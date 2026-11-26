import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PACK_REGISTRY } from '../src/packs/registry';
import { FieldsService } from '../src/fields/fields.service';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { joinAs, setRestricted } from './helpers/members';
import { liveFormUrl, trackFormToken } from './helpers/form-token';

/**
 * Ticket #704 - a field carries a description (its help text): plain text, trimmed, at most 200 characters, NULL when there is none.
 *
 * It is part of what the field IS (Dara's ruling on the ticket), so it is a column on `fields`, returned by every surface that lists
 * a field, and carried by everything that copies a field: pack export/import, duplicate database, change field type.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let space: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const as = async (method: string, url: string, payload?: unknown) => {
  const res = await call(owner.token, method, url, payload);
  trackFormToken(payload, res);
  return res;
};
const pub = (url: string) => app.inject({ method: 'GET', url: `/api/v1${liveFormUrl(url)}` });

interface Fld { id: string; displayName: string; apiName: string; type: string; isSystem?: boolean; description?: string | null; config: Record<string, unknown> }
const newDb = async (name: string) =>
  (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: `${name} ${Math.random().toString(36).slice(2, 7)}` })).json().id as string;
const detail = async (dbId: string, token = owner.token) => (await call(token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json() as { fields: Fld[] };
const fieldOf = async (dbId: string, name: string, token = owner.token) => (await detail(dbId, token)).fields.find((f) => f.displayName === name)!;
const addField = (dbId: string, body: Record<string, unknown>) => as('POST', `/workspaces/${ws}/databases/${dbId}/fields`, body);
const patchField = (dbId: string, fieldId: string, body: Record<string, unknown>) => as('PATCH', `/workspaces/${ws}/databases/${dbId}/fields/${fieldId}`, body);
/** The whole 422 body: the validation `message` is generic and the limit is named in `details`. */
const msg = (res: { body: string }) => res.body;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'FieldDescOwner');
  ws = (await as('POST', '/workspaces', { name: 'Field descriptions' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#704 create', () => {
  it('stores a trimmed description and returns it from the create response AND the database detail', async () => {
    const db = await newDb('Create');
    const res = await addField(db, { display_name: 'Goal', type: 'text', description: '  What this project is meant to achieve.  ' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().description).toBe('What this project is meant to achieve.');
    expect((await fieldOf(db, 'Goal')).description).toBe('What this project is meant to achieve.');
  });

  it('a field created without one has NO description (null), and so do empty / whitespace / null inputs', async () => {
    const db = await newDb('None');
    expect((await addField(db, { display_name: 'Plain', type: 'text' })).json().description ?? null).toBeNull();
    expect((await addField(db, { display_name: 'Empty', type: 'text', description: '' })).json().description ?? null).toBeNull();
    expect((await addField(db, { display_name: 'Spaces', type: 'text', description: '   ' })).json().description ?? null).toBeNull();
    expect((await addField(db, { display_name: 'Nul', type: 'text', description: null })).json().description ?? null).toBeNull();
    for (const f of (await detail(db)).fields.filter((x) => ['Plain', 'Empty', 'Spaces', 'Nul'].includes(x.displayName))) {
      expect(f.description ?? null, f.displayName).toBeNull();
    }
  });

  it('accepts exactly 200 characters, counted after trimming, and refuses 201 with a 422 that names the limit', async () => {
    const db = await newDb('Cap');
    const ok = await addField(db, { display_name: 'Exact', type: 'text', description: `  ${'a'.repeat(200)}  ` });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().description).toBe('a'.repeat(200));
    const over = await addField(db, { display_name: 'Over', type: 'text', description: 'a'.repeat(201) });
    expect(over.statusCode).toBe(422);
    expect(msg(over)).toMatch(/200/);
    expect((await detail(db)).fields.some((f) => f.displayName === 'Over'), 'a refused create made no field').toBe(false);
  });

  it('a non-string description is a 422, never a 500', async () => {
    const db = await newDb('Type');
    const res = await addField(db, { display_name: 'Num', type: 'text', description: 7 });
    expect(res.statusCode).toBe(422);
  });
});

describe('#704 update', () => {
  it('sets, then clears (with null, and with an empty string), and the field comes back with it each time', async () => {
    const db = await newDb('Update');
    const f = (await addField(db, { display_name: 'Effort', type: 'number' })).json() as Fld;
    const set = await patchField(db, f.id, { description: 'Story points, 1 to 13.' });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().description).toBe('Story points, 1 to 13.');
    expect((await fieldOf(db, 'Effort')).description).toBe('Story points, 1 to 13.');

    const cleared = await patchField(db, f.id, { description: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().description ?? null).toBeNull();
    expect((await fieldOf(db, 'Effort')).description ?? null).toBeNull();

    await patchField(db, f.id, { description: 'Again' });
    const emptied = await patchField(db, f.id, { description: '   ' });
    expect(emptied.statusCode, emptied.body).toBe(200);
    expect((await fieldOf(db, 'Effort')).description ?? null).toBeNull();
  });

  it('a patch that does not mention description leaves it alone, and a description-only patch leaves name, config and position alone', async () => {
    const db = await newDb('Unchanged');
    const f = (await addField(db, { display_name: 'Budget', type: 'number', config: { precision: 2 }, description: 'In euros.' })).json() as Fld;
    const renamed = await patchField(db, f.id, { display_name: 'Budget (EUR)' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().description, 'a rename alone must not touch the description').toBe('In euros.');

    const before = await fieldOf(db, 'Budget (EUR)');
    const only = await patchField(db, f.id, { description: 'Whole euros.' });
    expect(only.statusCode, only.body).toBe(200);
    const after = await fieldOf(db, 'Budget (EUR)');
    expect(after.description).toBe('Whole euros.');
    expect({ ...after, description: null, updatedAt: null }).toEqual({ ...before, description: null, updatedAt: null });
  });

  it('an over-long description is a 422 and the stored one is untouched', async () => {
    const db = await newDb('UpdateCap');
    const f = (await addField(db, { display_name: 'Owner', type: 'text', description: 'Keep me.' })).json() as Fld;
    const res = await patchField(db, f.id, { description: 'x'.repeat(201) });
    expect(res.statusCode).toBe(422);
    expect(msg(res)).toMatch(/200/);
    expect((await fieldOf(db, 'Owner')).description).toBe('Keep me.');
  });

  it('a description-only patch is a real patch (not the "send at least one field" 422), and null counts as a value', async () => {
    const db = await newDb('Patchy');
    const f = (await addField(db, { display_name: 'Note', type: 'text', description: 'x' })).json() as Fld;
    expect((await patchField(db, f.id, { description: null })).statusCode).toBe(200);
  });

  it('a system field can carry a description, but is still not renameable', async () => {
    const db = await newDb('System');
    const sys = (await detail(db)).fields.find((f) => f.isSystem)!;
    expect(sys, 'a database ships with system fields').toBeDefined();
    const res = await patchField(db, sys.id, { description: 'Set by the system.' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await detail(db)).fields.find((f) => f.id === sys.id)!.description).toBe('Set by the system.');
    expect((await patchField(db, sys.id, { display_name: 'Renamed' })).statusCode).toBe(422);
    expect((await patchField(db, sys.id, { description: null })).statusCode).toBe(200);
    expect((await detail(db)).fields.find((f) => f.id === sys.id)!.description ?? null).toBeNull();
  });
});

describe('#704 the service refuses an over-long description on its own', () => {
  it('FieldsService.create is capped without the controller DTO (pack and architect installs reach it directly)', async () => {
    const db = await newDb('ServiceCap');
    const svc = app.get(FieldsService);
    await expect(svc.create(db, { display_name: 'Too much', type: 'text', description: 'z'.repeat(201) })).rejects.toThrow(/200/);
    await expect(svc.update(db, (await addField(db, { display_name: 'Ok', type: 'text' })).json().id, { description: 'z'.repeat(201) })).rejects.toThrow(/200/);
  });
});

describe('#704 change field type keeps it', () => {
  it('the description survives a type change (and a dry run changes nothing)', async () => {
    const db = await newDb('ChangeType');
    const f = (await addField(db, { display_name: 'Contact', type: 'email', description: 'Who to ask.' })).json() as Fld;
    const url = `/workspaces/${ws}/databases/${db}/fields/${f.id}/change-type`;
    const dry = await as('POST', url, { type: 'url', dry_run: true });
    expect(dry.statusCode, dry.body).toBeLessThan(300);
    expect((await fieldOf(db, 'Contact')).description).toBe('Who to ask.');
    const res = await as('POST', url, { type: 'url' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const after = await fieldOf(db, 'Contact');
    expect(after.type).toBe('url');
    expect(after.description).toBe('Who to ask.');
  });

  it('text to a choice field keeps it too (that conversion rebuilds options)', async () => {
    const db = await newDb('ChangeChoice');
    const f = (await addField(db, { display_name: 'Size', type: 'text', description: 'T-shirt size.' })).json() as Fld;
    await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { size: 'S' } });
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/fields/${f.id}/change-type`, { type: 'select' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const after = await fieldOf(db, 'Size');
    expect(after.type).toBe('select');
    expect(after.description).toBe('T-shirt size.');
  });
});

describe('#704 who may write it', () => {
  it('a guest with edit rights, a guest with view rights and a member shut out of the database cannot set or clear it, on create or update; the stored one is unchanged', async () => {
    const db = await newDb('Perms');
    const f = (await addField(db, { display_name: 'Secret sauce', type: 'text', description: 'Original help.' })).json() as Fld;
    await setRestricted(app, owner.token, ws, 'database', db);

    const guestEdit = await joinAs(app, owner.token, ws, 'DescGuestEditor', 'guest', [{ database_id: db, role: 'editor' }]);
    const guestView = await joinAs(app, owner.token, ws, 'DescGuestViewer', 'guest', [{ database_id: db, role: 'viewer' }]);
    const shutOut = await joinAs(app, owner.token, ws, 'DescMemberShutOut', 'member');
    for (const [who, token] of [['guest-editor', guestEdit.token], ['guest-viewer', guestView.token], ['member-no-grant', shutOut.token]] as const) {
      const set = await call(token, 'PATCH', `/workspaces/${ws}/databases/${db}/fields/${f.id}`, { description: `${who} was here` });
      expect(set.statusCode, `${who} update: ${set.body}`).toBeGreaterThanOrEqual(400);
      expect(set.statusCode, `${who} update`).toBeLessThan(500);
      const clear = await call(token, 'PATCH', `/workspaces/${ws}/databases/${db}/fields/${f.id}`, { description: null });
      expect(clear.statusCode, `${who} clear`).toBeGreaterThanOrEqual(400);
      expect(clear.statusCode, `${who} clear`).toBeLessThan(500);
      const create = await call(token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: `By ${who}`, type: 'text', description: 'nope' });
      expect(create.statusCode, `${who} create: ${create.body}`).toBeGreaterThanOrEqual(400);
      expect(create.statusCode, `${who} create`).toBeLessThan(500);
    }
    const after = await detail(db);
    expect(after.fields.find((x) => x.displayName === 'Secret sauce')!.description).toBe('Original help.');
    expect(after.fields.some((x) => x.displayName.startsWith('By '))).toBe(false);
  }, 90_000);

  it('a guest who can READ the database sees the description', async () => {
    const db = await newDb('GuestRead');
    await addField(db, { display_name: 'Visible', type: 'text', description: 'Readable by a guest.' });
    const guest = await joinAs(app, owner.token, ws, 'DescGuestReader', 'guest', [{ database_id: db, role: 'viewer' }]);
    expect((await fieldOf(db, 'Visible', guest.token)).description).toBe('Readable by a guest.');
  }, 60_000);
});

describe('#704 pack export and import', () => {
  const exportDb = (dbId: string, slug: string) => as('POST', `/workspaces/${ws}/packs/export`, { slug, name: slug, database_ids: [dbId] });
  const install = (target: string, manifest: unknown) => as('POST', `/workspaces/${target}/packs/install`, { manifest });

  it('export carries a description, and installing the export elsewhere recreates it', async () => {
    const db = await newDb('Pack source');
    await addField(db, { display_name: 'Goal', type: 'text', description: 'What we want out of this.' });
    await addField(db, { display_name: 'Stage', type: 'workflow', description: 'Where it is in the flow.' });
    await addField(db, { display_name: 'Plain', type: 'text' });
    const exp = await exportDb(db, 'desc-export');
    expect(exp.statusCode, exp.body).toBe(201);
    const manifest = exp.json() as { databases: Array<{ fields: Array<{ name: string; description?: string }> }> };
    const fields = manifest.databases.flatMap((d) => d.fields);
    expect(fields.find((f) => f.name === 'Goal')!.description).toBe('What we want out of this.');
    expect(fields.find((f) => f.name === 'Stage')!.description).toBe('Where it is in the flow.');
    expect('description' in fields.find((f) => f.name === 'Plain')!, 'an undescribed field adds no key to the manifest').toBe(false);

    const ws2 = (await as('POST', '/workspaces', { name: `Pack target ${Date.now()}` })).json().id as string;
    const res = await install(ws2, manifest);
    expect(res.statusCode, res.body).toBe(201);
    const dbs = (await as('GET', `/workspaces/${ws2}/databases`)).json() as Array<{ id: string; name: string }>;
    const copy = dbs.find((d) => d.name === (manifest.databases[0] as unknown as { name: string }).name)!;
    const live = ((await as('GET', `/workspaces/${ws2}/databases/${copy.id}`)).json() as { fields: Fld[] }).fields;
    expect(live.find((f) => f.displayName === 'Goal')!.description).toBe('What we want out of this.');
    expect(live.find((f) => f.displayName === 'Stage')!.description).toBe('Where it is in the flow.');
    expect(live.find((f) => f.displayName === 'Plain')!.description ?? null).toBeNull();
  }, 120_000);

  it('a manifest states[] entry can carry one', async () => {
    const manifest = structuredClone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as unknown as {
      slug: string;
      states: Array<{ database: string; field: string; description?: string }>;
    };
    manifest.slug = 'desc-states';
    manifest.states[0]!.description = 'Where the ticket is.';
    const { database: stateDb, field: stateField } = manifest.states[0]!;
    const target = (await as('POST', '/workspaces', { name: `States target ${Date.now()}` })).json().id as string;
    const res = await install(target, manifest);
    expect(res.statusCode, res.body).toBe(201);
    const dbs = (await as('GET', `/workspaces/${target}/databases`)).json() as Array<{ id: string; name: string }>;
    const live = ((await as('GET', `/workspaces/${target}/databases/${dbs.find((d) => d.name === stateDb)!.id}`)).json() as { fields: Fld[] }).fields;
    expect(live.find((f) => f.displayName === stateField)!.description).toBe('Where the ticket is.');
  }, 120_000);

  it('a derived field (lookup / rollup / button) carries one through install AND export', async () => {
    const manifest = structuredClone(PACK_REGISTRY.find((p) => p.slug === 'deal-desk')!.manifest) as unknown as {
      slug: string;
      derived_fields: Array<{ database: string; name: string; description?: string }>;
    };
    expect(manifest.derived_fields.length, 'deal-desk must keep a derived field for this test to mean anything').toBeGreaterThan(0);
    manifest.slug = 'desc-derived';
    const derived = manifest.derived_fields[0]!;
    derived.description = 'Computed for you.';
    const target = (await as('POST', '/workspaces', { name: `Derived target ${Date.now()}` })).json().id as string;
    const res = await install(target, manifest);
    expect(res.statusCode, res.body).toBe(201);
    const dbs = (await as('GET', `/workspaces/${target}/databases`)).json() as Array<{ id: string; name: string }>;
    const home = dbs.find((d) => d.name === derived.database)!;
    const live = ((await as('GET', `/workspaces/${target}/databases/${home.id}`)).json() as { fields: Fld[] }).fields;
    expect(live.find((f) => f.displayName === derived.name)!.description).toBe('Computed for you.');

    const exp = await as('POST', `/workspaces/${target}/packs/export`, { slug: 'derived-desc', name: 'Derived desc', database_ids: dbs.map((d) => d.id) });
    expect(exp.statusCode, exp.body).toBe(201);
    const out = (exp.json() as { derived_fields: Array<{ database: string; name: string; description?: string }> }).derived_fields;
    expect(out.find((f) => f.database === derived.database && f.name === derived.name)!.description).toBe('Computed for you.');
  }, 180_000);

  it('a state field (a select a trigger binds to) exports its description under states[], and it installs back', async () => {
    const src = (await as('POST', '/workspaces', { name: `State source ${Date.now()}` })).json().id as string;
    const pack = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!;
    expect((await install(src, pack.manifest)).statusCode).toBe(201);
    const dbs = (await as('GET', `/workspaces/${src}/databases`)).json() as Array<{ id: string; name: string }>;
    const tickets = dbs.find((d) => d.name === 'Tickets')!;
    const status = ((await as('GET', `/workspaces/${src}/databases/${tickets.id}`)).json() as { fields: Fld[] }).fields.find((f) => f.displayName === 'Status')!;
    expect((await as('PATCH', `/workspaces/${src}/databases/${tickets.id}/fields/${status.id}`, { description: 'Where the ticket stands.' })).statusCode).toBe(200);
    const exp = await as('POST', `/workspaces/${src}/packs/export`, { slug: 'state-desc', name: 'State desc', database_ids: dbs.map((d) => d.id) });
    expect(exp.statusCode, exp.body).toBe(201);
    const manifest = exp.json() as { states: Array<{ field: string; description?: string }> };
    expect(manifest.states.find((s) => s.field === 'Status')!.description).toBe('Where the ticket stands.');
    const target = (await as('POST', '/workspaces', { name: `State target ${Date.now()}` })).json().id as string;
    expect((await install(target, manifest)).statusCode).toBe(201);
    const tdbs = (await as('GET', `/workspaces/${target}/databases`)).json() as Array<{ id: string; name: string }>;
    const live = ((await as('GET', `/workspaces/${target}/databases/${tdbs.find((d) => d.name === 'Tickets')!.id}`)).json() as { fields: Fld[] }).fields;
    expect(live.find((f) => f.displayName === 'Status')!.description).toBe('Where the ticket stands.');
  }, 180_000);

  it('an over-long description in a manifest is refused with a 422 naming the limit, and nothing is installed', async () => {
    const manifest = structuredClone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as unknown as {
      slug: string;
      databases: Array<{ fields: Array<{ name: string; description?: string }> }>;
    };
    manifest.slug = 'desc-too-long';
    manifest.databases[0]!.fields[0]!.description = 'y'.repeat(201);
    const target = (await as('POST', '/workspaces', { name: `Long target ${Date.now()}` })).json().id as string;
    const res = await install(target, manifest);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/200/);
    // The Members system database appears lazily on first read, so look for the PACK's databases rather than counting.
    const installed = ((await as('GET', `/workspaces/${target}/databases`)).json() as Array<{ name: string }>).map((d) => d.name);
    expect(installed.filter((n) => n !== 'Members'), 'nothing of the pack was installed').toEqual([]);
  }, 120_000);

  it('a built-in pack exported after install carries no description anywhere (existing packs stay as they were)', async () => {
    const target = (await as('POST', '/workspaces', { name: `Existing ${Date.now()}` })).json().id as string;
    const pack = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!;
    expect((await install(target, pack.manifest)).statusCode).toBe(201);
    const dbs = (await as('GET', `/workspaces/${target}/databases`)).json() as Array<{ id: string }>;
    const exp = await as('POST', `/workspaces/${target}/packs/export`, { slug: 'existing-export', name: 'Existing export', database_ids: dbs.map((d) => d.id) });
    expect(exp.statusCode, exp.body).toBe(201);
    const m = exp.json() as { databases: Array<{ fields: object[] }>; states: object[]; derived_fields: object[] };
    for (const entry of [...m.databases.flatMap((d) => d.fields), ...m.states, ...m.derived_fields]) {
      expect('description' in entry, JSON.stringify(entry)).toBe(false);
    }
  }, 120_000);
});

describe('#704 duplicate database', () => {
  it('the copy has the same descriptions as the source', async () => {
    const db = await newDb('Dup source');
    await addField(db, { display_name: 'Why', type: 'text', description: 'The reason, in a sentence.' });
    await addField(db, { display_name: 'Silent', type: 'text' });
    const dup = await as('POST', `/workspaces/${ws}/databases/${db}/duplicate`, {});
    expect(dup.statusCode, dup.body).toBeLessThan(300);
    const copy = await detail(dup.json().id);
    expect(copy.fields.find((f) => f.displayName === 'Why')!.description).toBe('The reason, in a sentence.');
    expect(copy.fields.find((f) => f.displayName === 'Silent')!.description ?? null).toBeNull();
    expect((await fieldOf(db, 'Why')).description, 'the source is untouched').toBe('The reason, in a sentence.');
  }, 120_000);
});

describe('#704 public form', () => {
  it('the public form payload carries the field description (null when there is none)', async () => {
    const db = await newDb('Form');
    const described = (await addField(db, { display_name: 'Budget', type: 'number', description: 'Total in euros, no VAT.' })).json() as Fld;
    const bare = (await addField(db, { display_name: 'Nickname', type: 'text' })).json() as Fld;
    const view = await as('POST', `/workspaces/${ws}/databases/${db}/views`, {
      name: 'Intake',
      type: 'form',
      config: {
        sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {},
        form: { title: 'Intake', access: 'public', public_token: 'tok-704', fields: [{ field_id: described.id }, { field_id: bare.id, help: 'form-level help' }] },
      },
    });
    expect(view.statusCode, view.body).toBe(201);
    const res = await pub('/public/forms/tok-704');
    expect(res.statusCode, res.body).toBe(200);
    const fields = res.json().fields as Array<{ label: string; description: string | null; help: string | null }>;
    expect(fields.find((f) => f.label === 'Budget')!.description).toBe('Total in euros, no VAT.');
    expect(fields.find((f) => f.label === 'Nickname')!.description).toBeNull();
    expect(fields.find((f) => f.label === 'Nickname')!.help, 'the form-level help is unchanged').toBe('form-level help');
  }, 60_000);
});

describe('#704 workspace export', () => {
  it('the machine-readable schema lists each field with its description (null when there is none)', async () => {
    const db = await newDb('Export');
    await addField(db, { display_name: 'Why', type: 'text', description: 'Backed up with the field.' });
    await addField(db, { display_name: 'Quiet', type: 'text' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${ws}/export/workspace.zip`, headers: authed(owner.token) });
    expect(res.statusCode).toBe(200);
    const zip = new AdmZip(res.rawPayload);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    const entry = manifest.spaces.flatMap((sp: { databases: Array<{ id: string; path: string }> }) => sp.databases).find((d: { id: string }) => d.id === db);
    const fields = JSON.parse(zip.readAsText(entry.path)).fields as Array<{ display_name: string; description?: string | null }>;
    expect(fields.find((f) => f.display_name === 'Why')!.description).toBe('Backed up with the field.');
    expect(fields.find((f) => f.display_name === 'Quiet')!.description ?? null).toBeNull();
  }, 120_000);
});
