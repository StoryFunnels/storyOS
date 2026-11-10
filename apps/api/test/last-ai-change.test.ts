import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { joinAs } from './helpers/members';
import { records, viewerState } from '../src/db/schema';
import { RecordsService } from '../src/records/records.service';

/**
 * Ticket #1204 (gold means agency, #831). Two things the web's gold edge reads:
 *
 *   1. `records.last_ai_change_at` — the latest change whose STORED provenance is agent / automation / mcp. Stamped in the writing
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

describe('#1204 AC1: agent, automation and MCP writes set last_ai_change_at; human writes do not', () => {
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

  it('an automation edit sets it (the service called with the automation source, as the automation runner does)', async () => {
    const r = await create(admin.token, 'x1');
    await app.get(RecordsService).update(ws, dbId, r.id, { name: 'x2' }, adminId, 0, 'automation');
    expect((await get(r.id)).last_ai_change_at).not.toBeNull();
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

describe('#1204 AC4: the backfill gives the right values (run against records whose history is already there)', () => {
  it('sets exactly the records with a non-human change in history, to the time of the latest one, and leaves the rest null', async () => {
    const humanOnly = await create(admin.token, 'bf human');
    await as(admin.token, 'PATCH', recUrl(humanOnly.id), { values: { name: 'bf human 2' } });
    const aiEdited = await create(admin.token, 'bf ai');
    await as(agentToken, 'PATCH', recUrl(aiEdited.id), { values: { name: 'bf ai 2' } });
    await as(mcpToken, 'PATCH', recUrl(aiEdited.id), { values: { name: 'bf ai 3' } });
    const aiCreated = await create(agentToken, 'bf created by agent');

    // Undo the live stamp, so what the statement computes is compared with what the write path stamped.
    const expected = new Map<string, number | null>();
    for (const r of await raw.select({ id: records.id, at: records.lastAiChangeAt }).from(records).where(eq(records.databaseId, dbId))) expected.set(r.id, r.at ? r.at.getTime() : null);
    await raw.execute(sql`UPDATE records SET last_ai_change_at = NULL WHERE database_id = ${dbId}`);

    const migration = readFileSync(join(__dirname, '../drizzle/0129_records_last_ai_change_at.sql'), 'utf8');
    const backfill = migration.split('--> statement-breakpoint')[1]!;
    await raw.execute(sql.raw(backfill));

    const after = new Map<string, number | null>();
    for (const r of await raw.select({ id: records.id, at: records.lastAiChangeAt }).from(records).where(eq(records.databaseId, dbId))) after.set(r.id, r.at ? r.at.getTime() : null);
    expect(after.get(humanOnly.id)).toBeNull();
    expect(after.get(aiEdited.id)).not.toBeNull();
    expect(after.get(aiCreated.id)).not.toBeNull();
    // same records are gold before and after; the backfilled time is the history's own timestamp, within a second of the live one
    let gold = 0;
    for (const [id, live] of expected) {
      expect(after.get(id) === null, `record ${id} (${(await raw.select({ t: records.title }).from(records).where(eq(records.id, id)))[0]?.t}) gold-ness`).toBe(live === null);
      if (live !== null) { gold++; expect(Math.abs(after.get(id)! - live)).toBeLessThan(2000); }
    }
    expect(gold).toBeGreaterThanOrEqual(2);
    console.log(`#1204 backfill: ${expected.size} records, ${gold} gold after backfill (matches the live stamp), ${expected.size - gold} null`);
  });
});
