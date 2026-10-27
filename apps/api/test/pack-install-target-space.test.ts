import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1095 — install a pack INTO an existing space. The empty space page offers a pack in one click; before this the install endpoint
 * took no target, so installing from a new empty space left it empty and made a second space.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let single: { slug: string; manifest: Manifest };
/** A single-space pack with NO agents: installing it must not create ANY space (an agent pack also provisions the system Agentic OS space, as before). */
let plain: { slug: string; manifest: Manifest } | undefined;
let multi: { slug: string; manifest: Manifest };

interface Manifest { slug: string; name: string; databases: Array<{ name: string; space: string }>; agents?: unknown[]; views?: unknown[]; automations?: unknown[] }

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const newSpace = async (ws: string, name: string) => (await as('POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
const spacesOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string; personal?: boolean }>);
const dbsOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name !== 'Members');
const install = (ws: string, manifest: unknown, target?: string) => as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...(target ? { target_space_id: target } : {}) });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Pack Target');
  const list = (await as('GET', '/packs/registry')).json() as { data?: Array<{ slug: string }> } | Array<{ slug: string }>;
  const slugs = (Array.isArray(list) ? list : list.data ?? []).map((p) => p.slug);
  for (const slug of slugs) {
    const manifest = ((await as('GET', `/packs/registry/${slug}`)).json() as { manifest?: Manifest }).manifest;
    if (!manifest) continue;
    const spaces = new Set(manifest.databases.map((d) => d.space.trim().toLowerCase()));
    if (spaces.size === 1 && manifest.databases.length >= 2 && !single) single = { slug, manifest };
    if (spaces.size === 1 && manifest.databases.length >= 2 && !plain && !(manifest.agents?.length)) plain = { slug, manifest };
  }
  expect(single, 'the registry has a single-space pack').toBeTruthy();
  // No built-in pack spreads over several spaces, so make one: the same pack with its second database moved to another space.
  const spread = JSON.parse(JSON.stringify(single.manifest)) as Manifest;
  spread.slug = `${spread.slug}-spread`;
  spread.databases[1]!.space = `${spread.databases[1]!.space} (elsewhere)`;
  multi = { slug: spread.slug, manifest: spread };
}, 180_000);
afterAll(async () => { await app.close(); });

describe('#1095 install into an existing space', () => {
  it('every database lands in the target space, and no space is created', async () => {
    const ws = await newWs('Target install');
    const target = await newSpace(ws, 'My empty space');
    const before = (await spacesOf(ws)).map((s) => s.id);
    const res = await install(ws, single.manifest, target);
    expect(res.statusCode, res.body).toBe(201);
    // The pack's OWN content space is never created. A pack WITH agents also needs the system Agentic OS space, and only that one.
    const made = (await spacesOf(ws)).filter((s) => !before.includes(s.id)).map((s) => s.name);
    expect(made.filter((n) => n !== 'Agentic OS'), 'no space other than the Agentic OS system space').toEqual([]);
    if (!(single.manifest.agents?.length)) expect(made, 'a pack without agents creates no space at all').toEqual([]);
    if (plain) {
      const ws2 = await newWs('Target install, no agents');
      const t2 = await newSpace(ws2, 'Another empty space');
      const b2 = (await spacesOf(ws2)).length;
      expect((await install(ws2, plain.manifest, t2)).statusCode).toBe(201);
      expect((await spacesOf(ws2)).length, 'a pack without agents creates NO space at all').toBe(b2);
    }
    const packDbs = (await dbsOf(ws)).filter((d) => single.manifest.databases.some((m) => m.name === d.name));
    expect(packDbs.length).toBe(single.manifest.databases.length);
    for (const d of packDbs) expect(d.spaceId, `${d.name} is in the target space`).toBe(target);
    expect(res.json().spaces).toEqual([{ name: 'My empty space', action: 'reused', id: target }]);
  });

  it('views and automations came along (they belong to the databases that are in the target)', async () => {
    const ws = await newWs('Target content');
    const target = await newSpace(ws, 'Content space');
    const res = await install(ws, single.manifest, target);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.views.length + body.automations.length + body.sample_records.length, 'the pack installed more than databases').toBeGreaterThan(0);
  });

  it('installing twice into the same space creates nothing the second time', async () => {
    const ws = await newWs('Target twice');
    const target = await newSpace(ws, 'Twice space');
    expect((await install(ws, single.manifest, target)).statusCode).toBe(201);
    const dbsAfterFirst = (await dbsOf(ws)).map((d) => d.id).sort();
    const again = await install(ws, single.manifest, target);
    expect(again.statusCode, again.body).toBe(201);
    expect((await dbsOf(ws)).map((d) => d.id).sort(), 'no database duplicated').toEqual(dbsAfterFirst);
    expect((again.json().databases as Array<{ action: string }>).every((d) => d.action === 'reused')).toBe(true);
  });

  it('install with NO target is exactly as before: it creates the pack\'s own space', async () => {
    const ws = await newWs('No target');
    const before = (await spacesOf(ws)).map((s) => s.name);
    const res = await install(ws, single.manifest);
    expect(res.statusCode, res.body).toBe(201);
    const wanted = single.manifest.databases[0]!.space;
    expect((await spacesOf(ws)).some((s) => s.name === wanted), 'its own space exists').toBe(true);
    expect(before).not.toContain(wanted);
  });
});

describe('#1095 what is refused', () => {
  it('a manifest with more than one space and a target is refused 422 naming the spaces, and nothing is created', async () => {
    const ws = await newWs('Multi space');
    const target = await newSpace(ws, 'Target');
    const res = await install(ws, multi.manifest, target);
    expect(res.statusCode, res.body).toBe(422);
    for (const s of new Set(multi.manifest.databases.map((d) => d.space))) expect(res.body).toContain(s);
    expect((await dbsOf(ws)).length, 'nothing was created').toBe(0);
  });

  it('a database that already lives in ANOTHER space is a 409 naming where, not a silent reuse that leaves the target empty', async () => {
    const ws = await newWs('Elsewhere');
    expect((await install(ws, single.manifest)).statusCode).toBe(201); // lands in the pack's own space
    const target = await newSpace(ws, 'Different space');
    const res = await install(ws, single.manifest, target);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.body).toContain(single.manifest.databases[0]!.space);
    expect((await dbsOf(ws)).filter((d) => d.spaceId === target), 'the target space stays empty').toEqual([]);
  });

  it('a space the caller cannot reach is a 404: another workspace\'s space, and someone else\'s personal space', async () => {
    const ws = await newWs('Unreachable');
    const otherWs = await newWs('Other workspace');
    const foreign = await newSpace(otherWs, 'Foreign');
    expect((await install(ws, single.manifest, foreign)).statusCode).toBe(404);
    const other = await signUpUser(app, 'Space Owner');
    const w2 = await newWs('Personal');
    const inv = await as('POST', `/workspaces/${w2}/invites`, { email: other.email, role: 'member' });
    await as('POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! }, other.token);
    const personal = (await as('POST', `/workspaces/${w2}/spaces/personal`, {}, other.token)).json() as { id?: string };
    if (personal.id) expect((await install(w2, single.manifest, personal.id)).statusCode, "an admin cannot target someone else's personal space").toBe(404);
  });

  it('your OWN personal space is refused 422: it holds documents and views, not databases', async () => {
    const ws = await newWs('Own personal');
    const personal = (await as('POST', `/workspaces/${ws}/spaces/personal`, {})).json() as { id?: string };
    if (personal.id) {
      const res = await install(ws, single.manifest, personal.id);
      expect(res.statusCode, res.body).toBe(422);
    }
  });

  it('a malformed target id is a 4xx, never a 500', async () => {
    const ws = await newWs('Bad id');
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: single.manifest, target_space_id: 'not-a-uuid' });
    expect(res.statusCode).toBeLessThan(500);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('#1095 preview and uninstall agree with install', () => {
  it('preview takes the same target and gives the same refusals, creating nothing', async () => {
    const ws = await newWs('Preview target');
    const target = await newSpace(ws, 'Preview space');
    const ok = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: single.manifest, target_space_id: target });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await dbsOf(ws)).length).toBe(0);
    const bad = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: multi.manifest, target_space_id: target });
    expect(bad.statusCode).toBe(422);
  });

  it('uninstalling removes the pack\'s content but never the space it was installed into', async () => {
    const ws = await newWs('Uninstall target');
    const target = await newSpace(ws, 'Keep this space');
    expect((await install(ws, single.manifest, target)).statusCode).toBe(201);
    const installed = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    const mine = installed.find((i) => i.slug === single.manifest.slug)!;
    const un = await as('POST', `/workspaces/${ws}/packs/${mine.id}/uninstall`, {});
    expect(un.statusCode, un.body).toBeLessThan(300);
    expect((await spacesOf(ws)).some((s) => s.id === target), 'the target space survives').toBe(true);
  });
});
