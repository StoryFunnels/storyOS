import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * ticket #1334 — when a write names a person who is not found, the 422 lists the candidates ("Name <email>") so the caller's
 * next attempt can fix itself (MN-118). That list is for a full member: a guest, or any credential bound to specific spaces or
 * databases (the access layer runs those as a guest), gets "not found" with no candidates. An anonymous caller already gets
 * none (#1069). Writing a known person by id, email or name works for every caller exactly as before.
 *
 * Every narrowed refusal is asserted on the whole response BODY: no other member's name or email in it.
 */
let app: NestFastifyApplication;
let ws: string;
let general = '';
let ledger = '';
let admin: { token: string; email: string };
let mate: Person;
let guest: Person;
let matePat = '';
let mateSpacePat = '';
let agentToken = '';
let spaceAgentToken = '';
let recordId = '';
const { pool } = connectTestDb();
const ADMIN_NAME = 'Candidate Admin';
const MATE_NAME = 'Candidate Mate';
const GUEST_NAME = 'Candidate Guest';

const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const records = () => `/workspaces/${ws}/databases/${ledger}/records`;

async function mintPat(token: string, resourceScope?: unknown): Promise<string> {
  const res = await as(token, 'POST', '/me/tokens', {
    name: 'pat',
    workspace_id: ws,
    scope: 'write',
    ...(resourceScope ? { resource_scope: resourceScope } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

/** Every write path that resolves a person, each with an unknown one. */
async function unknownPersonWrites(token: string) {
  const bad = 'nobody-at-all';
  return [
    ['create', await as(token, 'POST', records(), { values: { name: 'x', owner: bad } })],
    ['update', await as(token, 'PATCH', `${records()}/${recordId}`, { values: { owner: bad } })],
    ['batch create', await as(token, 'POST', `${records()}/batch`, { records: [{ values: { name: 'y', owner: bad } }] })],
    ['upsert', await as(token, 'POST', `${records()}/upsert`, { key_field: 'code', values: { name: 'z', code: 'z-1', owner: bad } })],
    ['bulk job', await as(token, 'POST', `${records()}/batch-jobs`, { op: 'update', record_ids: [recordId], values: { owner: bad } })],
  ] as const;
}

const everyone = () => [ADMIN_NAME, MATE_NAME, GUEST_NAME, admin.email, mate.email, guest.email];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, ADMIN_NAME);
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Candidates WS' })).json().id;
  general = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  ledger = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Ledger' })).json().id as string;
  const field = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ledger}/fields`, { display_name: 'Owner', type: 'user' });
  expect(field.statusCode, field.body).toBe(201);
  const key = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ledger}/fields`, { display_name: 'Code', type: 'text', config: { unique: true } });
  expect(key.statusCode, key.body).toBe(201);
  recordId = (await as(admin.token, 'POST', records(), { values: { name: 'Existing' } })).json().id as string;

  mate = await joinAs(app, admin.token, ws, MATE_NAME, 'member');
  guest = await joinAs(app, admin.token, ws, GUEST_NAME, 'guest', [{ space_id: general, role: 'editor' }]);
  matePat = await mintPat(mate.token);
  mateSpacePat = await mintPat(mate.token, { space_ids: [general] });

  // A database-scoped agent owned by the member, and a token minted for it.
  const agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id as string;
  const opt = async (dbId: string, apiName: string) =>
    Object.fromEntries(
      (
        await pool.query(
          'select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2',
          [dbId, apiName],
        )
      ).rows.map((r: { label: string; id: string }) => [r.label, r.id]),
    );
  const aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI'];
  const scopeIds = await opt(agentsDbId, 'scopes');
  const mkAgent = async (name: string, extra: Record<string, unknown>) => {
    const res = await as(mate.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
      values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const mintForAgent = async (agentId: string, resourceScope?: unknown) => {
    const res = await as(admin.token, 'POST', '/me/tokens', {
      name: 'agent',
      workspace_id: ws,
      scope: 'write',
      agent_id: agentId,
      ...(resourceScope ? { resource_scope: resourceScope } : {}),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().token as string;
  };
  // An agent credential bound to the one database, and an agent whose space target binds its credential live (#1195).
  agentToken = await mintForAgent(await mkAgent('Ledger clerk', { target_databases: ledger }), { database_ids: [ledger] });
  spaceAgentToken = await mintForAgent(await mkAgent('General clerk', { target_spaces: 'General' }));
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('#1334 a narrowed caller writing an unknown person gets "not found" without the candidate list', () => {
  for (const [label, token] of [
    ['guest editor', () => guest.token],
    ['database-scoped agent token', () => agentToken],
    ['space-scoped agent token', () => spaceAgentToken],
    ['space-bound PAT of a member', () => mateSpacePat],
  ] as const) {
    it(`${label}: 422 on every write path, and no member's name or email in the body`, async () => {
      for (const [path, res] of await unknownPersonWrites(token())) {
        expect(res.statusCode, `${label} ${path}: ${res.body}`).toBe(422);
        expect(res.body, `${label} ${path}`).toContain('nobody-at-all');
        for (const leak of everyone()) expect(res.body, `${label} ${path} carried ${leak}`).not.toContain(leak);
      }
    });
  }

  it('an ambiguous name to a narrowed caller names no one either', async () => {
    const twinA = await joinAs(app, admin.token, ws, 'Twin Name', 'member');
    const twinB = await joinAs(app, admin.token, ws, 'Twin Name', 'member');
    for (const token of [guest.token, agentToken]) {
      const res = await as(token, 'POST', records(), { values: { name: 'twin', owner: 'Twin Name' } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/matches 2 people/);
      for (const leak of [...everyone(), twinA.email, twinB.email]) expect(res.body).not.toContain(leak);
    }
  });
});

describe('#1334 a full member keeps the candidate list', () => {
  for (const [label, token] of [
    ['admin session', () => admin.token],
    ['member session', () => mate.token],
    ['unbound PAT of a member', () => matePat],
  ] as const) {
    it(`${label}: the 422 names the candidates on every write path`, async () => {
      for (const [path, res] of await unknownPersonWrites(token())) {
        expect(res.statusCode, `${label} ${path}: ${res.body}`).toBe(422);
        for (const who of [`${ADMIN_NAME} <${admin.email}>`, `${MATE_NAME} <${mate.email}>`]) {
          expect(res.body, `${label} ${path}`).toContain(who);
        }
      }
    });
  }
});

describe('#1334 a known person still resolves for every caller', () => {
  for (const [label, token] of [
    ['admin session', () => admin.token],
    ['member session', () => mate.token],
    ['unbound PAT of a member', () => matePat],
    ['guest editor', () => guest.token],
    ['database-scoped agent token', () => agentToken],
    ['space-scoped agent token', () => spaceAgentToken],
    ['space-bound PAT of a member', () => mateSpacePat],
  ] as const) {
    it(`${label}: by id, email and name`, async () => {
      for (const value of [mate.id, mate.email, MATE_NAME]) {
        const created = await as(token(), 'POST', records(), { values: { name: `${label} ${value}`, owner: value } });
        expect(created.statusCode, `${label} create ${value}: ${created.body}`).toBe(201);
        expect(created.json().values.owner).toBe(mate.id);
        const updated = await as(token(), 'PATCH', `${records()}/${recordId}`, { values: { owner: value } });
        expect(updated.statusCode, `${label} update ${value}: ${updated.body}`).toBe(200);
        expect(updated.json().values.owner).toBe(mate.id);
      }
    });
  }
});
