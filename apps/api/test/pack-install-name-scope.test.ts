import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

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
