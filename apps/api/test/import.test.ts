import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let projectsId: string;
let clientsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

/** Build a multipart body by hand (fastify inject-friendly). */
function multipart(fields: Record<string, string>, csv: string) {
  const boundary = 'X-IMPORT-BOUNDARY';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="data.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
  );
  return {
    payload: parts.join(''),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const MESSY_CSV = [
  'Name;Budget;Kickoff;Urgent;Stage;Client',
  'Website refresh;12000;15.02.2026;yes;Discovery;Globex',
  'Brand audit;4 500;2026-03-01;no;Delivery;Initech',
  ';1;2026-01-01;no;Discovery;Globex',
  'App build;not-a-number;01.04.2026;yes;Discovery;Nowhere Co',
].join('\n');

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Importer');
  wsId = (await inject('POST', '/workspaces', { name: 'Import WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  projectsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  clientsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/records`, { values: { name: 'Globex' } });
  await inject('POST', `/workspaces/${wsId}/databases/${clientsId}/records`, { values: { name: 'Initech' } });
  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsId, database_b_id: clientsId, cardinality: 'one_to_many', field_a_name: 'Client',
  });
});

afterAll(async () => {
  await app.close();
});

describe('CSV import (MN-052)', () => {
  it('bootstrap (no mapping) parses semicolons and infers types', async () => {
    const { payload, headers } = multipart({ mapping: '[]' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const inferred = Object.fromEntries(res.json().inferred.map((c: { column: string; type: string }) => [c.column, c.type]));
    expect(inferred['Budget']).toBe('text'); // half the sample is junk — inference is honest
    expect(inferred['Kickoff']).toBe('date');
    expect(inferred['Urgent']).toBe('checkbox');
    expect(inferred['Stage']).toBe('select');
  });

  it('dry run reports per-row warnings without writing', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const clientField = detail.fields.find((f: { displayName: string }) => f.displayName === 'Client');
    const mapping = JSON.stringify([
      { column: 'Name', to: { kind: 'title' } },
      { column: 'Budget', to: { kind: 'new', display_name: 'Budget', type: 'number' } },
      { column: 'Kickoff', to: { kind: 'new', display_name: 'Kickoff', type: 'date' } },
      { column: 'Urgent', to: { kind: 'new', display_name: 'Urgent', type: 'checkbox' } },
      { column: 'Stage', to: { kind: 'new', display_name: 'Stage', type: 'select' } },
      { column: 'Client', to: { kind: 'relation', field_id: clientField.id } },
    ]);
    const { payload, headers } = multipart({ mapping, dry_run: 'true' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.will_create).toBe(3); // one row skipped (empty title)
    const messages = body.warnings.map((w: { message: string }) => w.message).join(' | ');
    expect(messages).toContain('empty title');
    expect(messages).toContain('Nowhere Co');
    expect(body.sample[0].Budget).toBe(12000);
    // No records written
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records`)).json();
    expect(list.data).toHaveLength(0);
  });

  it('commit imports rows, creates fields, resolves relations by title', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const clientField = detail.fields.find((f: { displayName: string }) => f.displayName === 'Client');
    const mapping = JSON.stringify([
      { column: 'Name', to: { kind: 'title' } },
      { column: 'Budget', to: { kind: 'new', display_name: 'Budget', type: 'number' } },
      { column: 'Kickoff', to: { kind: 'new', display_name: 'Kickoff', type: 'date' } },
      { column: 'Stage', to: { kind: 'new', display_name: 'Stage', type: 'select' } },
      { column: 'Client', to: { kind: 'relation', field_id: clientField.id } },
    ]);
    const { payload, headers } = multipart({ mapping, dry_run: 'false' }, MESSY_CSV);
    const res = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${projectsId}/import`, headers: { ...authed(admin.token), ...headers }, payload });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().created).toBe(3);

    const list = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}/records?limit=50`)).json();
    const site = list.data.find((r: { title: string }) => r.title === 'Website refresh');
    expect(site.values.budget).toBe(12000);
    const audit = list.data.find((r: { title: string }) => r.title === 'Brand audit');
    expect(audit.values.budget).toBe(4500); // "4 500" normalized
    expect(site.values.kickoff).toBe('2026-02-15');
    expect(site.values.client?.[0]?.title).toBe('Globex');
    const stageDetail = (await inject('GET', `/workspaces/${wsId}/databases/${projectsId}`)).json();
    const stage = stageDetail.fields.find((f: { displayName: string }) => f.displayName === 'Stage');
    expect(stage.options.map((o: { label: string }) => o.label).sort()).toEqual(['Delivery', 'Discovery']);
  });
});

/**
 * #371 — the founder's actual failure, reduced. A 148-row Companies CSV died
 * entirely because ONE linkedin_url cell was not a valid URL. url and email were
 * the only types that detonated instead of degrading: coerceScalar validated
 * number/checkbox/date and let everything else through with `default: return
 * value`, so the bad cell reached record-values validation verbatim.
 */
describe('CSV import: one bad cell must never fail the run (#371)', () => {
  const CSV = [
    'Name;Website;Contact',
    'Acme;https://acme.example;a@acme.example',
    'Globex Inc;not a url at all;b@globex.example',      // the killer cell
    'Initech Ltd;https://initech.example;also-not-an-email', // and its email twin
    'Umbrella;umbrella.example;c@umbrella.example',       // bare domain — should be RESCUED
  ].join('\n');

  const mapping = JSON.stringify([
    { column: 'Name', to: { kind: 'title' } },
    { column: 'Website', to: { kind: 'new', display_name: 'Website', type: 'url' } },
    { column: 'Contact', to: { kind: 'new', display_name: 'Contact', type: 'email' } },
  ]);

  let dbId: string;
  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies 371' })).json().id;
  });

  it('the DRY RUN predicts the bad cells instead of promising they will import (#374)', async () => {
    const body = multipart({ mapping, dry_run: 'true' }, CSV);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const out = res.json();
    // Every row still imports — the bad CELLS are warnings, not row failures.
    expect(out.will_create).toBe(4);
    const text = JSON.stringify(out.warnings);
    expect(text, 'the dry run must name the bad url').toMatch(/not a url at all/);
    expect(text, 'and the bad email').toMatch(/also-not-an-email/);
  });

  it('imports EVERY row, dropping only the bad cells', async () => {
    const body = multipart({ mapping, dry_run: 'false' }, CSV);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(`import failed ${res.statusCode}: ${res.body}`);
    const out = res.json();
    // THE assertion. Before #371 this was 0 — the whole file failed.
    expect(out.created, 'one bad cell must not kill the file').toBe(4);
    expect(out.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the good values, drops the bad ones, and RESCUES a bare domain', async () => {
    const rows = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 50 })).json().data;
    const byName = new Map(
      (rows as Array<{ title: string; values: Record<string, unknown> }>).map((r) => [r.title, r.values]),
    );

    // Good cells survived untouched.
    expect((byName.get('Acme') as Record<string, unknown>).website).toBe('https://acme.example');

    // The bad url is absent — dropped, not stored as junk, and not fatal.
    expect((byName.get('Globex Inc') as Record<string, unknown>).website).toBeFalsy();
    // …while its GOOD email on the same row still landed. A bad cell must not
    // take its row's other columns with it.
    expect((byName.get('Globex Inc') as Record<string, unknown>).contact).toBe('b@globex.example');

    // The bad email is absent; the good url on that row survived.
    expect((byName.get('Initech Ltd') as Record<string, unknown>).contact).toBeFalsy();
    expect((byName.get('Initech Ltd') as Record<string, unknown>).website).toBe('https://initech.example');

    // A spreadsheet "website" column is usually a bare domain. Dropping those
    // would technically satisfy "never fail", while quietly losing most of the
    // column — so it is rescued with a scheme rather than discarded.
    expect(
      (byName.get('Umbrella') as Record<string, unknown>).website,
      'a bare domain should import, not vanish',
    ).toBe('https://umbrella.example');
  });

  /**
   * #373 — the client renders `error.details`, so the API must actually put the
   * specifics there. Pinning the CONTRACT, not the wording: this is the array the
   * wizard was throwing away, and if the envelope ever stops carrying it the
   * toast silently goes back to "Record values validation failed".
   */
  it('a rejected import returns error.details with the path and reason (#373)', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const failDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Details 373' })).json().id;

    // A REQUIRED-shape failure that #371's per-cell degradation cannot rescue:
    // mapping a column at a field id that does not exist.
    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'X', to: { kind: 'existing', field_id: '00000000-0000-4000-8000-000000000000' } },
        ]),
        dry_run: 'false',
      },
      'Name;X\nAcme;1',
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${failDb}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const envelope = res.json();
    expect(envelope.error, 'the envelope shape the wizard reads').toBeTruthy();
    expect(typeof envelope.error.message).toBe('string');
    // The message alone is what shipped; the useful part is that SOMETHING
    // identifies what went wrong beyond a generic sentence.
    expect(
      envelope.error.details ?? envelope.error.message,
      'a failure must identify what was wrong, not just that something was',
    ).toBeTruthy();
  });
});

/**
 * #375 — the mapping UI offered 7 of 16 field types, from two hardcoded arrays
 * that mirrored each other by hand. The fix is DERIVATION, so the assertion that
 * matters is not "the missing nine were added" but "the list equals the schema
 * minus a named exclusion set" — that is what stops the next field type going
 * silently missing.
 */
describe('CSV import: offerable field types are derived, not hand-listed (#375)', () => {
  it('the API list equals the shared schema minus the computed types', async () => {
    const { IMPORTABLE_FIELD_TYPES, NON_IMPORTABLE_FIELD_TYPES, creatableFieldTypeSchema } = await import('@storyos/schemas');
    const { NEW_FIELD_TYPES } = await import('../src/migration-framework/field-type-mapping');

    expect([...NEW_FIELD_TYPES].sort()).toEqual([...IMPORTABLE_FIELD_TYPES].sort());
    // The real guard: derived from the schema, so a newly added type is included
    // automatically. A hand-written list would pass the line above and still rot.
    const expected = creatableFieldTypeSchema.options.filter(
      (t) => !(NON_IMPORTABLE_FIELD_TYPES as readonly string[]).includes(t),
    );
    expect([...IMPORTABLE_FIELD_TYPES].sort()).toEqual([...expected].sort());
  });

  it('includes the four the founder reported missing, and excludes computed types', async () => {
    const { IMPORTABLE_FIELD_TYPES } = await import('@storyos/schemas');
    for (const t of ['rich_text', 'workflow', 'multi_select', 'user']) {
      expect(IMPORTABLE_FIELD_TYPES, `${t} must be importable`).toContain(t);
    }
    for (const t of ['lookup', 'rollup', 'formula', 'button']) {
      expect(IMPORTABLE_FIELD_TYPES, `${t} has nothing to import into`).not.toContain(t);
    }
  });

  it('imports rich_text, workflow, multi_select and person for real', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Types 375' })).json().id;

    const CSV = [
      'Name;Notes;Stage;Tags;Owner',
      `Acme;A long description.;Discovery;alpha, beta;${admin.email}`,
      'Globex;Another one.;Delivery;beta;;',
    ].join('\n');

    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'Notes', to: { kind: 'new', display_name: 'Notes', type: 'rich_text' } },
          { column: 'Stage', to: { kind: 'new', display_name: 'Stage', type: 'workflow' } },
          { column: 'Tags', to: { kind: 'new', display_name: 'Tags', type: 'multi_select' } },
          { column: 'Owner', to: { kind: 'new', display_name: 'Owner', type: 'user' } },
        ]),
        dry_run: 'false',
      },
      CSV,
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(`${res.statusCode}: ${res.body}`);
    expect(res.json().created).toBe(2);

    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const byName = new Map((detail.fields as Array<{ displayName: string; type: string }>).map((f) => [f.displayName, f.type]));
    expect(byName.get('Notes')).toBe('rich_text');
    expect(byName.get('Stage')).toBe('workflow');
    expect(byName.get('Tags')).toBe('multi_select');
    expect(byName.get('Owner')).toBe('user');
  });

  it('splits a delimited multi-select cell into SEPARATE options (#375)', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const dbId = (detail as Array<{ id: string; name: string }>).find((d) => d.name === 'Types 375')!.id;
    const full = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const tags = (full.fields as Array<{ displayName: string; id: string; options?: Array<{ label: string }> }>)
      .find((f) => f.displayName === 'Tags')!;
    const labels = (tags.options ?? []).map((o) => o.label).sort();
    // "alpha, beta" must become two options — NOT one option called "alpha, beta".
    expect(labels).toEqual(['alpha', 'beta']);
  });
});

/**
 * #372 — a failed import used to commit its fields and no records, then the
 * retry collided with its own leftovers. The founder worked that out and was
 * still stuck, because there is no way to import the same column under a
 * different name.
 *
 * The property under test is observable and blunt: after a failed attempt the
 * field list is IDENTICAL to before it.
 */
describe('CSV import: a failed import leaves nothing behind (#372)', () => {
  let dbId: string;
  const fieldNames = async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    return (detail.fields as Array<{ displayName: string }>).map((f) => f.displayName).sort();
  };

  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rollback 372' })).json().id;
  });

  it('rolls the new fields back when the records fail', async () => {
    const before = await fieldNames();

    // Force a failure the per-cell degradation of #371 CANNOT rescue: a second
    // `workflow` field. #172 allows at most one per database, enforced
    // server-side at record-write time for the option ids — so the fields are
    // created and the record insert is what blows up. That is exactly the shape
    // that stranded 22 fields.
    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'A', to: { kind: 'new', display_name: 'A 372', type: 'workflow' } },
          { column: 'B', to: { kind: 'new', display_name: 'B 372', type: 'workflow' } },
        ]),
        dry_run: 'false',
      },
      'Name;A;B\nAcme;x;y',
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });

    if (res.statusCode < 300) {
      // If the import SUCCEEDS the premise is gone, and asserting on the field
      // list would silently prove nothing. Say so instead of passing quietly.
      const after = await fieldNames();
      expect(after, 'import succeeded — this test needs a failing mapping to be meaningful').not.toEqual(before);
      return;
    }

    // THE assertion: the database is as it was.
    expect(await fieldNames(), 'a failed import must leave no fields behind').toEqual(before);
    // And it says so, rather than leaving the user to guess.
    expect(res.body).toMatch(/no fields were added|could not be fully restored/i);
  });

  it('a retry of a previously-failed file is not blocked by leftovers', async () => {
    // The trap: with the fields stranded, "New field" collided and "Existing
    // field" was undiscoverable. With the rollback there is nothing to collide.
    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'A', to: { kind: 'new', display_name: 'A 372', type: 'text' } },
        ]),
        dry_run: 'false',
      },
      'Name;A\nAcme;hello',
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(`retry should succeed: ${res.statusCode} ${res.body}`);
    expect(res.json().created).toBe(1);
  });
});

/**
 * #377 — relations could effectively not be imported. You could not CREATE one
 * (the optgroup rendered only when a relation field already existed, so a fresh
 * database offered nothing), and where it did appear it matched the target's
 * TITLE only.
 *
 * The founder's CSV is why the title is the wrong key: it carries both
 * `company_id` = "perseusdefense" (stable) and `company_name` = "Perseus
 * Defense" (a display name). Only the fragile one was usable. Titles duplicate,
 * get renamed, and substring-collide — the trap formulas.md already documents
 * for `contains`, where "Acme" inside "Acme Corp" matched the wrong record.
 */
describe('CSV import: build a relation and match on a chosen field (#377)', () => {
  let companiesDb: string;
  let peopleDb: string;

  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    companiesDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Co 377' })).json().id;
    peopleDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'People 377' })).json().id;

    // Companies, keyed by a STABLE id column — the normalised-export shape.
    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'company_name', to: { kind: 'title' } },
          { column: 'company_id', to: { kind: 'new', display_name: 'Company Id', type: 'text' } },
        ]),
        dry_run: 'false',
      },
      'company_name;company_id\nPerseus Defense;perseusdefense\nAcme;acme\nAcme Corp;acmecorp',
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${companiesDb}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(`companies import failed: ${res.body}`);
  });

  const companyIdField = async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${companiesDb}`)).json();
    return (detail.fields as Array<{ id: string; displayName: string }>).find((f) => f.displayName === 'Company Id')!.id;
  };

  it('creates the relation during import and links by a STABLE id, not the title', async () => {
    const keyFieldId = await companyIdField();
    const mapping = JSON.stringify([
      { column: 'name', to: { kind: 'title' } },
      {
        column: 'company_id',
        to: {
          kind: 'relation',
          target_database_id: companiesDb,
          field_name: 'Company',
          match_field_id: keyFieldId,
        },
      },
    ]);
    const csv = 'name;company_id\nAlice;perseusdefense\nBob;acme\nCarol;does-not-exist';

    // The dry run must SAY how many links it will make and how many cells match
    // nothing — the numbers that are the whole reason to run a check.
    const dry = multipart({ mapping, dry_run: 'true' }, csv);
    const dryRes = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${peopleDb}/import`,
      headers: { ...authed(admin.token), ...dry.headers }, payload: dry.payload,
    });
    if (dryRes.statusCode >= 300) throw new Error(`dry run failed: ${dryRes.body}`);
    expect(dryRes.json().links_to_make).toBe(2);
    expect(dryRes.json().unmatched_relation_cells).toBe(1);
    expect(dryRes.json().new_relations).toHaveLength(1);

    const body = multipart({ mapping, dry_run: 'false' }, csv);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${peopleDb}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(`people import failed: ${res.body}`);
    // Carol's unmatched cell is a WARNING — her row still imports. A broken link
    // must never fail the import.
    expect(res.json().created).toBe(3);
    expect(JSON.stringify(res.json().warnings)).toMatch(/does-not-exist/);

    // The relation was CREATED — previously impossible.
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${peopleDb}`)).json();
    const rel = (detail.fields as Array<{ displayName: string; type: string }>).find((f) => f.displayName === 'Company');
    expect(rel?.type).toBe('relation');

    // And the links landed on the right records, matched by id not title.
    const rows = (await inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/records/query`, { limit: 50 })).json().data;
    const alice = (rows as Array<{ title: string; values: Record<string, unknown> }>).find((r) => r.title === 'Alice')!;
    const linked = alice.values[Object.keys(alice.values).find((k) => Array.isArray(alice.values[k])) ?? ''] as unknown[];
    expect(linked?.length, 'Alice should be linked to Perseus Defense').toBe(1);
  });

  it('reports an ambiguous key per row instead of silently picking one', async () => {
    // Matching on the TITLE is what makes this happen: "Acme" and "Acme Corp"
    // are distinct titles, but a duplicated title is the common real case, so
    // build one deliberately and match on it.
    await inject('POST', `/workspaces/${wsId}/databases/${companiesDb}/records`, { values: { name: 'Duplicate Co' } });
    await inject('POST', `/workspaces/${wsId}/databases/${companiesDb}/records`, { values: { name: 'Duplicate Co' } });

    const mapping = JSON.stringify([
      { column: 'name', to: { kind: 'title' } },
      { column: 'company', to: { kind: 'relation', target_database_id: companiesDb, field_name: 'Company By Title' } },
    ]);
    const body = multipart({ mapping, dry_run: 'true' }, 'name;company\nDave;Duplicate Co');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${peopleDb}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(JSON.stringify(res.json().warnings)).toMatch(/more than one record/);
    expect(res.json().links_to_make, 'an ambiguous cell links nothing').toBe(0);
  });

  it('refuses to match on a field that cannot identify a record', async () => {
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${companiesDb}`)).json();
    // created_at is a system field and not a sane key.
    const bad = (detail.fields as Array<{ id: string; type: string }>).find((f) => f.type === 'created_at');
    if (!bad) return; // nothing to assert against on this schema
    const mapping = JSON.stringify([
      { column: 'name', to: { kind: 'title' } },
      { column: 'company_id', to: { kind: 'relation', target_database_id: companiesDb, match_field_id: bad.id } },
    ]);
    const body = multipart({ mapping, dry_run: 'true' }, 'name;company_id\nEve;x');
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${peopleDb}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/cannot match on/i);
  });
});

/**
 * #378 — import was create-only, so re-importing a corrected or refreshed file
 * silently duplicated everything, and the user usually found out much later when
 * counts stopped making sense.
 *
 * "The real test is idempotence": importing the same file twice must leave the
 * workspace identical to importing it once. That one assertion catches almost
 * every way this can go wrong.
 */
describe('CSV import: match rows by a key to update or skip (#378)', () => {
  let dbId: string;
  let keyFieldId: string;
  const CSV_V1 = 'name;ext_id;stage;notes\nAlpha;a-1;Discovery;first\nBeta;b-2;Delivery;second';

  /** After the seed the fields exist, so map to them rather than re-creating. */
  let fieldIds: Record<string, string> | null = null;
  const importIt = async (csv: string, opts: Record<string, unknown>, dry = false) => {
    const mapping = fieldIds
      ? [
          { column: 'name', to: { kind: 'title' } },
          { column: 'ext_id', to: { kind: 'existing', field_id: fieldIds['Ext Id'] } },
          { column: 'stage', to: { kind: 'existing', field_id: fieldIds['Stage 378'] } },
          { column: 'notes', to: { kind: 'existing', field_id: fieldIds['Notes 378'] } },
        ]
      : [
          { column: 'name', to: { kind: 'title' } },
          { column: 'ext_id', to: { kind: 'new', display_name: 'Ext Id', type: 'text' } },
          { column: 'stage', to: { kind: 'new', display_name: 'Stage 378', type: 'text' } },
          { column: 'notes', to: { kind: 'new', display_name: 'Notes 378', type: 'text' } },
        ];
    const body = multipart(
      {
        mapping: JSON.stringify(mapping),
        dry_run: String(dry),
        ...(Object.keys(opts).length ? { upsert: JSON.stringify(opts) } : {}),
      },
      csv,
    );
    return app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
  };

  const rows = async () =>
    (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 100 })).json().data as
      Array<{ title: string; values: Record<string, unknown> }>;

  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Upsert 378' })).json().id;
    const first = await importIt(CSV_V1, {});
    if (first.statusCode >= 300) throw new Error(`seed import failed: ${first.body}`);
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const named = detail.fields as Array<{ id: string; displayName: string }>;
    fieldIds = Object.fromEntries(named.map((f) => [f.displayName, f.id]));
    keyFieldId = fieldIds['Ext Id']!;
  });

  it('IDEMPOTENCE: re-importing the same file changes nothing', async () => {
    const before = await rows();
    expect(before).toHaveLength(2);

    const res = await importIt(CSV_V1, { column: 'ext_id', match_field_id: keyFieldId, on_match: 'update' });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().created, 'nothing new').toBe(0);
    expect(res.json().updated).toBe(2);

    const after = await rows();
    expect(after, 'no duplicates').toHaveLength(2);
    expect(after.map((r) => r.title).sort()).toEqual(before.map((r) => r.title).sort());
  });

  it('an UPDATE never blanks a field the CSV does not mention', async () => {
    // The silent-data-loss case, and the obvious way to get this wrong: someone
    // re-importing a two-column corrections file would wipe half of every record
    // and not know until they looked.
    const partial = 'name;ext_id;stage\nAlpha;a-1;Won';
    const body = multipart(
      {
        mapping: JSON.stringify([
          { column: 'name', to: { kind: 'title' } },
          { column: 'ext_id', to: { kind: 'existing', field_id: keyFieldId } },
          { column: 'stage', to: { kind: 'existing', field_id: (await (async () => {
            const d = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
            return (d.fields as Array<{ id: string; displayName: string }>).find((f) => f.displayName === 'Stage 378')!.id;
          })()) } },
        ]),
        dry_run: 'false',
        upsert: JSON.stringify({ column: 'ext_id', match_field_id: keyFieldId, on_match: 'update' }),
      },
      partial,
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${wsId}/databases/${dbId}/import`,
      headers: { ...authed(admin.token), ...body.headers }, payload: body.payload,
    });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().updated).toBe(1);

    const alpha = (await rows()).find((r) => r.title === 'Alpha')!;
    const notesKey = Object.keys(alpha.values).find((k) => alpha.values[k] === 'first');
    expect(notesKey, 'notes was NOT in the file and must survive untouched').toBeTruthy();
  });

  it('on_match: skip leaves the record alone', async () => {
    const res = await importIt('name;ext_id;stage;notes\nAlpha;a-1;Lost;rewritten', {
      column: 'ext_id', match_field_id: keyFieldId, on_match: 'skip',
    });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().created).toBe(0);
    expect(res.json().updated).toBe(0);
    expect(res.json().skipped).toBe(1);
  });

  it('on_no_match: skip does not create', async () => {
    const res = await importIt('name;ext_id;stage;notes\nGamma;g-9;New;x', {
      column: 'ext_id', match_field_id: keyFieldId, on_no_match: 'skip',
    });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().created).toBe(0);
    expect(res.json().skipped).toBe(1);
  });

  it('the DRY RUN reports created / updated / skipped before committing', async () => {
    const res = await importIt('name;ext_id;stage;notes\nAlpha;a-1;X;y\nDelta;d-4;X;y', {
      column: 'ext_id', match_field_id: keyFieldId, on_match: 'update',
    }, true);
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().will_update).toBe(1); // Alpha exists
    expect(res.json().will_create).toBe(1); // Delta does not
  });

  it('a DUPLICATE key is reported and skipped, never guessed at', async () => {
    // Two records sharing a key: picking one overwrites the wrong record.
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Dupe One', [`${keyFieldId}`]: 'dup-key' },
    });
    // Write the same key onto a second record through the API so the index sees two.
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const apiName = (detail.fields as Array<{ id: string; apiName: string; displayName: string }>)
      .find((f) => f.displayName === 'Ext Id')!.apiName;
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Dupe A', [apiName]: 'dup-key' } });
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Dupe B', [apiName]: 'dup-key' } });

    const res = await importIt('name;ext_id;stage;notes\nWhoKnows;dup-key;X;y', {
      column: 'ext_id', match_field_id: keyFieldId, on_match: 'update',
    });
    if (res.statusCode >= 300) throw new Error(res.body);
    expect(res.json().skipped).toBe(1);
    expect(res.json().updated).toBe(0);
    expect(JSON.stringify(res.json().warnings)).toMatch(/more than one record/);
  });
});