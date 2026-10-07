import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #229 — a per-field Unique constraint (text/number). Covers: toggling on
 * scans and refuses instead of silently enabling (AC1); create/edit rejects a
 * duplicate and names the conflicting record (AC2); enforcement is exercised
 * through the same RecordsService methods every write path shares (AC3, see
 * the research note in fields.service.ts/records.service.ts — CSV import and
 * MCP both funnel through create/createBatch/update, so this file exercises
 * them once at the REST layer); multiple empty values are always allowed and
 * normalization is optional (AC4); a real DB unique index survives a race the
 * app-level pre-check alone can't (AC5); turning the flag off keeps the data
 * (AC6).
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'UniqueFieldOwner');
  wsId = (await as('POST', '/workspaces', { name: 'Unique WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Products' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#229 unique field constraints', () => {
  it('a text field can be marked Unique at create time', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'SKU',
      type: 'text',
      config: { unique: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().config.unique).toBe(true);
  });

  it('rejects a create with a duplicate value, naming the conflicting record', async () => {
    const first = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'SKU-100' } });
    expect(first.statusCode, first.body).toBe(201);
    const firstNumber = first.json().number;

    const dupe = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'SKU-100' } });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.details[0].message).toContain(`#${firstNumber}`);
  });

  it('rejects an edit that would duplicate another record', async () => {
    const other = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'SKU-200' } })).json();
    const patch = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${other.id}`, { values: { sku: 'SKU-100' } });
    expect(patch.statusCode).toBe(409);
  });

  it('an edit that keeps a record\'s own value unchanged is not a conflict with itself', async () => {
    const record = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'SKU-300' } })).json();
    const patch = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${record.id}`, { values: { sku: 'SKU-300', name: 'Renamed' } });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
  });

  it('multiple records may all leave a Unique field empty', async () => {
    const a = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} });
    const b = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
  });

  it('normalizes case and whitespace by default before comparing', async () => {
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'Norm-1' } });
    const dupe = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: '  norm-1  ' } });
    expect(dupe.statusCode).toBe(409);
  });

  it('a real DB unique index survives a race the app-level pre-check alone would miss', async () => {
    const [a, b] = await Promise.all([
      as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'Race-1' } }),
      as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'Race-1' } }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it('turning Unique off keeps existing data and permits new duplicates', async () => {
    const fieldId = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'sku').id;
    const before = await as('GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    const countBefore = before.json().data.length;

    const off = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}`, { config: { unique: false } });
    expect(off.statusCode, off.body).toBeLessThan(300);
    expect(off.json().config.unique).toBe(false);

    const after = await as('GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(after.json().data.length).toBe(countBefore);

    const dupe = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { sku: 'SKU-100' } });
    expect(dupe.statusCode, dupe.body).toBe(201);
  });

  it('re-enabling Unique on a field with existing conflicts is refused, not silently applied', async () => {
    const fieldId = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'sku').id;
    // Two live "SKU-100" records now exist from the prior test.
    const res = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}`, { config: { unique: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message.toLowerCase()).toContain('sku-100');

    // Confirm the flag was NOT half-set by the rejected attempt.
    const detail = await as('GET', `/workspaces/${wsId}/databases/${dbId}`);
    const field = detail.json().fields.find((f: { id: string }) => f.id === fieldId);
    expect(field.config.unique).toBe(false);
  });

  it('a number field can also be marked Unique', async () => {
    const created = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Code',
      type: 'number',
      config: { unique: true },
    });
    expect(created.statusCode, created.body).toBe(201);

    const first = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { code: 42 } });
    expect(first.statusCode, first.body).toBe(201);
    const dupe = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { code: 42 } });
    expect(dupe.statusCode).toBe(409);
  });

  it('MUST KEEP WORKING: an ordinary (non-unique) text field never rejects a duplicate value', async () => {
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text' });
    const a = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { notes: 'same text' } });
    const b = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { notes: 'same text' } });
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
  });
});
