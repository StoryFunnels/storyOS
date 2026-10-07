import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, truncateAll } from './helpers/db';
import { databases, fields, spaces, views, workspaces } from '../src/db/schema';
import { reportNumberRefsByWorkspace, withReadOnly } from '../src/views/scan-number-field-refs-report';
import type { Db } from '../src/db/client';

/**
 * #764 Phase A — the per-workspace census must (1) count correctly and (2) be
 * demonstrably incapable of writing. The second is the acceptance bar, so it is
 * proven three independent ways: the database rejects a write, the scan refuses
 * to run when it cannot confirm read-only, and the source contains no write call.
 */
const { db, pool } = connectTestDb();

let wsA: string;
let wsB: string;
let wsC: string;
const PERSONAL_NAME = 'Quarterly layoffs shortlist';
const PERSONAL_OWNER = 'user-private-1';

async function workspace(name: string) {
  const [ws] = await db.insert(workspaces).values({ name, slug: name.toLowerCase().replace(/\W+/g, '-') }).returning();
  const [space] = await db.insert(spaces).values({ workspaceId: ws!.id, name: 'General', slug: 'general' }).returning();
  return { id: ws!.id, spaceId: space!.id };
}
async function database(ws: { id: string; spaceId: string }, name: string) {
  const [row] = await db
    .insert(databases)
    .values({ workspaceId: ws.id, spaceId: ws.spaceId, name, apiSlug: name.toLowerCase().replace(/\W+/g, '-') })
    .returning();
  return row!.id;
}
async function view(databaseId: string, name: string, config: Record<string, unknown>, extra: Partial<typeof views.$inferInsert> = {}) {
  const [row] = await db.insert(views).values({ databaseId, name, type: 'table', config, ...extra }).returning();
  return row!.id;
}

beforeAll(async () => {
  await truncateAll(pool);
  const a = await workspace('Workspace A');
  const b = await workspace('Workspace B');
  const c = await workspace('Workspace C');
  wsA = a.id;
  wsB = b.id;
  wsC = c.id;

  const tasks = await database(a, 'Tasks');
  await view(tasks, 'Filter', { filters: { field: 'number', op: 'eq', value: 1 } });
  await view(tasks, 'Sort', { sorts: [{ field: 'number', direction: 'desc' }] });
  await view(tasks, 'Unrelated', { filters: { field: 'name', op: 'eq', value: 'x' } });
  await view(tasks, PERSONAL_NAME, { filters: { field: 'number', op: 'gt', value: 5 } }, { ownerUserId: PERSONAL_OWNER });
  const trashed = await view(tasks, 'Trashed', { filters: { field: 'number', op: 'eq', value: 2 } });
  await db.update(views).set({ deletedAt: new Date() }).where(eq(views.id, trashed));

  const github = await database(a, 'GitHub issues');
  await db.insert(fields).values({ databaseId: github, displayName: 'number', apiName: 'number', type: 'number', isSystem: false });
  await view(github, 'GH filter', { filters: { field: 'number', op: 'eq', value: 42 } });

  await db.insert(views).values({
    spaceId: a.spaceId,
    databaseId: null,
    name: 'Space view',
    type: 'table',
    config: { filters: { field: 'number', op: 'eq', value: 9 } },
  });

  const bTasks = await database(b, 'Tasks');
  await view(bTasks, 'B filter', { filters: { field: 'number', op: 'eq', value: 3 } });

  const cTasks = await database(c, 'Tasks');
  await view(cTasks, 'C clean', { filters: { field: 'name', op: 'eq', value: 'y' } });
});

afterAll(async () => {
  await pool.end();
});

describe('#764 Phase A — per-workspace census of `number` references', () => {
  it('breaks the count down BY WORKSPACE, most affected first — not a single total', async () => {
    const report = await reportNumberRefsByWorkspace(db);
    expect(report.workspaces.map((w) => w.workspaceId)).toEqual([wsA, wsB, wsC]);
    const byId = Object.fromEntries(report.workspaces.map((w) => [w.workspaceId, w]));
    // A: filter + sort + the personal view reference the deprecated field. The trashed one does not count.
    expect(byId[wsA]).toEqual({ workspaceId: wsA, viewsScanned: 6, referencing: 3, userFieldDatabase: 1, spaceViewUnresolved: 1 });
    expect(byId[wsB]).toEqual({ workspaceId: wsB, viewsScanned: 1, referencing: 1, userFieldDatabase: 0, spaceViewUnresolved: 0 });
    expect(byId[wsC]).toEqual({ workspaceId: wsC, viewsScanned: 1, referencing: 0, userFieldDatabase: 0, spaceViewUnresolved: 0 });
    expect(report.totals).toMatchObject({ workspaces: 3, workspacesReferencing: 2, referencing: 4, viewsScanned: 8, userFieldDatabase: 1, spaceViewUnresolved: 1 });
  });

  it('a user field named `number` is not counted as a reference to the deprecated one', async () => {
    const report = await reportNumberRefsByWorkspace(db);
    const a = report.workspaces.find((w) => w.workspaceId === wsA)!;
    expect(a.userFieldDatabase).toBe(1);
    expect(a.referencing).toBe(3); // would be 4 if the GitHub view were wrongly counted
  });

  it('returns COUNTS ONLY — nothing that could identify a personal view', async () => {
    const report = await reportNumberRefsByWorkspace(db);
    const text = JSON.stringify(report);
    expect(text).not.toContain(PERSONAL_NAME);
    expect(text).not.toContain(PERSONAL_OWNER);
    const [first] = report.workspaces;
    expect(Object.keys(first!).sort()).toEqual(['referencing', 'spaceViewUnresolved', 'userFieldDatabase', 'viewsScanned', 'workspaceId']);
  });
});

describe('#764 Phase A — INCAPABLE OF WRITING', () => {
  it('layer 1: the database itself rejects a write inside the scan transaction', async () => {
    // Drizzle wraps the driver error, so the Postgres SQLSTATE sits on `cause`:
    // 25006 = read_only_sql_transaction. Asserting the code, not message text.
    const rejectedAsReadOnly = async (attempt: Promise<unknown>) => {
      const err = (await attempt.then(
        () => null,
        (e: unknown) => e,
      )) as { cause?: { code?: string; message?: string } } | null;
      expect(err, 'the write must be rejected').not.toBeNull();
      expect(err!.cause?.code).toBe('25006');
      expect(err!.cause?.message).toMatch(/read-only transaction/i);
    };
    const [anyView] = await db.select({ id: views.id }).from(views).limit(1);
    await rejectedAsReadOnly(withReadOnly(db, (tx) => tx.update(views).set({ name: 'hijacked' }).where(eq(views.id, anyView!.id))));
    await rejectedAsReadOnly(withReadOnly(db, (tx) => tx.insert(workspaces).values({ name: 'x', slug: 'x-ro' })));
    await rejectedAsReadOnly(withReadOnly(db, (tx) => tx.delete(views).where(eq(views.id, anyView!.id))));
    const [still] = await db.select({ name: views.name }).from(views).where(eq(views.id, anyView!.id));
    expect(still!.name).not.toBe('hijacked');
  });

  it('layer 2: it REFUSES to scan if the transaction is not read only', async () => {
    const notReadOnly = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ execute: async () => ({ rows: [{ transaction_read_only: 'off' }] }) }),
    } as unknown as Db;
    await expect(reportNumberRefsByWorkspace(notReadOnly)).rejects.toThrow(/not read only/i);
  });

  it('behaviourally: running the scan leaves every view row exactly as it was', async () => {
    const snapshot = async () =>
      (await db.select({ id: views.id, config: views.config, updatedAt: views.updatedAt, deletedAt: views.deletedAt }).from(views)).sort((x, y) =>
        x.id.localeCompare(y.id),
      );
    const before = await snapshot();
    await reportNumberRefsByWorkspace(db);
    await reportNumberRefsByWorkspace(db);
    expect(await snapshot()).toEqual(before);
  });

  it('layer 3: neither the report nor its CLI contains a write call or imports the migration', () => {
    const dir = join(__dirname, '..', 'src', 'views');
    for (const file of ['scan-number-field-refs-report.ts', 'scan-number-field-refs-cli.ts']) {
      const code = readFileSync(join(dir, file), 'utf8')
        // comments may describe writes; only code counts
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\.(update|insert|delete)\s*\(/);
      expect(code, file).not.toMatch(/migrate-number-field-refs/);
      expect(code, file).not.toMatch(/rewriteConfigNumberRefs/);
    }
  });
});
