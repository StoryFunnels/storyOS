import { UnprocessableEntityException } from '@nestjs/common';
import { linearStateCategory } from '@storyos/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fields as fieldsTable, relations as relationsTable, selectOptions } from '../db/schema';
import type { FieldsService } from '../fields/fields.service';
import type { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { pageAll } from './linear.service';
import type { LinearFetcher, LinearTeam } from './linear.service';

/**
 * Ticket #1365 — Linear issue relations (blocks, duplicate, related) as self relations on a team's Issues database.
 *
 * NOT RUN AGAINST LIVE LINEAR. Every Linear shape here (`Issue.relations`, `Issue.inverseRelations`, `IssueRelation.type`
 * with the values blocks / duplicate / related / similar, `IssueRelation.issue` / `.relatedIssue`) is from Linear's published
 * GraphQL schema. The probe on ticket #1362 is what proves them, and measures this query's cost.
 *
 * Kept out of linear.service.ts on purpose: that file is edited by several in-flight importer branches, and everything a
 * relation needs (the read, the plan, the field setup) is independent of them.
 */

/**
 * DECISION POINT (ruling on #1362: "decided after the probe"). What to do with a relation whose two issues are in DIFFERENT
 * Linear teams. Each team is its own space with its own Issues database, so such a link would need a cross-database
 * relation. Today the only implemented answer is 'report': the edge is NOT imported, it is counted (per team pair, never with
 * a title or identifier) in the sync summary and the preview, and a warning says so. If the probe shows the share is material,
 * the follow-up is one relation per team pair that actually occurs ('per_pair'), which is a code change here, not a switch.
 */
export const CROSS_TEAM_RELATION_POLICY = 'report' as const;

/** Nested relations of one issue are not paged; an issue with more than this many in one direction FAILS the read. */
export const ISSUE_RELATIONS_CAP = 50;
/** Smaller than the issue page: each issue carries two nested connections, so a page's complexity is multiplied. NOT measured. */
export const RELATIONS_ISSUE_PAGE_SIZE = 25;
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/** Its own query, not part of TEAM_ISSUES_QUERY: a separate complexity budget, and the issue read stays as it was. */
export const TEAM_RELATIONS_QUERY = `query TeamRelations($id: String!, $after: String) {
  team(id: $id) {
    issues(first: ${RELATIONS_ISSUE_PAGE_SIZE}, after: $after) {
      nodes {
        id
        relations(first: ${ISSUE_RELATIONS_CAP}) { nodes { id type relatedIssue { id team { key } } } ${PAGE_INFO} }
        inverseRelations(first: ${ISSUE_RELATIONS_CAP}) { nodes { id type issue { id team { key } } } ${PAGE_INFO} }
      }
      ${PAGE_INFO}
    }
  }
}`;
export const TEAM_RELATIONS_SINCE_QUERY = TEAM_RELATIONS_QUERY
  .replace('query TeamRelations($id: String!, $after: String)', 'query TeamRelationsSince($id: String!, $after: String, $since: DateTimeOrDuration!)')
  .replace(`issues(first: ${RELATIONS_ISSUE_PAGE_SIZE}, after: $after)`, `issues(first: ${RELATIONS_ISSUE_PAGE_SIZE}, after: $after, filter: { updatedAt: { gt: $since } })`);
if (!TEAM_RELATIONS_SINCE_QUERY.includes('updatedAt') || !TEAM_RELATIONS_SINCE_QUERY.includes('TeamRelationsSince')) {
  throw new Error('TEAM_RELATIONS_SINCE_QUERY no longer derives from TEAM_RELATIONS_QUERY');
}

export interface LinearRelationEdge {
  id: string;
  type: string;
  /** The OTHER issue: `relatedIssue` on an outgoing edge, `issue` on an incoming one. Only its id and team key are read. */
  other: { id: string; team: string | null };
}

/** One issue's relations in both directions, as read. */
export interface LinearIssueRelations {
  issueId: string;
  outgoing: LinearRelationEdge[];
  incoming: LinearRelationEdge[];
}

interface RawNode {
  id: string;
  relations?: { nodes?: Array<{ id: string; type: string; relatedIssue?: { id: string; team?: { key?: string } | null } | null }>; pageInfo?: { hasNextPage: boolean } };
  inverseRelations?: { nodes?: Array<{ id: string; type: string; issue?: { id: string; team?: { key?: string } | null } | null }>; pageInfo?: { hasNextPage: boolean } };
}

/**
 * Every relation of a team's issues, paged to the end. A nested list that is not known to be complete FAILS the read: a
 * dropped relation would be removed from the mirror on the next sync (Linear owns these links), which is a silent loss.
 * A full read must also cover every issue the issue read returned: a shorter list means the two reads disagree.
 */
export async function fetchTeamRelations(
  fetcher: LinearFetcher,
  apiKey: string,
  team: LinearTeam,
  opts: { since?: string; expectIssues?: number } = {},
): Promise<LinearIssueRelations[]> {
  const nodes = await pageAll<RawNode>(
    fetcher, apiKey,
    opts.since ? TEAM_RELATIONS_SINCE_QUERY : TEAM_RELATIONS_QUERY,
    opts.since ? { id: team.id, since: opts.since } : { id: team.id },
    (d: { team: { issues: never } }) => d.team?.issues,
    `relations of ${team.key}`,
  );
  const out: LinearIssueRelations[] = [];
  for (const n of nodes) {
    if (!n.relations?.pageInfo || n.relations.pageInfo.hasNextPage || !n.inverseRelations?.pageInfo || n.inverseRelations.pageInfo.hasNextPage) {
      throw new UnprocessableEntityException(`Linear issue ${n.id} in ${team.key} has more than ${ISSUE_RELATIONS_CAP} relations in one direction (or its relation list is incomplete) — refusing to import it without them`);
    }
    out.push({
      issueId: n.id,
      outgoing: (n.relations.nodes ?? []).filter((r) => r.relatedIssue).map((r) => ({ id: r.id, type: r.type, other: { id: r.relatedIssue!.id, team: r.relatedIssue!.team?.key ?? null } })),
      incoming: (n.inverseRelations.nodes ?? []).filter((r) => r.issue).map((r) => ({ id: r.id, type: r.type, other: { id: r.issue!.id, team: r.issue!.team?.key ?? null } })),
    });
  }
  if (opts.expectIssues !== undefined && out.length !== opts.expectIssues) {
    throw new UnprocessableEntityException(`Linear relations for ${team.key} cover ${out.length} issues but ${opts.expectIssues} were read — nothing was written. Re-run.`);
  }
  return out;
}

/** What one team's relations came to. Counts only: no titles, no identifiers, and a foreign team appears only as its key. */
export interface RelationReport {
  /** Edges by Linear type that this team will link (same team, both ends placeable). */
  blocks: number;
  duplicate: number;
  related: number;
  /** Linear's `similar` is its own suggestion engine, not a person's decision: never imported. */
  similar_ignored: number;
  /** A type this code does not know: not imported, named here so it is seen. */
  unknown_types: Record<string, number>;
  /** Edges to an issue of another team (see CROSS_TEAM_RELATION_POLICY). By `FROM→TO` team key, direction of the edge. */
  cross_team: Record<string, number>;
  /** Same team, but the other issue is not in the mirror (not read / not imported). */
  unplaced: number;
  /** An issue related to itself: not imported. */
  self_relation: number;
  /** An issue marked a duplicate of more than one: Linear allows one, so only the first is linked. */
  duplicate_of_extra_ignored: number;
}

export const emptyRelationReport = (): RelationReport => ({
  blocks: 0, duplicate: 0, related: 0, similar_ignored: 0, unknown_types: {}, cross_team: {}, unplaced: 0, self_relation: 0, duplicate_of_extra_ignored: 0,
});

/** What each field of one issue must hold, as Linear ids. */
export interface PlannedLinks {
  blocked_by: string[];
  blocks: string[];
  duplicate_of: string[];
  duplicates: string[];
  related: string[];
  related_to: string[];
}

/**
 * The pure core: Linear's relations of one issue → what each of its six fields must hold, plus the counts. Each issue is
 * planned from ITS OWN two lists, so an incremental read of one issue (which changed) is complete for that issue.
 *
 *  blocks:    A blocks B   →  B.blocked_by ∋ A, A.blocks ∋ B
 *  duplicate: A duplicate of B (Linear's `issue` is the duplicate)  →  A.duplicate_of = B, B.duplicates ∋ A
 *  related:   A related B  →  A.related ∋ B, B.related_to ∋ A  (Linear's edge has one direction; StoryOS shows it under both names)
 *
 * `crossTeam` collects each cross-team edge ONCE by its Linear id, so an edge between two imported teams (seen from both)
 * is not counted twice by the caller.
 */
export function planIssueRelations(
  rel: LinearIssueRelations,
  teamCode: string,
  placeable: (linearId: string) => boolean,
  report: RelationReport,
  crossTeam: Map<string, string>,
): PlannedLinks {
  const plan: PlannedLinks = { blocked_by: [], blocks: [], duplicate_of: [], duplicates: [], related: [], related_to: [] };
  const handle = (edge: LinearRelationEdge, outgoing: boolean) => {
    const type = edge.type;
    if (type === 'similar') { if (outgoing) report.similar_ignored++; return; }
    if (type !== 'blocks' && type !== 'duplicate' && type !== 'related') {
      if (outgoing) report.unknown_types[type] = (report.unknown_types[type] ?? 0) + 1;
      return;
    }
    if (edge.other.id === rel.issueId) { if (outgoing) report.self_relation++; return; }
    // Unknown team = Linear did not say; treated as foreign rather than guessed to be this one.
    if (edge.other.team !== teamCode) {
      const pair = outgoing ? `${teamCode}→${edge.other.team ?? '?'}` : `${edge.other.team ?? '?'}→${teamCode}`;
      if (!crossTeam.has(edge.id)) crossTeam.set(edge.id, pair);
      report.cross_team[pair] = (report.cross_team[pair] ?? 0) + 1;
      return;
    }
    if (!placeable(edge.other.id)) { if (outgoing) report.unplaced++; return; }
    if (type === 'blocks') { (outgoing ? plan.blocks : plan.blocked_by).push(edge.other.id); if (outgoing) report.blocks++; }
    else if (type === 'duplicate') { (outgoing ? plan.duplicate_of : plan.duplicates).push(edge.other.id); if (outgoing) report.duplicate++; }
    else { (outgoing ? plan.related : plan.related_to).push(edge.other.id); if (outgoing) report.related++; }
  };
  for (const e of rel.outgoing) handle(e, true);
  for (const e of rel.incoming) handle(e, false);
  // One duplicate-of per issue (the field is one-to-many): the first by edge id, deterministic, and the rest said out loud.
  if (plan.duplicate_of.length > 1) {
    report.duplicate_of_extra_ignored += plan.duplicate_of.length - 1;
    plan.duplicate_of = [plan.duplicate_of[0]!];
  }
  for (const k of Object.keys(plan) as Array<keyof PlannedLinks>) plan[k] = [...new Set(plan[k])];
  return plan;
}

/** Human-readable lines for the sync warnings; empty when there is nothing to say. */
export function relationWarnings(teamCode: string, r: RelationReport): string[] {
  const out: string[] = [];
  const cross = Object.entries(r.cross_team);
  if (cross.length) out.push(`team ${teamCode}: ${cross.reduce((n, [, c]) => n + c, 0)} relations to issues of another team were NOT imported (${cross.map(([p, c]) => `${p}: ${c}`).join(', ')}) — cross-team relations are not built yet (ticket #1365 decision point)`);
  if (r.unplaced) out.push(`team ${teamCode}: ${r.unplaced} relations point at issues that are not in the mirror and were not imported`);
  const unknown = Object.entries(r.unknown_types);
  if (unknown.length) out.push(`team ${teamCode}: relations of an unknown type were not imported (${unknown.map(([t, c]) => `${t}: ${c}`).join(', ')})`);
  if (r.duplicate_of_extra_ignored) out.push(`team ${teamCode}: ${r.duplicate_of_extra_ignored} issues are marked a duplicate of more than one issue; only the first was linked`);
  if (r.self_relation) out.push(`team ${teamCode}: ${r.self_relation} relations of an issue to itself were ignored`);
  return out;
}

/* ───────────────────────── the fields ───────────────────────── */

export type RelationRole = keyof PlannedLinks;

interface PairSpec {
  key: 'blocks' | 'duplicate' | 'related';
  cardinality: 'many_to_many' | 'one_to_many';
  aName: string;
  bName: string;
  a: RelationRole;
  b: RelationRole;
}
const PAIRS: PairSpec[] = [
  { key: 'blocks', cardinality: 'many_to_many', aName: 'Blocked by', bName: 'Blocks', a: 'blocked_by', b: 'blocks' },
  { key: 'duplicate', cardinality: 'one_to_many', aName: 'Duplicate of', bName: 'Duplicates', a: 'duplicate_of', b: 'duplicates' },
  { key: 'related', cardinality: 'many_to_many', aName: 'Related', bName: 'Related to', a: 'related', b: 'related_to' },
];

/** The field ids by role; a role is missing when its pair could not be set up (a warning says why). */
export type RelationFieldIds = Partial<Record<RelationRole, string>>;

/** The marker the importer stamps on the fields it owns: identity is the stamp, never the display name (ADR-0017's lesson). */
export const LINEAR_RELATION_CONFIG_KEY = 'linear_relation';

/**
 * Make sure the Issues database has the three self relations, creating what is missing. A database from before this
 * has none. A field is recognised by its stamp; failing that, an EXACT match (same names, one self relation, the right
 * cardinality and orientation) is adopted and stamped, so a team that built "Blocked by / Blocks" by hand keeps one pair
 * rather than getting a second ("Blocks 2" would be a trap). Anything else that holds a name is left alone and named in a
 * warning: the importer never writes into a field it cannot tell is its own.
 */
export async function ensureRelationFields(
  db: Db,
  relationsService: RelationsService,
  membership: Membership,
  issuesDbId: string,
  warnings: string[],
): Promise<RelationFieldIds> {
  const ids: RelationFieldIds = {};
  for (const spec of PAIRS) {
    const live = await db.query.fields.findMany({ where: and(eq(fieldsTable.databaseId, issuesDbId), isNull(fieldsTable.deletedAt)) });
    const stamped = (role: RelationRole) => live.find((f) => f.type === 'relation' && (f.config as Record<string, unknown>)[LINEAR_RELATION_CONFIG_KEY] === role);
    let a = stamped(spec.a);
    let b = stamped(spec.b);
    if (!a || !b) {
      const byName = (name: string) => live.find((f) => f.displayName.trim().toLowerCase() === name.toLowerCase());
      const na = byName(spec.aName);
      const nb = byName(spec.bName);
      if (!na && !nb) {
        const created = (await relationsService.create(membership, {
          database_a_id: issuesDbId, database_b_id: issuesDbId, cardinality: spec.cardinality, field_a_name: spec.aName, field_b_name: spec.bName,
        })) as { field_a: { id: string }; field_b: { id: string } };
        ids[spec.a] = created.field_a.id;
        ids[spec.b] = created.field_b.id;
        await stamp(db, created.field_a.id, spec.a);
        await stamp(db, created.field_b.id, spec.b);
        continue;
      }
      const cfgA = na?.type === 'relation' ? (na.config as { relation_id?: string; side?: string }) : null;
      const cfgB = nb?.type === 'relation' ? (nb.config as { relation_id?: string; side?: string }) : null;
      const rel = cfgA?.relation_id ? await db.query.relations.findFirst({ where: eq(relationsTable.id, cfgA.relation_id) }) : undefined;
      const exact =
        na && nb && cfgA && cfgB && rel && cfgA.relation_id === cfgB.relation_id && cfgA.side === 'a' && cfgB.side === 'b' &&
        rel.databaseAId === issuesDbId && rel.databaseBId === issuesDbId && rel.cardinality === spec.cardinality;
      if (!exact) {
        warnings.push(`relations (${spec.aName} / ${spec.bName}) were not imported: the Issues database already has a field named "${na ? spec.aName : spec.bName}" that is not a matching self relation. Rename it, then sync again.`);
        continue;
      }
      await stamp(db, na.id, spec.a);
      await stamp(db, nb.id, spec.b);
      a = na; b = nb;
    }
    ids[spec.a] = a.id;
    ids[spec.b] = b.id;
  }
  return ids;
}

async function stamp(db: Db, fieldId: string, role: RelationRole) {
  const row = await db.query.fields.findFirst({ where: eq(fieldsTable.id, fieldId), columns: { config: true } });
  await db.update(fieldsTable).set({ config: { ...((row?.config ?? {}) as Record<string, unknown>), [LINEAR_RELATION_CONFIG_KEY]: role } }).where(eq(fieldsTable.id, fieldId));
}

/* ───────────────────────── the Duplicate state ───────────────────────── */

/**
 * Linear documents its Duplicate workflow state as type `canceled`. The live mirror has a Duplicate State option with NO
 * category (the only one of 19 without one), and reading the sync code did not say why: `syncStatusOptions` sets a category
 * from the team's state type, so either Linear reports Duplicate with a type we do not map, or the option is not in the
 * team's workflow states at all and is left over from an older import that the sync never touches. This does not assume
 * which. It sets the category explicitly by NAME, and returns what it found, so the probe can read the cause off the report.
 */
export interface DuplicateStateReport {
  /** 'ok' already categorised · 'category_set' we set it · 'no_option' the database has no Duplicate option. */
  outcome: 'ok' | 'category_set' | 'no_option';
  /** The type Linear reports for the team's Duplicate state; null when the team's workflow has no state of that name. */
  linear_type: string | null;
  /** True when the team's workflow states do contain a Duplicate (so the option is not a leftover). */
  in_team_workflow: boolean;
  /** The category the option had before (null = none). */
  was: string | null;
}

export async function ensureDuplicateStateCategory(
  db: Db,
  fieldsService: FieldsService,
  issuesDbId: string,
  teamStates: Array<{ name: string; type: string }>,
): Promise<DuplicateStateReport> {
  const stateField = await db.query.fields.findFirst({
    where: and(eq(fieldsTable.databaseId, issuesDbId), eq(fieldsTable.apiName, 'state'), isNull(fieldsTable.deletedAt)),
  });
  const linearState = teamStates.find((s) => s.name.trim().toLowerCase() === 'duplicate');
  const base = { linear_type: linearState?.type ?? null, in_team_workflow: Boolean(linearState) };
  if (!stateField) return { ...base, outcome: 'no_option', was: null };
  const options = await db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, stateField.id) });
  const option = options.find((o) => o.label.trim().toLowerCase() === 'duplicate');
  if (!option) return { ...base, outcome: 'no_option', was: null };
  if (option.category) return { ...base, outcome: 'ok', was: option.category };
  // Linear's own type when it maps; otherwise `canceled`, which is what Linear documents for its Duplicate state.
  const category = (linearState ? linearStateCategory(linearState.type) : null) ?? 'canceled';
  await fieldsService.updateOption(issuesDbId, stateField.id, option.id, { category });
  return { ...base, outcome: 'category_set', was: null };
}
