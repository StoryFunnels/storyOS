import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automations, databases } from '../db/schema';
import { ACCESS_RANK, type AccessService, type EffectiveRole } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * Ticket #1280 / #1289 (Otto's ruling, 2026-11-13) - THE rule for who may read an automation rule's NAME, and how everyone else sees the rule.
 *
 * The gate is the one `GET /databases/{db}/automations` already enforces: `creator` on the rule's database. It lives here, as one
 * constant the controller's list route reads too, so a surface can never answer "may this viewer see the rule?" differently from the
 * route that lists the rules. It is deliberately NOT "who created the rule": a rule's author is no more entitled to it once they lose
 * the database, and the authored-by test is exactly the per-surface re-casing this replaces.
 *
 * `/approvals`, My work and the agent wake-sources endpoint all present a rule through `presentRules()` below. A new surface that names
 * a rule calls it; it does not read `automations.name` itself.
 */
export const AUTOMATIONS_READ_MIN: EffectiveRole = 'creator';

export interface PresentedRule {
  /** The rule's id; null when withheld (an id of an object the viewer may not read) and when no rule exists. */
  rule_id: string | null;
  /** The rule's CURRENT name, only for a viewer who may read that database's automations. null otherwise. */
  rule_name: string | null;
  /**
   * What to SHOW for the rule: the name when allowed, else a neutral "A rule in <database>" (the viewer can open that database), else
   * "A rule" (they cannot even see the database, so its name is not theirs either). null only when there is no rule at all - so
   * `rule_label !== null && rule_name === null` is how a client tells "withheld" from "none".
   */
  rule_label: string | null;
}

export const NO_RULE: PresentedRule = { rule_id: null, rule_name: null, rule_label: null };

/** Pure: may a viewer with this effective role on the rule's database read the rule? Mirrors `GET .../automations` (assertAccess min). */
export function mayReadRules(effective: EffectiveRole | null): boolean {
  return effective !== null && ACCESS_RANK[effective] >= ACCESS_RANK[AUTOMATIONS_READ_MIN];
}

/**
 * Resolve many rules at once for ONE viewer: one rules+databases read, one batched access resolution (a guest costs one grants fetch,
 * not one per rule). A rule id with no row (deleted) maps to NO_RULE. Never throws for a rule the viewer cannot read - that is the point.
 */
export async function presentRules(db: Db, access: AccessService, membership: Membership, ruleIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, PresentedRule>> {
  const ids = [...new Set(ruleIds.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, PresentedRule>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: automations.id, name: automations.name, databaseId: automations.databaseId, databaseName: databases.name, spaceId: databases.spaceId })
    .from(automations)
    .innerJoin(databases, eq(databases.id, automations.databaseId))
    .where(inArray(automations.id, ids));
  const effective = await access.effectiveForDatabases(membership, rows.map((r) => ({ id: r.databaseId, spaceId: r.spaceId })));
  for (const r of rows) {
    const role = effective.get(r.databaseId) ?? null;
    if (mayReadRules(role)) out.set(r.id, { rule_id: r.id, rule_name: r.name, rule_label: r.name });
    else out.set(r.id, { rule_id: null, rule_name: null, rule_label: role === null ? 'A rule' : `A rule in ${r.databaseName}` });
  }
  return out;
}

export function ruleFor(map: Map<string, PresentedRule>, ruleId: string | null | undefined): PresentedRule {
  return (ruleId && map.get(ruleId)) || NO_RULE;
}
