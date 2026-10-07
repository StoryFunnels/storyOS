import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_FIELD_BY_API_NAME } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #743 — Ievgen's naming ruling reverses #351's original one: `id` becomes
 * the canonical api_name for the permanent record number, `number` is
 * deprecated. Deprecate, never delete (his words, repeated throughout
 * #743): a stored view filtering/sorting by `number`, or a stored formula
 * referencing it, must keep resolving. What changes is only the LABEL —
 * "Number" must never appear in the UI, including as a chip's text on an
 * existing saved view — and a new `deprecated` flag a picker can use to
 * stop OFFERING it, which this ticket intentionally does not build here
 * (that's the consuming surface's job; see #743's phase plan).
 *
 * Shipped only AFTER #760 fixed the formula field-ref resolver's casing
 * bug — this file's last three tests exercise exactly the scenario that bug
 * broke (a stored formula reference after this relabel). The result is
 * better than originally feared: because `number` IS `number`'s own
 * api_name, EVERY reference this relabel could have stranded — `{number}`,
 * and even the stale `{Number}` — still resolves via #760's fixed fallback.
 * Only a reference to a name that was never real fails, exactly as before.
 */
describe('#743 — the `number` system field is deprecated, not removed', () => {
  it('registry: `number` is flagged deprecated and relabeled "ID"; `id` is unaffected', () => {
    const numberField = SYSTEM_FIELD_BY_API_NAME.get('number');
    expect(numberField?.deprecated).toBe(true);
    expect(numberField?.display_name).toBe('ID');

    const idField = SYSTEM_FIELD_BY_API_NAME.get('id');
    expect(idField?.deprecated).toBeFalsy();
    expect(idField?.display_name).toBe('ID');

    // Both still resolve through the same column — the rename is a label
    // change, not a new concept.
    expect(numberField?.type).toBe(idField?.type);
  });

  let app: NestFastifyApplication;
  let admin: { token: string; email: string };
  let wsId: string;
  let dbId: string;
  const as = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signUpUser(app, 'DeprecatedNumberAdmin');
    wsId = (await as(admin.token, 'POST', '/workspaces', { name: '743 WS' })).json().id;
    const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Issues' })).json().id;
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'First' } });
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Second' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('MUST KEEP WORKING: an existing stored filter/sort by the deprecated `number` api_name still resolves', async () => {
    const filtered = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: 'number', op: 'gte', value: 1 },
      sorts: [{ field: 'number', direction: 'asc' }],
    });
    expect(filtered.statusCode, filtered.body).toBeLessThan(300);
    expect(filtered.json().data.length).toBe(2);

    // Same records, same order, as sorting/filtering by the canonical `id` —
    // deprecating the name never changed what it resolves to.
    const viaId = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: 'id', op: 'gte', value: 1 },
      sorts: [{ field: 'id', direction: 'asc' }],
    });
    expect(filtered.json().data.map((r: { id: string }) => r.id)).toEqual(viaId.json().data.map((r: { id: string }) => r.id));
  });

  it('#760 regression check: a formula referencing {number} (the api_name) resolves despite the display_name now being "ID"', async () => {
    // This is the exact shape that broke before #760: {Number} (Title Case,
    // matching the OLD display_name) stopped resolving the moment `number`'s
    // display_name became "ID" — a reference by the api_name itself, in any
    // case, must keep working regardless.
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Hash Number',
      type: 'formula',
      config: { expression: '"#" + {number}' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Third' } });
    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`)).json();
    expect(after.values.hash_number).toBe(`#${rec.json().number}`);
  });

  it('#760 side effect: a formula referencing the OLD display name {Number} keeps resolving too — its text happens to lowercase to the api_name itself', async () => {
    // Not the scenario originally feared (a hard break): {Number}.toLowerCase()
    // is 'number', which #760's fixed fallback now matches against byApi
    // directly, since `number` IS the field's own api_name. So a stored
    // formula written against the OLD display name survives this relabel
    // for free, for this specific field — a strictly BETTER outcome than
    // "fails with a clear error", not a weaker one. (This coincidence is
    // specific to `number`/`id`, whose api_name equals their historical
    // display name lowercased; it does not generalize to every rename.)
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Stale Ref',
      type: 'formula',
      config: { expression: '"#" + {Number}' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const rec = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Fourth' } });
    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`)).json();
    expect(after.values.stale_ref).toBe(`#${rec.json().number}`);
  });

  it('a genuinely unknown reference (matching neither a display name nor any api_name) still fails clearly', async () => {
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Bad Ref',
      type: 'formula',
      config: { expression: '"#" + {NotAField}' },
    });
    expect(created.statusCode).toBe(422);
    expect(JSON.stringify(created.json())).toContain('Unknown field');
  });
});
