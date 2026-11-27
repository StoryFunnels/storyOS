import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher } from './helpers/linear-fake';
import { issueShape, WORKFLOW_STATES } from './fixtures/linear-documented-shapes';
import { LinearService } from '../src/integrations/linear.service';
import { LinearStatusWriteBackService, ISSUE_STATUS_QUERY, ISSUE_STATUS_UPDATE_MUTATION } from '../src/integrations/linear-status-write-back.service';
import { statusWriteBack } from '../src/integrations/linear-ownership';
import type { OwnershipSettings } from '../src/integrations/linear-ownership';
import { FieldsService } from '../src/fields/fields.service';
import { MAX_ATTEMPTS } from '../src/common/backoff-schedule';

/**
 * Ticket #1390 — while a Linear team is StoryOS-owned (ticket #1370) and an admin switched it on for that team, a status change made
 * in StoryOS is written to the matching Linear issue: exactly once, coalesced to the latest, retried with backoff, visible when it
 * gives up. A team Linear owns never writes back.
 *
 * Linear's side is a MOCK built from the DOCUMENTED shapes (`issue { state team { states } }`, `issueUpdate(id, input: { stateId })`
 * answering `{ success, issue { state } }`), not a live capture: no Linear key exists. The probe against the real API has to confirm
 * those shapes, the state-name mapping, the rate limits and whether Linear's own echo of our write carries a different updatedAt.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const QUA = { id: 'team-qua', key: 'QUA', name: 'Quality' };
const KEY = 'lin_api_SECRET_status_write_back_key_0123456789';
const TODO = { type: 'unstarted', name: 'Todo' };

describe('statusWriteBack guard (pure)', () => {
  const owned = { ENG: { owner: 'storyos' as const, changed_at: 'x', changed_by: 'u' } };
  const on = { ENG: { enabled: true, enabled_at: '2026-12-01T00:00:00.000Z', changed_at: 'x', changed_by: 'u' } };
  it('needs BOTH: StoryOS owns the team and an admin switched it on', () => {
    expect(statusWriteBack({ team_ownership: owned, status_write_back: on }, 'ENG')).toEqual({ allowed: true, enabled_at: '2026-12-01T00:00:00.000Z' });
    expect(statusWriteBack({ team_ownership: owned }, 'ENG').allowed).toBe(false);
    expect(statusWriteBack({ status_write_back: on }, 'ENG').allowed).toBe(false); // switched on, but Linear owns the team
    expect(statusWriteBack({ team_ownership: { ENG: { ...owned.ENG, owner: 'linear' } }, status_write_back: on }, 'ENG').allowed).toBe(false);
    expect(statusWriteBack(undefined, 'ENG').allowed).toBe(false);
  });
  it('damaged write-back state reads OFF, never on', () => {
    for (const bad of [{ ENG: 'yes' }, { ENG: null }, { ENG: { enabled: 'true' } }, { ENG: { enabled: 1 } }]) {
      expect(statusWriteBack({ team_ownership: owned, status_write_back: bad } as unknown as OwnershipSettings, 'ENG').allowed).toBe(false);
    }
  });
  it('matches the team key case-insensitively', () => {
    expect(statusWriteBack({ team_ownership: owned, status_write_back: on }, 'eng').allowed).toBe(true);
  });
});

const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let svc: LinearStatusWriteBackService;
let admin: { token: string };
let member: Person;
let guest: Person;
let outsider: { token: string };
let demoted: Person;
let left: Person;
let ws: string;
let issuesByTeam: Record<string, Array<Record<string, unknown>>>;
/** Every request our write-back made to Linear, by kind. */
let reads: Array<{ id: unknown }>;
let updates: Array<{ id: string; input: Record<string, unknown>; query: string }>;
/** What Linear currently says each issue's state is (by issue id): the mock's own memory, changed only by an accepted issueUpdate. */
let linearState: Map<string, string>;
let failUpdates = 0;
let failWith = 'Linear API 500 — check the API key';
let loseResponseOnce = false;
/** Runs while an issueUpdate is in flight (after Linear accepted it, before the answer is back): a change made in StoryOS at that moment. */
let duringUpdate: (() => Promise<void>) | null = null;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => as(admin.token, method, url, payload);
const rows = async (q: ReturnType<typeof sql>) => (await rawDb.execute(q)).rows as Array<Record<string, unknown>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const use = (teams: Array<{ team: typeof ENG; issues: Array<Record<string, unknown>> }>) => {
  issuesByTeam = Object.fromEntries(teams.map((t) => [t.team.key, t.issues]));
  linearState = new Map(teams.flatMap((t) => t.issues.map((i) => [i['id'] as string, (i['state'] as { name: string }).name] as const)));
  const fake = makeLinearFetcher(teams.map((t) => ({ ...t.team, data: { ...empty, issues: { nodes: t.issues as never }, states: WORKFLOW_STATES } })));
  linear.fetcher = async (query, variables, key) => {
    if (query === ISSUE_STATUS_QUERY) {
      expect(key).toBe(KEY);
      reads.push({ id: variables['id'] });
      const name = linearState.get(String(variables['id']));
      if (name === undefined) return { issue: null };
      const state = WORKFLOW_STATES.find((s) => s.name === name)!;
      return { issue: { id: variables['id'], state: { id: state.id, name }, team: { id: 'team-x', key: 'X', states: { nodes: WORKFLOW_STATES.map(({ id, name: n, type }) => ({ id, name: n, type })), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (query === ISSUE_STATUS_UPDATE_MUTATION) {
      expect(key).toBe(KEY);
      updates.push({ id: String(variables['id']), input: variables['input'] as Record<string, unknown>, query });
      if (failUpdates > 0) { failUpdates -= 1; throw new Error(failWith); }
      const stateId = (variables['input'] as { stateId: string }).stateId;
      const st = WORKFLOW_STATES.find((s) => s.id === stateId);
      if (!st) return { issueUpdate: { success: false, issue: null } };
      linearState.set(String(variables['id']), st.name);
      // the sync's next read of the issue carries our change, as Linear's would
      for (const list of Object.values(issuesByTeam)) for (const i of list) if (i['id'] === variables['id']) i['state'] = { type: st.type, name: st.name };
      if (loseResponseOnce) { loseResponseOnce = false; throw new Error('socket hang up'); }
      if (duringUpdate) { const run = duringUpdate; duringUpdate = null; await run(); }
      return { issueUpdate: { success: true, issue: { id: variables['id'], state: { id: st.id, name: st.name } } } };
    }
    return fake.fetcher(query, variables, key);
  };
};

const urls = {
  owner: (key: string) => `/workspaces/${ws}/integrations/linear/teams/${key}/ownership`,
  writeBack: (key: string) => `/workspaces/${ws}/integrations/linear/teams/${key}/status-write-back`,
  read: () => `/workspaces/${ws}/linear/ownership`,
  config: () => `/workspaces/${ws}/integrations/linear`,
};
const spaceName = (key: string) => (key === 'ENG' ? 'Engineering (Linear)' : 'Quality (Linear)');
const issuesDbOf = async (key: string) =>
  (await rows(sql`select d.id from databases d join spaces s on s.id = d.space_id where s.workspace_id = ${ws} and s.name = ${spaceName(key)} and d.name = 'Issues' and d.deleted_at is null`))[0]!.id as string;
const recordOf = async (key: string, n: number) =>
  (await rows(sql`select id from records where database_id = ${await issuesDbOf(key)} and number = ${n} and deleted_at is null`))[0]!.id as string;
const stateOption = async (key: string, label: string) =>
  (await rows(sql`select so.id from select_options so join fields f on f.id = so.field_id where f.database_id = ${await issuesDbOf(key)} and f.api_name = 'state' and so.label = ${label}`))[0]!.id as string;
const setStatus = async (key: string, n: number, label: string) => {
  const res = await adm('PATCH', `/workspaces/${ws}/databases/${await issuesDbOf(key)}/records/${await recordOf(key, n)}`, { values: { state: await stateOption(key, label) } });
  expect(res.statusCode, res.body).toBe(200);
  await sleep(15);
};
const outbox = async (key: string, n: number) =>
  (await rows(sql`select status, attempts, generation, target_label, applied_label, applied_generation, last_error, change_source, next_attempt_at from linear_status_pushes where record_id = ${await recordOf(key, n)}`))[0] ?? null;
const outboxRows = async () => (await rows(sql`select count(*)::int as n from linear_status_pushes where workspace_id = ${ws}`))[0]!.n as number;
const setLinearSettings = async (patch: Record<string, unknown>) =>
  rawDb.execute(sql`update workspaces set settings = jsonb_set(settings, '{linear}', (settings->'linear') || ${JSON.stringify(patch)}::jsonb) where id = ${ws}`);
const turnOn = async (key: string) => { const r = await adm('PUT', urls.writeBack(key), { enabled: true }); expect(r.statusCode, r.body).toBe(200); await sleep(15); };
const cutOver = async (key: string) => { const r = await adm('PUT', urls.owner(key), { owner: 'storyos' }); expect(r.statusCode, r.body).toBe(200); };
const resetOutbox = async () => { await rawDb.execute(sql`delete from linear_status_pushes where workspace_id = ${ws}`); updates = []; reads = []; failUpdates = 0; loseResponseOnce = false; duringUpdate = null; };
const HOUR = 3_600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR);

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  svc = app.get(LinearStatusWriteBackService);
  admin = await signUpUser(app, 'StatusWB Admin');
  outsider = await signUpUser(app, 'StatusWB Outsider');
  ws = (await adm('POST', '/workspaces', { name: 'Status WB WS' })).json().id;
  member = await joinAs(app, admin.token, ws, 'StatusWB Member', 'member');
  const spaceId = ((await adm('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
  guest = await joinAs(app, admin.token, ws, 'StatusWB Guest', 'guest', [{ space_id: spaceId, role: 'editor' }]);
  demoted = await joinAs(app, admin.token, ws, 'StatusWB Demoted', 'admin');
  left = await joinAs(app, admin.token, ws, 'StatusWB Leaver', 'admin');
  const members = (await adm('GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user: { email: string } }>;
  const idOf = (p: Person) => members.find((m) => m.user.email === p.email)!.id;
  expect((await adm('PATCH', `/workspaces/${ws}/members/${idOf(demoted)}`, { role: 'member' })).statusCode).toBe(200);
  expect((await adm('DELETE', `/workspaces/${ws}/members/${idOf(left)}`)).statusCode).toBe(200);
  expect((await adm('POST', urls.config(), { api_key: KEY, team_keys: ['ENG', 'QUA'], auto_sync: { enabled: true } })).statusCode).toBe(201);
  updates = []; reads = [];
  use([
    { team: ENG, issues: [1, 2, 3, 4, 5].map((n) => issueShape(ENG, n, { title: `Secret engineering title ${n}`, state: TODO })) },
    { team: QUA, issues: [issueShape(QUA, 1, { title: 'Flaky checkout test', state: TODO })] },
  ]);
  expect((await adm('POST', `${urls.config()}/sync`)).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('who can switch it, and when', () => {
  it('a member, a guest, a demoted admin, a former member and a stranger are refused; no token is 401; nothing changed', async () => {
    for (const [who, token] of [['member', member.token], ['guest', guest.token], ['demoted admin', demoted.token], ['former member', left.token], ['stranger', outsider.token]] as const) {
      const res = await as(token, 'PUT', urls.writeBack('ENG'), { enabled: true });
      expect([403, 404], `${who}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    expect((await call(app, null, 'PUT', urls.writeBack('ENG'), { enabled: true })).statusCode).toBe(401);
    expect(await rows(sql`select 1 from workspaces where id = ${ws} and settings->'linear' ? 'status_write_back'`)).toEqual([]);
  });

  it('is refused while Linear owns the team: it can never be switched on for a team StoryOS does not own', async () => {
    const res = await adm('PUT', urls.writeBack('ENG'), { enabled: true });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toMatch(/owned by Linear/);
    expect((await adm('PUT', urls.writeBack('NOPE'), { enabled: true })).statusCode).toBe(404);
    expect((await adm('PUT', urls.writeBack('ENG'), { enabled: 'yes' })).statusCode).toBe(422);
  });

  it('a team Linear owns writes nothing even when its settings were forced on and its statuses change', async () => {
    await resetOutbox();
    await setLinearSettings({ status_write_back: { QUA: { enabled: true, enabled_at: '2020-01-01T00:00:00.000Z', changed_at: 'x', changed_by: 'x' } } });
    await setStatus('QUA', 1, 'In Progress');
    await svc.tick(later(1));
    expect(updates).toEqual([]);
    expect(reads).toEqual([]);
    expect(await outboxRows()).toBe(0);
    await setLinearSettings({ status_write_back: {} });
  });
});

describe('default OFF: cutting a team over changes nothing about Linear', () => {
  it('a StoryOS-owned team whose write-back was never switched on writes nothing and queues nothing', async () => {
    await cutOver('ENG');
    await setStatus('ENG', 1, 'In Progress');
    await svc.tick(later(1));
    expect(updates).toEqual([]);
    expect(await outboxRows()).toBe(0);
    const owned = (await adm('GET', urls.read())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG');
    expect(owned.owner).toBe('storyos');
    expect(owned.status_write_back).toEqual({ enabled: false, pending: 0, failed: 0, unmapped: 0 });
  });
});

describe('switched on for a StoryOS-owned team', () => {
  it('switching it on is audited; the change that happened BEFORE is not replayed; it is readable by a member as counts', async () => {
    await resetOutbox();
    await turnOn('ENG');
    const event = await rows(sql`select actor_id, payload from activity_events where workspace_id = ${ws} and type = 'linear_status_write_back.changed' order by created_at desc limit 1`);
    expect(event[0]).toMatchObject({ payload: { enabled: true, object: { id: 'ENG' } } });
    expect(event[0]!.actor_id).toBeTruthy();
    await svc.tick(later(1));
    expect(updates, 'ENG-1 was set to In Progress before the switch was on').toEqual([]);
    expect(await outboxRows()).toBe(0);
    const seen = (await as(member.token, 'GET', urls.read())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG');
    expect(seen.status_write_back).toEqual({ enabled: true, pending: 0, failed: 0, unmapped: 0 });
    expect((await adm('PUT', urls.writeBack('ENG'), { enabled: true })).json().unchanged).toBe(true);
  });

  it('a status change is written to the matching Linear issue exactly once, and ONLY the status', async () => {
    await setStatus('ENG', 2, 'In Progress');
    await svc.tick(later(1));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 'lin-eng-2', input: { stateId: 'st-prog' } });
    expect(Object.keys(updates[0]!.input)).toEqual(['stateId']);
    // nothing the record holds (title, body) went to Linear, in the variables or in the query text
    expect(JSON.stringify(updates)).not.toMatch(/Secret engineering title/);
    expect(updates[0]!.query).toBe(ISSUE_STATUS_UPDATE_MUTATION);
    expect(await outbox('ENG', 2)).toMatchObject({ status: 'sent', applied_label: 'In Progress', target_label: 'In Progress', attempts: 1 });
    await svc.tick(later(2));
    await svc.tick(later(3));
    expect(updates, 'a sent status is never sent again').toHaveLength(1);
  });

  it('rapid changes coalesce into the latest: one write of the final status, and a change back to what Linear holds is no write at all', async () => {
    await resetOutbox();
    await setStatus('ENG', 3, 'In Progress');
    await setStatus('ENG', 3, 'Done');
    await svc.tick(later(1));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toEqual({ stateId: 'st-done' });
    const row = await outbox('ENG', 3);
    expect(row).toMatchObject({ status: 'sent', applied_label: 'Done' });
    // Todo -> In Progress -> Todo before the tick: Linear already says Todo, so nothing is queued and nothing is written
    await setStatus('ENG', 4, 'In Progress');
    await setStatus('ENG', 4, 'Todo');
    await svc.tick(later(2));
    expect(updates).toHaveLength(1);
    expect(await outbox('ENG', 4)).toBeNull();
  });

  it('the change id only goes up: a newer change after a send is a new generation, written once', async () => {
    const before = (await outbox('ENG', 3))!;
    await setStatus('ENG', 3, 'In Progress');
    await svc.tick(later(3));
    const after = (await outbox('ENG', 3))!;
    expect(after.generation).toBe((before.generation as number) + 1);
    expect(after).toMatchObject({ status: 'sent', applied_label: 'In Progress', applied_generation: after.generation });
    expect(updates.at(-1)!.input).toEqual({ stateId: 'st-prog' });
  });

  it('a change made while a send is in flight is never buried by that send: its outcome is stored only for the generation it carried', async () => {
    await resetOutbox();
    await setStatus('ENG', 3, 'Todo');
    await svc.tick(later(4));
    updates = [];
    await setStatus('ENG', 3, 'Done');
    duringUpdate = async () => {
      await setStatus('ENG', 3, 'In Progress');
      expect(await svc.enqueueEligible(ws, later(5))).toBe(1); // re-aimed at In Progress while the Done write is still out
    };
    await svc.tick(later(5));
    expect(updates.map((u) => u.input)).toEqual([{ stateId: 'st-done' }]);
    const mid = (await outbox('ENG', 3))!;
    expect(mid, 'the stale send did not mark the newer change sent').toMatchObject({ status: 'pending', target_label: 'In Progress' });
    await svc.tick(later(6));
    expect(updates.map((u) => u.input)).toEqual([{ stateId: 'st-done' }, { stateId: 'st-prog' }]);
    expect(await outbox('ENG', 3)).toMatchObject({ status: 'sent', applied_label: 'In Progress', generation: mid.generation });
  });

  it('records who changed it: the history source is kept on the outbox row', async () => {
    const row = (await outbox('ENG', 3))!;
    const history = await rows(sql`select source from record_field_changes where record_id = ${await recordOf('ENG', 3)} order by created_at desc limit 1`);
    expect(row['change_source']).toBe((history[0]?.source as string | undefined) ?? null);
  });
});

describe('retry, exactly once, and the dead letter', () => {
  it('a failing write backs off, is not retried before it is due, and succeeds later exactly once', async () => {
    await resetOutbox();
    await setStatus('ENG', 5, 'In Progress');
    failUpdates = 2;
    const t0 = later(1);
    await svc.tick(t0);
    expect(updates).toHaveLength(1);
    expect(await outbox('ENG', 5)).toMatchObject({ status: 'pending', attempts: 1 });
    await svc.tick(t0); // same moment: not due yet
    expect(updates).toHaveLength(1);
    await svc.tick(new Date(t0.getTime() + 60_000)); // 30 s backoff passed: attempt 2, fails again
    expect(updates).toHaveLength(2);
    expect(await outbox('ENG', 5)).toMatchObject({ status: 'pending', attempts: 2 });
    await svc.tick(new Date(t0.getTime() + 60_000 + 600_000)); // attempt 3 reaches Linear
    expect(updates).toHaveLength(3);
    expect(await outbox('ENG', 5)).toMatchObject({ status: 'sent', applied_label: 'In Progress', last_error: null });
    await svc.tick(new Date(t0.getTime() + 2 * HOUR));
    expect(updates, 'applied once: never again').toHaveLength(3);
  });

  it('a lost response (Linear stored it, the answer never came) is not applied twice: the retry finds it already in place', async () => {
    await resetOutbox();
    await setStatus('ENG', 1, 'Done');
    loseResponseOnce = true;
    const t0 = later(5);
    await svc.tick(t0);
    expect(updates).toHaveLength(1);
    expect(await outbox('ENG', 1)).toMatchObject({ status: 'pending', attempts: 1 });
    await svc.tick(new Date(t0.getTime() + 60_000));
    expect(updates, 'the retry read Linear, saw Done, and sent nothing').toHaveLength(1);
    expect(await outbox('ENG', 1)).toMatchObject({ status: 'sent', applied_label: 'Done', attempts: 2 });
  });

  it(`after ${MAX_ATTEMPTS} attempts it is a dead letter that an admin sees (settings, Preview, sync summary), with the key, URLs and hosts redacted; off and on retries it`, async () => {
    await resetOutbox();
    await setStatus('ENG', 2, 'Done');
    failUpdates = 99;
    failWith = `Linear API 502 at https://api.linear.app/graphql with key ${KEY} via gateway.example.net`;
    let t = later(10);
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) { await svc.tick(t); t = new Date(t.getTime() + 2 * HOUR); }
    expect(updates).toHaveLength(MAX_ATTEMPTS);
    const row = (await outbox('ENG', 2))!;
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(String(row['last_error'])).toMatch(/502/);
    for (const secret of [KEY, 'api.linear.app', 'gateway.example.net', 'https://']) expect(String(row['last_error'])).not.toContain(secret);
    await svc.tick(t);
    expect(updates, 'a dead letter is not retried by itself').toHaveLength(MAX_ATTEMPTS);

    const cfg = (await adm('GET', urls.config())).json().status_write_back;
    expect(cfg).toMatchObject({ failed: 1, pending: 0, unmapped: 0, teams: { ENG: { enabled: true, failed: 1 } } });
    expect(cfg.failures).toEqual([expect.objectContaining({ team_key: 'ENG', status: 'failed', target_label: 'Done', attempts: MAX_ATTEMPTS })]);
    expect(JSON.stringify(await adm('GET', urls.config()).then((r) => r.json()))).not.toContain(KEY);
    expect((await adm('GET', urls.read())).json().data.find((x: { team_key: string }) => x.team_key === 'ENG').status_write_back).toMatchObject({ failed: 1 });
    const preview = (await adm('POST', `${urls.config()}/dry-run`)).json();
    expect(preview.teams.find((x: { key: string }) => x.key === 'ENG').status_write_back).toMatchObject({ enabled: true, failed: 1 });
    const sync = await adm('POST', `${urls.config()}/sync`);
    expect(sync.json().status_write_back).toMatchObject({ failed: 1, pending: 0, unmapped: 0 });

    // an admin fixes the cause, switches it off and on: the dead letter goes back in the queue
    failUpdates = 0;
    expect((await adm('PUT', urls.writeBack('ENG'), { enabled: false })).statusCode).toBe(200);
    await svc.tick(t);
    expect(updates, 'switched off: nothing is sent').toHaveLength(MAX_ATTEMPTS);
    await turnOn('ENG');
    await svc.tick(new Date(t.getTime() + HOUR));
    expect(updates).toHaveLength(MAX_ATTEMPTS + 1);
    expect(await outbox('ENG', 2)).toMatchObject({ status: 'sent', applied_label: 'Done' });
    failWith = 'Linear API 500 — check the API key';
  });
});

describe('a status Linear has no state for is never guessed', () => {
  it('stays unwritten, is reported (settings, Preview, sync summary), and a later real status still goes out', async () => {
    await resetOutbox();
    const db = await issuesDbOf('ENG');
    const stateField = (await rows(sql`select id from fields where database_id = ${db} and api_name = 'state'`))[0]!.id as string;
    await app.get(FieldsService).addOption(db, stateField, { label: 'Won\'t Fix', color: 'gray' });
    await setStatus('ENG', 4, 'Won\'t Fix');
    await svc.tick(later(20));
    expect(updates, 'no guess: not Todo, not the nearest name').toEqual([]);
    expect(await outbox('ENG', 4)).toMatchObject({ status: 'unmapped', target_label: 'Won\'t Fix' });
    expect(String((await outbox('ENG', 4))!['last_error'])).toMatch(/Won't Fix/);
    await svc.tick(later(40));
    expect(updates, 'unmapped is not retried on a timer').toEqual([]);
    expect((await adm('GET', urls.config())).json().status_write_back).toMatchObject({ unmapped: 1, failed: 0 });
    expect((await adm('POST', `${urls.config()}/dry-run`)).json().teams.find((x: { key: string }) => x.key === 'ENG').status_write_back).toMatchObject({ unmapped: 1 });
    expect((await adm('POST', `${urls.config()}/sync`)).json().status_write_back).toMatchObject({ unmapped: 1 });
    await setStatus('ENG', 4, 'Done');
    await svc.tick(later(41));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.input).toEqual({ stateId: 'st-done' });
    expect(await outbox('ENG', 4)).toMatchObject({ status: 'sent', applied_label: 'Done' });
  });
});

describe('the guard holds at send time too, and a read of our own write is never a new change', () => {
  it('handing the team back to Linear cancels what was queued: the send re-checks ownership, it does not trust the queue', async () => {
    await resetOutbox();
    await setStatus('ENG', 5, 'Done');
    // queued, not yet sent
    await svc.enqueueEligible(ws, later(30));
    expect(await outbox('ENG', 5)).toMatchObject({ status: 'pending' });
    const back = await adm('PUT', urls.owner('ENG'), { owner: 'linear', confirm_overwrite: true });
    expect(back.statusCode, back.body).toBe(200);
    await svc.tick(later(31));
    expect(updates).toEqual([]);
    expect(await outbox('ENG', 5)).toMatchObject({ status: 'cancelled' });
    // handing back switched the team's write-back off, with its own audit event
    expect((await adm('GET', urls.read())).json().data.find((x: { team_key: string }) => x.team_key === 'ENG').status_write_back.enabled).toBe(false);
    expect((await rows(sql`select 1 from activity_events where workspace_id = ${ws} and type = 'linear_status_write_back.changed' and payload->>'reason' = 'team handed back to Linear'`)).length).toBe(1);
    expect((await adm('PUT', urls.writeBack('ENG'), { enabled: true })).statusCode, 'and it cannot be switched on again until StoryOS owns the team').toBe(409);
  });

  it('after our write, neither a manual sync nor the scheduled one applies it as a foreign change or queues it again', async () => {
    await resetOutbox();
    await cutOver('ENG');
    await turnOn('ENG');
    await setStatus('ENG', 5, 'Done');
    await svc.tick(later(50));
    expect(updates).toHaveLength(1);
    const generation = (await outbox('ENG', 5))!.generation;
    const historyBefore = (await rows(sql`select count(*)::int as n from record_field_changes where record_id = ${await recordOf('ENG', 5)}`))[0]!.n;
    expect(await adm('POST', `${urls.config()}/sync`).then((r) => r.statusCode)).toBe(201);
    await linear.tick(later(52));
    await svc.tick(later(53));
    await svc.tick(later(54));
    expect(updates, 'Linear now says Done (our own write); nothing is written back').toHaveLength(1);
    expect((await outbox('ENG', 5))!.generation).toBe(generation);
    expect(await outboxRows()).toBe(1);
    // the sync never wrote the StoryOS-owned record: no history row, no new value
    expect((await rows(sql`select count(*)::int as n from record_field_changes where record_id = ${await recordOf('ENG', 5)}`))[0]!.n).toBe(historyBefore);

  });

  it('a Linear-side change that the sync writes into a team Linear owns is not queued back to Linear', async () => {
    await resetOutbox();
    (issuesByTeam['QUA']![0] as Record<string, unknown>)['state'] = { type: 'completed', name: 'Done' };
    expect((await adm('POST', `${urls.config()}/sync`)).statusCode).toBe(201);
    await svc.tick(later(60));
    expect(updates).toEqual([]);
    expect((await rows(sql`select count(*)::int as n from linear_status_pushes where team_key = 'QUA'`))[0]!.n).toBe(0);
    expect((await rows(sql`select count(*)::int as n from records where database_id = ${await issuesDbOf('QUA')} and values::text like '%Done%'`))[0]!.n, 'the sync did write the Linear change into QUA').toBeGreaterThan(0);
  });
});
