import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY, toPublicPreview } from '../src/packs/registry';

/**
 * Ticket #1169 — the PUBLIC (pre-signup) pack routes return why, can and relations: the same text as the authenticated registry
 * listing (#1145), so the signup picker (#1150) can show them before anyone has an account.
 *
 * Every check loops over the WHOLE registry. The public routes are unauthenticated, so the other half of the contract is what they must
 * NOT carry: nothing workspace-specific, and the same bytes with or without a session.
 */
let app: NestFastifyApplication;
let member: { token: string };

const pub = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers });

type Rel = { from: string; to: string; cardinality: string; from_field: string; to_field: string };
type Copy = { slug: string; why: string | null; can: string[]; relations: Rel[] };

beforeAll(async () => {
  app = await createTestApp();
  member = await signUpUser(app, 'PublicPreview Member');
}, 60_000);
afterAll(async () => {
  await app?.close();
});

describe('the public routes return why, can and relations (#1169)', () => {
  it('the registry is not empty (the loops below would otherwise pass over nothing)', () => {
    expect(PACK_REGISTRY.length).toBeGreaterThanOrEqual(9);
  });

  it('GET /public/packs/registry: every pack, the same copy as the authenticated listing', async () => {
    const pubRes = await pub('/public/packs/registry');
    expect(pubRes.statusCode, pubRes.body).toBe(200);
    const authedRes = await app.inject({ method: 'GET', url: '/api/v1/packs/registry', headers: authed(member.token) });
    const mine = new Map((authedRes.json() as Copy[]).map((c) => [c.slug, c]));
    const cards = pubRes.json() as Copy[];
    expect(cards.map((c) => c.slug).sort()).toEqual(PACK_REGISTRY.map((e) => e.slug).sort());
    for (const card of cards) {
      const reg = mine.get(card.slug)!;
      expect(card.why, card.slug).toBe(reg.why);
      expect(card.why, `${card.slug} has a why`).toEqual(expect.any(String));
      expect(card.can, card.slug).toEqual(reg.can);
      expect(card.can.length, `${card.slug} has can lines`).toBeGreaterThan(0);
      expect(card.relations, card.slug).toEqual(reg.relations);
      expect((card as unknown as { manifest?: unknown }).manifest, 'no manifest leaks').toBeUndefined();
    }
    expect(cards.filter((c) => c.relations.length > 0).length).toBeGreaterThanOrEqual(5);
  });

  it('GET /public/packs/registry/:slug: every pack, the same copy as the registry', async () => {
    for (const entry of PACK_REGISTRY) {
      const res = await pub(`/public/packs/registry/${entry.slug}`);
      expect(res.statusCode, `${entry.slug}: ${res.body}`).toBe(200);
      const p = res.json() as Copy & { manifest?: unknown; contents: unknown };
      expect(p.why, entry.slug).toBe(entry.manifest.why);
      expect(p.can, entry.slug).toEqual(entry.manifest.can);
      expect(p.relations, entry.slug).toEqual(
        entry.manifest.relations.map(({ from, to, cardinality, from_field, to_field }) => ({ from, to, cardinality, from_field, to_field })),
      );
      expect(p.manifest).toBeUndefined();
      // what it returned before is still there
      expect(p.contents, entry.slug).toBeTruthy();
    }
    const agency = (await pub('/public/packs/registry/agency-os')).json() as Copy;
    expect(agency.relations).toContainEqual(expect.objectContaining({ from: 'Tasks', to: 'Tasks', cardinality: 'one_to_many' }));
  });

  it('a pack with no why/can/relations previews with null / [] / [] and no undefined fields', () => {
    const community = packManifestSchema.parse({
      format_version: 1,
      slug: 'community-bare',
      name: 'Community Bare',
      version: '1.0.0',
      summary: 'A community pack that predates why and can',
      databases: [{ action: 'create', name: 'Things', space: 'S', fields: [] }],
    });
    expect(community.why).toBeUndefined();
    const preview = toPublicPreview({ slug: community.slug, name: community.name, summary: community.summary, highlights: [], manifest: community });
    expect(preview.why).toBeNull();
    expect(preview.can).toEqual([]);
    expect(preview.relations).toEqual([]);
    // `undefined` would vanish from the JSON and the picker would see a missing key, not an empty one
    expect(Object.values(preview).includes(undefined as never)).toBe(false);
    expect(JSON.parse(JSON.stringify(preview))).toHaveProperty('why', null);
  });
});

describe('what the public routes must not carry (#1169)', () => {
  it('the same bytes with a session and without one: nothing in them depends on who asks', async () => {
    for (const url of ['/public/packs/registry', '/public/packs/registry/agency-os']) {
      const anon = await pub(url);
      const signedIn = await pub(url, authed(member.token));
      expect(anon.statusCode).toBe(200);
      expect(signedIn.body, url).toBe(anon.body);
    }
  });

  it('only the documented keys, and no ids or workspace data', async () => {
    const res = await pub('/public/packs/registry/agency-os');
    expect(Object.keys(res.json()).sort()).toEqual(
      ['can', 'contents', 'highlights', 'name', 'relations', 'requires', 'slug', 'summary', 'why'],
    );
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/); // no uuid of anything
    expect(res.body).not.toMatch(/\$(db|field|option):/);
    const list = (await pub('/public/packs/registry')).json() as Array<Record<string, unknown>>;
    for (const c of list) {
      expect(Object.keys(c).sort(), String(c.slug)).toEqual(['can', 'highlights', 'name', 'relations', 'slug', 'summary', 'why']);
    }
  });
});
