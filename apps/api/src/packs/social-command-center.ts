import { fieldRef, optionRef } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * #456 — the Social Command Center: a content calendar, an engagement triage board and a metrics log,
 * as a Business Pack (a MANIFEST pack, not a `TemplateDef` starter: manifests already carry automations
 * and suggested sources, #455/#600).
 *
 * ── What the copy may say (Otto's ruling on #456, binding) ──────────────────────────────────────────────
 * Nothing in this pack may claim that publishing works: not the summary, a database or field name, a
 * select option, a sample record, or a rule message. The one true sentence about publishing is
 * "Publishing requires connecting a LinkedIn or X account", and it appears only as that.
 *
 * ── Why no rule here publishes ──────────────────────────────────────────────────────────────────────────
 * A `post_social` action carries a `connection_id`, and `ActionsService.validate` refuses an action that
 * names a connection the workspace does not have. A manifest cannot know a workspace's connection, so a
 * rule that publishes cannot be pre-wired. The rules below are the ones that need no connection; the
 * publish rule is added by the person, after connecting an account.
 *
 * ── Every rule is explicitly disabled, and a test keeps it that way ─────────────────────────────────────
 * `packAutomationSchema.enabled` DEFAULTS TO TRUE, so a rule written without the field ships ON (the #878
 * shape: a default that does something while looking like a declaration). Each rule below says
 * `enabled: false`, and test/social-command-center-pack.test.ts iterates every rule the manifest has and
 * fails on any that is not `false`, so a rule added later without the line cannot ship live.
 */
export const SOCIAL_COMMAND_CENTER_PACK: PackRegistryEntry = {
  slug: 'social-command-center',
  name: 'Social Command Center',
  summary:
    'Plan posts on a calendar, track replies on a triage board, and log how each post performed. ' +
    'Publishing requires connecting a LinkedIn or X account.',
  highlights: [
    'Posts: a content calendar and a Draft → Approved → Scheduled → Published board',
    'Engagement: a triage board for replies, from Needs reply to Replied',
    'Metrics: views, likes and comments per post',
    'Three reminders, installed switched off — you turn on the ones you want',
    'Publishing requires connecting a LinkedIn or X account',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'social-command-center',
    name: 'Social Command Center',
    version: '1.0.0',
    scenario: 'pack',
    summary:
      'A content calendar, a reply triage board and a metrics log for social posts. Publishing requires ' +
      'connecting a LinkedIn or X account.',
    requires: { connections: [], ai: 'none' },
    databases: [
      {
        action: 'create',
        name: 'Posts',
        space: 'Social',
        fields: [
          { name: 'Publish Date', type: 'date' },
          {
            name: 'Channel',
            type: 'multi_select',
            options: [{ label: 'LinkedIn' }, { label: 'X' }],
          },
          { name: 'Text', type: 'rich_text' },
          { name: 'Media', type: 'attachment' },
          { name: 'Post URL', type: 'url' },
        ],
      },
      {
        action: 'create',
        name: 'Channels',
        space: 'Social',
        fields: [
          {
            name: 'Provider',
            type: 'select',
            options: [{ label: 'LinkedIn' }, { label: 'X' }],
          },
          { name: 'Handle', type: 'text' },
          { name: 'Notes', type: 'text' },
        ],
      },
      {
        action: 'create',
        name: 'Engagement',
        space: 'Social',
        fields: [
          {
            name: 'Platform',
            type: 'select',
            options: [{ label: 'LinkedIn' }, { label: 'X' }],
          },
          { name: 'Author', type: 'text' },
          { name: 'Message', type: 'rich_text' },
        ],
      },
      {
        action: 'create',
        name: 'Metrics',
        space: 'Social',
        fields: [
          { name: 'Date', type: 'date' },
          { name: 'Views', type: 'number' },
          { name: 'Likes', type: 'number' },
          { name: 'Comments', type: 'number' },
        ],
      },
    ],
    relations: [
      { from: 'Engagement', to: 'Posts', cardinality: 'one_to_many', from_field: 'Post', to_field: 'Engagement' },
      { from: 'Metrics', to: 'Posts', cardinality: 'one_to_many', from_field: 'Post', to_field: 'Metrics' },
    ],
    states: [
      {
        database: 'Posts',
        field: 'Status',
        options: [
          { label: 'Draft', color: 'gray' },
          { label: 'Approved', color: 'blue' },
          { label: 'Scheduled', color: 'gold' },
          { label: 'Published', color: 'green' },
        ],
      },
      {
        database: 'Engagement',
        field: 'Reply Status',
        options: [
          { label: 'Needs reply', color: 'red' },
          { label: 'Drafted', color: 'gold' },
          { label: 'Replied', color: 'green' },
          { label: 'Ignored', color: 'gray' },
        ],
      },
    ],
    agents: [],
    triggers: [],
    derived_fields: [],
    views: [
      {
        database: 'Posts',
        name: 'Content calendar',
        type: 'calendar',
        config: { date_field_id: fieldRef('Posts', 'Publish Date') },
      },
      {
        database: 'Posts',
        name: 'Post board',
        type: 'board',
        config: { group_by_field_id: fieldRef('Posts', 'Status') },
      },
      {
        database: 'Engagement',
        name: 'Triage',
        type: 'board',
        config: { group_by_field_id: fieldRef('Engagement', 'Reply Status') },
      },
      { database: 'Metrics', name: 'Metrics log', type: 'table', config: {} },
    ],
    automations: [
      {
        database: 'Posts',
        name: 'Remind me when a post’s status changes',
        trigger: { type: 'record_updated', field_id: fieldRef('Posts', 'Status') },
        actions: [{ type: 'notify_user', user: '@me', message: 'A post’s status changed.' }],
        enabled: false,
      },
      {
        database: 'Engagement',
        name: 'Remind me when something new needs a reply',
        trigger: { type: 'record_created' },
        actions: [{ type: 'notify_user', user: '@me', message: 'There is a new item to triage in Engagement.' }],
        enabled: false,
      },
      {
        database: 'Metrics',
        name: 'Weekly reminder to log post metrics',
        trigger: { type: 'schedule', every: 'week', weekday: 1, at: '09:00' },
        actions: [{ type: 'notify_user', user: '@me', message: 'Time to log this week’s post metrics.' }],
        enabled: false,
      },
    ],
    sample_records: [
      { database: 'Posts', values: { name: 'Launch announcement (sample)', status: optionRef('Posts', 'Status', 'Draft') } },
      { database: 'Posts', values: { name: 'Customer story (sample)', status: optionRef('Posts', 'Status', 'Approved') } },
      { database: 'Engagement', values: { name: 'Question about pricing (sample)', reply_status: optionRef('Engagement', 'Reply Status', 'Needs reply') } },
      { database: 'Metrics', values: { name: 'Week 1 (sample)', views: 1200, likes: 48, comments: 6 } },
    ],
    skills: [],
    // Suggestions only: nothing is connected for you, and a connection is the person's own step.
    suggested_sources: [
      { provider: 'linkedin.org_engagement', note: 'Pulls comments on your company page into Engagement, once you connect the account.' },
      { provider: 'x.mentions', note: 'Pulls mentions into Engagement, once you connect your X app.' },
    ],
  },
};
