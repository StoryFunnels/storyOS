import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { workspaces } from '../db/schema';

/** Slack block-kit block — passed through untouched (see Slack's Block Kit docs). */
export type SlackBlock = Record<string, unknown>;

export interface SlackConfig {
  /** xoxb-… bot token used as a Bearer credential for chat.postMessage. */
  bot_token?: string;
  /** Channel id/name used when a message doesn't name one. */
  default_channel?: string;
  /** Incoming-webhook URL; used when no bot token is configured. */
  webhook_url?: string;
}

/** Minimal fetch surface so the service is testable without a network (mirrors LinearFetcher). */
export type SlackFetcher = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultFetcher: SlackFetcher = (url, init) =>
  fetch(url, { method: 'POST', headers: init.headers, body: init.body });

const POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/**
 * Slack integration (MN-021), phase 1: send messages from StoryOS into Slack —
 * either through a bot token (chat.postMessage, supports per-message channels)
 * or an incoming webhook (fixed channel). The credential lives in the workspace
 * `settings.slack` blob, exactly like GitHub/Linear, and never leaves the server.
 *
 * Phase 2 (TODO): a real Slack OAuth install flow (`oauth.v2.access`) so a
 * workspace admin can click-to-connect instead of pasting a bot token, plus
 * Events API subscriptions for inbound "create record from message". That needs
 * a registered Slack app with client id/secret + signing secret — out of scope
 * here; a bot token in config is enough to send.
 */
@Injectable()
export class SlackService {
  /** Swappable in tests. */
  fetcher: SlackFetcher = defaultFetcher;

  constructor(@Inject(DB) private readonly db: Db) {}

  private async readConfig(workspaceId: string): Promise<SlackConfig> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    return (((ws?.settings ?? {}) as Record<string, unknown>).slack as SlackConfig | undefined) ?? {};
  }

  async saveConfig(
    workspaceId: string,
    config: { bot_token?: string; default_channel?: string; webhook_url?: string },
  ) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    const existing = (settings.slack as SlackConfig) ?? {};
    const slack: SlackConfig = {
      bot_token: config.bot_token !== undefined ? config.bot_token : existing.bot_token,
      default_channel:
        config.default_channel !== undefined ? config.default_channel : existing.default_channel,
      webhook_url: config.webhook_url !== undefined ? config.webhook_url : existing.webhook_url,
    };
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, slack } })
      .where(eq(workspaces.id, workspaceId));
    return this.present(slack);
  }

  async getConfig(workspaceId: string) {
    return this.present(await this.readConfig(workspaceId));
  }

  /** MN-249: clear the stored bot token / webhook / default channel — back to not-connected. */
  async disconnect(workspaceId: string) {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    const settings = (ws?.settings ?? {}) as Record<string, unknown>;
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, slack: {} } })
      .where(eq(workspaces.id, workspaceId));
    return this.present({});
  }

  /** Client-safe view — never leaks the token or the webhook URL (which is itself a secret). */
  private present(slack: SlackConfig) {
    return {
      has_token: Boolean(slack.bot_token),
      has_webhook: Boolean(slack.webhook_url),
      default_channel: slack.default_channel ?? null,
    };
  }

  /**
   * Post a message to Slack. Prefers the bot token (chat.postMessage, so a
   * per-message `channel` works); falls back to an incoming webhook. Throws a
   * 422 when neither credential — nor, for the bot path, any channel — is set.
   */
  async sendMessage(
    workspaceId: string,
    message: { channel?: string; text: string; blocks?: SlackBlock[] },
  ): Promise<{ ok: true; via: 'bot' | 'webhook'; channel?: string }> {
    const config = await this.readConfig(workspaceId);

    if (config.bot_token) {
      const channel = message.channel || config.default_channel;
      if (!channel) {
        throw new UnprocessableEntityException(
          'Slack message needs a channel — set one on the action or a default channel in config',
        );
      }
      const res = await this.fetcher(POST_MESSAGE_URL, {
        headers: {
          authorization: `Bearer ${config.bot_token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text: message.text, blocks: message.blocks }),
      });
      const body = JSON.parse(await res.text()) as { ok: boolean; error?: string };
      if (!body.ok) {
        throw new UnprocessableEntityException(`Slack API: ${body.error ?? `HTTP ${res.status}`}`);
      }
      return { ok: true, via: 'bot', channel };
    }

    if (config.webhook_url) {
      const res = await this.fetcher(config.webhook_url, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: message.text, blocks: message.blocks }),
      });
      const text = await res.text();
      if (res.status !== 200 || text.trim() !== 'ok') {
        throw new UnprocessableEntityException(`Slack webhook error: ${text || `HTTP ${res.status}`}`);
      }
      return { ok: true, via: 'webhook' };
    }

    throw new UnprocessableEntityException('Configure a Slack bot token or webhook URL first');
  }
}
