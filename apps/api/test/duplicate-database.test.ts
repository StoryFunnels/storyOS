import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #266 — "duplicate database" is export→rename→install of a one-database pack
 * slice (packs.service.ts's own `duplicateDatabase`), not a second copier. The
 * dangerous case named on the ticket (criterion 3) is the whole reason these
 * tests exist: `ArchitectService.buildDatabases` matches an existing database
 * purely by name, workspace-wide, so installing under the SOURCE's own name
 * would silently MERGE into it rather than create a copy.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function detail(dbId: string) {
  return (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'DupDbOwner');
  wsId = (await as('POST', '/workspaces', { name: '266 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('the dangerous case (#266 AC3): naming the copy after the source does NOT merge into it', () => {
  it('duplicating without changing the name still produces a SECOND database', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text' });
    const rec = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Original' } })).json();

    // The dangerous request: ask for a duplicate NAMED exactly like the source.
    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, { name: 'Leads' });
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const body = dup.json();
    expect(body.id, 'must be a NEW database id, not the source').not.toBe(dbId);
    expect(body.name, 'disambiguated rather than colliding').not.toBe('Leads');

    // The source is untouched: same record, same field, still named "Leads".
    const source = await detail(dbId);
    expect(source.name).toBe('Leads');
    expect(source.fields.some((f: { displayName: string }) => f.displayName === 'Notes')).toBe(true);
    const sourceRecords = (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json().data;
    expect(sourceRecords).toHaveLength(1);
    expect(sourceRecords[0].id).toBe(rec.id);

    // Two distinct "Leads"-ish databases now exist.
    const all = (await as('GET', `/workspaces/${wsId}/databases`)).json();
    const leadsLike = all.filter((d: { name: string }) => d.name.startsWith('Leads'));
    expect(leadsLike.length).toBeGreaterThanOrEqual(2);
  });

  it('the default name ("<source> copy") is itself disambiguated on a second duplicate', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Inventory' })).json().id;
    const first = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(first.json().name).toBe('Inventory copy');

    const second = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});
    expect(second.statusCode, second.body).toBeLessThan(300);
    expect(second.json().name, 'a second duplicate must not collide with the first copy').not.toBe('Inventory copy');
    expect(second.json().id).not.toBe(first.json().id);
  });
});

describe('the plain case (#266 AC10): no relations, no formulas, no selects', () => {
  it('duplicates cleanly with no warnings about things it does not have', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Plain' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text' });

    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const body = dup.json();
    expect(body.skipped_relations).toEqual([]);
    expect(body.skipped_derived_fields).toEqual([]);

    const copy = await detail(body.id);
    expect(copy.fields.some((f: { displayName: string }) => f.displayName === 'Notes')).toBe(true);
  });
});

describe('formulas and filtered views survive because api_names are NOT regenerated (#266 AC4)', () => {
  it('a formula still computes, and a filtered view still filters, in the copy', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Budget' })).json().id;
    const estimate = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Estimate', type: 'number' })
    ).json();
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Doubled',
      type: 'formula',
      config: { expression: '{Estimate} * 2' },
    });
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Big ones',
      type: 'table',
      config: { filters: { field: estimate.apiName, op: 'gt', value: 100 } },
    });
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [estimate.apiName]: 500 } });
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [estimate.apiName]: 5 } });

    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, { include_records: true });
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const copyId = dup.json().id;

    const copy = await detail(copyId);
    const copyEstimate = copy.fields.find((f: { displayName: string }) => f.displayName === 'Estimate');
    expect(copyEstimate.apiName, 'api_names must be preserved, not regenerated').toBe(estimate.apiName);
    const copyView = copy.views.find((v: { name: string }) => v.name === 'Big ones');
    expect(copyView.config.filters).toEqual({ field: estimate.apiName, op: 'gt', value: 100 });

    const copyRecords = (await as('GET', `/workspaces/${wsId}/databases/${copyId}/records`)).json().data;
    const big = copyRecords.find((r: { values: Record<string, unknown> }) => r.values[estimate.apiName] === 500);
    expect(big.values['Doubled'] ?? big.values['doubled']).toBe(1000);
  });
});

describe('select/multi-select round-trip with colours; a record\'s option value points at the COPY\'s own option (#266 AC5)', () => {
  it('option labels and colours survive, and record values remap', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Pipeline' })).json().id;
    const status = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Status',
        type: 'select',
        options: [{ label: 'Won', color: 'green' }, { label: 'Lost', color: 'red' }],
      })
    ).json();
    const wonOptionId = status.options.find((o: { label: string }) => o.label === 'Won').id;
    const rec = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [status.apiName]: wonOptionId } })
    ).json();

    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, { include_records: true });
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const copyId = dup.json().id;

    const copy = await detail(copyId);
    const copyStatus = copy.fields.find((f: { displayName: string }) => f.displayName === 'Status');
    expect(copyStatus.options.map((o: { label: string; color: string }) => ({ label: o.label, color: o.color }))).toEqual([
      { label: 'Won', color: 'green' },
      { label: 'Lost', color: 'red' },
    ]);
    const copyWonOptionId = copyStatus.options.find((o: { label: string }) => o.label === 'Won').id;
    expect(copyWonOptionId).not.toBe(wonOptionId);

    const copyRecords = (await as('GET', `/workspaces/${wsId}/databases/${copyId}/records`)).json().data;
    const copyRec = copyRecords.find((r: { title: string }) => r.title === rec.title) ?? copyRecords[0];
    expect(copyRec.values[status.apiName], "the copy's record must point at the COPY's option id").toBe(copyWonOptionId);
  });
});

describe('cross-database relations are skipped and reported, along with any dependent lookup/rollup (#266 AC6)', () => {
  it('duplicating one side of a relation drops the relation field and the rollup that used it, and says so', async () => {
    const projectsId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
    const tasksId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks For 266' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: projectsId,
      database_b_id: tasksId,
      cardinality: 'one_to_many',
    });
    expect(rel.statusCode, rel.body).toBeLessThan(300);
    const relationFieldOnProjects = rel.json().field_a;

    await as('POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Task count',
      type: 'rollup',
      config: { relation_field_id: relationFieldOnProjects.id, op: 'count' },
    });

    const dup = await as('POST', `/workspaces/${wsId}/databases/${projectsId}/duplicate`, {});
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const body = dup.json();

    expect(body.skipped_relations).toContain(relationFieldOnProjects.display_name);
    expect(body.skipped_derived_fields.some((f: { name: string }) => f.name === 'Task count')).toBe(true);

    const copy = await detail(body.id);
    expect(copy.fields.some((f: { displayName: string }) => f.displayName === relationFieldOnProjects.display_name)).toBe(false);
    expect(copy.fields.some((f: { displayName: string }) => f.displayName === 'Task count'), 'must not keep a lookup pointing at a relation it does not have').toBe(false);
  });

  it('a SELF-relation survives (both sides are in a one-database slice)', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Org Chart' })).json().id;
    const rel = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: dbId,
      cardinality: 'one_to_many',
      field_a_name: 'Manager',
      field_b_name: 'Reports',
    });
    expect(rel.statusCode, rel.body).toBeLessThan(300);

    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    expect(dup.json().skipped_relations).toEqual([]);

    const copy = await detail(dup.json().id);
    expect(copy.fields.some((f: { displayName: string }) => f.displayName === 'Manager')).toBe(true);
    expect(copy.fields.some((f: { displayName: string }) => f.displayName === 'Reports')).toBe(true);
  });
});

describe('MUST KEEP WORKING (#266 AC8/AC9): Business Packs, and the source, are unaffected', () => {
  it('export/install a real pack before and after this change lands the same way', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Pack Source' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'text' });

    const exported = await as('POST', `/workspaces/${wsId}/packs/export`, {
      slug: 'pack-source-266',
      name: 'Pack Source',
      version: '1.0.0',
      summary: 'sanity',
      database_ids: [dbId],
    });
    expect(exported.statusCode, exported.body).toBeLessThan(300);

    const targetWs = (await as('POST', '/workspaces', { name: '266 Pack Target' })).json().id;
    const installed = await as('POST', `/workspaces/${targetWs}/packs/install`, { manifest: exported.json() });
    expect(installed.statusCode, installed.body).toBeLessThan(300);
    expect(installed.json().databases.some((d: { name: string }) => d.name === 'Pack Source')).toBe(true);

    // And this pack DOES show up as an installed pack — unlike a duplicate.
    const installs = await as('GET', `/workspaces/${targetWs}/packs/installed`);
    expect(installs.statusCode, installs.body).toBeLessThan(300);
    expect(JSON.stringify(installs.json())).toContain('pack-source-266');
  });

  it("a duplicate's synthetic pack slug leaves NO installed-pack entry behind", async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'No Trace' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});

    const installs = await as('GET', `/workspaces/${wsId}/packs/installed`);
    expect(installs.statusCode, installs.body).toBeLessThan(300);
    expect(JSON.stringify(installs.json())).not.toContain('duplicate-');
  });
});

describe('records: include_records copies rows with remapped values; default is schema-only (#266 AC7)', () => {
  it('include_records defaults to false — no rows in the copy', async () => {
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'No Rows' })).json().id;
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} });

    const dup = await as('POST', `/workspaces/${wsId}/databases/${dbId}/duplicate`, {});
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    expect(dup.json().records_copied).toBe(0);
    const copyRecords = (await as('GET', `/workspaces/${wsId}/databases/${dup.json().id}/records`)).json().data;
    expect(copyRecords).toHaveLength(0);
  });
});
