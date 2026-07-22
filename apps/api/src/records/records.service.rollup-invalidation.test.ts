import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@storyos/schemas';
import type { Db } from '../db/client';
import { RecordsService } from './records.service';

/**
 * MN-267: unit coverage for RecordsService.invalidateRollupsForChange — the
 * reverse-lookup DISCOVERY logic RollupInvalidationSubscriber calls on every
 * record_created/record_updated domain event. This is the genuinely new part
 * (attachRollups' aggregation itself already existed, read-time, pre-#260);
 * what didn't exist before MN-267 is "given a change, which OTHER records'
 * rollup needs to recompute".
 *
 * fieldDefs() and recomputeRollupsForRelationField() are stubbed via spyOn —
 * both are exercised by other paths (fieldDefs by every other RecordsService
 * test; recomputeRollupsForRelationField's own aggregate SQL needs a real
 * Postgres and is covered by the DB-integration suite,
 * records-query-rollup-sort.test.ts). This file isolates the one thing that
 * can't run against a real DB in this environment but also doesn't need one:
 * the "who is affected" reasoning.
 *
 * Docker/Postgres are unreachable in this sandbox (repo-wide known limitation
 * tonight) — this file bypasses vitest.config.ts's Testcontainers globalSetup
 * (see the ad hoc --config used to run it locally) since it never touches a
 * real Db, only a hand-built fake.
 */

const TIMEOFF_DB = 'timeoff-db';
const MEMBERS_DB = 'members-db';
const RELATION_ID = 'rel-1';
const FIELD_A_ID = 'member-field-id'; // relation field on TIMEOFF_DB (side a)
const FIELD_B_ID = 'time-off-field-id'; // relation field on MEMBERS_DB (side b)
const DAYS_FIELD_ID = 'days-field-id'; // number field on TIMEOFF_DB
const DAYS_USED_FIELD_ID = 'days-used-field-id'; // sum rollup on MEMBERS_DB
const COUNT_FIELD_ID = 'record-count-field-id'; // count rollup on MEMBERS_DB
const OTHER_NUMBER_FIELD_ID = 'unrelated-number-field-id'; // a field the rollup does NOT target
const STATE_FIELD_ID = 'state-field-id'; // a field on TIMEOFF_DB a filtered rollup reads — NOT the sum's target

const RELATION = {
  id: RELATION_ID,
  databaseAId: TIMEOFF_DB,
  databaseBId: MEMBERS_DB,
  fieldAId: FIELD_A_ID,
  fieldBId: FIELD_B_ID,
};

const timeoffDefs: FieldDef[] = [
  { id: DAYS_FIELD_ID, api_name: 'days', type: 'number', config: {} },
  { id: OTHER_NUMBER_FIELD_ID, api_name: 'unrelated', type: 'number', config: {} },
  { id: STATE_FIELD_ID, api_name: 'state', type: 'select', config: {} },
  { id: FIELD_A_ID, api_name: 'member', type: 'relation', config: { relation_id: RELATION_ID, side: 'a' } },
];

const membersDefsWithSumRollup: FieldDef[] = [
  { id: FIELD_B_ID, api_name: 'time_off', type: 'relation', config: { relation_id: RELATION_ID, side: 'b' } },
  {
    id: DAYS_USED_FIELD_ID,
    api_name: 'days_used',
    type: 'rollup',
    config: { relation_field_id: FIELD_B_ID, op: 'sum', target_field_api_name: 'days' },
  },
];

const membersDefsWithFilteredSumRollup: FieldDef[] = [
  { id: FIELD_B_ID, api_name: 'time_off', type: 'relation', config: { relation_id: RELATION_ID, side: 'b' } },
  {
    id: DAYS_USED_FIELD_ID,
    api_name: 'days_used',
    type: 'rollup',
    config: {
      relation_field_id: FIELD_B_ID,
      op: 'sum',
      target_field_api_name: 'days',
      // MN-295: filters on `state`, not `days` — the invalidation gap this
      // whole feature needs to close (target-field-only invalidation would
      // never notice a `state` flip).
      filter: { field: 'state', op: 'neq', value: 'approved' },
    },
  },
];

const membersDefsWithCountRollup: FieldDef[] = [
  { id: FIELD_B_ID, api_name: 'time_off', type: 'relation', config: { relation_id: RELATION_ID, side: 'b' } },
  {
    id: COUNT_FIELD_ID,
    api_name: 'time_off_count',
    type: 'rollup',
    config: { relation_field_id: FIELD_B_ID, op: 'count' },
  },
];

const membersDefsNoRollup: FieldDef[] = [
  { id: FIELD_B_ID, api_name: 'time_off', type: 'relation', config: { relation_id: RELATION_ID, side: 'b' } },
];

function makeDb(opts: {
  relations?: (typeof RELATION)[];
  relationById?: typeof RELATION | null;
  linkedOtherIds?: string[];
}) {
  const db = {
    query: {
      relations: {
        findMany: vi.fn().mockResolvedValue(opts.relations ?? []),
        findFirst: vi.fn().mockResolvedValue(opts.relationById === undefined ? null : opts.relationById),
      },
    },
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue((opts.linkedOtherIds ?? []).map((id) => ({ other: id }))),
      }),
    }),
  };
  return db as unknown as Db;
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

/** Stubs fieldDefs() to return canned defs per databaseId, and spies on the
 * (separately-tested) recompute call so this file only asserts on "what got
 * called with what", not the aggregate SQL behind it. */
function stub(service: RecordsService, defsByDb: Record<string, FieldDef[]>) {
  vi.spyOn(service, 'fieldDefs').mockImplementation(async (databaseId: string) => defsByDb[databaseId] ?? []);
  const recompute = vi.spyOn(service, 'recomputeRollupsForRelationField').mockResolvedValue(undefined);
  return recompute;
}

describe('RecordsService.invalidateRollupsForChange — case (a): a related record\'s own field changed', () => {
  it('recomputes the sum rollup on the OTHER side for records linked to the changed record', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1', 'member-rec-2'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [DAYS_FIELD_ID], // the rollup's target field changed
    });

    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1', 'member-rec-2']);
  });

  it('does NOT recompute when the changed field is not the rollup\'s target (no false cascade)', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [OTHER_NUMBER_FIELD_ID], // unrelated field
    });

    expect(recompute).not.toHaveBeenCalled();
  });

  it('MN-295: a filtered sum rollup recomputes when the changed field is referenced by its FILTER, even though it is not the target field', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithFilteredSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [STATE_FIELD_ID], // the FILTER's field, not the sum's target ('days')
    });

    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
  });

  it('MN-295: a filtered sum rollup still recomputes when the changed field IS the target field', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithFilteredSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [DAYS_FIELD_ID],
    });

    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
  });

  it('MN-295: a filtered sum rollup does NOT recompute when the changed field is neither the target nor referenced by the filter (no false cascade)', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithFilteredSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [OTHER_NUMBER_FIELD_ID],
    });

    expect(recompute).not.toHaveBeenCalled();
  });

  it('a count rollup always recomputes on a related field change — count depends on link membership, not field values', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithCountRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [OTHER_NUMBER_FIELD_ID], // count rollup doesn't care what field this is
    });

    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
  });

  it('is a no-op when no rollup on the other side reads through this relation', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsNoRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [DAYS_FIELD_ID],
    });

    expect(recompute).not.toHaveBeenCalled();
  });

  it('is a no-op when the changed record is not currently linked to anything on the other side', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: [] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithSumRollup,
    });

    await service.invalidateRollupsForChange({
      databaseId: TIMEOFF_DB,
      recordId: 'timeoff-rec-1',
      changedFieldIds: [DAYS_FIELD_ID],
    });

    expect(recompute).not.toHaveBeenCalled();
  });

  it('is a no-op when changedFieldIds is empty (no field actually changed)', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['member-rec-1'] });
    const service = makeService(db);
    const recompute = stub(service, {
      [TIMEOFF_DB]: timeoffDefs,
      [MEMBERS_DB]: membersDefsWithSumRollup,
    });

    await service.invalidateRollupsForChange({ databaseId: TIMEOFF_DB, recordId: 'timeoff-rec-1', changedFieldIds: [] });

    expect(recompute).not.toHaveBeenCalled();
  });
});

describe('RecordsService.invalidateRollupsForChange — case (b): this record\'s own relation link-set changed', () => {
  it('recomputes both this record\'s own rollup (through the field that changed) and the other side\'s rollup (through the reverse field)', async () => {
    const db = makeDb({ relationById: RELATION });
    const service = makeService(db);
    // Own side (members-db) has the sum rollup; other side (timeoff-db) has none in this fixture.
    const recompute = stub(service, {});

    await service.invalidateRollupsForChange({
      databaseId: MEMBERS_DB,
      recordId: 'member-rec-1',
      linkedRelations: [
        {
          relationId: RELATION_ID,
          fieldId: FIELD_B_ID, // the 'time_off' field on members-db, just written
          otherDatabaseId: TIMEOFF_DB,
          otherRecordIds: ['timeoff-rec-1', 'timeoff-rec-2'],
        },
      ],
    });

    // Own-side recompute: this member's own rollup through the field it just wrote.
    expect(recompute).toHaveBeenNthCalledWith(1, MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
    // Other-side recompute: the reverse field (fieldAId, since link.fieldId === fieldBId)
    // for exactly the before∪after target ids writeLinks captured.
    expect(recompute).toHaveBeenNthCalledWith(2, TIMEOFF_DB, FIELD_A_ID, ['timeoff-rec-1', 'timeoff-rec-2']);
    expect(recompute).toHaveBeenCalledTimes(2);
  });

  it('still recomputes the owner\'s own rollup even when the relation itself no longer resolves (severed/deleted)', async () => {
    const db = makeDb({ relationById: null });
    const service = makeService(db);
    const recompute = stub(service, {});

    await service.invalidateRollupsForChange({
      databaseId: MEMBERS_DB,
      recordId: 'member-rec-1',
      linkedRelations: [
        { relationId: RELATION_ID, fieldId: FIELD_B_ID, otherDatabaseId: TIMEOFF_DB, otherRecordIds: ['timeoff-rec-1'] },
      ],
    });

    // Own-side call always happens first, regardless of whether the relation row is still there.
    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
  });

  it('skips the other-side recompute when nothing was actually linked/unlinked (otherRecordIds empty)', async () => {
    const db = makeDb({ relationById: RELATION });
    const service = makeService(db);
    const recompute = stub(service, {});

    await service.invalidateRollupsForChange({
      databaseId: MEMBERS_DB,
      recordId: 'member-rec-1',
      linkedRelations: [
        { relationId: RELATION_ID, fieldId: FIELD_B_ID, otherDatabaseId: TIMEOFF_DB, otherRecordIds: [] },
      ],
    });

    expect(recompute).toHaveBeenCalledExactlyOnceWith(MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
  });

  it('handles multiple relation fields written in the same update (e.g. two relation fields patched at once)', async () => {
    const otherRelation = { id: 'rel-2', databaseAId: MEMBERS_DB, databaseBId: 'projects-db', fieldAId: 'proj-field-on-members', fieldBId: 'members-field-on-projects' };
    let findFirstCalls = 0;
    const db = {
      query: {
        relations: {
          findMany: vi.fn(),
          findFirst: vi.fn().mockImplementation(async () => {
            // Both relation lookups go through the same mock; return by call order.
            findFirstCalls += 1;
            return findFirstCalls === 1 ? RELATION : otherRelation;
          }),
        },
      },
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    } as unknown as Db;
    const service = makeService(db);
    const recompute = stub(service, {});

    await service.invalidateRollupsForChange({
      databaseId: MEMBERS_DB,
      recordId: 'member-rec-1',
      linkedRelations: [
        { relationId: RELATION_ID, fieldId: FIELD_B_ID, otherDatabaseId: TIMEOFF_DB, otherRecordIds: ['timeoff-rec-1'] },
        { relationId: 'rel-2', fieldId: 'proj-field-on-members', otherDatabaseId: 'projects-db', otherRecordIds: ['proj-rec-1'] },
      ],
    });

    // Own-side recompute fires once per relation field, plus one other-side recompute each.
    expect(recompute).toHaveBeenCalledTimes(4);
    expect(recompute).toHaveBeenNthCalledWith(1, MEMBERS_DB, FIELD_B_ID, ['member-rec-1']);
    expect(recompute).toHaveBeenNthCalledWith(2, TIMEOFF_DB, FIELD_A_ID, ['timeoff-rec-1']);
    expect(recompute).toHaveBeenNthCalledWith(3, MEMBERS_DB, 'proj-field-on-members', ['member-rec-1']);
    expect(recompute).toHaveBeenNthCalledWith(4, 'projects-db', 'members-field-on-projects', ['proj-rec-1']);
  });
});
