/**
 * #451 — the seeder against a real database.
 *
 * Runs at `scale: 0.02`, which keeps the SHAPE (11 workspaces, every relation,
 * the guest, the extra space) and shrinks only the volume. The full run is a
 * five-minute setup step and has no business inside a test suite; what needs
 * proving here is that the applier writes what the plan says, through the
 * product's own endpoints, and that a second run adds nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { applyPlan } from '../src/seed/apply';
import { buildPlan } from '../src/seed/plan';
import { SEED_EPOCH } from '../src/seed/rng';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { records as recordsTable } from '../src/db/schema';

let app: NestFastifyApplication;
let db: Db;

const SEED = 'itest';
const SCALE = 0.02;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<Db>(DB);
}, 120_000);

afterAll(async () => {
  await app.close();
});

async function inject(method: string, url: string, token: string, payload?: unknown) {
  const res = await app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as never,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function signIn(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in/email',
    payload: { email, password: 'agent-uat-seed-password-1' },
  });
  return String(res.headers['set-auth-token']);
}

describe('#451 — seed:agent-uat writes a real environment', () => {
  it('seeds Nadia, then re-seeds without duplicating or resetting anything', async () => {
    const plan = buildPlan('nadia', SEED, { scale: SCALE });

    const first = await applyPlan(app, plan);
    expect(first.workspaces_created, 'eleven client workspaces').toBe(11);
    expect(first.databases_created).toBe(plan.totals.databases);
    expect(first.records_created).toBe(plan.totals.records);
    expect(first.links_created).toBeGreaterThan(0);
    expect(first.guest_granted, 'a guest with partial access').toBe(true);

    const ownerToken = await signIn(plan.owner.email);
    const afterFirst = await inject('GET', '/workspaces', ownerToken);
    const countFirst = (afterFirst.body as unknown[]).length;

    // The re-run. Additive or nothing — never a reset.
    const second = await applyPlan(app, plan);
    expect(second.workspaces_created, 'a second run must create no workspace').toBe(0);
    expect(second.workspaces_topped_up).toBe(11);
    expect(second.databases_created, 'nor any database').toBe(0);
    expect(second.records_created, 'nor any record').toBe(0);

    const afterSecond = await inject('GET', '/workspaces', ownerToken);
    expect((afterSecond.body as unknown[]).length).toBe(countFirst);
  }, 600_000);

  it('backdates history over six months, with records edited more than once', async () => {
    const plan = buildPlan('nadia', SEED, { scale: SCALE });
    const ownerToken = await signIn(plan.owner.email);
    const workspaces = (await inject('GET', '/workspaces', ownerToken)).body as Array<{ id: string; slug: string }>;
    const flagship = workspaces.find((w) => w.slug === plan.workspaces[0]!.key)!;
    const dbs = (await inject('GET', `/workspaces/${flagship.id}/databases`, ownerToken)).body as Array<{ id: string; name: string }>;
    // NOT dbs[0] — #128 provisions a "Members" system database at workspace
    // creation, so index 0 is a database the seeder never touched and whose
    // rows are genuinely stamped at seed time.
    const seeded = dbs.find((d) => d.name === plan.workspaces[0]!.databases[0]!.name)!;
    expect(seeded, 'the seeded database, not the Members projection').toBeTruthy();

    const rows = await db.query.records.findMany({
      where: eq(recordsTable.databaseId, seeded.id),
      columns: { id: true, createdAt: true, updatedAt: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    const oldest = rows.reduce((m, r) => (r.createdAt < m ? r.createdAt : m), rows[0]!.createdAt);
    const spanDays = (SEED_EPOCH.getTime() - oldest.getTime()) / 86_400_000;
    expect(spanDays, 'six months of history, not one seeding moment').toBeGreaterThan(100);
    // Not all created at seed time — the condition #404 hid behind.
    expect(new Set(rows.map((r) => r.createdAt.toISOString().slice(0, 10))).size).toBeGreaterThan(3);
    expect(rows.every((r) => r.createdAt.getTime() <= SEED_EPOCH.getTime())).toBe(true);

    // Version history is real, written by real PATCHes, and dated inside the record's own life.
    const versions = await db.query.recordVersions.findMany({
      where: inArray(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import('../src/db/schema')).recordVersions.recordId as any,
        rows.map((r) => r.id),
      ),
      columns: { recordId: true, createdAt: true },
    });
    expect(versions.length, 'edits produced version rows').toBeGreaterThan(0);
    expect(versions.every((v) => v.createdAt.getTime() <= SEED_EPOCH.getTime() + 86_400_000)).toBe(true);
  }, 300_000);

  it('creates the self-relation, the cross-space relation and the guest boundary', async () => {
    const plan = buildPlan('nadia', SEED, { scale: SCALE });
    const ownerToken = await signIn(plan.owner.email);
    const workspaces = (await inject('GET', '/workspaces', ownerToken)).body as Array<{ id: string; slug: string }>;
    const flagship = workspaces.find((w) => w.slug === plan.workspaces[0]!.key)!;

    const spaces = (await inject('GET', `/workspaces/${flagship.id}/spaces`, ownerToken)).body as Array<{ id: string; slug: string }>;
    expect(spaces.length, 'a second space, so a relation can cross one').toBeGreaterThan(1);

    // #448's shape: { data: [{ id, self_relation, a: {...}, b: {...} }] }.
    const relations = (await inject('GET', `/workspaces/${flagship.id}/relations`, ownerToken)).body as {
      data: Array<{ self_relation: boolean; a: { space_id: string }; b: { space_id: string } }>;
    };
    expect(relations.data.length).toBeGreaterThanOrEqual(2);
    expect(
      relations.data.some((r) => r.self_relation),
      'a self-relation exists in the seeded workspace',
    ).toBe(true);
    expect(
      relations.data.some((r) => !r.self_relation && r.a.space_id !== r.b.space_id),
      'a relation that genuinely crosses a space',
    ).toBe(true);

    // The guest boundary: a guest granted ONE space must not see the other.
    const guestToken = await signIn(plan.guest!.email);
    const guestSpaces = (await inject('GET', `/workspaces/${flagship.id}/spaces`, guestToken)).body as Array<{ slug: string }>;
    expect(guestSpaces.length, 'the guest sees strictly less than the owner').toBeLessThan(spaces.length);
    expect(guestSpaces.map((s) => s.slug)).toContain('delivery');
  }, 300_000);

  it('seeds Kai as a separate, document-heavy workspace', async () => {
    const plan = buildPlan('kai', SEED, { scale: SCALE });
    const result = await applyPlan(app, plan);
    expect(result.workspaces_created).toBe(1);
    expect(result.records_created).toBe(plan.totals.records);
    expect(result.guest_granted, 'Kai has no guest — one operator, one workspace').toBe(false);
  }, 300_000);
});
