import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { apifyActorProvider } from './apify';
import { SourceSyncError } from './types';
import type { SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

type FetchResponse = Awaited<ReturnType<ConnectionFetcher>>;

/** One JSON response, Apify's `{ data: ... }` envelope optional per-route. */
function jsonRes(status: number, body: unknown): FetchResponse {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

type Route = { method?: string; test: (url: string) => boolean; respond: (url: string) => FetchResponse | Promise<FetchResponse> };

function routedFetcher(routes: Route[]): { fetcher: ConnectionFetcher; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const fetcher: ConnectionFetcher = async (url, init) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    const route = routes.find((r) => (!r.method || r.method === method) && r.test(url));
    if (!route) throw new Error(`no route for ${method} ${url}`);
    return route.respond(url);
  };
  return { fetcher, calls };
}

const baseConfig = { actor_id: 'apify/website-content-crawler', input: {}, monthly_run_cap: 60, include_raw: false };

function baseCtx(overrides: Partial<SourceSyncContext> = {}): SourceSyncContext {
  return {
    auth: { api_key: 'apify_test_token' },
    config: baseConfig,
    cursor: {},
    fetcher: async () => {
      throw new Error('fetcher not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

describe('apifyActorProvider.sync — happy path', () => {
  it('starts a run, polls to SUCCEEDED, pages the dataset once, and emits upsert-ready items', async () => {
    const { fetcher, calls } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/acts/apify~website-content-crawler/runs'), respond: () => jsonRes(200, { data: { id: 'run_1' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_1'), respond: () =>
          jsonRes(200, { data: { id: 'run_1', status: 'SUCCEEDED', defaultDatasetId: 'ds_1', usageTotalUsd: 0.05, stats: { computeUnits: 0.01 } } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_1/items'), respond: () =>
          jsonRes(200, [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B' }]) },
    ]);

    const emitted: Array<Record<string, unknown>> = [];
    const result = await apifyActorProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));

    expect(emitted).toEqual([
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: 'B' },
    ]);
    expect(result.cursor).toEqual({ last_run_id: 'run_1', last_dataset_offset: 2 });
    expect(result.stats).toEqual({ apify_run_id: 'run_1', apify_dataset_id: 'ds_1', compute_units: 0.01, usage_usd: 0.05 });
    // slash in the actor id was addressed as a tilde path segment, per Apify's convention
    expect(calls.some((c) => c.url.includes('apify~website-content-crawler'))).toBe(true);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('apifyActorProvider.sync — re-entrant resume (MN-262)', () => {
  it('a RUNNING run persists pending_run_id/phase instead of blocking, and never starts a second run', async () => {
    const { fetcher: firstFetcher, calls: firstCalls } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/runs') && !u.includes('actor-runs'), respond: () => jsonRes(200, { data: { id: 'run_2' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_2'), respond: () => jsonRes(200, { data: { id: 'run_2', status: 'RUNNING' } }) },
    ]);

    const emitted: Array<Record<string, unknown>> = [];
    const first = await apifyActorProvider.sync(baseCtx({ fetcher: firstFetcher, emit: async (items) => void emitted.push(...items) }));

    expect(emitted).toEqual([]); // nothing emitted yet — the run hasn't finished
    expect(first.stats).toBeUndefined();
    expect(first.cursor['pending_run_id']).toBe('run_2');
    expect(first.cursor['phase']).toBe('polling');
    expect(typeof first.cursor['pending_run_started_at']).toBe('string');
    expect(firstCalls.filter((c) => c.method === 'POST')).toHaveLength(1); // one run started

    // Second tick: same source, cursor round-tripped verbatim — a fetcher whose
    // POST handler throws proves resume never starts a second run.
    const { fetcher: secondFetcher, calls: secondCalls } = routedFetcher([
      {
        method: 'POST',
        test: () => true,
        respond: () => {
          throw new Error('must not start a second run — this is a resume');
        },
      },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_2'), respond: () =>
          jsonRes(200, { data: { id: 'run_2', status: 'SUCCEEDED', defaultDatasetId: 'ds_2' } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_2/items'), respond: () => jsonRes(200, [{ url: 'https://c.example' }]) },
    ]);

    const second = await apifyActorProvider.sync(
      baseCtx({ fetcher: secondFetcher, cursor: first.cursor, emit: async (items) => void emitted.push(...items) }),
    );

    expect(emitted).toEqual([{ url: 'https://c.example' }]);
    expect(second.cursor).toEqual({ last_run_id: 'run_2', last_dataset_offset: 1 });
    expect(secondCalls.filter((c) => c.method === 'POST')).toHaveLength(0); // resumed, never re-started
  });

  it('resumes dataset paging (not a re-poll) when a prior tick left phase: "paging"', async () => {
    const cursor = { pending_run_id: 'run_5', phase: 'paging', dataset_id: 'ds_5', dataset_offset: 2 };
    const { fetcher, calls } = routedFetcher([
      {
        method: 'GET',
        test: (u) => u.includes('/actor-runs/'),
        respond: () => {
          throw new Error('must not re-check run status while paging');
        },
      },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_5/items'), respond: (u) => {
          const offset = new URL(u).searchParams.get('offset');
          expect(offset).toBe('2'); // resumed exactly where it left off
          return jsonRes(200, [{ url: 'https://d.example' }]);
        } },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    const result = await apifyActorProvider.sync(baseCtx({ fetcher, cursor, emit: async (items) => void emitted.push(...items) }));
    expect(emitted).toEqual([{ url: 'https://d.example' }]);
    expect(result.cursor).toEqual({ last_run_id: 'run_5', last_dataset_offset: 3 });
    expect(calls.filter((c) => c.url.includes('/actor-runs/'))).toHaveLength(0);
  });
});

describe('apifyActorProvider.sync — failure surfaces', () => {
  it('a FAILED run throws a SourceSyncError carrying the actor statusMessage, and clears pending_run_id', async () => {
    const { fetcher } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/runs') && !u.includes('actor-runs'), respond: () => jsonRes(200, { data: { id: 'run_3' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_3'), respond: () =>
          jsonRes(200, { data: { id: 'run_3', status: 'FAILED', statusMessage: 'Actor crashed: out of memory' } }) },
    ]);

    await expect(apifyActorProvider.sync(baseCtx({ fetcher }))).rejects.toThrow('Actor crashed: out of memory');

    let caught: unknown;
    try {
      await apifyActorProvider.sync(baseCtx({ fetcher }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SourceSyncError);
    const err = caught as SourceSyncError;
    expect(err.cursor).toBeDefined();
    expect(err.cursor?.['pending_run_id']).toBeUndefined();
    expect(err.cursor?.['phase']).toBeUndefined();
    expect(err.cursor?.['last_run_status']).toBe('FAILED');
  });

  it('a run stuck past the 30-minute ceiling errors out and clears the cursor instead of polling forever', async () => {
    const staleCursor = {
      pending_run_id: 'run_4',
      phase: 'polling',
      pending_run_started_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    };
    const { fetcher, calls } = routedFetcher([
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_4'), respond: () => jsonRes(200, { data: { id: 'run_4', status: 'RUNNING' } }) },
    ]);

    let caught: unknown;
    try {
      await apifyActorProvider.sync(baseCtx({ fetcher, cursor: staleCursor }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SourceSyncError);
    const err = caught as SourceSyncError;
    expect(err.message).toContain('30-minute polling ceiling');
    expect(err.cursor).toEqual({}); // pending_run_id/phase/pending_run_started_at all cleared
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // resumed, not re-started
  });
});

describe('apifyActorProvider.sync — raw payload (Step 5)', () => {
  it('omits "raw" entirely when include_raw is false (the default)', async () => {
    const { fetcher } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/runs') && !u.includes('actor-runs'), respond: () => jsonRes(200, { data: { id: 'run_6' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_6'), respond: () => jsonRes(200, { data: { id: 'run_6', status: 'SUCCEEDED', defaultDatasetId: 'ds_6' } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_6/items'), respond: () => jsonRes(200, [{ url: 'x', big: 'y'.repeat(50) }]) },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await apifyActorProvider.sync(baseCtx({ fetcher, config: { ...baseConfig, include_raw: false }, emit: async (items) => void emitted.push(...items) }));
    expect(Object.keys(emitted[0]!)).not.toContain('raw');
  });

  it('adds a truncated, visibly-marked "raw" key (32KB cap) when include_raw is true', async () => {
    const bigItem = { url: 'https://big.example', blob: 'z'.repeat(40_000) };
    const { fetcher } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/runs') && !u.includes('actor-runs'), respond: () => jsonRes(200, { data: { id: 'run_7' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_7'), respond: () => jsonRes(200, { data: { id: 'run_7', status: 'SUCCEEDED', defaultDatasetId: 'ds_7' } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_7/items'), respond: () => jsonRes(200, [bigItem]) },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await apifyActorProvider.sync(baseCtx({ fetcher, config: { ...baseConfig, include_raw: true }, emit: async (items) => void emitted.push(...items) }));
    const raw = emitted[0]!['raw'] as string;
    expect(raw.endsWith('\n[truncated]')).toBe(true);
    expect(raw.length).toBe(32 * 1024 + '\n[truncated]'.length);
    expect(emitted[0]!['url']).toBe('https://big.example'); // the rest of the item is untouched
  });

  it('does not mark a small item as truncated', async () => {
    const smallItem = { url: 'https://small.example', title: 'Small' };
    const { fetcher } = routedFetcher([
      { method: 'POST', test: (u) => u.includes('/runs') && !u.includes('actor-runs'), respond: () => jsonRes(200, { data: { id: 'run_8' } }) },
      { method: 'GET', test: (u) => u.includes('/actor-runs/run_8'), respond: () => jsonRes(200, { data: { id: 'run_8', status: 'SUCCEEDED', defaultDatasetId: 'ds_8' } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_8/items'), respond: () => jsonRes(200, [smallItem]) },
    ]);
    const emitted: Array<Record<string, unknown>> = [];
    await apifyActorProvider.sync(baseCtx({ fetcher, config: { ...baseConfig, include_raw: true }, emit: async (items) => void emitted.push(...items) }));
    expect(emitted[0]!['raw']).toBe(JSON.stringify(smallItem));
    expect((emitted[0]!['raw'] as string).includes('[truncated]')).toBe(false);
  });
});

describe('apifyActorProvider.discover (Step 4)', () => {
  it('tier 1: reads the actor\'s last successful run\'s first dataset item, no run started', async () => {
    const { fetcher, calls } = routedFetcher([
      { method: 'GET', test: (u) => u.includes('/runs?') && u.includes('status=SUCCEEDED'), respond: () =>
          jsonRes(200, { data: { items: [{ defaultDatasetId: 'ds_9' }] } }) },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_9/items'), respond: () => jsonRes(200, [{ foo: 'a', bar: 'b' }]) },
    ]);
    const result = await apifyActorProvider.discover!({ api_key: 'k' }, { actor_id: 'user/actor' }, fetcher);
    expect(result).toEqual({ keys: ['foo', 'bar'] });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('tier 2: no run history — runs the actor once, capped cheap, and reads its output', async () => {
    const { fetcher, calls } = routedFetcher([
      { method: 'GET', test: (u) => u.includes('/runs?') && u.includes('status=SUCCEEDED'), respond: () => jsonRes(200, { data: { items: [] } }) },
      {
        method: 'POST',
        test: (u) => u.includes('/runs?') && u.includes('waitForFinish=120'),
        respond: (u) => {
          expect(u).toContain('memory=256');
          expect(u).toContain('timeout=120');
          return jsonRes(200, { data: { status: 'SUCCEEDED', defaultDatasetId: 'ds_10' } });
        },
      },
      { method: 'GET', test: (u) => u.includes('/datasets/ds_10/items'), respond: () => jsonRes(200, [{ a: 1, b: 2 }]) },
    ]);
    const result = await apifyActorProvider.discover!({ api_key: 'k' }, { actor_id: 'user/actor' }, fetcher);
    expect(result).toEqual({ keys: ['a', 'b'] });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('rejects when no actor_id is set yet, before any network call', async () => {
    const { fetcher, calls } = routedFetcher([]);
    await expect(apifyActorProvider.discover!({ api_key: 'k' }, {}, fetcher)).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toHaveLength(0);
  });
});

describe('apifyActorProvider — auth guard', () => {
  it('rejects sync() and discover() when the connection has no api_key, before any network call', async () => {
    const { fetcher, calls } = routedFetcher([]);
    await expect(apifyActorProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(apifyActorProvider.discover!({}, { actor_id: 'user/actor' }, fetcher)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(calls).toHaveLength(0);
  });
});
