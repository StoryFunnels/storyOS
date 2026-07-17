import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases as databasesTable, fields as fieldsTable, selectOptions, workspaces } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import { SpacesService } from '../workspaces/spaces.service';
import type { Membership } from '../workspaces/workspace-access.guard';

interface GithubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  html_url: string;
  labels: Array<{ name: string }>;
  assignee: { login: string } | null;
  pull_request?: object; // present when the "issue" is actually a PR
  body?: string | null;
}

interface GithubPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  draft?: boolean;
}

/**
 * Which PR event moves the linked record where. Values are state-option
 * **labels** (not ids): a label survives a workspace re-provisioning the option,
 * and it is what an admin actually types. An explicit `null` means "this event
 * moves nothing" — that is how you switch a default off (see DEFAULT_STATE_AUTOMATION).
 */
export interface GithubStateAutomation {
  opened?: string | null;
  reopened?: string | null;
  review_requested?: string | null;
  review_approved?: string | null;
  review_changes_requested?: string | null;
  merged?: string | null;
  closed?: string | null;
  pushed?: string | null;
}

/** AC 4's defaults — opened → In Progress, review_requested → In Review, merged → Done. */
export const DEFAULT_STATE_AUTOMATION: GithubStateAutomation = {
  opened: 'In Progress',
  reopened: 'In Progress',
  review_requested: 'In Review',
  review_approved: null,
  review_changes_requested: null,
  merged: 'Done',
  // A PR closed *without* merging is an abandoned attempt, not a finished one —
  // moving the record anywhere on it would be a guess, so it defaults to off.
  closed: null,
  pushed: null,
};

export interface GithubConfig {
  /** PAT. Optional: only the checks lookup (AC 3) needs it — the webhook does not. */
  token?: string;
  repos?: string[];
  /** HMAC-SHA256 key for `x-hub-signature-256` on inbound deliveries (#42). Write-only. */
  webhook_secret?: string;
  /**
   * The identity webhook-driven writes act as. There is no caller on an inbound
   * delivery, so writes are attributed to the admin who configured the hook —
   * never to a synthetic superuser.
   */
  webhook_actor_id?: string;
  /** Which database `story-<n>` branch numbers resolve against (numbers are per-database). */
  link_database_id?: string;
  state_automation?: GithubStateAutomation;
}

export type GithubFetcher = (path: string, token: string) => Promise<unknown>;

/**
 * AC 3's "+ checks". `Unknown` is a first-class value, not a gap: without a PAT
 * there is no checks endpoint to ask, and saying so beats an empty cell that
 * reads as "no checks ran".
 */
const CHECKS_FIELD: Parameters<FieldsService['create']>[1] = {
  display_name: 'Checks',
  type: 'select',
  config: {},
  options: [
    { label: 'Success', color: 'green' },
    { label: 'Pending', color: 'yellow' },
    { label: 'Failure', color: 'red' },
    { label: 'Unknown', color: 'gray' },
  ],
};

const defaultFetcher: GithubFetcher = async (path, token) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'storyos',
    },
  });
  if (!res.ok) {
    throw new UnprocessableEntityException(`GitHub API ${res.status} for ${path}`);
  }
  return res.json();
};

/**
 * GitHub integration v1 (MN-065): token-based import + refresh of Issues and
 * Pull Requests into a GitHub pack, idempotent by GitHub number, with
 * automatic PR↔Issue linking from "#N" / branch-name references. One-way,
 * webhook-less by design (self-host friendly); the token stays server-side.
 */
@Injectable()
export class GithubService {
  /** Swappable in tests. */
  fetcher: GithubFetcher = defaultFetcher;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly spaces: SpacesService,
    private readonly databasesService: DatabasesService,
    private readonly fields: FieldsService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
  ) {}

  /** The full config, secrets included. Server-side only — never hand this to a client. */
  async readConfig(workspaceId: string): Promise<GithubConfig> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    return (((ws?.settings ?? {}) as Record<string, unknown>).github as GithubConfig | undefined) ?? {};
  }

  async saveConfig(
    workspaceId: string,
    config: {
      token?: string;
      repos?: string[];
      webhook_secret?: string;
      link_database_id?: string;
      state_automation?: GithubStateAutomation;
    },
    actorId?: string,
  ) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const existing = (settings.github as GithubConfig) ?? {};
    const github: GithubConfig = {
      token: config.token !== undefined ? config.token : existing.token,
      repos: config.repos !== undefined ? config.repos : (existing.repos ?? []),
      webhook_secret:
        config.webhook_secret !== undefined ? config.webhook_secret : existing.webhook_secret,
      // Whoever set the secret owns what the hook does with it, so the actor
      // follows the secret. Existing actor is kept when the secret isn't touched.
      webhook_actor_id:
        config.webhook_secret !== undefined && actorId ? actorId : existing.webhook_actor_id,
      link_database_id:
        config.link_database_id !== undefined ? config.link_database_id : existing.link_database_id,
      state_automation:
        config.state_automation !== undefined ? config.state_automation : existing.state_automation,
    };
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, github } })
      .where(eq(workspaces.id, workspaceId));
    return this.present(github);
  }

  async getConfig(workspaceId: string) {
    return this.present(await this.readConfig(workspaceId));
  }

  /**
   * Client-safe view (AC 6). The token and the webhook secret are write-only:
   * they are reported as presence booleans and never as values. Anything that
   * ever grows a new secret here must go through `redactSecrets` naming too —
   * the workspace `settings` blob is served by WorkspacesService, which redacts.
   */
  private present(github: GithubConfig) {
    return {
      repos: github.repos ?? [],
      has_token: Boolean(github.token),
      has_webhook_secret: Boolean(github.webhook_secret),
      link_database_id: github.link_database_id ?? null,
      state_automation: { ...DEFAULT_STATE_AUTOMATION, ...(github.state_automation ?? {}) },
    };
  }

  async ensurePack(membership: Membership) {
    const all = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, membership.workspaceId),
    });
    let issuesDb = all.find((d) => d.name === 'GitHub Issues');
    let pullsDb = all.find((d) => d.name === 'GitHub Pull Requests');
    if (issuesDb && pullsDb) {
      // A pack provisioned before #42 predates the Checks field — grow it in
      // place rather than making the webhook a second, divergent provisioner.
      await this.ensureField(pullsDb.id, 'checks', CHECKS_FIELD);
      return { issuesDb, pullsDb, created: false };
    }

    const space = await this.spaces.create(membership.workspaceId, { name: 'GitHub', icon: '🐙' });
    issuesDb = (await this.databasesService.create(membership, {
      space_id: space.id,
      name: 'GitHub Issues',
      icon: '🐛',
    })) as typeof issuesDb;
    pullsDb = (await this.databasesService.create(membership, {
      space_id: space.id,
      name: 'GitHub Pull Requests',
      icon: '🔀',
    })) as typeof pullsDb;

    const issueFields: Array<Parameters<FieldsService['create']>[1]> = [
      { display_name: 'Repo', type: 'text', config: {} },
      { display_name: 'Number', type: 'number', config: {} },
      { display_name: 'State', type: 'select', config: {}, options: [{ label: 'Open', color: 'green' }, { label: 'Closed', color: 'purple' }] },
      { display_name: 'Labels', type: 'text', config: {} },
      { display_name: 'Assignee (login)', type: 'text', config: {} },
      { display_name: 'URL', type: 'url', config: {} },
    ];
    for (const f of issueFields) await this.fields.create(issuesDb!.id, f);
    const pullFields: Array<Parameters<FieldsService['create']>[1]> = [
      { display_name: 'Repo', type: 'text', config: {} },
      { display_name: 'Number', type: 'number', config: {} },
      { display_name: 'State', type: 'select', config: {}, options: [{ label: 'Open', color: 'green' }, { label: 'Merged', color: 'purple' }, { label: 'Closed', color: 'brown' }, { label: 'Draft', color: 'gray' }] },
      { display_name: 'Branch', type: 'text', config: {} },
      { display_name: 'Author (login)', type: 'text', config: {} },
      { display_name: 'URL', type: 'url', config: {} },
      CHECKS_FIELD,
    ];
    for (const f of pullFields) await this.fields.create(pullsDb!.id, f);

    await this.relationsService.create(membership, {
      database_a_id: pullsDb!.id,
      database_b_id: issuesDb!.id,
      cardinality: 'many_to_many',
      field_a_name: 'Closes Issues',
      field_b_name: 'Pull Requests',
    });
    return { issuesDb: issuesDb!, pullsDb: pullsDb!, created: true };
  }

  /** Add a field to a pack database if it isn't there yet, found by api_name. */
  private async ensureField(
    databaseId: string,
    apiName: string,
    spec: Parameters<FieldsService['create']>[1],
  ): Promise<void> {
    const existing = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    if (!existing) await this.fields.create(databaseId, spec);
  }

  /** label → option id for a select field, for writing values. */
  async optionIdsByLabel(databaseId: string, apiName: string): Promise<Map<string, string>> {
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, apiName)),
    });
    const options = field
      ? await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, field.id) })
      : [];
    return new Map(options.map((o) => [o.label, o.id]));
  }

  /**
   * Find-or-create a record keyed by (repo, number) — the identity GitHub gives
   * us. Public because the webhook (#42) upserts the *same* PR rows this
   * importer does: two writers, one row per PR, no duplicates either way.
   */
  async upsert(
    membership: Membership,
    databaseId: string,
    repo: string,
    number: number,
    values: Record<string, unknown>,
    actorId: string,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.recordsService.query(databaseId, {
      filter: { and: [{ field: 'repo', op: 'eq', value: repo }, { field: 'number', op: 'eq', value: number }] },
      sorts: [],
      limit: 1,
    } as never, actorId);
    if (existing.data[0]) {
      await this.recordsService.update(membership.workspaceId, databaseId, existing.data[0].id, values, actorId);
      return { id: existing.data[0].id, created: false };
    }
    const created = await this.recordsService.create(
      membership.workspaceId,
      databaseId,
      { ...values, repo, number },
      actorId,
      0,
    );
    return { id: created.id, created: true };
  }

  async sync(membership: Membership, actorId: string) {
    const config = await this.getConfig(membership.workspaceId);
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, membership.workspaceId) });
    const token = (((ws?.settings ?? {}) as Record<string, unknown>).github as { token?: string })?.token;
    if (!token || config.repos.length === 0) {
      throw new UnprocessableEntityException('Configure a GitHub token and at least one repo first');
    }

    const { issuesDb, pullsDb } = await this.ensurePack(membership);
    const stateOptions = async (databaseId: string) => {
      const stateField = await this.db.query.fields.findFirst({
        where: and(eq(fieldsTable.databaseId, databaseId), eq(fieldsTable.apiName, 'state')),
      });
      const options = stateField
        ? await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, stateField.id) })
        : [];
      return new Map(options.map((o) => [o.label, o.id]));
    };
    const issueStates = await stateOptions(issuesDb.id);
    const pullStates = await stateOptions(pullsDb.id);
    const summary = { issues: 0, pulls: 0, linked: 0, repos: config.repos };
    // number → record id per repo, for the linking pass
    const issueIds = new Map<string, string>();

    for (const repo of config.repos) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        throw new UnprocessableEntityException(`Invalid repo "${repo}" — use owner/name`);
      }
      const issues = (await this.fetcher(`/repos/${repo}/issues?state=all&per_page=100`, token)) as GithubIssue[];
      for (const issue of issues) {
        if (issue.pull_request) continue; // the issues endpoint includes PRs
        const { id } = await this.upsert(membership, issuesDb.id, repo, issue.number, {
          name: issue.title,
          state: issueStates.get(issue.state === 'open' ? 'Open' : 'Closed') ?? null,
          labels: issue.labels.map((l) => l.name).join(', ') || null,
          assignee_login: issue.assignee?.login ?? null,
          url: issue.html_url,
        }, actorId);
        issueIds.set(`${repo}#${issue.number}`, id);
        summary.issues++;
      }

      const pulls = (await this.fetcher(`/repos/${repo}/pulls?state=all&per_page=100`, token)) as GithubPull[];
      const prRelationField = (await this.recordsService.fieldDefs(pullsDb.id)).find((d) => d.type === 'relation');
      for (const pull of pulls) {
        const state = pull.merged_at ? 'Merged' : pull.draft ? 'Draft' : pull.state === 'open' ? 'Open' : 'Closed';
        const { id } = await this.upsert(membership, pullsDb.id, repo, pull.number, {
          name: pull.title,
          state: pullStates.get(state) ?? null,
          branch: pull.head.ref,
          author_login: pull.user?.login ?? null,
          url: pull.html_url,
        }, actorId);
        summary.pulls++;

        // Auto-link (the "significantly better" part): #N in title or issue-number in branch name.
        if (!prRelationField) continue;
        const referenced = new Set<number>();
        for (const match of pull.title.matchAll(/#(\d+)/g)) referenced.add(Number(match[1]));
        for (const match of pull.head.ref.matchAll(/(?:^|[/_-])(\d{1,6})(?:[/_-]|$)/g)) referenced.add(Number(match[1]));
        const targets = [...referenced]
          .map((n) => issueIds.get(`${repo}#${n}`))
          .filter((v): v is string => Boolean(v));
        if (targets.length > 0) {
          await this.relationsService
            .addLinks(membership.workspaceId, pullsDb.id, id, prRelationField.id, targets, actorId)
            .then(() => { summary.linked += targets.length; })
            .catch(() => undefined);
        }
      }
    }

    return summary;
  }
}
