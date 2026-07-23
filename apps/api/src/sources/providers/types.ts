import type { ZodObject, ZodRawShape } from 'zod';
import type { ConnectionFetcher } from '../../connections/providers/types';

/**
 * #239 — one page/cycle's worth of work handed to a provider's `sync()`.
 * `emit` is awaited so the engine's per-batch upsert (and quota bookkeeping)
 * happens before the provider fetches the next page — back-pressure, not a
 * buffered pipe.
 */
export interface SourceSyncContext {
  auth: unknown;
  config: Record<string, unknown>;
  /** Provider-owned opaque state (page tokens, watermarks), round-tripped
   * verbatim from the previous cycle's returned `cursor` ({} on first run). */
  cursor: Record<string, unknown>;
  /** Set when the source has synced before — providers use it to decide how
   * far back to walk (e.g. comments stop once older than the watermark). */
  since?: Date;
  fetcher: ConnectionFetcher;
  emit(items: Array<Record<string, unknown>>): Promise<void>;
  /**
   * Resolve the live external-key values already stored by ANOTHER source
   * (same workspace) — e.g. youtube.metrics enumerating video ids off a
   * paired youtube.videos source instead of a second `video_ids` config
   * knob. Returns [] if the source doesn't exist or has no rows yet.
   */
  lookupSourceKeys(sourceId: string): Promise<string[]>;
}

/**
 * A provider's `sync()` throws this instead of a plain `Error` when a run
 * must be recorded as `'error'` AND the cursor still needs to change — e.g.
 * MN-262's Apify provider clearing a stuck `pending_run_id` once its overall
 * polling ceiling passes, so the next tick starts a fresh run instead of
 * resuming a dead one forever. A plain thrown `Error` leaves the cursor
 * untouched (SourcesService.runOne), which is the right default for every
 * transient failure — a network blip must not silently forget a legitimate
 * in-flight run.
 */
export class SourceSyncError extends Error {
  readonly cursor?: Record<string, unknown>;
  constructor(message: string, cursor?: Record<string, unknown>) {
    super(message);
    this.name = 'SourceSyncError';
    this.cursor = cursor;
  }
}

/**
 * A registered source provider (#239 Step 2, mirrors connections/providers'
 * ProviderDescriptor). Adding one — MN-261/MN-262 — is a new file here plus
 * one entry in `providers/index.ts`; never a schema change.
 */
export interface SourceProviderDescriptor {
  /** Registry key, stored verbatim in `sources.providerSource` — "id.subresource". */
  id: string;
  label: string;
  /** connections.provider id this source's connection must be (e.g. "google"). */
  connectionProvider: string;
  configSchema: ZodObject<ZodRawShape>;
  /** Shown as-is under the provider picker in the "Sync from…" dialog — MN-262's
   * responsibility framing ("Actors run under YOUR Apify account…") is this,
   * not special-cased UI copy, so any future third-party-account provider gets
   * the same treatment for free. */
  description?: string;
  /** Estimated API quota units this one sync cycle will cost — the budget
   * guard consumes this BEFORE calling sync(), so a mid-cycle failure never
   * leaves quota accounting short. Defaults to 1 (a single cheap call). */
  estimateQuotaUnits?(config: Record<string, unknown>): number;
  /** External keys a fresh config would emit, for the mapping UI's first
   * "here's what you'll get" preview before any sync has run. */
  discover?(auth: unknown, config: Record<string, unknown>, fetcher: ConnectionFetcher): Promise<{ keys: string[] }>;
  sync(ctx: SourceSyncContext): Promise<{
    cursor: Record<string, unknown>;
    /** Provider-owned run metadata that isn't a fetched/created/updated count
     * (MN-262: `{ compute_units, apify_run_id, apify_dataset_id }`) — stored
     * verbatim on the run row (`source_runs.stats`). Omit for nothing to show. */
    stats?: Record<string, unknown>;
  }>;
}
