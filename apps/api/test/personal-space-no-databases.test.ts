import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { databases, memberships, spaceDocuments, spaces } from '../src/db/schema';
import { DatabasesService } from '../src/databases/databases.service';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #1173 — a PERSONAL space holds documents and views only (personal-space.md §2). `POST /databases` already refused a
 * personal space; `PATCH /databases/:db` with `space_id` did not, so a database could be MOVED into one, becoming private from
 * admins and excluded from export. One shared guard (`AccessService.assertDatabaseHome` / `spaceCanHoldDatabases`) now stands on
 * every path that places a database; this file has one test per path, and each asserts the refusal AND that nothing changed.
 */
const REASON = 'A personal space holds documents and views only, so a database cannot live there.';

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string };
let alice: { token: string };
let bob: { token: string };
let wsId: string;
let shared: string;
let sharedB: string;
let alicePersonal: string;
let bobPersonal: string;
let adminPersonal: { id: string; name: string };
let aliceDb: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const refusal = (r: { json(): { error: Record<string, unknown> } }) => { const { request_id: _r, ...rest } = r.json().error; return rest; };
const dbRows = () => db.query.databases.findMany({ where: eq(databases.workspaceId, wsId) });
const rowOf = async (id: string) => (await db.query.databases.findFirst({ where: eq(databases.id, id) }))!;
const newDb = async (space: string, name: string) =>
  (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name })).json().id as string;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'NoDbAdmin');
  alice = await signUpUser(app, 'NoDbAlice');
  bob = await signUpUser(app, 'NoDbBob');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'No DB in personal' })).json().id;
  shared = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  sharedB = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Second shared space' })).json().id;
  for (const u of [alice, bob]) {
    const id = (await as(u.token, 'GET', '/me')).json().id as string;
    await db.insert(memberships).values({ workspaceId: wsId, userId: id, role: 'member' });
  }
  alicePersonal = (await as(alice.token, 'POST', `/workspaces/${wsId}/spaces/personal`)).json().id;
  bobPersonal = (await as(bob.token, 'POST', `/workspaces/${wsId}/spaces/personal`)).json().id;
  adminPersonal = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/personal`)).json();
  aliceDb = await newDb(shared, 'Alice shared database');
}, 60_000);
afterAll(async () => { await app.close(); });

describe('REST PATCH /databases/:db — moving a database into a personal space', () => {
  it('the owner of the personal space cannot move a database into it: 422 with the reason, and the database has not moved', async () => {
    const before = await rowOf(aliceDb);
    const res = await as(alice.token, 'PATCH', `/workspaces/${wsId}/databases/${aliceDb}`, { space_id: alicePersonal });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toBe(REASON);
    const after = await rowOf(aliceDb);
    expect(after.spaceId).toBe(before.spaceId);
    expect(after.apiSlug).toBe(before.apiSlug);
  });

  it('a rename that rides along with the refused move is refused whole (nothing is half-applied)', async () => {
    const res = await as(alice.token, 'PATCH', `/workspaces/${wsId}/databases/${aliceDb}`, { name: 'Sneaky rename', space_id: alicePersonal });
    expect(res.statusCode, res.body).toBe(422);
    expect((await rowOf(aliceDb)).name).toBe('Alice shared database');
  });

  it("another member naming ALICE's personal space answers exactly like a space that does not exist (404, ADR-0018 b)", async () => {
    const bobDb = await newDb(shared, 'Bob move target');
    const theirs = await as(bob.token, 'PATCH', `/workspaces/${wsId}/databases/${bobDb}`, { space_id: alicePersonal });
    const nowhere = await as(bob.token, 'PATCH', `/workspaces/${wsId}/databases/${bobDb}`, { space_id: '00000000-0000-4000-8000-000000000000' });
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(nowhere.statusCode).toBe(404);
    expect(refusal(theirs)).toEqual(refusal(nowhere));
    expect((await rowOf(bobDb)).spaceId).toBe(shared);
  });

  it("an ADMIN naming someone's personal space also gets the plain 404", async () => {
    const res = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${aliceDb}`, { space_id: bobPersonal });
    expect(res.statusCode, res.body).toBe(404);
    expect((await rowOf(aliceDb)).spaceId).toBe(shared);
  });

  it('the service refuses on its own, so a caller that skips the controller pre-check is still stopped', async () => {
    const aliceId = (await as(alice.token, 'GET', '/me')).json().id as string;
    const svc = app.get(DatabasesService);
    await expect(
      svc.update({ workspaceId: wsId, userId: aliceId, role: 'member' } as never, aliceDb, { space_id: alicePersonal }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await rowOf(aliceDb)).spaceId).toBe(shared);
  });

  it('MUST KEEP WORKING: moving a database between ordinary spaces, and a rename in place', async () => {
    const id = await newDb(shared, 'Mover');
    const moved = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${id}`, { space_id: sharedB });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await rowOf(id)).spaceId).toBe(sharedB);
    const renamed = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${id}`, { name: 'Mover renamed', space_id: sharedB });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });
});

describe('REST POST /databases — creating a database in a personal space', () => {
  it('own personal space: 422 with the reason and no row created', async () => {
    const before = (await dbRows()).length;
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: alicePersonal, name: 'Secret DB' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toBe(REASON);
    expect((await dbRows()).length).toBe(before);
  });

  it("someone else's personal space answers exactly like a missing space (404)", async () => {
    const theirs = await as(bob.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: alicePersonal, name: 'Peek' });
    const nowhere = await as(bob.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: '00000000-0000-4000-8000-000000000000', name: 'Peek' });
    expect(theirs.statusCode, theirs.body).toBe(404);
    expect(refusal(theirs)).toEqual(refusal(nowhere));
  });

  it('MUST KEEP WORKING: an ordinary space still takes a database', async () => {
    expect((await as(alice.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: shared, name: 'Fine' })).statusCode).toBe(201);
  });
});

describe('template apply, duplicate, pack install and the Architect — every other path that places a database', () => {
  it('apply_template (database template) into a personal space: 422 and nothing created', async () => {
    const before = (await dbRows()).length;
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/templates/funnels/apply`, { space_id: alicePersonal });
    expect(res.statusCode, res.body).toBe(422);
    expect((await dbRows()).length).toBe(before);
  });

  it('duplicate_database of a database that already sits in a personal space (legacy row) is refused, and no copy appears', async () => {
    const legacy = await newDb(shared, 'Legacy in personal');
    // Seeded directly: this is the state the production query in the PR looks for.
    await db.update(databases).set({ spaceId: alicePersonal }).where(eq(databases.id, legacy));
    const before = (await dbRows()).length;
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${legacy}/duplicate`, { name: 'Legacy copy' });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toContain('documents and views only');
    expect((await dbRows()).length).toBe(before);
    await db.delete(databases).where(eq(databases.id, legacy));
  });

  it('duplicate_database of an ordinary database still works and lands next to its source', async () => {
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${aliceDb}/duplicate`, { name: 'Alice copy' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect((await rowOf(res.json().id)).spaceId).toBe(shared);
  });

  describe('pack install', () => {
    let manifest: { slug: string; name: string; databases: Array<{ name: string; space: string }>; agents?: unknown[] };
    beforeAll(async () => {
      const list = (await as(admin.token, 'GET', '/packs/registry')).json() as { data?: Array<{ slug: string }> } | Array<{ slug: string }>;
      for (const { slug } of Array.isArray(list) ? list : (list.data ?? [])) {
        const m = ((await as(admin.token, 'GET', `/packs/registry/${slug}`)).json() as { manifest?: typeof manifest }).manifest;
        if (m && !(m.agents?.length) && m.databases.length >= 2 && new Set(m.databases.map((d) => d.space.toLowerCase())).size === 1) { manifest = m; break; }
      }
      expect(manifest, 'the registry has a plain single-space pack').toBeTruthy();
    }, 120_000);
    const install = (token: string, m: unknown, target?: string) =>
      as(token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest: m, ...(target ? { target_space_id: target } : {}) });

    it('target_space_id = the caller\'s personal space: 422, nothing built', async () => {
      const before = (await dbRows()).length;
      const res = await install(admin.token, manifest, adminPersonal.id);
      expect(res.statusCode, res.body).toBe(422);
      expect((await dbRows()).length).toBe(before);
    });

    it("target_space_id = someone else's personal space answers like a missing space (404)", async () => {
      const theirs = await install(admin.token, manifest, alicePersonal);
      const nowhere = await install(admin.token, manifest, '00000000-0000-4000-8000-000000000000');
      expect(theirs.statusCode, theirs.body).toBe(404);
      expect(refusal(theirs)).toEqual(refusal(nowhere));
    });

    it("a manifest whose `space` NAMES the caller's personal space is refused, and the install leaves nothing behind", async () => {
      const personalName = (await db.query.spaces.findFirst({ where: eq(spaces.id, adminPersonal.id) }))!.name;
      const named = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
      named.slug = `${manifest.slug}-into-personal`;
      for (const d of named.databases) d.space = personalName;
      const before = (await dbRows()).length;
      const res = await install(admin.token, named);
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).toContain('documents and views only');
      expect((await dbRows()).length, 'no database was left behind').toBe(before);
      const inPersonal = await db.query.databases.findMany({ where: eq(databases.spaceId, adminPersonal.id) });
      expect(inPersonal).toEqual([]);
    });

    it('MUST KEEP WORKING: the same pack installs into an ordinary target space', async () => {
      const res = await install(admin.token, manifest, shared);
      expect(res.statusCode, res.body).toBe(201);
    });
  });

  it("build_schema (the Architect) with a planned space that NAMES the admin's personal space is refused, and builds nothing", async () => {
    
    const proposed = await as(admin.token, 'POST', `/workspaces/${wsId}/architect/propose`, {
      goal: 'When a lead arrives I want it to draft a reply and open a follow-up task, but nothing gets sent without me approving it',
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const plan = proposed.json() as { databases: Array<{ space: string }> };
    for (const d of plan.databases) d.space = adminPersonal.name;
    const before = (await dbRows()).length;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/architect/build`, { plan });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('documents and views only');
    expect((await dbRows()).length).toBe(before);
    expect((await db.query.databases.findMany({ where: eq(databases.spaceId, adminPersonal.id) })).length).toBe(0);
  });
});

describe('MUST KEEP WORKING in a personal space: documents and views', () => {
  it('a document can still be created in the personal space', async () => {
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/spaces/${alicePersonal}/documents`, { title: 'My note' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect((await db.query.spaceDocuments.findMany({ where: eq(spaceDocuments.spaceId, alicePersonal) })).length).toBeGreaterThan(0);
  });

  it('a personal VIEW on shared data still works', async () => {
    const res = await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${aliceDb}/views/personal`, { name: 'My lens', type: 'table', config: {} });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });
});

/**
 * The sweep. A path that places a database without the shared guard is how this shipped. Every write to `databases` in src/ is listed
 * here with why it is safe; a NEW file that inserts or updates `databases` fails this test until someone reads this comment.
 */
describe('sweep: nothing writes databases.spaceId behind the guard', () => {
  const srcRoot = join(__dirname, '..', 'src');
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  const writers = walk(srcRoot).filter((f) => /\.(insert|update)\(\s*(\w+\.)?databases(Table)?\s*\)/.test(readFileSync(f, 'utf8')));
  const rel = (f: string) => f.slice(srcRoot.length + 1);

  it('only the allow-listed files write the databases table', () => {
    expect(writers.map(rel).sort()).toEqual([
      'databases/databases.service.ts', // create (guarded) + update (guarded) + soft delete/restore (no space change)
      'icons/migrate-emoji-icons.ts', // icon only
      'records/records.service.ts', // record_counter only
    ]);
  });

  it('databases.service.ts routes BOTH create and update through the guard', () => {
    const src = readFileSync(join(srcRoot, 'databases', 'databases.service.ts'), 'utf8');
    const create = src.slice(src.indexOf('async create('), src.indexOf('async update('));
    const update = src.slice(src.indexOf('async update('), src.indexOf('async remove('));
    expect(create).toMatch(/assertDatabaseHome\(/);
    expect(update).toMatch(/assertSpaceCanHoldDatabases\(|assertDatabaseHome\(/);
    expect(src).toMatch(/assertDatabaseHome\(membership, destinationSpaceId/); // the controller's pre-check
  });

  it('every caller that finds a space BY NAME skips personal spaces or refuses them', () => {
    for (const f of ['agents/architect.service.ts', 'agents/agents.service.ts', 'integrations/linear.service.ts']) {
      expect(readFileSync(join(srcRoot, f), 'utf8'), f).toMatch(/spaceCanHoldDatabases|assertSpaceCanHoldDatabases/);
    }
  });

  // Keeps `and` imported for the helper below without widening the file's surface.
  it('personal spaces are keyed on the flag, never the name', async () => {
    const rows = await db.query.spaces.findMany({ where: and(eq(spaces.workspaceId, wsId), eq(spaces.personal, true)) });
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([alicePersonal, bobPersonal]));
  });
});
