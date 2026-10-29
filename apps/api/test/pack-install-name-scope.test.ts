import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DatabasesService } from '../src/databases/databases.service';

/**
 * #1156 — a pack install matches the databases it plans against what already exists BY NAME. That match used to be workspace-wide, so a
 * pack with a database called "Issues" was refused (or silently reused the other "Issues") wherever any other "Issues" lived. The match
 * is now scoped to the space the pack installs into: the target space (#1095), or the space the manifest names.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let pack: Manifest;

interface Manifest {
  slug: string;
  name: string;
  databases: Array<{ name: string; space: string }>;
  relations: Array<{ from: string; to: string; from_field: string }>;
  agents?: unknown[];
}

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const newSpace = async (ws: string, name: string) => (await as('POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
const dbsOf = async (ws: string) =>
  ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name !== 'Members');
const detail = async (ws: string, id: string) =>
  (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: Array<{ id: string; displayName: string; type: string; relation?: { target_database_id: string } }> };
const install = (ws: string, manifest: unknown, target?: string) =>
  as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...(target ? { target_space_id: target } : {}) });
const preview = (ws: string, manifest: unknown, target?: string) =>
  as('POST', `/workspaces/${ws}/packs/preview`, { manifest, ...(target ? { target_space_id: target } : {}) });

/** Same-named databases in ANOTHER space, each with an extra field and a record, so "untouched" is checkable. */
async function seedLookalikes(ws: string, space: string) {
  const out = [] as Array<{ id: string; name: string; fieldCount: number; recordCount: number }>;
  for (const d of pack.databases) {
    const made = await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: d.name });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    const f = await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Lookalike only', type: 'text' });
    expect(f.statusCode, f.body).toBeLessThan(300);
    const r = await as('POST', `/workspaces/${ws}/databases/${id}/records`, { values: { name: 'Keep me' } });
    expect(r.statusCode, r.body).toBe(201);
    out.push({ id, name: d.name, fieldCount: (await detail(ws, id)).fields.length, recordCount: 1 });
  }
  return out;
}
async function untouched(ws: string, lookalikes: Awaited<ReturnType<typeof seedLookalikes>>, space: string) {
  const all = await dbsOf(ws);
  for (const l of lookalikes) {
    expect(all.find((d) => d.id === l.id)?.spaceId, `${l.name} is still in its own space`).toBe(space);
    expect((await detail(ws, l.id)).fields.length, `${l.name} gained no fields`).toBe(l.fieldCount);
    const recs = (await as('GET', `/workspaces/${ws}/databases/${l.id}/records`)).json() as { data: unknown[] };
    expect(recs.data.length, `${l.name} keeps its records, gains none`).toBe(l.recordCount);
  }
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Name Scope');
  guest = await signUpUser(app, 'Name Scope Guest');
  const list = (await as('GET', '/packs/registry')).json() as { data?: Array<{ slug: string }> } | Array<{ slug: string }>;
  const slugs = (Array.isArray(list) ? list : list.data ?? []).map((p) => p.slug);
  for (const slug of slugs) {
    const m = ((await as('GET', `/packs/registry/${slug}`)).json() as { manifest?: Manifest }).manifest;
    if (!m) continue;
    const spaces = new Set(m.databases.map((d) => d.space.trim().toLowerCase()));
    const dbNames = new Set(m.databases.map((d) => d.name.trim().toLowerCase()));
    if (spaces.size === 1 && m.databases.length >= 2 && m.relations?.length && !m.agents?.length && dbNames.size === m.databases.length) {
      pack = m;
      break;
    }
  }
  expect(pack, 'the registry has a single-space, agent-free pack with a relation').toBeTruthy();
}, 180_000);
afterAll(async () => { await app.close(); });

describe('#1156 installing next to databases of the same name in other spaces', () => {
  it('into a new space: succeeds, creates its OWN databases there, and touches nothing in the other space', async () => {
    const ws = await newWs('Lookalikes target');
    const other = await newSpace(ws, 'Other space');
    const lookalikes = await seedLookalikes(ws, other);
    const target = await newSpace(ws, 'Fresh space');
    const res = await install(ws, pack, target);
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().databases as Array<{ action: string }>).every((d) => d.action === 'created'), 'created, not reused').toBe(true);
    const all = await dbsOf(ws);
    for (const d of pack.databases) {
      const mine = all.filter((x) => x.name === d.name && x.spaceId === target);
      expect(mine, `${d.name} exists in the target space`).toHaveLength(1);
    }
    await untouched(ws, lookalikes, other);
  });

  it('with no target: the pack gets its own space and its own databases; the lookalikes elsewhere are untouched', async () => {
    const ws = await newWs('Lookalikes no target');
    const other = await newSpace(ws, 'Somewhere else');
    const lookalikes = await seedLookalikes(ws, other);
    const res = await install(ws, pack);
    expect(res.statusCode, res.body).toBe(201);
    const all = await dbsOf(ws);
    const ownSpace = (res.json().spaces as Array<{ name: string; id: string }>).find((s) => s.name === pack.databases[0]!.space)!.id;
    for (const d of pack.databases) expect(all.filter((x) => x.name === d.name && x.spaceId === ownSpace)).toHaveLength(1);
    await untouched(ws, lookalikes, other);
  });

  it('a relation the pack creates joins the pack\'s own databases, never the lookalikes', async () => {
    const ws = await newWs('Lookalikes relations');
    const other = await newSpace(ws, 'Other for relations');
    const lookalikes = await seedLookalikes(ws, other);
    const target = await newSpace(ws, 'Relations target');
    expect((await install(ws, pack, target)).statusCode).toBe(201);
    const all = await dbsOf(ws);
    const mineId = (name: string) => all.find((d) => d.name === name && d.spaceId === target)!.id;
    const rel = pack.relations[0]!;
    const field = (await detail(ws, mineId(rel.from))).fields.find((f) => f.type === 'relation' && f.displayName === rel.from_field);
    expect(field, 'the relation field exists on the pack\'s database').toBeTruthy();
    expect(field!.relation!.target_database_id).toBe(mineId(rel.to));
    await untouched(ws, lookalikes, other);
  });

  it('re-installing into the same space is idempotent: nothing duplicated, in the target or elsewhere', async () => {
    const ws = await newWs('Lookalikes twice');
    const other = await newSpace(ws, 'Other for twice');
    const lookalikes = await seedLookalikes(ws, other);
    const target = await newSpace(ws, 'Twice target');
    expect((await install(ws, pack, target)).statusCode).toBe(201);
    const first = (await dbsOf(ws)).map((d) => d.id).sort();
    const again = await install(ws, pack, target);
    expect(again.statusCode, again.body).toBe(201);
    expect((await dbsOf(ws)).map((d) => d.id).sort()).toEqual(first);
    expect((again.json().databases as Array<{ action: string }>).every((d) => d.action === 'reused')).toBe(true);
    await untouched(ws, lookalikes, other);
  });

  it('a no-target install twice is idempotent too', async () => {
    const ws = await newWs('Lookalikes twice no target');
    const other = await newSpace(ws, 'Other for twice no target');
    await seedLookalikes(ws, other);
    expect((await install(ws, pack)).statusCode).toBe(201);
    const first = (await dbsOf(ws)).map((d) => d.id).sort();
    const again = await install(ws, pack);
    expect(again.statusCode, again.body).toBe(201);
    expect((await dbsOf(ws)).map((d) => d.id).sort()).toEqual(first);
  });

  it('preview says the same thing install does: create, not collision, for databases that only exist elsewhere', async () => {
    const ws = await newWs('Lookalikes preview');
    const other = await newSpace(ws, 'Other for preview');
    await seedLookalikes(ws, other);
    const target = await newSpace(ws, 'Preview target');
    for (const t of [target, undefined]) {
      const res = await preview(ws, pack, t);
      expect(res.statusCode, res.body).toBe(201);
      const dbs = res.json().databases as Array<{ action: string }>;
      expect(dbs.every((d) => d.action === 'create'), JSON.stringify(dbs)).toBe(true);
    }
    expect((await dbsOf(ws)).filter((d) => d.spaceId === target)).toEqual([]);
  });

  it('uninstall finds the pack\'s views in ITS databases even though a same-named database sits elsewhere (not skipped as "already gone")', async () => {
    const run = async (withLookalikes: boolean) => {
      const ws = await newWs(withLookalikes ? 'Lookalikes uninstall' : 'Control uninstall');
      const other = await newSpace(ws, 'Other for uninstall');
      const lookalikes = withLookalikes ? await seedLookalikes(ws, other) : [];
      const target = await newSpace(ws, 'Uninstall target');
      const res = await install(ws, pack, target);
      expect(res.statusCode, res.body).toBe(201);
      const viewIds = (res.json().views as Array<{ id: string }>).map((v) => v.id);
      expect(viewIds.length, 'the pack installs views').toBeGreaterThan(0);
      const installed = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
      const un = await as('POST', `/workspaces/${ws}/packs/${installed.find((i) => i.slug === pack.slug)!.id}/uninstall`, {});
      expect(un.statusCode, un.body).toBeLessThan(300);
      const body = un.json() as { removed: Array<{ kind: string; id: string }>; kept: Array<{ kind: string; id: string }> };
      const accounted = [...body.removed, ...body.kept].filter((r) => r.kind === 'view').map((r) => r.id).sort();
      if (withLookalikes) await untouched(ws, lookalikes, other);
      return { viewIds: [...viewIds].sort(), accounted, removed: body.removed.length, kept: body.kept.length };
    };
    const control = await run(false);
    const crowded = await run(true);
    // Every view is either removed or kept WITH a reason: none is silently skipped because the lookup landed on the wrong database.
    expect(crowded.accounted).toEqual(crowded.viewIds);
    // And the outcome is the one an uninstall gives with no lookalike anywhere.
    expect({ removed: crowded.removed, kept: crowded.kept }).toEqual({ removed: control.removed, kept: control.kept });
  });
});

describe('#1156 what must still be refused', () => {
  it('a same-named database that is already IN the target space (not from this pack) is still a 409 naming it, as before', async () => {
    const ws = await newWs('Already in target');
    const target = await newSpace(ws, 'Occupied target');
    await as('POST', `/workspaces/${ws}/databases`, { space_id: target, name: pack.databases[0]!.name });
    const res = await install(ws, pack, target);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(pack.databases[0]!.name);
  });

  it('with no target, a database that is already in the pack\'s own named space is still a 409', async () => {
    const ws = await newWs('Already in own space');
    const own = await newSpace(ws, pack.databases[0]!.space);
    await as('POST', `/workspaces/${ws}/databases`, { space_id: own, name: pack.databases[0]!.name });
    const res = await install(ws, pack);
    expect(res.statusCode, res.body).toBe(409);
  });

  it('a guest cannot install or preview at all (403), so a refusal can never describe databases they cannot see', async () => {
    const ws = await newWs('Guest');
    const secret = await newSpace(ws, 'Hidden space');
    await as('POST', `/workspaces/${ws}/databases`, { space_id: secret, name: pack.databases[0]!.name });
    const visible = await newSpace(ws, 'Shared with the guest');
    const invite = await as('POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ space_id: visible, role: 'viewer' }] });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as('POST', '/invites/accept', { token }, guest.token);
    for (const path of ['install', 'preview']) {
      const res = await as('POST', `/workspaces/${ws}/packs/${path}`, { manifest: pack, target_space_id: secret }, guest.token);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(403);
      expect(res.body).not.toContain('Hidden space');
    }
    // ...and the guest really cannot see the hidden database, so the 403 is not hiding an install they could have made.
    const seen = (await as('GET', `/workspaces/${ws}/databases`, undefined, guest.token)).json() as Array<{ spaceId: string }>;
    expect(seen.some((d) => d.spaceId === secret)).toBe(false);
  });
});

/**
 * Otto's ruling on #1156: matching is per space by default, but sharing a database across packs stays when the person EXPLICITLY chooses
 * `reuse` for it in the review (Agency OS + Consulting OS on one Clients list), provided they can edit it.
 */
describe('#1156 deliberate sharing: an explicit reuse adopts a database from another space', () => {
  interface PackM { slug: string; name: string; databases: Array<{ name: string; space: string }>; relations: Array<{ from: string; to: string; from_field: string }> }
  let agency: PackM;
  let consulting: PackM;
  /** Consulting OS with Clients.Status a select, like Agency OS's: every field fits, so Clients is reusable. */
  let compat: PackM;
  const notFound = (db: string) => `There is no ${db} database you can edit.`;
  const norm = (s: string) => s.trim().toLowerCase();
  const reuseClients = { Clients: { action: 'reuse' } };
  const withResolutions = (ws: string, manifest: unknown, resolutions?: unknown) =>
    as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...(resolutions ? { resolutions } : {}) });
  const clientsOf = async (ws: string) => (await dbsOf(ws)).filter((d) => d.name === 'Clients');
  const recordCount = async (ws: string, id: string) => ((await as('GET', `/workspaces/${ws}/databases/${id}/records?limit=200`)).json() as { data: unknown[] }).data.length;

  beforeAll(async () => {
    const get = async (slug: string) => ((await as('GET', `/packs/registry/${slug}`)).json() as { manifest: PackM }).manifest;
    agency = await get('agency-os');
    consulting = await get('consulting-os');
    compat = JSON.parse(JSON.stringify(consulting)) as PackM;
    const status = (compat.databases.find((d) => d.name === 'Clients') as unknown as { fields: Array<{ name: string; type: string }> }).fields.find((f) => f.name === 'Status')!;
    expect(status.type, 'the real Consulting OS needs a workflow here').toBe('workflow');
    status.type = 'select';
    expect(agency.databases.find((d) => d.name === 'Clients')).toBeTruthy();
    expect(consulting.databases.find((d) => d.name === 'Clients')).toBeTruthy();
    expect(norm(agency.databases.find((d) => d.name === 'Clients')!.space), 'the two packs keep Clients in different spaces').not.toBe(norm(consulting.databases.find((d) => d.name === 'Clients')!.space));
  });

  async function agencyThenConsulting() {
    const ws = await newWs('Sharing Clients');
    expect((await install(ws, agency)).statusCode).toBe(201);
    const [agencyClients] = await clientsOf(ws);
    return { ws, agencyClients: agencyClients!, records: await recordCount(ws, agencyClients!.id) };
  }

  it('by explicit choice, Consulting OS adopts Agency OS\'s Clients across spaces: one Clients, relations point at it', async () => {
    const { ws, agencyClients } = await agencyThenConsulting();
    const res = await withResolutions(ws, compat, reuseClients);
    expect(res.statusCode, res.body).toBe(201);
    const clients = await clientsOf(ws);
    expect(clients.map((d) => d.id), 'no duplicate Clients').toEqual([agencyClients.id]);
    expect((res.json().databases as Array<{ name: string; action: string; id: string }>).find((d) => d.name === 'Clients')).toMatchObject({ action: 'reused', id: agencyClients.id });
    const rel = compat.relations.find((r) => r.to === 'Clients' || r.from === 'Clients');
    expect(rel, 'Consulting OS has a relation on Clients').toBeTruthy();
    const all = await dbsOf(ws);
    const other = (name: string) => all.find((d) => d.name === name && d.spaceId !== agencyClients.spaceId)!.id;
    const fromId = rel!.from === 'Clients' ? agencyClients.id : other(rel!.from);
    const toId = rel!.to === 'Clients' ? agencyClients.id : other(rel!.to);
    const field = (await detail(ws, fromId)).fields.find((f) => f.type === 'relation' && f.displayName === rel!.from_field);
    expect(field?.relation?.target_database_id).toBe(toId);
  });

  it('the preview names the database and the space it would adopt, and only says "could" until reuse is chosen', async () => {
    const { ws, agencyClients } = await agencyThenConsulting();
    const spaces = (await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    const space = spaces.find((s) => s.id === agencyClients.spaceId)!.name;
    const plain = (await preview(ws, compat)).json().databases.find((d: { name: string }) => d.name === 'Clients');
    expect(plain.action).toBe('create');
    expect(plain.existing_elsewhere).toEqual({ database_id: agencyClients.id, space_name: space, adopted: false, reusable: true });
    const chosen = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: compat, resolutions: reuseClients });
    expect(chosen.statusCode, chosen.body).toBe(201);
    expect(chosen.json().databases.find((d: { name: string }) => d.name === 'Clients').existing_elsewhere).toEqual({ database_id: agencyClients.id, space_name: space, adopted: true, reusable: true });
  });

  it('without the explicit choice nothing is adopted: Consulting OS gets its own Clients and Agency OS\'s is untouched', async () => {
    const { ws, agencyClients, records } = await agencyThenConsulting();
    const fields = (await detail(ws, agencyClients.id)).fields.length;
    const res = await install(ws, consulting);
    expect(res.statusCode, res.body).toBe(201);
    expect((await clientsOf(ws)).length).toBe(2);
    expect((await detail(ws, agencyClients.id)).fields.length).toBe(fields);
    expect(await recordCount(ws, agencyClients.id)).toBe(records);
  });

  it('a database the installer cannot EDIT is not adopted, and the refusal reads exactly like one for a database that does not exist', async () => {
    const { ws, agencyClients } = await agencyThenConsulting();
    const empty = await newWs('Nothing to adopt');
    const dbs = app.get(DatabasesService, { strict: false });
    const real = dbs.list.bind(dbs);
    const spy = vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) =>
      (await real(...a)).map((d) => (d.id === agencyClients.id ? { ...d, my_access: 'viewer' as const } : d))) as never);
    try {
      const viewerOnly = await withResolutions(ws, consulting, reuseClients);
      expect(viewerOnly.statusCode, viewerOnly.body).toBe(422);
      const noSuchDb = await withResolutions(empty, consulting, reuseClients);
      expect(noSuchDb.statusCode, noSuchDb.body).toBe(422);
      expect(viewerOnly.json().error.message, 'same words whether it is read-only or absent').toBe(noSuchDb.json().error.message);
      expect(viewerOnly.body).not.toContain(agencyClients.id);
      expect(viewerOnly.body).not.toContain(agency.databases.find((d) => d.name === 'Clients')!.space);
      const pv = (await preview(ws, consulting)).json().databases.find((d: { name: string }) => d.name === 'Clients');
      expect(pv.existing_elsewhere, 'the preview says only what it says for a database that is not there: no id, no space').toEqual({ adopted: false, reusable: false, reason: notFound('Clients') });
      expect(viewerOnly.json().error.message).toBe(notFound('Clients'));
      expect((await clientsOf(ws)).length, 'nothing was created or adopted').toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('with two editable databases of that name elsewhere, an explicit reuse is refused as ambiguous rather than guessed', async () => {
    const { ws } = await agencyThenConsulting();
    const other = await newSpace(ws, 'Second clients list');
    await as('POST', `/workspaces/${ws}/databases`, { space_id: other, name: 'Clients' });
    const res = await withResolutions(ws, consulting, reuseClients);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toBe("Can't use one: you have more than one Clients database (in Client Work and Second clients list). Create a new one here.");
  });

  it('uninstalling the adopting pack never deletes the adopted database or its data', async () => {
    const { ws, agencyClients, records } = await agencyThenConsulting();
    expect((await withResolutions(ws, compat, reuseClients)).statusCode).toBe(201);
    const withBoth = await recordCount(ws, agencyClients.id);
    expect(withBoth, 'the adopting pack added its sample client').toBeGreaterThanOrEqual(records);
    const installed = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    const un = await as('POST', `/workspaces/${ws}/packs/${installed.find((i) => i.slug === compat.slug)!.id}/uninstall`, {});
    expect(un.statusCode, un.body).toBeLessThan(300);
    expect((await clientsOf(ws)).map((d) => d.id)).toEqual([agencyClients.id]);
    expect(await recordCount(ws, agencyClients.id), 'no record of the adopted database was deleted').toBe(withBoth);
  });

  it('re-installing the adopting pack is idempotent, with or without repeating the choice', async () => {
    const { ws, agencyClients } = await agencyThenConsulting();
    expect((await withResolutions(ws, compat, reuseClients)).statusCode).toBe(201);
    const first = (await dbsOf(ws)).map((d) => d.id).sort();
    for (const resolutions of [reuseClients, undefined]) {
      const again = await withResolutions(ws, compat, resolutions);
      expect(again.statusCode, again.body).toBe(201);
      expect((await dbsOf(ws)).map((d) => d.id).sort(), 'nothing duplicated').toEqual(first);
      expect((await clientsOf(ws)).map((d) => d.id)).toEqual([agencyClients.id]);
    }
  });
});

/** The wording Dara and Iris show next to a disabled "use existing". */
describe('#1156 existing_elsewhere says whether the database can be reused, and why not', () => {
  const pvClients = (body: { databases: Array<{ name: string; existing_elsewhere?: Record<string, unknown> }> }) => body.databases.find((d) => d.name === 'Clients');
  async function consultingManifest() {
    return ((await as('GET', '/packs/registry/consulting-os')).json() as { manifest: { slug: string; databases: Array<{ name: string; space: string; fields: Array<{ name: string; type: string }> }> } }).manifest;
  }
  async function agencyManifest() {
    return ((await as('GET', '/packs/registry/agency-os')).json() as { manifest: unknown }).manifest;
  }
  /** Make the installer's access to the named databases read-only, or hide them from the installer altogether. */
  function limitAccess(ids: string[], mode: 'viewer' | 'hidden') {
    const dbs = app.get(DatabasesService, { strict: false });
    const real = dbs.list.bind(dbs);
    return vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) => {
      const all = await real(...a);
      if (mode === 'hidden') return all.filter((d) => !ids.includes(d.id));
      return all.map((d) => (ids.includes(d.id) ? { ...d, my_access: 'viewer' as const } : d));
    }) as never);
  }
  async function threeClients() {
    const ws = await newWs('Three Clients');
    const made: Record<string, string> = {};
    for (const space of ['Alpha', 'Bravo', 'Hidden Charlie']) {
      const sid = await newSpace(ws, space);
      made[space] = (await as('POST', `/workspaces/${ws}/databases`, { space_id: sid, name: 'Clients' })).json().id as string;
    }
    return { ws, made };
  }

  it('a field of another type makes it not reusable: the reason names the field and BOTH types, and an install with reuse says the same', async () => {
    const ws = await newWs('Type mismatch');
    expect((await install(ws, await agencyManifest())).statusCode).toBe(201); // Agency OS's Clients.Status is a select
    const consulting = await consultingManifest(); // Consulting OS needs Clients.Status to be a workflow
    const reason = 'Status is a select here but this pack needs a workflow.';
    const plain = pvClients((await preview(ws, consulting)).json());
    expect(plain!.existing_elsewhere).toMatchObject({ adopted: false, reusable: false, reason });
    const chosen = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: consulting, resolutions: { Clients: { action: 'reuse' } } });
    expect(chosen.statusCode, 'the preview reports it, it does not refuse').toBe(201);
    expect(pvClients(chosen.json())!.existing_elsewhere).toMatchObject({ adopted: false, reusable: false, reason });
    const before = (await dbsOf(ws)).length;
    const res = await install(ws, consulting);
    expect(res.statusCode, 'without the choice it still installs its own').toBe(201);
    const ws2 = await newWs('Type mismatch install');
    expect((await install(ws2, await agencyManifest())).statusCode).toBe(201);
    const refused = await as('POST', `/workspaces/${ws2}/packs/install`, { manifest: consulting, resolutions: { Clients: { action: 'reuse' } } });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.message).toBe(reason);
    expect((await dbsOf(ws2)).filter((d) => d.name === 'Clients').length, 'nothing adopted, nothing created').toBe(1);
    expect(before).toBeGreaterThan(0);
  });

  it('reusable is true, with no reason, when every field fits', async () => {
    const ws = await newWs('Reusable');
    expect((await install(ws, await agencyManifest())).statusCode).toBe(201);
    const consulting = JSON.parse(JSON.stringify(await consultingManifest()));
    consulting.databases.find((d: { name: string }) => d.name === 'Clients').fields.find((f: { name: string }) => f.name === 'Status').type = 'select';
    const hint = pvClients((await preview(ws, consulting)).json())!.existing_elsewhere!;
    expect(hint.reusable).toBe(true);
    expect(hint.reason).toBeUndefined();
  });

  it('two editable databases of that name: not reusable, and the reason names exactly their spaces in Dara\'s words', async () => {
    const { ws, made } = await threeClients();
    const spy = limitAccess([made['Hidden Charlie']!], 'viewer');
    try {
      const res = await preview(ws, await consultingManifest());
      const hint = pvClients(res.json())!.existing_elsewhere!;
      expect(hint).toEqual({ adopted: false, reusable: false, reason: "Can't use one: you have more than one Clients database (in Alpha and Bravo). Create a new one here." });
      // the leak check: the database the installer cannot edit is neither named nor counted, and nothing identifies any database
      expect(res.body).not.toContain('Charlie');
      expect(res.body).not.toContain(made['Hidden Charlie']);
      const refused = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: await consultingManifest(), resolutions: { Clients: { action: 'reuse' } } });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.message).toBe(hint.reason);
      expect(refused.body).not.toContain('Charlie');
    } finally {
      spy.mockRestore();
    }
  });

  it('three editable names read "A, B and C"; two editable become reusable once only one can be edited', async () => {
    const { ws, made } = await threeClients();
    const all = pvClients((await preview(ws, await consultingManifest())).json())!.existing_elsewhere!;
    expect(all.reason).toBe("Can't use one: you have more than one Clients database (in Alpha, Bravo and Hidden Charlie). Create a new one here.");
    const spy = limitAccess([made['Hidden Charlie']!, made['Bravo']!], 'viewer');
    try {
      const one = pvClients((await preview(ws, await consultingManifest())).json())!.existing_elsewhere!;
      expect(one.reason ?? '', 'one editable match is not ambiguous').not.toContain('more than one');
      expect(one.database_id).toBe(made['Alpha']);
    } finally {
      spy.mockRestore();
    }
  });

  it('without edit access: the wording is the one for a database that is not there, and one the installer cannot even read leaves no trace', async () => {
    const { ws, made } = await threeClients();
    const spy = limitAccess(Object.values(made), 'viewer');
    try {
      const hint = pvClients((await preview(ws, await consultingManifest())).json())!.existing_elsewhere!;
      expect(hint).toEqual({ adopted: false, reusable: false, reason: 'There is no Clients database you can edit.' });
      const empty = await newWs('No Clients anywhere');
      const absent = await as('POST', `/workspaces/${empty}/packs/install`, { manifest: await consultingManifest(), resolutions: { Clients: { action: 'reuse' } } });
      expect(absent.json().error.message, 'identical to the refusal for a database that does not exist').toBe(hint.reason);
    } finally {
      spy.mockRestore();
    }
    const hidden = limitAccess(Object.values(made), 'hidden');
    try {
      const res = await preview(ws, await consultingManifest());
      expect(pvClients(res.json())!.existing_elsewhere, 'not even the object appears').toBeUndefined();
      expect(res.body).not.toContain('Hidden Charlie');
    } finally {
      hidden.mockRestore();
    }
  });
});

/**
 * Vera's send-back of #1338 (data loss): a same-named database the install did NOT create must never be written to just because this pack
 * was installed once somewhere else. A tracked database is the one whose id the install recorded, not the one whose name matches.
 */
describe('#1156 a database is "the pack\'s own" only by the id the install recorded', () => {
  const NAME = () => pack.databases[0]!.name;
  const records = async (ws: string, id: string) => ((await as('GET', `/workspaces/${ws}/databases/${id}/records?limit=200`)).json() as { data: unknown[] }).data.length;
  /** The user's OWN database of the pack's first database's name, in a space of their own, with one field and one record. */
  async function foreignIn(ws: string, spaceName: string) {
    const space = await newSpace(ws, spaceName);
    const id = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: NAME() })).json().id as string;
    await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Mine only', type: 'text' });
    await as('POST', `/workspaces/${ws}/databases/${id}/records`, { values: { name: 'My own row' } });
    return { space, id, fields: (await detail(ws, id)).fields.length, records: await records(ws, id) };
  }
  const unchanged = async (ws: string, f: Awaited<ReturnType<typeof foreignIn>>) => {
    expect((await detail(ws, f.id)).fields.length, 'no pack field was added to the user\'s database').toBe(f.fields);
    expect(await records(ws, f.id), 'no sample record was written into the user\'s database').toBe(f.records);
  };

  it('Vera\'s repro: installed once, then re-installed into a space holding the user\'s own same-named database: refused, theirs untouched', async () => {
    const ws = await newWs('Foreign after install');
    expect((await install(ws, pack)).statusCode).toBe(201);
    const mine = await foreignIn(ws, 'Same');
    const res = await install(ws, pack, mine.space);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(NAME());
    await unchanged(ws, mine);
    const pv = (await preview(ws, pack, mine.space)).json().databases.find((d: { name: string }) => d.name === NAME());
    expect(pv.action, 'the preview agrees: a collision, not a reuse').toBe('collision');
  });

  it('a tracked database is matched by its id even after the user renamed it: re-install reuses it and creates no second one', async () => {
    const ws = await newWs('Renamed tracked');
    const target = await newSpace(ws, 'Renamed target');
    expect((await install(ws, pack, target)).statusCode).toBe(201);
    const mine = (await dbsOf(ws)).find((d) => d.name === NAME() && d.spaceId === target)!;
    expect((await as('PATCH', `/workspaces/${ws}/databases/${mine.id}`, { name: 'Renamed by the user' })).statusCode).toBeLessThan(300);
    const before = (await dbsOf(ws)).map((d) => d.id).sort();
    const again = await install(ws, pack, target);
    expect(again.statusCode, again.body).toBe(201);
    expect((await dbsOf(ws)).map((d) => d.id).sort(), 'nothing duplicated').toEqual(before);
    expect((again.json().databases as Array<{ name: string; id: string; action: string }>).find((d) => d.name === NAME())).toMatchObject({ id: mine.id, action: 'reused' });
  });

  it('with an explicit reuse AND edit access the user\'s database is adopted (and only then)', async () => {
    const ws = await newWs('Foreign explicit reuse');
    expect((await install(ws, pack)).statusCode).toBe(201);
    const mine = await foreignIn(ws, 'Same');
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: pack, target_space_id: mine.space, resolutions: { [NAME()]: { action: 'reuse' } } });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().databases as Array<{ name: string; id: string; action: string }>).find((d) => d.name === NAME())).toMatchObject({ id: mine.id, action: 'reused' });
    expect((await detail(ws, mine.id)).fields.length, 'the chosen adoption adds the pack\'s fields').toBeGreaterThan(mine.fields);
  });

  it('with an explicit reuse but NO edit access: the same refusal as for a database that is not there, and nothing is written', async () => {
    const ws = await newWs('Foreign no edit');
    expect((await install(ws, pack)).statusCode).toBe(201);
    const mine = await foreignIn(ws, 'Same');
    const dbs = app.get(DatabasesService, { strict: false });
    const real = dbs.list.bind(dbs);
    const spy = vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) =>
      (await real(...a)).map((d) => (d.id === mine.id ? { ...d, my_access: 'viewer' as const } : d))) as never);
    try {
      const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: pack, target_space_id: mine.space, resolutions: { [NAME()]: { action: 'reuse' } } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.message).toBe(`There is no ${NAME()} database you can edit.`);
    } finally {
      spy.mockRestore();
    }
    await unchanged(ws, mine);
  });
});
