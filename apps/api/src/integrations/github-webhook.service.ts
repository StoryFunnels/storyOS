import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  databases as databasesTable,
  fields as fieldsTable,
  memberships,
  relations as relationsTable,
  selectOptions,
  workspaces,
} from '../db/schema';
import { env } from '../config/env';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { GithubAppService } from './github-app.service';
import { GithubReviewsService } from './github-reviews.service';
import type { RawComment } from './github-reviews.service';
import { BACKLINK_COMMENT_API, DEFAULT_STATE_AUTOMATION, GithubService } from './github.service';
import type { GithubConfig, GithubStateAutomation } from './github.service';

/**
 * The inbound delivery path. Exported so app.setup.ts can put exactly this path
 * — and nothing else — on the raw-body allowlist. If this string and the
 * controller's route ever drift apart, the HMAC has no bytes to verify and every
 * delivery 401s: loud, not silent.
 */
export const GITHUB_WEBHOOK_PATH = '/api/v1/integrations/github/webhook';

/** The relation field name on GitHub Pull Requests, pointing at the linked record. */
const LINK_FIELD_NAME = 'Linked Record';
/** Its mirror on the user's database. Named so it can't collide with the importer's
 *  PR↔Issue relation ("Pull Requests" on GitHub Issues). */
const BACKLINK_FIELD_NAME = 'GitHub Pull Requests';

/**
 * The magic branch name (AC 2): `story-123`, anywhere in the ref, case-insensitive.
 * Bounded by a separator or an end, so `history-12` and `story-12x` do not match
 * while `feat/story-123-some-slug` does.
 */
const BRANCH_RE = /(?:^|[/_-])story-(\d+)(?:[-_/]|$)/i;

/** A StoryOS record URL in the PR body/title: /w/<ws>/d/<uuid>/r/<rec>. */
const RECORD_URL_RE =
  /\/w\/[^/\s]+\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/r\/([A-Za-z0-9_-]+)/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookPull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  html_url: string;
  body?: string | null;
  user?: { login: string } | null;
  head: { ref: string; sha?: string };
}

interface WebhookPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: WebhookPull;
  review?: { state?: string };
  ref?: string;
  commits?: Array<{ message?: string }>;
  /** Present on every GitHub App delivery — the App-native tenant key. */
  installation?: { id?: number };
  /** Present on `pull_request_review_comment` deliveries (#43). */
  comment?: RawComment;
}

/** What a delivery did — the response body, and what the tests assert on. */
export interface WebhookOutcome {
  ok: true;
  event: string;
  /** null when nothing about this delivery was actionable (still a 200). */
  linked_record_id?: string | null;
  pull_request_record_id?: string | null;
  /** Why we did nothing, when we did nothing. */
  skipped?: string;
  state_applied?: string | null;
  pong?: boolean;
}

/**
 * Inbound GitHub webhooks (#42, AC 2/3/4/6).
 *
 * Security posture: the route is unauthenticated because GitHub calls it, so the
 * `x-hub-signature-256` HMAC **is** the authentication — and it doubles as the
 * tenant resolver. Nothing about a payload is read, parsed into meaning, or
 * written anywhere until a signature verifies against some workspace's secret.
 *
 * Everything downstream of that goes through the ordinary services: PRs are
 * upserted via GithubService's (repo, number) upsert, and state moves via
 * RecordsService.update — which is what makes the agent triggers fire off a
 * webhook exactly as they do off a human edit.
 *
 * Tenant resolution has two eras, and which one runs is decided by ONE thing:
 * whether the instance-level `GITHUB_APP_WEBHOOK_SECRET` is set.
 *
 *  - **App-native (present):** a GitHub App issues one webhook secret (set at App
 *    registration) and every delivery carries `installation.id`. So we verify the
 *    signature against that single env secret and resolve the workspace by the
 *    payload's `installation.id` → the workspace whose github settings
 *    `installation_id` matches. No per-workspace secret, no PAT.
 *  - **Legacy fallback (absent):** the pre-App #42 path — the matching
 *    per-workspace `webhook_secret` both authenticates AND identifies the tenant.
 *    Kept intact for non-App self-hosters.
 *
 * The precedence is unambiguous: env secret set → App path only (a delivery that
 * would only pass some workspace's legacy secret is rejected); env secret unset →
 * legacy path only. Either way, a delivery that fails the active path is a 401 and
 * never processed; a well-signed delivery whose installation matches no workspace
 * is a 200 no-op (a 4xx would teach GitHub to disable the hook). See
 * `maybeBacklink` for the GitHub-side backlink (AC 5), posted as the installation.
 */
@Injectable()
export class GithubWebhookService {
  private readonly logger = new Logger(GithubWebhookService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly github: GithubService,
    private readonly githubApp: GithubAppService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
    private readonly githubReviews: GithubReviewsService,
  ) {}

  /**
   * Verify + dispatch. Throws 401 on a bad/absent signature; every other
   * failure mode is a 200 with a `skipped` reason, because a 4xx teaches GitHub
   * to disable the hook and an unmatched branch is not GitHub's fault.
   */
  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    event: string | undefined,
  ): Promise<WebhookOutcome> {
    if (!rawBody || !signature) throw new UnauthorizedException('Missing signature');

    // Precedence: the instance-level App secret, if set, is the ONLY authority —
    // App path. Absent → legacy per-workspace path. This decides both how the
    // signature is verified and how the tenant is resolved.
    const appSecret = this.githubApp.webhookSecret();
    let workspaceId: string | null;
    let payload: WebhookPayload;

    if (appSecret) {
      // App-native: one env secret verifies every delivery; the raw-body HMAC is
      // unchanged, only its secret source moved from per-workspace to env.
      if (!verifySignature(rawBody, appSecret, signature)) {
        throw new UnauthorizedException('Invalid signature');
      }
      const parsed = this.parse(rawBody);
      if (!parsed) return { ok: true, event: event ?? 'unknown', skipped: 'unparseable_body' };
      payload = parsed;
      // ping is a connectivity check with nothing to route — ack it before we
      // even look for an installation.
      if (event === 'ping') return { ok: true, event, pong: true };
      workspaceId = await this.resolveByInstallation(payload);
      if (!workspaceId) {
        // Well-signed, but names an installation no workspace has connected.
        // 200 no-op (never 4xx → GitHub keeps the hook; never a cross-tenant
        // write), logged so a mis-linked installation is diagnosable.
        this.logger.log(
          `github webhook ${event ?? 'unknown'}: no workspace for installation ${payload.installation?.id ?? 'none'}`,
        );
        return { ok: true, event: event ?? 'unknown', skipped: 'unknown_installation' };
      }
    } else {
      // Legacy #42: the matching per-workspace secret authenticates AND names the
      // tenant, in one HMAC sweep. Untouched.
      workspaceId = await this.authenticate(rawBody, signature);
      const parsed = this.parse(rawBody);
      if (!parsed) return { ok: true, event: event ?? 'unknown', skipped: 'unparseable_body' };
      payload = parsed;
      if (event === 'ping') return { ok: true, event, pong: true };
    }

    // #43: pull_request_review_comment is a read-only cache refresh (inline
    // review comment thread), not a state-automation trigger — see the
    // dedicated branch in `process`, kept separate from the AC 2/3/4 flow below.
    if (
      event !== 'pull_request' &&
      event !== 'pull_request_review' &&
      event !== 'pull_request_review_comment' &&
      event !== 'push'
    ) {
      return { ok: true, event: event ?? 'unknown', skipped: 'unhandled_event' };
    }

    try {
      return await this.process(workspaceId, event, payload);
    } catch (error) {
      // A delivery must not 500: GitHub retries and eventually disables a hook
      // that keeps erroring. Log it, ack it, move on.
      this.logger.error(`github webhook ${event} failed: ${String(error)}`);
      return { ok: true, event, skipped: 'handler_error' };
    }
  }

  /** Parse the verified raw bytes, or null if they aren't JSON. */
  private parse(rawBody: Buffer): WebhookPayload | null {
    try {
      return JSON.parse(rawBody.toString('utf8')) as WebhookPayload;
    } catch {
      return null;
    }
  }

  /**
   * App path tenant resolution: the workspace whose github settings
   * `installation_id` matches the payload's `installation.id`.
   *
   * Two workspaces can legitimately share an installation (the same org connected
   * from two workspaces). We resolve that deterministically to the
   * earliest-created workspace — a stable, documented choice — rather than crash
   * or pick at random. Comparison is on the JSON text so a malformed stored value
   * can never throw a cast error and 500 the delivery.
   */
  private async resolveByInstallation(payload: WebhookPayload): Promise<string | null> {
    const installationId = payload.installation?.id;
    if (installationId === undefined || installationId === null) return null;
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        sql`${workspaces.settings}->'github'->>'installation_id' = ${String(installationId)}`,
      )
      .orderBy(workspaces.createdAt)
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * The security core. Returns the workspace the delivery authenticates as.
   *
   * The route carries no tenant, so the secret *is* the tenant: we HMAC the raw
   * bytes with each configured secret and the one that matches identifies the
   * workspace. That is not a lookup shortcut — a forged delivery cannot match
   * any secret, so it can never name a workspace.
   */
  private async authenticate(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!rawBody || !signature) throw new UnauthorizedException('Missing signature');

    const candidates = await this.db
      .select({ id: workspaces.id, settings: workspaces.settings })
      .from(workspaces)
      .where(sql`${workspaces.settings}->'github'->>'webhook_secret' IS NOT NULL`);

    for (const candidate of candidates) {
      const secret = ((candidate.settings as Record<string, unknown>).github as GithubConfig)
        ?.webhook_secret;
      if (secret && verifySignature(rawBody, secret, signature)) return candidate.id;
    }
    // Covers all three of: no workspace has a secret, wrong secret, tampered body.
    throw new UnauthorizedException('Invalid signature');
  }

  private async process(
    workspaceId: string,
    event: 'pull_request' | 'pull_request_review' | 'pull_request_review_comment' | 'push',
    payload: WebhookPayload,
  ): Promise<WebhookOutcome> {
    const repo = payload.repository?.full_name;
    if (!repo) return { ok: true, event, skipped: 'no_repository' };

    // #43 inbound sync: cache the comment (created/edited) so it shows up here
    // without a manual poll, whichever side authored it. Deliberately short:
    // no state automation, no actor resolution, no repo-filter — a comment
    // isn't a workflow trigger, just a read cache to keep fresh. `deleted`
    // removes the cached row rather than leaving a stale comment behind.
    if (event === 'pull_request_review_comment') {
      const number = payload.pull_request?.number;
      if (!number || !payload.comment) return { ok: true, event, skipped: 'no_comment' };
      if (payload.action === 'deleted') {
        await this.githubReviews.deleteCached(workspaceId, String(payload.comment.id));
      } else {
        await this.githubReviews.cacheFromWebhook(workspaceId, repo, number, payload.comment);
      }
      return { ok: true, event };
    }

    const config = await this.github.readConfig(workspaceId);

    // #247 repo picker: once an admin has narrowed the watched set, ignore events
    // from repos outside it. An empty set means "not narrowed" → watch all, which
    // keeps the pre-#247 manual-secret behaviour (and its tests) unchanged.
    if ((config.repos?.length ?? 0) > 0 && !config.repos!.includes(repo)) {
      return { ok: true, event, skipped: 'repo_not_selected' };
    }

    const membership = await this.resolveActor(workspaceId, config);
    if (!membership) {
      // Nobody to act as → we will not invent an identity (ADR-0010 §2).
      this.logger.warn(`github webhook: no active actor for workspace ${workspaceId}`);
      return { ok: true, event, skipped: 'no_actor' };
    }
    const actorId = membership.userId;

    const { branch, text } = this.subject(event, payload);
    const linked = await this.resolveRecord(workspaceId, config, branch, text);
    if (!linked) {
      // AC 2: an unmatched branch is a no-op 200, not a 4xx. Logged so a
      // mis-typed branch is diagnosable rather than silently inert.
      this.logger.log(`github webhook ${event}: no record for branch "${branch}" in ${repo}`);
    }

    let pullRecordId: string | null = null;
    if (payload.pull_request) {
      pullRecordId = await this.upsertPull(membership, config, repo, payload.pull_request, linked);
    }

    const label = this.stateFor(event, payload, config.state_automation);
    let applied: string | null = null;
    if (linked && label) {
      applied = await this.applyState(workspaceId, linked.databaseId, linked.recordId, label, actorId);
    }

    return {
      ok: true,
      event,
      linked_record_id: linked?.recordId ?? null,
      pull_request_record_id: pullRecordId,
      state_applied: applied,
    };
  }

  /** The branch + free text this event offers up for linking. */
  private subject(event: string, payload: WebhookPayload): { branch: string; text: string } {
    if (event === 'push') {
      return {
        branch: (payload.ref ?? '').replace(/^refs\/heads\//, ''),
        text: (payload.commits ?? []).map((c) => c.message ?? '').join('\n'),
      };
    }
    const pr = payload.pull_request;
    return {
      branch: pr?.head.ref ?? '',
      text: [pr?.title ?? '', pr?.body ?? ''].join('\n'),
    };
  }

  /**
   * AC 2's two linking rules, in order:
   *  1. the magic branch name `story-<n>` → record #n in the configured database;
   *  2. a StoryOS record URL in the PR body/title (or a commit message) — which
   *     names its own database, so it works without any linking config at all.
   */
  private async resolveRecord(
    workspaceId: string,
    config: GithubConfig,
    branch: string,
    text: string,
  ): Promise<{ databaseId: string; recordId: string } | null> {
    const branchMatch = branch.match(BRANCH_RE);
    if (branchMatch && config.link_database_id) {
      const found = await this.byNumber(
        workspaceId,
        config.link_database_id,
        Number(branchMatch[1]),
      );
      if (found) return found;
    }

    const urlMatch = text.match(RECORD_URL_RE);
    if (urlMatch) {
      const databaseId = urlMatch[1]!;
      const rec = urlMatch[2]!;
      // The URL names a database; it must still be one of *this* workspace's,
      // or a PR body could reach across tenants.
      const database = await this.db.query.databases.findFirst({
        where: and(eq(databasesTable.id, databaseId), eq(databasesTable.workspaceId, workspaceId)),
      });
      if (!database) return null;
      if (UUID_RE.test(rec)) {
        const record = await this.recordsService.get(databaseId, rec).catch(() => null);
        return record ? { databaseId, recordId: record.id } : null;
      }
      const trailing = rec.match(/(\d+)$/);
      if (trailing) return this.byNumber(workspaceId, databaseId, Number(trailing[1]));
    }
    return null;
  }

  private async byNumber(workspaceId: string, databaseId: string, number: number) {
    const database = await this.db.query.databases.findFirst({
      where: and(eq(databasesTable.id, databaseId), eq(databasesTable.workspaceId, workspaceId)),
    });
    if (!database) return null;
    const record = await this.recordsService.getByNumber(databaseId, number).catch(() => null);
    return record ? { databaseId, recordId: record.id } : null;
  }

  /**
   * AC 3. Idempotent on (repo, PR number) through the importer's own upsert, so
   * a redelivery — GitHub redelivers freely — updates the row instead of adding
   * a second one.
   */
  private async upsertPull(
    membership: Membership,
    config: GithubConfig,
    repo: string,
    pr: WebhookPull,
    linked: { databaseId: string; recordId: string } | null,
  ): Promise<string> {
    const { pullsDb } = await this.github.ensurePack(membership);
    const merged = Boolean(pr.merged ?? pr.merged_at);
    const stateLabel = merged ? 'Merged' : pr.draft ? 'Draft' : pr.state === 'open' ? 'Open' : 'Closed';
    const checksLabel = await this.fetchChecks(repo, pr.head.sha, config.token);

    const stateOptions = await this.github.optionIdsByLabel(pullsDb.id, 'state');
    const checkOptions = await this.github.optionIdsByLabel(pullsDb.id, 'checks');

    const { id } = await this.github.upsert(
      membership,
      pullsDb.id,
      repo,
      pr.number,
      {
        name: pr.title,
        state: stateOptions.get(stateLabel) ?? null,
        checks: checkOptions.get(checksLabel) ?? null,
        branch: pr.head.ref,
        author_login: pr.user?.login ?? null,
        url: pr.html_url,
      },
      membership.userId,
    );

    if (linked) {
      await this.link(membership, pullsDb.id, id, linked).catch((error) =>
        this.logger.warn(`github webhook: linking PR ${repo}#${pr.number} failed: ${String(error)}`),
      );
      await this.maybeBacklink(membership, config, pullsDb.id, id, repo, pr.number, linked);
    }
    return id;
  }

  /**
   * AC 5: the moment a record links to a PR, put one backlink comment on the PR.
   *
   * Post-once is the whole game. GitHub redelivers events freely, so we guard on
   * the comment id stored on the PR record: absent → POST and store the id;
   * present → PATCH the existing comment. Either way exactly one comment ever
   * exists. A failure (missing App, no installation, revoked perms, deleted PR)
   * is logged and swallowed — a backlink must never break inbound processing.
   */
  private async maybeBacklink(
    membership: Membership,
    config: GithubConfig,
    pullsDbId: string,
    pullRecordId: string,
    repo: string,
    prNumber: number,
    linked: { databaseId: string; recordId: string },
  ): Promise<void> {
    // Backlinks require the connected GitHub App (they post as the installation).
    // Without it, connect isn't available and there's nothing to post with.
    if (!this.githubApp.isConfigured() || config.installation_id === undefined || config.installation_id === null) {
      return;
    }
    const installationId = config.installation_id;
    try {
      const record = await this.recordsService.get(linked.databaseId, linked.recordId);
      const url = `${env().WEB_URL}/w/${membership.workspaceId}/d/${linked.databaseId}/r/${record.number ?? record.id}`;
      const body = `🔗 Linked to StoryOS: **${record.title}**\n\n${url}`;

      const prRecord = await this.recordsService.get(pullsDbId, pullRecordId);
      const existing = prRecord.values[BACKLINK_COMMENT_API];
      if (typeof existing === 'string' && existing.length > 0) {
        await this.githubApp.updateComment(installationId, repo, existing, body);
        return;
      }
      const commentId = await this.githubApp.postComment(installationId, repo, prNumber, body);
      await this.recordsService.update(
        membership.workspaceId,
        pullsDbId,
        pullRecordId,
        { [BACKLINK_COMMENT_API]: commentId },
        membership.userId,
      );
    } catch (error) {
      this.logger.warn(`github backlink for ${repo}#${prNumber} failed: ${String(error)}`);
    }
  }

  /**
   * Point the PR row at the record. The PR↔record relation is provisioned
   * lazily and found by (database pair), the same find-or-create discipline
   * ensurePack uses — the target database isn't known until someone links to it.
   */
  private async link(
    membership: Membership,
    pullsDbId: string,
    pullRecordId: string,
    linked: { databaseId: string; recordId: string },
  ) {
    let fieldId = await this.findLinkField(pullsDbId, linked.databaseId);
    if (!fieldId) {
      await this.relationsService.create(membership, {
        database_a_id: pullsDbId,
        database_b_id: linked.databaseId,
        cardinality: 'many_to_many',
        field_a_name: LINK_FIELD_NAME,
        field_b_name: BACKLINK_FIELD_NAME,
      });
      fieldId = await this.findLinkField(pullsDbId, linked.databaseId);
    }
    if (!fieldId) return;
    await this.relationsService.addLinks(
      membership.workspaceId,
      pullsDbId,
      pullRecordId,
      fieldId,
      [linked.recordId],
      membership.userId,
    );
  }

  /** The relation field on pullsDb that points at targetDb, if the relation exists. */
  private async findLinkField(pullsDbId: string, targetDbId: string): Promise<string | null> {
    const relation = await this.db.query.relations.findFirst({
      where: or(
        and(
          eq(relationsTable.databaseAId, pullsDbId),
          eq(relationsTable.databaseBId, targetDbId),
        ),
        and(
          eq(relationsTable.databaseAId, targetDbId),
          eq(relationsTable.databaseBId, pullsDbId),
        ),
      ),
    });
    if (!relation) return null;
    const fieldId = relation.databaseAId === pullsDbId ? relation.fieldAId : relation.fieldBId;
    const field = await this.db.query.fields.findFirst({
      where: and(eq(fieldsTable.id, fieldId), isNull(fieldsTable.deletedAt)),
    });
    return field ? field.id : null;
  }

  /** AC 3's checks column. No PAT → `Unknown`; a PAT is the only way to ask. */
  private async fetchChecks(repo: string, sha: string | undefined, token: string | undefined) {
    if (!token || !sha) return 'Unknown';
    try {
      const res = (await this.github.fetcher(`/repos/${repo}/commits/${sha}/status`, token)) as {
        state?: string;
      };
      switch (res?.state) {
        case 'success':
          return 'Success';
        case 'pending':
          return 'Pending';
        case 'failure':
        case 'error':
          return 'Failure';
        default:
          return 'Unknown';
      }
    } catch (error) {
      // The checks column is decoration; a flaky GitHub read must not cost us
      // the state automation this delivery is actually here to do.
      this.logger.warn(`github webhook: checks lookup for ${repo}@${sha} failed: ${String(error)}`);
      return 'Unknown';
    }
  }

  /** AC 4: which configured state label (if any) this event asks for. */
  private stateFor(
    event: string,
    payload: WebhookPayload,
    configured: GithubStateAutomation | undefined,
  ): string | null {
    const map = { ...DEFAULT_STATE_AUTOMATION, ...(configured ?? {}) };
    if (event === 'push') return map.pushed ?? null;
    if (event === 'pull_request_review') {
      if (payload.action !== 'submitted') return null;
      if (payload.review?.state === 'approved') return map.review_approved ?? null;
      if (payload.review?.state === 'changes_requested') return map.review_changes_requested ?? null;
      return null;
    }
    switch (payload.action) {
      case 'opened':
        return map.opened ?? null;
      case 'reopened':
        return map.reopened ?? null;
      case 'review_requested':
        return map.review_requested ?? null;
      case 'closed':
        // "closed" is two different events wearing one name.
        return payload.pull_request?.merged || payload.pull_request?.merged_at
          ? (map.merged ?? null)
          : (map.closed ?? null);
      default:
        return null;
    }
  }

  /**
   * AC 4's payoff. The write goes through RecordsService.update — the ordinary
   * path — so it emits the same record_updated DomainEvent a human edit does,
   * and the agent trigger subscriber (#212) dispatches off it for free.
   *
   * A missing state field or an unknown option label is a config mismatch, not
   * an error: skip cleanly and say why. Never a 500.
   */
  private async applyState(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    label: string,
    actorId: string,
  ): Promise<string | null> {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fieldsTable.databaseId, databaseId), isNull(fieldsTable.deletedAt)),
    });
    const stateField = fieldRows.find(
      (f) => f.type === 'select' && (f.apiName === 'state' || f.apiName === 'status'),
    );
    if (!stateField) {
      this.logger.log(`github webhook: database ${databaseId} has no state field — skipping`);
      return null;
    }
    const options = await this.db.query.selectOptions.findMany({
      where: eq(selectOptions.fieldId, stateField.id),
    });
    const option = options.find((o) => o.label.toLowerCase() === label.toLowerCase());
    if (!option) {
      this.logger.log(`github webhook: no "${label}" option on ${stateField.apiName} — skipping`);
      return null;
    }
    await this.recordsService.update(
      workspaceId,
      databaseId,
      recordId,
      { [stateField.apiName]: option.id },
      actorId,
    );
    return option.label;
  }

  /**
   * The identity a webhook-driven write acts as: the admin who configured the
   * hook, falling back to any active admin (the config predates #42 in existing
   * workspaces). A demoted or departed configurer yields no actor at all rather
   * than a write from a ghost.
   */
  private async resolveActor(
    workspaceId: string,
    config: GithubConfig,
  ): Promise<Membership | null> {
    if (config.webhook_actor_id) {
      const membership = await this.db.query.memberships.findFirst({
        where: and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, config.webhook_actor_id),
        ),
      });
      if (membership && membership.status === 'active') return membership;
    }
    const admins = await this.db.query.memberships.findMany({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin')),
    });
    return admins.find((m) => m.status === 'active') ?? null;
  }
}

/**
 * `x-hub-signature-256` verification (GitHub's spec: "sha256=" + hex HMAC of the
 * **raw request body**).
 *
 * Two things carry the security here:
 *  - the HMAC is over `rawBody`, the bytes off the wire. Hashing a re-serialized
 *    body would still "pass" for well-formed payloads while silently accepting
 *    tampering that survives a parse/stringify round-trip.
 *  - the compare is `timingSafeEqual`, length-checked first because it *throws*
 *    on a length mismatch (a throw is also an oracle). The short-circuit is safe:
 *    the expected length is a public constant, not a secret.
 */
export function verifySignature(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
