import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * ticket #1334 (second half) — the paths that COPY a person onto a record rather than take one from the request body: duplicate,
 * copy to another database, CSV import, and a board drop that carries values. When the person copied is no longer a member (a
 * removed member's id still sits in the source record's user field) the write fails to resolve it, and the 422 used to list
 * every active member — to a guest or a credential bound to specific spaces or databases, through any of these paths that did
 * not hand the caller's membership down. The full-member case (admin, member, unbound token) keeps its candidates.
 *
 * Every narrowed refusal is asserted on the whole response BODY: no member's name or email in it.
 */
let app: NestFastifyApplication;
let ws: string;
let general = '';
let ledger = '';
let target = '';
let admin: { token: string; email: string };
let mate: Person;
let guest: Person;
let gone: Person;
let matePat = '';
let mateSpacePat = '';
let agentToken = '';
let spaceAgentToken = '';
let orphanId = '';
const { pool } = connectTestDb();
const ADMIN_NAME = 'Copy Admin';
const MATE_NAME = 'Copy Mate';
const GUEST_NAME = 'Copy Guest';
const GONE_NAME = 'Copy Departed';

const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const records = (db = ledger) => `/workspaces/${ws}/databases/${db}/records`;
const everyone = () => [ADMIN_NAME, MATE_NAME, GUEST_NAME, admin.email, mate.email, guest.email];

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

function multipart(fields: Record<string, string>, csv: string) {
  const boundary = 'X-CANDIDATES-BOUNDARY';
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
  return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Each path that carries the departed person's id onto a write. */
async function copyingWrites(token: string) {
  const importBody = multipart(
    {
      dry_run: 'false',
      mapping: JSON.stringify([
        { column: 'Name', to: { kind: 'title' } },
        { column: 'Owner', to: { kind: 'existing', field_id: await ownerFieldId(ledger) } },
      ]),
    },
    `Name;Owner\nImported;${gone.id}`,
  );
  return [
    ['duplicate', await as(token, 'POST', `${records()}/${orphanId}/duplicate`)],
    [
      'copy to another database',
      await as(token, 'POST', `${records()}/copy`, { record_ids: [orphanId], target_database_id: target, dry_run: false }),
    ],
    [
      'csv import',
      await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${ws}/databases/${ledger}/import`,
        headers: { ...authed(token), ...importBody.headers },
        payload: importBody.payload,
      }),
    ],
    ['board drop with values', await as(token, 'POST', `${records()}/${orphanId}/move`, { values: { owner: gone.id } })],
  ] as const;
}

const fieldIds = new Map<string, string>();
async function ownerFieldId(db: string): Promise<string> {
  const cached = fieldIds.get(db);
  if (cached) return cached;
  const id = (await pool.query("select id from fields where database_id = $1 and api_name = 'owner'", [db])).rows[0].id as string;
  fieldIds.set(db, id);
  return id;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, ADMIN_NAME);
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Copying WS' })).json().id;
  general = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const mkDb = async (name: string) => {
    const id = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: general, name })).json().id as string;
    const f = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Owner', type: 'user' });
    expect(f.statusCode, f.body).toBe(201);
    return id;
  };
  ledger = await mkDb('Ledger');
  target = await mkDb('Archive');

  mate = await joinAs(app, admin.token, ws, MATE_NAME, 'member');
  // A guest who can create (duplicate needs creator) — a plain guest editor is refused before it reaches the write.
  guest = await joinAs(app, admin.token, ws, GUEST_NAME, 'guest', [{ space_id: general, role: 'creator' }]);
  gone = await joinAs(app, admin.token, ws, GONE_NAME, 'member');

  // A record that names the departed person, then the person leaves: their id no longer resolves.
  const created = await as(admin.token, 'POST', records(), { values: { name: 'Orphaned', owner: gone.id } });
  expect(created.statusCode, created.body).toBe(201);
  orphanId = created.json().id as string;
  const members = (await as(admin.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id: string }>;
  const membershipId = members.find((m) => m.user_id === gone.id)?.id;
  expect(membershipId, 'the departed member has a membership row').toBeTruthy();
  const removed = await as(admin.token, 'DELETE', `/workspaces/${ws}/members/${membershipId}`);
  expect(removed.statusCode, removed.body).toBeLessThan(300);

  matePat = await mintPat(mate.token);
  mateSpacePat = await mintPat(mate.token, { space_ids: [general] });

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
  agentToken = await mintForAgent(await mkAgent('Ledger clerk', { target_databases: ledger }), { database_ids: [ledger] });
  spaceAgentToken = await mintForAgent(await mkAgent('General clerk', { target_spaces: 'General' }));
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('#1334 copying a departed person onto a record: a narrowed caller gets no candidate list', () => {
  for (const [label, token] of [
    ['guest with a creator grant', () => guest.token],
    ['database-scoped agent token', () => agentToken],
    ['space-scoped agent token', () => spaceAgentToken],
    ['space-bound PAT of a member', () => mateSpacePat],
  ] as const) {
    it(`${label}: no member's name or email in the body of any copying path`, async () => {
      for (const [path, res] of await copyingWrites(token())) {
        // The refusal itself is not what is under test (a path may 422 or report a failed row) — the leak is.
        expect(res.statusCode, `${label} ${path} must not succeed silently: ${res.body}`).not.toBe(500);
        for (const leak of everyone()) expect(res.body, `${label} ${path} carried ${leak}`).not.toContain(leak);
        expect(res.body, `${label} ${path} listed candidates`).not.toContain('Members:');
      }
    });
  }

  it('csv import is closed to a bound credential before it reaches the write (member role), and copy never prints details', async () => {
    // Traced, not assumed: import needs role member (the access layer runs a bound credential as guest), and the copy
    // route's 422 carries only a message, never the per-field details that hold the candidate list. If either changes,
    // the loop above turns red on this path — this test pins WHY it is currently safe.
    for (const token of [guest.token, agentToken, spaceAgentToken, mateSpacePat]) {
      const [, copy, imp] = await copyingWrites(token);
      expect([403, 422]).toContain(copy![1].statusCode); // a database-bound token cannot reach the target at all
      expect(copy![1].json().error.details).toBeUndefined();
      expect([403, 422]).toContain(imp![1].statusCode);
    }
  });

  it('duplicate in particular is a 422 that says the person was not found', async () => {
    for (const token of [guest.token, agentToken, spaceAgentToken, mateSpacePat]) {
      const res = await as(token, 'POST', `${records()}/${orphanId}/duplicate`);
      expect(res.statusCode, res.body).toBe(422);
    }
  });
});

describe('#1334 a full member keeps the candidate list on duplicate', () => {
  for (const [label, token] of [
    ['admin session', () => admin.token],
    ['member session', () => mate.token],
    ['unbound PAT of a member', () => matePat],
  ] as const) {
    it(`${label}: the duplicate 422 names the candidates`, async () => {
      const res = await as(token(), 'POST', `${records()}/${orphanId}/duplicate`);
      expect(res.statusCode, res.body).toBe(422);
      for (const who of [`${ADMIN_NAME} <${admin.email}>`, `${MATE_NAME} <${mate.email}>`]) expect(res.body, label).toContain(who);
    });
  }

  it('a duplicate of a record whose person still resolves succeeds for a bound caller', async () => {
    const fine = await as(admin.token, 'POST', records(), { values: { name: 'Fine', owner: mate.id } });
    expect(fine.statusCode, fine.body).toBe(201);
    for (const token of [guest.token, agentToken, mateSpacePat]) {
      const res = await as(token, 'POST', `${records()}/${fine.json().id}/duplicate`);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().values.owner).toBe(mate.id);
    }
  });
});
