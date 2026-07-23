import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { platformAdmins } from '../src/db/schema';
import type { PackManifest } from '@storyos/schemas';

/**
 * Community Marketplace — MN-220. Submit → review → publish, v1 curated.
 *
 * Deliberately its own file rather than folded into packs.test.ts: that file
 * is about the pack FORMAT and the installer; this is about what happens to a
 * manifest BEFORE it ever reaches `PacksService.install` — the review queue,
 * the publish write, versioning/changelog, and the "update available" signal
 * an install surfaces afterward. None of it re-tests export/install itself.
 */

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string }; // workspace admin — the author
let operator: { token: string; email: string; id: string }; // platform admin — the reviewer
let member: { token: string; email: string }; // ordinary workspace member — negative cases

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function newWorkspace(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

/** The smallest exportable business: one space, one database, one field. */
async function buildMinimalBusiness(wsId: string): Promise<void> {
  const space = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Ops' })).json()
    .id as string;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Items' });
}

async function exportManifest(
  wsId: string,
  overrides: Record<string, unknown> = {},
): Promise<PackManifest> {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/export`, {
    slug: 'ops-pack',
    name: 'Ops Pack',
    version: '1.0.0',
    summary: 'A minimal ops pack',
    space: 'Ops',
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as PackManifest;
}

async function submit(
  wsId: string,
  manifest: unknown,
  meta: { vertical?: string; screenshots?: string[] } = {},
) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/packs/submissions`, {
    manifest,
    vertical: 'ops',
    screenshots: [],
    ...meta,
  });
}

async function submitOk(wsId: string, manifest: unknown, meta?: { vertical?: string }) {
  const res = await submit(wsId, manifest, meta);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; status: string; slug: string; version: string };
}

async function review(id: string, action: 'approve' | 'reject', notes?: string) {
  return as(operator.token, 'POST', `/admin/packs/submissions/${id}/review`, { action, notes });
}

async function reviewOk(id: string, action: 'approve' | 'reject', notes?: string) {
  const res = await review(id, action, notes);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function marketplaceEntry(slug: string) {
  return as(admin.token, 'GET', `/packs/marketplace/${slug}`);
}

async function installedList(wsId: string) {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/packs/installed`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Array<{
    id: string;
    slug: string;
    version: string;
    latest_version: string | null;
    update_available: boolean;
  }>;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'MarketAuthor');
  member = await signUpUser(app, 'MarketMember');
  operator = { ...(await signUpUser(app, 'MarketOperator')), id: '' };

  const me = await as(operator.token, 'GET', '/me');
  operator.id = me.json().id;
  await db.insert(platformAdmins).values({ userId: operator.id, grantedBy: null });
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('license/attribution (MN-220)', () => {
  it('defaults when the author does not set them', async () => {
    const wsId = await newWorkspace('License Default');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'license-default' });
    expect(manifest.license).toBe('All rights reserved');
    expect(manifest.attribution).toBeUndefined();
  });

  it('carries whatever the author sets, verbatim', async () => {
    const wsId = await newWorkspace('License Custom');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, {
      slug: 'license-custom',
      license: 'CC-BY-4.0',
      attribution: 'Jane Doe / Acme Consulting',
    });
    expect(manifest.license).toBe('CC-BY-4.0');
    expect(manifest.attribution).toBe('Jane Doe / Acme Consulting');
  });
});

describe('submit — the author flow (MN-220)', () => {
  it('is admin-gated', async () => {
    const wsId = await newWorkspace('Submit Gate');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'gate-pack' });
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/packs/submissions`, {
      manifest,
      vertical: 'ops',
      screenshots: [],
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('a malformed manifest is a 422, not a 500', async () => {
    const wsId = await newWorkspace('Submit Bad Manifest');
    const res = await submit(wsId, { not: 'a manifest' });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('a bad vertical is a 422', async () => {
    const wsId = await newWorkspace('Submit Bad Vertical');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'bad-vertical-pack' });
    const res = await submit(wsId, manifest, { vertical: 'not-a-vertical' });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('lands as a pending submission, visible to the author', async () => {
    const wsId = await newWorkspace('Submit Pending');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'pending-pack' });
    const created = await submitOk(wsId, manifest);
    expect(created.status).toBe('pending');
    expect(created.slug).toBe('pending-pack');

    const mine = await as(admin.token, 'GET', `/workspaces/${wsId}/packs/submissions`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect((mine.json() as Array<{ id: string }>).some((s) => s.id === created.id)).toBe(true);
  });

  it('is not yet on the marketplace — pending is not published', async () => {
    const wsId = await newWorkspace('Submit Not Live');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'not-live-pack' });
    await submitOk(wsId, manifest);

    const res = await marketplaceEntry('not-live-pack');
    expect(res.statusCode).toBe(404);
  });
});

describe('moderation — platform-admin only (MN-220)', () => {
  it('401s with no auth, 403s for a non-platform-admin', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/admin/packs/submissions' });
    expect(noAuth.statusCode).toBe(401);

    const notAdmin = await as(admin.token, 'GET', '/admin/packs/submissions');
    expect(notAdmin.statusCode).toBe(403);

    const reviewAttempt = await as(
      admin.token,
      'POST',
      '/admin/packs/submissions/00000000-0000-4000-8000-000000000000/review',
      { action: 'approve' },
    );
    expect(reviewAttempt.statusCode).toBe(403);
  });

  it('a platform admin sees pending submissions in the queue', async () => {
    const wsId = await newWorkspace('Queue Visible');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'queue-visible-pack' });
    const created = await submitOk(wsId, manifest);

    const res = await as(operator.token, 'GET', '/admin/packs/submissions?status=pending');
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as Array<{ id: string; slug: string }>;
    expect(rows.some((r) => r.id === created.id)).toBe(true);
  });

  it('404s reviewing a submission that does not exist', async () => {
    const res = await review('00000000-0000-4000-8000-000000000000', 'approve');
    expect(res.statusCode).toBe(404);
  });

  it('reject annotates the submission and never publishes anything', async () => {
    const wsId = await newWorkspace('Reject Flow');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, { slug: 'rejected-pack' });
    const created = await submitOk(wsId, manifest);

    const result = await reviewOk(created.id, 'reject', 'Not a good fit for the marketplace yet.');
    expect(result.status).toBe('rejected');
    expect(result.review_notes).toBe('Not a good fit for the marketplace yet.');

    expect((await marketplaceEntry('rejected-pack')).statusCode).toBe(404);

    // A decided submission cannot be reviewed again.
    const again = await review(created.id, 'approve');
    expect(again.statusCode, again.body).toBe(422);
  });

  it('approve publishes: a marketplace card and detail with the manifest appear', async () => {
    const wsId = await newWorkspace('Approve Flow');
    await buildMinimalBusiness(wsId);
    const manifest = await exportManifest(wsId, {
      slug: 'approved-pack',
      license: 'MIT',
      attribution: 'Acme Consulting',
    });
    const created = await submitOk(wsId, manifest);

    const result = await reviewOk(created.id, 'approve');
    expect(result.status).toBe('approved');

    const list = await as(admin.token, 'GET', '/packs/marketplace');
    expect(list.statusCode, list.body).toBe(200);
    const card = (list.json() as Array<{ slug: string; license: string; attribution?: string }>).find(
      (c) => c.slug === 'approved-pack',
    );
    expect(card, 'the approved pack is listed').toBeTruthy();
    expect(card!.license).toBe('MIT');
    expect(card!.attribution).toBe('Acme Consulting');

    const detail = await marketplaceEntry('approved-pack');
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as { manifest: PackManifest; versions: Array<{ version: string }> };
    expect(body.manifest.slug).toBe('approved-pack');
    expect(body.versions.map((v) => v.version)).toEqual(['1.0.0']);
  });

  it('a version that is not newer than what is published is refused at approval', async () => {
    const wsId = await newWorkspace('Version Guard');
    await buildMinimalBusiness(wsId);
    const first = await exportManifest(wsId, { slug: 'version-guard-pack', version: '1.0.0' });
    await reviewOk((await submitOk(wsId, first)).id, 'approve');

    const same = await exportManifest(wsId, { slug: 'version-guard-pack', version: '1.0.0' });
    const secondSubmission = await submitOk(wsId, same);
    const res = await review(secondSubmission.id, 'approve');
    expect(res.statusCode, res.body).toBe(422);
  });

  it('versioning + changelog: a newer submission adds a version, keeps the old one, bumps latest', async () => {
    const wsId = await newWorkspace('Version Bump');
    await buildMinimalBusiness(wsId);
    const v1 = await exportManifest(wsId, { slug: 'version-bump-pack', version: '1.0.0' });
    await reviewOk((await submitOk(wsId, v1)).id, 'approve');

    const v2 = await exportManifest(wsId, {
      slug: 'version-bump-pack',
      version: '1.1.0',
      upgrade_notes: 'Adds a widget.',
    });
    await reviewOk((await submitOk(wsId, v2)).id, 'approve');

    const detail = await marketplaceEntry('version-bump-pack');
    const body = detail.json() as {
      latest_version: string;
      versions: Array<{ version: string; changelog?: string }>;
    };
    expect(body.latest_version).toBe('1.1.0');
    expect(body.versions.map((v) => v.version).sort()).toEqual(['1.0.0', '1.1.0']);
    expect(body.versions.find((v) => v.version === '1.1.0')?.changelog).toBe('Adds a widget.');
  });
});

describe('installed packs surface available updates (MN-220)', () => {
  it('a marketplace pack installed at an older version reports the newer one available', async () => {
    const sourceWs = await newWorkspace('Update Source');
    await buildMinimalBusiness(sourceWs);
    const v1 = await exportManifest(sourceWs, { slug: 'update-available-pack', version: '1.0.0' });
    await reviewOk((await submitOk(sourceWs, v1)).id, 'approve');

    // Installed into a target workspace at v1.0.0, straight from the marketplace manifest.
    const targetWs = await newWorkspace('Update Target');
    const installRes = await as(admin.token, 'POST', `/workspaces/${targetWs}/packs/install`, {
      manifest: v1,
    });
    expect(installRes.statusCode, installRes.body).toBe(201);

    let installs = await installedList(targetWs);
    let mine = installs.find((i) => i.slug === 'update-available-pack')!;
    expect(mine.update_available).toBe(false);
    expect(mine.latest_version).toBe('1.0.0');

    // A newer version is published…
    const v2 = await exportManifest(sourceWs, { slug: 'update-available-pack', version: '1.1.0' });
    await reviewOk((await submitOk(sourceWs, v2)).id, 'approve');

    // …and the SAME tracked install now reports it, without touching the install itself.
    installs = await installedList(targetWs);
    mine = installs.find((i) => i.slug === 'update-available-pack')!;
    expect(mine.update_available).toBe(true);
    expect(mine.latest_version).toBe('1.1.0');
    expect(mine.version).toBe('1.0.0'); // the tracked install itself is untouched
  }, 60_000);

  it('a built-in registry pack installed at its current version reports no update', async () => {
    const wsId = await newWorkspace('Builtin Current');
    const entry = await as(admin.token, 'GET', '/packs/registry/support-inbox');
    expect(entry.statusCode, entry.body).toBe(200);
    const manifest = entry.json().manifest as PackManifest;

    const installRes = await as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest });
    expect(installRes.statusCode, installRes.body).toBe(201);

    const installs = await installedList(wsId);
    const mine = installs.find((i) => i.slug === 'support-inbox')!;
    expect(mine.update_available).toBe(false);
    expect(mine.latest_version).toBe(manifest.version);
  }, 60_000);
});
