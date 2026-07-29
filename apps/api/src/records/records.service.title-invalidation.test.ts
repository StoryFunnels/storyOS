import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@storyos/schemas';
import { parseFormula } from '@storyos/schemas';
import type { Db } from '../db/client';
import { RecordsService } from './records.service';

/**
 * #132: unit coverage for the REACTIVE half of cross-record computed names —
 * the "who needs their title recomputed" reasoning
 * RecordsService.invalidateRollupsForChange now runs alongside the MN-267 rollup
 * cascade. Mirrors records.service.rollup-invalidation.test.ts exactly (hand-built
 * fake Db, fieldDefs + the recompute methods stubbed via spyOn) so it isolates
 * the discovery logic without touching a real Postgres — which is unreachable in
 * this sandbox and, more importantly, not what this file is testing. The actual
 * title materialization end-to-end lives in test/computed-names.test.ts.
 */

const ORDERS_DB = 'orders-db'; // has the computed name that references a lookup
const CUSTOMERS_DB = 'customers-db'; // the related record whose field/title drives the name
const RELATION_ID = 'rel-1';
const CUST_FIELD_ID = 'customer-field-id'; // relation field on ORDERS_DB (side a)
const ORDERS_FIELD_ID = 'orders-field-id'; // relation field on CUSTOMERS_DB (side b)
const CUST_NAME_FIELD_ID = 'customer-name-field-id'; // text field on CUSTOMERS_DB
const CUST_OTHER_FIELD_ID = 'customer-other-field-id'; // a field the lookup does NOT target

const RELATION = {
  id: RELATION_ID,
  databaseAId: ORDERS_DB,
  databaseBId: CUSTOMERS_DB,
  fieldAId: CUST_FIELD_ID,
  fieldBId: ORDERS_FIELD_ID,
};

/** ORDERS_DB: a computed title `concat("Order for ", {Customer Name})`, where
 * `customer_name` is a LOOKUP through the `customer` relation of CUSTOMERS_DB's
 * `cust_name` field. */
function ordersDefs(source = 'concat("Order for ", {customer_name})'): FieldDef[] {
  const titleAst = parseFormula(source, [{ api_name: 'customer_name', display_name: 'Customer Name', formula_type: 'text' }]);
  return [
    { id: 'orders-title-id', api_name: 'name', type: 'title', config: { name_mode: 'computed', ast: titleAst } },
    { id: CUST_FIELD_ID, api_name: 'customer', type: 'relation', config: { relation_id: RELATION_ID, side: 'a' } },
    {
      id: 'orders-lookup-id',
      api_name: 'customer_name',
      type: 'lookup',
      config: { relation_field_id: CUST_FIELD_ID, target_field_api_name: 'cust_name' },
    },
  ];
}

/** ORDERS_DB with an own-record-only computed title (references no lookup/rollup). */
function ordersDefsOwnRecordName(): FieldDef[] {
  const titleAst = parseFormula('concat("Order ", "static")', []);
  return [
    { id: 'orders-title-id', api_name: 'name', type: 'title', config: { name_mode: 'computed', ast: titleAst } },
    { id: CUST_FIELD_ID, api_name: 'customer', type: 'relation', config: { relation_id: RELATION_ID, side: 'a' } },
    {
      id: 'orders-lookup-id',
      api_name: 'customer_name',
      type: 'lookup',
      config: { relation_field_id: CUST_FIELD_ID, target_field_api_name: 'cust_name' },
    },
  ];
}

const customersDefs: FieldDef[] = [
  { id: 'customers-title-id', api_name: 'name', type: 'title', config: {} },
  { id: CUST_NAME_FIELD_ID, api_name: 'cust_name', type: 'text', config: {} },
  { id: CUST_OTHER_FIELD_ID, api_name: 'tier', type: 'text', config: {} },
  { id: ORDERS_FIELD_ID, api_name: 'orders', type: 'relation', config: { relation_id: RELATION_ID, side: 'b' } },
];

/** ORDERS_DB whose name looks up the customer's TITLE (`name`), not a plain field. */
function ordersDefsLookupTitle(): FieldDef[] {
  const titleAst = parseFormula('concat("Order for ", {customer_name})', [
    { api_name: 'customer_name', display_name: 'Customer Name', formula_type: 'text' },
  ]);
  return [
    { id: 'orders-title-id', api_name: 'name', type: 'title', config: { name_mode: 'computed', ast: titleAst } },
    { id: CUST_FIELD_ID, api_name: 'customer', type: 'relation', config: { relation_id: RELATION_ID, side: 'a' } },
    {
      id: 'orders-lookup-id',
      api_name: 'customer_name',
      type: 'lookup',
      config: { relation_field_id: CUST_FIELD_ID, target_field_api_name: 'name' }, // the customer's TITLE
    },
  ];
}

function makeDb(opts: { relations?: (typeof RELATION)[]; relationById?: typeof RELATION | null; linkedOtherIds?: string[] }) {
  return {
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
  } as unknown as Db;
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

/** Stubs fieldDefs() per-db and spies on BOTH recompute entry points (their DB
 * work is covered by the integration suite); returns the title spy to assert on. */
function stub(service: RecordsService, defsByDb: Record<string, FieldDef[]>) {
  vi.spyOn(service, 'fieldDefs').mockImplementation(async (databaseId: string) => defsByDb[databaseId] ?? []);
  vi.spyOn(service, 'recomputeRollupsForRelationField').mockResolvedValue(undefined);
  return vi.spyOn(service, 'recomputeTitlesForRecords').mockResolvedValue(undefined);
}

describe('#132 cross-record names — case (a): a related record\'s own field changed', () => {
  it('recomputes titles on the OTHER side when the changed field is the one a title\'s lookup targets', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['order-1', 'order-2'] });
    const service = makeService(db);
    const titles = stub(service, { [CUSTOMERS_DB]: customersDefs, [ORDERS_DB]: ordersDefs() });

    await service.invalidateRollupsForChange({
      databaseId: CUSTOMERS_DB,
      recordId: 'cust-1',
      changedFieldIds: [CUST_NAME_FIELD_ID], // the field the orders lookup reads
    });

    expect(titles).toHaveBeenCalledExactlyOnceWith(ORDERS_DB, ['order-1', 'order-2']);
  });

  it('does NOT recompute titles when the changed field is not the one the title\'s lookup targets', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['order-1'] });
    const service = makeService(db);
    const titles = stub(service, { [CUSTOMERS_DB]: customersDefs, [ORDERS_DB]: ordersDefs() });

    await service.invalidateRollupsForChange({
      databaseId: CUSTOMERS_DB,
      recordId: 'cust-1',
      changedFieldIds: [CUST_OTHER_FIELD_ID], // `tier` — the lookup targets `cust_name`, not this
    });

    expect(titles).not.toHaveBeenCalled();
  });

  it('does NOT recompute titles for an own-record-only computed name (no cross-record ref)', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['order-1'] });
    const service = makeService(db);
    const titles = stub(service, { [CUSTOMERS_DB]: customersDefs, [ORDERS_DB]: ordersDefsOwnRecordName() });

    await service.invalidateRollupsForChange({
      databaseId: CUSTOMERS_DB,
      recordId: 'cust-1',
      changedFieldIds: [CUST_NAME_FIELD_ID],
    });

    expect(titles).not.toHaveBeenCalled();
  });

  it('recomputes titles when the related record\'s TITLE changed and the name looks up that title (titleChanged, no changedFieldIds)', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: ['order-1'] });
    const service = makeService(db);
    const titles = stub(service, { [CUSTOMERS_DB]: customersDefs, [ORDERS_DB]: ordersDefsLookupTitle() });

    // A freetext customer rename carries no changedFieldId — only titleChanged.
    await service.invalidateRollupsForChange({
      databaseId: CUSTOMERS_DB,
      recordId: 'cust-1',
      changedFieldIds: [],
      titleChanged: true,
    });

    expect(titles).toHaveBeenCalledExactlyOnceWith(ORDERS_DB, ['order-1']);
  });

  it('does NOT recompute when the changed record is not currently linked to anything on the other side', async () => {
    const db = makeDb({ relations: [RELATION], linkedOtherIds: [] });
    const service = makeService(db);
    const titles = stub(service, { [CUSTOMERS_DB]: customersDefs, [ORDERS_DB]: ordersDefs() });

    await service.invalidateRollupsForChange({
      databaseId: CUSTOMERS_DB,
      recordId: 'cust-1',
      changedFieldIds: [CUST_NAME_FIELD_ID],
    });

    expect(titles).not.toHaveBeenCalled();
  });
});

describe('#132 cross-record names — case (b): this record\'s own relation link-set changed', () => {
  it('recomputes this record\'s own title (its lookup set changed) and the other side\'s', async () => {
    const db = makeDb({ relationById: RELATION });
    const service = makeService(db);
    const titles = stub(service, { [ORDERS_DB]: ordersDefs(), [CUSTOMERS_DB]: customersDefs });

    await service.invalidateRollupsForChange({
      databaseId: ORDERS_DB,
      recordId: 'order-1',
      linkedRelations: [
        { relationId: RELATION_ID, fieldId: CUST_FIELD_ID, otherDatabaseId: CUSTOMERS_DB, otherRecordIds: ['cust-1', 'cust-2'] },
      ],
    });

    // Own-side: this order's own title, because its `customer` link (and thus its
    // `customer_name` lookup) just changed.
    expect(titles).toHaveBeenNthCalledWith(1, ORDERS_DB, ['order-1']);
    // Other-side: the customers whose link membership changed (no-op there unless
    // THEY have a cross-record name, but the wiring still fires).
    expect(titles).toHaveBeenNthCalledWith(2, CUSTOMERS_DB, ['cust-1', 'cust-2']);
    expect(titles).toHaveBeenCalledTimes(2);
  });

  it('still recomputes the owner\'s own title even when the relation no longer resolves', async () => {
    const db = makeDb({ relationById: null });
    const service = makeService(db);
    const titles = stub(service, { [ORDERS_DB]: ordersDefs() });

    await service.invalidateRollupsForChange({
      databaseId: ORDERS_DB,
      recordId: 'order-1',
      linkedRelations: [
        { relationId: RELATION_ID, fieldId: CUST_FIELD_ID, otherDatabaseId: CUSTOMERS_DB, otherRecordIds: ['cust-1'] },
      ],
    });

    expect(titles).toHaveBeenCalledExactlyOnceWith(ORDERS_DB, ['order-1']);
  });
});
