import { API_URL } from './api';

/**
 * #1030 — the MCP OAuth consent screen's ONLY door to the server (the two calls in `oauth-consent.controller.ts`):
 *   GET  /api/v1/oauth/consent?consent_code=…   -> ConsentRequest
 *   POST /api/v1/oauth/consent {consent_code, decision, workspace_id?} -> { redirect_url }
 * `workspace_id` OMITTED means ALL of the person's workspaces (resolved per request); a uuid means that one (#1079). There is no
 * access level: every connection is read and write, and limiting which tools an AI uses is the client's job.
 * Errors are the standard `{error:{code,message}}`: 404 unknown or not yours, 410 expired or already answered,
 * 422 no workspace chosen, 403 not a signed-in person. better-auth redirects here with `consent_code`, `client_id`
 * and `scope`; only `consent_code` is needed, the rest comes back from the GET.
 */
export interface ConsentScope {
  id: string;
  /** Plain-language, written by the server so the words match what the token will really be allowed to do. */
  label: string;
}

export interface ConsentRequest {
  client_name: string;
  /** Where the code goes if the person allows: the host of the client's registered redirect URI. */
  redirect_host: string;
  scopes: ConsentScope[];
  /** The workspaces this person is in: "All my workspaces" is the default, and one of these can be chosen instead. */
  workspaces: Array<{ id: string; name: string }>;
}

export type ConsentFailure = 'expired' | 'invalid' | 'no_workspace' | 'not_a_session' | 'unavailable';

export type ConsentLoad =
  | { kind: 'ready'; request: ConsentRequest }
  | { kind: 'failed'; code: ConsentFailure; message?: string };

export type ConsentDecision = 'allow' | 'deny';

export type ConsentOutcome = { kind: 'redirect'; url: string } | { kind: 'failed'; code: ConsentFailure; message?: string };

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Schemes that run or expose content in the app's own context if navigated to. */
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);

/**
 * The URL when the page may navigate to it, else null. The SERVER is the authority on where a code goes: it
 * exact-matches `redirect_uri` against the client's registered URIs, so native clients work — loopback
 * (`http://127.0.0.1:PORT`, RFC 8252) and custom schemes (`cursor://`, `vscode://`). This is defence in depth
 * for the one thing the page must never do: navigate to a scheme that runs script (the same class as a form's
 * redirect_url, ticket #1032). The check is on the PARSED protocol, so `JaVaScRiPt:` and a tab inside the
 * scheme do not slip past a prefix test; anything that does not parse (empty, relative, `//host`) is refused.
 */
export function redirectTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return REFUSED_SCHEMES.has(new URL(value).protocol) ? null : value;
  } catch {
    return null;
  }
}

/** The server's own sentence for a 410 ("expired" vs "already answered") is worth showing; nothing else is. */
const failure = (status: number, body: unknown): { code: ConsentFailure; message?: string } => {
  const message = asRecord(asRecord(body).error).message;
  if (status >= 500) return { code: 'unavailable' };
  if (status === 410) return { code: 'expired', message: typeof message === 'string' ? message : undefined };
  if (status === 403) return { code: 'not_a_session' };
  // 404, 422, an unknown status or no body: a request we cannot act on. Never guess "ready".
  return { code: 'invalid' };
};

export function readConsent(status: number, body: unknown): ConsentLoad {
  const rec = asRecord(body);
  if (status >= 200 && status < 300) {
    const workspaces = Array.isArray(rec.workspaces) ? rec.workspaces.map(asRecord) : null;
    const scopes = Array.isArray(rec.scopes) ? rec.scopes.map(asRecord) : null;
    if (
      typeof rec.client_name === 'string' &&
      rec.client_name.trim() !== '' &&
      typeof rec.redirect_host === 'string' &&
      workspaces &&
      workspaces.every((w) => typeof w.id === 'string' && typeof w.name === 'string') &&
      scopes &&
      scopes.every((s) => typeof s.id === 'string' && typeof s.label === 'string')
    ) {
      // Nothing to bind it to is a dead end, not a form with an empty list.
      if (workspaces.length === 0) return { kind: 'failed', code: 'no_workspace' };
      return {
        kind: 'ready',
        request: {
          client_name: rec.client_name,
          redirect_host: rec.redirect_host,
          scopes: scopes.map((s) => ({ id: s.id as string, label: s.label as string })),
          workspaces: workspaces.map((w) => ({ id: w.id as string, name: w.name as string })),
        },
      };
    }
    // A 200 we cannot read is not consent to show: the person would be approving something unnamed.
    return { kind: 'failed', code: 'invalid' };
  }
  return { kind: 'failed', ...failure(status, body) };
}

export function readDecision(status: number, body: unknown): ConsentOutcome {
  if (status >= 200 && status < 300) {
    const url = redirectTarget(asRecord(body).redirect_url);
    return url ? { kind: 'redirect', url } : { kind: 'failed', code: 'invalid' };
  }
  return { kind: 'failed', ...failure(status, body) };
}

const consentUrl = () => `${API_URL}/api/v1/oauth/consent`;

export async function loadConsent(consentCode: string): Promise<ConsentLoad> {
  try {
    const res = await fetch(`${consentUrl()}?consent_code=${encodeURIComponent(consentCode)}`, { credentials: 'include' });
    return readConsent(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
}

export async function decideConsent(input: {
  consentCode: string;
  decision: ConsentDecision;
  /** Omitted = all of the person's workspaces. */
  workspaceId?: string;
}): Promise<ConsentOutcome> {
  try {
    const res = await fetch(consentUrl(), {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        consent_code: input.consentCode,
        decision: input.decision,
        // A deny names no workspace; an allow names one only when the person chose one (omitted = all).
        ...(input.decision === 'allow' && input.workspaceId ? { workspace_id: input.workspaceId } : {}),
      }),
    });
    return readDecision(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'failed', code: 'unavailable' };
  }
}
