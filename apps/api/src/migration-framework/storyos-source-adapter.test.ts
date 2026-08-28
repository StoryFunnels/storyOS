import { describe, expect, it, vi } from 'vitest';
import { IMPORTABLE_FIELD_TYPES } from '@storyos/schemas';
import { StoryosSourceAdapter } from './storyos-source-adapter';
import type { StoryosSourceConfig } from './storyos-source-adapter';
import * as fieldTypeMapping from './field-type-mapping';

/**
 * #431 — a StoryOS database read through the same contract every importer uses.
 *
 * Unit-level with stubbed services: what is under test is the ADAPTER's
 * decisions — which types it reports, what it excludes, what it refuses to
 * resolve — none of which need a database to be true. The access-check
 * behaviour it inherits is asserted by construction (it calls the same
 * access-checked service methods every other read path does) and is covered
 * where those live.
 */

const FIELDS = [
  { id: 'f-title', apiName: 'name', displayName: 'Name', type: 'title' },
  { id: 'f-note', apiName: 'note', displayName: 'Note', type: 'text' },
  { id: 'f-num', apiName: 'estimate', displayName: 'Estimate', type: 'number' },
  { id: 'f-done', apiName: 'done', displayName: 'Done', type: 'checkbox' },
  {
    id: 'f-state',
    apiName: 'state',
    displayName: 'State',
    type: 'select',
    // Deliberately includes an option NO record uses — the schema is
    // authoritative, and a sampler would miss it.
    options: [{ id: 'o1', label: 'To Do' }, { id: 'o2', label: 'Done' }, { id: 'o3', label: 'Never Used' }],
  },
  {
    id: 'f-epic',
    apiName: 'epic',
    displayName: 'Epic',
    type: 'relation',
    relation: { target_database_id: 'db-epics' },
  },
  {
    id: 'f-empty-rel',
    apiName: 'blocked_by',
    displayName: 'Blocked by',
    type: 'relation',
    relation: { target_database_id: 'db-issues' },
  },
];

const ROW = {
  id: 'rec-1',
  title: 'Fix the bug',
  values: {
    name: 'Fix the bug',
    note: 'some prose',
    estimate: 0,
    done: false,
    state: 'o1',
    epic: [{ id: 'ep-1', title: 'Views' }, { id: 'ep-2', title: 'Records' }],
    blocked_by: [],
  },
};

function build(recordIds = ['rec-1']) {
  const databases = { get: vi.fn().mockResolvedValue({ fields: FIELDS }) };
  const records = { get: vi.fn().mockResolvedValue(ROW) };
  const adapter = new StoryosSourceAdapter(databases as never, records as never);
  const config: StoryosSourceConfig = {
    membership: { workspaceId: 'ws-1', userId: 'u-1' } as never,
    databaseId: 'db-1',
    recordIds,
  };
  return { adapter, databases, records, config };
}

describe('#431 — StoryosSourceAdapter', () => {
  it('reports the REAL StoryOS types and never infers', async () => {
    // Inference exists because a CSV column is just strings. Here the source is
    // already typed, so inferring would be lossy: a select holding two distinct
    // values infers as checkbox, and the copy would silently change shape.
    const spy = vi.spyOn(fieldTypeMapping, 'inferFieldType' as never);
    const { adapter, config } = build();
    await adapter.connect(config);
    const schema = adapter.readSchema();

    expect(schema.find((f) => f.key === 'state')!.sourceType).toBe('select');
    expect(schema.find((f) => f.key === 'estimate')!.sourceType).toBe('number');
    expect(spy).not.toHaveBeenCalled();
  });

  it('takes select options from the FIELD DEFINITION, not from observed values', async () => {
    const { adapter, config } = build();
    await adapter.connect(config);
    const state = adapter.readSchema().find((f) => f.key === 'state')!;
    // "Never Used" appears on no record. A sampler would drop it and the copy
    // would silently lose a valid destination option.
    expect(state.options).toEqual(['To Do', 'Done', 'Never Used']);
  });

  it('reads through the access-checked services, not the tables', async () => {
    // An adapter that reached for db.query would quietly become a way to read
    // rows the caller cannot see.
    const { adapter, databases, records, config } = build();
    await adapter.connect(config);
    await adapter.readRecords();
    expect(databases.get).toHaveBeenCalledWith(config.membership, 'db-1');
    expect(records.get).toHaveBeenCalledWith('db-1', 'rec-1');
  });

  it('honours recordIds — one record and many take the identical path', async () => {
    const { adapter, config } = build(['rec-1', 'rec-2', 'rec-3']);
    await adapter.connect(config);
    expect(await adapter.readRecords()).toHaveLength(3);
  });

  it('carries `false` and `0` rather than treating them as absent', async () => {
    // #345's lesson, one module over: emptiness tested explicitly, never by
    // falsiness. A copy that dropped `Done = false` would look complete.
    const { adapter, config } = build();
    await adapter.connect(config);
    const [rec] = await adapter.readRecords();
    expect(rec!.fields.done).toBe(false);
    expect(rec!.fields.estimate).toBe(0);
  });

  it('keeps relations OUT of `fields` — one representation per edge', async () => {
    const { adapter, config } = build();
    await adapter.connect(config);
    const [rec] = await adapter.readRecords();
    expect(rec!.fields).not.toHaveProperty('epic');
    expect(rec!.fields).not.toHaveProperty('blocked_by');
    expect(rec!.fields).toHaveProperty('note');
  });

  it('returns relations as RAW ids and resolves nothing', async () => {
    // The contract says resolution always happens in relation-resolver. The
    // titles are right there in the chip, and passing them along is the exact
    // shortcut that would make this source special-cased.
    const { adapter, config } = build();
    await adapter.connect(config);
    const links = await adapter.readRelations();
    const epic = links.find((l) => l.fieldKey === 'epic')!;
    expect(epic.toSourceIds).toEqual(['ep-1', 'ep-2']);
    expect(JSON.stringify(links)).not.toContain('Views');
  });

  it('OMITS an empty relation rather than emitting an empty edge', async () => {
    // "No edge" and "an edge to nothing" are different, and #432's blocking
    // rule turns on it: an empty relation must never block a copy.
    const { adapter, config } = build();
    await adapter.connect(config);
    const links = await adapter.readRelations();
    expect(links.map((l) => l.fieldKey)).toEqual(['epic']);
  });

  it('never sets `container` — a copy is single-database by #430', async () => {
    const { adapter, config } = build();
    await adapter.connect(config);
    const [rec] = await adapter.readRecords();
    expect(rec).not.toHaveProperty('container');
  });

  it('refuses to read before connect, rather than returning nothing', async () => {
    const { adapter } = build();
    await expect(adapter.readRecords()).rejects.toThrow(/connect/);
  });

  it('handles EVERY importable field type, so a new one fails here not in production', async () => {
    // #431 AC-8. When someone adds a field type to IMPORTABLE_FIELD_TYPES, this
    // is where the copy feature finds out.
    const fields = IMPORTABLE_FIELD_TYPES.map((type, i) => ({
      id: `f-${i}`,
      apiName: `f_${type}`,
      displayName: type,
      type,
    }));
    const databases = { get: vi.fn().mockResolvedValue({ fields }) };
    const values = Object.fromEntries(fields.map((f) => [f.apiName, `v-${f.type}`]));
    const records = { get: vi.fn().mockResolvedValue({ id: 'r', title: 't', values }) };
    const adapter = new StoryosSourceAdapter(databases as never, records as never);
    await adapter.connect({ membership: {} as never, databaseId: 'db-1', recordIds: ['r'] });

    const schema = adapter.readSchema();
    expect(schema.map((f) => f.sourceType).sort()).toEqual([...IMPORTABLE_FIELD_TYPES].sort());
    const [rec] = await adapter.readRecords();
    for (const type of IMPORTABLE_FIELD_TYPES) {
      expect(rec!.fields[`f_${type}`], `${type} must be carried`).toBe(`v-${type}`);
    }
  });
});
