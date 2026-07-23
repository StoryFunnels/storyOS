import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { ConnectionsService } from '../src/connections/connections.service';
import { SourcesService } from '../src/sources/sources.service';
import type { ConnectionFetcher } from '../src/connections/providers';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let connections: ConnectionsService;
let sourcesService: SourcesService;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

/** Real HTTP round-trip through connections + sources + the new discover
 * route — a fresh database, three text fields, and an active apify.actor
 * connection (healthCheck stubbed via `connections.fetcher`, same as
 * connections.test.ts). */
async function setupDatabaseAndConnection(label: string) {
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `${label} DB` })).json().id;

  const field = async (display_name: string, type: string) => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name, type, config: {} });
    const body = res.json();
    return { id: body.id as string, apiName: body.apiName as string };
  };
  const urlField = await field('URL', 'text');
  const titleField = await field('Title', 'text');
  const rawField = await field('Raw', 'text');

  const connCreate = await inject('POST', `/workspaces/${wsId}/connections`, {
    provider: 'apify',
    name: `${label} Apify`,
    auth: { api_key: 'apify_test_token' },
  });
  expect(connCreate.statusCode, `connection create failed: ${connCreate.body}`).toBe(201);
  const connectionId = connCreate.json().id as string;

  return { dbId, connectionId, urlField, titleField, rawField };
}

async function createApifySource(
  dbId: string,
  connectionId: string,
  label: string,
  overrides: Partial<{ config: Record<string, unknown>; field_mapping: Record<string, string>; external_key_field_id: string }>,
  urlField: { id: string },
  titleField: { id: string },
) {
  const created = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources`, {
    name: `${label} apify`,
    connection_id: connectionId,
    provider_source: 'apify.actor',
    config: { actor_id: 'apify/website-content-crawler', input: {}, monthly_run_cap: 1 },
    field_mapping: { url: urlField.id, title: titleField.id },
    external_key_field_id: urlField.id,
    schedule: '15m',
    ...overrides,
  });
  return created;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ApifySourceAdmin');
  wsId = (await inject('POST', '/workspaces', { name: 'Apify Source WS' })).json().id;

  connections = app.get(ConnectionsService);
  sourcesService = app.get(SourcesService);

  // apifyProvider.healthCheck hits GET /v2/users/me — always accept in this suite.
  const healthCheckFetcher: ConnectionFetcher = async () => ({ status: 200, json: async () => ({}), text: async () => '' });
  connections.fetcher = healthCheckFetcher;
});

afterAll(async () => {
  await app.close();
});

describe('Apify source (MN-262) — real API surface', () => {
  it('rejects creating a source whose external key is not one of field_mapping\'s target fields', async () => {
    const { dbId, connectionId, urlField, titleField } = await setupDatabaseAndConnection('BadExternalKey');
    const otherField = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Unrelated',
      type: 'text',
      config: {},
    })).json();

    const res = await createApifySource(dbId, connectionId, 'BadExternalKey', { external_key_field_id: otherField.id }, urlField, titleField);
    expect(res.statusCode).toBe(400);
  });

  it('discover(): tier 1 reads the actor\'s last successful run without starting a new one', async () => {
    const { dbId, connectionId } = await setupDatabaseAndConnection('Discover');
    sourcesService.fetcher = async (url, init) => {
      if (init.method === 'POST') throw new Error('discover must not start a run when a prior success exists');
      if (url.includes('/runs?') && url.includes('status=SUCCEEDED')) {
        return { status: 200, json: async () => ({ data: { items: [{ defaultDatasetId: 'ds_discover' } ] } }), text: async () => '' };
      }
      if (url.includes('/datasets/ds_discover/items')) {
        return { status: 200, json: async () => [{ url: 'https://x.example', title: 'X' }], text: async () => '' };
      }
      throw new Error(`unexpected discover url: ${init.method ?? 'GET'} ${url}`);
    };

    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/discover`, {
      connection_id: connectionId,
      provider_source: 'apify.actor',
      config: { actor_id: 'apify/website-content-crawler' },
    });
    expect(res.statusCode, `discover failed: ${res.body}`).toBe(201);
    expect(res.json()).toEqual({ keys: ['url', 'title'] });
  });

  it('monthly_run_cap: syncs and upserts while under the cap, then skips (with a once-per-month notice) once it is hit', async () => {
    const { dbId, connectionId, urlField, titleField } = await setupDatabaseAndConnection('MonthlyCap');
    const created = await createApifySource(dbId, connectionId, 'MonthlyCap', {}, urlField, titleField);
    expect(created.statusCode, `source create failed: ${created.body}`).toBe(201);
    const sourceId = created.json().id as string;

    let runCounter = 0;
    sourcesService.fetcher = async (url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.includes('/acts/') && !url.includes('actor-runs')) {
        runCounter += 1;
        return { status: 200, json: async () => ({ data: { id: `run_${runCounter}` } }), text: async () => '' };
      }
      if (url.includes('/actor-runs/')) {
        return {
          status: 200,
          json: async () => ({
            data: {
              id: `run_${runCounter}`,
              status: 'SUCCEEDED',
              defaultDatasetId: `ds_${runCounter}`,
              usageTotalUsd: 0.02,
              stats: { computeUnits: 0.01 },
            },
          }),
          text: async () => '',
        };
      }
      if (url.includes('/datasets/')) {
        return {
          status: 200,
          json: async () => [{ url: `https://example.com/page-${runCounter}`, title: `Page ${runCounter}` }],
          text: async () => '',
        };
      }
      throw new Error(`unexpected apify url: ${method} ${url}`);
    };

    // 1st run — cap is 1, so this one is allowed and lands a record.
    const first = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(first.statusCode, `sync-now failed: ${first.body}`).toBe(201);
    expect(first.json()).toEqual(expect.objectContaining({ status: 'ok', fetched: 1, created: 1, updated: 0 }));
    expect(first.json().stats).toEqual(
      expect.objectContaining({ apify_run_id: 'run_1', apify_dataset_id: 'ds_1', compute_units: 0.01, usage_usd: 0.02 }),
    );

    const recsAfterFirst = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(recsAfterFirst).toHaveLength(1);

    // 2nd run this month — the cap (1) is already used, so this is skipped
    // WITHOUT ever calling the fetcher (no new Apify run, no new record).
    const second = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(second.json()).toEqual(expect.objectContaining({ status: 'skipped_cap', fetched: 0, created: 0, updated: 0 }));
    expect(runCounter).toBe(1); // no second run was started

    const recsAfterSecond = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(recsAfterSecond).toHaveLength(1); // unchanged

    const notifs = await inject('GET', `/workspaces/${wsId}/notifications?type=source_run_cap_reached`);
    const forThisSource = notifs.json().data.filter((n: { snippet: string | null }) => n.snippet?.includes('MonthlyCap apify'));
    expect(forThisSource).toHaveLength(1);

    // A 3rd skipped attempt this same month must not send a second notice.
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    const notifsAfterThird = await inject('GET', `/workspaces/${wsId}/notifications?type=source_run_cap_reached`);
    expect(
      notifsAfterThird.json().data.filter((n: { snippet: string | null }) => n.snippet?.includes('MonthlyCap apify')),
    ).toHaveLength(1); // still exactly one — deduped
  });

  it('a FAILED actor run surfaces the actor\'s statusMessage as the run error', async () => {
    const { dbId, connectionId, urlField, titleField } = await setupDatabaseAndConnection('FailedRun');
    const created = await createApifySource(dbId, connectionId, 'FailedRun', {}, urlField, titleField);
    const sourceId = created.json().id as string;

    sourcesService.fetcher = async (url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST' && url.includes('/acts/') && !url.includes('actor-runs')) {
        return { status: 200, json: async () => ({ data: { id: 'run_failed' } }), text: async () => '' };
      }
      if (url.includes('/actor-runs/')) {
        return {
          status: 200,
          json: async () => ({ data: { id: 'run_failed', status: 'FAILED', statusMessage: 'Target site blocked the crawler' } }),
          text: async () => '',
        };
      }
      throw new Error(`unexpected apify url: ${method} ${url}`);
    };

    const run = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(run.json()).toEqual(expect.objectContaining({ status: 'error', error: 'Target site blocked the crawler' }));

    const recs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(recs).toHaveLength(0);
  });
});
