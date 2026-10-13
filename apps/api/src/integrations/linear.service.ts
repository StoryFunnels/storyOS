import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { eq, or } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable, relations as relationsTable, selectOptions, spaces as spacesTable, workspaces } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { DocumentsService } from '../documents/documents.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { DryRunBuilder } from '../migration-framework/dry-run';
import { ExternalIdUpsertService } from '../migration-framework/external-id-upsert.service';
import { RelationLinkerService } from '../migration-framework/relation-linker.service';
import { pickOption } from '../migration-framework/select-options';
import { markdownToBlocks } from './markdown-to-blocks';
import { LinearSourceAdapter } from './linear-source-adapter';

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string | null;
}

export interface LinearTeamComplete extends LinearTeamData {
  /** Linear's own `Team.issueCount`, fetched separately from the walk. */
  issueTotal: number;
}

export interface LinearTeamData {
  labels: { nodes: LinearLabel[] };
  cycles: { nodes: Array<{ id: string; name: string | null; number: number; startsAt: string | null; endsAt: string | null }> };
  projects: { nodes: Array<{ id: string; name: string; description: string | null; state: string; targetDate: string | null; url: string }> };
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      url: string;
      estimate: number | null;
      priority: number;
      state: { type: string; name: string };
      labels: { nodes: LinearLabel[] };
      assignee: { name: string } | null;
      parent: { id: string } | null;
      cycle: { id: string } | null;
      project: { id: string } | null;
    }>;
  };
}

export type LinearFetcher = (query: string, variables: Record<string, unknown>, apiKey: string) => Promise<unknown>;

export const defaultFetcher: LinearFetcher = async (query, variables, apiKey) => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new UnprocessableEntityException(`Linear API ${res.status} — check the API key`);
  }
  const body = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new UnprocessableEntityException(`Linear API: ${body.errors[0]!.message}`);
  }
  return body.data;
};

/**
 * #902 — every Linear connection is PAGED to its end. These queries used to be one `issues(first: 250)` (and 250/50/50
 * for labels/cycles/projects) with no `pageInfo`, so a team past 250 issues imported its first 250 and reported
 * success. Page sizes are deliberately modest: Linear rejects a query whose complexity is too high, and a page of issues
 * carries nested labels. NOT measured against the live API; the page-walk does not depend on the size, only the number
 * of requests does.
 */
export const ISSUE_PAGE_SIZE = 50;
const LABEL_PAGE_SIZE = 250;
const SMALL_PAGE_SIZE = 100;
/** Nested labels on one issue are not paged; an issue with more than this many FAILS the sync instead of dropping labels. */
export const ISSUE_LABELS_CAP = 50;

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
export const TEAMS_QUERY = `query Teams($after: String) { teams(first: 50, after: $after) { nodes { id key name } ${PAGE_INFO} } }`;
export const TEAM_ISSUE_COUNT_QUERY = `query TeamIssueCount($id: String!) { team(id: $id) { issueCount } }`;
export const TEAM_LABELS_QUERY = `query TeamLabels($id: String!, $after: String) { team(id: $id) { labels(first: ${LABEL_PAGE_SIZE}, after: $after) { nodes { id name color } ${PAGE_INFO} } } }`;
export const TEAM_CYCLES_QUERY = `query TeamCycles($id: String!, $after: String) { team(id: $id) { cycles(first: ${SMALL_PAGE_SIZE}, after: $after) { nodes { id name number startsAt endsAt } ${PAGE_INFO} } } }`;
export const TEAM_PROJECTS_QUERY = `query TeamProjects($id: String!, $after: String) { team(id: $id) { projects(first: ${SMALL_PAGE_SIZE}, after: $after) { nodes { id name description state targetDate url } ${PAGE_INFO} } } }`;
export const TEAM_ISSUES_QUERY = `query TeamIssues($id: String!, $after: String) {
  team(id: $id) {
    issues(first: ${ISSUE_PAGE_SIZE}, after: $after) {
      nodes {
        id identifier title description url estimate priority
        state { type name }
        labels(first: ${ISSUE_LABELS_CAP}) { nodes { id name color } ${PAGE_INFO} }
        assignee { name }
        parent { id }
        cycle { id }
        project { id }
      }
      ${PAGE_INFO}
    }
  }
}`;

interface PageInfo { hasNextPage: boolean; endCursor: string | null }

/**
 * Walk one connection to its end. Never assumes completeness: a response with no `pageInfo`, a `hasNextPage` with no
 * cursor, or a cursor that does not advance is an ERROR, because each of those would otherwise look like "that was
 * everything" — the exact silent partial import this replaces.
 */
async function pageAll<T>(
  fetcher: LinearFetcher,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: never) => { nodes: T[]; pageInfo?: PageInfo } | undefined,
  what: string,
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const data = await fetcher(query, after ? { ...variables, after } : variables, apiKey);
    const conn = pick(data as never);
    if (!conn || !Array.isArray(conn.nodes)) throw new UnprocessableEntityException(`Linear returned no ${what} — refusing to continue with a partial copy`);
    if (!conn.pageInfo) throw new UnprocessableEntityException(`Linear returned no pageInfo for ${what} — cannot tell whether the list is complete`);
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    const next = conn.pageInfo.endCursor;
    if (!next || seen.has(next)) {
      throw new UnprocessableEntityException(`Linear paging for ${what} stopped advancing after ${out.length} rows — refusing to continue with a partial copy`);
    }
    seen.add(next);
    after = next;
  }
}

export async function fetchAllTeams(fetcher: LinearFetcher, apiKey: string): Promise<LinearTeam[]> {
  return pageAll<LinearTeam>(fetcher, apiKey, TEAMS_QUERY, {}, (d: { teams: { nodes: LinearTeam[]; pageInfo?: PageInfo } }) => d.teams, 'teams');
}

/**
 * Everything one team has, every connection paged to its end, plus Linear's own issue total. The total comes from a
 * SEPARATE count (`Team.issueCount`) so the comparison is between two independent answers, not the walk checking
 * itself. A mismatch throws: a copy that is short of Linear must never be reported as a success.
 */
export async function fetchTeamData(fetcher: LinearFetcher, apiKey: string, team: LinearTeam): Promise<LinearTeamComplete> {
  const id = team.id;
  const [labels, cycles, projects, issues, count] = await Promise.all([
    pageAll<LinearLabel>(fetcher, apiKey, TEAM_LABELS_QUERY, { id }, (d: { team: { labels: never } }) => d.team?.labels, `labels of ${team.key}`),
    pageAll<LinearTeamData['cycles']['nodes'][number]>(fetcher, apiKey, TEAM_CYCLES_QUERY, { id }, (d: { team: { cycles: never } }) => d.team?.cycles, `cycles of ${team.key}`),
    pageAll<LinearTeamData['projects']['nodes'][number]>(fetcher, apiKey, TEAM_PROJECTS_QUERY, { id }, (d: { team: { projects: never } }) => d.team?.projects, `projects of ${team.key}`),
    pageAll<LinearTeamData['issues']['nodes'][number]>(fetcher, apiKey, TEAM_ISSUES_QUERY, { id }, (d: { team: { issues: never } }) => d.team?.issues, `issues of ${team.key}`),
    fetcher(TEAM_ISSUE_COUNT_QUERY, { id }, apiKey) as Promise<{ team?: { issueCount?: number } }>,
  ]);
  const total = count.team?.issueCount;
  if (typeof total !== 'number') {
    throw new UnprocessableEntityException(`Linear did not report an issue total for ${team.key} — cannot verify the copy is complete`);
  }
  if (total !== issues.length) {
    throw new UnprocessableEntityException(
      `Linear team ${team.key} has ${total} issues but ${issues.length} were fetched — nothing was written. Re-run; if it persists, the team may include archived issues.`,
    );
  }
  for (const issue of issues) {
    const l = issue.labels as { nodes: LinearLabel[]; pageInfo?: PageInfo };
    if (!l.pageInfo || l.pageInfo.hasNextPage) {
      throw new UnprocessableEntityException(`Linear issue ${issue.identifier} has more than ${ISSUE_LABELS_CAP} labels (or its label list is incomplete) — refusing to import it without them`);
    }
  }
  return { labels: { nodes: labels }, cycles: { nodes: cycles }, projects: { nodes: projects }, issues: { nodes: issues }, issueTotal: total };
}

/** Per team and per Linear project: how many issues a sync will copy (#902 AC3). `project: null` = no project. */
export function issueCountsByProject(data: LinearTeamData): Array<{ project_id: string | null; name: string; issues: number }> {
  const names = new Map(data.projects.nodes.map((p) => [p.id, p.name]));
  const counts = new Map<string | null, number>();
  for (const issue of data.issues.nodes) {
    const key = issue.project?.id ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([project_id, issues]) => ({ project_id, name: project_id ? (names.get(project_id) ?? project_id) : '(no project)', issues }))
    .sort((a, b) => b.issues - a.issues);
}

/** Linear workflow-state *types* → our task-DNA states. */
const STATE_MAP: Record<string, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'To Do',
  started: 'In Progress',
  completed: 'Done',
  canceled: 'Canceled',
};

const PRIORITY_MAP: Record<number, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };

/**
 * Resolve a select option id from a label→id map, trying each candidate in
 * order, case-insensitively (#68). Now the framework's shared `pickOption`
 * (migration-framework/select-options.ts, imported above) — re-exported here
 * so existing importers of this module keep working unchanged.
 */
export { pickOption };

/**
 * Linear importer (MN-066): leave Linear, keep your data. One-shot GraphQL
 * import — each team becomes a dev-project-shaped space (Issues + Projects +
 * Sprints from cycles), idempotent by Linear ID so re-imports update instead
 * of duplicating. Assignee names land in a text field (users must exist
 * first); parent/sub-issue, cycle and project links are preserved.
 */
@Injectable()
export class LinearService {
  /** Swappable in tests. */
  fetcher: LinearFetcher = defaultFetcher;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
    private readonly documentsService: DocumentsService,
    private readonly externalIdUpsert: ExternalIdUpsertService,
    private readonly relationLinker: RelationLinkerService,
  ) {}

  /**
   * Write a Linear body as the record's description — but only when the record
   * has no document yet (version 0), so a re-import fills blanks without ever
   * clobbering a description edited in StoryOS. Empty bodies write nothing.
   */
  private async importDescription(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    markdown: string | null | undefined,
    actorId: string,
  ) {
    if (!markdown || !markdown.trim()) return;
    const current = await this.documentsService.get(recordId);
    if (current.version !== 0) return; // already has a description — leave it alone
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) return;
    await this.documentsService
      .put(workspaceId, databaseId, recordId, blocks, 0, actorId)
      .catch(() => undefined);
  }

  async saveConfig(workspaceId: string, config: { api_key?: string; team_keys?: string[] }) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const existing = (settings.linear as { api_key?: string; team_keys?: string[] }) ?? {};
    const linear = {
      api_key: config.api_key !== undefined ? config.api_key : existing.api_key,
      team_keys: config.team_keys !== undefined ? config.team_keys : (existing.team_keys ?? []),
    };
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, linear } })
      .where(eq(workspaces.id, workspaceId));
    return { team_keys: linear.team_keys, has_key: Boolean(linear.api_key) };
  }

  async getConfig(workspaceId: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const linear = ((ws?.settings ?? {}) as Record<string, unknown>).linear as
      | { api_key?: string; team_keys?: string[] }
      | undefined;
    return { team_keys: linear?.team_keys ?? [], has_key: Boolean(linear?.api_key) };
  }

  /** MN-249: clear the stored API key + team-key filter — back to not-connected. */
  async disconnect(workspaceId: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, linear: {} } })
      .where(eq(workspaces.id, workspaceId));
    return { team_keys: [], has_key: false };
  }

  private async apiKey(workspaceId: string): Promise<string> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const key = (((ws?.settings ?? {}) as Record<string, unknown>).linear as { api_key?: string })?.api_key;
    if (!key) throw new UnprocessableEntityException('Configure a Linear API key first');
    return key;
  }

  /** Create the Labels database + a many-to-many Issues↔Labels relation. Returns both. */
  private async createLabelsPack(membership: Membership, spaceId: string, issuesDbId: string) {
    const labelsDb = await this.databasesService.create(membership, { space_id: spaceId, name: 'Labels', icon: 'set:tag' });
    for (const f of [
      { display_name: 'Color', type: 'text' as const, config: {} },
      { display_name: 'Linear ID', type: 'text' as const, config: {} },
    ]) await this.fields.create(labelsDb.id, f);
    const rel = await this.relationsService.create(membership, {
      database_a_id: issuesDbId, database_b_id: labelsDb.id,
      cardinality: 'many_to_many', field_a_name: 'Labels', field_b_name: 'Issues',
    });
    return { labelsDb, labelsFieldId: (rel as { field_a: { id: string } }).field_a.id };
  }

  /** The Issues-side field of the Issues↔Labels relation (for re-imports). */
  private async findLabelsFieldId(issuesDbId: string, labelsDbId: string): Promise<string | undefined> {
    const rels = await this.db.query.relations.findMany({
      where: or(eq(relationsTable.databaseAId, issuesDbId), eq(relationsTable.databaseBId, issuesDbId)),
    });
    const rel = rels.find(
      (r) =>
        (r.databaseAId === issuesDbId && r.databaseBId === labelsDbId) ||
        (r.databaseBId === issuesDbId && r.databaseAId === labelsDbId),
    );
    if (!rel) return undefined;
    return rel.databaseAId === issuesDbId ? rel.fieldAId : rel.fieldBId;
  }

  /** One space per team, holding Issues + Projects + Sprints + Labels. Idempotent by space name. */
  private async ensureTeamPack(membership: Membership, team: LinearTeam) {
    const spaceName = `${team.name} (Linear)`;
    const allSpaces = await this.db.query.spaces.findMany({
      where: eq(spacesTable.workspaceId, membership.workspaceId),
    });
    let space = allSpaces.find((s) => s.name === spaceName);
    const allDbs = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, membership.workspaceId),
    });
    if (space) {
      const inSpace = allDbs.filter((d) => d.spaceId === space!.id);
      const issuesDb = inSpace.find((d) => d.name === 'Issues');
      const projectsDb = inSpace.find((d) => d.name === 'Projects');
      const sprintsDb = inSpace.find((d) => d.name === 'Sprints');
      let labelsDb = inSpace.find((d) => d.name === 'Labels');
      if (issuesDb && projectsDb && sprintsDb) {
        // Incremental upgrade: an older import predates the Labels database.
        let labelsFieldId = labelsDb ? await this.findLabelsFieldId(issuesDb.id, labelsDb.id) : undefined;
        if (!labelsDb) {
          const created = await this.createLabelsPack(membership, space.id, issuesDb.id);
          labelsDb = created.labelsDb;
          labelsFieldId = created.labelsFieldId;
        }
        return { issuesDb, projectsDb, sprintsDb, labelsDb: labelsDb!, labelsFieldId };
      }
    }
    space = space ?? // #221: curated ref rather than an emoji (#251).
      (await this.spaces.create(membership.workspaceId, { name: spaceName, icon: 'brand:linear' }));

    const projectsDb = await this.databasesService.create(membership, {
      space_id: space.id, name: 'Projects', icon: '🎯',
    });
    for (const f of [
      { display_name: 'State', type: 'text' as const, config: {} },
      { display_name: 'Target Date', type: 'date' as const, config: {} },
      { display_name: 'URL', type: 'url' as const, config: {} },
      { display_name: 'Linear ID', type: 'text' as const, config: {} },
    ]) await this.fields.create(projectsDb.id, f);

    const sprintsDb = await this.databasesService.create(membership, {
      space_id: space.id, name: 'Sprints', icon: '🏃',
    });
    for (const f of [
      { display_name: 'Number', type: 'number' as const, config: {} },
      { display_name: 'Start Date', type: 'date' as const, config: {} },
      { display_name: 'End Date', type: 'date' as const, config: {} },
      { display_name: 'Linear ID', type: 'text' as const, config: {} },
    ]) await this.fields.create(sprintsDb.id, f);

    const issuesDb = await this.databasesService.create(membership, {
      space_id: space.id, name: 'Issues', icon: 'set:bug',
    });
    for (const f of [
      { display_name: 'State', type: 'select' as const, config: {}, options: [
        { label: 'Triage', color: 'gold' }, { label: 'Backlog', color: 'gray' }, { label: 'To Do', color: 'blue' },
        { label: 'In Progress', color: 'green' }, { label: 'In Review', color: 'purple' },
        { label: 'Done', color: 'brown' }, { label: 'Canceled', color: 'red' },
      ] },
      { display_name: 'Priority', type: 'select' as const, config: {}, options: [
        { label: 'Urgent', color: 'red' }, { label: 'High', color: 'gold' },
        { label: 'Medium', color: 'blue' }, { label: 'Low', color: 'gray' },
      ] },
      { display_name: 'Identifier', type: 'text' as const, config: {} },
      { display_name: 'Assignee (name)', type: 'text' as const, config: {} },
      { display_name: 'Estimate', type: 'number' as const, config: {} },
      { display_name: 'URL', type: 'url' as const, config: {} },
      { display_name: 'Linear ID', type: 'text' as const, config: {} },
    ]) await this.fields.create(issuesDb.id, f);

    await this.relationsService.create(membership, {
      database_a_id: issuesDb.id, database_b_id: sprintsDb.id,
      cardinality: 'one_to_many', field_a_name: 'Sprint', field_b_name: 'Issues',
    });
    await this.relationsService.create(membership, {
      database_a_id: issuesDb.id, database_b_id: projectsDb.id,
      cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Issues',
    });
    await this.relationsService.create(membership, {
      database_a_id: issuesDb.id, database_b_id: issuesDb.id,
      cardinality: 'one_to_many', field_a_name: 'Parent Issue', field_b_name: 'Sub-issues',
    });
    const { labelsDb, labelsFieldId } = await this.createLabelsPack(membership, space.id, issuesDb.id);
    return { issuesDb, projectsDb, sprintsDb, labelsDb, labelsFieldId };
  }

  /** Idempotent re-import by Linear id (MN-066) — now the framework's shared
   * upsert-by-external-id primitive (ADR-0013 §3) instead of a hand-rolled
   * query-then-create/update, so every adapter gets this for free. */
  private async upsertByLinearId(
    membership: Membership,
    databaseId: string,
    linearId: string,
    values: Record<string, unknown>,
    actorId: string,
  ): Promise<string> {
    const { id } = await this.externalIdUpsert.upsert(membership, databaseId, 'linear_id', linearId, values, actorId);
    return id;
  }

  private async fetchTeams(workspaceId: string): Promise<{ teams: LinearTeam[]; apiKey: string }> {
    const apiKey = await this.apiKey(workspaceId);
    const config = await this.getConfig(workspaceId);
    let teams = await fetchAllTeams(this.fetcher, apiKey);
    if (config.team_keys.length > 0) {
      teams = teams.filter((t) => config.team_keys.includes(t.key));
    }
    if (teams.length === 0) {
      throw new UnprocessableEntityException('No Linear teams matched — check the team keys');
    }
    return { teams, apiKey };
  }

  /**
   * Counts only, writes nothing — the look-before-you-leap step. Also runs the
   * shared `LinearSourceAdapter` (the framework's `SourceAdapter` contract,
   * ADR-0013) to produce the unified dry-run report every importer now shares
   * — additive fields alongside the original per-team breakdown so existing
   * consumers of `.teams` keep working unchanged.
   */
  async dryRun(membership: Membership) {
    const { teams, apiKey } = await this.fetchTeams(membership.workspaceId);
    const summary = {
      dry_run: true,
      teams: [] as Array<{
        key: string; name: string; issues: number; linear_issue_total: number; sprints: number; projects: number; labels: number;
        /** #902 — how many of this team's issues each Linear project will bring (and how many have none). */
        issues_by_project: Array<{ project_id: string | null; name: string; issues: number }>;
      }>,
    };
    // Every read is paged to the end and count-checked (fetchTeamData), so these counts are uncapped and the same
    // numbers the sync will act on. The adapter below is handed the data rather than re-reading it.
    const prefetched = new Map<string, LinearTeamComplete>();
    for (const team of teams) {
      const data = await fetchTeamData(this.fetcher, apiKey, team);
      prefetched.set(team.id, data);
      summary.teams.push({
        key: team.key,
        name: team.name,
        issues: data.issues.nodes.length,
        linear_issue_total: data.issueTotal,
        sprints: data.cycles.nodes.length,
        projects: data.projects.nodes.length,
        labels: data.labels.nodes.length,
        issues_by_project: issueCountsByProject(data),
      });
    }

    const adapter = new LinearSourceAdapter();
    await adapter.connect({ apiKey, teamKeys: teams.map((t) => t.key), fetcher: this.fetcher, prefetched });
    const [schema, sourceRecords] = await Promise.all([adapter.readSchema(), adapter.readRecords()]);
    const report = new DryRunBuilder();
    for (const record of sourceRecords) {
      report.willCreate++;
      report.addSample({ container: record.container, title: record.title, ...record.fields });
    }
    const built = report.build();

    return { ...summary, will_create: built.will_create, sample: built.sample, schema };
  }

  async sync(membership: Membership, actorId: string) {
    const { teams, apiKey } = await this.fetchTeams(membership.workspaceId);
    const summary = {
      dry_run: false, issues: 0, sprints: 0, projects: 0, labels: 0, teams: teams.map((t) => t.key),
      /** #902 — per team, what was fetched against what Linear says it has. A mismatch never gets this far (it throws). */
      per_team: [] as Array<{ key: string; issues_fetched: number; linear_issue_total: number }>,
    };
    // Read and verify EVERY team before writing anything: a short or unverifiable team fails the sync loudly while
    // the workspace is still untouched, instead of leaving a partial copy that looks like a finished one.
    const fetched = new Map<string, LinearTeamComplete>();
    for (const team of teams) fetched.set(team.id, await fetchTeamData(this.fetcher, apiKey, team));
    // Failed links used to be silently swallowed (`.catch(() => undefined)`) —
    // every importer had that bug (ADR-0013). RelationLinkerService turns a
    // failure into a warning instead, collected here without changing the
    // summary's existing counted fields.
    const linkWarnings: string[] = [];

    for (const team of teams) {
      const data = fetched.get(team.id)!;
      summary.per_team.push({ key: team.key, issues_fetched: data.issues.nodes.length, linear_issue_total: data.issueTotal });
      const { issuesDb, projectsDb, sprintsDb, labelsDb, labelsFieldId } = await this.ensureTeamPack(membership, team);

      const issueDefs = await this.recordsService.fieldDefs(issuesDb.id);
      const stateOptions = await this.selectLabelMap(issuesDb.id, 'state');
      const priorityOptions = await this.selectLabelMap(issuesDb.id, 'priority');

      // Labels → their own database (team labels + any label seen on an issue), deduped by id.
      const labelById = new Map<string, LinearLabel>();
      for (const l of data.labels.nodes) labelById.set(l.id, l);
      for (const issue of data.issues.nodes) for (const l of issue.labels.nodes) if (!labelById.has(l.id)) labelById.set(l.id, l);
      const labelRecordIds = new Map<string, string>();
      for (const label of labelById.values()) {
        const id = await this.upsertByLinearId(membership, labelsDb.id, label.id, {
          name: label.name,
          color: label.color ?? null,
        }, actorId);
        labelRecordIds.set(label.id, id);
        summary.labels++;
      }

      const sprintIds = new Map<string, string>();
      for (const cycle of data.cycles.nodes) {
        const id = await this.upsertByLinearId(membership, sprintsDb.id, cycle.id, {
          name: cycle.name || `Cycle ${cycle.number}`,
          number: cycle.number,
          start_date: cycle.startsAt ? cycle.startsAt.slice(0, 10) : null,
          end_date: cycle.endsAt ? cycle.endsAt.slice(0, 10) : null,
        }, actorId);
        sprintIds.set(cycle.id, id);
        summary.sprints++;
      }

      const projectIds = new Map<string, string>();
      for (const project of data.projects.nodes) {
        const id = await this.upsertByLinearId(membership, projectsDb.id, project.id, {
          name: project.name,
          state: project.state,
          target_date: project.targetDate,
          url: project.url,
        }, actorId);
        await this.importDescription(membership.workspaceId, projectsDb.id, id, project.description, actorId);
        projectIds.set(project.id, id);
        summary.projects++;
      }

      const relationField = (apiName: string) =>
        issueDefs.find((d) => d.type === 'relation' && d.api_name === apiName);
      const sprintField = relationField('sprint');
      const projectField = relationField('project');
      const parentField = relationField('parent_issue');

      const issueIds = new Map<string, string>();
      for (const issue of data.issues.nodes) {
        const id = await this.upsertByLinearId(membership, issuesDb.id, issue.id, {
          name: issue.title,
          identifier: issue.identifier,
          state: pickOption(stateOptions, issue.state.name, STATE_MAP[issue.state.type], 'Backlog'),
          priority: issue.priority ? pickOption(priorityOptions, PRIORITY_MAP[issue.priority]) : null,
          assignee_name: issue.assignee?.name ?? null,
          estimate: issue.estimate,
          url: issue.url,
        }, actorId);
        await this.importDescription(membership.workspaceId, issuesDb.id, id, issue.description, actorId);
        issueIds.set(issue.id, id);
        summary.issues++;

        const link = async (field: typeof sprintField, target: string | undefined) => {
          if (!field || !target) return;
          const failure = await this.relationLinker.link(membership.workspaceId, issuesDb.id, id, field.id, [target], actorId);
          if (failure) linkWarnings.push(failure);
        };
        await link(sprintField, issue.cycle ? sprintIds.get(issue.cycle.id) : undefined);
        await link(projectField, issue.project ? projectIds.get(issue.project.id) : undefined);

        // Link the issue to its label records (many-to-many).
        const labelTargets = issue.labels.nodes
          .map((l) => labelRecordIds.get(l.id))
          .filter((v): v is string => Boolean(v));
        if (labelsFieldId && labelTargets.length) {
          const failure = await this.relationLinker.link(membership.workspaceId, issuesDb.id, id, labelsFieldId, labelTargets, actorId);
          if (failure) linkWarnings.push(failure);
        }
      }

      // parents in a second pass — a parent can appear later in the feed
      if (parentField) {
        for (const issue of data.issues.nodes) {
          const child = issueIds.get(issue.id);
          const parent = issue.parent ? issueIds.get(issue.parent.id) : undefined;
          if (!child || !parent) continue;
          const failure = await this.relationLinker.link(membership.workspaceId, issuesDb.id, child, parentField.id, [parent], actorId);
          if (failure) linkWarnings.push(failure);
        }
      }
    }
    return linkWarnings.length > 0 ? { ...summary, warnings: linkWarnings } : summary;
  }

  private async selectLabelMap(databaseId: string, apiName: string): Promise<Map<string, string>> {
    const rows = await this.db.query.fields.findMany({
      where: eq(fieldsTable.databaseId, databaseId),
    });
    const target = rows.find((f) => f.apiName === apiName);
    if (!target) return new Map();
    const options = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, target.id),
    });
    return new Map(options.map((o) => [o.label, o.id]));
  }
}
