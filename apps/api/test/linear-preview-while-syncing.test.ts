import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { LinearService } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';

/**
 * #1028 — on production the Linear Preview sat on "Checking…" for as long as a sync ran (about 19 minutes): a Preview reads everything
 * from Linear, exactly like a sync, so the two competed for the same API budget. The attack here is the person pressing Preview during
 * a sync; what is measured is how long it takes to be answered, and how many reads Linear sees from the Preview.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-p', key: 'PV', name: 'Preview' };
const { db } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

/** A Linear that answers like the fake, but holds every call until `release()`: a slow, large workspace. */
function gatedLinear() {
  const inner = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]);
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  let calls = 0;
  const fetcher: LinearFetcher = async (query, variables, apiKey) => {
    calls++;
    await gate;
    return inner.fetcher(query, variables, apiKey);
  };
  return { fetcher, release: open, calls: () => calls };
}
const waitFor = async (cond: () => Promise<boolean>, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('condition not met in time');
};
const running = async () => ((await db.execute(sql`SELECT settings->'linear'->'sync_status'->>'running_since' AS r FROM workspaces WHERE id = ${ws}`)) as unknown as { rows: Array<{ r: string | null }> }).rows[0]!.r;

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Preview Admin');
  ws = (await inject('POST', '/workspaces', { name: 'Preview WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['PV'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1028 Preview while a sync is running', () => {
  it('is answered AT ONCE with a plain sentence, and makes NO reads of its own; after the sync it works as before', async () => {
    const slow = gatedLinear();
    linear.fetcher = slow.fetcher;
    const sync = inject('POST', `/workspaces/${ws}/integrations/linear/sync`); // started, held open by the gate
    await waitFor(async () => (await running()) !== null);
    await waitFor(async () => slow.calls() > 0);
    const readsBefore = slow.calls();

    const started = Date.now();
    const preview = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    const took = Date.now() - started;
    expect(preview.statusCode, preview.body).toBe(409);
    expect(preview.body).toContain('A Linear sync is running');
    expect(took, 'answered immediately, not after the sync').toBeLessThan(1500);
    expect(slow.calls(), 'and the Preview did not read from Linear at all').toBe(readsBefore);

    slow.release();
    expect((await sync).statusCode).toBeLessThan(300);
    expect(await running(), 'the run lock is released').toBeNull();

    // with no sync running, Preview behaves as before
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]).fetcher;
    const after = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(after.statusCode, after.body).toBe(201);
    expect(after.json().teams[0]).toMatchObject({ key: 'PV', issues: 3 });
  });

  it('a STALE run lock (an hour old: a crashed process) does not block Preview forever', async () => {
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]).fetcher;
    await db.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,sync_status,running_since}', to_jsonb(${new Date(Date.now() - 61 * 60_000).toISOString()}::text)) WHERE id = ${ws}`);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`)).statusCode).toBe(201);
    await db.execute(sql`UPDATE workspaces SET settings = settings #- '{linear,sync_status,running_since}' WHERE id = ${ws}`);
  });

  it('a second Preview while one is already reading is refused at once, and Preview works again when the first ends', async () => {
    const slow = gatedLinear();
    linear.fetcher = slow.fetcher;
    const first = inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    await waitFor(async () => slow.calls() > 0);
    const readsBefore = slow.calls();
    const second = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.body).toContain('already running');
    expect(slow.calls()).toBe(readsBefore);
    slow.release();
    expect((await first).statusCode).toBe(201);
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]).fetcher;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`)).statusCode, 'the in-flight mark is cleared').toBe(201);
  });

  it('a Preview that FAILS clears its mark too (a bad key must not wedge Preview)', async () => {
    linear.fetcher = async () => { throw new Error('Linear API 401 — check the API key'); };
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`)).statusCode).toBeGreaterThanOrEqual(400);
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]).fetcher;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`)).statusCode).toBe(201);
  });
});
