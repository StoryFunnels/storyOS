import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { trackFormToken, liveFormUrl } from './helpers/form-token';

/**
 * #1088 — a record created with no value for a WORKFLOW field must start at that field's default: the configured one (#475's
 * `config.default`) or, when none, the first state. A new issue with an empty State is on no board column and in no queue.
 *
 * "Not given" vs "explicitly empty": the KEY. A create whose values do not contain the field's api_name was not given a value and
 * gets the default; one that contains it (`null`, or anything) was given one and is left exactly as given. That is the rule
 * `applyFieldDefaults` has always had for every type, and it is the same for REST, MCP (which is REST), forms and import.
 */
let app: NestFastifyApplication;
let token: string;
let ws: string;
const as = (method: string, url: string, payload?: unknown) => {
  const res = app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
  return res.then((r) => { trackFormToken(payload, r); return r; });
};
const pub = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${liveFormUrl(url)}`, payload: payload as never });

interface F { id: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> }
const fieldsOf = async (db: string) => ((await as('GET', `/workspaces/${ws}/databases/${db}`)).json().fields as F[]);
const labelOf = (f: F | undefined, id: unknown) => (id == null ? null : (f?.options?.find((o) => o.id === id)?.label ?? `?${String(id)}`));

async function newDb(name: string, workflowOptions: string[] | null = ['Triage', 'Backlog', 'Done']) {
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  if (workflowOptions) {
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'State', type: 'workflow', config: {}, options: workflowOptions.map((label) => ({ label })) });
    expect(res.statusCode, res.body).toBe(201);
  }
  await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Priority', type: 'select', config: {}, options: [{ label: 'Low' }, { label: 'High' }] });
  return db;
}
const create = async (db: string, values: Record<string, unknown>) => {
  const res = await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; values: Record<string, unknown> };
};

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'State Default')).token;
  ws = (await as('POST', '/workspaces', { name: 'State Default WS' })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1088 the Dev Project pack: everything lands in Triage', () => {
  it('a new issue created with only a name has State = Triage', async () => {
    const w = (await as('POST', '/workspaces', { name: 'Dev pack WS' })).json().id as string;
    const applied = await as('POST', `/workspaces/${w}/templates/dev-project/apply`, {});
    expect(applied.statusCode, applied.body).toBe(201);
    const issues = applied.json().databases['issues'] as string;
    const f = ((await as('GET', `/workspaces/${w}/databases/${issues}`)).json().fields as F[]);
    const state = f.find((x) => x.apiName === 'state')!;
    const res = await as('POST', `/workspaces/${w}/databases/${issues}/records`, { values: { name: 'Fresh issue' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(labelOf(state, res.json().values['state']), `State of a new issue; the pack guide says "Everything lands in Triage"`).toBe('Triage');
  });
});

describe('#1088 the fallback: no configured default means the first state', () => {
  it('REST create, REST batch create and the first-option ORDER (position, not name)', async () => {
    const db = await newDb('Fallback', ['Zeta first', 'Alpha second', 'Done']);
    const f = await fieldsOf(db);
    const state = f.find((x) => x.apiName === 'state')!;
    const one = await create(db, { name: 'one' });
    expect(labelOf(state, one.values['state'])).toBe('Zeta first');
    const batch = await as('POST', `/workspaces/${ws}/databases/${db}/records/batch`, { records: [{ values: { name: 'a' } }, { values: { name: 'b' } }] });
    expect(batch.statusCode, batch.body).toBe(201);
    for (const r of batch.json().data as Array<{ values: Record<string, unknown> }>) expect(labelOf(state, r.values['state'])).toBe('Zeta first');
  });

  it('a configured default (#475) still wins over the first state', async () => {
    const db = await newDb('Configured');
    const state = (await fieldsOf(db)).find((x) => x.apiName === 'state')!;
    const backlog = state.options!.find((o) => o.label === 'Backlog')!.id;
    expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${state.id}`, { config: { default: backlog } })).statusCode).toBeLessThan(300);
    expect(labelOf(state, (await create(db, { name: 'x' })).values['state'])).toBe('Backlog');
  });

  it('a plain SELECT is never auto-filled: an empty Priority is a legitimate answer', async () => {
    const db = await newDb('Plain select');
    const r = await create(db, { name: 'x' });
    expect(r.values['priority'] ?? null).toBeNull();
  });

  it('a workflow field with no options at all has nothing to default to, and a create still works', async () => {
    const db = await newDb('No options', []);
    const r = await create(db, { name: 'x' });
    expect(r.values['state'] ?? null).toBeNull();
  });
});

describe('#1088 explicitly empty is respected: the key being present is what says so', () => {
  it('state: null stays empty, an explicit state is kept, and a batch row can differ from its neighbour', async () => {
    const db = await newDb('Explicit');
    const state = (await fieldsOf(db)).find((x) => x.apiName === 'state')!;
    expect((await create(db, { name: 'cleared', state: null })).values['state'] ?? null, 'explicit null = leave empty').toBeNull();
    const doneId = state.options!.find((o) => o.label === 'Done')!.id;
    expect(labelOf(state, (await create(db, { name: 'chosen', state: doneId })).values['state'])).toBe('Done');
    const batch = await as('POST', `/workspaces/${ws}/databases/${db}/records/batch`, { records: [{ values: { name: 'p', state: null } }, { values: { name: 'q' } }] });
    const [p, q] = batch.json().data as Array<{ values: Record<string, unknown> }>;
    expect(p!.values['state'] ?? null).toBeNull();
    expect(labelOf(state, q!.values['state'])).toBe('Triage');
  });
});

describe('#1088 existing records are not backfilled', () => {
  it('an empty-state record stays empty when edited, and a later default change does not touch it', async () => {
    const db = await newDb('Backfill');
    const state = (await fieldsOf(db)).find((x) => x.apiName === 'state')!;
    const old = await create(db, { name: 'legacy', state: null });
    expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/records/${old.id}`, { values: { name: 'legacy edited' } })).statusCode).toBe(200);
    const done = state.options!.find((o) => o.label === 'Done')!.id;
    await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${state.id}`, { config: { default: done } });
    const after = (await as('GET', `/workspaces/${ws}/databases/${db}/records/${old.id}`)).json();
    expect(after.values['state'] ?? null, 'an UPDATE never applies defaults').toBeNull();
  });
});

describe('#1088 every create path: forms and CSV import', () => {
  it('a public form submit that does not include State lands in the default', async () => {
    const db = await newDb('Form path');
    const f = await fieldsOf(db);
    const state = f.find((x) => x.apiName === 'state')!;
    const nameId = f.find((x) => x.type === 'title' || x.apiName === 'name')!.id;
    const made = await as('POST', `/workspaces/${ws}/databases/${db}/views`, {
      name: 'Intake', type: 'form',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {}, form: { title: 'Intake', access: 'public', public_token: 'tok-1088', fields: [{ field_id: nameId, required: true }] } },
    });
    expect(made.statusCode, made.body).toBe(201);
    const sub = await pub('POST', '/public/forms/tok-1088', { values: { name: 'From the form' } });
    expect(sub.statusCode, sub.body).toBe(201);
    const rows = (await as('POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 10 })).json().data as Array<{ title: string; values: Record<string, unknown> }>;
    const row = rows.find((r) => r.title === 'From the form')!;
    expect(labelOf(state, row.values['state'])).toBe('Triage');
  });

  it('a CSV import with no State column lands every row in the default', async () => {
    const db = await newDb('Import path');
    const state = (await fieldsOf(db)).find((x) => x.apiName === 'state')!;
    const boundary = 'b1088';
    const csv = 'Name\nrow one\nrow two';
    const payload = [`--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify([{ column: 'Name', to: { kind: 'title' } }])}\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\nfalse\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`].join('');
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/databases/${db}/import`, headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const rows = (await as('POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 10 })).json().data as Array<{ values: Record<string, unknown> }>;
    expect(rows.length).toBe(2);
    for (const r of rows) expect(labelOf(state, r.values['state'])).toBe('Triage');
  });
});
