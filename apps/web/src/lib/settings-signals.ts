import type { SettingsSignals } from '@/lib/settings-home';

/** What the queries returned; a field is `undefined` until its query has succeeded (a failed or never-asked query stays `undefined`). */
export interface SettingsRawData {
  userName?: string;
  members?: unknown[];
  invites?: Array<{ expires_at: string }>;
  aiConnections?: Array<{ kind: 'oauth' | 'token'; reaches: string }>;
  /** Tokens that work in this workspace (already split from the other workspaces' tokens). */
  tokens?: Array<{ last_used_at: string | null }>;
  connections?: Array<{ name: string; status: string }>;
  packs?: Array<{ name: string; update_available: boolean }>;
}

/** Turn raw responses into signals. Expiry is judged against `now`, injected so the rule can be tested. */
export function deriveSettingsSignals(raw: SettingsRawData, now: number): SettingsSignals {
  const s: SettingsSignals = { userName: raw.userName };
  if (raw.members) s.members = raw.members.length;
  if (raw.invites) {
    const expired = raw.invites.filter((i) => Date.parse(i.expires_at) < now).length;
    s.invitesExpired = expired;
    s.invitesPending = raw.invites.length - expired;
  }
  if (raw.aiConnections) {
    // Every connection the Connect-your-AI page lists (an app that signed in, or a personal token), so this count and that page, and the
    // onboarding checklist's "Connect your AI" tick, can never disagree about whether an AI is connected.
    s.aiApps = raw.aiConnections.length;
    s.aiNeedReconnect = raw.aiConnections.filter((c) => c.reaches === 'needs_reconnect').length;
  }
  if (raw.tokens) {
    s.tokens = raw.tokens.length;
    const used = raw.tokens.map((t) => t.last_used_at).filter((d): d is string => Boolean(d));
    s.tokensLastUsedAt = used.length ? used.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
  }
  if (raw.connections) {
    s.connections = raw.connections.length;
    s.connectionsNeedFix = raw.connections.filter((c) => c.status !== 'active').length;
    s.connectionNames = [...new Set(raw.connections.filter((c) => c.status === 'active').map((c) => c.name))].slice(0, 4);
  }
  if (raw.packs) {
    s.packs = raw.packs.length;
    s.packNames = raw.packs.map((p) => p.name);
    s.packUpdates = raw.packs.filter((p) => p.update_available).length;
  }
  return s;
}
