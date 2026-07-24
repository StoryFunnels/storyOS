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
