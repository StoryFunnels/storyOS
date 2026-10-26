import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { MembersDbService } from '../src/members/members-db.service';
import { AgentsService } from '../src/agents/agents.service';
import { DB } from '../src/db/db.module';

/**
 * #1063 — a system database is identified by `is_system` + a fixed `system_key`, never by its display name, so it can be
 * renamed/relabelled safely and a person's own database called "Runs" is never mistaken for one.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string, spaceId: string;
const client = () => (app.get(DB) as unknown as { $client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client;
const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const keyOf = async (id: string) => (await client().query('select system_key, is_system from databases where id = $1', [id])).rows[0]!;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'sysKey Admin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Sys Key WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1063 keys on provisioned system databases', () => {
  it('the agent pack and the Members projection carry their fixed keys', async () => {
    const pack = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
    const members = await app.get(MembersDbService).ensureMembersDb(ws);
    expect(await keyOf(pack.agentsDb.id)).toMatchObject({ system_key: 'agents', is_system: true });
    expect(await keyOf(pack.runsDb.id)).toMatchObject({ system_key: 'agent_runs', is_system: true });
    expect(await keyOf(pack.triggersDb.id)).toMatchObject({ system_key: 'agent_triggers', is_system: true });
    expect(await keyOf(members.id)).toMatchObject({ system_key: 'members', is_system: true });
  });

  it('renaming a system database changes nothing about how it is found: no duplicate pack, runs still resolve', async () => {
    const before = await app.get(AgentsService).findPackDbs(ws);
    await client().query(`update databases set name = 'Agent runs' where id = $1`, [before.runsDb!.id]);
    await client().query(`update databases set name = 'Triggers' where id = $1`, [before.triggersDb!.id]);
    const after = await app.get(AgentsService).findPackDbs(ws);
    expect(after.runsDb?.id).toBe(before.runsDb!.id);
    expect(after.triggersDb?.id).toBe(before.triggersDb!.id);
    const again = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
    expect(again.runsDb.id, 'ensure did not provision a second Runs').toBe(before.runsDb!.id);
    const count = (await client().query(`select count(*)::int n from databases where workspace_id = $1 and system_key = 'agent_runs'`, [ws])).rows[0]!.n;
    expect(count).toBe(1);
    // and the runtime-owned-field rule (#1062) still recognises the renamed Runs
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${before.runsDb!.id}/records`, { values: { name: 'x', cost: 5 } });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('a user database called "Agents" / "Runs" / "Agent Triggers" / "Members" is NOT a system database, and the pack ignores it', async () => {
    const fresh = (await as(admin.token, 'POST', '/workspaces', { name: 'Sys Key Lookalikes' })).json().id as string;
    const sp = (await as(admin.token, 'GET', `/workspaces/${fresh}/spaces`)).json()[0].id as string;
    const mine: Record<string, string> = {};
    for (const name of ['Agents', 'Runs', 'Agent Triggers', 'Members']) {
      mine[name] = (await as(admin.token, 'POST', `/workspaces/${fresh}/databases`, { space_id: sp, name })).json().id;
      expect(await keyOf(mine[name]!)).toMatchObject({ system_key: null, is_system: false });
    }
    const pack = (await as(admin.token, 'POST', `/workspaces/${fresh}/agents/ensure`)).json();
    for (const id of [pack.agentsDb.id, pack.runsDb.id, pack.triggersDb.id]) expect(Object.values(mine)).not.toContain(id);
    const members = await app.get(MembersDbService).ensureMembersDb(fresh);
    expect(Object.values(mine)).not.toContain(members.id);
    // the user's Runs accepts the very values a system Runs refuses
    expect((await as(admin.token, 'POST', `/workspaces/${fresh}/databases/${mine['Runs']}/records`, { values: { name: 'plain' } })).statusCode).toBe(201);
  });

  it('cannot be forged over HTTP', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Sneaky', is_system: true, system_key: 'agent_runs' });
    expect(res.statusCode).toBeLessThan(300);
    expect(await keyOf(res.json().id)).toMatchObject({ system_key: null, is_system: false });
  });
});

describe('#1063 the database refuses an invalid key', () => {
  it('a key on a non-system database, an unknown key, and a second database with the same key in one workspace are all rejected', async () => {
    const user = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Plain' })).json().id as string;
    await expect(client().query(`update databases set system_key = 'agents' where id = $1`, [user])).rejects.toThrow(/databases_system_key_valid/);
    await expect(client().query(`update databases set is_system = true, system_key = 'nonsense' where id = $1`, [user])).rejects.toThrow(/databases_system_key_valid/);
    await expect(client().query(`update databases set is_system = true, system_key = 'agent_runs' where id = $1`, [user])).rejects.toThrow(/databases_workspace_system_key_uq/);
  });
});

describe('#1063 the backfill migration', () => {
  const sqlText = readFileSync(join(__dirname, '../drizzle/0119_system_database_key.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .find((c) => c.includes('WITH ranked'))!;

  it('keys every flagged system database by its name, oldest wins on a duplicate, and leaves user databases and odd names alone', async () => {
    const w = (await as(admin.token, 'POST', '/workspaces', { name: 'Backfill WS' })).json().id as string;
    const sp = (await as(admin.token, 'GET', `/workspaces/${w}/spaces`)).json()[0].id as string;
    const mk = async (name: string) => (await as(admin.token, 'POST', `/workspaces/${w}/databases`, { space_id: sp, name })).json().id as string;
    const old = await mk('Runs'), dup = await mk('Runs'), agents = await mk('Agents'), trig = await mk('Agent Triggers'), mem = await mk('Members');
    const userRuns = await mk('Runs'), odd = await mk('Something else');
    // simulate the pre-#1063 state: flagged by name, no key (oldest first)
    await client().query(`update databases set created_at = now() - interval '3 days' where id = $1`, [old]);
    await client().query(`update databases set created_at = now() - interval '1 day' where id = $1`, [dup]);
    await client().query(`update databases set is_system = true, system_key = null where id = any($1)`, [[old, dup, agents, trig, mem, odd]]);
    await client().query(sqlText);
    expect(await keyOf(old)).toMatchObject({ system_key: 'agent_runs' });
    expect((await keyOf(dup)).system_key, 'the newer duplicate stays keyless rather than violating the unique index').toBeNull();
    expect(await keyOf(agents)).toMatchObject({ system_key: 'agents' });
    expect(await keyOf(trig)).toMatchObject({ system_key: 'agent_triggers' });
    // the workspace already has its real Members projection, keyed and older: it keeps the key, the lookalike stays keyless
    expect((await keyOf(mem)).system_key).toBeNull();
    expect((await client().query(`select count(*)::int n from databases where workspace_id = $1 and system_key = 'members'`, [w])).rows[0]!.n).toBe(1);
    expect(await keyOf(userRuns), "a user's own database named Runs gets no key").toMatchObject({ system_key: null, is_system: false });
    expect((await keyOf(odd)).system_key, 'a flagged row with an unknown name is left keyless, not guessed').toBeNull();
  });
});

describe('#1063 no lookup by name is left', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []));
  it('nothing in src resolves a system database by its display name', () => {
    const offenders = walk(join(__dirname, '../src'))
      .filter((f) => !f.endsWith('db/schema.ts'))
      .flatMap((f) =>
        readFileSync(f, 'utf8').split('\n').map((line, i) => ({ f, i: i + 1, line })).filter(({ line }) =>
          /\.name === '(Agents|Runs|Agent Triggers|Members)'/.test(line) ||
          /eq\(\s*databases(Table)?\.name\s*,/.test(line) ||
          /JOIN databases d ON .*\bd\.name\b/i.test(line),
        ),
      )
      .map(({ f, i, line }) => `${f.split('/src/')[1]}:${i}: ${line.trim()}`);
    expect(offenders, 'resolve a system database by is_system + system_key (ticket #1063)').toEqual([]);
  });
});
