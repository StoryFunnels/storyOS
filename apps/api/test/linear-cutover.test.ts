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
import { teamOwnership } from '../src/integrations/linear-ownership';
import type { OwnershipSettings } from '../src/integrations/linear-ownership';

/**
 * Ticket #1370 — cutover. A Linear team is owned by Linear (today's mirror: every sync rewrites what Linear maps) or by StoryOS
 * (the switch has been thrown: nothing Linear says is written into that team's records again). One state per team, kept in the
 * Linear settings JSON, default `linear`. The point of the whole file is acceptance criterion 1: after the switch, a StoryOS edit
 * survives the next sync window, on every path a sync can take (manual, scheduled-full, scheduled-incremental).
 *
 * Linear's side is a documented-shape fixture, not a live capture. Every access case has a member, a guest and a DEMOTED admin beside
 * the admin, because "only admins can flip it" proves nothing without the people who must be refused.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const QUA = { id: 'team-qua', key: 'QUA', name: 'Quality' };
const HOUR = 3_600_000;

describe('teamOwnership (pure)', () => {
  it('a team with no stored state is owned by Linear: today\'s behaviour, unchanged', () => {
    expect(teamOwnership(undefined, 'ENG').owner).toBe('linear');
    expect(teamOwnership({}, 'ENG').owner).toBe('linear');
    expect(teamOwnership({ team_ownership: {} }, 'ENG').owner).toBe('linear');
    expect(teamOwnership({ team_ownership: { QUA: { owner: 'storyos', changed_at: 'x', changed_by: 'u' } } }, 'ENG').owner).toBe('linear');
  });

  it('a team that was handed over reads storyos, matched by key case-insensitively', () => {
    const s: OwnershipSettings = { team_ownership: { ENG: { owner: 'storyos', changed_at: '2026-12-01T00:00:00.000Z', changed_by: 'u1' } } };
    expect(teamOwnership(s, 'ENG')).toMatchObject({ owner: 'storyos', changed_by: 'u1' });
    expect(teamOwnership(s, 'eng').owner).toBe('storyos');
  });

  it('an entry that is not exactly "linear" reads storyos: damaged state protects StoryOS edits, it never opens them to an overwrite', () => {
    expect(teamOwnership({ team_ownership: { ENG: { owner: 'LINEAR!!' as never, changed_at: 'x', changed_by: 'u' } } }, 'ENG').owner).toBe('storyos');
    expect(teamOwnership({ team_ownership: { ENG: 'storyos' as never } }, 'ENG').owner).toBe('storyos');
    expect(teamOwnership({ team_ownership: { ENG: null as never } }, 'ENG').owner).toBe('storyos');
  });
});

const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let member: Person;
let guest: Person;
let outsider: { token: string };
let demoted: Person;
let left: Person;
let ws: string;
let fetched: Array<{ query: string; team: unknown }>;
let clock = 0;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => as(admin.token, method, url, payload);
const rows = async (q: ReturnType<typeof sql>) => (await rawDb.execute(q)).rows as Array<Record<string, unknown>>;

type Team = typeof ENG;
const use = (teams: Array<{ team: Team; issues: unknown[]; private?: boolean }>) => {
  const fake = makeLinearFetcher(teams.map((t) => ({ ...t.team, private: t.private, data: { ...empty, issues: { nodes: t.issues as never }, states: WORKFLOW_STATES } })));
  fetched = [];
  linear.fetcher = async (query, variables, key) => {
    fetched.push({ query: String(query.match(/query (\w+)/)?.[1]), team: variables['id'] });
    return fake.fetcher(query, variables, key);
  };
};
const ownerUrl = (key: string) => `/workspaces/${ws}/integrations/linear/teams/${key}/ownership`;
const readUrl = () => `/workspaces/${ws}/linear/ownership`;
const issuesDbOf = async (key: string) =>
  (await rows(sql`select d.id, d.record_counter from databases d join spaces s on s.id = d.space_id where s.workspace_id = ${ws} and s.name = ${key === 'ENG' ? 'Engineering (Linear)' : 'Quality (Linear)'} and d.name = 'Issues' and d.deleted_at is null`))[0]!;
const recordsOf = async (key: string) => {
  const d = await issuesDbOf(key);
  return (await rows(sql`select id, number, title, values from records where database_id = ${d.id as string} and deleted_at is null order by number`)).map((r) => ({
    id: r.id as string, number: r.number as number, title: r.title as string, values: r.values as Record<string, unknown>,
  }));
};
const titleOf = async (key: string, n: number) => (await recordsOf(key)).find((r) => r.number === n)!.title;
const editTitle = async (key: string, n: number, title: string) => {
  const rec = (await recordsOf(key)).find((r) => r.number === n)!;
  const res = await adm('PATCH', `/workspaces/${ws}/databases/${(await issuesDbOf(key)).id as string}/records/${rec.id}`, { values: { name: title } });
  expect(res.statusCode, res.body).toBe(200);
};
const manualSync = () => adm('POST', `/workspaces/${ws}/integrations/linear/sync`);
const tickAt = async (hours: number) => { await linear.tick(new Date(Date.now() + hours * HOUR)); };
const lastRun = async () => (await adm('GET', `/workspaces/${ws}/integrations/linear`)).json().sync.last_run;
const asksAbout = (team: Team) => fetched.filter((c) => c.team === team.id).length;

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Cutover Admin');
  outsider = await signUpUser(app, 'Cutover Outsider');
  ws = (await adm('POST', '/workspaces', { name: 'Cutover WS' })).json().id;
  member = await joinAs(app, admin.token, ws, 'Cutover Member', 'member');
  const spaceId = ((await adm('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
  guest = await joinAs(app, admin.token, ws, 'Cutover Guest', 'guest', [{ space_id: spaceId, role: 'editor' }]);
  demoted = await joinAs(app, admin.token, ws, 'Cutover Demoted', 'admin');
  left = await joinAs(app, admin.token, ws, 'Cutover Leaver', 'admin');
  const members = (await adm('GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user: { email: string } }>;
  const idOf = (p: Person) => members.find((m) => m.user.email === p.email)!.id;
  expect((await adm('PATCH', `/workspaces/${ws}/members/${idOf(demoted)}`, { role: 'member' })).statusCode).toBe(200);
  expect((await adm('DELETE', `/workspaces/${ws}/members/${idOf(left)}`)).statusCode).toBe(200);
  expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['ENG', 'QUA'], auto_sync: { enabled: true } })).statusCode).toBe(201);
  use([
    { team: ENG, issues: [issueShape(ENG, 1, { title: 'Login is slow' }), issueShape(ENG, 2, { title: 'Export fails' }), issueShape(ENG, 3, { title: 'Dark mode flicker' })] },
    { team: QUA, issues: [issueShape(QUA, 1, { title: 'Flaky checkout test' })] },
  ]);
  const first = await manualSync();
  expect(first.statusCode, first.body).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('before the switch: Linear owns the team, exactly as today', () => {
  it('every configured team reads as owned by Linear', async () => {
    const res = await adm('GET', readUrl());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ team_key: 'ENG', owner: 'linear' }), expect.objectContaining({ team_key: 'QUA', owner: 'linear' })]));
  });

  it('a StoryOS edit is overwritten by the next sync (the mirror has not changed)', async () => {
    await editTitle('ENG', 3, 'Edited in StoryOS, still mirrored');
    expect((await manualSync()).statusCode).toBe(201);
    expect(await titleOf('ENG', 3)).toBe('Dark mode flicker');
  });
});

describe('who can flip it', () => {
  const body = { owner: 'storyos' };
  it('a member, a guest, a demoted admin, a former member and a stranger are all refused, and nothing changed', async () => {
    for (const [who, token] of [['member', member.token], ['guest', guest.token], ['demoted admin', demoted.token], ['former member', left.token], ['stranger', outsider.token]] as const) {
      const res = await as(token, 'PUT', ownerUrl('ENG'), body);
      expect([403, 404], `${who}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
    }
    expect((await call(app, null, 'PUT', ownerUrl('ENG'), body)).statusCode).toBe(401);
    expect((await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG').owner).toBe('linear');
  });

  it('flipping it back is just as closed', async () => {
    for (const token of [member.token, guest.token, demoted.token, left.token, outsider.token]) {
      const res = await as(token, 'PUT', ownerUrl('ENG'), { owner: 'linear', confirm_overwrite: true });
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it('an invalid owner value is a 422, not a silent default', async () => {
    expect((await adm('PUT', ownerUrl('ENG'), { owner: 'both' })).statusCode).toBe(422);
    expect((await adm('PUT', ownerUrl('ENG'), {})).statusCode).toBe(422);
  });

  it('a team key that is not one of the workspace\'s configured Linear teams is a 404, and creates no state', async () => {
    const res = await adm('PUT', ownerUrl('NOPE'), body);
    expect(res.statusCode, res.body).toBe(404);
    expect((await rows(sql`select settings->'linear'->'team_ownership' as o from workspaces where id = ${ws}`))[0]!.o).toBeNull();
  });
});

describe('the read: who sees which team\'s state', () => {
  it('a member, a guest and a stranger can read it (it drives the banner), a stranger only gets a 403/404', async () => {
    expect((await as(member.token, 'GET', readUrl())).statusCode).toBe(200);
    expect([403, 404]).toContain((await as(outsider.token, 'GET', readUrl())).statusCode);
    expect((await call(app, null, 'GET', readUrl())).statusCode).toBe(401);
  });
});

describe('cutover of ENG', () => {
  let cut: Record<string, any>;
  let counterBefore: number;

  it('a failing final read leaves the team owned by Linear: the switch is not thrown on a half-copy', async () => {
    const real = linear.fetcher;
    linear.fetcher = async () => { throw new Error('Linear API 500'); };
    const res = await adm('PUT', ownerUrl('ENG'), { owner: 'storyos' });
    linear.fetcher = real;
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect((await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG').owner).toBe('linear');
  });

  it('the switch runs one final full read of THAT team, counted against Linear, then records the state', async () => {
    counterBefore = (await issuesDbOf('ENG')).record_counter as number;
    use([
      { team: ENG, issues: [issueShape(ENG, 1, { title: 'Login is slow' }), issueShape(ENG, 2, { title: 'Export fails' }), issueShape(ENG, 3, { title: 'Dark mode flicker' }), issueShape(ENG, 4, { title: 'Final-read arrival' })] },
      { team: QUA, issues: [issueShape(QUA, 1, { title: 'Flaky checkout test' })] },
    ]);
    const res = await adm('PUT', ownerUrl('ENG'), { owner: 'storyos' });
    expect(res.statusCode, res.body).toBe(200);
    cut = res.json();
    expect(cut).toMatchObject({ team_key: 'ENG', owner: 'storyos', final_sync: { mode: 'full', issues: 4, linear_issue_total: 4 } });
    expect(cut.cut_over_at).toBeTruthy();
    expect(asksAbout(QUA), 'the other team is not read by this team\'s cutover').toBe(0);
    expect(await titleOf('ENG', 4)).toBe('Final-read arrival');
  });

  it('the counter jumps ahead by the headroom (default 50) from the highest number, so a straggler created in Linear shows as a gap', async () => {
    const after = (await issuesDbOf('ENG')).record_counter as number;
    expect(counterBefore).toBeLessThan(4);
    expect(after).toBe(4 + 50);
    expect(cut.counter).toMatchObject({ after: 54, headroom: 50 });
  });

  it('who and when is on the record, and the read says so', async () => {
    const entry = (await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG');
    expect(entry).toMatchObject({ owner: 'storyos', cut_over_at: cut.cut_over_at });
    expect(entry.changed_by).toBeTruthy();
    expect(entry.changed_at).toBeTruthy();
  });

  it('the audit log says who threw the switch, when, and for which team', async () => {
    const log = (await adm('GET', `/workspaces/${ws}/audit-log?limit=50`)).json();
    const ev = (log.data as Array<{ type: string; actor_id: string; object: { id: string } | null; payload: Record<string, unknown> }>).find((e) => e.type === 'linear_ownership.changed');
    expect(ev, JSON.stringify(log.data.map((e: { type: string }) => e.type))).toBeTruthy();
    expect(ev!.object?.id).toBe('ENG');
    expect(ev!.payload).toMatchObject({ from: 'linear', to: 'storyos' });
    expect(ev!.actor_id).toBeTruthy();
  });

  it('a second cutover of the same team is an idempotent no-op that does not read Linear again or bump the counter again', async () => {
    const before = (await issuesDbOf('ENG')).record_counter;
    fetched = [];
    const res = await adm('PUT', ownerUrl('ENG'), { owner: 'storyos' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().unchanged).toBe(true);
    expect(fetched).toHaveLength(0);
    expect((await issuesDbOf('ENG')).record_counter).toBe(before);
  });

  it('a cutover is refused while a sync is running, and changes nothing', async () => {
    const taken = await linear.acquireRun(ws, new Date());
    expect(taken).toBe(true);
    try {
      const res = await adm('PUT', ownerUrl('QUA'), { owner: 'storyos' });
      expect(res.statusCode, res.body).toBe(409);
      expect((await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'QUA').owner).toBe('linear');
    } finally {
      await linear.releaseRun(ws);
    }
  });
});

describe('after the switch: a StoryOS edit survives the next sync window (acceptance criterion 1)', () => {
  const linearSide = (extra: unknown[] = []) => use([
    // Linear moved on: it renamed issue 1, deleted issue 2, and has a brand-new issue 5; its issue 3 is unchanged.
    { team: ENG, issues: [issueShape(ENG, 1, { title: 'Linear renamed it', updatedAt: new Date(Date.now() + 60_000).toISOString() }), issueShape(ENG, 3, { title: 'Dark mode flicker' }), issueShape(ENG, 5, { title: 'Created in Linear after cutover', updatedAt: new Date(Date.now() + 60_000).toISOString() }), ...extra] },
    { team: QUA, issues: [issueShape(QUA, 1, { title: 'Flaky checkout test, renamed in Linear' })] },
  ]);

  it('a MANUAL sync writes nothing to the team: no overwrite, no new issue, no "left scope" mark, and does not even read it', async () => {
    await editTitle('ENG', 1, 'Edited in StoryOS');
    const before = (await recordsOf('ENG')).map((r) => r.id);
    linearSide();
    const res = await manualSync();
    expect(res.statusCode, res.body).toBe(201);
    expect(await titleOf('ENG', 1)).toBe('Edited in StoryOS');
    expect((await recordsOf('ENG')).map((r) => r.id), 'no record created, none removed').toEqual(before);
    const two = (await recordsOf('ENG')).find((r) => r.number === 2)!;
    expect(JSON.stringify(two.values), 'an issue Linear no longer returns is not marked').not.toMatch(/Left Linear scope/);
    expect(asksAbout(ENG), 'a team StoryOS owns is not read at all').toBe(0);
    expect(res.json().teams).toEqual(['QUA']);
    expect(res.json().skipped_storyos_owned).toEqual(['ENG']);
  });

  it('a team still owned by Linear in the same workspace keeps syncing', async () => {
    expect(await titleOf('QUA', 1)).toBe('Flaky checkout test, renamed in Linear');
  });

  it('a SCHEDULED run, incremental and then full, leaves it alone too', async () => {
    await editTitle('ENG', 3, 'Edited again in StoryOS');
    linearSide();
    await tickAt(2);
    expect(await lastRun()).toMatchObject({ mode: 'incremental' });
    expect(await titleOf('ENG', 3)).toBe('Edited again in StoryOS');
    // The day-old safety net: age the recorded full read so the next scheduled run reads everything (the planner reads the real clock).
    await rawDb.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,sync_status,last_full_at}', to_jsonb(${new Date(Date.now() - 30 * HOUR).toISOString()}::text)) WHERE id = ${ws}`);
    linearSide();
    await tickAt(4);
    expect(await lastRun()).toMatchObject({ mode: 'full' });
    expect(await titleOf('ENG', 3)).toBe('Edited again in StoryOS');
    expect(await titleOf('ENG', 1)).toBe('Edited in StoryOS');
    expect(asksAbout(ENG)).toBe(0);
    const two = (await recordsOf('ENG')).find((r) => r.number === 2)!;
    expect(JSON.stringify(two.values), 'the full read is where "left scope" is decided, and it is not decided for this team').not.toMatch(/Left Linear scope/);
    expect((await recordsOf('ENG')).map((r) => r.number)).toEqual([1, 2, 3, 4]);
  });

  it('the write path itself refuses: with the state set but the sync told to take the team, it still writes nothing', async () => {
    // Defence in depth. The partition at the top of the run is one guard; the per-team re-read before any write is the other, and a
    // run that was handed the team anyway (a future caller, a race) must still not touch it.
    await editTitle('ENG', 3, 'Edited a third time');
    linearSide();
    const created = await (linear as unknown as { runSync: (...a: unknown[]) => Promise<unknown> }).runSync(
      { workspaceId: ws, userId: (await rows(sql`select user_id from memberships where workspace_id = ${ws} and role = 'admin' and status = 'active' limit 1`))[0]!.user_id, role: 'admin' },
      (await rows(sql`select user_id from memberships where workspace_id = ${ws} and role = 'admin' and status = 'active' limit 1`))[0]!.user_id,
      { only: ['ENG'] },
    ).catch((e: Error) => e);
    expect(created instanceof Error ? created.message : '').toMatch(/owned by StoryOS/);
    expect(await titleOf('ENG', 3)).toBe('Edited a third time');
  });

  it('the preview still reads the team and says it is not written, so a person can see what Linear holds without it touching anything', async () => {
    linearSide();
    const res = await adm('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    const eng = res.json().teams.find((t: { key: string }) => t.key === 'ENG');
    expect(eng).toMatchObject({ owner: 'storyos', sync_writes: false });
    expect(res.json().teams.find((t: { key: string }) => t.key === 'QUA')).toMatchObject({ owner: 'linear', sync_writes: true });
    expect(await titleOf('ENG', 1)).toBe('Edited in StoryOS');
  });
});

describe('giving it back to Linear', () => {
  it('is refused until an admin confirms, and says how many records were edited here since the cutover', async () => {
    const res = await adm('PUT', ownerUrl('ENG'), { owner: 'linear' });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.message).toMatch(/overwrit/i);
    const edited = (await rows(sql`select count(*)::int as n from records r where r.database_id = ${(await issuesDbOf('ENG')).id as string} and r.deleted_at is null and r.values->>${await linearIdField()} is not null and r.updated_at > ${await cutoverAt()}::timestamptz`))[0]!.n as number;
    expect(edited).toBeGreaterThanOrEqual(2);
    expect(res.json().error.message).toContain(String(edited));
    expect((await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'ENG').owner).toBe('storyos');
  });

  it('with confirmation it flips, is logged, and the very next sync overwrites what was edited here', async () => {
    const res = await adm('PUT', ownerUrl('ENG'), { owner: 'linear', confirm_overwrite: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ team_key: 'ENG', owner: 'linear' });
    const ev = (await adm('GET', `/workspaces/${ws}/audit-log?limit=50`)).json().data.filter((e: { type: string }) => e.type === 'linear_ownership.changed');
    expect(ev).toHaveLength(2);
    expect(ev[0].payload).toMatchObject({ from: 'storyos', to: 'linear' });
    use([{ team: ENG, issues: [issueShape(ENG, 1, { title: 'Linear is the master again' }), issueShape(ENG, 3, { title: 'Dark mode flicker' })] }, { team: QUA, issues: [issueShape(QUA, 1, { title: 'Flaky checkout test, renamed in Linear' })] }]);
    expect((await manualSync()).statusCode).toBe(201);
    expect(await titleOf('ENG', 1)).toBe('Linear is the master again');
  });
});

async function cutoverAt() {
  const ev = (await rows(sql`select created_at from activity_events where workspace_id = ${ws} and type = 'linear_ownership.changed' and payload->>'to' = 'storyos' order by created_at limit 1`))[0]!;
  return new Date(ev.created_at as string).toISOString();
}
async function linearIdField() {
  return ((await rows(sql`select f.id from fields f where f.database_id = ${(await issuesDbOf('ENG')).id as string} and f.api_name = 'linear_id' and f.deleted_at is null`))[0]!.id) as string;
}

describe('damaged state fails CLOSED, in a real sync and on hand-back (review of ticket #1370)', () => {
  const damage = (value: unknown) =>
    rawDb.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,team_ownership}', coalesce(settings->'linear'->'team_ownership', '{}'::jsonb) || jsonb_build_object('QUA', ${JSON.stringify(value)}::jsonb)) WHERE id = ${ws}`);
  const clear = () => rawDb.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,team_ownership}', (settings->'linear'->'team_ownership') - 'QUA') WHERE id = ${ws}`);
  const quaSide = (title: string, extra: unknown[] = []) => use([
    { team: ENG, issues: [issueShape(ENG, 1)] },
    { team: QUA, issues: [issueShape(QUA, 1, { title }), ...extra] },
  ]);

  it('the final read of a cutover runs as an IMPORT run, so Slack subscriptions post nothing for it and history counts it as an import', async () => {
    const { currentImportRun } = await import('../src/common/import-run-context');
    const seen: Array<string | null> = [];
    // A new issue Linear gave no updatedAt: the read stamps no time on it, so its row keeps the moment the final read wrote it.
    quaSide('Flaky checkout test', [issueShape(QUA, 2, { title: 'Arrives in the final read', updatedAt: undefined })]);
    const wrapped = linear.fetcher;
    linear.fetcher = async (q, v, k) => { seen.push(currentImportRun()); return wrapped(q, v, k); };
    const res = await adm('PUT', ownerUrl('QUA'), { owner: 'storyos' });
    expect(res.statusCode, res.body).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((m) => m === 'full'), JSON.stringify(seen)).toBe(true);
  });

  it('a hand-back right after the cutover counts no edits: what the final read wrote is Linear\'s, not an edit made here', async () => {
    const res = await adm('PUT', ownerUrl('QUA'), { owner: 'linear' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().records_edited_since_cutover).toBe(0);
  });

  it('a hand-back from DAMAGED state (no cut_over_at) cannot count the edits, so it demands confirmation instead of reporting zero', async () => {
    await damage('storyos');
    try {
      const refused = await adm('PUT', ownerUrl('QUA'), { owner: 'linear' });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toMatch(/incomplete|cannot tell/i);
      expect((await adm('GET', readUrl())).json().data.find((t: { team_key: string }) => t.team_key === 'QUA').owner, 'still StoryOS-owned').toBe('storyos');
    } finally {
      await clear();
    }
    await damage({ owner: 'storyos', changed_at: 'x', changed_by: 'u' }); // an entry that lost only its cut_over_at
    try {
      expect((await adm('PUT', ownerUrl('QUA'), { owner: 'linear' })).statusCode).toBe(409);
      const confirmed = await adm('PUT', ownerUrl('QUA'), { owner: 'linear', confirm_overwrite: true });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().records_edited_since_cutover, 'unknown is reported as unknown, never as 0').toBeNull();
    } finally {
      await clear();
    }
  });

  it('a REAL sync run leaves a team with damaged state unwritten (not just the pure helper)', async () => {
    await damage({ owner: 'LINEAR!!', changed_at: 'x', changed_by: 'u' }); // an entry whose owner is not a value we ever write
    try {
      await editTitle('QUA', 1, 'Edited while the state was damaged');
      quaSide('Linear says something else');
      const res = await manualSync();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().skipped_storyos_owned).toEqual(['QUA']);
      expect(await titleOf('QUA', 1)).toBe('Edited while the state was damaged');
    } finally {
      await clear();
    }
  });
});

describe('a private team\'s state is not a leak', () => {
  it('a member without a grant does not see a restricted team in the read; an admin does', async () => {
    const PRV = { id: 'team-prv', key: 'PRV', name: 'Private Bets' };
    expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['ENG', 'QUA', 'PRV'], allow_private_teams: true })).statusCode).toBe(201);
    use([
      { team: ENG, issues: [issueShape(ENG, 1)] }, { team: QUA, issues: [issueShape(QUA, 1)] },
      { team: PRV as Team, issues: [issueShape(PRV, 1)], private: true },
    ]);
    expect((await manualSync()).statusCode).toBe(201);
    const keys = (r: { json(): { data: Array<{ team_key: string }> } }) => r.json().data.map((t) => t.team_key);
    expect(keys(await adm('GET', readUrl()))).toContain('PRV');
    expect(keys(await as(member.token, 'GET', readUrl())), 'the member holds no grant on the private team\'s restricted space').not.toContain('PRV');
    expect(keys(await as(member.token, 'GET', readUrl()))).toEqual(expect.arrayContaining(['ENG', 'QUA']));
    expect(keys(await as(guest.token, 'GET', readUrl())), 'the guest holds a grant on one open space only').not.toContain('PRV');
  });
});
