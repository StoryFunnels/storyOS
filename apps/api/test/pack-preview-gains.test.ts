import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * ticket #982 — a pack install/update into a database that ALREADY EXISTS merges new fields, options and views in; the preview said only
 * "reuse". The preview now carries `gains` per reused database, computed by the decision functions the install itself runs
 * (`agents/plan-decisions.ts`). The load-bearing test is the third: preview, then install, then compare what the preview promised with
 * what actually changed in the database.
 */
let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, admin.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Gains Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

async function workspace(label: string) {
  const ws = (await as('POST', '/workspaces', { name: label })).json().id as string;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  return { ws, space };
}
const manifest = (slug: string, version: string, over: Partial<PackManifest> = {}): PackManifest =>
  ({
    format_version: 1, slug, name: `Gains ${slug}`, version, summary: 's', scenario: 'pack',
    databases: [], relations: [], states: [], agents: [], triggers: [], views: [], automations: [], derived_fields: [],
    sample_records: [], skills: [], requires: { connections: [], ai: 'none' }, license: 'All rights reserved',
    ...over,
  }) as unknown as PackManifest;
const preview = async (ws: string, m: PackManifest) => {
  const res = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: m });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};
const install = (ws: string, m: PackManifest, resolutions?: unknown) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, ...(resolutions ? { resolutions } : {}) });

type Snap = { fields: Map<string, string>; options: Map<string, string[]>; views: string[] };
async function snap(ws: string, dbName: string): Promise<Snap> {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const detail = (await as('GET', `/workspaces/${ws}/databases/${dbs.find((d) => d.name === dbName)!.id}`)).json();
  return {
    fields: new Map((detail.fields as Array<{ displayName: string; type: string }>).map((f) => [f.displayName, f.type])),
    options: new Map((detail.fields as Array<{ displayName: string; options?: Array<{ label: string }> }>).filter((f) => f.options).map((f) => [f.displayName, f.options!.map((o) => o.label)])),
    views: (detail.views as Array<{ name: string }>).map((v) => v.name),
  };
}
/** What changed between two snapshots, in the shape `gains` reports it. */
const changed = (before: Snap, after: Snap) => ({
  fields: [...after.fields].filter(([n]) => !before.fields.has(n)).map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name)),
  options: [...after.options].flatMap(([field, labels]) => {
    const had = before.options.get(field);
    if (!had) return [];
    const added = labels.filter((l) => !had.includes(l));
    return added.length ? [{ field, labels: added }] : [];
  }),
  views: after.views.filter((v) => !before.views.includes(v)).sort(),
});

/** A database that exists already (not from any pack), with a select `Stage` and a text `Budget`. */
async function existingProjects(ws: string, space: string) {
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Projects' })).json().id as string;
  await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Owner', type: 'text' });
  await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Budget', type: 'text' });
  await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Stage', type: 'select', options: [{ label: 'Open', color: 'blue' }] });
  return db;
}
const projectsPack = (version = '1.0.0') =>
  manifest('gains-pack', version, {
    databases: [
      { action: 'create', name: 'Projects', space: 'Work', fields: [{ name: 'Owner', type: 'text' }, { name: 'Budget', type: 'number' }, { name: 'Notes', type: 'text' }] },
      { action: 'create', name: 'Tasks', space: 'Work', fields: [{ name: 'Title2', type: 'text' }] },
    ],
    relations: [{ from: 'Tasks', from_field: 'Project', to: 'Projects', to_field: 'Tasks', cardinality: 'one_to_many' }],
    states: [{ database: 'Projects', field: 'Stage', options: [{ label: 'Open' }, { label: 'Closed' }, { label: 'Blocked' }] }],
    views: [{ database: 'Projects', name: 'Board', type: 'table', config: {} }],
  } as unknown as Partial<PackManifest>);

describe('#982 the preview says what a reused database will gain', () => {
  it('a database the pack creates carries no gains; a reused one lists fields, options, views, and what is kept', async () => {
    const { ws, space } = await workspace('Gains Preview');
    const fresh = await preview(ws, projectsPack());
    expect(fresh.databases.map((d: { action: string }) => d.action)).toEqual(['create', 'create']);
    expect(fresh.databases.every((d: { gains?: unknown }) => d.gains === undefined)).toBe(true);

    await existingProjects(ws, space);
    const pv = await preview(ws, projectsPack());
    const projects = pv.databases.find((d: { name: string }) => d.name === 'Projects');
    expect(projects.action).toBe('collision'); // it exists and no pack made it
    expect(projects.gains.fields).toEqual(expect.arrayContaining([{ name: 'Notes', type: 'text' }, { name: 'Tasks', type: 'relation' }]));
    expect(projects.gains.fields.map((f: { name: string }) => f.name)).not.toContain('Owner'); // already there, same type
    expect(projects.gains.options).toEqual([{ field: 'Stage', labels: ['Closed', 'Blocked'] }]);
    expect(projects.gains.views).toEqual(['Board']);
    expect(projects.gains.not_applied).toEqual([expect.objectContaining({ kind: 'field', name: 'Projects.Budget', reason: expect.stringContaining('already exists as text') })]);
    expect(pv.databases.find((d: { name: string }) => d.name === 'Tasks').gains).toBeUndefined();
  });

  it('a state that exists as a non-select field is reported as blocking the install, and install really refuses', async () => {
    const { ws, space } = await workspace('Gains Blocked');
    const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Projects' })).json().id as string;
    await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Stage', type: 'text' });
    const m = manifest('gains-blocked', '1.0.0', {
      databases: [{ action: 'create', name: 'Projects', space: 'Work', fields: [] }],
      states: [{ database: 'Projects', field: 'Stage', options: [{ label: 'Open' }] }],
    } as unknown as Partial<PackManifest>);
    const pv = await preview(ws, m);
    expect(pv.databases[0].gains.not_applied).toEqual([expect.objectContaining({ kind: 'state', name: 'Projects.Stage', blocks_install: true })]);
    const res = await install(ws, m, { Projects: { action: 'reuse' } });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('PREVIEW THEN INSTALL: what the preview promised is exactly what changed (adopting an existing database)', async () => {
    const { ws, space } = await workspace('Gains Match Adopt');
    await existingProjects(ws, space);
    const pv = await preview(ws, projectsPack());
    const gains = pv.databases.find((d: { name: string }) => d.name === 'Projects').gains;
    const before = await snap(ws, 'Projects');
    const res = await install(ws, projectsPack(), { Projects: { action: 'reuse' } });
    expect(res.statusCode, res.body).toBe(201);
    const after = await snap(ws, 'Projects');
    const actual = changed(before, after);
    expect(gains.fields.slice().sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual(actual.fields);
    expect(gains.options).toEqual(actual.options);
    expect([...gains.views].sort()).toEqual(actual.views);
    // and what it said it would NOT apply, it did not: Budget is still text
    expect(after.fields.get('Budget')).toBe('text');
  });

  it('PREVIEW THEN INSTALL on an UPDATE: v2 adds a field, an option and a view to the database v1 installed, and the preview matched', async () => {
    const { ws } = await workspace('Gains Match Update');
    const v1 = manifest('upd-pack', '1.0.0', {
      databases: [{ action: 'create', name: 'Projects', space: 'Work', fields: [{ name: 'Owner', type: 'text' }] }],
      states: [{ database: 'Projects', field: 'Stage', options: [{ label: 'Open' }] }],
    } as unknown as Partial<PackManifest>);
    expect((await install(ws, v1)).statusCode).toBe(201);
    const v2 = manifest('upd-pack', '1.1.0', {
      databases: [{ action: 'create', name: 'Projects', space: 'Work', fields: [{ name: 'Owner', type: 'text' }, { name: 'Budget', type: 'number' }] }],
      states: [{ database: 'Projects', field: 'Stage', options: [{ label: 'Open' }, { label: 'Done' }] }],
      views: [{ database: 'Projects', name: 'Board', type: 'table', config: {} }],
    } as unknown as Partial<PackManifest>);
    const pv = await preview(ws, v2);
    const item = pv.databases[0];
    expect(item.action).toBe('reuse');
    expect(item.gains).toEqual({ fields: [{ name: 'Budget', type: 'number' }], options: [{ field: 'Stage', labels: ['Done'] }], views: ['Board'], not_applied: [] });
    const before = await snap(ws, 'Projects');
    expect((await install(ws, v2)).statusCode).toBe(201);
    const actual = changed(before, await snap(ws, 'Projects'));
    expect(item.gains.fields).toEqual(actual.fields);
    expect(item.gains.options).toEqual(actual.options);
    expect(item.gains.views).toEqual(actual.views);
    // a second preview of the same version has nothing left to gain
    expect((await preview(ws, v2)).databases[0].gains).toEqual({ fields: [], options: [], views: [], not_applied: [] });
  });
});
