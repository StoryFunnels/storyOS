import { canConnectAi, canOpenAdminSettings, type SettingsPageId } from '@/lib/settings-nav';

/**
 * The Settings home page's card model and the nav's attention counts (ticket #1185), as pure functions of what the server REPORTED.
 *
 * "Never guess numbers": every field in `SettingsSignals` is `undefined` until the query behind it has answered, and stays
 * `undefined` when it fails or the viewer's role never asks. An unknown renders as a card with no count, never as a zero: a wrong
 * zero reads as "all clear", and that is the most dangerous number to invent. Zero is shown only when the server said zero.
 */
export interface SettingsSignals {
  userName?: string;
  /** People in the workspace (admins only ask). */
  members?: number;
  /** Invitations whose `expires_at` has passed / that are still live (admins only ask). */
  invitesExpired?: number;
  invitesPending?: number;
  /** AI connections (apps that signed in, and tokens), and how many of them the server says need reconnecting. */
  aiApps?: number;
  aiNeedReconnect?: number;
  /** Personal tokens that work in THIS workspace, and the most recent use among them. */
  tokens?: number;
  tokensLastUsedAt?: string | null;
  /** Provider connections, how many are active, how many are not (expired, revoked, failing), and a few of their names. */
  connections?: number;
  connectionsNeedFix?: number;
  connectionNames?: string[];
  /** Installed packs, and how many have a newer version. */
  packs?: number;
  packNames?: string[];
  packUpdates?: number;
}

export interface SettingsHomeCard {
  id: string;
  /** The page it opens (a nav id), so the card and the nav entry cannot point at different places. */
  page: SettingsPageId | 'data-and-security';
  title: string;
  /** Absent when the number is not known: the card then shows only `detail`. */
  headline?: string;
  detail?: string;
  /** `warn` means something needs the viewer. Rendered with `text-warning-text`, never gold (gold is for an agent acting). */
  tone?: 'warn';
}

export const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface SettingsNavCount {
  text: string;
  warn?: boolean;
}

/** The small count at the right of a nav entry. Only where a real figure exists. */
export function settingsNavCounts(role: string | undefined, s: SettingsSignals): Partial<Record<SettingsPageId, SettingsNavCount>> {
  const out: Partial<Record<SettingsPageId, SettingsNavCount>> = {};
  if (canOpenAdminSettings(role)) {
    if (s.invitesExpired) out.members = { text: `${s.invitesExpired} expired`, warn: true };
    if (s.connections !== undefined && s.connections > 0) out.integrations = { text: String(s.connections), warn: Boolean(s.connectionsNeedFix) };
    if (s.packs) out.packs = { text: String(s.packs), warn: Boolean(s.packUpdates) };
  }
  if (canConnectAi(role)) {
    if (s.aiNeedReconnect) out['connect-ai'] = { text: `${s.aiNeedReconnect} to fix`, warn: true };
    if (s.tokens) out['api-tokens'] = { text: String(s.tokens) };
  }
  return out;
}

/** The cards on `/settings`: one per area the viewer can open, each saying what needs attention. */
export function settingsHomeCards(
  role: string | undefined,
  s: SettingsSignals,
  formatDate: (iso: string) => string,
): SettingsHomeCard[] {
  const cards: SettingsHomeCard[] = [
    {
      id: 'you',
      page: 'profile',
      title: 'You',
      headline: s.userName,
      detail: 'Profile, preferences, notifications',
    },
  ];

  if (canOpenAdminSettings(role)) {
    const members: SettingsHomeCard = { id: 'members', page: 'members', title: 'Members', headline: s.members === undefined ? undefined : plural(s.members, 'person', 'people') };
    if (s.invitesExpired) {
      members.detail = `${plural(s.invitesExpired, 'invitation')} expired`;
      members.tone = 'warn';
    } else if (s.invitesPending) {
      members.detail = `${plural(s.invitesPending, 'invitation')} waiting to be accepted`;
    } else if (s.invitesExpired === 0 && s.invitesPending === 0) {
      members.detail = 'No open invitations';
    }
    cards.push(members);
  }

  if (canConnectAi(role)) {
    const ai: SettingsHomeCard = { id: 'connect-ai', page: 'connect-ai', title: 'Connect your AI' };
    if (s.aiApps !== undefined) {
      const working = s.aiApps - (s.aiNeedReconnect ?? 0);
      ai.headline = s.aiApps === 0 ? 'No AI connected' : `${plural(Math.max(working, 0), 'connection')} working`;
      if (s.aiNeedReconnect) {
        ai.detail = `${s.aiNeedReconnect} ${s.aiNeedReconnect === 1 ? 'needs' : 'need'} reconnecting`;
        ai.tone = 'warn';
      } else if (s.aiApps === 0) {
        ai.detail = 'Connect Claude, ChatGPT or Cursor to work in StoryOS as you';
      }
    } else {
      ai.detail = 'Apps and tokens that work in StoryOS as you';
    }
    cards.push(ai);

    const tokens: SettingsHomeCard = { id: 'api-tokens', page: 'api-tokens', title: 'API tokens' };
    if (s.tokens !== undefined) {
      tokens.headline = plural(s.tokens, 'token');
      if (s.tokens === 0) tokens.detail = 'None yet';
      else if (s.tokensLastUsedAt) tokens.detail = `Last used ${formatDate(s.tokensLastUsedAt)}`;
      else tokens.detail = 'Never used';
    } else {
      tokens.detail = 'Personal tokens for scripts and anything that calls the API as you';
    }
    cards.push(tokens);
  }

  if (canOpenAdminSettings(role)) {
    const integrations: SettingsHomeCard = { id: 'integrations', page: 'integrations', title: 'Integrations' };
    if (s.connections !== undefined) {
      const working = s.connections - (s.connectionsNeedFix ?? 0);
      integrations.headline = s.connections === 0 ? 'Nothing connected' : `${Math.max(working, 0)} connected`;
      if (s.connectionsNeedFix) {
        integrations.detail = `${s.connectionsNeedFix} ${s.connectionsNeedFix === 1 ? 'needs' : 'need'} attention`;
        integrations.tone = 'warn';
      } else if (s.connectionNames?.length) {
        integrations.detail = s.connectionNames.join(' · ');
      }
    } else {
      integrations.detail = 'GitHub, Linear, Slack, Google and more';
    }
    cards.push(integrations);

    const packs: SettingsHomeCard = { id: 'packs', page: 'packs', title: 'Packs' };
    if (s.packs !== undefined) {
      if (s.packs === 0) {
        packs.headline = 'None installed';
      } else {
        packs.headline = s.packs === 1 && s.packNames?.[0] ? s.packNames[0] : plural(s.packs, 'pack') + ' installed';
        if (s.packUpdates) {
          packs.detail = `${plural(s.packUpdates, 'update')} available`;
          packs.tone = 'warn';
        } else {
          packs.detail = 'Up to date';
        }
      }
    } else {
      packs.detail = 'Ready-made workspaces for a kind of work';
    }
    cards.push(packs);

    cards.push({ id: 'data', page: 'data-and-security', title: 'Data & security', headline: 'Export · Trash · Audit log' });
  }

  return cards;
}
