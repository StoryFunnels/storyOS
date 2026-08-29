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
import type { SeedPlan } from '../src/seed/plan';
import { SEED_EPOCH } from '../src/seed/rng';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { attachments, records as recordsTable } from '../src/db/schema';

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
    // #460
    expect(first.attachments_uploaded, 'real files on real records').toBe(plan.totals.attachments);
    expect(first.templates_applied, 'the agency template, for invoices').toBe(1);
    expect(first.packs_installed, 'the client-portal pack').toBe(1);

    const ownerToken = await signIn(plan.owner.email);
    const afterFirst = await inject('GET', '/workspaces', ownerToken);
    const countFirst = (afterFirst.body as unknown[]).length;

    // The re-run. Additive or nothing — never a reset.
    const second = await applyPlan(app, plan);
    expect(second.workspaces_created, 'a second run must create no workspace').toBe(0);
    expect(second.workspaces_topped_up).toBe(11);
    expect(second.databases_created, 'nor any database').toBe(0);
    expect(second.records_created, 'nor any record').toBe(0);
    expect(second.attachments_uploaded, 'nor re-upload a file').toBe(0);
    expect(second.templates_applied, 'nor re-apply the template').toBe(0);
    expect(second.packs_installed, 'nor re-install the pack').toBe(0);

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

  it('#460 — attachments are real files that can actually be downloaded', async () => {
    const plan = buildPlan('nadia', SEED, { scale: SCALE });
    const ownerToken = await signIn(plan.owner.email);
    const workspaces = (await inject('GET', '/workspaces', ownerToken)).body as Array<{ id: string; slug: string }>;
    const flagship = workspaces.find((w) => w.slug === plan.workspaces[0]!.key)!;
    const dbs = (await inject('GET', `/workspaces/${flagship.id}/databases`, ownerToken)).body as Array<{ id: string; name: string }>;
    const seeded = dbs.find((d) => d.name === plan.workspaces[0]!.databases[0]!.name)!;

    const page = (await inject('POST', `/workspaces/${flagship.id}/databases/${seeded.id}/records/query`, ownerToken, { limit: 200 }))
      .body as { data: Array<{ id: string }> };
    let found: { recordId: string; attId: string } | null = null;
    for (const record of page.data) {
      const list = (await inject('GET', `/workspaces/${flagship.id}/databases/${seeded.id}/records/${record.id}/attachments`, ownerToken))
        .body as { data: Array<{ id: string; filename: string }> } | Array<{ id: string; filename: string }>;
      const items = Array.isArray(list) ? list : list.data;
      if (items?.length) {
        found = { recordId: record.id, attId: items[0]!.id };
        expect(items[0]!.filename, 'obviously synthetic filenames').toMatch(/mockup|handover|brief|screenshot/);
        break;
      }
    }
    expect(found, 'at least one seeded record carries a file').toBeTruthy();

    // The point of uploading through the real endpoint: the bytes are there.
    // An attachment row with no stored object looks fine in a list and 404s
    // the moment anyone clicks it.
    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${flagship.id}/databases/${seeded.id}/records/${found!.recordId}/attachments/${found!.attId}/download`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(download.statusCode, 'the file downloads').toBeLessThan(300);
    expect(download.rawPayload.length, 'and has bytes in it').toBeGreaterThan(0);
  }, 300_000);

  it('#460 — a re-run adds no duplicate files across a paginated database', async () => {
    /*
     * Regression, and it only reproduces PAST THE PAGE BOUNDARY.
     *
     * The plan addresses records by index, so index N has to mean the same
     * record on every run. `listRecordIds` pages `records/query` at 200 a
     * time, and the concatenated pages did not come back in creation order —
     * so on a re-run index N pointed at a different record, that record had no
     * file by that name, and a second copy went up. At full scale 113
     * attachments became 194 while the summary line said "additive".
     *
     * A small fixture cannot show this: under 200 records there is one page
     * and the order happens to hold. I checked — the first version of this
     * test still passed with the fix reverted, which made it worthless. This
     * one seeds 260 records into a single database on purpose.
     */
    const full = buildPlan('nadia', 'paged', { scale: 0.47 });
    const flagship = full.workspaces[0]!;
    const database = flagship.databases[0]!;
    expect(database.records.length, 'must cross the 200-row page boundary').toBeGreaterThan(200);
    expect(database.attachments.length).toBeGreaterThan(1);

    const plan: SeedPlan = {
      ...full,
      workspaces: [{ ...flagship, spaces: [], databases: [database], relations: [], templates: [], packs: [], guest_grant: undefined }],
      guest: null,
    };

    const first = await applyPlan(app, plan);
    expect(first.attachments_uploaded).toBe(database.attachments.length);
    const after = await db.$count(attachments);

    const second = await applyPlan(app, plan);
    expect(second.records_created, 'a re-run creates no records').toBe(0);
    expect(second.attachments_uploaded, 'and no file is uploaded twice').toBe(0);
    // Counted in the database, because the return value was the thing that lied.
    expect(await db.$count(attachments)).toBe(after);
  }, 600_000);

  it('#460 — invoices and a client portal exist, and the guest can open the portal', async () => {
    const plan = buildPlan('nadia', SEED, { scale: SCALE });
    const ownerToken = await signIn(plan.owner.email);
    const workspaces = (await inject('GET', '/workspaces', ownerToken)).body as Array<{ id: string; slug: string }>;
    const flagship = workspaces.find((w) => w.slug === plan.workspaces[0]!.key)!;

    const spaces = (await inject('GET', `/workspaces/${flagship.id}/spaces`, ownerToken)).body as Array<{ id: string; name: string }>;
    expect(spaces.map((s) => s.name), 'the pack created its portal space').toContain('Client Portal');

    const dbs = (await inject('GET', `/workspaces/${flagship.id}/databases`, ownerToken)).body as Array<{ id: string; name: string }>;
    const invoices = dbs.find((d) => d.name === 'Invoices');
    expect(invoices, 'the agency template brought an Invoices database').toBeTruthy();
    const rows = (await inject('POST', `/workspaces/${flagship.id}/databases/${invoices!.id}/records/query`, ownerToken, { limit: 50 }))
      .body as { data: unknown[] };
    expect(rows.data.length, 'with sample invoices in it, not an empty shell').toBeGreaterThan(0);

    // A portal the client cannot open is not a portal — but the guest must
    // still see strictly less than the owner.
    const guestToken = await signIn(plan.guest!.email);
    const guestSpaces = (await inject('GET', `/workspaces/${flagship.id}/spaces`, guestToken)).body as Array<{ name: string }>;
    expect(guestSpaces.map((s) => s.name)).toContain('Client Portal');
    expect(guestSpaces.length).toBeLessThan(spaces.length);
  }, 300_000);

  it('seeds Kai as a separate, document-heavy workspace', async () => {
    const plan = buildPlan('kai', SEED, { scale: SCALE });
    const result = await applyPlan(app, plan);
    expect(result.workspaces_created).toBe(1);
    expect(result.records_created).toBe(plan.totals.records);
    expect(result.attachments_uploaded, 'the file-heavy persona gets files').toBe(plan.totals.attachments);
    expect(result.guest_granted, 'Kai has no guest — one operator, one workspace').toBe(false);
  }, 300_000);
});
