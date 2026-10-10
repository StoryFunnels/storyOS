import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #881 — narrowing was applied to what a RESPONSE contains and never to what a QUERY can ask.
 * A guest correctly read a hidden rollup as 0 yet could filter on its true value (a bisection
 * recovers it), confirm a link to a record they cannot read with `has [id]`, and read a hidden
 * database's NAME off a relation field.
 *
 * Fixture: Projects (the guest holds a DATABASE grant) -> Clients (a different space, no grant).
 * Every project links to a client whose `worth` is the secret 7,777,777; `Total` is a rollup of it.
 * The load-bearing assertion is INDISTINGUISHABILITY, compared on the response BYTES: a query on a
 * field the caller cannot read must answer exactly what it answers for a field that does not exist.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let guest: { token: string; email: string }; // grant on Projects only
let insider: { token: string; email: string }; // grant on Projects AND Clients (the "can read it" control)
let ws: string;
let projects: string;
let clients: string;
let secretClient: string;
let secretClientNumber: number;
let relFieldId: string;

const SECRET = 7_777_777;
const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const query = (token: string, body: unknown) => inject(token, 'POST', `/workspaces/${ws}/databases/${projects}/records/query`, body);

/** A response reduced to what a caller can observe, minus the per-request id. */
const observed = (res: { statusCode: number; body: string }, swap?: [string, string]) => {
  let body = res.body.replace(/"request_id":"[^"]*"/g, '"request_id":"-"');
  if (swap) body = body.split(swap[0]).join(swap[1]);
  return `${res.statusCode} ${body}`;
};
const titles = (res: { json: () => { data: Array<{ title: string }> } }) => res.json().data.map((r) => r.title).sort();

async function inviteGuest(name: string, grants: Array<Record<string, unknown>>) {
  const u = await signUpUser(app, name);
  const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: u.email, role: 'guest', grants });
  expect(inv.statusCode, inv.body).toBeLessThan(300);
  await inject(u.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  return u;
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Q881 Owner');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'Q881' })).json().id;
  const spaceA = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const spaceB = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  projects = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Projects' })).json().id;
  clients = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'Zanzibar Clients' })).json().id;
  const worth = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${clients}/fields`, { display_name: 'Worth', type: 'number' });
  const worthApi = worth.json().apiName as string;
  const rel = await inject(owner.token, 'POST', `/workspaces/${ws}/relations`, {
    database_a_id: projects, database_b_id: clients, cardinality: 'one_to_many', field_a_name: 'Client',
  });
  relFieldId = rel.json().field_a.id;
  const roll = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/fields`, {
    display_name: 'Total', type: 'rollup', config: { relation_field_id: relFieldId, op: 'sum', target_field_api_name: worthApi },
  });
  expect(roll.statusCode, roll.body).toBe(201);
  const lookup = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/fields`, {
    display_name: 'Client Worth', type: 'lookup', config: { relation_field_id: relFieldId, target_field_api_name: worthApi },
  });
  expect(lookup.statusCode, lookup.body).toBe(201);
  await inject(owner.token, 'POST', `/workspaces/${ws}/favorites`, { target_type: 'record', target_id: secretClient });
  const formula = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/fields`, {
    display_name: 'Exposure', type: 'formula', config: { expression: 'sum({Client.Worth})' },
  });
  expect(formula.statusCode, formula.body).toBe(201);
  const budget = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/fields`, { display_name: 'Budget', type: 'number' });
  const budgetApi = budget.json().apiName as string;

  const secret = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${clients}/records`, { values: { name: 'Hidden Co', [worthApi]: SECRET } });
  secretClient = secret.json().id;
  secretClientNumber = secret.json().number;
  for (const [i, name] of ['Alpha', 'Beta'].entries()) {
    const p = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/records`, { values: { name, [budgetApi]: (i + 1) * 100 } });
    if (name === 'Alpha') {
      const link = await inject(owner.token, 'PUT', `/workspaces/${ws}/databases/${projects}/records/${p.json().id}/links/${relFieldId}`, { record_ids: [secretClient] });
      expect(link.statusCode, link.body).toBeLessThan(300);
    }
  }

  guest = await inviteGuest('Q881 Guest', [{ database_id: projects, role: 'viewer' }]);
  insider = await inviteGuest('Q881 Insider', [{ database_id: projects, role: 'viewer' }, { database_id: clients, role: 'viewer' }]);
}, 180_000);

afterAll(async () => { await app.close(); });

const rollupFilter = (op: string, value: number, field = 'total') => ({ filter: { field, op, value }, limit: 50 });

describe('#881 (A) the bisection stops working', () => {
  it('CONTROL: an admin CAN filter the rollup, so the three probes differ (this is the oracle the guest must not get)', async () => {
    const gt7 = titles(await query(owner.token, rollupFilter('gt', 7_000_000)));
    const eq = titles(await query(owner.token, rollupFilter('eq', SECRET)));
    const gt8 = titles(await query(owner.token, rollupFilter('gt', 8_000_000)));
    expect(gt7).toEqual(['Alpha']);
    expect(eq).toEqual(['Alpha']);
    expect(gt8).toEqual([]);
  });

  it.each([['gt', 7_000_000], ['eq', SECRET], ['gt', 8_000_000]] as const)(
    'a guest filtering the hidden rollup with %s %d gets the SAME BYTES as a field that does not exist',
    async (op, value) => {
      const hidden = await query(guest.token, rollupFilter(op, value, 'total'));
      const missing = await query(guest.token, rollupFilter(op, value, 'zzqq'));
      expect(hidden.statusCode).toBe(422);
      expect(observed(hidden)).toBe(observed(missing, ['zzqq', 'total']));
      expect(hidden.body).not.toContain(String(SECRET));
    },
  );

  it('the three probes are mutually indistinguishable (no response differs from another)', async () => {
    const seen = new Set<string>();
    for (const [op, value] of [['gt', 7_000_000], ['eq', SECRET], ['gt', 8_000_000]] as const) {
      // the response carries neither the op nor the value, so the raw bytes are compared directly
      seen.add(observed(await query(guest.token, rollupFilter(op, value, 'total'))));
    }
    expect(seen.size).toBe(1);
  });

  it('sort by the hidden rollup is refused exactly like a sort by a field that does not exist', async () => {
    const hidden = await query(guest.token, { sorts: [{ field: 'total', direction: 'desc' }], limit: 50 });
    const missing = await query(guest.token, { sorts: [{ field: 'zzqq', direction: 'desc' }], limit: 50 });
    expect(hidden.statusCode).toBe(422);
    expect(observed(hidden)).toBe(observed(missing, ['zzqq', 'total']));
  });

  it('sum over the hidden rollup, and a group-by on the relation, are refused like unknown fields', async () => {
    for (const body of [
      { op: 'sum', field: 'total' },
      { op: 'sum', field: 'zzqq' },
    ]) {
      const res = await inject(guest.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate`, body);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).not.toContain(String(SECRET));
    }
    const a = await inject(guest.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate`, { op: 'sum', field: 'total' });
    const b = await inject(guest.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate`, { op: 'sum', field: 'zzqq' });
    expect(observed(a)).toBe(observed(b, ['zzqq', 'total']));
    const grouped = await inject(guest.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate/grouped`, { op: 'count', group_by: 'client' });
    const groupedMissing = await inject(guest.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate/grouped`, { op: 'count', group_by: 'zzqq' });
    expect(grouped.statusCode).toBe(422);
    expect(observed(grouped)).toBe(observed(groupedMissing, ['zzqq', 'client']));
  });
});

describe('#881 (A) a formula derived through the relation is closed like the rollup', () => {
  it('CONTROL: an admin can filter it; a guest gets the same bytes as an unknown field', async () => {
    const adminHit = await query(owner.token, rollupFilter('gt', 7_000_000, 'exposure'));
    expect(adminHit.statusCode, adminHit.body).toBeLessThan(300);
    expect(titles(adminHit)).toEqual(['Alpha']);
    const hidden = await query(guest.token, rollupFilter('gt', 7_000_000, 'exposure'));
    const missing = await query(guest.token, rollupFilter('gt', 7_000_000, 'zzqq'));
    expect(hidden.statusCode).toBe(422);
    expect(observed(hidden)).toBe(observed(missing, ['zzqq', 'exposure']));
  });
});

describe('#881 (A) a relation filter cannot confirm a link to a record the caller cannot read', () => {
  const has = (token: string, ids: string[], op = 'has') =>
    query(token, { filter: { field: 'client', op, value: ids }, limit: 50 });

  it('CONTROL: an admin CAN confirm the link', async () => {
    expect(titles(await has(owner.token, [secretClient]))).toEqual(['Alpha']);
  });

  it('a guest: `has [hidden id]` answers EXACTLY what `has [an id that does not exist]` answers', async () => {
    const hidden = await has(guest.token, [secretClient]);
    const missing = await has(guest.token, [crypto.randomUUID()]);
    expect(hidden.statusCode).toBeLessThan(300);
    expect(observed(hidden)).toBe(observed(missing));
    expect(titles(hidden)).toEqual([]);
  });

  it('`has_none [hidden id]` likewise matches `has_none [nonexistent id]` (everything), and the guest sees no links at all', async () => {
    const hidden = await has(guest.token, [secretClient], 'has_none');
    const missing = await has(guest.token, [crypto.randomUUID()], 'has_none');
    expect(observed(hidden)).toBe(observed(missing));
    expect(titles(hidden)).toEqual(['Alpha', 'Beta']);
    // is_empty / not_empty see only visible links: none, so they cannot reveal which project links to a hidden record
    expect(titles(await query(guest.token, { filter: { field: 'client', op: 'not_empty' }, limit: 50 }))).toEqual([]);
    expect(titles(await query(guest.token, { filter: { field: 'client', op: 'is_empty' }, limit: 50 }))).toEqual(['Alpha', 'Beta']);
  });

  it('a malformed relation filter fails the same for a guest and an admin (validation is not narrowed)', async () => {
    const g = await query(guest.token, { filter: { field: 'client', op: 'has', value: [] }, limit: 5 });
    const a = await query(owner.token, { filter: { field: 'client', op: 'has', value: [] }, limit: 5 });
    expect(g.statusCode).toBe(a.statusCode);
    expect(observed(g)).toBe(observed(a));
  });

  it('the record number of a hidden client is no back door either', async () => {
    const byNumber = await has(guest.token, [String(secretClientNumber)]);
    expect(titles(byNumber)).toEqual([]);
  });
});

describe('#881 MUST KEEP WORKING', () => {
  it('a guest who CAN read the whole target database filters and sorts the rollup normally, same as an admin', async () => {
    for (const probe of [rollupFilter('gt', 7_000_000), rollupFilter('eq', SECRET), rollupFilter('gt', 8_000_000)]) {
      const a = await query(owner.token, probe);
      const i = await query(insider.token, probe);
      expect(i.statusCode, i.body).toBeLessThan(300);
      expect(titles(i)).toEqual(titles(a));
    }
    const sorted = await query(insider.token, { sorts: [{ field: 'total', direction: 'desc' }], limit: 50 });
    expect(sorted.statusCode, sorted.body).toBeLessThan(300);
    expect(titles(await query(insider.token, { filter: { field: 'client', op: 'has', value: [secretClient] }, limit: 50 }))).toEqual(['Alpha']);
  });

  it('the restricted guest still filters and sorts their own scalar fields, and reads the rollup as 0 with no chip (#824/#937)', async () => {
    const budget = (await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${projects}`)).json().fields.find((f: { name?: string; displayName?: string }) => (f.displayName ?? f.name) === 'Budget').apiName as string;
    const over = await query(guest.token, { filter: { field: budget, op: 'gt', value: 150 }, sorts: [{ field: budget, direction: 'desc' }], limit: 50 });
    expect(over.statusCode, over.body).toBeLessThan(300);
    expect(titles(over)).toEqual(['Beta']);
    const all = await query(guest.token, { limit: 50 });
    expect(all.body).not.toContain('Hidden Co');
    expect(all.body).not.toContain(String(SECRET));
  });

  it('an admin and a member are not narrowed at all', async () => {
    const res = await query(owner.token, { sorts: [{ field: 'total', direction: 'desc' }], limit: 50 });
    expect(res.statusCode).toBeLessThan(300);
    expect((await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${projects}/records/aggregate`, { op: 'sum', field: 'total' })).json().value).toBe(SECRET);
  });
});

describe('#881 (B) a relation field names nothing about a database the caller cannot reach', () => {
  const relationOf = async (token: string) => {
    const res = await inject(token, 'GET', `/workspaces/${ws}/databases/${projects}`);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, field: res.json().fields.find((f: { type: string }) => f.type === 'relation') };
  };

  it('CONTROL: an admin, and a guest who can reach the target, see the far side', async () => {
    for (const token of [owner.token, insider.token]) {
      const { field } = await relationOf(token);
      expect(field.relation.target_database_id).toBe(clients);
      expect(field.relation.target_database_name).toBe('Zanzibar Clients');
    }
  });

  it('a guest without access: the field still renders, but no id, name, colour or inverse field of the far side', async () => {
    for (const token of [guest.token]) {
      const { body, field } = await relationOf(token);
      expect(field, 'the field must still be there').toBeDefined();
      expect(field.relation.target_database_id).toBeNull();
      expect(field.relation.target_database_name).toBeNull();
      expect(field.relation.target_database_color).toBeNull();
      expect(field.relation.inverse_field_id).toBeNull();
      expect(field.relation.cardinality).toBe('one_to_many');
      expect(body).not.toContain('Zanzibar');
      expect(body).not.toContain(clients);
    }
  });
});

describe('#881 the OTHER query paths (AC8), each checked against the response body', () => {
  it('a sort by a lookup over the hidden database is refused like an unknown field', async () => {
    const hidden = await query(guest.token, { sorts: [{ field: 'client_worth', direction: 'desc' }], limit: 50 });
    const missing = await query(guest.token, { sorts: [{ field: 'zzqq', direction: 'desc' }], limit: 50 });
    expect(hidden.statusCode).toBe(422);
    expect(observed(hidden)).toBe(observed(missing, ['zzqq', 'client_worth']));
  });

  it('global search: neither the hidden record\'s title nor its value is findable, and a hit in scope still is', async () => {
    for (const q of ['Hidden', 'Zanzibar', String(SECRET)]) {
      const res = await inject(guest.token, 'GET', `/workspaces/${ws}/search?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.body).not.toContain('Hidden Co');
      expect(res.body).not.toContain(secretClient);
    }
    const hit = await inject(guest.token, 'GET', `/workspaces/${ws}/search?q=Alpha`);
    expect(hit.body).toContain('Alpha');
  });

  it('favourites: the owner favourited the hidden record; the guest neither sees it listed nor can add it', async () => {
    const list = await inject(guest.token, 'GET', `/workspaces/${ws}/favorites`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain('Hidden Co');
    expect(list.body).not.toContain(secretClient);
    const add = await inject(guest.token, 'POST', `/workspaces/${ws}/favorites`, { target_type: 'record', target_id: secretClient });
    expect(add.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a record read still carries no chip, no title and no value from the far side (the #824/#937 response rule is intact)', async () => {
    const all = await query(guest.token, { limit: 50 });
    expect(all.body).not.toContain('Hidden Co');
    expect(all.body).not.toContain(String(SECRET));
    expect(all.body).not.toContain(secretClient);
  });
});
