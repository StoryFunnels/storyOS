import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #203 — field defaults land on records created through the real API, not just
 * in the resolver's unit tests.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function addField(name: string, type: string, config: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: name,
    type,
    config,
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json() as { id: string; apiName: string };
}

async function createRecord(values: Record<string, unknown>) {
  // The endpoint takes `{ values }` keyed by api_name — NOT a flat body. Posting
  // flat silently creates an empty record, which made every "explicit value"
  // assertion below look like an implementation bug on the first run.
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values,
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json() as { id: string; values: Record<string, unknown> };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'field-defaults');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Defaults Co' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Tasks',
    })
  ).json().id;
});

afterAll(async () => {
  await app?.close();
});

describe('checkbox default (#203)', () => {
  it('applies to a new record, and an explicit false still wins', async () => {
    const field = await addField('Done', 'checkbox', { default: true });

    const defaulted = await createRecord({ name: 'Uses the default' });
    expect(defaulted.values[field.apiName]).toBe(true);

    // The user deliberately unchecked it — the server must not "helpfully" put
    // it back, or an unchecked record could never be created.
    const explicit = await createRecord({ name: 'Opted out', [field.apiName]: false });
    expect(explicit.values[field.apiName]).toBeFalsy();
  });

  it('a field with no default configured leaves the value alone', async () => {
    const field = await addField('Archived', 'checkbox', {});
    const record = await createRecord({ name: 'No default' });
    expect(record.values[field.apiName]).toBeFalsy();
  });
});

describe('date default (#203)', () => {
  it('stamps a date-only field with a bare YYYY-MM-DD', async () => {
    const field = await addField('Due', 'date', { default_today: true });
    const record = await createRecord({ name: 'Due today' });
    // Shape matters: a time smuggled into a date-only column changes how every
    // downstream formatter renders it.
    expect(record.values[field.apiName]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('stamps a date-time field with a full timestamp', async () => {
    const field = await addField('Started', 'date', { default_today: true, include_time: true });
    const record = await createRecord({ name: 'Started now' });
    expect(String(record.values[field.apiName])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('a caller-supplied date is never overwritten', async () => {
    const field = await addField('Planned', 'date', { default_today: true });
    const record = await createRecord({ name: 'Back-dated', [field.apiName]: '2020-01-01' });
    expect(record.values[field.apiName]).toBe('2020-01-01');
  });
});

describe('existing records and fields are unaffected (#203)', () => {
  it('adding a default to a field does not rewrite records already created', async () => {
    const field = await addField('Flagged', 'checkbox', {});
    const before = await createRecord({ name: 'Created before the default existed' });
    expect(before.values[field.apiName]).toBeFalsy();

    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${field.id}`, {
      config: { default: true },
    });

    // The default is for NEW records. A config change is not a data migration —
    // silently flipping historical rows would be a far worse surprise.
    const reread = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${before.id}`)
    ).json();
    expect(reread.values[field.apiName]).toBeFalsy();

    const after = await createRecord({ name: 'Created after' });
    expect(after.values[field.apiName]).toBe(true);
  });
});
