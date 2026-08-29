/**
 * #451 — the determinism claim, asserted where it is cheap to assert.
 *
 * The plan is pure, so "the same --seed produces the same data" is a
 * millisecond-scale property test rather than a two-minute reseed-and-diff. If
 * this file goes red, every finding from every agent environment built after
 * the change is suspect, which is exactly the failure the ticket names.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { buildPlan } from '../src/seed/plan';
import { Rng, SEED_EPOCH, daysBefore } from '../src/seed/rng';
import { parseArgs, planHash } from '../src/seed/agent-uat';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

describe('#451 — agent UAT seed plan', () => {
  it('is byte-identical for the same seed, and different for a different one', () => {
    const a = buildPlan('nadia', '1');
    const b = buildPlan('nadia', '1');
    expect(hash(a)).toBe(hash(b));
    expect(hash(buildPlan('nadia', '2'))).not.toBe(hash(a));
  });

  it('does not depend on the wall clock — no timestamp is later than the fixed epoch', () => {
    // A plan that reaches for Date.now() looks deterministic in one process and
    // drifts across days. Every generated date must sit at or before SEED_EPOCH.
    const plan = buildPlan('nadia', '1');
    const dates: string[] = [];
    for (const ws of plan.workspaces) {
      for (const db of ws.databases) {
        for (const record of db.records) {
          dates.push(record.created_at, record.updated_at, ...record.edits.map((e) => e.at));
        }
      }
    }
    expect(dates.length).toBeGreaterThan(1000);
    const latest = dates.reduce((m, d) => (d > m ? d : m));
    expect(new Date(latest).getTime()).toBeLessThanOrEqual(SEED_EPOCH.getTime());
  });

  it("hits Nadia's sizes: 11 workspaces, ~18 databases, ~2,400 records, one database over 500", () => {
    const plan = buildPlan('nadia', '1');
    expect(plan.totals.workspaces).toBe(11);
    expect(plan.totals.databases).toBeGreaterThanOrEqual(17);
    expect(plan.totals.databases).toBeLessThanOrEqual(19);
    expect(plan.totals.records).toBeGreaterThanOrEqual(2300);
    const biggest = Math.max(
      ...plan.workspaces.flatMap((w) => w.databases.map((d) => d.records.length)),
    );
    expect(biggest).toBeGreaterThan(500);
  });

  it('is deliberately uneven — two large, six medium, three nearly empty', () => {
    const sizes = buildPlan('nadia', '1').workspaces.map((w) => w.size);
    expect(sizes.filter((s) => s === 'large')).toHaveLength(2);
    expect(sizes.filter((s) => s === 'medium')).toHaveLength(6);
    expect(sizes.filter((s) => s === 'tiny')).toHaveLength(3);
  });

  it('spreads six months of history and edits some records more than once', () => {
    const plan = buildPlan('nadia', '1');
    const records = plan.workspaces.flatMap((w) => w.databases.flatMap((d) => d.records));
    const oldest = records.reduce((m, r) => (r.created_at < m ? r.created_at : m), records[0]!.created_at);
    const spanDays = (SEED_EPOCH.getTime() - new Date(oldest).getTime()) / 86_400_000;
    expect(spanDays).toBeGreaterThan(150);
    expect(records.filter((r) => r.edits.length > 1).length).toBeGreaterThan(20);
    // Not everything was created at seed time — that is the whole point.
    expect(new Set(records.map((r) => r.created_at.slice(0, 10))).size).toBeGreaterThan(100);
  });

  it('plans a self-relation and a cross-space relation, and a guest on one space of several', () => {
    const flagship = buildPlan('nadia', '1').workspaces[0]!;
    const selfRel = flagship.relations.find((r) => r.a_key === r.b_key);
    expect(selfRel, 'a self-relation — one of the two shapes that break diagrams').toBeTruthy();
    expect(selfRel!.field_a_name).not.toBe(selfRel!.field_b_name);
    // A self-relation must never link a record to itself.
    expect(selfRel!.links.every((l) => l.from !== l.to)).toBe(true);

    const spaceOf = new Map(flagship.databases.map((d) => [d.key, d.space_key]));
    const crossRel = flagship.relations.find(
      (r) => r.a_key !== r.b_key && spaceOf.get(r.a_key) !== spaceOf.get(r.b_key),
    );
    expect(crossRel, 'a relation that genuinely crosses a space').toBeTruthy();

    expect(flagship.spaces.length).toBeGreaterThan(0);
    expect(flagship.guest_grant?.space_key).toBe('delivery');
  });

  it('names are obviously synthetic — nothing reads as a real company', () => {
    const plan = buildPlan('nadia', '1');
    for (const ws of plan.workspaces) {
      expect(ws.name).toMatch(
        /Northwind|Contoso|Fabrikam|Litware|Tailspin|Wingtip|Adventure Works|Proseware|Lucerne|Woodgrove|Fourth Coffee|Graphic Design Institute|Trey Research|Blue Yonder/,
      );
    }
    expect(plan.owner.email).toMatch(/@agents\.storyos\.invalid$/);
    expect(plan.guest!.email).toMatch(/@agents\.storyos\.invalid$/);
  });

  it("Kai's plan is one document-heavy, deliberately messy workspace", () => {
    const plan = buildPlan('kai', '1');
    expect(plan.totals.workspaces).toBe(1);
    expect(plan.totals.records).toBeGreaterThanOrEqual(850);
    const records = plan.workspaces[0]!.databases.flatMap((d) => d.records);
    expect(records.filter((r) => r.document && r.document.length > 0).length).toBeGreaterThan(300);
    // The states a fast solo user leaves behind: untitled rows and one-field rows.
    expect(records.filter((r) => r.title === '').length).toBeGreaterThan(10);
    expect(records.filter((r) => Object.keys(r.values).length === 1).length).toBeGreaterThan(10);
    expect(plan.guest).toBeNull();
  });

  it('plans at most one target per source on a one-to-many relation', () => {
    // The A side of a one-to-many holds exactly one link; the API 409s on a
    // second. A plan that asks for two produces a workspace whose links are
    // silently missing, which is how this was found.
    for (const ws of buildPlan('nadia', '1').workspaces) {
      for (const relation of ws.relations.filter((r) => r.cardinality === 'one_to_many')) {
        const sources = relation.links.map((l) => l.from);
        expect(new Set(sources).size, `${relation.key} links one target per source`).toBe(sources.length);
      }
    }
  });

  it('scale changes the volume but never the shape', () => {
    const full = buildPlan('nadia', '1');
    const small = buildPlan('nadia', '1', { scale: 0.01 });
    expect(small.totals.workspaces).toBe(full.totals.workspaces);
    expect(small.totals.databases).toBe(full.totals.databases);
    expect(small.totals.records).toBeLessThan(full.totals.records / 10);
    // Every structural case survives a scaled run, or a fast test proves nothing.
    expect(small.workspaces[0]!.relations.map((r) => r.key)).toEqual(
      full.workspaces[0]!.relations.map((r) => r.key),
    );
    expect(small.workspaces[0]!.guest_grant).toEqual(full.workspaces[0]!.guest_grant);
  });

  it('forked streams are independent — adding a draw in one does not shift another', () => {
    const a = new Rng('root').fork('b');
    const b = new Rng('root').fork('b');
    const c = new Rng('root').fork('c');
    expect(a.next()).toBe(b.next());
    expect(new Rng('root').fork('b').next()).not.toBe(c.next());
  });

  it('daysBefore never returns a future date', () => {
    const rng = new Rng('dates');
    for (let i = 0; i < 500; i++) {
      expect(daysBefore(rng, 183).getTime()).toBeLessThanOrEqual(SEED_EPOCH.getTime());
    }
  });

  it('parses its arguments, and refuses an unknown persona', () => {
    expect(parseArgs(['--persona', 'nadia'])).toEqual({ persona: 'nadia', seed: '1', scale: 1, dryRun: false });
    expect(parseArgs(['--persona=kai', '--seed=7', '--scale=0.5', '--dry-run'])).toEqual({
      persona: 'kai',
      seed: '7',
      scale: 0.5,
      dryRun: true,
    });
    expect(() => parseArgs(['--persona', 'nobody'])).toThrow(/nadia/);
    expect(() => parseArgs([])).toThrow(/persona/);
    expect(() => parseArgs(['--persona', 'kai', '--scale', '0'])).toThrow(/scale/);
  });

  it('the printed plan hash is stable, so two environments can be compared by eye', () => {
    expect(planHash(buildPlan('kai', '3'))).toBe(planHash(buildPlan('kai', '3')));
    expect(planHash(buildPlan('kai', '3'))).not.toBe(planHash(buildPlan('kai', '4')));
  });
});
