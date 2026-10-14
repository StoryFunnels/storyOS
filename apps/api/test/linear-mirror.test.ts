import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { LinearService } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';

/**
 * #906 — the mirror refreshes itself on a schedule, says so loudly when it fails, flags a description edited in Linear
 * (without touching the StoryOS body), and marks issues that left scope instead of deleting them.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-m', key: 'MR', name: 'Mirror' };
const issue = (n: number, description: string | null) => ({ ...manyIssues(1)[0]!, id: `i${n}`, identifier: `MR-${n}`, title: `Issue ${n}`, description });

let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
let current: Array<Record<string, unknown>>;
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const use = (issues: Array<Record<string, unknown>>) => {
  current = issues;
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues } } }]).fetcher;
};
const cfg = async () => (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json();
async function recordsByTitle() {
  const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json();
  const db = dbs.find((d: { name: string }) => d.name === 'Issues');
  const rows = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records?limit=50`)).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
  return { db, byTitle: (t: string) => rows.find((r) => r.title === t)!, count: rows.length };
}
const docText = async (dbId: string, recId: string) => JSON.stringify((await inject('GET', `/workspaces/${ws}/databases/${dbId}/records/${recId}/document`)).json().content);

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Linear Mirror');
  ws = (await inject('POST', '/workspaces', { name: 'Linear Mirror WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['MR'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#906 schedule and loud failure', () => {
  it('auto-sync is OFF until an admin switches it on, and a tick does nothing for an off workspace', async () => {
    expect((await cfg()).auto_sync).toEqual({ enabled: false, interval_minutes: 60 });
    use([issue(1, 'first')]);
    await linear.tick();
    expect((await recordsByTitle().catch(() => ({ count: 0 }))).count, 'nothing synced by itself').toBe(0);
  });

  it('switched on: a tick syncs without anyone clicking, records the success, and is not due again within the interval', async () => {
    const on = await inject('POST', `/workspaces/${ws}/integrations/linear`, { auto_sync: { enabled: true } });
    expect(on.statusCode, on.body).toBe(201);
    expect(on.json().auto_sync).toEqual({ enabled: true, interval_minutes: 60 });
    await linear.tick();
    expect((await recordsByTitle()).count).toBe(1);
    const c = await cfg();
    expect(c.sync.last_success_at).toBeTruthy();
    expect(c.sync.last_error).toBeNull();
    expect(c.sync.stale).toBe(false);
    expect(c.sync.last_run).toMatchObject({ issues: 1 });
    use([issue(1, 'first'), issue(2, null)]);
    await linear.tick(); // same hour: not due
    expect((await recordsByTitle()).count, 'not re-run inside the interval').toBe(1);
    await linear.tick(new Date(Date.now() + 61 * 60_000)); // an hour later: due
    expect((await recordsByTitle()).count).toBe(2);
  });

  it('an invalid key makes the mirror visibly fail: the error is shown, it goes stale after 2 intervals, and a recovery clears it', async () => {
    const bad: LinearFetcher = async () => { throw new Error('Linear API 401 — check the API key'); };
    linear.fetcher = bad;
    const t = Date.now() + 2 * 60 * 60_000; // two hours on
    await linear.tick(new Date(t));
    const c = await cfg();
    expect(c.sync.last_error).toContain('Linear API 401');
    expect(c.sync.last_error_at).toBeTruthy();
    expect(c.sync.consecutive_failures).toBe(1);
    // staleness is evaluated against the real clock on read; make the last success old to prove the rule
    const stale = (linear as unknown as { present: (l: unknown, now: Date) => { sync: { stale: boolean } } }).present(
      { auto_sync: { enabled: true, interval_minutes: 60, enabled_at: new Date(0).toISOString() }, sync_status: { last_success_at: new Date(t - 3 * 60 * 60_000).toISOString() } },
      new Date(t),
    );
    expect(stale.sync.stale, 'no success in 3h on a 1h interval').toBe(true);
    use(current);
    await linear.tick(new Date(t + 2 * 60 * 60_000));
    const ok = await cfg();
    expect(ok.sync.last_error).toBeNull();
    expect(ok.sync.consecutive_failures).toBe(0);
  });

  it('a count mismatch on a scheduled run is a FAILED run, not a partial success (#902 still applies)', async () => {
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: current } } }], { issueCount: () => current.length + 1 }).fetcher;
    await linear.tick(new Date(Date.now() + 5 * 60 * 60_000));
    const c = await cfg();
    expect(c.sync.last_error).toContain('issues but');
    expect(c.sync.consecutive_failures).toBe(1);
    use(current);
  });
});

describe('#906 two API instances', () => {
  it('a due run can be claimed by exactly one of them; it is claimable again one interval later', async () => {
    const t = new Date(Date.now() + 10 * 60 * 60_000);
    expect(await linear.claimRun(ws, t, 60)).toBe(true);
    expect(await linear.claimRun(ws, t, 60), 'the second instance loses').toBe(false);
    expect(await linear.claimRun(ws, new Date(t.getTime() + 30 * 60_000), 60), 'not due again half an hour later').toBe(false);
    expect(await linear.claimRun(ws, new Date(t.getTime() + 61 * 60_000), 60), 'due again after the interval').toBe(true);
  });
});

describe('#906 overlapping runs', () => {
  it('a run that is still active blocks the next scheduled claim, even past the interval, and a manual sync is refused with 409', async () => {
    const t = new Date(Date.now() + 20 * 60 * 60_000);
    expect(await linear.acquireRun(ws, t), 'a run starts').toBe(true);
    expect((await cfg()).sync.running, 'the config says one is running').toBe(true);
    expect(await linear.acquireRun(ws, t), 'a second manual run cannot take it').toBe(false);
    expect(await linear.claimRun(ws, new Date(t.getTime() + 30 * 60_000), 15), 'due (past the 15 minute interval) but the run is still going: no second run').toBe(false);
    const manual = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(manual.statusCode, manual.body).toBe(409);
    expect(manual.body).toContain('already running');
    await linear.releaseRun(ws);
    expect((await cfg()).sync.running).toBe(false);
  });

  it('a run presumed dead (older than the lock timeout) no longer blocks, and a finished sync clears its mark', async () => {
    const t = new Date(Date.now() + 30 * 60 * 60_000);
    expect(await linear.acquireRun(ws, t)).toBe(true);
    expect(await linear.claimRun(ws, new Date(t.getTime() + 61 * 60_000), 15), 'a crashed run does not block forever').toBe(true);
    await linear.releaseRun(ws);
    use(current);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    expect((await cfg()).sync.running, 'a finished sync releases the mark').toBe(false);
  });

  it('a sync that FAILS also releases the mark, so one failure cannot block every later run', async () => {
    linear.fetcher = async () => { throw new Error('Linear API 500 — boom'); };
    const failed = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect((await cfg()).sync.running).toBe(false);
    use(current);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode, 'the next run is not blocked').toBe(201);
  });
});

describe('#906 description drift', () => {
  it('a description edited in Linear is flagged and stored beside the body; the StoryOS description is untouched', async () => {
    use([issue(1, 'first'), issue(2, 'Linear text v1')]);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    const { db, byTitle } = await recordsByTitle();
    const rec = byTitle('Issue 2');
    expect(rec.values.linear_description).toBe('Linear text v1');
    expect(rec.values.description_drift ?? false).toBe(false);
    expect(await docText(db.id, rec.id)).toContain('Linear text v1');
    // a person edits the StoryOS description
    const cur = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}/document`)).json();
    await inject('PUT', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}/document`, {
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agent notes built on this', styles: {} }] }], expected_version: cur.version,
    });
    // Linear's text changes
    use([issue(1, 'first'), issue(2, 'Linear text v2')]);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).json().drift_flagged).toBe(1);
    const after = (await recordsByTitle()).byTitle('Issue 2');
    expect(after.values.description_drift, 'flagged').toBe(true);
    expect(after.values.linear_description, 'new Linear text stored').toBe('Linear text v2');
    const body = await docText(db.id, rec.id);
    expect(body, 'the StoryOS description is unchanged').toContain('Agent notes built on this');
    expect(body).not.toContain('Linear text v2');
    // unchanged Linear text on the next sync: no new flag, and a cleared flag stays cleared
    await inject('PATCH', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}`, { values: { description_drift: false } });
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).json().drift_flagged).toBe(0);
    expect((await recordsByTitle()).byTitle('Issue 2').values.description_drift ?? false).toBe(false);
  });
});

describe('#906 leaving scope', () => {
  it('an issue Linear stops returning is marked, never deleted, and un-marks itself if it returns', async () => {
    use([issue(1, 'first')]); // issue 2 has left (archived / moved / deleted)
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().left_scope).toBe(1);
    const { byTitle, count } = await recordsByTitle();
    expect(count, 'not deleted').toBe(2);
    expect(String(byTitle('Issue 2').values.linear_status)).toMatch(/^Left Linear scope .* · \d{4}-\d{2}-\d{2}$/);
    expect(String(byTitle('Issue 1').values.linear_status), 'the others are untouched').not.toMatch(/Left Linear scope/);
    // marked once, not re-marked every run
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear/sync`)).json().left_scope).toBe(0);
    // it comes back
    use([issue(1, 'first'), issue(2, 'Linear text v2')]);
    await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(String((await recordsByTitle()).byTitle('Issue 2').values.linear_status)).not.toMatch(/Left Linear scope/);
  });
});
