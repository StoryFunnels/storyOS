import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { records } from '../src/db/schema';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
const { db, pool } = connectTestDb();

async function createField(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
    headers: authed(admin.token),
    payload,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'FieldSmith');
  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Fields WS' },
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
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('fields CRUD (MN-010)', () => {
  it('creates every user-creatable type with valid config', async () => {
    for (const [type, config] of [
      ['text', { multiline: true }],
      ['number', { format: 'currency', currency_code: 'USD' }],
      ['checkbox', {}],
      ['date', { include_time: true }],
      ['url', {}],
      ['email', {}],
      ['user', { multi: true }],
    ] as const) {
      const res = await createField({ display_name: `F ${type}`, type, config });
      expect(res.statusCode, `${type}: ${res.body}`).toBe(201);
    }
  });

  it('rejects invalid config with per-path 422 details', async () => {
    const res = await createField({
      display_name: 'Bad precision',
      type: 'number',
      config: { precision: -1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.some((d: { path: string }) => d.path.includes('config'))).toBe(true);
  });

  it('keeps api_names stable across display renames, and refuses duplicate display names (MN-212)', async () => {
    const first = await createField({ display_name: 'Status', type: 'select', options: [{ label: 'Open' }] });
    expect(first.json().apiName).toBe('status');

    // MN-212: a second live field with the same display name is refused outright —
    // no more silent status_2 twin rendering an identical label on the card.
    const second = await createField({ display_name: 'Status', type: 'text' });
    expect(second.statusCode).toBe(422);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${first.json().id}`,
      headers: authed(admin.token),
      payload: { display_name: 'Workflow state' },
    });
    expect(renamed.json().displayName).toBe('Workflow state');
    expect(renamed.json().apiName).toBe('status');

    // apiName uniqueness (incl. soft-deleted names) still suffixes: "Status" is free
    // again as a DISPLAY name, but the api slug "status" is taken forever.
    const third = await createField({ display_name: 'Status', type: 'text' });
    expect(third.statusCode).toBe(201);
    expect(third.json().apiName).toBe('status_2');
  });

  it('protects title and system fields from edit/delete', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}`,
      headers: authed(admin.token),
    });
    const title = detail.json().fields.find((f: { type: string }) => f.type === 'title');
    const system = detail.json().fields.find((f: { apiName: string }) => f.apiName === 'created_at');

    for (const id of [title.id, system.id]) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${id}`,
        headers: authed(admin.token),
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it('soft delete excludes the field from reads and reports usage', async () => {
    const field = (await createField({ display_name: 'Estimate', type: 'number' })).json();
    await db.insert(records).values({
      databaseId: dbId,
      title: 'Task with estimate',
      values: { [field.id]: 5 },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}`,
      headers: authed(admin.token),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().records_with_value).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}`,
      headers: authed(admin.token),
    });
    expect(detail.json().fields.find((f: { id: string }) => f.id === field.id)).toBeUndefined();
  });
});

describe('type changes (MN-010)', () => {
  it('text→number: dry run counts lossy conversions, apply converts in one transaction', async () => {
    const field = (await createField({ display_name: 'Hours text', type: 'text' })).json();
    await db.insert(records).values([
      { databaseId: dbId, title: 'ok', values: { [field.id]: '42.5' } },
      { databaseId: dbId, title: 'bad', values: { [field.id]: 'many' } },
    ]);

    const dry = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'number', dry_run: true },
    });
    expect(dry.json()).toMatchObject({ dry_run: true, records_affected: 2, lossy_conversions: 1 });

    const apply = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'number' },
    });
    expect(apply.json().lossy_conversions).toBe(1);

    const rows = await db.query.records.findMany();
    const values = rows.map((r) => (r.values as Record<string, unknown>)[field.id]).filter((v) => v !== undefined);
    expect(values).toEqual([42.5]);
  });

  it('select→multi_select wraps existing values', async () => {
    const field = (
      await createField({ display_name: 'Stage', type: 'select', options: [{ label: 'Idea', color: 'gold' }] })
    ).json();
    const optionId = field.options[0].id;
    await db.insert(records).values({ databaseId: dbId, title: 's', values: { [field.id]: optionId } });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'multi_select' },
    });
    expect(res.statusCode).toBe(201);

    const rows = await db.query.records.findMany();
    const converted = rows.find((r) => (r.values as Record<string, unknown>)[field.id] !== undefined);
    expect((converted!.values as Record<string, unknown>)[field.id]).toEqual([optionId]);
  });

  it('disallowed conversions return 422 with an explanation', async () => {
    const field = (await createField({ display_name: 'Owner', type: 'user' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'number' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('Cannot convert');
  });
});

describe('select options (MN-010)', () => {
  it('option delete: 409 with usage count unless confirmed, then clears values', async () => {
    const field = (
      await createField({
        display_name: 'Priority',
        type: 'select',
        options: [{ label: 'High', color: 'red' }, { label: 'Low' }],
      })
    ).json();
    const high = field.options[0];
    await db.insert(records).values({ databaseId: dbId, title: 'p', values: { [field.id]: high.id } });

    const url = `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/options/${high.id}`;
    const blocked = await app.inject({ method: 'DELETE', url, headers: authed(admin.token), payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('1 record');

    const confirmed = await app.inject({
      method: 'DELETE',
      url,
      headers: authed(admin.token),
      payload: { confirm: true },
    });
    expect(confirmed.json().records_cleared).toBe(1);
  });

  it('renaming an option is O(1) — stable id, label change only', async () => {
    const field = (
      await createField({ display_name: 'Channel', type: 'multi_select', options: [{ label: 'X' }] })
    ).json();
    const option = field.options[0];
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/options/${option.id}`,
      headers: authed(admin.token),
      payload: { label: 'Twitter/X', color: 'blue' },
    });
    expect(res.json().id).toBe(option.id);
    expect(res.json().label).toBe('Twitter/X');
  });
});

describe('rich_text fields (MN-041)', () => {
  const BLOCKS = [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hello rich world', styles: {} }] },
  ];
  let fieldId: string;
  let apiName: string;

  it('creates a rich_text field and writes/reads BlockNote JSON', async () => {
    const created = await createField({ display_name: 'Brief', type: 'rich_text', config: {} });
    expect(created.statusCode, created.body).toBe(201);
    fieldId = created.json().id;
    apiName = created.json().apiName;

    const rec = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: authed(admin.token),
      payload: { values: { name: 'Rich rec', [apiName]: BLOCKS } },
    });
    expect(rec.statusCode, rec.body).toBe(201);
    expect(rec.json().values[apiName]).toEqual(BLOCKS);
  });

  it('rejects non-block JSON and oversized documents', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: authed(admin.token),
      payload: { values: { name: 'Bad', [apiName]: 'just a string' } },
    });
    expect(bad.statusCode).toBe(422);

    const huge = [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(70_000), styles: {} }] }];
    const tooBig = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: authed(admin.token),
      payload: { values: { name: 'Huge', [apiName]: huge } },
    });
    expect(tooBig.statusCode).toBe(422);
  });

  it('converts rich_text → text (plain extraction) and text → rich_text (wrapped)', async () => {
    const down = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'text' },
    });
    expect(down.statusCode, down.body).toBe(201);

    const list1 = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records?limit=50`,
      headers: authed(admin.token),
    });
    const rec1 = list1.json().data.find((r: { title: string }) => r.title === 'Rich rec');
    expect(rec1.values[apiName]).toBe('Hello rich world');

    const up = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}/change-type`,
      headers: authed(admin.token),
      payload: { type: 'rich_text' },
    });
    expect(up.statusCode, up.body).toBe(201);

    const list2 = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records?limit=50`,
      headers: authed(admin.token),
    });
    const rec2 = list2.json().data.find((r: { title: string }) => r.title === 'Rich rec');
    expect(rec2.values[apiName]).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello rich world', styles: {} }] },
    ]);
  });
});
