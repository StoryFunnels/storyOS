import { describe, expect, it } from 'vitest';
import { blockingFields, isEmptyValue, planField } from './copy-mapping';
import type { DestinationField } from './copy-mapping';
import { DryRunBuilder } from './dry-run';

/**
 * #432 — the refuse contract.
 *
 * The failure being prevented is a copy that looks complete while missing data.
 * So these test what must be KEPT as much as what must be refused — #305's
 * lesson, where conflating "not configured" with "invalid" deleted people's
 * dashboard tiles.
 */

const dest = (over: Partial<DestinationField> & { id: string; displayName: string; type: string }): DestinationField => ({
  apiName: over.displayName.toLowerCase().replace(/\W+/g, '_'),
  ...over,
});

const DESTS: DestinationField[] = [
  dest({ id: 'd-note', displayName: 'Note', type: 'text' }),
  dest({ id: 'd-company', displayName: 'Company Name', type: 'text' }),
  dest({ id: 'd-calc', displayName: 'Total', type: 'formula' }),
  dest({ id: 'd-epic', displayName: 'Epic', type: 'relation', targetDatabaseId: 'db-epics' }),
];

const src = (key: string, sourceType: string, label = key) => ({ key, label, sourceType });

describe('#432 — three states and no fourth', () => {
  it('maps a field whose name matches, in any spelling', () => {
    // Reuses the shared matcher: company_name ↔ Company Name ↔ companyName.
    const plan = planField(src('company_name', 'text', 'company_name'), DESTS, { hasValue: true });
    expect(plan.state).toBe('mapped');
    expect(plan.to).toEqual({ kind: 'existing', field_id: 'd-company' });
  });

  it('BLOCKS a field that has a value and no destination, and names it', () => {
    const plan = planField(src('estimate', 'number', 'Estimate'), DESTS, { hasValue: true });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toContain('Estimate');
    // The way forward is stated, or the user is just stuck.
    expect(plan.reason).toMatch(/skip it explicitly/i);
  });

  it('does NOT block a field with no destination and no value', () => {
    // Refusing over an empty field would make the feature unusable the first
    // time two schemas do not line up perfectly.
    const plan = planField(src('estimate', 'number', 'Estimate'), DESTS, { hasValue: false });
    expect(plan.state).toBe('skipped');
  });

  it('an explicit skip unblocks, and is recorded as a skip not a mapping', () => {
    const plan = planField(src('estimate', 'number', 'Estimate'), DESTS, { hasValue: true, skipped: true });
    expect(plan.state).toBe('skipped');
    expect(plan.to).toEqual({ kind: 'skip' });
    expect(blockingFields([plan])).toEqual([]);
  });

  it('never offers an unwritable destination', () => {
    // `Total` is a formula. Matching it would pre-select a destination that is
    // guaranteed to fail on write.
    const plan = planField(src('total', 'number', 'Total'), DESTS, { hasValue: true });
    expect(plan.state).toBe('blocking');
    expect(JSON.stringify(plan.to)).not.toContain('d-calc');
  });
});

describe('#432 — relations, where the rule is subtlest', () => {
  it('maps a relation only when both sides target the SAME database', () => {
    const plan = planField(src('epic', 'relation', 'Epic'), DESTS, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-epics',
    });
    expect(plan.state).toBe('mapped');
    expect(plan.to).toEqual({ kind: 'relation', field_id: 'd-epic' });
  });

  it('BLOCKS a relation pointing at a different database', () => {
    // Record ids only mean something to the database they point at. A relation
    // to a different one would import ids that resolve to nothing — or worse,
    // to the wrong rows.
    const plan = planField(src('epic', 'relation', 'Epic'), DESTS, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-something-else',
    });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toContain('Epic');
  });

  it('an EMPTY relation never blocks, whatever it points at', () => {
    // #431's adapter omits empty relations for exactly this reason. Nothing
    // would be lost, so refusing would be theatre.
    const plan = planField(src('epic', 'relation', 'Epic'), DESTS, {
      hasValue: false,
      sourceTargetDatabaseId: 'db-something-else',
    });
    expect(plan.state).toBe('skipped');
  });

  it('treats SEVERAL valid relations as a choice to offer, naming them', () => {
    // "Blocked by" and "Duplicates" both pointing at Issues is a legitimate
    // shape. Guessing one is a coin flip the user cannot see.
    const many = [
      ...DESTS,
      dest({ id: 'd-epic2', displayName: 'Secondary epic', type: 'relation', targetDatabaseId: 'db-epics' }),
    ];
    const plan = planField(src('epic', 'relation', 'Epic'), many, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-epics',
    });
    expect(plan.state).toBe('blocking');
    expect(plan.ambiguousWith).toEqual([
      { field_id: 'd-epic', display_name: 'Epic' },
      { field_id: 'd-epic2', display_name: 'Secondary epic' },
    ]);
    expect(plan.reason).toMatch(/more than one/i);
  });
});

describe('#432 — emptiness is tested explicitly, never by falsiness', () => {
  it('treats false and 0 as PRESENT', () => {
    // The single most likely way to break this: `if (!value)`. A copy that
    // dropped `Done = false` and `Estimate = 0` would look complete (#345).
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(0)).toBe(false);
  });

  it('treats the genuinely empty things as empty', () => {
    for (const v of [undefined, null, '', []]) expect(isEmptyValue(v)).toBe(true);
  });

  it('so a `false` value still blocks when it has nowhere to go', () => {
    // The consequence that matters: falsiness would have made this "skipped",
    // silently losing the value.
    const plan = planField(src('done', 'checkbox', 'Done'), DESTS, { hasValue: !isEmptyValue(false) });
    expect(plan.state).toBe('blocking');
  });
});

describe('#432 — blocking is not a warning', () => {
  it('keeps the two lists apart in the dry-run report', () => {
    // A warning is "proceed knowing this"; a block is "you cannot proceed".
    // Collapsed into one list, a block becomes a warning nobody reads.
    const b = new DryRunBuilder();
    b.addWarning({ message: 'coerced "12 apples" to 12' });
    b.addBlocking('epic', 'Epic links to records the destination has no relation for.');
    const report = b.build();
    expect(report.warnings).toHaveLength(1);
    expect(report.blocking).toEqual([{ sourceKey: 'epic', message: expect.stringContaining('Epic') }]);
    expect(b.isBlocked).toBe(true);
  });

  it('omits `blocking` entirely when nothing blocks, so CSV and Linear are unchanged', () => {
    const b = new DryRunBuilder();
    b.addWarning({ message: 'a warning' });
    expect(b.build()).not.toHaveProperty('blocking');
    expect(b.isBlocked).toBe(false);
  });
});

describe('#605 — an explicit override wins over auto-match, ambiguity, and skip-by-omission', () => {
  it('redirects a field to a destination auto-match would NOT have chosen', () => {
    // "Note" auto-matches by name; overriding to "Company Name" instead.
    const plan = planField(src('note', 'text', 'Note'), DESTS, { hasValue: true, override: 'd-company' });
    expect(plan.state).toBe('mapped');
    expect(plan.to).toEqual({ kind: 'existing', field_id: 'd-company' });
  });

  it('resolves an ambiguous relation by naming the SPECIFIC candidate (the ambiguousWith field_id)', () => {
    const many = [
      ...DESTS,
      dest({ id: 'd-epic2', displayName: 'Secondary epic', type: 'relation', targetDatabaseId: 'db-epics' }),
    ];
    // First confirm it's genuinely ambiguous without an override...
    const ambiguous = planField(src('epic', 'relation', 'Epic'), many, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-epics',
    });
    expect(ambiguous.state).toBe('blocking');
    const chosen = ambiguous.ambiguousWith!.find((c) => c.display_name === 'Secondary epic')!;

    // ...then resolve it by naming that exact candidate's field_id.
    const resolved = planField(src('epic', 'relation', 'Epic'), many, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-epics',
      override: chosen.field_id,
    });
    expect(resolved.state).toBe('mapped');
    expect(resolved.to).toEqual({ kind: 'relation', field_id: 'd-epic2' });
  });

  it('refuses (blocking, not silently ignored) an override naming a field that does not exist in the destination', () => {
    const plan = planField(src('note', 'text', 'Note'), DESTS, { hasValue: true, override: 'no-such-field' });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toMatch(/does not exist/i);
  });

  it('refuses an override sending a relation source to a NON-relation destination', () => {
    const plan = planField(src('epic', 'relation', 'Epic'), DESTS, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-epics',
      override: 'd-note', // a text field, not a relation
    });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toMatch(/only be mapped to a relation field/i);
  });

  it('refuses an override sending a scalar source to a relation destination', () => {
    const plan = planField(src('note', 'text', 'Note'), DESTS, { hasValue: true, override: 'd-epic' });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toMatch(/cannot be mapped to a relation field/i);
  });

  it('refuses an override naming a relation destination that targets the WRONG database', () => {
    const plan = planField(src('epic', 'relation', 'Epic'), DESTS, {
      hasValue: true,
      sourceTargetDatabaseId: 'db-something-else', // the source actually points elsewhere
      override: 'd-epic', // targets db-epics
    });
    expect(plan.state).toBe('blocking');
    expect(plan.reason).toMatch(/same database/i);
  });

  it('refuses an override naming an UNWRITABLE destination (formula) — same rule as auto-match', () => {
    const plan = planField(src('note', 'text', 'Note'), DESTS, { hasValue: true, override: 'd-calc' });
    expect(plan.state).toBe('blocking');
  });

  it('MUST KEEP WORKING: with no override, auto-match/ambiguity/skip-by-omission behave exactly as before', () => {
    const matched = planField(src('note', 'text', 'Note'), DESTS, { hasValue: true });
    expect(matched.state).toBe('mapped');
    expect(matched.to).toEqual({ kind: 'existing', field_id: 'd-note' });
  });
});
