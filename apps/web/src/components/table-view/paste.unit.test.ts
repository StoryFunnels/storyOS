import { describe, expect, it } from 'vitest';
import { PASTE_WRONG_TARGET, coercePaste, resolvePasteSource, type CopiedCell } from './paste';
import type { Field } from './use-table-data';

/**
 * MN-119 paste rules, now unit-testable (MN-135). These were buried in a 700-line
 * component and could only be eyeballed; the logic lives in a pure module now.
 */

const field = (over: Partial<Field> & { type: string; id?: string }): Field =>
  ({ id: over.id ?? `f_${over.type}`, apiName: over.type, displayName: over.type, ...over }) as Field;

const copied = (f: Field, value: unknown): CopiedCell => ({ field: f, value });

describe('same-field paste — exact for every type', () => {
  it('pastes the copied value verbatim when the target IS the source field', () => {
    const sel = field({ type: 'select', id: 'state' });
    expect(coercePaste(sel, '', copied(sel, 'opt-1'))).toBe('opt-1');

    const user = field({ type: 'user', id: 'assignee' });
    expect(coercePaste(user, '', copied(user, 'usr-1'))).toBe('usr-1');
  });

  // A live user report: filling a relation column down/across several rows in
  // the SAME column tripped the backend's raw "expected an array of record
  // ids or numbers" validation instead of succeeding. `copied.value` for a
  // relation cell is always the display shape, {id,title}[] chips — never
  // bare ids, even when copying within one column — but this fast path used
  // to return it verbatim, bypassing the chip-to-id extraction the dedicated
  // relation → relation branch below does. This is the single most common
  // relation-paste case, and the one path that branch never covered (it only
  // ran when `copied.field.id !== target.id`).
  it('relation is excluded from the verbatim fast path — extracts ids from chips, even within the same column', () => {
    const epic = field({ type: 'relation', id: 'epic', relation: { target_database_id: 'db-A' } as never });
    expect(coercePaste(epic, '', copied(epic, [{ id: 'rec-1', title: 'Integrations & Agents' }]))).toEqual(
      ['rec-1'],
    );
  });
});

describe('user → user across different fields', () => {
  const single = field({ type: 'user', id: 'a', config: {} });
  const multi = field({ type: 'user', id: 'b', config: { multi: true } });

  it('copies a person into a single-user field', () => {
    expect(coercePaste(single, '', copied(multi, ['usr-1', 'usr-2']))).toBe('usr-1');
  });

  it('reshapes into a multi-user field as an array', () => {
    expect(coercePaste(multi, '', copied(single, 'usr-9'))).toEqual(['usr-9']);
  });

  it('an empty single-user paste clears to null', () => {
    expect(coercePaste(single, '', copied(multi, []))).toBeNull();
  });
});

describe('relation → relation only within the same target database', () => {
  const fromField = field({ type: 'relation', id: 'r1', relation: { target_database_id: 'db-A' } as never });
  const sameDb = field({ type: 'relation', id: 'r2', relation: { target_database_id: 'db-A' } as never });
  const otherDb = field({ type: 'relation', id: 'r3', relation: { target_database_id: 'db-B' } as never });

  it('pastes the target ids when both point at the same database', () => {
    expect(coercePaste(sameDb, '', copied(fromField, [{ id: 'rec-1' }, { id: 'rec-2' }]))).toEqual([
      'rec-1',
      'rec-2',
    ]);
  });

  it('refuses a paste across different databases', () => {
    expect(coercePaste(otherDb, '', copied(fromField, [{ id: 'rec-1' }]))).toBe(PASTE_WRONG_TARGET);
  });

  it('clears the target when the copied relation cell was empty', () => {
    expect(coercePaste(sameDb, '', copied(fromField, null))).toEqual([]);
    expect(coercePaste(sameDb, '', copied(fromField, []))).toEqual([]);
  });

  // MN-291: a live user report showed the backend's raw validation string
  // ("expected an array of record ids or numbers") instead of either success
  // or a clean refusal. Root-caused to `useRecordMutations`' optimistic cache
  // update (use-table-data.ts) writing a relation paste's own mutation
  // payload — a plain `string[]` of ids — straight into `row.values`, in the
  // shape the mutation *sends*, not the `{id,title}[]` chip shape the server
  // *returns*. Copying that same cell again before the mutation settles and
  // the query refetches hands `coercePaste` a `copied.value` of `string[]`
  // instead of chip objects.
  it('refuses when the copied "chips" are actually plain id strings (stale optimistic cache, MN-291)', () => {
    // Mapping `.id` over bare strings gives `undefined` for every entry —
    // exactly the malformed shape that used to slip through uncaught and
    // reach the mutation (surfacing the backend's raw error after JSON
    // serialized `undefined` array entries into `null`).
    const staleCacheValue = ['rec-1', 'rec-2'] as unknown;
    expect(coercePaste(sameDb, '', copied(fromField, staleCacheValue))).toBe(PASTE_WRONG_TARGET);
  });

  it('refuses when copied chips are malformed in other ways rather than sending undefined/null ids', () => {
    expect(coercePaste(sameDb, '', copied(fromField, [null, undefined, 42, 'bare-string']))).toBe(
      PASTE_WRONG_TARGET,
    );
    expect(coercePaste(sameDb, '', copied(fromField, 'not-an-array'))).toBe(PASTE_WRONG_TARGET);
  });

  it('keeps only the well-formed ids out of a partially malformed chip array', () => {
    // Filters rather than refuses when at least one entry is a genuine chip —
    // matches the documented "filter, don't blanket-refuse" rule for a
    // non-empty result.
    expect(
      coercePaste(sameDb, '', copied(fromField, [{ id: 'rec-1' }, { id: '' }, { title: 'no id' }, null])),
    ).toEqual(['rec-1']);
  });
});

describe('external text', () => {
  it('into a user field is passed through for server-side resolution (MN-118)', () => {
    // The API resolves a name/email or names the candidates — better than guessing here.
    expect(coercePaste(field({ type: 'user', id: 'x' }), 'Maya Rodriguez', null)).toBe('Maya Rodriguez');
    expect(coercePaste(field({ type: 'user', id: 'x' }), '', null)).toBeNull();
  });

  it('into a relation field is refused — a title cannot become a record id client-side', () => {
    expect(coercePaste(field({ type: 'relation', id: 'x' }), 'Some Title', null)).toBe(PASTE_WRONG_TARGET);
  });

  it('coerces scalars', () => {
    expect(coercePaste(field({ type: 'number', id: 'n' }), '1,234', null)).toBe(1234);
    expect(coercePaste(field({ type: 'checkbox', id: 'c' }), 'yes', null)).toBe(true);
    expect(coercePaste(field({ type: 'text', id: 't' }), 'hello', null)).toBe('hello');
  });

  it('resolves a select label to the target field option id', () => {
    const sel = field({ type: 'select', id: 's', options: [{ id: 'o1', label: 'Done', color: 'green' }] as never });
    expect(coercePaste(sel, 'done', null)).toBe('o1');
    expect(coercePaste(sel, 'Nonexistent', null)).toBeUndefined();
  });
});

describe('resolvePasteSource (MN-292)', () => {
  // Copy ONE relation cell (copyCell, not copyRange), then extend a range
  // (e.g. shift+arrow down) before pasting — reproduces the live report
  // "shift-down selects but doesn't paste": pasteRange used to only look at
  // the multi-cell range copy, so a lone single-cell copy vanished the
  // moment a range existed, and the resulting plain-text fallback is a
  // guaranteed PASTE_WRONG_TARGET for relation columns (see the "external
  // text into a relation field" case above).
  const relField = field({ type: 'relation', id: 'r1', relation: { target_database_id: 'db-A' } as never });
  const singleCopy: CopiedCell = { field: relField, value: [{ id: 'rec-1' }] };

  it('a range copy always wins, unchanged', () => {
    const rangeCopy: CopiedCell[][] = [[{ field: relField, value: [{ id: 'rec-9' }] }]];
    expect(resolvePasteSource(rangeCopy, singleCopy)).toBe(rangeCopy);
  });

  it('folds a lone single-cell copy into a 1x1 grid instead of vanishing', () => {
    expect(resolvePasteSource(null, singleCopy)).toEqual([[singleCopy]]);
  });

  it('is null when neither a range nor a single cell was copied', () => {
    expect(resolvePasteSource(null, null)).toBeNull();
  });

  it('end to end: the folded single-cell copy round-trips through coercePaste for a relation target, where raw clipboard text never could', () => {
    const sameDb = field({ type: 'relation', id: 'r2', relation: { target_database_id: 'db-A' } as never });
    const copiedCell = resolvePasteSource(null, singleCopy)![0]![0]!;
    expect(coercePaste(sameDb, '', copiedCell)).toEqual(['rec-1']);
    // The bug's failure mode: same paste, but with only clipboard text (no
    // in-session copy) — always refused for a relation target.
    expect(coercePaste(sameDb, 'Some Title', null)).toBe(PASTE_WRONG_TARGET);
  });
});
