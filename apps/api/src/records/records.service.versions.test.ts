import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import { RecordsService } from './records.service';

const WORKSPACE_ID = 'ws-1';
const DATABASE_ID = 'db-1';
const RECORD_ID = 'rec-1';
const ACTOR_ID = 'user-1';

const baseRow = {
  id: RECORD_ID,
  databaseId: DATABASE_ID,
  number: 1,
  title: 'Current title',
  values: { field_a: 'current value' },
  computedValues: {},
  position: 'a0',
  createdBy: ACTOR_ID,
  updatedBy: ACTOR_ID,
  deletedAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-10T00:00:00Z'),
};

/** Fake Db exposing only the query/transaction surface RecordsService touches for versions. */
function makeDb(opts: {
  row?: typeof baseRow | null;
  version?: { id: string; recordId: string; title: string; values: unknown } | null;
  versionRows?: Array<{ id: string; title: string; actorId: string | null; createdAt: Date }>;
}) {
  const inserted: Array<{ table: string; values: unknown }> = [];
  const updated: Array<{ table: string; patch: unknown }> = [];
  let tableTag = '';

  const db = {
    query: {
      records: {
        findFirst: vi.fn().mockResolvedValue(opts.row === undefined ? baseRow : opts.row),
      },
      fields: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      selectOptions: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      recordVersions: {
        findFirst: vi.fn().mockResolvedValue(opts.version === undefined ? null : opts.version),
        findMany: vi.fn().mockResolvedValue(opts.versionRows ?? []),
      },
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: (_table: { _tag?: string }) => {
          // drizzle table objects don't carry a friendly name; tag by call order instead.
          tableTag = tableTag === '' ? 'record_versions' : 'activity_events';
          return {
            values: async (v: unknown) => {
              inserted.push({ table: tableTag, values: v });
              return [];
            },
          };
        },
        update: (_table: unknown) => ({
          set: (patch: unknown) => {
            updated.push({ table: 'records', patch });
            return {
              where: () => ({
                returning: async () => [{ ...baseRow, ...(patch as object) }],
              }),
            };
          },
        }),
      };
      return cb(tx);
    },
  };
  return { db: db as unknown as Db, inserted, updated };
}

function makeService(db: Db) {
  return new RecordsService(
    db,
    { notify: vi.fn() } as never,
    { emit: vi.fn() } as never,
    { syncRecordMentions: vi.fn() } as never,
    { recordWrites: vi.fn() } as never,
  );
}

describe('RecordsService.restoreVersion', () => {
  it('throws NotFoundException when the version does not exist (or belongs to another record)', async () => {
    const { db } = makeDb({ version: null });
    const service = makeService(db);
    await expect(
      service.restoreVersion(WORKSPACE_ID, DATABASE_ID, RECORD_ID, 'missing-version', ACTOR_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a no-op (no writes) when the version snapshot matches the current row', async () => {
    const { db, inserted, updated } = makeDb({
      version: { id: 'v1', recordId: RECORD_ID, title: baseRow.title, values: baseRow.values },
    });
    const service = makeService(db);
    const result = await service.restoreVersion(WORKSPACE_ID, DATABASE_ID, RECORD_ID, 'v1', ACTOR_ID);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(result.title).toBe(baseRow.title);
  });

  it('snapshots the current state, writes the target snapshot back, and logs an activity event', async () => {
    const { db, inserted, updated } = makeDb({
      version: {
        id: 'v1',
        recordId: RECORD_ID,
        title: 'Old title',
        values: { field_a: 'old value' },
      },
    });
    const service = makeService(db);
    const result = await service.restoreVersion(WORKSPACE_ID, DATABASE_ID, RECORD_ID, 'v1', ACTOR_ID);

    // The state we're about to overwrite gets captured first, so the restore is itself undoable.
    const versionSnapshot = inserted.find((i) => i.table === 'record_versions');
    expect(versionSnapshot?.values).toMatchObject({
      workspaceId: WORKSPACE_ID,
      recordId: RECORD_ID,
      title: baseRow.title,
      values: baseRow.values,
    });

    // The record row is overwritten with the target snapshot, not merged.
    expect(updated[0]?.patch).toMatchObject({ values: { field_a: 'old value' }, title: 'Old title' });

    // The restore shows up in the existing activity trail like a normal edit.
    const activity = inserted.find((i) => i.table === 'activity_events');
    expect(activity?.values).toMatchObject({
      type: 'record.updated',
      payload: {
        diff: { field_a: { from: 'current value', to: 'old value' }, title: { from: 'Current title', to: 'Old title' } },
        restored_from_version_id: 'v1',
      },
    });

    expect(result.title).toBe('Old title');
  });
});

describe('RecordsService.listVersions', () => {
  it('maps rows to the public shape and reports no next cursor on the last page', async () => {
    const rows = [
      { id: 'v2', title: 'B', actorId: ACTOR_ID, createdAt: new Date('2026-07-02T00:00:00Z') },
      { id: 'v1', title: 'A', actorId: ACTOR_ID, createdAt: new Date('2026-07-01T00:00:00Z') },
    ];
    const { db } = makeDb({ versionRows: rows });
    const service = makeService(db);
    const result = await service.listVersions(RECORD_ID, 50);
    expect(result.data).toEqual([
      { id: 'v2', title: 'B', actor_id: ACTOR_ID, created_at: rows[0]!.createdAt },
      { id: 'v1', title: 'A', actor_id: ACTOR_ID, created_at: rows[1]!.createdAt },
    ]);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeNull();
  });

  it('signals has_more and a usable cursor when the page is full', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `v${i}`,
      title: `T${i}`,
      actorId: ACTOR_ID,
      createdAt: new Date(2026, 6, 3 - i),
    }));
    const { db } = makeDb({ versionRows: rows });
    const service = makeService(db);
    const result = await service.listVersions(RECORD_ID, 2);
    expect(result.data).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).not.toBeNull();
  });
});
