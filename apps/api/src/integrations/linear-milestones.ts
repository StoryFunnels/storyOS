import { UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable } from '../db/schema';
import type { DatabasesService } from '../databases/databases.service';
import type { FieldsService } from '../fields/fields.service';
import type { RecordsService } from '../records/records.service';
import type { RelationsService } from '../relations/relations.service';
import type { RelationLinkerService } from '../migration-framework/relation-linker.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { pageAll } from './linear.service';
import type { LinearFetcher, LinearTeam } from './linear.service';

/**
 * Ticket #1364 — Linear project milestones.
 *
 * Linear's model (its published GraphQL schema, NOT yet exercised against the live API — see the PR): a `Project` has
 * `projectMilestones` (name, description, targetDate, sortOrder) and an `Issue` has one optional `projectMilestone`.
 * A milestone belongs to exactly ONE project, and a project can sit on several teams, so the same milestone is read
 * (and written) once for every team database whose project list holds that project. "The counts match Linear's" is
 * therefore defined on DISTINCT Linear milestone ids, never on the sum over teams.
 *
 * Everything new is here (and in one call each from linear.service.ts) so a parallel change to the importer meets this
 * file only at those seams.
 */

/** One milestone, flattened with the id of the project that owns it. */
export interface LinearMilestone {
  id: string;
  name: string;
  description: string | null;
  /** Linear's `TimelessDate` (`YYYY-MM-DD`). */
  targetDate: string | null;
  /** Linear's own manual ordering, a float. */
  sortOrder: number;
  projectId: string;
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const MILESTONE_FIELDS = 'id name description targetDate sortOrder';
/** Projects per request x nested milestones per project: kept modest because Linear rejects a query whose complexity is too high (NOT measured against the live API). */
export const MILESTONE_PROJECT_PAGE_SIZE = 50;
export const MILESTONE_NESTED_PAGE_SIZE = 50;
const MILESTONE_PAGE_SIZE = 100;

/** Every project of one team with its first page of milestones. A project with more than the nested page is re-read on its own (below). */
export const TEAM_PROJECT_MILESTONES_QUERY = `query TeamProjectMilestones($id: String!, $after: String) { team(id: $id) { projects(first: ${MILESTONE_PROJECT_PAGE_SIZE}, after: $after) { nodes { id projectMilestones(first: ${MILESTONE_NESTED_PAGE_SIZE}) { nodes { ${MILESTONE_FIELDS} } ${PAGE_INFO} } } ${PAGE_INFO} } } }`;
/** One project's milestones, paged to the end. */
export const PROJECT_MILESTONES_QUERY = `query ProjectMilestonesPaged($id: String!, $after: String) { project(id: $id) { projectMilestones(first: ${MILESTONE_PAGE_SIZE}, after: $after) { nodes { ${MILESTONE_FIELDS} } ${PAGE_INFO} } } }`;

interface RawMilestone { id: string; name: string; description?: string | null; targetDate?: string | null; sortOrder?: number | null }
interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RawProject { id: string; projectMilestones?: { nodes?: RawMilestone[]; pageInfo?: PageInfo } | null }

/**
 * Every milestone of every project the team has, paged to the end. Like every other read here it never assumes
 * completeness: a project that returns no milestone list at all is an ERROR (it would otherwise look like "this
 * project has none"), and a project with more milestones than the nested page is read again on its own.
 */
export async function fetchTeamMilestones(fetcher: LinearFetcher, apiKey: string, team: LinearTeam): Promise<LinearMilestone[]> {
  const projects = await pageAll<RawProject>(
    fetcher, apiKey, TEAM_PROJECT_MILESTONES_QUERY, { id: team.id },
    (d: { team?: { projects: never } }) => d.team?.projects, `projects of ${team.key} (for milestones)`,
  );
  const out = new Map<string, LinearMilestone>();
  for (const project of projects) {
    const list = project.projectMilestones;
    if (!list || !Array.isArray(list.nodes) || !list.pageInfo) {
      throw new UnprocessableEntityException(`Linear returned no milestone list for a project of ${team.key} (${project.id}) — cannot tell whether it has none, refusing to continue with a partial copy`);
    }
    const nodes = list.pageInfo.hasNextPage
      ? await pageAll<RawMilestone>(
        fetcher, apiKey, PROJECT_MILESTONES_QUERY, { id: project.id },
        (d: { project?: { projectMilestones: never } }) => d.project?.projectMilestones, `milestones of project ${project.id}`,
      )
      : list.nodes;
    for (const m of nodes) {
      out.set(m.id, {
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        targetDate: m.targetDate ? m.targetDate.slice(0, 10) : null,
        sortOrder: typeof m.sortOrder === 'number' ? m.sortOrder : 0,
        projectId: project.id,
      });
    }
  }
  return [...out.values()];
}

/** What an issue's milestone link resolves to. `unknown` names a milestone this read did not return. */
export interface MilestoneTally { linked: number; unplaced: number; unplacedIds: Set<string> }
export const newMilestoneTally = (): MilestoneTally => ({ linked: 0, unplaced: 0, unplacedIds: new Set() });

/**
 * The link set to write for one issue, in the same convention as the other Linear-owned links: `[]` = Linear says none
 * (so any link is removed), `[id]` = its milestone, `null` = Linear names a milestone we do not hold, which must be
 * COUNTED and reported, and must leave the existing link alone rather than clear it.
 */
export function milestoneTargets(linearMilestoneId: string | null | undefined, known: Map<string, string>, tally: MilestoneTally): string[] | null {
  if (!linearMilestoneId) return [];
  const target = known.get(linearMilestoneId);
  if (!target) {
    tally.unplaced++;
    tally.unplacedIds.add(linearMilestoneId);
    return null;
  }
  tally.linked++;
  return [target];
}

/** The Milestones database of a team space, with the ids the importer needs. */
export interface MilestonesPack {
  milestonesDb: { id: string; name: string };
  /** The Milestones-side relation to Projects. */
  projectFieldId: string;
}

export interface MilestoneDeps {
  db: Db;
  databases: DatabasesService;
  fields: FieldsService;
  records: RecordsService;
  relations: RelationsService;
  relationLinker: RelationLinkerService;
  /** Upsert by Linear id into a database; returns the record id. */
  upsert: (databaseId: string, linearId: string, values: Record<string, unknown>) => Promise<string>;
  /** Write a Linear body as the record description, only when it has none (never clobbers an edit). */
  describe: (databaseId: string, recordId: string, markdown: string | null) => Promise<void>;
}

const liveField = (db: Db, databaseId: string, apiName: string) =>
  db.query.fields.findFirst({ where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName), isNull(fieldsTable.deletedAt)) });

/**
 * Make sure a team space has a Milestones database linked to Projects, and that Issues point at it. Idempotent, and an
 * incremental upgrade: a mirror imported before this ticket has none and gets it on its next sync (the same way the Labels
 * database was added). It adds; it never deletes or renames anything a person made.
 */
export async function ensureMilestonesPack(
  deps: MilestoneDeps,
  membership: Membership,
  issuesDb: { id: string; spaceId: string },
  projectsDb: { id: string },
): Promise<MilestonesPack> {
  const { db } = deps;
  const inSpace = await db.query.databases.findMany({
    where: and(eq(databasesTable.workspaceId, membership.workspaceId), eq(databasesTable.spaceId, issuesDb.spaceId), isNull(databasesTable.deletedAt)),
  });
  const milestonesDb = inSpace.find((d) => d.name === 'Milestones')
    ?? await deps.databases.create(membership, { space_id: issuesDb.spaceId, name: 'Milestones', icon: '🏁' });
  for (const f of [
    { apiName: 'target_date', display_name: 'Target Date', type: 'date' as const },
    { apiName: 'sort_order', display_name: 'Sort Order', type: 'number' as const },
    { apiName: 'linear_id', display_name: 'Linear ID', type: 'text' as const },
  ]) {
    if (!(await liveField(db, milestonesDb.id, f.apiName))) await deps.fields.create(milestonesDb.id, { display_name: f.display_name, type: f.type, config: {} });
  }
  let projectField = await liveField(db, milestonesDb.id, 'project');
  if (!projectField) {
    // Milestones (many) -> Projects (one): a milestone has one project, a project has many milestones.
    await deps.relations.create(membership, {
      database_a_id: milestonesDb.id, database_b_id: projectsDb.id,
      cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Milestones',
    });
    projectField = await liveField(db, milestonesDb.id, 'project');
  }
  if (!(await liveField(db, issuesDb.id, 'milestone'))) {
    await deps.relations.create(membership, {
      database_a_id: issuesDb.id, database_b_id: milestonesDb.id,
      cardinality: 'one_to_many', field_a_name: 'Milestone', field_b_name: 'Issues',
    });
  }
  if (!projectField) throw new UnprocessableEntityException('The Milestones database has no Project relation after creating it — refusing to import milestones without it');
  return { milestonesDb: { id: milestonesDb.id, name: milestonesDb.name }, projectFieldId: projectField.id };
}

export interface TeamMilestoneResult {
  /** Linear milestone id -> the record id in THIS team's Milestones database, for the issue links. */
  ids: Map<string, string>;
  written: number;
  /** Milestones whose project this team's read does not hold: counted and warned about, never dropped silently. */
  orphaned: number;
  /** Milestone records in StoryOS that Linear no longer returns (deleted or archived there). Kept, never deleted. */
  notInLinear: string[];
}

/** Every milestone record already mirrored, by Linear id (paged read) — to tell which ones Linear no longer has. */
async function loadMilestoneMirror(deps: MilestoneDeps, databaseId: string, actorId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.records.query(databaseId, { filter: { field: 'linear_id', op: 'not_empty' }, sorts: [], limit: 200, cursor } as never, actorId);
    for (const r of page.data as Array<{ title?: string; values: Record<string, unknown> }>) {
      const linearId = r.values['linear_id'];
      if (typeof linearId === 'string') out.set(linearId, r.title ?? linearId);
    }
    if (!page.next_cursor) return out;
    cursor = page.next_cursor;
  }
}

/**
 * Write one team's milestones (idempotent by Linear id) and link each to its project. Linear owns every field written
 * here, so a sync sets them to Linear's values and sets the Project link to Linear's.
 */
export async function syncTeamMilestones(
  deps: MilestoneDeps,
  membership: Membership,
  actorId: string,
  a: { team: LinearTeam; pack: MilestonesPack; milestones: LinearMilestone[]; projectIds: Map<string, string>; warnings: string[] },
): Promise<TeamMilestoneResult> {
  const result: TeamMilestoneResult = { ids: new Map(), written: 0, orphaned: 0, notInLinear: [] };
  const { milestonesDb, projectFieldId } = a.pack;
  for (const m of a.milestones) {
    const projectRecord = a.projectIds.get(m.projectId);
    if (!projectRecord) {
      result.orphaned++;
      a.warnings.push(`team ${a.team.key}: milestone "${m.name}" (${m.id}) belongs to project ${m.projectId}, which this team's read did not return — not imported`);
      continue;
    }
    const id = await deps.upsert(milestonesDb.id, m.id, { name: m.name, target_date: m.targetDate, sort_order: m.sortOrder });
    await deps.describe(milestonesDb.id, id, m.description);
    const failure = await deps.relationLinker.set(membership.workspaceId, milestonesDb.id, id, projectFieldId, [projectRecord], actorId);
    if (failure) a.warnings.push(failure);
    result.ids.set(m.id, id);
    result.written++;
  }
  const seen = new Set(a.milestones.map((m) => m.id));
  for (const [linearId, title] of await loadMilestoneMirror(deps, milestonesDb.id, actorId)) {
    if (!seen.has(linearId)) result.notInLinear.push(title);
  }
  if (result.notInLinear.length > 0) {
    const shown = result.notInLinear.slice(0, 5).map((n) => `"${n}"`).join(', ');
    a.warnings.push(`team ${a.team.key}: ${result.notInLinear.length} milestone record(s) no longer exist in Linear (${shown}${result.notInLinear.length > 5 ? ', …' : ''}) — kept, not deleted`);
  }
  return result;
}

/** What a sync reports about milestones across all teams. `distinct` is the number to compare with Linear's. */
export interface MilestoneSummary {
  /** Distinct Linear milestone ids read across every team (a project on two teams counts its milestones once). */
  distinct: number;
  /** Milestone records written across team databases (a milestone of a project on two teams is written to both). */
  written: number;
  issue_links: { linked: number; unplaced: number };
  orphaned: number;
  not_in_linear: number;
  per_team: Array<{ key: string; milestones: number; written: number; issue_links: number; unplaced: number }>;
}

export const newMilestoneSummary = (): MilestoneSummary => ({
  distinct: 0, written: 0, issue_links: { linked: 0, unplaced: 0 }, orphaned: 0, not_in_linear: 0, per_team: [],
});

/** Fold one team's outcome into the run summary. `seen` carries the distinct ids across teams. */
export function addTeamMilestones(
  summary: MilestoneSummary,
  seen: Set<string>,
  team: LinearTeam,
  fetched: LinearMilestone[],
  result: TeamMilestoneResult,
  tally: MilestoneTally,
): void {
  for (const m of fetched) seen.add(m.id);
  summary.distinct = seen.size;
  summary.written += result.written;
  summary.orphaned += result.orphaned;
  summary.not_in_linear += result.notInLinear.length;
  summary.issue_links.linked += tally.linked;
  summary.issue_links.unplaced += tally.unplaced;
  summary.per_team.push({ key: team.key, milestones: fetched.length, written: result.written, issue_links: tally.linked, unplaced: tally.unplaced });
}

/** The preview's milestone numbers, from data already read (writes nothing). */
export function milestonePreview(teams: Array<{ team: LinearTeam; milestones: LinearMilestone[]; issues: Array<{ projectMilestone?: { id: string } | null }>; projectIds: string[] }>) {
  const distinct = new Set<string>();
  const projectTeams = new Map<string, number>();
  const per_team = teams.map(({ team, milestones, issues, projectIds }) => {
    for (const m of milestones) distinct.add(m.id);
    for (const p of projectIds) projectTeams.set(p, (projectTeams.get(p) ?? 0) + 1);
    const known = new Set(milestones.map((m) => m.id));
    const withMilestone = issues.filter((i) => i.projectMilestone?.id);
    return {
      key: team.key,
      milestones: milestones.length,
      issues_with_milestone: withMilestone.length,
      issues_with_unreadable_milestone: withMilestone.filter((i) => !known.has(i.projectMilestone!.id)).length,
    };
  });
  return {
    distinct: distinct.size,
    projects_on_several_teams: [...projectTeams.values()].filter((n) => n > 1).length,
    per_team,
  };
}
