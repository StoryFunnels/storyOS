import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { trackFormToken, liveFormUrl } from './helpers/form-token';
import { PACK_REGISTRY } from '../src/packs/registry';
import { AutomationsService } from '../src/automations/automations.service';

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

interface F { id: string; apiName: string; displayName?: string; type: string; options?: Array<{ id: string; label: string; position?: number; category?: string | null }> }
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

describe('#1088 the Dev Project template: everything lands in Triage', () => {
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

/**
 * ticket #1325 - the REAL packs. Every built-in pack declares its state as a `select` whose options carry categories (not a `workflow`), so
 * the #1088 default (workflow only) never reached a pack-made database. The case above applies a template with a workflow field of its own: a
 * fixture that is a prefix of reality, green while every pack shipped an empty State.
 *
 * This walks PACK_REGISTRY itself, so a pack added tomorrow is covered with no edit here. Each pack is installed (the real install path, a
 * workspace of its own) and, in every database it made, a record created with only a name is read back against the pack's OWN fields:
 *   - a `workflow` field, or a `select` whose options carry a category, must start at its first state;
 *   - a `select` with no categorised option (Priority, Type) must stay empty;
 *   - an explicit null on the state still wins.
 */
const isStateField = (f: F) => f.type === 'workflow' || (f.type === 'select' && (f.options ?? []).some((o) => o.category != null));
/** The first state, read from the stored options themselves (not from the helper under test): lowest position among the categorised ones. */
const firstStateOf = (f: F) => [...(f.options ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).find((o) => f.type === 'workflow' || o.category != null)!;
const packsWithStates = new Map<string, Array<{ db: string; field: string; first: string }>>();
describe('#1325 every built-in pack: a new record lands in its first state', () => {
  it.each(PACK_REGISTRY.map((p) => [p.slug] as const))('%s', async (slug) => {
    const w = (await as('POST', '/workspaces', { name: `Pack ${slug}` })).json().id as string;
    const entry = PACK_REGISTRY.find((p) => p.slug === slug)!;
    const requires = ((entry.manifest.requires as { packs?: Array<{ pack: string }> }).packs ?? []);
    const installed = await as('POST', `/workspaces/${w}/packs/install`, {
      manifest: entry.manifest,
      required_packs: Object.fromEntries(requires.map((r) => [r.pack, 'create_here'])),
    });
    expect(installed.statusCode, installed.body).toBe(201);
    const dbs = ((await as('GET', `/workspaces/${w}/databases`)).json() as Array<{ id: string; name: string; isSystem?: boolean }>).filter((d) => d.name !== 'Members' && !d.isSystem);
    const found: Array<{ db: string; field: string; first: string }> = [];
    for (const d of dbs) {
      const fields = (await as('GET', `/workspaces/${w}/databases/${d.id}`)).json().fields as F[];
      const states = fields.filter(isStateField);
      const plainSelects = fields.filter((f) => f.type === 'select' && !isStateField(f));
      const res = await as('POST', `/workspaces/${w}/databases/${d.id}/records`, { values: { name: `new ${d.name}` } });
      expect(res.statusCode, `${slug}/${d.name}: ${res.body}`).toBe(201);
      for (const f of states) {
        const first = firstStateOf(f);
        expect(labelOf(f, res.json().values[f.apiName]), `${slug}: ${d.name}.${f.displayName} of a record created with only a name`).toBe(first.label);
        found.push({ db: d.name, field: f.displayName ?? f.apiName, first: first.label });
      }
      for (const f of plainSelects) {
        expect(res.json().values[f.apiName] ?? null, `${slug}: ${d.name}.${f.displayName} has no categories, so it stays empty`).toBeNull();
      }
      // an explicit empty still wins on the very same database
      if (states.length) {
        const cleared = await as('POST', `/workspaces/${w}/databases/${d.id}/records`, { values: { name: `cleared ${d.name}`, [states[0]!.apiName]: null } });
        expect(cleared.statusCode, cleared.body).toBe(201);
        expect(cleared.json().values[states[0]!.apiName] ?? null, `${slug}: ${d.name} explicit null`).toBeNull();
      }
    }
    packsWithStates.set(slug, found);
  }, 60_000);

  // The pack list is whatever the registry holds; this pins that the loop above was not vacuous, by NAME, for the packs the ticket names.
  it('the walk really saw Dev Tracker, Team Board and Team Wiki states (not an empty loop)', () => {
    const seen = (slug: string) => (packsWithStates.get(slug) ?? []).map((s) => `${s.db}.${s.field}=${s.first}`);
    expect(seen('dev-tracker')).toEqual(expect.arrayContaining(['Issues.State=Triage']));
    expect(seen('team-board')).toEqual(expect.arrayContaining(['Tasks.Status=To Do']));
    expect(seen('team-wiki')).toEqual(expect.arrayContaining(['Pages.Status=Draft']));
    expect([...packsWithStates.values()].flat().length, 'at least the five state fields the ticket lists').toBeGreaterThanOrEqual(5);
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

  // #1087 means a workflow field can no longer be created with zero options (it starts as To do / In progress / Done), so "a field with
  // nothing to default to" is not reachable through the API; the resolver's empty-options case is covered in field-defaults.unit.test.ts.
  // What IS reachable, and worth pinning, is the two changes together: a brand-new status field and the first record created in it.
  it('a workflow field created with no options starts as To do / In progress / Done, and the first record lands in To do (#1087 + #1088)', async () => {
    const db = await newDb('No options given', []);
    const state = (await fieldsOf(db)).find((x) => x.apiName === 'state')!;
    expect(state.options!.map((o) => o.label)).toEqual(['To do', 'In progress', 'Done']);
    const r = await create(db, { name: 'x' });
    expect(labelOf(state, r.values['state'])).toBe('To do');
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

/**
 * ticket #1325 - a `select` whose options carry state categories is a state: it starts at its first categorised option, on every path that
 * creates a record (they all go through RecordsService.createBatch, so each is pinned here rather than assumed). A select without any
 * category is NOT a state and stays empty, a configured default wins, and explicit null wins: the same three rules #1088 set for workflow.
 */
async function newCatDb(name: string, status: Array<{ label: string; category?: string }> = [{ label: 'Triage', category: 'backlog' }, { label: 'Doing', category: 'started' }, { label: 'Done', category: 'completed' }]) {
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  const made = await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Status', type: 'select', config: {}, options: status });
  expect(made.statusCode, made.body).toBe(201);
  // an ordinary select beside it, no categories: must never be filled
  const type = await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Type', type: 'select', config: {}, options: [{ label: 'Bug' }, { label: 'Chore' }] });
  expect(type.statusCode, type.body).toBe(201);
  return db;
}
const statusOf = async (db: string) => (await fieldsOf(db)).find((x) => x.apiName === 'status')!;
const rowsOf = async (db: string) => (await as('POST', `/workspaces/${ws}/databases/${db}/records/query`, { limit: 50 })).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;

describe('#1325 a categorised select starts at its first state', () => {
  it('REST create and batch land in the first categorised option; the uncategorised select beside it stays empty', async () => {
    const db = await newCatDb('Cat select');
    const status = await statusOf(db);
    const one = await create(db, { name: 'one' });
    expect(labelOf(status, one.values['status'])).toBe('Triage');
    expect(one.values['type'] ?? null, 'Type has no categories: not a state, not filled').toBeNull();
    const batch = await as('POST', `/workspaces/${ws}/databases/${db}/records/batch`, { records: [{ values: { name: 'a' } }, { values: { name: 'b', status: null } }] });
    expect(batch.statusCode, batch.body).toBe(201);
    const [a, b] = batch.json().data as Array<{ values: Record<string, unknown> }>;
    expect(labelOf(status, a!.values['status'])).toBe('Triage');
    expect(b!.values['status'] ?? null, 'explicit null in the same batch still wins').toBeNull();
  });

  it('"first" is the lowest-ordered CATEGORISED option, not the lowest option', async () => {
    const db = await newCatDb('Partial', [{ label: 'Misc' }, { label: 'Todo', category: 'unstarted' }, { label: 'Done', category: 'completed' }]);
    const status = await statusOf(db);
    expect(labelOf(status, (await create(db, { name: 'x' })).values['status'])).toBe('Todo');
  });

  it('a select with NO categorised option is never filled: unconfigured is not invalid', async () => {
    const db = await newCatDb('No categories', [{ label: 'Alpha' }, { label: 'Beta' }]);
    const r = await create(db, { name: 'x' });
    expect(r.values['status'] ?? null).toBeNull();
    expect(r.values['type'] ?? null).toBeNull();
  });

  it('a configured default wins, an explicit value is kept, explicit null is kept', async () => {
    const db = await newCatDb('Configured cat');
    const status = await statusOf(db);
    const doing = status.options!.find((o) => o.label === 'Doing')!.id;
    const done = status.options!.find((o) => o.label === 'Done')!.id;
    expect(labelOf(status, (await create(db, { name: 'chosen', status: done })).values['status'])).toBe('Done');
    expect((await create(db, { name: 'cleared', status: null })).values['status'] ?? null).toBeNull();
    expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${status.id}`, { config: { default: doing } })).statusCode).toBeLessThan(300);
    expect(labelOf(status, (await create(db, { name: 'dflt' })).values['status'])).toBe('Doing');
  });

  it('existing records keep an empty Status: an edit does not fill it', async () => {
    const db = await newCatDb('No backfill cat');
    const old = await create(db, { name: 'legacy', status: null });
    expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/records/${old.id}`, { values: { name: 'legacy edited' } })).statusCode).toBe(200);
    const after = (await as('GET', `/workspaces/${ws}/databases/${db}/records/${old.id}`)).json();
    expect(after.values['status'] ?? null, 'an UPDATE never applies defaults').toBeNull();
  });
});

describe('#1325 every create path gets the categorised-select default', () => {
  it('duplicate: an empty source starts at the first state, a source with a state keeps it', async () => {
    const db = await newCatDb('Dup cat');
    const status = await statusOf(db);
    const done = status.options!.find((o) => o.label === 'Done')!.id;
    const empty = await create(db, { name: 'empty', status: null });
    const full = await create(db, { name: 'full', status: done });
    const dupEmpty = await as('POST', `/workspaces/${ws}/databases/${db}/records/${empty.id}/duplicate`);
    expect(dupEmpty.statusCode, dupEmpty.body).toBe(201);
    expect(labelOf(status, dupEmpty.json().values['status'])).toBe('Triage');
    const dupFull = await as('POST', `/workspaces/${ws}/databases/${db}/records/${full.id}/duplicate`);
    expect(labelOf(status, dupFull.json().values['status'])).toBe('Done');
  });

  it('a record template without a Status preset starts at the first state; a preset wins', async () => {
    const db = await newCatDb('Template cat');
    const status = await statusOf(db);
    const done = status.options!.find((o) => o.label === 'Done')!.id;
    const bare = (await as('POST', `/workspaces/${ws}/databases/${db}/record-templates`, { name: 'Bare', values: {} })).json();
    const preset = (await as('POST', `/workspaces/${ws}/databases/${db}/record-templates`, { name: 'Preset', values: { status: done } })).json();
    const a = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${bare.id}/records`, { values: { name: 'from bare' } });
    expect(a.statusCode, a.body).toBe(201);
    expect(labelOf(status, a.json().record.values['status'])).toBe('Triage');
    const b = await as('POST', `/workspaces/${ws}/databases/${db}/record-templates/${preset.id}/records`, { values: { name: 'from preset' } });
    expect(labelOf(status, b.json().record.values['status'])).toBe('Done');
  });

  it('a public form submit that does not include Status lands in the first state', async () => {
    const db = await newCatDb('Form cat');
    const f = await fieldsOf(db);
    const status = await statusOf(db);
    const nameId = f.find((x) => x.type === 'title' || x.apiName === 'name')!.id;
    const made = await as('POST', `/workspaces/${ws}/databases/${db}/views`, {
      name: 'Intake', type: 'form',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {}, form: { title: 'Intake', access: 'public', public_token: 'tok-1325', fields: [{ field_id: nameId, required: true }] } },
    });
    expect(made.statusCode, made.body).toBe(201);
    const sub = await pub('POST', '/public/forms/tok-1325', { values: { name: 'From the form' } });
    expect(sub.statusCode, sub.body).toBe(201);
    expect(labelOf(status, (await rowsOf(db)).find((r) => r.title === 'From the form')!.values['status'])).toBe('Triage');
  });

  it('a CSV import with no Status column lands every row in the first state', async () => {
    const db = await newCatDb('Import cat');
    const status = await statusOf(db);
    const boundary = 'b1325';
    const csv = 'Name\nrow one\nrow two';
    const payload = [`--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify([{ column: 'Name', to: { kind: 'title' } }])}\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\nfalse\r\n`, `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`].join('');
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/databases/${db}/import`, headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const rows = await rowsOf(db);
    expect(rows.length).toBe(2);
    for (const r of rows) expect(labelOf(status, r.values['status'])).toBe('Triage');
  });

  it('an automation create_record action (no Status in its values) starts the record at the first state', async () => {
    const target = await newCatDb('Automation target cat');
    const status = await statusOf(target);
    const src = await newDb('Automation source', null);
    const rule = await as('POST', `/workspaces/${ws}/databases/${src}/automations`, {
      name: 'File one', trigger: { type: 'record_created' }, actions: [{ type: 'create_record', database_id: target, values: { name: 'Filed by rule' } }],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const trigger = await create(src, { name: 'go' });
    await app.get(AutomationsService).settle(trigger.id);
    let filed: Array<{ title: string; values: Record<string, unknown> }> = [];
    for (let i = 0; i < 40 && !filed.length; i++) {
      filed = (await rowsOf(target)).filter((r) => r.title === 'Filed by rule');
      if (!filed.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(filed, 'the rule created its record').toHaveLength(1);
    expect(labelOf(status, filed[0]!.values['status'])).toBe('Triage');
  });
});
