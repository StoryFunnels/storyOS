import { ConflictException, HttpException, Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { linearStateCategory } from '@storyos/schemas';
import type { StateCategory } from '@storyos/schemas';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { VIA_STORYOS_PATTERN } from './linear-write-back.constants';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { linearCommentPushes, memberships, databases as databasesTable, fields as fieldsTable, relations as relationsTable, selectOptions, spaces as spacesTable, workspaces } from '../db/schema';
import { env } from '../config/env';
import { DatabasesService } from '../databases/databases.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentsService } from '../comments/comments.service';
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

/** One of a team's workflow states (#904). `position` is Linear's own order. */
export interface LinearState {
  id: string;
  name: string;
  type: string;
  position: number;
}

/** One Linear comment (#903). The author is a user, or an integration/bot, or an external user; one is set. */
export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  url: string;
  user: { name: string } | null;
  botActor: { name: string } | null;
  externalUser: { name: string } | null;
  issue: { id: string } | null;
}

export interface LinearTeamComplete extends LinearTeamData {
  /** Every comment on the team's issues, paged to the end (#903). */
  comments: { nodes: LinearComment[] };
  /** The team's real workflow states, in Linear's order (#904). These BUILD the Issues State options. */
  states: { nodes: LinearState[] };
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

export const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
/** A run marked as running for longer than this is presumed dead (a crash) and no longer blocks the next one. */
export const RUN_LOCK_TIMEOUT_MINUTES = 60;

/** The sync's own health, kept next to the config so an admin sees it without a log (#906). */
interface LinearSyncStatus {
  /** Set while a sync is running (manual or scheduled); cleared when it ends. Stops runs overlapping (#906). */
  running_since?: string;
  last_attempt_at?: string;
  last_success_at?: string;
  last_error?: string;
  last_error_at?: string;
  consecutive_failures?: number;
  last_run?: { issues: number; comments: number; drift_flagged: number; left_scope: number; duration_ms: number };
}

interface LinearSettings {
  api_key?: string;
  team_keys?: string[];
  auto_sync?: { enabled: boolean; interval_minutes: number; actor_id?: string; enabled_at?: string };
  /** #907 — push StoryOS comments on mirrored records to Linear. Off until an admin switches it on. */
  write_back?: { enabled: boolean; enabled_at?: string };
  sync_status?: LinearSyncStatus;
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
export const TEAM_STATES_QUERY = `query TeamStates($id: String!, $after: String) { team(id: $id) { states(first: ${SMALL_PAGE_SIZE}, after: $after) { nodes { id name type position } ${PAGE_INFO} } } }`;
/** All comments of one team's issues, as one stream (not nested per issue: nesting would multiply query complexity). */
export const TEAM_COMMENTS_QUERY = `query TeamComments($id: ID!, $after: String) { comments(first: ${SMALL_PAGE_SIZE}, after: $after, filter: { issue: { team: { id: { eq: $id } } } }) { nodes { id body createdAt url user { name } botActor { name } externalUser { name } issue { id } } ${PAGE_INFO} } }`;
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
  const [labels, cycles, projects, issues, count, states, linearComments] = await Promise.all([
    pageAll<LinearLabel>(fetcher, apiKey, TEAM_LABELS_QUERY, { id }, (d: { team: { labels: never } }) => d.team?.labels, `labels of ${team.key}`),
    pageAll<LinearTeamData['cycles']['nodes'][number]>(fetcher, apiKey, TEAM_CYCLES_QUERY, { id }, (d: { team: { cycles: never } }) => d.team?.cycles, `cycles of ${team.key}`),
    pageAll<LinearTeamData['projects']['nodes'][number]>(fetcher, apiKey, TEAM_PROJECTS_QUERY, { id }, (d: { team: { projects: never } }) => d.team?.projects, `projects of ${team.key}`),
    pageAll<LinearTeamData['issues']['nodes'][number]>(fetcher, apiKey, TEAM_ISSUES_QUERY, { id }, (d: { team: { issues: never } }) => d.team?.issues, `issues of ${team.key}`),
    fetcher(TEAM_ISSUE_COUNT_QUERY, { id }, apiKey) as Promise<{ team?: { issueCount?: number } }>,
    pageAll<LinearState>(fetcher, apiKey, TEAM_STATES_QUERY, { id }, (d: { team: { states: never } }) => d.team?.states, `workflow states of ${team.key}`),
    pageAll<LinearComment>(fetcher, apiKey, TEAM_COMMENTS_QUERY, { id }, (d: { comments: never }) => d.comments, `comments of ${team.key}`),
  ]);
  states.sort((a, b) => a.position - b.position);
  // #904: a status the team's own state list does not contain cannot be given an option, so the copy would have to
  // guess. It fails the read instead, before anything is written.
  const known = new Set(states.map((st) => st.name));
  const stray = [...new Set(issues.map((i) => i.state.name).filter((n) => !known.has(n)))];
  if (stray.length > 0) {
    throw new UnprocessableEntityException(`Linear team ${team.key} has issues in status ${stray.map((n) => `"${n}"`).join(', ')} which is not in its workflow states — refusing to map them by guesswork`);
  }
  const total = count.team?.issueCount;
  if (typeof total !== 'number') {
    throw new UnprocessableEntityException(`Linear did not report an issue total for ${team.key} — cannot verify the copy is complete`);
  }
  if (total !== issues.length) {
    throw new UnprocessableEntityException(
      `Linear team ${team.key} has ${total} issues but ${issues.length} were fetched — nothing was written. Re-run; if it persists, the team may include archived issues.`,
    );
  }
  // #903: a comment on an issue we did not read cannot be placed, and dropping it would be a silent loss.
  const issueIds = new Set(issues.map((i) => i.id));
  const orphans = linearComments.filter((c) => !c.issue || !issueIds.has(c.issue.id));
  if (orphans.length > 0) {
    throw new UnprocessableEntityException(`Linear team ${team.key} has ${orphans.length} comments on issues that were not read — refusing to copy without them`);
  }
  for (const issue of issues) {
    const l = issue.labels as { nodes: LinearLabel[]; pageInfo?: PageInfo };
    if (!l.pageInfo || l.pageInfo.hasNextPage) {
      throw new UnprocessableEntityException(`Linear issue ${issue.identifier} has more than ${ISSUE_LABELS_CAP} labels (or its label list is incomplete) — refusing to import it without them`);
    }
  }
  return { labels: { nodes: labels }, cycles: { nodes: cycles }, projects: { nodes: projects }, issues: { nodes: issues }, states: { nodes: states }, comments: { nodes: linearComments }, issueTotal: total };
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

/** Per team and per Linear status, in Linear's order (zero-count statuses included): the preview a person checks against Linear. */
export function issueCountsByStatus(data: LinearTeamComplete): Array<{ status: string; type: string; issues: number }> {
  const counts = new Map<string, number>();
  for (const issue of data.issues.nodes) counts.set(issue.state.name, (counts.get(issue.state.name) ?? 0) + 1);
  return data.states.nodes.map((st) => ({ status: st.name, type: st.type, issues: counts.get(st.name) ?? 0 }));
}

/** #904: State options are the team's real workflow states, by name; this only colours them. */
/** Option colour by Linear state TYPE — cosmetic only; the option's NAME is the team's own status name (#904). */
const STATE_COLOR: Record<string, string> = {
  triage: 'gold',
  backlog: 'gray',
  unstarted: 'blue',
  started: 'green',
  completed: 'brown',
  canceled: 'red',
};
const stateColor = (type: string) => STATE_COLOR[type] ?? 'gray';
/** #1014 — the category Linear's own state type says: the import SETS it, it never guesses from the name. Undefined for a type we do not know. */
const stateCategory = (type: string): StateCategory | undefined => linearStateCategory(type) ?? undefined;

/** #957 — Linear's fixed project states (`Project.state`), as Linear names them, in lifecycle order. */
const PROJECT_STATES = ['backlog', 'planned', 'started', 'paused', 'completed', 'canceled'] as const;
/** #1014 — Linear's project states as categories: planned is not begun, and a paused project is one that was started and has not finished. */
const PROJECT_STATE_CATEGORY: Record<(typeof PROJECT_STATES)[number], StateCategory> = {
  backlog: 'backlog', planned: 'unstarted', started: 'started', paused: 'started', completed: 'completed', canceled: 'canceled',
};
const PROJECT_STATE_COLOR: Record<(typeof PROJECT_STATES)[number], string> = {
  backlog: 'gray', planned: 'blue', started: 'green', paused: 'gold', completed: 'brown', canceled: 'red',
};

/**
 * #904 — the option whose name IS the Linear status. There is no type fallback and no 'Backlog' default: an issue whose
 * status has no option is an error (fetchTeamData already refuses a status outside the team's workflow states, and the
 * options are built from those states), never a silent "Done".
 */
function statusOptionId(options: Map<string, string>, status: string): string {
  const id = pickOption(options, status);
  if (!id) throw new UnprocessableEntityException(`No State option for Linear status "${status}" — refusing to map it by guesswork`);
  return id;
}

/** The `linear_status` an issue carries once Linear stops returning it (#906). */
const LEFT_SCOPE_PREFIX = 'Left Linear scope (archived, deleted or moved)';

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
export class LinearService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinearService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
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
    private readonly commentsService: CommentsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Everything already mirrored in an Issues database, by Linear id (paged read; ids and the three bookkeeping fields). */
  private async loadMirror(issuesDbId: string, actorId: string) {
    const out = new Map<string, { id: string; linearDescription: string | null; linearStatus: string | null }>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.recordsService.query(
        issuesDbId,
        { filter: { field: 'linear_id', op: 'not_empty' }, sorts: [], limit: 200, cursor } as never,
        actorId,
      );
      for (const r of page.data as Array<{ id: string; values: Record<string, unknown> }>) {
        const linearId = r.values['linear_id'];
        if (typeof linearId !== 'string') continue;
        const d = r.values['linear_description'];
        const st = r.values['linear_status'];
        out.set(linearId, { id: r.id, linearDescription: typeof d === 'string' ? d : null, linearStatus: typeof st === 'string' ? st : null });
      }
      if (!page.next_cursor) return out;
      cursor = page.next_cursor;
    }
  }

  /**
   * #906 — the description bookkeeping for one issue. The StoryOS description is NEVER written here (importDescription
   * only fills a blank one, and an agent may have built on the rest); this only decides what to store beside it:
   *  - new record, or a still-blank description: record the Linear text, no drift;
   *  - a description exists but we never recorded what Linear said (an import from before this field): record it as the
   *    baseline, no drift (we cannot tell what changed, and flagging every edited description would drown the real ones);
   *  - Linear's text differs from the text we recorded: store the new text and SET `description_drift`;
   *  - same text: nothing (so a person clearing the flag is not undone).
   */
  private async descriptionValues(prior: { id: string; linearDescription: string | null } | undefined, linearText: string): Promise<Record<string, unknown>> {
    if (!prior) return { linear_description: linearText, description_drift: false };
    const blank = (await this.documentsService.get(prior.id)).version === 0;
    if (blank) return { linear_description: linearText, description_drift: false };
    if (prior.linearDescription === null) return { linear_description: linearText };
    if (prior.linearDescription !== linearText) return { linear_description: linearText, description_drift: true };
    return {};
  }

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

  private async readLinear(workspaceId: string): Promise<LinearSettings> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    return (((ws?.settings ?? {}) as Record<string, unknown>).linear as LinearSettings | undefined) ?? {};
  }

  private async writeLinear(workspaceId: string, linear: LinearSettings) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    await this.db.update(workspaces).set({ settings: { ...settings, linear } }).where(eq(workspaces.id, workspaceId));
  }

  /** What an admin sees (never the key): config, the schedule, and how the mirror is doing right now (#906). */
  private present(linear: LinearSettings, now = new Date(), pushes: { pending: number; failed: number; last_error: string | null } = { pending: 0, failed: 0, last_error: null }) {
    const auto = linear.auto_sync;
    const interval = auto?.interval_minutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
    const status = linear.sync_status ?? {};
    const enabled = Boolean(auto?.enabled);
    // A mirror is STALE when it is meant to be refreshing and has not succeeded in 2 intervals. A mirror that has never
    // succeeded counts from when auto-sync was switched on, so "enabled and never worked" cannot look healthy.
    const since = status.last_success_at ?? auto?.enabled_at;
    const stale = enabled && (!since || now.getTime() - new Date(since).getTime() > 2 * interval * 60_000);
    const lastAttempt = status.last_attempt_at ?? auto?.enabled_at;
    return {
      team_keys: linear.team_keys ?? [],
      has_key: Boolean(linear.api_key),
      auto_sync: { enabled, interval_minutes: interval },
      write_back: { enabled: Boolean(linear.write_back?.enabled), ...pushes },
      sync: {
        last_success_at: status.last_success_at ?? null,
        last_attempt_at: status.last_attempt_at ?? null,
        last_error: status.last_error ?? null,
        last_error_at: status.last_error_at ?? null,
        consecutive_failures: status.consecutive_failures ?? 0,
        stale,
        next_due_at: enabled ? new Date((lastAttempt ? new Date(lastAttempt).getTime() : now.getTime()) + interval * 60_000).toISOString() : null,
        last_run: status.last_run ?? null,
        running: Boolean(status.running_since && now.getTime() - new Date(status.running_since).getTime() < RUN_LOCK_TIMEOUT_MINUTES * 60_000),
      },
    };
  }

  async saveConfig(
    workspaceId: string,
    config: { api_key?: string; team_keys?: string[]; auto_sync?: { enabled?: boolean; interval_minutes?: number }; write_back?: { enabled?: boolean } },
    actorId?: string,
  ) {
    const existing = await this.readLinear(workspaceId);
    const linear: LinearSettings = {
      ...existing,
      api_key: config.api_key !== undefined ? config.api_key : existing.api_key,
      team_keys: config.team_keys !== undefined ? config.team_keys : (existing.team_keys ?? []),
    };
    if (config.auto_sync) {
      const was = existing.auto_sync;
      const enabled = config.auto_sync.enabled ?? was?.enabled ?? false;
      linear.auto_sync = {
        enabled,
        interval_minutes: config.auto_sync.interval_minutes ?? was?.interval_minutes ?? DEFAULT_SYNC_INTERVAL_MINUTES,
        // Whoever switches it on owns what the schedule writes (the same rule as the GitHub webhook actor).
        actor_id: enabled && !was?.enabled ? (actorId ?? was?.actor_id) : was?.actor_id,
        enabled_at: enabled && !was?.enabled ? new Date().toISOString() : was?.enabled_at,
      };
    }
    if (config.write_back?.enabled !== undefined) {
      const was = existing.write_back?.enabled ?? false;
      linear.write_back = {
        enabled: config.write_back.enabled,
        // Only comments written AFTER this moment are ever pushed: switching it on never replays history.
        enabled_at: config.write_back.enabled && !was ? new Date().toISOString() : existing.write_back?.enabled_at,
      };
    }
    await this.writeLinear(workspaceId, linear);
    return this.present(linear, new Date(), await this.pushCounts(workspaceId));
  }

  async getConfig(workspaceId: string) {
    return this.present(await this.readLinear(workspaceId), new Date(), await this.pushCounts(workspaceId));
  }

  /** How the comment push is doing, for the config response: what is waiting, what gave up, and the latest error. */
  private async pushCounts(workspaceId: string) {
    const rows = await this.db
      .select({ status: linearCommentPushes.status, n: sql<number>`count(*)::int`, lastError: sql<string | null>`max(${linearCommentPushes.lastError})` })
      .from(linearCommentPushes)
      .where(eq(linearCommentPushes.workspaceId, workspaceId))
      .groupBy(linearCommentPushes.status);
    const by = new Map(rows.map((r) => [r.status, r]));
    return {
      pending: (by.get('pending')?.n ?? 0) + (by.get('sending')?.n ?? 0),
      failed: by.get('failed')?.n ?? 0,
      last_error: by.get('failed')?.lastError ?? by.get('pending')?.lastError ?? null,
    };
  }

  /** MN-249: clear the stored API key + team-key filter — back to not-connected. */
  async disconnect(workspaceId: string) {
    await this.writeLinear(workspaceId, {});
    return { team_keys: [], has_key: false };
  }

  /** The stored key, for the server-side write-back only. Never returned by any endpoint or tool. */
  async apiKeyFor(workspaceId: string): Promise<string> {
    return this.apiKey(workspaceId);
  }

  private async apiKey(workspaceId: string): Promise<string> {
    const key = (await this.readLinear(workspaceId)).api_key;
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

  /**
   * #904 — bring an EXISTING Issues database in line with the team's workflow states: add every status that has no
   * option (matched by name, case-insensitively), put Linear's statuses first in Linear's order (an old fixed-list
   * option such as "To Do" stays, after them, because issues may still point at it until they are re-synced), and add
   * the `Linear Status` text field if the earlier import predates it. Never deletes an option.
   */
  private async syncStatusOptions(issuesDbId: string, states: LinearState[]) {
    const stateField = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, issuesDbId), eq(fieldsTable.apiName, 'state'), isNull(fieldsTable.deletedAt)),
    });
    if (stateField) {
      const options = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, stateField.id) });
      const byLabel = new Map(options.map((o) => [o.label.toLowerCase(), o]));
      for (const st of states) {
        const known = byLabel.get(st.name.toLowerCase());
        if (!known) {
          byLabel.set(st.name.toLowerCase(), await this.fields.addOption(issuesDbId, stateField.id, { label: st.name, color: stateColor(st.type), category: stateCategory(st.type) }));
        } else if (stateCategory(st.type) && known.category !== stateCategory(st.type)) {
          // #1014 — an earlier import has the option but no category: the team's state type says what it is, so say it (never the reverse).
          await this.fields.updateOption(issuesDbId, stateField.id, known.id, { category: stateCategory(st.type) });
        }
      }
      const inLinearOrder = new Set(states.map((st) => st.name.toLowerCase()));
      const leftovers = options.filter((o) => !inLinearOrder.has(o.label.toLowerCase()));
      const ordered = [...states.map((st) => byLabel.get(st.name.toLowerCase())!), ...leftovers];
      for (const [position, option] of ordered.entries()) {
        if (option.position !== position) await this.fields.updateOption(issuesDbId, stateField.id, option.id, { position });
      }
    }
    // The mirror's own bookkeeping fields (#904 Linear Status; #906 description drift). An earlier import lacks them.
    for (const f of [
      { apiName: 'linear_status', display_name: 'Linear Status', type: 'text' as const },
      { apiName: 'linear_description', display_name: 'Linear Description', type: 'text' as const },
      { apiName: 'description_drift', display_name: 'Description Drift', type: 'checkbox' as const },
    ]) {
      const has = await this.db.query.fields.findFirst({
        where: and(eq(fieldsTable.databaseId, issuesDbId), eq(fieldsTable.apiName, f.apiName), isNull(fieldsTable.deletedAt)),
      });
      if (!has) await this.fields.create(issuesDbId, { display_name: f.display_name, type: f.type, config: f.apiName === 'linear_description' ? { entity_hidden: true } : {} });
    }
    return this.hideMachineDescription(issuesDbId);
  }

  /**
   * #955 — `linear_description` is the importer's copy of Linear's text, kept so the next sync can tell whether the body
   * drifted (#906). Shown beside the editable description it reads as the same text twice, so it is hidden on the record
   * page (still readable over the API, MCP and table views). Applied to an existing database ONCE: only when nobody has
   * decided yet (`entity_hidden` absent), so a person who shows it again is not overruled by the next sync.
   * Returns whether this call changed anything.
   */
  private async hideMachineDescription(issuesDbId: string): Promise<boolean> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, issuesDbId), eq(fieldsTable.apiName, 'linear_description'), isNull(fieldsTable.deletedAt)),
    });
    const config = (field?.config ?? {}) as Record<string, unknown>;
    if (!field || config['entity_hidden'] !== undefined) return false;
    await this.fields.update(issuesDbId, field.id, { config: { ...config, entity_hidden: true } });
    return true;
  }

  /** One space per team, holding Issues + Projects + Sprints + Labels. Idempotent by space name. */
  private async ensureTeamPack(membership: Membership, team: LinearTeam, states: LinearState[], warnings: string[]) {
    const spaceName = `${team.name} (Linear)`;
    // #959 — LIVE rows only. A trashed mirror (someone deleted the space to re-import fresh) kept being found by name, and its
    // databases' fields are gone, so every sync died on `unknown field "linear_id"`. Newest first: when a restore leaves two
    // live spaces with this name, the sync imports into the newest and says so (see `warnings`).
    const liveSpaces = (
      await this.db.query.spaces.findMany({
        where: and(eq(spacesTable.workspaceId, membership.workspaceId), isNull(spacesTable.deletedAt)),
      })
    )
      .filter((s) => s.name === spaceName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    let space = liveSpaces[0];
    if (liveSpaces.length > 1) {
      warnings.push(
        `team ${team.key}: ${liveSpaces.length} live spaces are named "${spaceName}"; importing into the newest (${space!.id}). Delete or rename the others to stop seeing this.`,
      );
    }
    const allDbs = await this.db.query.databases.findMany({
      where: and(eq(databasesTable.workspaceId, membership.workspaceId), isNull(databasesTable.deletedAt)),
    });
    if (space) {
      const inSpace = allDbs.filter((d) => d.spaceId === space!.id);
      const issuesDb = inSpace.find((d) => d.name === 'Issues');
      const projectsDb = inSpace.find((d) => d.name === 'Projects');
      const sprintsDb = inSpace.find((d) => d.name === 'Sprints');
      let labelsDb = inSpace.find((d) => d.name === 'Labels');
      // #959 — some but not all of the three core databases: a half-present mirror (one was trashed or renamed). Building a
      // second full set beside the survivors would duplicate them, so refuse, naming the team and what is missing.
      const present = [issuesDb, projectsDb, sprintsDb].filter(Boolean).length;
      if (present > 0 && present < 3) {
        const missing = [['Issues', issuesDb], ['Projects', projectsDb], ['Sprints', sprintsDb]].filter(([, d]) => !d).map(([n]) => n);
        throw new UnprocessableEntityException(
          `team ${team.key}: target database missing — the space "${spaceName}" has no live ${missing.join(' / ')} database (trashed or renamed?). Restore it from the trash or rename it back, or delete the space to import fresh.`,
        );
      }
      if (issuesDb && projectsDb && sprintsDb) {
        // #904 incremental upgrade: an older import built State from a fixed list of 7 and kept no status name.
        const descriptionHidden = await this.syncStatusOptions(issuesDb.id, states);
        // Incremental upgrade: an older import predates the Labels database.
        let labelsFieldId = labelsDb ? await this.findLabelsFieldId(issuesDb.id, labelsDb.id) : undefined;
        if (!labelsDb) {
          const created = await this.createLabelsPack(membership, space.id, issuesDb.id);
          labelsDb = created.labelsDb;
          labelsFieldId = created.labelsFieldId;
        }
        return { issuesDb, projectsDb, sprintsDb, labelsDb: labelsDb!, labelsFieldId, descriptionHidden };
      }
    }
    space = space ?? // #221: curated ref rather than an emoji (#251).
      (await this.spaces.create(membership.workspaceId, { name: spaceName, icon: 'brand:linear' }));

    const projectsDb = await this.databasesService.create(membership, {
      space_id: space.id, name: 'Projects', icon: '🎯',
    });
    for (const f of [
      // #957: Linear's project states are a fixed set, so State is a select, not free text. The names are Linear's own.
      { display_name: 'State', type: 'select' as const, config: {}, options: PROJECT_STATES.map((st) => ({ label: st, color: PROJECT_STATE_COLOR[st], category: PROJECT_STATE_CATEGORY[st] })) },
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
      // #904: the options ARE the team's workflow states, named as in Linear, in Linear's order.
      { display_name: 'State', type: 'select' as const, config: {}, options: states.map((st) => ({ label: st.name, color: stateColor(st.type), category: stateCategory(st.type) })) },
      { display_name: 'Priority', type: 'select' as const, config: {}, options: [
        { label: 'Urgent', color: 'red' }, { label: 'High', color: 'gold' },
        { label: 'Medium', color: 'blue' }, { label: 'Low', color: 'gray' },
      ] },
      { display_name: 'Identifier', type: 'text' as const, config: {} },
      // #904: the original status name, kept as plain text as well, so a wrong State option is visible, not silent.
      { display_name: 'Linear Status', type: 'text' as const, config: {} },
      // #906: the latest Linear description, and a flag a person or agent clears once they have reconciled it.
      // #955: machine state for drift detection (#906), not something to read: hidden on the record page from the start.
      { display_name: 'Linear Description', type: 'text' as const, config: { entity_hidden: true } },
      { display_name: 'Description Drift', type: 'checkbox' as const, config: {} },
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
    return { issuesDb, projectsDb, sprintsDb, labelsDb, labelsFieldId, descriptionHidden: false };
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
        key: string; name: string; issues: number; linear_issue_total: number; comments: number; sprints: number; projects: number; labels: number;
        /** #902 — how many of this team's issues each Linear project will bring (and how many have none). */
        issues_by_project: Array<{ project_id: string | null; name: string; issues: number }>;
        /** #904 — per Linear status, in Linear's order: the numbers to check against Linear's own per-status counts. */
        issues_by_status: Array<{ status: string; type: string; issues: number }>;
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
        comments: data.comments.nodes.length,
        sprints: data.cycles.nodes.length,
        projects: data.projects.nodes.length,
        labels: data.labels.nodes.length,
        issues_by_project: issueCountsByProject(data),
        issues_by_status: issueCountsByStatus(data),
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

  /**
   * Run a sync and record how it went (#906): manual and scheduled runs both go through here, so the "last success" an
   * admin sees is true whichever one made it. A failure is stored with its message and re-thrown, never swallowed: a
   * job that fails quietly every hour looks exactly like one with nothing to do.
   */
  async sync(membership: Membership, actorId: string, opts: { runHeld?: boolean } = {}) {
    const started = Date.now();
    const workspaceId = membership.workspaceId;
    // One run at a time per workspace. A scheduled run already holds the lock (claimRun took it); a manual one must take it,
    // and is refused while another run is active, instead of two syncs writing the same records at once.
    if (!opts.runHeld && !(await this.acquireRun(workspaceId, new Date(started)))) {
      throw new ConflictException('A Linear sync is already running for this workspace — try again when it finishes');
    }
    try {
      return await this.syncRecorded(membership, actorId, started);
    } finally {
      await this.releaseRun(workspaceId).catch(() => undefined);
    }
  }

  private async syncRecorded(membership: Membership, actorId: string, started: number) {
    const workspaceId = membership.workspaceId;
    const before = await this.readLinear(workspaceId);
    await this.writeLinear(workspaceId, { ...before, sync_status: { ...before.sync_status, last_attempt_at: new Date(started).toISOString() } });
    try {
      const summary = await this.runSync(membership, actorId);
      const after = await this.readLinear(workspaceId);
      await this.writeLinear(workspaceId, {
        ...after,
        sync_status: {
          last_attempt_at: new Date(started).toISOString(),
          last_success_at: new Date().toISOString(),
          consecutive_failures: 0,
          last_run: { issues: summary.issues, comments: summary.comments.fetched, drift_flagged: summary.drift_flagged, left_scope: summary.left_scope, duration_ms: Date.now() - started },
        },
      });
      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const after = await this.readLinear(workspaceId);
      const failures = (after.sync_status?.consecutive_failures ?? 0) + 1;
      await this.writeLinear(workspaceId, {
        ...after,
        sync_status: { ...after.sync_status, last_attempt_at: new Date(started).toISOString(), last_error: message.slice(0, 500), last_error_at: new Date().toISOString(), consecutive_failures: failures },
      });
      // One ping when it STARTS failing (not one an hour while it stays broken); the status above stays loud meanwhile.
      if (failures === 1) {
        await this.notifications
          .notify({ workspaceId, actorId, type: 'connection_error', recipients: [actorId], snippet: `Linear mirror sync failed: ${message.slice(0, 160)}`, allowSelf: true })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /** One scheduler pass — public so tests can call it. Runs each workspace whose auto-sync is on and due. */
  async tick(now = new Date()): Promise<void> {
    const rows = (await this.db.execute(
      sql`SELECT id FROM workspaces WHERE settings->'linear'->'auto_sync'->>'enabled' = 'true'`,
    )) as unknown as { rows?: Array<{ id: string }> };
    for (const { id: workspaceId } of rows.rows ?? []) {
      const linear = await this.readLinear(workspaceId);
      const interval = linear.auto_sync?.interval_minutes ?? DEFAULT_SYNC_INTERVAL_MINUTES;
      // Due by last ATTEMPT, so a broken key is retried each interval, not every minute.
      const last = linear.sync_status?.last_attempt_at ?? null;
      if (last && now.getTime() - new Date(last).getTime() < interval * 60_000) continue; // cheap pre-check; the claim below decides
      if (!(await this.claimRun(workspaceId, now, interval))) {
        if (linear.sync_status?.running_since && now.getTime() - new Date(linear.sync_status.running_since).getTime() < RUN_LOCK_TIMEOUT_MINUTES * 60_000) {
          this.logger.log(`linear sync for ${workspaceId} skipped: previous run still active`);
        }
        continue;
      }
      try {
        await this.runScheduled(workspaceId, linear);
      } catch (error) {
        this.logger.warn(`linear scheduled sync for ${workspaceId} failed: ${String(error)}`);
      } finally {
        await this.releaseRun(workspaceId).catch(() => undefined); // also covers a run that never reached sync()
      }
    }
  }

  /**
   * Claim a due run atomically in the workspace row: only one API instance wins the compare-and-set on last_attempt_at,
   * and there is no session-level lock to leak (a pooled connection that unlocks on a different session releases nothing).
   * Public so a test can prove the exclusion directly.
   */
  async claimRun(workspaceId: string, now: Date, intervalMinutes: number): Promise<boolean> {
    const cutoff = new Date(now.getTime() - intervalMinutes * 60_000).toISOString();
    const lockCutoff = new Date(now.getTime() - RUN_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
    const claimed = (await this.db.execute(sql`
      UPDATE workspaces
         SET settings = jsonb_set(settings, '{linear,sync_status}',
               coalesce(settings->'linear'->'sync_status', '{}'::jsonb)
                 || jsonb_build_object('last_attempt_at', ${now.toISOString()}::text, 'running_since', ${now.toISOString()}::text))
       WHERE id = ${workspaceId}
         AND (settings->'linear'->'sync_status'->>'last_attempt_at' IS NULL
              OR (settings->'linear'->'sync_status'->>'last_attempt_at')::timestamptz <= ${cutoff}::timestamptz)
         -- never start while the previous run is still going: a slow Linear or a 15 minute interval must not overlap runs
         AND (settings->'linear'->'sync_status'->>'running_since' IS NULL
              OR (settings->'linear'->'sync_status'->>'running_since')::timestamptz <= ${lockCutoff}::timestamptz)
      RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };
    return Boolean(claimed.rows?.length);
  }

  /** Take the "a sync is running" mark for a MANUAL run. False while a fresh one exists. Atomic in the workspace row. */
  async acquireRun(workspaceId: string, now: Date): Promise<boolean> {
    const lockCutoff = new Date(now.getTime() - RUN_LOCK_TIMEOUT_MINUTES * 60_000).toISOString();
    const taken = (await this.db.execute(sql`
      UPDATE workspaces
         SET settings = jsonb_set(settings, '{linear,sync_status}',
               coalesce(settings->'linear'->'sync_status', '{}'::jsonb) || jsonb_build_object('running_since', ${now.toISOString()}::text))
       WHERE id = ${workspaceId}
         AND (settings->'linear'->'sync_status'->>'running_since' IS NULL
              OR (settings->'linear'->'sync_status'->>'running_since')::timestamptz <= ${lockCutoff}::timestamptz)
      RETURNING id`)) as unknown as { rows?: Array<{ id: string }> };
    return Boolean(taken.rows?.length);
  }

  async releaseRun(workspaceId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE workspaces
         SET settings = jsonb_set(settings, '{linear,sync_status}', (settings->'linear'->'sync_status') - 'running_since')
       WHERE id = ${workspaceId} AND settings->'linear'->'sync_status' IS NOT NULL`);
  }

  private async runScheduled(workspaceId: string, linear: LinearSettings) {
    // The admin who switched it on, else any active admin; nobody to act as means we do not invent an identity.
    const candidates = await this.db.query.memberships.findMany({ where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')) });
    const membership = candidates.find((m) => m.userId === linear.auto_sync?.actor_id) ?? candidates.find((m) => m.role === 'admin');
    if (!membership) {
      const after = await this.readLinear(workspaceId);
      await this.writeLinear(workspaceId, { ...after, sync_status: { ...after.sync_status, last_attempt_at: new Date().toISOString(), last_error: 'No active admin to run the scheduled sync as', last_error_at: new Date().toISOString(), consecutive_failures: (after.sync_status?.consecutive_failures ?? 0) + 1 } });
      return;
    }
    await this.sync(membership, membership.userId, { runHeld: true });
  }

  private async isOurOwnPush(c: LinearComment): Promise<boolean> {
    if (VIA_STORYOS_PATTERN.test(c.body ?? '')) return true;
    const [row] = await this.db.select({ id: linearCommentPushes.commentId }).from(linearCommentPushes).where(eq(linearCommentPushes.linearCommentId, c.id)).limit(1);
    return Boolean(row);
  }

  private async runSync(membership: Membership, actorId: string) {
    const { teams, apiKey } = await this.fetchTeams(membership.workspaceId);
    const summary = {
      dry_run: false, issues: 0, sprints: 0, projects: 0, labels: 0, teams: teams.map((t) => t.key),
      /** #902 — per team, what was fetched against what Linear says it has. A mismatch never gets this far (it throws). */
      per_team: [] as Array<{ key: string; issues_fetched: number; linear_issue_total: number }>,
      /** #904 — issues mapped to a State by anything other than their own status name. Always 0: a non-zero would have thrown. */
      fallback_mapped: 0,
      /** #903 — fetched = created + already_present, checked below; a gap throws. Not compared with a Linear-side total (Linear reports none). */
      comments: { fetched: 0, created: 0, already_present: 0 },
      /** #906 — descriptions whose Linear text changed after import: new text stored, StoryOS body untouched. */
      drift_flagged: 0,
      /** #955 — existing Issues databases whose `linear_description` this sync hid on the record page (once; empty when nothing changed). */
      description_hidden_in: [] as string[],
      /** #906 — mirrored issues Linear no longer returns (archived, deleted, moved out): marked, never deleted. */
      left_scope: 0,
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

    let currentTeam = '';
    try {
    for (const team of teams) {
      currentTeam = team.key;
      const data = fetched.get(team.id)!;
      summary.per_team.push({ key: team.key, issues_fetched: data.issues.nodes.length, linear_issue_total: data.issueTotal });
      const { issuesDb, projectsDb, sprintsDb, labelsDb, labelsFieldId, descriptionHidden } = await this.ensureTeamPack(membership, team, data.states.nodes, linkWarnings);
      if (descriptionHidden) summary.description_hidden_in.push(`${team.name} (Linear) / ${issuesDb.name} (${issuesDb.id})`);

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
      const projectState = await this.projectStateWriter(projectsDb.id);
      for (const project of data.projects.nodes) {
        const id = await this.upsertByLinearId(membership, projectsDb.id, project.id, {
          name: project.name,
          state: await projectState(project.state),
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

      // What is already mirrored (one paged read), for drift detection and for spotting issues that have left scope.
      const mirrored = await this.loadMirror(issuesDb.id, actorId);
      const issueIds = new Map<string, string>();
      for (const issue of data.issues.nodes) {
        const descriptionValues = await this.descriptionValues(mirrored.get(issue.id), issue.description ?? '');
        if (descriptionValues.description_drift === true) summary.drift_flagged++;
        const id = await this.upsertByLinearId(membership, issuesDb.id, issue.id, {
          ...descriptionValues,
          name: issue.title,
          identifier: issue.identifier,
          state: statusOptionId(stateOptions, issue.state.name),
          linear_status: issue.state.name,
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

      // #906 — an issue we mirrored that Linear no longer returns (archived, deleted, moved out of the chosen teams) is
      // MARKED, never deleted: agents may hold work against it. The read above passed the count check, so "absent" is
      // reliable. It reverts by itself if the issue comes back (the upsert rewrites linear_status).
      const fetchedIds = new Set(data.issues.nodes.map((i) => i.id));
      for (const [linearId, prior] of mirrored) {
        if (fetchedIds.has(linearId) || prior.linearStatus?.startsWith(LEFT_SCOPE_PREFIX)) continue;
        await this.recordsService.update(
          membership.workspaceId, issuesDb.id, prior.id,
          { linear_status: `${LEFT_SCOPE_PREFIX} · ${new Date().toISOString().slice(0, 10)}` },
          actorId, 0, 'automation',
        );
        summary.left_scope++;
      }

      // #903 — comments, in the order they were written. Each keeps its real author, time and body.
      const commentRows = [...data.comments.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const c of commentRows) {
        const recordId = issueIds.get(c.issue!.id);
        if (!recordId) throw new UnprocessableEntityException(`Comment ${c.id} belongs to an issue that was not imported`);
        // #907 — a comment WE pushed to Linear must not come back as a second copy. Two independent guards: its Linear id is
        // recorded in the outbox, and its first line ends "· via StoryOS". Either one is enough; both is the point.
        if (await this.isOurOwnPush(c)) {
          summary.comments.fetched++;
          summary.comments.already_present++;
          continue;
        }
        const author = c.user?.name ?? c.botActor?.name ?? c.externalUser?.name ?? 'Unknown author';
        const header = { type: 'paragraph', content: [{ type: 'text', text: `${author} · ${c.createdAt.slice(0, 16).replace('T', ' ')} UTC (from Linear)`, styles: { bold: true } }] };
        const outcome = await this.commentsService.importExternal(recordId, actorId, [header, ...markdownToBlocks(c.body ?? '')], new Date(c.createdAt), c.url);
        summary.comments.fetched++;
        if (outcome === 'created') summary.comments.created++;
        else summary.comments.already_present++;
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
    } catch (error) {
      // #959 — the integration page shows this text: name the team, so a raw engine message ("unknown field ...") is never
      // the whole story. The status is kept, and a message that already names the team is not prefixed twice.
      if (!currentTeam) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(`team ${currentTeam}:`)) throw error;
      const wrapped = `team ${currentTeam}: ${message}`;
      throw error instanceof HttpException ? new HttpException(wrapped, error.getStatus()) : new Error(wrapped);
    }
    if (summary.comments.fetched !== summary.comments.created + summary.comments.already_present) {
      throw new UnprocessableEntityException(`Comments fetched (${summary.comments.fetched}) do not equal created (${summary.comments.created}) plus already present (${summary.comments.already_present})`);
    }
    return linkWarnings.length > 0 ? { ...summary, warnings: linkWarnings } : summary;
  }

  /**
   * #957 — what to write into a Projects database's `State`. A NEW import makes it a select; one imported before
   * that (or converted by a person since) may still be text, or a select whose options came from the distinct values
   * the person had. So: text → the Linear name as is; a choice field → the option with that name, ADDED if the team
   * now has a state the list lacks (never dropped to empty, never mapped to a neighbour by guesswork).
   */
  private async projectStateWriter(projectsDbId: string): Promise<(state: string) => Promise<string | null>> {
    const field = (await this.db.query.fields.findMany({ where: eq(fieldsTable.databaseId, projectsDbId) })).find((f) => f.apiName === 'state' && !f.deletedAt);
    if (!field) return async () => null;
    if (field.type !== 'select' && field.type !== 'workflow') return async (state) => state;
    const options = await this.selectLabelMap(projectsDbId, 'state');
    return async (state) => {
      const known = pickOption(options, state);
      if (known) return known;
      const color = PROJECT_STATE_COLOR[state as keyof typeof PROJECT_STATE_COLOR] ?? 'gray';
      const created = await this.fields.addOption(projectsDbId, field.id, { label: state, color, category: PROJECT_STATE_CATEGORY[state as keyof typeof PROJECT_STATE_CATEGORY] });
      options.set(created.label, created.id);
      return created.id;
    };
  }

  private async selectLabelMap(databaseId: string, apiName: string): Promise<Map<string, string>> {
    const rows = await this.db.query.fields.findMany({
      where: and(eq(fieldsTable.databaseId, databaseId), isNull(fieldsTable.deletedAt)),
    });
    const target = rows.find((f) => f.apiName === apiName);
    if (!target) return new Map();
    const options = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, target.id),
    });
    return new Map(options.map((o) => [o.label, o.id]));
  }
}
