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

async function addOptionedField(
  name: string,
  type: 'select' | 'workflow',
  options: string[],
  config: Record<string, unknown> = {},
) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: name,
    type,
    config,
    options: options.map((label) => ({ label })),
  });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json() as { id: string; apiName: string; options: Array<{ id: string; label: string }> };
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

/**
 * #475 — Vera's exact reproduction: a select field with options and no
 * default let a record land with a null value, 201, no warning — invisible to
 * the standard `state has [<option>]` queue filter every agent runs, while
 * still visible to an unfiltered page-through. This suite proves both that
 * the bug reproduces without a default, and that configuring one closes it.
 */
describe('select/workflow default (#475)', () => {
  it('reproduction: with no default, a record created without the field is invisible to the queue filter', async () => {
    const field = await addOptionedField('State (undefaulted)', 'select', ['Backlog', 'ToDo', 'Done']);
    const todoId = field.options.find((o) => o.label === 'ToDo')!.id;

    const filed = await createRecord({ name: 'Filed with no state' });
    expect(filed.values[field.apiName]).toBeUndefined();
    const control = await createRecord({ name: 'Filed with a state', [field.apiName]: todoId });

    const queued = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: field.apiName, op: 'has', value: [todoId] },
    });
    const ids = queued.json().data.map((r: { id: string }) => r.id);
    expect(ids).toContain(control.id);
    expect(ids).not.toContain(filed.id);

    const unfiltered = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {});
    const allIds = unfiltered.json().data.map((r: { id: string }) => r.id);
    expect(allIds).toContain(filed.id);
  });

  it('a default configured at create time (by option label) fills a record filed with no value', async () => {
    const field = await addOptionedField('State (defaulted select)', 'select', ['Backlog', 'ToDo', 'Done'], {
      default: 'Backlog',
    });
    const backlogId = field.options.find((o) => o.label === 'Backlog')!.id;

    const filed = await createRecord({ name: 'Filed with no state' });
    expect(filed.values[field.apiName]).toBe(backlogId);

    // MUST KEEP WORKING: an explicit null is a deliberate "leave this empty"
    // and must survive — the server must not put the default back.
    const explicitNull = await createRecord({ name: 'Explicitly cleared', [field.apiName]: null });
    expect(explicitNull.values[field.apiName]).toBeFalsy();

    // Now findable by the exact filter shape every agent's queue runs.
    const queued = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: field.apiName, op: 'has', value: [backlogId] },
    });
    expect(queued.json().data.map((r: { id: string }) => r.id)).toContain(filed.id);
  });

  it('a workflow field defaults the same way as select', async () => {
    const field = await addOptionedField('Status', 'workflow', ['Triage', 'ToDo', 'Done'], { default: 'Triage' });
    const triageId = field.options.find((o) => o.label === 'Triage')!.id;
    const filed = await createRecord({ name: 'No status given' });
    expect(filed.values[field.apiName]).toBe(triageId);
  });

  it('create rejects a default label that does not match any of the field\'s own options', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Bad Default',
      type: 'select',
      config: { default: 'Nonexistent' },
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('configuring a default via PATCH (by option id) applies to records created afterward, never retroactively', async () => {
    const field = await addOptionedField('State (patched default)', 'select', ['Backlog', 'ToDo', 'Done']);
    const backlogId = field.options.find((o) => o.label === 'Backlog')!.id;
    const before = await createRecord({ name: 'Created before the default existed' });
    expect(before.values[field.apiName]).toBeUndefined();

    const patch = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${field.id}`, {
      config: { default: backlogId },
    });
    expect(patch.statusCode, patch.body).toBeLessThan(300);

    const reread = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${before.id}`)
    ).json();
    expect(reread.values[field.apiName]).toBeUndefined();

    const after = await createRecord({ name: 'Created after the default' });
    expect(after.values[field.apiName]).toBe(backlogId);
  });

  it('update rejects a default id that is not one of the field\'s own options', async () => {
    const field = await addOptionedField('State (rejects bad patch)', 'select', ['Backlog', 'ToDo']);
    const res = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${field.id}`, {
      config: { default: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('removing the option a field defaults to clears the dangling default rather than leaving it', async () => {
    const field = await addOptionedField('State (default removed)', 'select', ['Backlog', 'ToDo']);
    const backlog = field.options.find((o) => o.label === 'Backlog')!;
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${field.id}`, {
      config: { default: backlog.id },
    });

    const removed = await as(
      admin.token,
      'DELETE',
      `/workspaces/${wsId}/databases/${dbId}/fields/${field.id}/options/${backlog.id}`,
      { confirm: true },
    );
    expect(removed.statusCode, removed.body).toBeLessThan(300);

    // The default is gone, not dangling — a new record is filed with no value,
    // exactly as if no default had ever been configured, never an id that
    // resolves to nothing.
    const filed = await createRecord({ name: 'After the default option was removed' });
    expect(filed.values[field.apiName]).toBeUndefined();
  });
});
