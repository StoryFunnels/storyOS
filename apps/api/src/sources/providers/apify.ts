import { z } from 'zod';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type { ApifyAuth } from '../../connections/providers/apify';
import type { ConnectionFetcher } from '../../connections/providers/types';
import { SourceSyncError } from './types';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';

/**
 * MN-262 — the escape hatch: schedule ANY Apify actor by id, raw JSON input,
 * results land as records. Unlike the YouTube providers (a fixed, known-ahead
 * API), an actor's dataset items have no universal id or shape, so this
 * provider needs two things they don't: `discover()` (Step 4 — a sample item
 * so the mapping UI can be point-and-click instead of "read the actor's
 * docs"), and a re-entrant `sync()` (Step 2 — an actor run can take far
 * longer than one 60s scheduler tick, so this never blocks waiting for it).
 */

const API_BASE = 'https://api.apify.com/v2';
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
/** Once a run has been `pending` this long across ticks, stop resuming it —
 * clear the cursor and surface an error instead of polling forever. */
const OVERALL_CEILING_MS = 30 * 60 * 1000;
const DATASET_PAGE_LIMIT = 1000;
/** Dataset pages fetched within one sync() call before yielding back to the
 * next tick — bounds one source's worst-case time inside a shared scheduler
 * pass, same reasoning as youtube.ts's MAX_PAGES. */
const MAX_DATASET_PAGES_PER_TICK = 5;
/** Approximate — JSON.stringify's *character* count, not UTF-8 byte count;
 * close enough for the "visible truncation marker" this exists for. */
const RAW_TRUNCATE_CHARS = 32 * 1024;

export const apifyActorConfigSchema = z.object({
  actor_id: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$|^[a-zA-Z0-9]{17}$/, 'Use "username/actor-name" or a 17-character actor id')
    .describe('The Apify actor to run, e.g. "apify/website-content-crawler".'),
  input: z.record(z.string(), z.unknown()).default({}).describe('Raw JSON input passed to the actor run.'),
  memory_mbytes: z.number().int().min(128).max(4096).optional().describe('Overrides the actor\'s default run memory (MB).'),
  timeout_secs: z.number().int().max(3600).optional().describe('Overrides the actor\'s default run timeout (seconds).'),
  monthly_run_cap: z
    .number()
    .int()
    .min(1)
    .default(60)
    .describe('Stop scheduling new runs once this many have run this calendar month.'),
  include_raw: z
    .boolean()
    .default(false)
    .describe('Also map the whole item as truncated JSON (32KB cap) into a "raw" key, for anything the field mapping misses.'),
});
export type ApifyActorConfig = z.infer<typeof apifyActorConfigSchema>;

interface ApifyRunDetail {
  id: string;
  status: string;
  statusMessage?: string | null;
  defaultDatasetId?: string;
  usageTotalUsd?: number;
  stats?: { computeUnits?: number };
}

function authKey(auth: unknown): string {
  const { api_key } = (auth ?? {}) as Partial<ApifyAuth>;
  if (!api_key || !api_key.trim()) throw new UnprocessableEntityException('Apify connection needs an API key');
  return api_key;
}

/** Apify addresses an actor by "username/actor-name" in a URL path with the
 * slash swapped for a tilde (or, for a bare 17-char id, used verbatim). */
function actorPathSegment(actorId: string): string {
  return actorId.includes('/') ? actorId.replace('/', '~') : actorId;
}

async function apifyFetch(
  fetcher: ConnectionFetcher,
  apiKey: string,
  path: string,
  opts: { method?: string; qs?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const qs = opts.qs ? `?${new URLSearchParams(opts.qs).toString()}` : '';
  const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetcher(`${API_BASE}${path}${qs}`, { method: opts.method ?? 'GET', headers, body });
}

async function startRun(
  fetcher: ConnectionFetcher,
  apiKey: string,
  actorPath: string,
  input: Record<string, unknown>,
  memoryMbytes?: number,
  timeoutSecs?: number,
): Promise<string> {
  const qs: Record<string, string> = { waitForFinish: '0' };
  if (memoryMbytes) qs['memory'] = String(memoryMbytes);
  if (timeoutSecs) qs['timeout'] = String(timeoutSecs);
  const res = await apifyFetch(fetcher, apiKey, `/acts/${actorPath}/runs`, { method: 'POST', qs, body: input });
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`Could not start Apify actor "${actorPath}" (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: { id?: string } };
  const id = body.data?.id;
  if (!id) throw new UnprocessableEntityException('Apify run-start response had no run id');
  return id;
}

async function getRunDetail(fetcher: ConnectionFetcher, apiKey: string, runId: string): Promise<ApifyRunDetail> {
  const res = await apifyFetch(fetcher, apiKey, `/actor-runs/${runId}`);
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`Could not check Apify run ${runId} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data?: ApifyRunDetail };
  if (!body.data) throw new UnprocessableEntityException(`Apify run ${runId} response had no data`);
  return body.data;
}

async function getDatasetPage(
  fetcher: ConnectionFetcher,
  apiKey: string,
  datasetId: string,
  offset: number,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const res = await apifyFetch(fetcher, apiKey, `/datasets/${datasetId}/items`, {
    qs: { offset: String(offset), limit: String(limit), clean: 'true' },
  });
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`Could not read Apify dataset ${datasetId} (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as Array<Record<string, unknown>>;
}

async function firstItemKeys(fetcher: ConnectionFetcher, apiKey: string, datasetId: string): Promise<string[] | null> {
  const items = await getDatasetPage(fetcher, apiKey, datasetId, 0, 1);
  const first = items[0];
  return first ? Object.keys(first) : null;
}

/** Step 5 — raw payload is NOT stored by default; `include_raw` adds a
 * synthetic `raw` key (truncated JSON, visibly marked) a user can map like
 * any other item key, instead of every field mapping losing what the
 * mapping dialog didn't cover. */
function shapeItem(item: Record<string, unknown>, includeRaw: boolean): Record<string, unknown> {
  if (!includeRaw) return item;
  const json = JSON.stringify(item);
  const raw = json.length > RAW_TRUNCATE_CHARS ? `${json.slice(0, RAW_TRUNCATE_CHARS)}\n[truncated]` : json;
  return { ...item, raw };
}

export const apifyActorProvider: SourceProviderDescriptor = {
  id: 'apify.actor',
  label: 'Apify — run any actor',
  connectionProvider: 'apify',
  configSchema: apifyActorConfigSchema,
  description:
    'Actors run under YOUR Apify account and are subject to Apify\'s and the target platforms\' terms. StoryOS moves the results; you own what you collect.',

  async discover(auth: unknown, config: Record<string, unknown>, fetcher: ConnectionFetcher): Promise<{ keys: string[] }> {
    const apiKey = authKey(auth);
    const actorId = config['actor_id'] as string | undefined;
    if (!actorId || !actorId.trim()) throw new BadRequestException('Set an actor id before discovering fields');
    const actorPath = actorPathSegment(actorId);

    // Tier 1 (cheap): the actor's own last successful run, if it has one.
    const lastRuns = await apifyFetch(fetcher, apiKey, `/acts/${actorPath}/runs`, {
      qs: { status: 'SUCCEEDED', desc: 'true', limit: '1' },
    });
    if (lastRuns.status >= 200 && lastRuns.status < 300) {
      const body = (await lastRuns.json()) as { data?: { items?: Array<{ defaultDatasetId?: string }> } };
      const datasetId = body.data?.items?.[0]?.defaultDatasetId;
      if (datasetId) {
        const keys = await firstItemKeys(fetcher, apiKey, datasetId);
        if (keys) return { keys };
      }
    }

    // Tier 2: no run history yet — run it once, capped cheap, and wait.
    const input = (config['input'] as Record<string, unknown> | undefined) ?? {};
    const started = await apifyFetch(fetcher, apiKey, `/acts/${actorPath}/runs`, {
      method: 'POST',
      qs: { waitForFinish: '120', memory: '256', timeout: '120' },
      body: input,
    });
    if (started.status < 200 || started.status >= 300) {
      const text = await started.text().catch(() => '');
      throw new UnprocessableEntityException(
        `Could not start "${actorId}" for field discovery (HTTP ${started.status}): ${text.slice(0, 300)}`,
      );
    }
    const startedBody = (await started.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    const run = startedBody.data;
    if (run?.status !== 'SUCCEEDED' || !run.defaultDatasetId) {
      throw new UnprocessableEntityException(
        `"${actorId}" hasn't produced a successful run yet — paste a sample item's JSON instead of discovering.`,
      );
    }
    const keys = await firstItemKeys(fetcher, apiKey, run.defaultDatasetId);
    if (!keys) throw new UnprocessableEntityException(`"${actorId}"'s run produced no dataset items to map`);
    return { keys };
  },

  async sync(ctx: SourceSyncContext) {
    const apiKey = authKey(ctx.auth);
    const config = ctx.config as ApifyActorConfig;
    const actorPath = actorPathSegment(config.actor_id);
    const cursor: Record<string, unknown> = { ...ctx.cursor };

    let runId = cursor['pending_run_id'] as string | undefined;
    let phase = cursor['phase'] as string | undefined;

    // Not re-entering an in-flight run — start a fresh one.
    if (!runId) {
      runId = await startRun(ctx.fetcher, apiKey, actorPath, config.input, config.memory_mbytes, config.timeout_secs);
      cursor['pending_run_id'] = runId;
      cursor['pending_run_started_at'] = new Date().toISOString();
      phase = 'polling';
      cursor['phase'] = phase;
      delete cursor['dataset_id'];
      delete cursor['dataset_offset'];
    }

    if (phase !== 'paging') {
      // One status check per tick — no in-call sleep/retry loop. Re-entrancy
      // (not blocking) IS the polling strategy: the next scheduler tick,
      // ~60s later, is the next poll.
      const detail = await getRunDetail(ctx.fetcher, apiKey, runId);

      if (!TERMINAL_STATUSES.has(detail.status)) {
        const startedAtMs = cursor['pending_run_started_at']
          ? new Date(cursor['pending_run_started_at'] as string).getTime()
          : Date.now();
        if (Date.now() - startedAtMs > OVERALL_CEILING_MS) {
          const cleared = { ...cursor };
          delete cleared['pending_run_id'];
          delete cleared['pending_run_started_at'];
          delete cleared['phase'];
          throw new SourceSyncError(
            `Apify run ${runId} did not finish within the 30-minute polling ceiling`,
            cleared,
          );
        }
        // Still running — persist and resume next tick.
        return { cursor };
      }

      if (detail.status !== 'SUCCEEDED') {
        const cleared: Record<string, unknown> = { ...cursor, last_run_id: runId, last_run_status: detail.status };
        delete cleared['pending_run_id'];
        delete cleared['pending_run_started_at'];
        delete cleared['phase'];
        throw new SourceSyncError(detail.statusMessage || `Apify run ended as ${detail.status}`, cleared);
      }

      // SUCCEEDED — move into the dataset-paging phase.
      cursor['phase'] = 'paging';
      cursor['dataset_id'] = detail.defaultDatasetId;
      cursor['dataset_offset'] = 0;
      cursor['run_compute_units'] = detail.stats?.computeUnits ?? null;
      cursor['run_usage_usd'] = detail.usageTotalUsd ?? null;
    }

    // Paging phase — page the finished run's dataset, bounded per tick.
    const datasetId = cursor['dataset_id'] as string;
    let offset = (cursor['dataset_offset'] as number | undefined) ?? 0;
    let pagesFetched = 0;
    let donePaging = false;

    while (pagesFetched < MAX_DATASET_PAGES_PER_TICK) {
      const items = await getDatasetPage(ctx.fetcher, apiKey, datasetId, offset, DATASET_PAGE_LIMIT);
      if (items.length === 0) {
        donePaging = true;
        break;
      }
      await ctx.emit(items.map((item) => shapeItem(item, config.include_raw)));
      offset += items.length;
      pagesFetched += 1;
      if (items.length < DATASET_PAGE_LIMIT) {
        donePaging = true;
        break;
      }
    }

    if (!donePaging) {
      cursor['dataset_offset'] = offset;
      return { cursor };
    }

    const computeUnits = cursor['run_compute_units'] ?? null;
    const usageUsd = cursor['run_usage_usd'] ?? null;
    const finalCursor: Record<string, unknown> = { ...cursor, last_run_id: runId, last_dataset_offset: offset };
    delete finalCursor['pending_run_id'];
    delete finalCursor['pending_run_started_at'];
    delete finalCursor['phase'];
    delete finalCursor['dataset_id'];
    delete finalCursor['dataset_offset'];
    delete finalCursor['run_compute_units'];
    delete finalCursor['run_usage_usd'];

    return {
      cursor: finalCursor,
      stats: { apify_run_id: runId, apify_dataset_id: datasetId, compute_units: computeUnits, usage_usd: usageUsd },
    };
  },
};
