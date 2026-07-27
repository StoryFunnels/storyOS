/**
 * The integrations directory registry (#44).
 *
 * A small, static catalog — id, label, "built by", description, auth kind and
 * status — that drives the gallery at `/settings/integrations` generically
 * instead of a hand-maintained card per platform. It deliberately carries no
 * icon and no config-field schema: icons are a client-rendering concern (see
 * the `ICONS` map in the web gallery page), and every entry here still owns a
 * bespoke connect/config surface — GitHub's App-install + repo picker,
 * Linear's dry-run/import, Slack's bot-token-or-webhook chooser — because
 * each is genuinely richer than one generic key/value form. What this
 * registry unifies is the one thing that WAS duplicated per platform: the
 * gallery card and its connected/not-connected status. `IntegrationsDirectoryController`
 * (integrations.controller.ts) is the one place that turns this list into
 * live `connected` booleans, by asking each integration's own service.
 *
 * The workspace credential registry two doors down (`connections/providers`,
 * MN-252) is a deliberately different, narrower thing: a generic OAuth2/api_key
 * credential store with no per-provider UI or workflow logic (Apify, Resend,
 * and a YouTube-scoped Google connection). Google Calendar connects through a
 * dedicated calendar-scoped sibling in that credential store, so granting
 * Calendar write access never widens an existing YouTube credential.
 */

export type IntegrationAuthKind = 'oauth2' | 'config' | 'delegate';
export type IntegrationStatus = 'available' | 'soon';

export interface IntegrationDescriptor {
  /** Registry key — also the last path segment of its settings page. */
  id: string;
  label: string;
  builtBy: string;
  description: string;
  authKind: IntegrationAuthKind;
  status: IntegrationStatus;
}

/**
 * #112 — the social-ingest platforms whose sources run on the shared generic
 * 'http' bearer connection. Since there's no dedicated per-platform OAuth
 * provider yet, a platform counts as "connected" when there's an active http
 * connection NAMED for it — the setup page seeds that name so tokens are
 * identifiable and can't be mis-paired. The web side (`lib/social-ingest.ts`)
 * mirrors `defaultConnectionName`; keep the two in sync.
 */
export const SOCIAL_INGEST: Record<
  'meta' | 'x' | 'linkedin',
  { defaultConnectionName: string; sourceProvider: string; match: RegExp }
> = {
  meta: { defaultConnectionName: 'Meta comments', sourceProvider: 'meta.page_comments', match: /^meta\b/i },
  x: { defaultConnectionName: 'X mentions', sourceProvider: 'x.mentions', match: /^x\b/i },
  linkedin: { defaultConnectionName: 'LinkedIn comments', sourceProvider: 'linkedin.org_engagement', match: /^linkedin\b/i },
};

export const INTEGRATION_REGISTRY: readonly IntegrationDescriptor[] = [
  {
    id: 'github',
    label: 'GitHub',
    builtBy: 'StoryOS',
    description: 'Import Issues & Pull Requests; PRs auto-link to the issues they reference.',
    authKind: 'oauth2',
    status: 'available',
  },
  {
    id: 'linear',
    label: 'Linear',
    builtBy: 'StoryOS',
    description: 'One-shot migration — teams become spaces with Issues, Sprints and Projects.',
    authKind: 'config',
    status: 'available',
  },
  {
    id: 'slack',
    label: 'Slack',
    builtBy: 'StoryOS',
    description:
      'Send messages to Slack from automations — post updates to a channel when records change.',
    authKind: 'config',
    status: 'available',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    builtBy: 'StoryOS',
    description: 'Import channel videos, comments and performance metrics into StoryOS databases.',
    authKind: 'oauth2',
    status: 'available',
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    builtBy: 'StoryOS',
    description: 'Two-way sync between date fields and your calendar.',
    authKind: 'oauth2',
    status: 'available',
  },
  // MN-261 social engagement ingest (#112) — each is a discoverable top-level
  // entry point for "pull in our Meta/X/LinkedIn comments" so a user doesn't
  // have to already be inside a database's "Sync from…" menu to find it. They
  // run on the generic 'http' bearer connection today (no dedicated OAuth
  // provider yet); the setup page names the connection per-platform so tokens
  // can't be mis-paired. `connected` is resolved from a per-platform-named http
  // connection (integrations.controller.ts).
  {
    id: 'meta',
    label: 'Meta (Facebook & Instagram)',
    builtBy: 'StoryOS',
    description: 'Pull Facebook Page and Instagram comments into a StoryOS database as records.',
    authKind: 'config',
    status: 'available',
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    builtBy: 'StoryOS',
    description: 'Pull mentions of your X account into a StoryOS database as records.',
    authKind: 'config',
    status: 'available',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    builtBy: 'StoryOS',
    description: 'Pull comments on your LinkedIn organization posts into a StoryOS database.',
    authKind: 'config',
    status: 'available',
  },
  {
    id: 'mcp',
    label: 'Claude & ChatGPT',
    builtBy: 'StoryOS',
    description: 'Connect AI clients to your StoryOS workspace through the hosted MCP endpoint.',
    authKind: 'oauth2',
    status: 'available',
  },
  {
    id: 'delegate-agent',
    label: 'Delegate to agent',
    builtBy: 'StoryOS',
    description:
      'Assign the StoryOS agent to any record — it works through the tool catalog and posts progress back as a comment.',
    authKind: 'delegate',
    status: 'available',
  },
  // Carried over from the original MN-099 gallery — roadmap placeholders, not
  // yet backed by any service, hence no entry in the controller's `connected`
  // map below (it defaults an unlisted id to `false`).
  {
    id: 'storyfunnels',
    label: 'StoryFunnels',
    builtBy: 'StoryOS',
    description: 'Native integration with StoryFunnels — pipelines and content in sync.',
    authKind: 'config',
    status: 'soon',
  },
  {
    id: 'storypages',
    label: 'StoryPages',
    builtBy: 'StoryOS',
    description: 'Native integration with StoryPages — publish and track pages from here.',
    authKind: 'config',
    status: 'soon',
  },
] as const;
