import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema, type PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { platformAdmins } from '../src/db/schema';
import { PACK_REGISTRY } from '../src/packs/registry';

/**
 * Ticket #1145 — a pack manifest carries `why` (one sentence) and `can` (up to three lines), every BUILT-IN pack declares both,
 * and the pack listing (REST; MCP proxies it) returns them with each pack's relations.
 *
 * The built-in checks run over the WHOLE registry, not a sample: a pack added later without its text fails here. The expected
 * text is a frozen copy of the prototype's PACK_WHY (fixtures/pack-why-prototype.json) so "word for word" is a comparison, not a
 * hope. The prototype holds 22 entries; the repo has 9 built-ins today, and an entry for a slug that does not exist is
 * deliberately NOT carried in the fixture (it would be dead text).
 */
const PROTOTYPE = JSON.parse(
  readFileSync(new URL('./fixtures/pack-why-prototype.json', import.meta.url), 'utf8'),
) as Record<string, { why: string; can: string[] }>;

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string };
let operator: { token: string };

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => {
  const res = await as(admin.token, 'POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

const minimal = (extra: Record<string, unknown> = {}) => ({
  format_version: 1,
  slug: 'why-can-min',
  name: 'Why Can Min',
  version: '1.0.0',
  summary: 'A minimal pack',
  databases: [{ action: 'create', name: 'Things', space: 'Why Can Space', fields: [] }],
  ...extra,
});

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'WhyCan Author');
  operator = await signUpUser(app, 'WhyCan Operator');
  const me = await as(operator.token, 'GET', '/me');
  await db.insert(platformAdmins).values({ userId: me.json().id as string, grantedBy: null });
}, 60_000);
afterAll(async () => {
  await app?.close();
});

describe('manifest schema: why / can (#1145)', () => {
  const parse = (extra: Record<string, unknown>) => packManifestSchema.safeParse(minimal(extra));

  it('accepts a manifest WITHOUT them (community and exported manifests predate the fields)', () => {
    const r = parse({});
    expect(r.success).toBe(true);
    expect(r.success && r.data.why).toBeUndefined();
    expect(r.success && r.data.can).toBeUndefined();
  });

  it('accepts one sentence and one to three lines', () => {
    expect(parse({ why: 'You run client work and need to see what is slipping.', can: ['One'] }).success).toBe(true);
    expect(parse({ why: 'A.', can: ['One', 'Two', 'Three'] }).success).toBe(true);
    // a sentence that merely CONTAINS punctuation is still one sentence
    expect(parse({ why: 'Move people from Applied → Screening (or Not moving forward), 30/60/90 style.' }).success).toBe(true);
    expect(parse({ why: 'Is it 3.5 weeks or 4?' }).success).toBe(true);
  });

  it('REJECTS more than one sentence', () => {
    expect(parse({ why: 'You sell. Then you deliver.' }).success).toBe(false);
    expect(parse({ why: 'Where did it go? Nobody knows' }).success).toBe(false);
    expect(parse({ why: 'Stop! Look "now". Then go' }).success).toBe(false);
  });

  it('REJECTS an empty or over-long why, and more than three / zero / blank can lines', () => {
    expect(parse({ why: '' }).success).toBe(false);
    expect(parse({ why: 'x'.repeat(401) }).success).toBe(false);
    expect(parse({ can: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(parse({ can: [] }).success).toBe(false);
    expect(parse({ can: ['ok', '   '] }).success).toBe(false);
    expect(parse({ can: ['x'.repeat(301)] }).success).toBe(false);
  });
});

describe('the built-in packs declare why and can (#1145)', () => {
  it('the registry is not empty (the loops below would otherwise pass over nothing)', () => {
    expect(PACK_REGISTRY.length).toBeGreaterThanOrEqual(9);
  });

  it.each(PACK_REGISTRY.map((e) => [e.slug, e] as const))('%s: non-empty why and 1-3 can lines that validate', (_slug, entry) => {
    const m = entry.manifest;
    expect(m.why, 'why').toBeTruthy();
    expect(m.can?.length, 'can').toBeGreaterThanOrEqual(1);
    expect(m.can!.length).toBeLessThanOrEqual(3);
    expect(packManifestSchema.safeParse(m).success).toBe(true);
  });

  it('every built-in carries the prototype text word for word', () => {
    for (const e of PACK_REGISTRY) {
      const want = PROTOTYPE[e.slug];
      expect(want, `${e.slug}: no prototype text in the fixture`).toBeTruthy();
      expect({ slug: e.slug, why: e.manifest.why, can: e.manifest.can }).toEqual({ slug: e.slug, ...want });
    }
  });
});

describe('GET /packs/registry returns why, can and relations (#1145)', () => {
  it('for every pack in the listing, none skipped', async () => {
    const res = await as(admin.token, 'GET', '/packs/registry');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Array<{
      slug: string;
      why: string | null;
      can: string[];
      relations: Array<{ from: string; to: string; cardinality: string; from_field: string; to_field: string }>;
      manifest?: unknown;
    }>;
    expect(body.map((c) => c.slug).sort()).toEqual(PACK_REGISTRY.map((e) => e.slug).sort());
    for (const card of body) {
      const entry = PACK_REGISTRY.find((e) => e.slug === card.slug)!;
      expect(card.why, card.slug).toBe(entry.manifest.why);
      expect(card.can, card.slug).toEqual(entry.manifest.can);
      expect(card.relations, card.slug).toEqual(
        entry.manifest.relations.map(({ from, to, cardinality, from_field, to_field }) => ({ from, to, cardinality, from_field, to_field })),
      );
      expect(card.manifest, 'the manifest is not leaked into the listing').toBeUndefined();
    }
    // not vacuous: packs with relations really return some, including a self-relation
    expect(body.filter((c) => c.relations.length > 0).length).toBeGreaterThanOrEqual(5);
    expect(body.find((c) => c.slug === 'agency-os')!.relations).toContainEqual(
      expect.objectContaining({ from: 'Tasks', to: 'Tasks', cardinality: 'one_to_many' }),
    );
    // a pack with none returns an empty list, never undefined
    expect(body.find((c) => c.slug === 'support-inbox')!.relations).toEqual([]);
  });
});

describe('install and export (#1145)', () => {
  it('MUST KEEP WORKING: a manifest without why/can installs', async () => {
    const ws = await newWs('No why');
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: minimal() });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a built-in manifest with its why/can stripped still installs (an older community copy of it)', async () => {
    const ws = await newWs('Stripped');
    const { why: _w, can: _c, ...stripped } = PACK_REGISTRY.find((e) => e.slug === 'support-inbox')!.manifest as PackManifest;
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: stripped });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a manifest with a bad why is refused at install, naming the field', async () => {
    const ws = await newWs('Bad why');
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: minimal({ why: 'Two. Sentences' }) });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.body).toMatch(/why/);
  });

  it('export round-trips why and can, and omits them when not given', async () => {
    const ws = await newWs('Export');
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: minimal() })).statusCode).toBe(201);
    const withText = await as(admin.token, 'POST', `/workspaces/${ws}/packs/export`, {
      slug: 'rt', name: 'RT', space: 'Why Can Space', why: 'You track things and lose them.', can: ['See every thing', 'Find it fast'],
    });
    expect(withText.statusCode, withText.body).toBe(201);
    const exported = withText.json() as PackManifest;
    expect(exported.why).toBe('You track things and lose them.');
    expect(exported.can).toEqual(['See every thing', 'Find it fast']);
    // ...and the exported manifest installs again
    const ws2 = await newWs('Export reinstall');
    expect((await as(admin.token, 'POST', `/workspaces/${ws2}/packs/install`, { manifest: exported })).statusCode).toBe(201);

    const without = await as(admin.token, 'POST', `/workspaces/${ws}/packs/export`, { slug: 'rt2', name: 'RT2', space: 'Why Can Space' });
    expect(without.statusCode, without.body).toBe(201);
    expect((without.json() as PackManifest).why).toBeUndefined();
    expect((without.json() as PackManifest).can).toBeUndefined();

    const bad = await as(admin.token, 'POST', `/workspaces/${ws}/packs/export`, { slug: 'rt3', name: 'RT3', space: 'Why Can Space', can: ['a', 'b', 'c', 'd'] });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect(bad.statusCode).toBeLessThan(500);
  });
});

describe('marketplace submission carries why and can (#1145)', () => {
  it('a submitted manifest keeps them through approval and into the published detail', async () => {
    const marketSlug = `why-can-market-${Date.now()}`; // a published slug is global and survives a re-run on the same database
    const ws = await newWs('Submit why');
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/packs/install`, { manifest: minimal() })).statusCode).toBe(201);
    const manifest = (
      await as(admin.token, 'POST', `/workspaces/${ws}/packs/export`, {
        slug: marketSlug, name: 'Why Can Market', space: 'Why Can Space',
        why: 'You want to see it travel to the marketplace.', can: ['Submit it', 'Approve it'],
      })
    ).json() as PackManifest;
    const sub = await as(admin.token, 'POST', `/workspaces/${ws}/packs/submissions`, { manifest, vertical: 'ops', screenshots: [] });
    expect(sub.statusCode, sub.body).toBe(201);
    const ok = await as(operator.token, 'POST', `/admin/packs/submissions/${sub.json().id}/review`, { action: 'approve' });
    expect(ok.statusCode, ok.body).toBe(201);
    const detail = await as(admin.token, 'GET', `/packs/marketplace/${marketSlug}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const got = (detail.json() as { manifest: PackManifest }).manifest;
    expect(got.why).toBe('You want to see it travel to the marketplace.');
    expect(got.can).toEqual(['Submit it', 'Approve it']);
  });
});
