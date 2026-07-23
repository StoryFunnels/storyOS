import { Inject, Injectable, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields } from '../db/schema';
import { ConnectionsService } from '../connections/connections.service';
import type { HttpConnectionAuth } from '../connections/providers';
import { RecordsService } from '../records/records.service';
import { getJsonPath } from '../common/json-path';
import { redactLiteralValues, redactSecrets } from '../common/redact-secrets';
import { guardedFetch, SsrfBlockedError } from '../common/net-guard';
import { ProviderError } from '../common/provider-error';
import { parseTemplateBody } from './actions.service';
import { JobRunnerService } from './job-runner.service';
import type { JobHelpers } from './job-runner.service';

export type HttpRequestAction = Extract<AutomationAction, { type: 'http_request' }>;

export interface HttpRequestJobPayload {
  action: HttpRequestAction;
  ctx: {
    workspaceId: string;
    databaseId: string;
    recordId: string | null;
    actorId: string;
    depth: number;
  };
}

/** 1MB response cap and 8KB result/error cap, per the MN-263 implementation guide. */
const MAX_BODY_BYTES = 1_000_000;
const MAX_RESULT_LEN = 8_000;

export interface HttpRequestRunResult {
  status: number;
  ok: boolean;
  body: string;
  truncated: boolean;
  captured_fields: string[];
  capture_error?: string;
}

function allowPrivateCidrsFromEnv(): string[] {
  return (process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `{ auth_style: 'headers', headers: {...} }`'s values, plus a bearer token / basic
 * password — everything that must never surface in a run result or log, literally. */
function secretLiteralsFromAuth(auth: HttpConnectionAuth | undefined): string[] {
  if (!auth) return [];
  const values: (string | undefined)[] = [auth.token, auth.password];
  if (auth.headers) values.push(...Object.values(auth.headers));
  if (auth.auth_style === 'basic' && auth.username !== undefined && auth.password !== undefined) {
    values.push(Buffer.from(`${auth.username}:${auth.password}`).toString('base64'));
  }
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Merges connection auth into the outgoing headers — SEND TIME ONLY. The merged
 * headers are never written back into the stored/rendered action config; they
 * exist only for the duration of this one request. */
function mergeAuthHeaders(
  headers: Record<string, string>,
  auth: HttpConnectionAuth | undefined,
): Record<string, string> {
  if (!auth) return headers;
  const merged = { ...headers };
  if (auth.auth_style === 'bearer' && auth.token) {
    merged.Authorization = `Bearer ${auth.token}`;
  } else if (auth.auth_style === 'basic' && auth.username !== undefined && auth.password !== undefined) {
    merged.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  } else if (auth.auth_style === 'headers' && auth.headers) {
    Object.assign(merged, auth.headers);
  }
  return merged;
}

/** Flattens a parsed JSON value into the dot/array paths json-path.ts understands,
 * for the editor's capture-row path picker. Capped so a huge/deep response doesn't
 * produce an unusable list. */
export function flattenCapturePaths(value: unknown, maxPaths = 50): string[] {
  const out: string[] = [];
  function walk(node: unknown, prefix: string) {
    if (out.length >= maxPaths) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, prefix ? `${prefix}.${i}` : String(i)));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, prefix ? `${prefix}.${key}` : key);
      }
      return;
    }
    if (prefix) out.push(prefix);
  }
  walk(value, '');
  return out.slice(0, maxPaths);
}

/** Best-effort number coercion for a captured value landing on a `number` field. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

/** MN-253/263: 4xx never retries; 5xx/429/network errors do. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * MN-263 — the http_request automation action's executor, registered with
 * JobRunnerService (MN-253's durable queue) at boot. Render → net-guard →
 * merge connection auth (send time only) → guarded fetch (redirect re-
 * validated, 1MB cap) → capture matched json-paths onto the record.
 */
@Injectable()
export class HttpRequestActionService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRunnerService,
    private readonly connections: ConnectionsService,
    private readonly records: RecordsService,
  ) {}

  onModuleInit() {
    this.jobs.registerExecutor(
      'http_request',
      (payload, helpers) => this.run(payload as unknown as HttpRequestJobPayload, helpers),
      { timeoutClass: 'short' },
    );
  }

  /**
   * Runs an already-rendered http_request action (its url/headers/body_template
   * are plain strings by the time this is called — actions.service.ts's
   * execute() renders {Field} tokens before enqueue, since the job payload
   * only carries ctx.recordId, not the record's field values).
   */
  async run(payload: HttpRequestJobPayload, helpers: JobHelpers): Promise<HttpRequestRunResult> {
    const { action, ctx } = payload;

    let auth: HttpConnectionAuth | undefined;
    if (action.connection_id) {
      const decrypted = await helpers.connectionAuth(action.connection_id);
      auth = decrypted.auth as HttpConnectionAuth;
    }
    const secrets = secretLiteralsFromAuth(auth);
    const headers = mergeAuthHeaders({ ...(action.headers ?? {}) }, auth);

    let body: string | undefined;
    if (action.body_template && action.method !== 'GET') {
      const parsed = parseTemplateBody(action.body_template);
      body = JSON.stringify(parsed);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }

    let res: Awaited<ReturnType<typeof guardedFetch>>;
    try {
      res = await guardedFetch(
        helpers.fetcher,
        action.url,
        { method: action.method, headers, body, signal: helpers.signal },
        { allowPrivateCidrs: allowPrivateCidrsFromEnv(), maxBodyBytes: MAX_BODY_BYTES },
      );
    } catch (error) {
      // SsrfBlockedError is a refusal, not a transient network blip — retrying
      // an SSRF-blocked destination can't ever succeed.
      const retryable = !(error instanceof SsrfBlockedError);
      throw new ProviderError(error instanceof Error ? error.message : String(error), { retryable });
    }

    const redactedBody = redactLiteralValues(res.text, secrets);
    const bodySnippet = redactedBody.length > MAX_RESULT_LEN ? redactedBody.slice(0, MAX_RESULT_LEN) : redactedBody;

    if (res.status >= 400) {
      throw new ProviderError(`HTTP ${res.status}: ${bodySnippet}`, { retryable: isRetryableStatus(res.status) });
    }

    let capturedFields: string[] = [];
    let captureError: string | undefined;
    if (action.capture?.length && ctx.recordId) {
      try {
        capturedFields = await this.applyCapture(action, ctx, res.text);
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
    }

    return redactSecrets({
      status: res.status,
      ok: true,
      body: bodySnippet,
      truncated: res.truncated || redactedBody.length > MAX_RESULT_LEN,
      captured_fields: capturedFields,
      ...(captureError ? { capture_error: captureError } : {}),
    });
  }

  /** Parses the 2xx body as JSON and set_values()es each capture's path onto its
   * target field, coerced by that field's type. A non-JSON body is reported via
   * the thrown Error (caught by run() above as `capture_error`), not a job
   * failure — the HTTP call itself succeeded. */
  private async applyCapture(
    action: HttpRequestAction,
    ctx: HttpRequestJobPayload['ctx'],
    bodyText: string,
  ): Promise<string[]> {
    let parsed: unknown;
    try {
      parsed = bodyText.trim() ? JSON.parse(bodyText) : undefined;
    } catch {
      throw new Error('response body is not valid JSON — nothing captured');
    }
    const captures = action.capture ?? [];
    const targetIds = captures.map((c) => c.target_field_id);
    const targetFields = await this.db.query.fields.findMany({
      where: and(inArray(fields.id, targetIds), eq(fields.databaseId, ctx.databaseId), isNull(fields.deletedAt)),
    });
    const byId = new Map(targetFields.map((f) => [f.id, f]));

    const values: Record<string, unknown> = {};
    const applied: string[] = [];
    for (const capture of captures) {
      const field = byId.get(capture.target_field_id);
      if (!field) continue; // deleted since the rule was saved — validate() already
      // guaranteed the field existed at save time; skip rather than fail the run.
      const path = capture.path.replace(/^\$\./, '');
      const raw = getJsonPath(parsed, path);
      if (raw === undefined) continue;
      if (field.type === 'number') {
        const n = coerceNumber(raw);
        if (n === null) continue;
        values[field.apiName] = n;
      } else if (field.type === 'checkbox' && typeof raw === 'boolean') {
        values[field.apiName] = raw;
      } else if (raw !== null && typeof raw === 'object') {
        const json = JSON.stringify(raw);
        values[field.apiName] = json.length > 8_000 ? json.slice(0, 8_000) : json;
      } else {
        values[field.apiName] = String(raw);
      }
      applied.push(field.apiName);
    }
    if (Object.keys(values).length > 0 && ctx.recordId) {
      await this.records.update(ctx.workspaceId, ctx.databaseId, ctx.recordId, values, ctx.actorId, ctx.depth + 1);
    }
    return applied;
  }

  /**
   * MN-263 — the editor's "Send test request": executes a single (already-
   * rendered) http_request action for real, outside the durable queue, and
   * returns the response paths a capture row picker can offer. Real request,
   * real response — the caller (automations.service.ts's test()) is
   * responsible for the confirm-dialog UX; this just runs it.
   */
  async sendForTest(
    workspaceId: string,
    databaseId: string,
    recordId: string | null,
    actorId: string,
    action: HttpRequestAction,
  ): Promise<{ status: number; body: string; available_paths: string[] }> {
    let auth: HttpConnectionAuth | undefined;
    if (action.connection_id) {
      const decrypted = await this.connections.getDecryptedAuth(workspaceId, action.connection_id);
      auth = decrypted.auth as HttpConnectionAuth;
    }
    const secrets = secretLiteralsFromAuth(auth);
    const headers = mergeAuthHeaders({ ...(action.headers ?? {}) }, auth);
    let body: string | undefined;
    if (action.body_template && action.method !== 'GET') {
      body = JSON.stringify(parseTemplateBody(action.body_template));
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      let res: Awaited<ReturnType<typeof guardedFetch>>;
      try {
        res = await guardedFetch(
          fetch,
          action.url,
          { method: action.method, headers, body, signal: controller.signal },
          { allowPrivateCidrs: allowPrivateCidrsFromEnv(), maxBodyBytes: MAX_BODY_BYTES },
        );
      } catch (error) {
        // MN-263: an SSRF refusal or network failure here is a 4xx the editor
        // shows inline (test() is a synchronous, user-facing call) — not an
        // uncaught 500. Same redaction as the real send path, in case the
        // thrown message ever echoes a header value back.
        const message = redactLiteralValues(error instanceof Error ? error.message : String(error), secrets);
        throw new UnprocessableEntityException(message);
      }
      const redactedBody = redactLiteralValues(res.text, secrets);
      const bodySnippet = redactedBody.length > MAX_RESULT_LEN ? redactedBody.slice(0, MAX_RESULT_LEN) : redactedBody;
      let availablePaths: string[] = [];
      if (res.status >= 200 && res.status < 300) {
        try {
          availablePaths = flattenCapturePaths(JSON.parse(res.text));
        } catch {
          availablePaths = [];
        }
      }
      return { status: res.status, body: bodySnippet, available_paths: availablePaths };
    } finally {
      clearTimeout(timer);
    }
  }
}
