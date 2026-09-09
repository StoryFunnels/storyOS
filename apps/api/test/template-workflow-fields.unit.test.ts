import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/templates/definitions';
import { STARTER_PACKS } from '../src/packs/starter-packs';

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
 *
 * Covers BOTH surfaces the ticket named: `templates/definitions/*.ts` (the
 * `display_name` DSL) and `packs/starter-packs.ts` (the manifest DSL, which
 * names the same property `name`) — the two were audited and fixed
 * separately in this codebase's history and had drifted: definitions/*.ts
 * was already converted by the time this file's TEMPLATES-only checks were
 * written, but starter-packs.ts's own 18 lifecycle fields were still plain
 * `select` until #218 closed the gap. One shared check over both sources is
 * what keeps a THIRD manifest format from repeating the drift silently.
 */
const LIFECYCLE = /^(status|state|stage|phase)$/i;

interface TField {
  display_name?: string;
  name?: string;
  type?: string;
}

interface TDatabase {
  name: string;
  fields?: TField[];
}

interface Source {
  label: string;
  databases: TDatabase[];
}

const SOURCES: Source[] = [
  ...TEMPLATES.map((t) => ({ label: t.slug, databases: (t.databases ?? []) as TDatabase[] })),
  ...STARTER_PACKS.map((p) => ({
    label: p.slug,
    databases: (p.manifest.databases ?? []) as unknown as TDatabase[],
  })),
];

describe('template + pack lifecycle status fields (#218)', () => {
  it('never seeds two workflow fields in one database — that is a 409 on apply', () => {
    for (const source of SOURCES) {
      for (const db of source.databases) {
        const workflows = (db.fields ?? []).filter((f) => f.type === 'workflow');
        expect(
          workflows.length,
          `${source.label} → ${db.name} has ${workflows.length} workflow fields: ${workflows
            .map((f) => f.display_name ?? f.name)
            .join(', ')}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses workflow (not select) for a field named like a lifecycle status', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const source of SOURCES) {
      for (const db of source.databases) {
        for (const f of db.fields ?? []) {
          const label = f.display_name ?? f.name ?? '';
          if (!LIFECYCLE.test(label)) continue;
          checked += 1;
          if (f.type !== 'workflow') offenders.push(`${source.label} → ${db.name} → ${label} is ${f.type}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
    // Guard the guard: if a rename made LIFECYCLE match nothing, this test would
    // pass while asserting about an empty set.
    expect(checked).toBeGreaterThan(30);
  });
});
