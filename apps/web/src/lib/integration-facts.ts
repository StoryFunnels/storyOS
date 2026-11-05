import type { IntegrationEndpoint, IntegrationFacts } from '@/lib/provider-pages';
import { mirrorHealth, timeAgo, type SyncStatus } from '@/lib/linear-mirror';

/**
 * Ticket #1188 — what a connection card needs from GitHub's, Linear's and Slack's own config responses, as pure functions.
 * The health sentences are the server's own verdicts reported, never re-derived: GitHub's `ignored_deliveries` (#828) and Linear's
 * `sync.stale` / `consecutive_failures` (#919).
 */
export interface GithubCfg {
  connected: boolean;
  has_token: boolean;
  repos: string[];
  ignored_deliveries?: { repos: Array<{ repo: string; count: number }>; other_count: number };
}
export interface LinearCfg {
  has_key: boolean;
  auto_sync: { enabled: boolean };
  sync: SyncStatus;
}
export interface SlackCfg {
  has_token: boolean;
  has_webhook: boolean;
  default_channel?: string | null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** GitHub: connected, and the repositories that still send events although they are not tracked. */
export function githubFacts(cfg: GithubCfg): IntegrationFacts {
  const connected = Boolean(cfg.connected || cfg.has_token);
  const ignored = (cfg.ignored_deliveries?.repos.length ?? 0) + (cfg.ignored_deliveries?.other_count ?? 0);
  const tracked = cfg.repos.length;
  return {
    connected,
    problem: connected && ignored > 0 ? `${ignored} ${plural(ignored, 'repository', 'repositories')} you don’t track ${plural(ignored, 'is', 'are')} still sending events.` : null,
    detail: connected ? `${tracked} ${plural(tracked, 'repository', 'repositories')} tracked` : null,
  };
}

/** Linear: whether a key is saved, and the mirror's verdict. */
export function linearFacts(cfg: LinearCfg, now: Date = new Date()): IntegrationFacts {
  if (!cfg.has_key) return { connected: false };
  const health = mirrorHealth(cfg.auto_sync.enabled, cfg.sync);
  const last = cfg.sync.last_success_at ? `Last synced ${timeAgo(cfg.sync.last_success_at, now)}` : 'Not synced yet';
  return {
    connected: true,
    problem: health === 'stale' ? `The mirror is not updating. ${last}.` : health === 'failing' ? `The last sync failed. ${last}.` : null,
    detail: last,
  };
}

export function slackFacts(cfg: SlackCfg): IntegrationFacts {
  const connected = Boolean(cfg.has_token || cfg.has_webhook);
  return { connected, detail: connected ? (cfg.default_channel ? `Posts to ${cfg.default_channel}` : cfg.has_token ? 'Bot token saved' : 'Webhook saved') : null };
}

export const INTEGRATION_FACTS: Record<IntegrationEndpoint, (raw: never) => IntegrationFacts> = {
  github: githubFacts as (raw: never) => IntegrationFacts,
  linear: ((raw: LinearCfg) => linearFacts(raw)) as (raw: never) => IntegrationFacts,
  slack: slackFacts as (raw: never) => IntegrationFacts,
};

/** Friendlier copy for the Slack errors people actually hit when testing the connection (moved here from the Slack page, ticket #1188). */
export function friendlySlackTestError(message: string): string {
  if (message.includes('channel_not_found')) {
    return "Slack couldn't find that channel. Invite the bot to it first: /invite @YourAppName";
  }
  if (message.includes('not_in_channel')) {
    return 'The bot isn’t in that channel yet. Run /invite @YourAppName in Slack, then test again.';
  }
  if (message.includes('invalid_auth') || message.includes('token_revoked')) {
    return 'That token is invalid or was revoked. Copy a fresh Bot User OAuth Token from your Slack app.';
  }
  return message;
}
