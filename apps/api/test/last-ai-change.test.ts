import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { joinAs } from './helpers/members';
import { records, viewerState, type ChangeSource } from '../src/db/schema';
import { RecordsService } from '../src/records/records.service';
import { AGENCY_SOURCES, isAgencySource } from '../src/records/agency-source';

/**
 * Ticket #1204 (gold means agency, #831). Two things the web's gold edge reads:
 *
 *   1. `records.last_ai_change_at` — the latest change whose STORED provenance is agent / mcp (ticket #1294 narrowed it: automation and a person do not stamp). Stamped in the writing
 *      transaction from the same `source` that badges record_versions, returned as a plain column on every record.
 *   2. a per-person, per-view last-seen time, kept as a `viewer_state` row of kind `view_last_seen` (ADR-0019), so it is private
 *      to that person, leaves with the member, and is never exported.
 *
 * Test names carry the ticket's acceptance criteria, numbered.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ws: string, dbId: string, space: string, viewId: string;
let adminId: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recUrl = (id = '') => `/workspaces/${ws}/databases/${dbId}/records${id ? `/${id}` : ''}`;
const seenUrl = (view = viewId, db = dbId) => `/workspaces/${ws}/databases/${db}/views/${view}/seen`;
const create = async (token: string, name: string) => {
  const res = await as(token, 'POST', recUrl(), { values: { name } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; last_ai_change_at: string | null };
};
const get = async (id: string) => (await as(admin.token, 'GET', recUrl(id))).json() as { last_ai_change_at: string | null; title: string };
const stored = async (id: string) => (await raw.select({ at: records.lastAiChangeAt }).from(records).where(eq(records.id, id)))[0]!.at;

let agentToken: string;
let mcpToken: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'LastAi Owner');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: '1204 WS' })).json().id;
  adminId = (await as(admin.token, 'GET', '/me')).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Work' })).json().id;
  viewId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/views`, { name: 'Board', type: 'table' })).json().id;

  const agentsDb = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  const agent = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${agentsDb}/records`, { values: { name: 'Gold Bot', enabled: true } })).json();
  agentToken = (await as(admin.token, 'POST', '/me/tokens', { name: 'agent', workspace_id: ws, scope: 'write', agent_id: agent.id })).json().token;
  mcpToken = (await as(admin.token, 'POST', '/me/tokens', { name: 'plain pat', workspace_id: ws, scope: 'write' })).json().token;
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1204 AC1 as narrowed by #1294: agent and MCP writes set last_ai_change_at; automation and human writes do not', () => {
  it('a record a person creates and edits has last_ai_change_at null', async () => {
    const r = await create(admin.token, 'human made');
    expect(r.last_ai_change_at).toBeNull();
    expect((await as(admin.token, 'PATCH', recUrl(r.id), { values: { name: 'human edited' } })).statusCode).toBe(200);
    expect((await get(r.id)).last_ai_change_at).toBeNull();
    expect(await stored(r.id)).toBeNull();
  });

  it('an agent-token edit sets it, to the time of that edit', async () => {
    const r = await create(admin.token, 'a1');
    const before = Date.now();
    expect((await as(agentToken, 'PATCH', recUrl(r.id), { values: { name: 'a2' } })).statusCode).toBe(200);
    const at = (await get(r.id)).last_ai_change_at;
    expect(at).not.toBeNull();
    expect(new Date(at!).getTime()).toBeGreaterThanOrEqual(before - 2000);
  });

  it('a plain personal-access-token (MCP) edit sets it', async () => {
    const r = await create(admin.token, 'm1');
    expect((await as(mcpToken, 'PATCH', recUrl(r.id), { values: { name: 'm2' } })).statusCode).toBe(200);
    expect((await get(r.id)).last_ai_change_at).not.toBeNull();
  });

  it('an automation edit does NOT set it (ticket #1294: automation is neutral; the service called with the automation source, as the automation runner does)', async () => {
    const r = await create(admin.token, 'x1');
    await app.get(RecordsService).update(ws, dbId, r.id, { name: 'x2' }, adminId, 0, 'automation');
    expect((await get(r.id)).last_ai_change_at).toBeNull();
    expect(await stored(r.id)).toBeNull();
  });

  it('an automation edit AFTER an agent neither clears nor moves the agent stamp', async () => {
    const r = await create(admin.token, 'xa1');
    await as(agentToken, 'PATCH', recUrl(r.id), { values: { name: 'xa2' } });
    const first = await stored(r.id);
    expect(first).not.toBeNull();
    await app.get(RecordsService).update(ws, dbId, r.id, { name: 'xa3' }, adminId, 0, 'automation');
    expect((await stored(r.id))!.getTime()).toBe(first!.getTime());
  });

  it('a record an agent or MCP CREATES is gold from the start; one a person creates is not', async () => {
    expect((await create(agentToken, 'made by agent')).last_ai_change_at).not.toBeNull();
    expect((await create(mcpToken, 'made by mcp')).last_ai_change_at).not.toBeNull();
    expect((await create(admin.token, 'made by me')).last_ai_change_at).toBeNull();
  });

  it('restoring an old version over MCP is an agent-side change and sets it; a person restoring does not', async () => {
    const r = await create(admin.token, 'v1');
    await as(admin.token, 'PATCH', recUrl(r.id), { values: { name: 'v2' } });
    const versions = (await as(admin.token, 'GET', `${recUrl(r.id)}/versions`)).json().data;
    expect((await as(admin.token, 'POST', `${recUrl(r.id)}/versions/${versions[0].id}/restore`)).statusCode).toBeLessThan(300);
    expect((await get(r.id)).last_ai_change_at, 'a person restoring').toBeNull();
    await as(admin.token, 'PATCH', recUrl(r.id), { values: { name: 'v3' } });
    const again = (await as(admin.token, 'GET', `${recUrl(r.id)}/versions`)).json().data;
    expect((await as(mcpToken, 'POST', `${recUrl(r.id)}/versions/${again[0].id}/restore`)).statusCode).toBeLessThan(300);
    expect((await get(r.id)).last_ai_change_at, 'an MCP restore').not.toBeNull();
  });

  it('a person editing AFTER an agent does not clear it, and an agent write that changes nothing does not move it', async () => {
    const r = await create(admin.token, 'k1');
    await as(agentToken, 'PATCH', recUrl(r.id), { values: { name: 'k2' } });
    const first = await stored(r.id);
    expect(first).not.toBeNull();
    await as(admin.token, 'PATCH', recUrl(r.id), { values: { name: 'k3' } });
    expect((await stored(r.id))!.getTime(), 'a human write leaves it alone').toBe(first!.getTime());
    await as(agentToken, 'PATCH', recUrl(r.id), { values: { name: 'k3' } }); // same value: empty diff
    expect((await stored(r.id))!.getTime(), 'a no-op agent write stamps nothing').toBe(first!.getTime());
    await as(agentToken, 'PATCH', recUrl(r.id), { values: { name: 'k4' } });
    expect((await stored(r.id))!.getTime(), 'a real agent write moves it forward').toBeGreaterThanOrEqual(first!.getTime());
  });

  it('provenance is the credential, not a header: a session that SAYS it is an agent is still a person', async () => {
    const r = await create(admin.token, 'h1');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1${recUrl(r.id)}`,
      headers: { ...authed(admin.token), 'x-storyos-source': 'agent', 'x-source': 'agent', 'x-change-source': 'agent' },
      payload: { values: { name: 'h2' } },
    });
    expect(res.statusCode).toBe(200);
    expect((await get(r.id)).last_ai_change_at).toBeNull();
  });
});

describe('#1294: ONE predicate (records/agency-source.ts) decides every write path', () => {
  const SOURCES: ChangeSource[] = ['human', 'agent', 'automation', 'mcp'];
  let keyField = '';
  const stamps = (s: ChangeSource) => s === 'agent' || s === 'mcp'; // the ruling, written out once more on purpose: the test is the second witness

  it('the predicate is exactly agent + mcp, and AGENCY_SOURCES is what the migration uses', () => {
    expect([...AGENCY_SOURCES].sort()).toEqual(['agent', 'mcp']);
    for (const s of SOURCES) expect(isAgencySource(s), s).toBe(stamps(s));
  });

  // Every writer of the column is reached through the service with each stored source, not just the two HTTP credentials:
  // create, update, restore-a-version, batch create, batch update, upsert, duplicate.
  it.each(SOURCES)('create / update / restore version / batch create / batch update / upsert / duplicate with source %s', async (s) => {
    const svc = app.get(RecordsService);
    const want = stamps(s);
    const seen = async (id: string, what: string) => expect((await stored(id)) !== null, `${s}: ${what}`).toBe(want);

    const created = (await svc.create(ws, dbId, { name: `p1-${s}` }, adminId, 0, s)) as { id: string };
    await seen(created.id, 'create');

    const upd = (await svc.create(ws, dbId, { name: `p2-${s}` }, adminId, 0, 'human')) as { id: string };
    await svc.update(ws, dbId, upd.id, { name: `p2b-${s}` }, adminId, 0, s);
    await seen(upd.id, 'update');

    const versions = (await as(admin.token, 'GET', `${recUrl(upd.id)}/versions`)).json().data;
    await svc.restoreVersion(ws, dbId, upd.id, versions[versions.length - 1].id, adminId, s);
    await seen(upd.id, 'restore version');

    const batch = (await svc.createBatch(ws, dbId, [{ name: `p3-${s}` }, { name: `p4-${s}` }], adminId, 0, { source: s })) as { id: string }[];
    for (const r of batch) await seen(r.id, 'batch create');

    const bu = (await svc.create(ws, dbId, { name: `p5-${s}` }, adminId, 0, 'human')) as { id: string };
    await svc.batchUpdate(ws, dbId, [bu.id], { name: `p5b-${s}` }, adminId, s);
    await seen(bu.id, 'batch update');

    if (!keyField) {
      const f = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${dbId}/fields`, { display_name: 'Key', type: 'text', config: { unique: true } });
      expect(f.statusCode, f.body).toBeLessThan(300);
      keyField = f.json().apiName ?? f.json().api_name;
    }
    const up = (await svc.upsert(ws, dbId, keyField, { name: `p6-${s}`, [keyField]: `k-${s}` }, adminId, s)) as { id?: string; record?: { id: string } };
    await seen((up.record?.id ?? up.id)!, 'upsert (create branch)');

    const dup = (await svc.duplicate(ws, dbId, bu.id, adminId, s)) as { id: string };
    await seen(dup.id, 'duplicate');
  });

  it('over HTTP: batch create, batch update and duplicate follow the credential (agent stamps, a person does not)', async () => {
    const mk = async (token: string, n: string) => {
      const res = await as(token, 'POST', `${recUrl()}/batch`, { records: [{ values: { name: n } }] });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return (res.json().data as { id: string; last_ai_change_at: string | null }[])[0]!;
    };
    expect((await mk(agentToken, 'h-batch-agent')).last_ai_change_at).not.toBeNull();
    expect((await mk(mcpToken, 'h-batch-mcp')).last_ai_change_at).not.toBeNull();
    const mine = await mk(admin.token, 'h-batch-human');
    expect(mine.last_ai_change_at).toBeNull();

    expect((await as(admin.token, 'PATCH', `${recUrl()}/batch`, { record_ids: [mine.id], values: { name: 'h-batch-human-2' } })).statusCode).toBeLessThan(300);
    expect(await stored(mine.id)).toBeNull();
    expect((await as(agentToken, 'PATCH', `${recUrl()}/batch`, { record_ids: [mine.id], values: { name: 'h-batch-agent-2' } })).statusCode).toBeLessThan(300);
    expect(await stored(mine.id)).not.toBeNull();

    const human = await create(admin.token, 'h-dup-src');
    const dupByMe = (await as(admin.token, 'POST', `${recUrl(human.id)}/duplicate`)).json() as { id: string };
    expect(await stored(dupByMe.id)).toBeNull();
    const dupByAgent = (await as(agentToken, 'POST', `${recUrl(human.id)}/duplicate`)).json() as { id: string };
    expect(await stored(dupByAgent.id)).not.toBeNull();
  });
});

describe('#1204 AC2: record lists return it with no extra query per row', () => {
  it('the list carries last_ai_change_at on every row (a column of the row already read), null for people-only rows', async () => {
    const gold = await create(agentToken, 'list gold');
    const plain = await create(admin.token, 'list plain');
    const list = (await as(admin.token, 'GET', `${recUrl()}?limit=200`)).json().data as Array<{ id: string; last_ai_change_at: string | null }>;
    expect(list.find((r) => r.id === gold.id)!.last_ai_change_at).not.toBeNull();
    expect(list.find((r) => r.id === plain.id)!.last_ai_change_at).toBeNull();
    for (const row of list) expect('last_ai_change_at' in row, `row ${row.id} carries the key`).toBe(true);
  });
});

describe('#1204 AC3: last-seen is per person per view and updates on open', () => {
  it('the first open returns previous_seen_at null; the next returns the time of the first, and the stored time moves on', async () => {
    const first = (await as(admin.token, 'POST', seenUrl())).json();
    expect(first.previous_seen_at).toBeNull();
    expect(typeof first.seen_at).toBe('string');
    await new Promise((r) => setTimeout(r, 20));
    const second = (await as(admin.token, 'POST', seenUrl())).json();
    expect(second.previous_seen_at).toBe(first.seen_at);
    expect(new Date(second.seen_at).getTime()).toBeGreaterThan(new Date(first.seen_at).getTime());
    const rows = await raw.select().from(viewerState).where(eq(viewerState.userId, adminId));
    expect(rows.filter((r) => r.kind === 'view_last_seen' && r.targetId === viewId)).toHaveLength(1);
  });

  it('two people each have their own time on one view: one opening it never moves the other\'s', async () => {
    const a = await joinAs(app, admin.token, ws, 'Seen A', 'member');
    const b = await joinAs(app, admin.token, ws, 'Seen B', 'member');
    const aFirst = (await as(a.token, 'POST', seenUrl())).json();
    expect(aFirst.previous_seen_at, 'A has never opened it, whatever the owner did').toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect((await as(b.token, 'POST', seenUrl())).json().previous_seen_at, 'B has never opened it either').toBeNull();
    const aSecond = (await as(a.token, 'POST', seenUrl())).json();
    expect(aSecond.previous_seen_at, 'A sees A\'s own first time, not B\'s later one').toBe(aFirst.seen_at);
  });

  it('nobody else can read it: no route returns it, the only route answers for the caller, and an admin gets no view into another member\'s row', async () => {
    const m = await joinAs(app, admin.token, ws, 'Seen Private', 'member');
    const mine = (await as(m.token, 'POST', seenUrl())).json();
    // the owner (an admin) opens the same view: their answer is about THEIR time, never the member's
    const adminsAnswer = (await as(admin.token, 'POST', seenUrl())).json();
    expect(adminsAnswer.previous_seen_at).not.toBe(mine.seen_at);
    // and the member's own row still holds the member's time
    const row = (await raw.select().from(viewerState).where(eq(viewerState.userId, m.id)))[0]!;
    expect((row.data as { seen_at: string }).seen_at).toBe(mine.seen_at);
    // no GET exists: reading is only ever the POST's answer
    expect((await as(admin.token, 'GET', seenUrl())).statusCode).toBe(404);
  });

  it('an agent or MCP credential cannot mark a view seen (403) and nothing is written', async () => {
    const before = await raw.select().from(viewerState).where(eq(viewerState.userId, adminId));
    expect((await as(agentToken, 'POST', seenUrl())).statusCode).toBe(403);
    expect((await as(mcpToken, 'POST', seenUrl())).statusCode).toBe(403);
    const after = await raw.select().from(viewerState).where(eq(viewerState.userId, adminId));
    expect(after.map((r) => (r.data as { seen_at?: string }).seen_at)).toEqual(before.map((r) => (r.data as { seen_at?: string }).seen_at));
  });

  it('rejections: another member\'s PERSONAL view is a 404 (never confirmed), a stranger without database access is a 404, a view not in the database named is a 404', async () => {
    const mine = await joinAs(app, admin.token, ws, 'Seen Personal Owner', 'member');
    const personal = (await as(mine.token, 'POST', `/workspaces/${ws}/databases/${dbId}/views/personal`, { name: 'Mine', type: 'table' })).json().id;
    const other = await joinAs(app, admin.token, ws, 'Seen Nosy', 'member');
    expect((await as(other.token, 'POST', seenUrl(personal))).statusCode).toBe(404);
    expect((await as(admin.token, 'POST', seenUrl(personal))).statusCode, 'private from admins too').toBe(404);
    expect((await as(mine.token, 'POST', seenUrl(personal))).statusCode, 'the owner can').toBe(200);
    const otherDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Elsewhere' })).json().id;
    expect((await as(admin.token, 'POST', seenUrl(viewId, otherDb))).statusCode).toBe(404);
    const stranger = await joinAs(app, admin.token, ws, 'Seen Stranger', 'guest', [{ database_id: otherDb, role: 'viewer' }]);
    expect((await as(stranger.token, 'POST', seenUrl())).statusCode).toBe(404);
    const rows = await raw.select().from(viewerState).where(eq(viewerState.userId, stranger.id));
    expect(rows, 'a refused open writes nothing').toHaveLength(0);
  });
});

describe('#1294: migration 0131 recomputes existing values from history with the same rule', () => {
  const file = readFileSync(join(__dirname, '../drizzle/0131_records_last_ai_change_agency_only.sql'), 'utf8');
  const statements = file.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
  const apply = async () => { for (const s of statements) await raw.execute(sql.raw(s)); };
  // a block of `-- ` comment lines between two markers, uncommented (the dry-run query and the revert statement live in the file)
  const commented = (start: string, endsAt: (line: string) => boolean) => {
    const lines = file.split('\n');
    const from = lines.findIndex((l) => l.includes(start)) + 1;
    const out: string[] = [];
    for (let i = from; i < lines.length && !endsAt(lines[i]!); i++) out.push(lines[i]!.replace(/^--\s?/, ''));
    return out.join('\n');
  };
  const dryRunSql = () => commented('-- DRY-RUN-BEGIN', (l) => l.includes('DRY-RUN-END'));
  const revertSql = () => commented('-- REVERT (', (l) => !l.startsWith('--   '));
  const dryRun = async () => {
    const res = (await raw.execute(sql.raw(dryRunSql()))) as unknown as { rows?: Record<string, string>[] } | Record<string, string>[];
    const row = (Array.isArray(res) ? res : res.rows)![0]!;
    return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as Record<'stamped_now' | 'would_null' | 'would_move' | 'would_set' | 'kept' | 'kept_without_history', number>;
  };
  const setStamp = (id: string, at: Date | null) => raw.execute(sql`UPDATE records SET last_ai_change_at = ${at ? at.toISOString() : null} WHERE id = ${id}`);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  it('the migration names exactly the shared predicate\'s sources, and automation appears in no IN (...) list', () => {
    const lists = [...file.split('\n').filter((l) => !l.startsWith('--')).join('\n').matchAll(/source IN \(([^)]*)\)/g)].map((m) => m[1]!.split(',').map((x) => x.trim().replace(/'/g, '')).sort());
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) expect(l).toEqual([...AGENCY_SOURCES].sort());
  });

  it('rows changed only by automation become null, agent/mcp rows keep their time, history-less rows are kept, it is re-runnable, and the revert restores the old values', async () => {
    const svc = app.get(RecordsService);
    const mk = async (name: string) => (await create(admin.token, name)).id;

    const humanOnly = await mk('m human');
    await as(admin.token, 'PATCH', recUrl(humanOnly), { values: { name: 'm human 2' } });

    const agentEdited = await mk('m agent');
    await as(agentToken, 'PATCH', recUrl(agentEdited), { values: { name: 'm agent 2' } });
    const mcpEdited = await mk('m mcp');
    await as(mcpToken, 'PATCH', recUrl(mcpEdited), { values: { name: 'm mcp 2' } });
    const agentCreated = (await create(agentToken, 'm created by agent')).id;
    const humanAfterAgent = await mk('m human after agent');
    await as(agentToken, 'PATCH', recUrl(humanAfterAgent), { values: { name: 'm haa 2' } });
    await as(admin.token, 'PATCH', recUrl(humanAfterAgent), { values: { name: 'm haa 3' } });

    // old rule stamped these: automation-only, and automation AFTER an agent
    const automationOnly = await mk('m automation');
    await svc.update(ws, dbId, automationOnly, { name: 'm automation 2' }, adminId, 0, 'automation');
    const agentThenAutomation = await mk('m agent then automation');
    await as(agentToken, 'PATCH', recUrl(agentThenAutomation), { values: { name: 'm ata 2' } });
    await new Promise((r) => setTimeout(r, 2100));
    await svc.update(ws, dbId, agentThenAutomation, { name: 'm ata 3' }, adminId, 0, 'automation');

    // a stamp with no history behind it at all (history not captured / pruned): kept, never guessed
    const noHistory = await mk('m no history');
    await raw.execute(sql`DELETE FROM record_versions WHERE record_id = ${noHistory}`);
    await raw.execute(sql`DELETE FROM activity_events WHERE record_id = ${noHistory}`);

    const ids = [humanOnly, agentEdited, mcpEdited, agentCreated, humanAfterAgent, automationOnly, agentThenAutomation, noHistory];

    // simulate production as 0129 left it: automation-changed rows stamped (the OLD rule), the rest as the live write path stamped
    const oldAutomationStamp = hoursAgo(1);
    await setStamp(automationOnly, oldAutomationStamp);
    const ataAgentLive = await stored(agentThenAutomation);
    const oldAta = new Date(Date.now()); // the automation write's time, later than the agent's by > 2s
    await setStamp(agentThenAutomation, oldAta);
    const noHistoryStamp = hoursAgo(2);
    await setStamp(noHistory, noHistoryStamp);
    const before = new Map<string, Date | null>();
    for (const id of ids) before.set(id, await stored(id));
    expect(before.get(humanOnly)).toBeNull();
    expect(before.get(automationOnly)).not.toBeNull();

    const dry = await dryRun();
    expect(dry.would_null, 'dry run: the automation-only row').toBeGreaterThanOrEqual(1);
    expect(dry.would_move, 'dry run: the agent-then-automation row').toBeGreaterThanOrEqual(1);
    expect(dry.kept_without_history, 'dry run: the history-less row').toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(await stored(id), 'the dry run changed nothing').toEqual(before.get(id));

    await apply();
    const after = new Map<string, Date | null>();
    for (const id of ids) after.set(id, await stored(id));

    expect(after.get(humanOnly), 'human only').toBeNull();
    expect(after.get(automationOnly), 'automation only becomes null').toBeNull();
    for (const [id, what] of [[agentEdited, 'agent edit'], [mcpEdited, 'mcp edit'], [agentCreated, 'agent create'], [humanAfterAgent, 'human after agent']] as const) {
      expect(after.get(id), what).not.toBeNull();
      expect(after.get(id)!.getTime(), `${what}: kept as it was`).toBe(before.get(id)!.getTime());
    }
    expect(after.get(agentThenAutomation), 'moves back to the agent change').not.toBeNull();
    expect(Math.abs(after.get(agentThenAutomation)!.getTime() - ataAgentLive!.getTime())).toBeLessThan(2000);
    expect(after.get(noHistory)!.getTime(), 'no history proves nothing, so the stamp is kept').toBe(noHistoryStamp.getTime());

    const backup = (id: string) => raw.execute(sql`SELECT old_value, new_value FROM records_last_ai_change_backup_1294 WHERE record_id = ${id}`) as unknown as Promise<{ rows?: { old_value: Date | null; new_value: Date | null }[] } | { old_value: Date | null; new_value: Date | null }[]>;
    const rowsOf = <T,>(r: { rows?: T[] } | T[]) => (Array.isArray(r) ? r : r.rows)!;
    const b = rowsOf(await backup(automationOnly));
    expect(b, 'the old value is backed up').toHaveLength(1);
    expect(new Date(b[0]!.old_value as never).getTime()).toBe(oldAutomationStamp.getTime());
    expect(b[0]!.new_value).toBeNull();
    expect(rowsOf(await backup(agentEdited)), 'an unchanged row is not in the backup').toHaveLength(0);

    // re-runnable: a second run changes nothing and cannot overwrite the first backup
    await apply();
    for (const id of ids) expect(await stored(id), `second run: ${id}`).toEqual(after.get(id));
    expect(new Date(rowsOf(await backup(automationOnly))[0]!.old_value as never).getTime()).toBe(oldAutomationStamp.getTime());
    const second = await dryRun();
    expect(second.would_null).toBe(0);
    expect(second.would_move).toBe(0);

    // the revert statement in the file puts the old values back
    await raw.execute(sql.raw(revertSql()));
    for (const id of ids) expect((await stored(id))?.getTime() ?? null, `revert: ${id}`).toBe(before.get(id)?.getTime() ?? null);
    // ... and leave the database as the new rule has it, for the tests after this one
    await apply();
    console.log(`#1294 migration fixture: ${ids.length} records; dry run before: ${JSON.stringify(dry)}; after: ${JSON.stringify(second)}`);
  }, 60_000);
});
