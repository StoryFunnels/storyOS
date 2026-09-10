import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { activityEvents } from '../src/db/schema';
import { RecordsService } from '../src/records/records.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateFieldOptions: Array<{ id: string; label: string }>;
let adminUserId: string;
const { db, pool } = connectTestDb();

const base = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Recorder');
  adminUserId = (
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(admin.token) })
  ).json().id;
  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Records WS' },
  });
  wsId = ws.json().id;
  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  const database = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases`,
    headers: authed(admin.token),
    payload: { space_id: spaces.json()[0].id, name: 'Tasks' },
  });
  dbId = database.json().id;

  const stateField = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload: {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done', color: 'green' }],
    },
  });
  stateFieldOptions = stateField.json().options;

  await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload: { display_name: 'Estimate', type: 'number' },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('records CRUD (MN-011)', () => {
  let recId: string;

  it('creates a record with values keyed by api_name and stamps created_by', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: {
        values: { name: 'Ship v1', state: stateFieldOptions[0]!.id, estimate: 8 },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const rec = res.json();
    recId = rec.id;
    expect(rec.title).toBe('Ship v1');
    expect(rec.values).toEqual({ state: stateFieldOptions[0]!.id, estimate: 8 });
    // "Stamps created_by" means stamps it with the CALLER. `toBeTruthy()` passed
    // for any non-empty value — including another user's id or a system constant,
    // which is the only bug this line exists to catch.
    expect(rec.created_by, 'the author must be the caller, not merely present').toBe(adminUserId);
    expect(rec.position).toBeTruthy();
  });

  it('emits record.created activity in the same transaction', async () => {
    const events = await db.query.activityEvents.findMany({
      where: eq(activityEvents.recordId, recId),
    });
    expect(events.map((e) => e.type)).toContain('record.created');
  });

  it('rejects bad values with per-path 422 details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(admin.token),
      payload: { values: { nope: 1, estimate: 'many', state: 'bad-option' } },
    });
    expect(res.statusCode).toBe(422);
    const details = res.json().error.details;
    expect(details.map((d: { path: string }) => d.path).sort()).toEqual([
      'values.estimate',
      'values.nope',
      'values.state',
    ]);
  });

  it('PATCH merges values; explicit null clears a key; diff lands in activity', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/${recId}`,
      headers: authed(admin.token),
      payload: { values: { estimate: null, state: stateFieldOptions[1]!.id } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().values).toEqual({ state: stateFieldOptions[1]!.id });

    const events = await db.query.activityEvents.findMany({
      where: eq(activityEvents.recordId, recId),
    });
    const update = events.find((e) => e.type === 'record.updated');
    expect(update).toBeDefined();
    const diff = (update!.payload as { diff: Record<string, { from: unknown; to: unknown }> }).diff;
    expect(Object.keys(diff)).toHaveLength(2);
  });

  it('orphan values from deleted fields disappear from reads', async () => {
    const field = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
      headers: authed(admin.token),
      payload: { display_name: 'Temp', type: 'text' },
    });
    await app.inject({
      method: 'PATCH',
      url: `${base()}/${recId}`,
      headers: authed(admin.token),
      payload: { values: { temp: 'ephemeral' } },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.json().id}`,
      headers: authed(admin.token),
    });

    const rec = await app.inject({ method: 'GET', url: `${base()}/${recId}`, headers: authed(admin.token) });
    expect(rec.json().values.temp).toBeUndefined();
  });

  it('soft delete → trash → restore round-trip', async () => {
    await app.inject({ method: 'DELETE', url: `${base()}/${recId}`, headers: authed(admin.token) });

    const gone = await app.inject({ method: 'GET', url: `${base()}/${recId}`, headers: authed(admin.token) });
    expect(gone.statusCode).toBe(404);

    const trash = await app.inject({ method: 'GET', url: `${base()}/trash`, headers: authed(admin.token) });
    expect(trash.json().data.map((r: { id: string }) => r.id)).toContain(recId);

    const restored = await app.inject({
      method: 'POST',
      url: `${base()}/${recId}/restore`,
      headers: authed(admin.token),
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().title).toBe('Ship v1');
  });

  it('batch create is atomic and ≤100', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { records: Array.from({ length: 20 }, (_, i) => ({ values: { name: `Bulk ${i}` } })) },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toHaveLength(20);

    const tooMany = await app.inject({
      method: 'POST',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { records: Array.from({ length: 101 }, () => ({ values: {} })) },
    });
    expect(tooMany.statusCode).toBe(422);
  });

  it('lists with cursor pagination and q search', async () => {
    const page1 = await app.inject({
      method: 'GET',
      url: `${base()}?limit=10`,
      headers: authed(admin.token),
    });
    expect(page1.json().data).toHaveLength(10);
    expect(page1.json().has_more).toBe(true);

    const page2 = await app.inject({
      method: 'GET',
      url: `${base()}?limit=10&cursor=${page1.json().next_cursor}`,
      headers: authed(admin.token),
    });
    const ids1 = page1.json().data.map((r: { id: string }) => r.id);
    const ids2 = page2.json().data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);

    const search = await app.inject({
      method: 'GET',
      url: `${base()}?q=Ship`,
      headers: authed(admin.token),
    });
    expect(search.json().data.map((r: { title: string }) => r.title)).toContain('Ship v1');
  });

  it('guests can read but not write records', async () => {
    const guest = await signUpUser(app, 'GuestRec');
    const spaces = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
    });
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/invites`,
      headers: authed(admin.token),
      payload: { email: guest.email, role: 'guest', grants: [{ space_id: spaces.json()[0].id, role: 'commenter' }] },
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(guest.token),
      payload: { token },
    });

    const read = await app.inject({ method: 'GET', url: base(), headers: authed(guest.token) });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: 'POST',
      url: base(),
      headers: authed(guest.token),
      payload: { values: { name: 'nope' } },
    });
    expect(write.statusCode).toBe(403);
  });
});

describe('batch operations (MN-050)', () => {
  it('applies one patch to many records with partial-failure reporting', async () => {
    const make = async (name: string) =>
      (await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
        headers: authed(admin.token),
        payload: { values: { name } },
      })).json().id;
    const a = await make('Batch A');
    const b = await make('Batch B');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/batch`,
      headers: authed(admin.token),
      payload: { record_ids: [a, b, '00000000-0000-4000-8000-000000000000'], values: { name: 'Batched' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().failed).toHaveLength(1);

    const del = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/batch-delete`,
      headers: authed(admin.token),
      payload: { record_ids: [a, b] },
    });
    expect(del.json().deleted).toBe(2);

    const restore = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/batch-restore`,
      headers: authed(admin.token),
      payload: { record_ids: del.json().record_ids },
    });
    expect(restore.json().restored).toBe(2);
  });

  /**
   * #519 AC1 — reproduce first, per the ticket's own instruction, before
   * scoping any chunking mechanism.
   *
   * FINDING: batch-delete cannot exhibit "times out mid-flight, partial
   * unreported result" at all — records.service.ts's batchDelete is a single
   * set-based transaction, and batchRecordIdsSchema caps the array at 200, so
   * there is no path today to a 20k-row single request. batch-update
   * (records.service.ts's batchUpdate), however, applies each record
   * SEQUENTIALLY with NO enclosing transaction — a genuinely different shape.
   * A per-record failure is already caught and reported (see the test above),
   * but that same lack of a transaction means every record that succeeded
   * BEFORE a later one fails is already permanently committed, with no
   * all-or-nothing guarantee. This test proves the commit is real and
   * unconditional, not the network-timeout half of Otto's fear (which needs a
   * live socket abort to demonstrate and is not test-reachable) — but it is
   * the same failure shape: a batch that is part-applied, and the only
   * account of "which part" is the response body of a single request that a
   * real client can still fail to receive (timeout, network drop) after the
   * writes are done.
   *
   * #653 closed the "no undo path" half of this (see the batch-update-undo
   * tests below) by reusing the `record_versions` snapshot `update()` already
   * writes on every real change — this test still documents that the WRITE
   * itself remains unconditional and non-atomic across the batch.
   */
  it('#519 AC1: a batch update with a later failure leaves EARLIER records already committed — no transaction, no undo', async () => {
    const make = async (name: string) =>
      (
        await app.inject({
          method: 'POST',
          url: base(),
          headers: authed(admin.token),
          payload: { values: { name } },
        })
      ).json().id;
    const first = await make('First 519');
    const second = await make('Second 519');
    const ghost = '00000000-0000-4000-8000-000000000519'; // never existed — guaranteed to fail

    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: [first, second, ghost], values: { name: 'Renamed 519' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().failed).toHaveLength(1);

    // The two that succeeded are ALREADY PERSISTED — no rollback. If the
    // client never saw this 200 (dropped connection, proxy timeout), it would
    // have no way to learn even this much: the writes happen regardless of
    // whether anyone is listening for the response. (An undo path now exists
    // for the case where the response WAS seen — see the batch-update-undo
    // tests below — but that only helps a caller who has the `restorable`
    // list; it does nothing for a response nobody received.)
    const check = async (id: string) =>
      (await app.inject({ method: 'GET', url: `${base()}/${id}`, headers: authed(admin.token) })).json();
    expect((await check(first)).title).toBe('Renamed 519');
    expect((await check(second)).title).toBe('Renamed 519');
  });

  /**
   * #653 — the actual remaining gap #519 named: a selection above the old
   * 200-row cap. Seeds via RecordsService.createBatch directly (not 250
   * sequential HTTP posts) purely to keep the test fast; the assertions
   * below exercise the real HTTP batch endpoints.
   */
  it('#653: batch-delete above 200 records succeeds in internal chunks, and retrying with the same ids is a safe no-op', async () => {
    const recordsService = app.get(RecordsService);
    const seeded = await recordsService.createBatch(
      wsId,
      dbId,
      Array.from({ length: 250 }, (_, i) => ({ name: `Bulk653 ${i}` })),
      adminUserId,
    );
    const ids = seeded.map((r) => r.id);
    expect(ids).toHaveLength(250);

    const first = await app.inject({
      method: 'POST',
      url: `${base()}/batch-delete`,
      headers: authed(admin.token),
      payload: { record_ids: ids },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().deleted).toBe(250);

    // Retrying with the SAME ids (simulating a client that never saw the
    // response) must be safe: every row is already soft-deleted, so the
    // chunked isNull(deletedAt) filter finds nothing left to touch.
    const retry = await app.inject({
      method: 'POST',
      url: `${base()}/batch-delete`,
      headers: authed(admin.token),
      payload: { record_ids: ids },
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().deleted).toBe(0);
  });

  /**
   * #653 — batchRestore had NOT been given batchDelete's own chunking
   * treatment (found while reading it for the undo work below): a >200-row
   * restore was one single unbounded transaction. Fixed alongside the undo
   * work since it's the same function family under the same ticket.
   */
  it('#653: batch-restore above 200 records succeeds in internal chunks, and retrying with the same ids is a safe no-op', async () => {
    const recordsService = app.get(RecordsService);
    const seeded = await recordsService.createBatch(
      wsId,
      dbId,
      Array.from({ length: 250 }, (_, i) => ({ name: `Restore653 ${i}` })),
      adminUserId,
    );
    const ids = seeded.map((r) => r.id);
    await app.inject({
      method: 'POST',
      url: `${base()}/batch-delete`,
      headers: authed(admin.token),
      payload: { record_ids: ids },
    });

    const first = await app.inject({
      method: 'POST',
      url: `${base()}/batch-restore`,
      headers: authed(admin.token),
      payload: { record_ids: ids },
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().restored).toBe(250);

    const retry = await app.inject({
      method: 'POST',
      url: `${base()}/batch-restore`,
      headers: authed(admin.token),
      payload: { record_ids: ids },
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json().restored).toBe(0);
  });

  it('#653: batch-update above 200 records applies the patch to all of them, and retrying with the same ids is a safe no-op difference', async () => {
    const recordsService = app.get(RecordsService);
    const seeded = await recordsService.createBatch(
      wsId,
      dbId,
      Array.from({ length: 220 }, (_, i) => ({ name: `Bulk653b ${i}` })),
      adminUserId,
    );
    const ids = seeded.map((r) => r.id);

    const first = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: ids, values: { name: 'Renamed 653' } },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().updated).toBe(220);
    expect(first.json().failed).toHaveLength(0);

    // Re-applying the SAME patch to the SAME ids is a no-op difference, not
    // an error and not a double-effect — the resumability guarantee #653
    // relies on instead of a durable job/cursor.
    const retry = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: ids, values: { name: 'Renamed 653' } },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().updated).toBe(220);

    const check = await app.inject({
      method: 'GET',
      url: `${base()}/${ids[0]}`,
      headers: authed(admin.token),
    });
    expect(check.json().title).toBe('Renamed 653');
  });

  /**
   * #653 — the undo half. batchUpdate already ran `update()` per record,
   * which already snapshots the pre-write state into `record_versions`
   * (MN-231) whenever a value actually changes. No new table: `restorable`
   * is just the version id that write produced, per record.
   */
  it('#653: batch-update reports a restorable version per CHANGED record, and undo restores exactly those', async () => {
    const make = async (name: string) =>
      (await app.inject({ method: 'POST', url: base(), headers: authed(admin.token), payload: { values: { name } } })).json().id;
    const a = await make('Undo A');
    const b = await make('Undo B');

    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: [a, b], values: { name: 'Renamed for undo' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBe(2);
    expect(res.json().restorable).toHaveLength(2);
    expect(res.json().restorable.map((r: { record_id: string }) => r.record_id).sort()).toEqual([a, b].sort());

    const undo = await app.inject({
      method: 'POST',
      url: `${base()}/batch-update-undo`,
      headers: authed(admin.token),
      payload: { restorable: res.json().restorable },
    });
    expect(undo.statusCode, undo.body).toBe(201);
    expect(undo.json().restored).toBe(2);
    expect(undo.json().failed).toHaveLength(0);

    const check = async (id: string) =>
      (await app.inject({ method: 'GET', url: `${base()}/${id}`, headers: authed(admin.token) })).json();
    expect((await check(a)).title).toBe('Undo A');
    expect((await check(b)).title).toBe('Undo B');
  });

  it('#653: a no-op patch (value already equal) reports nothing restorable — there is no version to undo', async () => {
    const make = async (name: string) =>
      (await app.inject({ method: 'POST', url: base(), headers: authed(admin.token), payload: { values: { name } } })).json().id;
    const a = await make('Same Name');

    const res = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: [a], values: { name: 'Same Name' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().updated).toBe(1);
    expect(res.json().restorable).toHaveLength(0);
  });

  it('#653: undo refuses a version id that does not belong to the named record — no cross-record restore', async () => {
    const make = async (name: string) =>
      (await app.inject({ method: 'POST', url: base(), headers: authed(admin.token), payload: { values: { name } } })).json().id;
    const a = await make('Owner A');
    const b = await make('Owner B');

    const patchA = await app.inject({
      method: 'PATCH',
      url: `${base()}/batch`,
      headers: authed(admin.token),
      payload: { record_ids: [a], values: { name: 'A renamed' } },
    });
    const versionIdForA = patchA.json().restorable[0].version_id;

    // Mismatched pair: b's id paired with a's version — must 404 that entry,
    // not silently apply a's pre-edit snapshot onto b.
    const undo = await app.inject({
      method: 'POST',
      url: `${base()}/batch-update-undo`,
      headers: authed(admin.token),
      payload: { restorable: [{ record_id: b, version_id: versionIdForA }] },
    });
    expect(undo.statusCode, undo.body).toBe(201);
    expect(undo.json().restored).toBe(0);
    expect(undo.json().failed).toHaveLength(1);
    expect(undo.json().failed[0].record_id).toBe(b);

    const checkB = await app.inject({ method: 'GET', url: `${base()}/${b}`, headers: authed(admin.token) });
    expect(checkB.json().title).toBe('Owner B');
  });
});

describe('#230 upsert on a unique key', () => {
  let emailApiName: string;

  beforeAll(async () => {
    const field = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
      headers: authed(admin.token),
      payload: { display_name: 'Email 230', type: 'email', config: { unique: true } },
    });
    emailApiName = field.json().apiName;
  });

  it('rejects a non-unique field as the upsert key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: 'name', values: { name: 'x' } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an upsert with no value for the key field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'No email' } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('no existing match: creates a new record, created: true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'Ada', [emailApiName]: 'ada@example.com' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created).toBe(true);
    expect(res.json().record.title).toBe('Ada');
  });

  it('an existing match: updates that record instead of creating a duplicate, created: false', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'Grace', [emailApiName]: 'grace@example.com' } },
    });
    const firstId = first.json().record.id;

    const second = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'Grace Hopper', [emailApiName]: 'grace@example.com' } },
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().record.id).toBe(firstId);
    expect(second.json().record.title).toBe('Grace Hopper');

    const list = await app.inject({
      method: 'GET',
      url: `${base()}?q=Grace`,
      headers: authed(admin.token),
    });
    expect(list.json().data.filter((r: { title: string }) => r.title.startsWith('Grace'))).toHaveLength(1);
  });

  it('matches case-normalized, same as #229 uniqueness', async () => {
    await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'Mixed Case', [emailApiName]: 'Case@Example.com' } },
    });
    const res = await app.inject({
      method: 'POST',
      url: `${base()}/upsert`,
      headers: authed(admin.token),
      payload: { key_field: emailApiName, values: { name: 'Still Mixed Case', [emailApiName]: 'case@example.com' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().created).toBe(false);
    expect(res.json().record.title).toBe('Still Mixed Case');
  });
});
