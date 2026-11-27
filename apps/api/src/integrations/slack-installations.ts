import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { workspaces } from '../db/schema';
import { openFields, SEALED_SETTING_FIELDS } from '../common/settings-secret';
import { callSlack, defaultSlackApiFetcher } from './slack-api';
import type { SlackApiFetcher, SlackCallResult, SlackApiMethod } from './slack-api';

/**
 * Ticket #1379 - ONE Slack API client for the link-preview path, so a test swaps ONE `fetcher` and no real call can slip past it
 * (the same idea as `SlackService.fetcher`). Every call goes through `callSlack`, which only knows two methods on slack.com.
 */
@Injectable()
export class SlackApiClient {
  /** Swappable in tests. */
  fetcher: SlackApiFetcher = defaultSlackApiFetcher;

  call(method: SlackApiMethod, token: string, body: unknown): Promise<SlackCallResult> {
    return callSlack(this.fetcher, method, token, body);
  }
}

/** A Slack workspace (`teamId`) that a StoryOS workspace installed the app into, and the bot token that acts for it. */
export interface SlackInstallation {
  workspaceId: string;
  teamId: string;
  botToken: string;
}

/**
 * Ticket #1379 - THE SEAM between link previews and wherever installations come from.
 *
 * Previews need exactly one fact: "this Slack team was installed by THAT StoryOS workspace, and here is its bot token". Today the
 * only token source is the bot token an admin saved in the workspace's Slack settings (`WorkspaceSettingsInstallationProvider`
 * below). Ticket #1378 (OAuth install, an encrypted per-workspace token, one row per installation) replaces that source by
 * providing another class under `SLACK_INSTALLATION_PROVIDER`; nothing that consumes this interface changes.
 *
 * The contract a provider MUST keep, because the access rule rests on it:
 *   - `null` for a team no StoryOS workspace installed, and for a team that more than one workspace claims (it cannot be said which
 *     one installed it, so nobody gets previews: fail closed);
 *   - never throw for "not found"; and never return a token that does not belong to `teamId`.
 */
export interface SlackInstallationProvider {
  findByTeamId(teamId: string): Promise<SlackInstallation | null>;
}

export const SLACK_INSTALLATION_PROVIDER = Symbol('SLACK_INSTALLATION_PROVIDER');

/** How many workspaces with a saved bot token one lookup will examine. Past it the lookup fails closed and says so in the log. */
const MAX_CANDIDATES = 200;
/** A token Slack rejected is not asked about again for this long. A token Slack accepted never changes team, so it is kept for good. */
const NEGATIVE_TTL_MS = 5 * 60_000;

/**
 * Today's token source: the workspace's saved Slack bot token (`settings.slack.bot_token`, sealed at rest).
 *
 * "Installed by" is PROVEN, never claimed: a token's team is what Slack itself answers to `auth.test` for that token, so an admin
 * cannot attach their workspace to somebody else's Slack team by typing a team id (there is nowhere to type one). The answers are
 * cached per token hash (not per token: the token never becomes a key anywhere), so a lookup costs one `auth.test` per distinct
 * token per process, not one per event.
 *
 * It scans the workspaces that have a token, which is fine for a self-hosted instance (one or a few) and is exactly the cost
 * ticket #1378's indexed `team_id` column removes; `MAX_CANDIDATES` is the guard until then.
 */
@Injectable()
export class WorkspaceSettingsInstallationProvider implements SlackInstallationProvider {
  private readonly logger = new Logger(WorkspaceSettingsInstallationProvider.name);
  private readonly teamByToken = new Map<string, { teamId: string | null; at: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly client: SlackApiClient,
  ) {}

  async findByTeamId(teamId: string): Promise<SlackInstallation | null> {
    if (!teamId) return null;
    const rows = await this.db
      .select({ id: workspaces.id, settings: workspaces.settings })
      .from(workspaces)
      .where(sql`coalesce(${workspaces.settings} -> 'slack' ->> 'bot_token', '') <> ''`)
      .limit(MAX_CANDIDATES + 1);
    if (rows.length > MAX_CANDIDATES) {
      this.logger.warn(`more than ${MAX_CANDIDATES} workspaces hold a Slack bot token; link previews refuse until ticket #1378's installation table replaces this lookup`);
      return null;
    }
    const matches: SlackInstallation[] = [];
    for (const row of rows) {
      const token = this.tokenOf(row.settings);
      if (!token) continue;
      if ((await this.teamOf(token)) === teamId) matches.push({ workspaceId: row.id, teamId, botToken: token });
    }
    // Two workspaces holding a token for the SAME Slack team: nobody can say which one installed it.
    return matches.length === 1 ? matches[0]! : null;
  }

  private tokenOf(settings: unknown): string | null {
    const slack = ((settings ?? {}) as Record<string, unknown>).slack;
    if (!slack || typeof slack !== 'object') return null;
    try {
      const open = openFields(slack as { bot_token?: string; webhook_url?: string }, SEALED_SETTING_FIELDS.slack);
      return typeof open.bot_token === 'string' && open.bot_token.trim() ? open.bot_token.trim() : null;
    } catch {
      return null; // a value that no longer opens is not a token
    }
  }

  private async teamOf(token: string): Promise<string | null> {
    const key = createHash('sha256').update(token).digest('hex');
    const hit = this.teamByToken.get(key);
    if (hit && (hit.teamId !== null || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.teamId;
    const res = await this.client.call('auth.test', token, {});
    const teamId = res.ok && typeof res.data.team_id === 'string' && res.data.team_id ? res.data.team_id : null;
    this.teamByToken.set(key, { teamId, at: Date.now() });
    return teamId;
  }
}
