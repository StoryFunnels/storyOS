import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable, selectOptions, spaces as spacesTable, workspaces } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { DocumentsService } from '../documents/documents.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { markdownToBlocks } from './markdown-to-blocks';

interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

interface LinearTeamData {
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
      labels: { nodes: Array<{ name: string }> };
      assignee: { name: string } | null;
      parent: { id: string } | null;
      cycle: { id: string } | null;
      project: { id: string } | null;
    }>;
  };
}

export type LinearFetcher = (query: string, variables: Record<string, unknown>, apiKey: string) => Promise<unknown>;

const defaultFetcher: LinearFetcher = async (query, variables, apiKey) => {
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

const TEAMS_QUERY = `query Teams { teams { nodes { id key name } } }`;

const TEAM_QUERY = `query Team($id: String!) {
  team(id: $id) {
    cycles(first: 50) { nodes { id name number startsAt endsAt } }
    projects(first: 50) { nodes { id name description state targetDate url } }
    issues(first: 250) { nodes {
      id identifier title description url estimate priority
      state { type name }
      labels { nodes { name } }
      assignee { name }
      parent { id }
      cycle { id }
      project { id }
    } }
  }
}`;

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
  ) {}

  /**
   * Write a Linear body as the record's description — but only when the record
   * has no document yet (version 0), so a re-import fills blanks without ever
   * clobbering a description edited in StoryOS. Empty bodies write nothing.
   */
  private async importDescription(
    workspaceId: string,
    recordId: string,
    markdown: string | null | undefined,
    actorId: string,
  ) {
    if (!markdown || !markdown.trim()) return;
    const current = await this.documentsService.get(recordId);
    if (current.version !== 0) return; // already has a description — leave it alone
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) return;
    await this.documentsService.put(workspaceId, recordId, blocks, 0, actorId).catch(() => undefined);
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

  private async apiKey(workspaceId: string): Promise<string> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const key = (((ws?.settings ?? {}) as Record<string, unknown>).linear as { api_key?: string })?.api_key;
    if (!key) throw new UnprocessableEntityException('Configure a Linear API key first');
    return key;
  }

  /** One space per team, holding Issues + Projects + Sprints. Idempotent by space name. */
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
      if (issuesDb && projectsDb && sprintsDb) return { issuesDb, projectsDb, sprintsDb };
    }
    space = space ?? (await this.spaces.create(membership.workspaceId, { name: spaceName, icon: '📐' }));

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
      space_id: space.id, name: 'Issues', icon: '🐛',
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
      { display_name: 'Labels', type: 'text' as const, config: {} },
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
    return { issuesDb, projectsDb, sprintsDb };
  }

  private async upsertByLinearId(
    membership: Membership,
    databaseId: string,
    linearId: string,
    values: Record<string, unknown>,
    actorId: string,
  ): Promise<string> {
    const existing = await this.recordsService.query(databaseId, {
      filter: { field: 'linear_id', op: 'eq', value: linearId },
      sorts: [],
      limit: 1,
    } as never, actorId);
    if (existing.data[0]) {
      await this.recordsService.update(membership.workspaceId, databaseId, existing.data[0].id, values, actorId);
      return existing.data[0].id;
    }
    const created = await this.recordsService.create(
      membership.workspaceId, databaseId, { ...values, linear_id: linearId }, actorId, 0,
    );
    return created.id;
  }

  private async fetchTeams(workspaceId: string): Promise<{ teams: LinearTeam[]; apiKey: string }> {
    const apiKey = await this.apiKey(workspaceId);
    const config = await this.getConfig(workspaceId);
    const data = (await this.fetcher(TEAMS_QUERY, {}, apiKey)) as { teams: { nodes: LinearTeam[] } };
    let teams = data.teams.nodes;
    if (config.team_keys.length > 0) {
      teams = teams.filter((t) => config.team_keys.includes(t.key));
    }
    if (teams.length === 0) {
      throw new UnprocessableEntityException('No Linear teams matched — check the team keys');
    }
    return { teams, apiKey };
  }

  /** Counts only, writes nothing — the look-before-you-leap step. */
  async dryRun(membership: Membership) {
    const { teams, apiKey } = await this.fetchTeams(membership.workspaceId);
    const summary = { dry_run: true, teams: [] as Array<{ key: string; name: string; issues: number; sprints: number; projects: number }> };
    for (const team of teams) {
      const { team: data } = (await this.fetcher(TEAM_QUERY, { id: team.id }, apiKey)) as { team: LinearTeamData };
      summary.teams.push({
        key: team.key,
        name: team.name,
        issues: data.issues.nodes.length,
        sprints: data.cycles.nodes.length,
        projects: data.projects.nodes.length,
      });
    }
    return summary;
  }

  async sync(membership: Membership, actorId: string) {
    const { teams, apiKey } = await this.fetchTeams(membership.workspaceId);
    const summary = { dry_run: false, issues: 0, sprints: 0, projects: 0, teams: teams.map((t) => t.key) };

    for (const team of teams) {
      const { team: data } = (await this.fetcher(TEAM_QUERY, { id: team.id }, apiKey)) as { team: LinearTeamData };
      const { issuesDb, projectsDb, sprintsDb } = await this.ensureTeamPack(membership, team);

      const issueDefs = await this.recordsService.fieldDefs(issuesDb.id);
      const stateOptions = await this.selectLabelMap(issuesDb.id, 'state');
      const priorityOptions = await this.selectLabelMap(issuesDb.id, 'priority');

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
        await this.importDescription(membership.workspaceId, id, project.description, actorId);
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
          state: stateOptions.get(STATE_MAP[issue.state.type] ?? 'Backlog') ?? null,
          priority: issue.priority ? (priorityOptions.get(PRIORITY_MAP[issue.priority] ?? '') ?? null) : null,
          labels: issue.labels.nodes.map((l) => l.name).join(', ') || null,
          assignee_name: issue.assignee?.name ?? null,
          estimate: issue.estimate,
          url: issue.url,
        }, actorId);
        await this.importDescription(membership.workspaceId, id, issue.description, actorId);
        issueIds.set(issue.id, id);
        summary.issues++;

        const link = async (field: typeof sprintField, target: string | undefined) => {
          if (!field || !target) return;
          await this.relationsService
            .addLinks(membership.workspaceId, issuesDb.id, id, field.id, [target], actorId)
            .catch(() => undefined);
        };
        await link(sprintField, issue.cycle ? sprintIds.get(issue.cycle.id) : undefined);
        await link(projectField, issue.project ? projectIds.get(issue.project.id) : undefined);
      }

      // parents in a second pass — a parent can appear later in the feed
      if (parentField) {
        for (const issue of data.issues.nodes) {
          const child = issueIds.get(issue.id);
          const parent = issue.parent ? issueIds.get(issue.parent.id) : undefined;
          if (!child || !parent) continue;
          await this.relationsService
            .addLinks(membership.workspaceId, issuesDb.id, child, parentField.id, [parent], actorId)
            .catch(() => undefined);
        }
      }
    }
    return summary;
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
