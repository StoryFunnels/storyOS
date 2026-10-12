import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #543 — a token bound to specific spaces/databases reaches those and provably nothing else.
 *
 * The fixture is a project in the granted space linked to a client in a space the token is NOT
 * bound to; the client carries a distinctive name and email. Every adversarial path asserts on
 * the RESPONSE BODY (no id, no title, no value from the other side), because a status code alone
 * would pass a response that refuses the route but still leaks through a side door.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string;
let spaceA: string; // in scope
let spaceB: string; // out of scope
let projects: string; // in spaceA
let siblingInA: string; // in spaceA, a second database (space-scope proves it, db-scope excludes it)
let clients: string; // in spaceB — the secret side
let projectRec: string;
let clientRec: string;
let lookupApi: string;
let boundToDb: string; // PAT bound to `projects` only
let boundToSpace: string; // PAT bound to spaceA

const SECRET_NAME = 'Zanzibar Holdings';
const SECRET_EMAIL = 'ceo@zanzibar-secret.example';

const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const asOwner = (method: string, url: string, payload?: unknown) => inject(owner.token, method, url, payload);

async function mint(resource_scope?: unknown, scope = 'admin'): Promise<{ token: string; id: string }> {
  const res = await asOwner('POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope, resource_scope });
  expect(res.statusCode, res.body).toBe(201);
  return { token: res.json().token, id: res.json().id };
}

const noSecret = (body: string) => {
  expect(body).not.toContain(SECRET_NAME);
  expect(body).not.toContain(SECRET_EMAIL);
  expect(body).not.toContain(clientRec);
  expect(body).not.toContain(clients);
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Bound Owner');
  ws = (await asOwner('POST', '/workspaces', { name: 'Bound WS' })).json().id;
  spaceA = (await asOwner('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const sb = await asOwner('POST', `/workspaces/${ws}/spaces`, { name: 'Other space' });
  expect(sb.statusCode, sb.body).toBeLessThan(300);
  spaceB = sb.json().id;
  projects = (await asOwner('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Projects' })).json().id;
  siblingInA = (await asOwner('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Sibling' })).json().id;
  clients = (await asOwner('POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'Clients' })).json().id;
  const email = await asOwner('POST', `/workspaces/${ws}/databases/${clients}/fields`, {
    display_name: 'Email', type: 'text',
  });
  const emailApi = email.json().apiName as string;
  const rel = await asOwner('POST', `/workspaces/${ws}/relations`, {
    database_a_id: projects, database_b_id: clients, cardinality: 'one_to_many', field_a_name: 'Client',
  });
  const relField = rel.json().field_a.id as string;
  const lookup = await asOwner('POST', `/workspaces/${ws}/databases/${projects}/fields`, {
    display_name: 'Client Email', type: 'lookup', config: { relation_field_id: relField, target_field_api_name: emailApi },
  });
  expect(lookup.statusCode, lookup.body).toBe(201);
  lookupApi = lookup.json().apiName;
  clientRec = (await asOwner('POST', `/workspaces/${ws}/databases/${clients}/records`, {
    values: { name: SECRET_NAME, [emailApi]: SECRET_EMAIL },
  })).json().id;
  projectRec = (await asOwner('POST', `/workspaces/${ws}/databases/${projects}/records`, {
    values: { name: 'Rebrand' },
  })).json().id;
  const link = await asOwner('PUT', `/workspaces/${ws}/databases/${projects}/records/${projectRec}/links/${relField}`, {
    record_ids: [clientRec],
  });
  expect(link.statusCode, link.body).toBeLessThan(300);
  // The owner favourites the secret record — a bound token must never see it listed.
  await asOwner('POST', `/workspaces/${ws}/favorites`, { target_type: 'record', target_id: clientRec });
  boundToDb = (await mint({ database_ids: [projects] })).token;
  boundToSpace = (await mint({ space_ids: [spaceA] })).token;
}, 180_000);

afterAll(async () => {
  await app.close();
});

describe('#543 control — what the bound token MUST still do', () => {
  it('reads, creates, updates and deletes in its own database', async () => {
    const list = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${projects}/records`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain('Rebrand');
    const created = await inject(boundToDb, 'POST', `/workspaces/${ws}/databases/${projects}/records`, { values: { name: 'Fresh' } });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const id = created.json().id as string;
    expect((await inject(boundToDb, 'PATCH', `/workspaces/${ws}/databases/${projects}/records/${id}`, { values: { name: 'Fresher' } })).statusCode).toBe(200);
    expect((await inject(boundToDb, 'DELETE', `/workspaces/${ws}/databases/${projects}/records/${id}`)).statusCode).toBeLessThan(300);
  });

  it("the person's own session and an unrestricted PAT are not narrowed", async () => {
    const plain = (await mint()).token;
    for (const token of [owner.token, plain]) {
      const dbs = await inject(token, 'GET', `/workspaces/${ws}/databases`);
      expect(dbs.statusCode).toBe(200);
      expect(dbs.body).toContain(clients);
    }
  });

  it('a space-bound token reaches every database in that space, and only that space', async () => {
    const dbs = await inject(boundToSpace, 'GET', `/workspaces/${ws}/databases`);
    expect(dbs.statusCode).toBe(200);
    expect(dbs.body).toContain(projects);
    expect(dbs.body).toContain(siblingInA);
    noSecret(dbs.body);
    // …whereas a database-bound token does NOT reach the sibling in the same space.
    const sibling = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${siblingInA}/records`);
    expect(sibling.statusCode).toBe(403);
  });
});

describe('#543 — what a space covers, and what the credential can say about itself', () => {
  it('a space-bound token covers a database created in that space AFTER it was minted', async () => {
    const later = (await asOwner('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Later' })).json().id as string;
    const res = await inject(boundToSpace, 'GET', `/workspaces/${ws}/databases/${later}/records`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('/me shows a bound credential its own boundary, and an unrestricted one null', async () => {
    const bound = await inject(boundToDb, 'GET', '/me');
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().auth.resource_scope).toEqual({ space_ids: [], database_ids: [projects] });
    const plain = await asOwner('GET', '/me');
    expect(plain.json().auth.resource_scope).toBeNull();
  });
});

describe('#543 adversarial — nothing outside the boundary, by path', () => {
  it('LIST: databases', async () => {
    const res = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(projects);
    expect(res.body).not.toContain(siblingInA);
    noSecret(res.body);
  });

  it('LIST: spaces', async () => {
    const res = await inject(boundToDb, 'GET', `/workspaces/${ws}/spaces`);
    expect(res.body).not.toContain(spaceB);
    expect(res.body).not.toContain('Other space');
  });

  it('BY ID: database, its records, one record, create, update — all refused, naming the boundary', async () => {
    const attempts: Array<[string, string, unknown?]> = [
      ['GET', `/workspaces/${ws}/databases/${clients}`],
      ['GET', `/workspaces/${ws}/databases/${clients}/records`],
      ['GET', `/workspaces/${ws}/databases/${clients}/records/${clientRec}`],
      ['POST', `/workspaces/${ws}/databases/${clients}/records`, { values: { name: 'x' } }],
      ['PATCH', `/workspaces/${ws}/databases/${clients}/records/${clientRec}`, { values: { name: 'x' } }],
      ['DELETE', `/workspaces/${ws}/databases/${clients}/records/${clientRec}`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await inject(boundToDb, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.body, `${method} ${url}`).toContain('bound to specific spaces or databases');
      noSecret(res.body);
    }
  });

  it('NO EXISTENCE ORACLE: a real out-of-scope database and an id that does not exist get the identical refusal', async () => {
    const real = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${clients}/records`);
    const missing = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${crypto.randomUUID()}/records`);
    expect(real.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(real.json().error.message).toBe(missing.json().error.message);
  });

  it('RELATION FIELD: the linked record on an in-scope row does not carry the out-of-scope side', async () => {
    const res = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${projects}/records/${projectRec}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Rebrand');
    noSecret(res.body);
  });

  it('LOOKUP / ROLLUP: a value derived through the relation is not served either', async () => {
    // The control: the OWNER does see the looked-up value, so a null for the bound token is the
    // boundary working, not a fixture that never produced a value.
    const ownerView = await asOwner('GET', `/workspaces/${ws}/databases/${projects}/records/${projectRec}`);
    expect(ownerView.json().values?.[lookupApi]).toBe(SECRET_EMAIL);
    const one = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${projects}/records/${projectRec}`);
    expect(one.json().values?.[lookupApi] ?? null).toBeNull();
    const list = await inject(boundToDb, 'GET', `/workspaces/${ws}/databases/${projects}/records`);
    noSecret(list.body);
    const query = await inject(boundToDb, 'POST', `/workspaces/${ws}/databases/${projects}/records/query`, {});
    noSecret(query.body);
  });

  it('RELATIONS: listing shows none that touch the other side, and one cannot be created toward it', async () => {
    const list = await inject(boundToDb, 'GET', `/workspaces/${ws}/relations`);
    expect(list.statusCode, list.body).toBe(200);
    noSecret(list.body);
    const make = await inject(boundToDb, 'POST', `/workspaces/${ws}/relations`, {
      database_a_id: projects, database_b_id: clients, cardinality: 'many_to_many',
    });
    expect(make.statusCode, make.body).toBeGreaterThanOrEqual(400);
    noSecret(make.body);
  });

  it('GLOBAL SEARCH: finds in scope, never out of scope', async () => {
    const hit = await inject(boundToDb, 'GET', `/workspaces/${ws}/search?q=Rebrand`);
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.body).toContain('Rebrand');
    const miss = await inject(boundToDb, 'GET', `/workspaces/${ws}/search?q=Zanzibar`);
    expect(miss.statusCode).toBe(200);
    noSecret(miss.body);
  });

  it('FAVOURITES: the owner favourited an out-of-scope record; the bound token neither sees nor adds it', async () => {
    const list = await inject(boundToDb, 'GET', `/workspaces/${ws}/favorites`);
    expect(list.statusCode, list.body).toBe(200);
    noSecret(list.body);
    const add = await inject(boundToDb, 'POST', `/workspaces/${ws}/favorites`, { target_type: 'record', target_id: clientRec });
    expect(add.statusCode).toBeGreaterThanOrEqual(400);
    noSecret(add.body);
  });

  it('VIEWS and COMMENTS on the out-of-scope database are refused', async () => {
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', `/workspaces/${ws}/databases/${clients}/views`, { name: 'v', type: 'table' }],
      ['GET', `/workspaces/${ws}/databases/${clients}/views/trash`],
      ['GET', `/workspaces/${ws}/databases/${clients}/records/${clientRec}/comments`],
      ['POST', `/workspaces/${ws}/databases/${clients}/records/${clientRec}/comments`, { body: [{ type: 'text', text: 'hi' }] }],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await inject(boundToDb, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.body).toContain('bound to specific spaces or databases');
    }
  });

  it('NOTIFICATIONS and every other unmarked route: refused in words, and the body carries nothing', async () => {
    for (const url of [
      `/workspaces/${ws}/notifications`,
      `/workspaces/${ws}/approvals`,
      `/workspaces/${ws}/members`,
      `/workspaces/${ws}/skills`,
      `/workspaces/${ws}/grants`,
      `/workspaces/${ws}/audit-log`,
      `/workspaces/${ws}/export/workspace.zip`,
      `/workspaces/${ws}/databases/${clients}/export/csv`,
    ]) {
      const res = await inject(boundToDb, 'GET', url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.message, url).toContain('bound to specific spaces or databases');
      noSecret(res.body);
    }
  });

  it('a bound token cannot mint another token (which would walk around the binding)', async () => {
    const res = await inject(boundToDb, 'POST', '/me/tokens', { name: 'escape', workspace_id: ws });
    expect(res.statusCode).toBe(403);
  });
});

describe('#543 minting — never wider than the minter, and no oracle', () => {
  it('rejects an empty scope', async () => {
    const res = await asOwner('POST', '/me/tokens', { name: 'x', workspace_id: ws, resource_scope: { space_ids: [], database_ids: [] } });
    expect(res.statusCode).toBe(422);
  });

  it('a nonexistent id and a real-but-foreign one are rejected the same way', async () => {
    const stranger = await signUpUser(app, 'Bound Stranger');
    const other = (await inject(stranger.token, 'POST', '/workspaces', { name: 'Theirs' })).json().id as string;
    const theirSpace = (await inject(stranger.token, 'GET', `/workspaces/${other}/spaces`)).json()[0].id as string;
    const missing = await asOwner('POST', '/me/tokens', { name: 'x', workspace_id: ws, resource_scope: { space_ids: [crypto.randomUUID()] } });
    const foreign = await asOwner('POST', '/me/tokens', { name: 'x', workspace_id: ws, resource_scope: { space_ids: [theirSpace] } });
    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
  });

  it('a guest cannot mint a token wider than their own grants, and narrowing them narrows the token live', async () => {
    const guest = await signUpUser(app, 'Bound Guest');
    const inv = await asOwner('POST', `/workspaces/${ws}/invites`, {
      email: guest.email, role: 'guest', grants: [{ database_id: projects, role: 'editor' }],
    });
    expect(inv.statusCode, inv.body).toBeLessThan(300);
    await inject(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const guestId = ((await inject(guest.token, 'GET', '/me')).json().user?.id ?? (await inject(guest.token, 'GET', '/me')).json().id) as string;

    const tooWide = await inject(guest.token, 'POST', '/me/tokens', {
      name: 'wide', workspace_id: ws, resource_scope: { database_ids: [clients] },
    });
    expect(tooWide.statusCode).toBe(404);

    const ok = await inject(guest.token, 'POST', '/me/tokens', {
      name: 'ok', workspace_id: ws, resource_scope: { database_ids: [projects] },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const url = `/workspaces/${ws}/databases/${projects}/records`;
    expect((await inject(ok.json().token, 'GET', url)).statusCode).toBe(200);

    // Take the guest's grant away underneath the held token.
    const grants = (await asOwner('GET', `/workspaces/${ws}/grants`)).json();
    const mine = (Array.isArray(grants) ? grants : grants.data).filter((g: { user_id: string }) => g.user_id === guestId);
    for (const g of mine) await asOwner('DELETE', `/workspaces/${ws}/grants/${g.id}`);
    expect((await inject(ok.json().token, 'GET', url)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('#543 lifecycle — immediate, immutable, inspectable', () => {
  it('revoking takes effect on the very next call of a held token', async () => {
    const held = await mint({ database_ids: [projects] });
    const url = `/workspaces/${ws}/databases/${projects}/records`;
    expect((await inject(held.token, 'GET', url)).statusCode).toBe(200);
    expect((await asOwner('DELETE', `/me/tokens/${held.id}`)).statusCode).toBe(200);
    expect((await inject(held.token, 'GET', url)).statusCode).toBe(401);
  });

  it('there is no way to widen a token: scope cannot be updated', async () => {
    const t = await mint({ database_ids: [projects] });
    const res = await asOwner('PATCH', `/me/tokens/${t.id}`, { resource_scope: { database_ids: [clients] } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const url = `/workspaces/${ws}/databases/${clients}/records`;
    expect((await inject(t.token, 'GET', url)).statusCode).toBe(403);
  });

  it('the scope is inspectable on the token list, and an unrestricted token says null', async () => {
    const list = (await asOwner('GET', '/me/tokens')).json().data as Array<{ name: string; resource_scope: unknown }>;
    expect(list.some((t) => t.resource_scope && JSON.stringify(t.resource_scope).includes(projects))).toBe(true);
    expect(list.some((t) => t.resource_scope === null)).toBe(true);
  });

  it('a token bound to a database that is later deleted reaches nothing, rather than everything', async () => {
    const tmp = (await asOwner('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Doomed' })).json().id as string;
    const t = await mint({ database_ids: [tmp] });
    const gone = await asOwner('DELETE', `/workspaces/${ws}/databases/${tmp}`, { confirm: 'Doomed' });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    const dbs = await inject(t.token, 'GET', `/workspaces/${ws}/databases`);
    expect(dbs.statusCode).toBe(200);
    expect(dbs.json()).toEqual([]);
  });
});
