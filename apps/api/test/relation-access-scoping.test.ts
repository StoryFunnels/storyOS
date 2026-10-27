import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { fields } from '../src/db/schema';

/**
 * #1070 — three relation gaps the 2026-10-26 security scan found:
 *  1. a relation field's relation_id was writable through the generic field PATCH, and relations were loaded by id
 *     alone, so a field could be pointed at another tenant's relation;
 *  2. record create/update/batch wrote links through planLinks with no access check on the target database — #238
 *     only covered POST/PUT .../links;
 *  3. creating a lookup/rollup checked nothing about the related database.
 * Same GUEST fixture shape as guest-mutation-surface.test.ts (#238): DB A in one space, DB B in another, a guest
 * granted on A only.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string;
let dbA: string;
let dbB: string;
let relFieldId: string;
let relApi: string;
let recB: { id: string; number: number };
let otherRelationId: string;

const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const recordsUrl = (db: string) => `/workspaces/${ws}/databases/${db}/records`;

async function linksOf(db: string, recordId: string) {
  const res = await as(owner.token, 'GET', `${recordsUrl(db)}/${recordId}`);
  return (res.json().values[relApi] ?? []) as Array<{ id: string }>;
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Rel1070 Owner');
  ws = (await as(owner.token, 'POST', '/workspaces', { name: '1070 WS' })).json().id;
  const spaceA = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const spaceB = (await as(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Space B' })).json().id;
  dbA = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'DB A' })).json().id;
  dbB = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'DB B' })).json().id;
  const rel = await as(owner.token, 'POST', `/workspaces/${ws}/relations`, {
    database_a_id: dbA,
    database_b_id: dbB,
    cardinality: 'many_to_many',
    field_a_name: 'Partner',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);
  relFieldId = rel.json().field_a.id;
  const fieldsA = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${dbA}`)).json().fields as Array<{ id: string; apiName: string }>;
  relApi = fieldsA.find((f) => f.id === relFieldId)!.apiName;
  const b = (await as(owner.token, 'POST', recordsUrl(dbB), { values: { name: 'Secret B' } })).json();
  recB = { id: b.id, number: b.number };

  // A second tenant with its own relation — the target a forged relation_id would aim at.
  const stranger = await signUpUser(app, 'Rel1070 Stranger');
  const ws2 = (await as(stranger.token, 'POST', '/workspaces', { name: 'Other tenant' })).json().id;
  const space2 = (await as(stranger.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
  const x = (await as(stranger.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: space2, name: 'X' })).json().id;
  const y = (await as(stranger.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: space2, name: 'Y' })).json().id;
  otherRelationId = (
    await as(stranger.token, 'POST', `/workspaces/${ws2}/relations`, { database_a_id: x, database_b_id: y, cardinality: 'many_to_many' })
  ).json().id;
  expect(otherRelationId).toBeTruthy();
});

afterAll(async () => {
  await app.close();
});

describe('a relation field cannot be re-pointed through field PATCH (#1070)', () => {
  // Its own relation, so a PATCH that wrongly succeeds cannot break the other describes' field.
  let pairFieldId: string;
  let pairApi: string;
  const fieldUrl = () => `/workspaces/${ws}/databases/${dbA}/fields/${pairFieldId}`;

  beforeAll(async () => {
    const rel = await as(owner.token, 'POST', `/workspaces/${ws}/relations`, {
      database_a_id: dbA,
      database_b_id: dbB,
      cardinality: 'many_to_many',
      field_a_name: 'Pair',
    });
    expect(rel.statusCode, rel.body).toBeLessThan(300);
    pairFieldId = rel.json().field_a.id;
    const detail = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${dbA}`)).json();
    pairApi = (detail.fields as Array<{ id: string; apiName: string }>).find((f) => f.id === pairFieldId)!.apiName;
  });

  it('changing relation_id to another tenant\'s relation is refused and the stored config is untouched', async () => {
    const res = await as(owner.token, 'PATCH', fieldUrl(), { config: { relation_id: otherRelationId } });
    expect(res.statusCode, res.body).toBe(422);
    const flipped = await as(owner.token, 'PATCH', fieldUrl(), { config: { side: 'b' } });
    expect(flipped.statusCode, flipped.body).toBe(422);
    const fields = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${dbA}`)).json().fields as Array<{ id: string; config: Record<string, unknown> }>;
    const field = fields.find((f) => f.id === pairFieldId)!;
    expect(field.config['relation_id']).not.toBe(otherRelationId);
    expect(field.config['side']).toBe('a');
  });

  it('MUST KEEP WORKING: echoing the stored relation keys back alongside another config change is fine', async () => {
    const fields = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${dbA}`)).json().fields as Array<{ id: string; config: Record<string, unknown> }>;
    const stored = fields.find((f) => f.id === pairFieldId)!.config;
    const res = await as(owner.token, 'PATCH', fieldUrl(), { config: { ...stored, entity_hidden: false } });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('a field whose stored config already names a foreign relation (written before this fix) resolves to nothing', async () => {
    const db = app.get<Db>(DB);
    const [row] = await db.select({ config: fields.config }).from(fields).where(eq(fields.id, pairFieldId));
    await db
      .update(fields)
      .set({ config: { ...(row!.config as Record<string, unknown>), relation_id: otherRelationId } })
      .where(eq(fields.id, pairFieldId));
    const create = await as(owner.token, 'POST', recordsUrl(dbA), { values: { name: 'x', [pairApi]: [1] } });
    expect(create.statusCode, create.body).toBe(422);
    expect(create.body).toContain('relation no longer exists');
    const recA = (await as(owner.token, 'POST', recordsUrl(dbA), { values: { name: 'y' } })).json().id;
    const link = await as(owner.token, 'PUT', `${recordsUrl(dbA)}/${recA}/links/${pairFieldId}`, { record_ids: [] });
    expect(link.statusCode, link.body).toBe(404);
  });
});

describe('record create/update access-check link targets like #238 does for /links (#1070)', () => {
  let guestA: Person;
  let guestBoth: Person;
  let member: Person;

  beforeAll(async () => {
    guestA = await joinAs(app, owner.token, ws, 'Rel1070 GuestA', 'guest', [{ database_id: dbA, role: 'editor' }]);
    guestBoth = await joinAs(app, owner.token, ws, 'Rel1070 GuestBoth', 'guest', [
      { database_id: dbA, role: 'editor' },
      { database_id: dbB, role: 'viewer' },
    ]);
    member = await joinAs(app, owner.token, ws, 'Rel1070 Member', 'member');
  });

  it('a guest without a grant on DB B cannot create an A record linked to a B record — by id or by number', async () => {
    for (const target of [recB.id, recB.number]) {
      const res = await as(guestA.token, 'POST', recordsUrl(dbA), { values: { name: 'sneaky', [relApi]: [target] } });
      expect(res.statusCode, res.body).toBe(422);
      // Same answer as a record that does not exist — no title, nothing to enumerate by.
      expect(res.body).toContain('no record');
      expect(res.body).not.toContain('Secret B');
    }
  });

  it('…nor through batch create', async () => {
    const batch = await as(guestA.token, 'POST', `${recordsUrl(dbA)}/batch`, { records: [{ values: { [relApi]: [recB.id] } }] });
    expect(batch.statusCode, batch.body).toBe(422);
  });

  it('…nor by updating an existing A record (PATCH, batch PATCH, move, bulk job)', async () => {
    const recA = (await as(owner.token, 'POST', recordsUrl(dbA), { values: { name: 'A1' } })).json().id;
    const patch = await as(guestA.token, 'PATCH', `${recordsUrl(dbA)}/${recA}`, { values: { [relApi]: [recB.id] } });
    expect(patch.statusCode, patch.body).toBe(422);

    const batch = await as(guestA.token, 'PATCH', `${recordsUrl(dbA)}/batch`, { record_ids: [recA], values: { [relApi]: [recB.id] } });
    expect(batch.statusCode, batch.body).toBe(200);
    expect(batch.json().updated).toBe(0);

    const move = await as(guestA.token, 'POST', `${recordsUrl(dbA)}/${recA}/move`, { values: { [relApi]: [recB.id] } });
    expect(move.statusCode, move.body).toBe(422);

    const job = await as(guestA.token, 'POST', `${recordsUrl(dbA)}/batch-jobs`, { op: 'update', record_ids: [recA], values: { [relApi]: [recB.id] } });
    expect(job.statusCode, job.body).toBe(422);

    expect(await linksOf(dbA, recA)).toEqual([]);
  });

  it('MUST KEEP WORKING: a guest who can read DB B links on create and update', async () => {
    const created = await as(guestBoth.token, 'POST', recordsUrl(dbA), { values: { name: 'ok', [relApi]: [recB.number] } });
    expect(created.statusCode, created.body).toBe(201);
    expect((await linksOf(dbA, created.json().id)).map((l) => l.id)).toEqual([recB.id]);

    const recA = (await as(owner.token, 'POST', recordsUrl(dbA), { values: { name: 'A2' } })).json().id;
    const patch = await as(guestBoth.token, 'PATCH', `${recordsUrl(dbA)}/${recA}`, { values: { [relApi]: [recB.id] } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await linksOf(dbA, recA)).map((l) => l.id)).toEqual([recB.id]);
  });

  it('MUST KEEP WORKING: a guest without B access can still clear links and write other values', async () => {
    const recA = (await as(owner.token, 'POST', recordsUrl(dbA), { values: { name: 'A3', [relApi]: [recB.id] } })).json().id;
    const res = await as(guestA.token, 'PATCH', `${recordsUrl(dbA)}/${recA}`, { values: { name: 'renamed', [relApi]: [] } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await linksOf(dbA, recA)).toEqual([]);
  });

  it('MUST KEEP WORKING: a member links across both databases', async () => {
    const created = await as(member.token, 'POST', recordsUrl(dbA), { values: { name: 'm', [relApi]: [recB.id] } });
    expect(created.statusCode, created.body).toBe(201);
    expect((await linksOf(dbA, created.json().id)).map((l) => l.id)).toEqual([recB.id]);
  });
});

describe('lookup/rollup creation requires read access on the related database (#1070)', () => {
  const fieldsUrl = () => `/workspaces/${ws}/databases/${dbA}/fields`;

  it('a guest with creator on DB A but no grant on DB B cannot create a lookup or a rollup through the relation', async () => {
    const guest = await joinAs(app, owner.token, ws, 'Rel1070 CreatorA', 'guest', [{ database_id: dbA, role: 'creator' }]);
    const lookup = await as(guest.token, 'POST', fieldsUrl(), {
      display_name: 'Peek',
      type: 'lookup',
      config: { relation_field_id: relFieldId, target_field_api_name: 'name' },
    });
    expect(lookup.statusCode, lookup.body).toBe(403);
    const rollup = await as(guest.token, 'POST', fieldsUrl(), {
      display_name: 'Peek count',
      type: 'rollup',
      config: { relation_field_id: relFieldId, op: 'count' },
    });
    expect(rollup.statusCode, rollup.body).toBe(403);
  });

  it('…nor re-point an existing lookup at it', async () => {
    const guest = await joinAs(app, owner.token, ws, 'Rel1070 CreatorA2', 'guest', [{ database_id: dbA, role: 'creator' }]);
    const textA = (await as(owner.token, 'POST', fieldsUrl(), { display_name: 'Note', type: 'text' })).json();
    // A self-relation on A gives the guest a lookup they legitimately own.
    const self = await as(owner.token, 'POST', `/workspaces/${ws}/relations`, {
      database_a_id: dbA, database_b_id: dbA, cardinality: 'many_to_many', field_a_name: 'Sibling', field_b_name: 'Sibling of',
    });
    expect(self.statusCode, self.body).toBeLessThan(300);
    const own = await as(guest.token, 'POST', fieldsUrl(), {
      display_name: 'Sibling note',
      type: 'lookup',
      config: { relation_field_id: self.json().field_a.id, target_field_api_name: textA.apiName },
    });
    expect(own.statusCode, own.body).toBe(201);
    const repoint = await as(guest.token, 'PATCH', `${fieldsUrl()}/${own.json().id}`, {
      config: { relation_field_id: relFieldId, target_field_api_name: 'name' },
    });
    expect(repoint.statusCode, repoint.body).toBe(403);
  });

  it('MUST KEEP WORKING: a guest who can read DB B creates both', async () => {
    const guest = await joinAs(app, owner.token, ws, 'Rel1070 CreatorBoth', 'guest', [
      { database_id: dbA, role: 'creator' },
      { database_id: dbB, role: 'viewer' },
    ]);
    const lookup = await as(guest.token, 'POST', fieldsUrl(), {
      display_name: 'Partner name',
      type: 'lookup',
      config: { relation_field_id: relFieldId, target_field_api_name: 'name' },
    });
    expect(lookup.statusCode, lookup.body).toBe(201);
    const rollup = await as(guest.token, 'POST', fieldsUrl(), {
      display_name: 'Partner count',
      type: 'rollup',
      config: { relation_field_id: relFieldId, op: 'count' },
    });
    expect(rollup.statusCode, rollup.body).toBe(201);
  });

  it('MUST KEEP WORKING: the owner creates a lookup', async () => {
    const res = await as(owner.token, 'POST', fieldsUrl(), {
      display_name: 'Owner partner name',
      type: 'lookup',
      config: { relation_field_id: relFieldId, target_field_api_name: 'name' },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
