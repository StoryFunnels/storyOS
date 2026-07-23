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
  /** Estimated API quota units this one sync cycle will cost — the budget
   * guard consumes this BEFORE calling sync(), so a mid-cycle failure never
   * leaves quota accounting short. Defaults to 1 (a single cheap call). */
  estimateQuotaUnits?(config: Record<string, unknown>): number;
  /** External keys a fresh config would emit, for the mapping UI's first
   * "here's what you'll get" preview before any sync has run. */
  discover?(auth: unknown, config: Record<string, unknown>, fetcher: ConnectionFetcher): Promise<{ keys: string[] }>;
  sync(ctx: SourceSyncContext): Promise<{ cursor: Record<string, unknown> }>;
}
