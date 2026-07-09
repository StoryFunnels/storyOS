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

export type GithubFetcher = (path: string, token: string) => Promise<unknown>;

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

  async saveConfig(workspaceId: string, config: { token?: string; repos?: string[] }) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const existing = (settings.github as { token?: string; repos?: string[] }) ?? {};
    const github = {
      token: config.token !== undefined ? config.token : existing.token,
      repos: config.repos !== undefined ? config.repos : (existing.repos ?? []),
    };
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, github } })
      .where(eq(workspaces.id, workspaceId));
    return { repos: github.repos, has_token: Boolean(github.token) };
  }

  async getConfig(workspaceId: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const github = ((ws?.settings ?? {}) as Record<string, unknown>).github as
      | { token?: string; repos?: string[] }
      | undefined;
    return { repos: github?.repos ?? [], has_token: Boolean(github?.token) };
  }

  private async ensurePack(membership: Membership) {
    const all = await this.db.query.databases.findMany({
      where: eq(databasesTable.workspaceId, membership.workspaceId),
    });
    let issuesDb = all.find((d) => d.name === 'GitHub Issues');
    let pullsDb = all.find((d) => d.name === 'GitHub Pull Requests');
    if (issuesDb && pullsDb) return { issuesDb, pullsDb, created: false };

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

  private async upsert(
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
