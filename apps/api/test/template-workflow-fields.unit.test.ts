import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/templates/definitions';

/**
 * #218 — a database's LIFECYCLE status must be a `workflow` field, not a plain
 * `select`.
 *
 * Workflow is the canonical status: #172 allows exactly one per database, board
 * grouping prefers it, the mention badge renders it, and My Work keys off it. A
 * template that seeds a plain `select` called "Status" produces a workspace
 * where none of that works, and nobody notices until a board won't group.
 *
 * Two rules, and the second is the one that can actually break an install:
 * seeding TWO workflow fields in one database is a 409 from
 * assertNoExistingWorkflowField — the template would fail to apply at all.
 */
const LIFECYCLE = /^(status|state|stage|phase)$/i;

interface TField {
  display_name?: string;
  type?: string;
}

describe('template lifecycle status fields (#218)', () => {
  it('never seeds two workflow fields in one database — that is a 409 on apply', () => {
    for (const template of TEMPLATES) {
      for (const db of template.databases ?? []) {
        const workflows = (db.fields ?? []).filter((f: TField) => f.type === 'workflow');
        expect(
          workflows.length,
          `${template.slug} → ${db.name} has ${workflows.length} workflow fields: ${workflows
            .map((f: TField) => f.display_name)
            .join(', ')}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses workflow (not select) for a field named like a lifecycle status', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const template of TEMPLATES) {
      for (const db of template.databases ?? []) {
        for (const f of (db.fields ?? []) as TField[]) {
          if (!LIFECYCLE.test(f.display_name ?? '')) continue;
          checked += 1;
          if (f.type !== 'workflow') offenders.push(`${template.slug} → ${db.name} → ${f.display_name} is ${f.type}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    // Guard the guard: if a rename made LIFECYCLE match nothing, this test would
    // pass while asserting about an empty set.
    expect(checked).toBeGreaterThan(30);
  });
});
