import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { fieldType, records } from '../src/db/schema';
import { FIELD_VALUE_STORAGE } from '../src/fields/field-value-emptiness';

/**
 * Ticket #1308 — `get_field_usage` reported 0 records for RELATION fields that hold links. The count read `records.values[field]`, and a
 * relation never stores anything there: its data is rows in `record_links`. The same blind spot applied to every field whose value is not a
 * key in `records.values` (the title column, the system columns, computed values, lookups), so each type is exercised here, not only the
 * one the ticket named.
 *
 * The invariant under test: a reported 0 means 0. Two ways a count can be wrong in the dangerous direction are pinned: counting
 * the wrong storage (this ticket), and counting what the caller may not see (the guest section).
 */
let app: NestFastifyApplication;
let db: Db;
let owner: { token: string; email: string };
let ws: string;
let people: string;
let episodes: string;
let spaceId: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const as = (method: string, url: string, payload?: unknown) => call(owner.token, method, url, payload);
const usageOf = async (database: string, fieldId: string, token = owner.token) => {
  const res = await call(token, 'GET', `/workspaces/${ws}/databases/${database}/fields/${fieldId}/usage`);
  expect(res.statusCode, res.body).toBe(200);
  const { records_with_value, storage, complete } = res.json() as { records_with_value: number; storage: string; complete: boolean };
  return { records_with_value, storage, complete };
};
async function newDatabase(name: string) {
  return (await as('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name })).json().id as string;
}
async function newRecord(database: string, values: Record<string, unknown>) {
  const res = await as('POST', `/workspaces/${ws}/databases/${database}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function setLinks(database: string, record: string, fieldId: string, ids: string[]) {
  const res = await as('PUT', `/workspaces/${ws}/databases/${database}/records/${record}/links/${fieldId}`, { record_ids: ids });
  expect(res.statusCode, res.body).toBeLessThan(300);
}
async function newRelation(a: string, b: string, cardinality: 'many_to_many' | 'one_to_many', nameA: string, nameB: string) {
  const res = await as('POST', `/workspaces/${ws}/relations`, {
    database_a_id: a, database_b_id: b, cardinality, field_a_name: nameA, field_b_name: nameB,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.id as string, fieldA: body.field_a.id as string, fieldB: body.field_b.id as string };
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<Db>(DB);
  owner = await signUpUser(app, 'Usage Storage Owner');
  ws = (await as('POST', '/workspaces', { name: 'Usage Storage' })).json().id;
  spaceId = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  people = await newDatabase('People');
  episodes = await newDatabase('Episodes');
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#1308 relation fields count their LINKS, on both sides', () => {
  let rel: { id: string; fieldA: string; fieldB: string };
  let p: string[];
  let e: string[];

  beforeAll(async () => {
    rel = await newRelation(people, episodes, 'many_to_many', 'Episodes', 'Hosts');
    p = [];
    for (const name of ['Ada', 'Bo', 'Cy', 'Di']) p.push(await newRecord(people, { name }));
    e = [];
    for (const name of ['Pilot', 'Finale']) e.push(await newRecord(episodes, { name }));
  });

  it('an empty relation field reports 0, and says what 0 is counted from', async () => {
    expect(await usageOf(people, rel.fieldA)).toEqual({ records_with_value: 0, storage: 'record_links', complete: true });
    expect(await usageOf(episodes, rel.fieldB)).toMatchObject({ records_with_value: 0, complete: true });
  });

  it('three records with links report 3 (acceptance 1); the fourth, with none, is not counted', async () => {
    for (const rec of p.slice(0, 3)) await setLinks(people, rec, rel.fieldA, [e[0]!]);
    expect((await usageOf(people, rel.fieldA)).records_with_value).toBe(3);
  });

  it('counts RECORDS, not links: one record holding two links is one record', async () => {
    await setLinks(people, p[0]!, rel.fieldA, [e[0]!, e[1]!]);
    expect((await usageOf(people, rel.fieldA)).records_with_value).toBe(3);
  });

  it('the REVERSE field counts the records on its own side (one episode is linked, then both)', async () => {
    // Pilot has three hosts, Finale has one: both episodes now carry links.
    expect((await usageOf(episodes, rel.fieldB)).records_with_value).toBe(2);
    await setLinks(people, p[0]!, rel.fieldA, [e[0]!]);
    // Finale lost its only link: the reverse side drops to 1 although nothing on the Episodes records was edited.
    expect((await usageOf(episodes, rel.fieldB)).records_with_value).toBe(1);
  });

  it('an unlinked link is not counted (a deleted link must not read as data)', async () => {
    await setLinks(people, p[2]!, rel.fieldA, []);
    expect((await usageOf(people, rel.fieldA)).records_with_value).toBe(2);
  });

  it('a soft-deleted OWNING record is not counted', async () => {
    const del = await as('DELETE', `/workspaces/${ws}/databases/${people}/records/${p[1]}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await usageOf(people, rel.fieldA)).records_with_value).toBe(1);
  });

  it('a link to a trashed TARGET still counts: the link survives in the trash and the relation delete would destroy it', async () => {
    const owner2 = await newRecord(people, { name: 'Eve' });
    const target = await newRecord(episodes, { name: 'Bonus' });
    await setLinks(people, owner2, rel.fieldA, [target]);
    const before = (await usageOf(people, rel.fieldA)).records_with_value;
    const del = await as('DELETE', `/workspaces/${ws}/databases/${episodes}/records/${target}`);
    expect(del.statusCode, del.body).toBeLessThan(300);
    expect((await usageOf(people, rel.fieldA)).records_with_value).toBe(before);
  });

  it('a one-to-many relation counts the same way on its single-valued side and its many side', async () => {
    const shows = await newDatabase('Shows');
    const hosts = await newDatabase('Hosts');
    const r = await newRelation(shows, hosts, 'one_to_many', 'Host', 'Shows');
    const show = await newRecord(shows, { name: 'Morning' });
    await newRecord(shows, { name: 'Evening' });
    const host = await newRecord(hosts, { name: 'Fran' });
    expect((await usageOf(shows, r.fieldA)).records_with_value).toBe(0);
    await setLinks(shows, show, r.fieldA, [host]);
    expect((await usageOf(shows, r.fieldA)).records_with_value).toBe(1);
    expect((await usageOf(hosts, r.fieldB)).records_with_value).toBe(1);
  });

  it('a SELF relation keeps its two sides apart', async () => {
    const tasks = await newDatabase('Tasks');
    const r = await newRelation(tasks, tasks, 'many_to_many', 'Blocks', 'Blocked by');
    const t1 = await newRecord(tasks, { name: 't1' });
    const t2 = await newRecord(tasks, { name: 't2' });
    await newRecord(tasks, { name: 't3' });
    await setLinks(tasks, t1, r.fieldA, [t2]);
    expect((await usageOf(tasks, r.fieldA)).records_with_value).toBe(1); // t1 blocks something
    expect((await usageOf(tasks, r.fieldB)).records_with_value).toBe(1); // t2 is blocked by something
  });
});

describe('#1308 delete consumers use the same number', () => {
  it('DELETE /fields on a relation field is refused (relations API), and the links are untouched', async () => {
    const a = await newDatabase('Left');
    const b = await newDatabase('Right');
    const r = await newRelation(a, b, 'many_to_many', 'Rights', 'Lefts');
    const left = await newRecord(a, { name: 'l' });
    const right = await newRecord(b, { name: 'r' });
    await setLinks(a, left, r.fieldA, [right]);
    const del = await as('DELETE', `/workspaces/${ws}/databases/${a}/fields/${r.fieldA}`);
    expect(del.statusCode).toBe(422);
    expect((await usageOf(a, r.fieldA)).records_with_value).toBe(1);
  });

  it('DELETE /relations without confirm is refused and destroys no link', async () => {
    const a = await newDatabase('Left2');
    const b = await newDatabase('Right2');
    const r = await newRelation(a, b, 'many_to_many', 'Rights', 'Lefts');
    const left = await newRecord(a, { name: 'l' });
    await setLinks(a, left, r.fieldA, [await newRecord(b, { name: 'r' })]);
    const refused = await as('DELETE', `/workspaces/${ws}/relations/${r.id}`, {});
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.statusCode).toBeLessThan(500);
    expect((await usageOf(a, r.fieldA)).records_with_value).toBe(1);
    const ok = await as('DELETE', `/workspaces/${ws}/relations/${r.id}`, { confirm: true });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
  });

  it('DELETE /fields on a plain field still returns its stored-value count (unchanged)', async () => {
    const d = await newDatabase('Plain');
    const f = (await as('POST', `/workspaces/${ws}/databases/${d}/fields`, { display_name: 'Note', type: 'text', config: {} })).json();
    await newRecord(d, { note: 'x' });
    await newRecord(d, { note: '   ' });
    await newRecord(d, {});
    expect(await usageOf(d, f.id)).toEqual({ records_with_value: 1, storage: 'record_values', complete: true });
    const del = await as('DELETE', `/workspaces/${ws}/databases/${d}/fields/${f.id}`);
    expect(del.json().records_with_value).toBe(1);
  });
});

describe('#1308 every field type is counted from where it is stored', () => {
  let d: string;
  let related: string;
  let relField: string;
  const fieldIds: Record<string, string> = {};

  beforeAll(async () => {
    d = await newDatabase('Everything');
    related = await newDatabase('Related things');
    const mk = async (name: string, type: string, config: Record<string, unknown> = {}, target = d) => {
      const res = await as('POST', `/workspaces/${ws}/databases/${target}/fields`, { display_name: name, type, config });
      expect(res.statusCode, `${name}: ${res.body}`).toBe(201);
      return res.json() as { id: string; apiName: string };
    };
    const rel = await newRelation(d, related, 'many_to_many', 'Links', 'Back links');
    relField = rel.fieldA;
    const power = await mk('Power', 'number', {}, related);
    const lookup = await mk('Power seen', 'lookup', { relation_field_id: relField, target_field_api_name: power.apiName });
    const rollup = await mk('Power total', 'rollup', { relation_field_id: relField, op: 'sum', target_field_api_name: power.apiName });
    const score = await mk('Score', 'number');
    const doubled = await mk('Doubled', 'formula', { expression: '{Score} * 2' });
    const button = await mk('Press', 'button', { actions: [{ type: 'create_record', database_id: related, values: { name: 'x' } }] });
    const attach = await mk('Cover', 'attachment');
    const user = await mk('Owner', 'user', {});
    const ai = await mk('Gist', 'ai', { prompt: 'Summarise {Score}', output: { kind: 'text' } });
    Object.assign(fieldIds, {
      score: score.id, lookup: lookup.id, rollup: rollup.id, formula: doubled.id, button: button.id, attach: attach.id, user: user.id, ai: ai.id,
    });

    const target = await newRecord(related, { name: 'T', [power.apiName]: 5 });
    const r1 = await newRecord(d, { name: 'one', [score.apiName]: 0 }); // 0 is a value
    const r2 = await newRecord(d, { name: 'two', [score.apiName]: 4 });
    await newRecord(d, { name: '   ' }); // a blank title is not a value
    await setLinks(d, r1, relField, [target]);
    // r2 links to a far record that holds NO Power: it carries a link but nothing for the lookup to show.
    await setLinks(d, r2, relField, [await newRecord(related, { name: 'Empty T' })]);
    // An AI field's text lives in computed_values, written by a background job; write it the way the job does.
    await db.update(records).set({ computedValues: sql`${records.computedValues} || ${JSON.stringify({ [ai.id]: 'a gist' })}::jsonb` }).where(and(eq(records.id, r2)));
  });

  it('title: counted from the title column, blank titles not counted', async () => {
    const titleField = (await as('GET', `/workspaces/${ws}/databases/${d}`)).json().fields.find((f: { type: string }) => f.type === 'title');
    expect(await usageOf(d, titleField.id)).toMatchObject({ records_with_value: 2, storage: 'title' });
  });

  it('a stored number counts 0 as a value and ignores records that never set it', async () => {
    expect(await usageOf(d, fieldIds.score!)).toMatchObject({ records_with_value: 2, storage: 'record_values' });
  });

  it('system columns: every live record has a created_at', async () => {
    const createdAt = (await as('GET', `/workspaces/${ws}/databases/${d}`)).json().fields.find((f: { type: string }) => f.type === 'created_at');
    expect(createdAt, 'every database carries a stored created_at system field').toBeTruthy();
    expect(await usageOf(d, createdAt.id)).toMatchObject({ records_with_value: 3, storage: 'system_column' });
  });

  it('lookup: derived from the links, so only a record linked to a target that HOLDS a value counts (r2 is linked, to a blank one)', async () => {
    expect((await usageOf(d, relField)).records_with_value).toBe(2);
    expect(await usageOf(d, fieldIds.lookup!)).toMatchObject({ records_with_value: 1, storage: 'derived_from_links', complete: true });
  });

  it('rollup, formula and ai: counted from the materialised computed values', async () => {
    expect(await usageOf(d, fieldIds.rollup!)).toMatchObject({ storage: 'computed_values' });
    expect((await usageOf(d, fieldIds.formula!)).records_with_value).toBe(2);
    expect(await usageOf(d, fieldIds.ai!)).toMatchObject({ records_with_value: 1, storage: 'computed_values' });
  });

  it('button: holds no value at all, so 0 is exact', async () => {
    expect(await usageOf(d, fieldIds.button!)).toEqual({ records_with_value: 0, storage: 'none', complete: true });
  });

  it('attachment and user fields are values-backed and unchanged', async () => {
    expect(await usageOf(d, fieldIds.attach!)).toMatchObject({ records_with_value: 0, storage: 'record_values' });
    expect(await usageOf(d, fieldIds.user!)).toMatchObject({ records_with_value: 0, storage: 'record_values' });
  });

  it('EVERY field type in the database enum has a declared storage (a new type cannot be forgotten)', () => {
    for (const type of fieldType.enumValues) expect(FIELD_VALUE_STORAGE[type], `field type "${type}" has no declared storage`).toBeTruthy();
    expect(Object.keys(FIELD_VALUE_STORAGE).sort()).toEqual([...fieldType.enumValues].sort());
  });
});

describe('#1308 the count does not leak links the caller cannot see', () => {
  let a: string;
  let b: string;
  let linked: { id: string; fieldA: string };
  let unlinked: { id: string; fieldA: string };
  let narrow: { token: string; email: string }; // creator on A, no grant on B
  let insider: { token: string; email: string }; // creator on A, viewer on B
  let lookupField: string;
  let hiddenRecord: string;
  let rollupField: string;

  async function invite(name: string, grants: Array<Record<string, unknown>>) {
    const u = await signUpUser(app, name);
    const inv = await as('POST', `/workspaces/${ws}/invites`, { email: u.email, role: 'guest', grants });
    expect(inv.statusCode, inv.body).toBeLessThan(300);
    await call(u.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    return u;
  }

  beforeAll(async () => {
    const hiddenSpace = (await as('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
    a = await newDatabase('Guest-side');
    b = (await as('POST', `/workspaces/${ws}/databases`, { space_id: hiddenSpace, name: 'Hidden-side' })).json().id;
    const c = (await as('POST', `/workspaces/${ws}/databases`, { space_id: hiddenSpace, name: 'Hidden-empty' })).json().id;
    const r1 = await newRelation(a, b, 'many_to_many', 'Secrets', 'Seen by');
    const r2 = await newRelation(a, c, 'many_to_many', 'Nothing', 'Nobody');
    linked = { id: r1.id, fieldA: r1.fieldA };
    unlinked = { id: r2.id, fieldA: r2.fieldA };
    const worth = (await as('POST', `/workspaces/${ws}/databases/${b}/fields`, { display_name: 'Worth', type: 'number', config: {} })).json();
    lookupField = (await as('POST', `/workspaces/${ws}/databases/${a}/fields`, {
      display_name: 'Worth seen', type: 'lookup', config: { relation_field_id: r1.fieldA, target_field_api_name: worth.apiName },
    })).json().id;
    rollupField = (await as('POST', `/workspaces/${ws}/databases/${a}/fields`, {
      display_name: 'Worth total', type: 'rollup', config: { relation_field_id: r1.fieldA, op: 'sum', target_field_api_name: worth.apiName },
    })).json().id;
    const hidden = await newRecord(b, { name: 'Hidden Co', [worth.apiName]: 7_777_777 });
    hiddenRecord = hidden;
    for (const name of ['x', 'y']) await setLinks(a, await newRecord(a, { name }), r1.fieldA, [hidden]);
    // A third record links only to a SECOND far record that the record-scoped caller below cannot read.
    const hiddenToo = await newRecord(b, { name: 'Other Hidden Co', [worth.apiName]: 1 });
    await setLinks(a, await newRecord(a, { name: 'z' }), r1.fieldA, [hiddenToo]);
    narrow = await invite('Usage Narrow', [{ database_id: a, role: 'creator' }]);
    insider = await invite('Usage Insider', [{ database_id: a, role: 'creator' }, { database_id: b, role: 'viewer' }]);
  }, 120_000);

  it('CONTROL: the owner and a caller who can read the far side see the real count, marked complete', async () => {
    expect(await usageOf(a, linked.fieldA)).toMatchObject({ records_with_value: 3, complete: true });
    expect(await usageOf(a, linked.fieldA, insider.token)).toMatchObject({ records_with_value: 3, complete: true });
  });

  it('a caller who cannot read the far side gets a count of what they can see (0) AND complete: false, never a confident zero', async () => {
    const got = await usageOf(a, linked.fieldA, narrow.token);
    expect(got.records_with_value).toBe(0);
    expect(got.complete).toBe(false);
  });

  it('...and cannot tell a relation with hidden links from one with none: the two responses are identical', async () => {
    const withLinks = await usageOf(a, linked.fieldA, narrow.token);
    const without = await usageOf(a, unlinked.fieldA, narrow.token);
    expect(withLinks).toEqual(without);
  });

  it('a lookup through the same relation is held back the same way (its count would otherwise reveal the links)', async () => {
    expect(await usageOf(a, lookupField)).toMatchObject({ records_with_value: 3, complete: true });
    expect(await usageOf(a, lookupField, narrow.token)).toMatchObject({ records_with_value: 0, complete: false });
  });

  it('a rollup through the same relation is held back the same way (a materialised value would otherwise reveal the links)', async () => {
    expect((await usageOf(a, rollupField)).complete).toBe(true);
    expect(await usageOf(a, rollupField, narrow.token)).toMatchObject({ records_with_value: 0, complete: false });
  });

  it('a caller who can read ONE far record counts only the records linked to it (2 of 3), marked incomplete; a lookup stays held back', async () => {
    const scoped = await invite('Usage Record Scoped', [{ database_id: a, role: 'creator' }, { record_id: hiddenRecord, role: 'viewer' }]);
    expect(await usageOf(a, linked.fieldA, scoped.token)).toMatchObject({ records_with_value: 2, complete: false });
    expect(await usageOf(a, unlinked.fieldA, scoped.token)).toMatchObject({ records_with_value: 0, complete: false });
    expect(await usageOf(a, lookupField, scoped.token)).toMatchObject({ records_with_value: 0, complete: false });
  });

  it('a caller without creator on the database still gets nothing (the existing gate is intact)', async () => {
    const viewer = await invite('Usage Viewer', [{ database_id: a, role: 'viewer' }]);
    const res = await call(viewer.token, 'GET', `/workspaces/${ws}/databases/${a}/fields/${linked.fieldA}/usage`);
    expect(res.statusCode).toBeGreaterThanOrEqual(403);
    expect(res.statusCode).toBeLessThan(500);
  });
});
