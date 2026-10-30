import { fieldRef, optionRef } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';
import { HOME_BODY, HOW_WE_WORK_BODY, ONBOARDING_BODY, starterPage, TOOLS_BODY } from './team-wiki-pages';

/**
 * ticket #1147 — Team Wiki: pages with an owner and a review date, so the team knows what is still true.
 * Built from the prototype's Team Wiki (gallery card, why/can lines, "how it fits together" map, install list); the wording below is that
 * prototype's, not a rewrite of it.
 *
 * How "needs review" works, and why it is TWO rules rather than one reminder that repeats:
 *   1. "Move stale pages to Needs review": a daily scheduled rule. Its selection is Status = Verified AND Last reviewed before
 *      `$date:-90d` (a relative date, resolved when the rule runs: see `compileDate`), and its action sets Status to Needs review.
 *      A page leaves the selection the moment it moves, so it is selected once per crossing.
 *   2. "Review reminder": when a page's Status BECOMES Needs review, tell its Owner. A state-change trigger, so it fires once per
 *      crossing, not every day the page stays stale.
 * The "Needs review" view is the same 90-day test on its own, so a page whose Status nobody has flipped yet (or a Draft) still shows; a
 * page with NO review date does not (the four starter pages are Drafts with Last reviewed empty).
 *
 * The four starter pages' text is Dara's, approved on the ticket: see team-wiki-pages.ts. The prototype's install list is the source for
 * everything else, including the third view ("My pages") that makes its "3 views" true.
 */

export const TEAM_WIKI_PACK: PackRegistryEntry = {
  slug: 'team-wiki',
  name: 'Team Wiki',
  summary:
    'Pages with an owner and a review date, so the team knows what is still true. Starts with Home, Onboarding, How we work and Tools & accounts.',
  highlights: [
    'Pages: Owner, Last reviewed, Status (Draft, Verified, Needs review), Team, Parent page',
    'Teams: each team and the pages it keeps',
    'All pages, grouped by Team; My pages; and Needs review: pages not reviewed in 90 days',
    'Tells a page’s owner when it needs another look',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'team-wiki',
    name: 'Team Wiki',
    version: '1.0.0',
    why: 'Your team keeps answering the same questions, or nobody knows which document is still true.',
    can: [
      'Give every page an owner people can ask',
      'See which pages nobody has checked in 90 days',
      'Send new starters to Onboarding instead of answering in chat',
    ],
    scenario: 'pack',
    summary:
      'Pages with an owner and a review date, so the team knows what is still true. Starts with Home, Onboarding, How we work and Tools & accounts.',
    requires: { connections: [], ai: 'none' },
    databases: [
      {
        action: 'create',
        name: 'Pages',
        space: 'Wiki',
        fields: [
          { name: 'Owner', type: 'user' },
          { name: 'Last reviewed', type: 'date' },
        ],
      },
      { action: 'create', name: 'Teams', space: 'Wiki', fields: [] },
    ],
    relations: [
      // Each page belongs to a team; the Teams side collects "the pages it keeps".
      { from: 'Pages', to: 'Teams', cardinality: 'one_to_many', from_field: 'Team', to_field: 'Pages' },
      // A page's parent is another page.
      { from: 'Pages', to: 'Pages', cardinality: 'one_to_many', from_field: 'Parent page', to_field: 'Sub-pages' },
    ],
    states: [
      {
        database: 'Pages',
        field: 'Status',
        options: [
          { label: 'Draft', color: 'gray', category: 'unstarted' },
          { label: 'Verified', color: 'green', category: 'completed' },
          { label: 'Needs review', color: 'gold', category: 'started' },
        ],
      },
    ],
    agents: [],
    triggers: [],
    derived_fields: [],
    views: [
      {
        database: 'Pages',
        name: 'All pages',
        type: 'list',
        // "The space opens here".
        default: true,
        config: { group_by_field_id: fieldRef('Pages', 'Team') },
      },
      {
        database: 'Pages',
        name: 'My pages',
        type: 'list',
        // `'me'` is resolved to whoever opens the view: one shared view shows each person the pages they own.
        config: { filters: { field: 'owner', op: 'has', value: ['me'] } },
      },
      {
        database: 'Pages',
        name: 'Needs review',
        type: 'table',
        // Not reviewed in 90 days: the date is resolved when the view is opened, so it stays true as the days pass.
        config: { filters: { field: 'last_reviewed', op: 'before', value: '$date:-90d' } },
      },
    ],
    automations: [
      {
        database: 'Pages',
        name: 'Move stale pages to Needs review',
        trigger: { type: 'schedule', every: 'day', at: '09:00' },
        condition: {
          and: [
            { field: 'status', op: 'eq', value: optionRef('Pages', 'Status', 'Verified') },
            { field: 'last_reviewed', op: 'before', value: '$date:-90d' },
          ],
        },
        actions: [{ type: 'set_values', values: { status: optionRef('Pages', 'Status', 'Needs review') } }],
        enabled: true,
      },
      {
        database: 'Pages',
        name: 'Review reminder',
        trigger: { type: 'record_updated', field_id: fieldRef('Pages', 'Status') },
        condition: { field: 'status', op: 'eq', value: optionRef('Pages', 'Status', 'Needs review') },
        // 'owner' is the api_name of the person field: whoever owns the page.
        actions: [{ type: 'notify_user', user: 'owner', message: 'A page you own is 90 days old and needs another look.' }],
        enabled: true,
      },
    ],
    sample_records: [
      // Teams starts with one team; every starter page is on it.
      { database: 'Teams', values: { name: 'Everyone' } },
      starterPage('Home', HOME_BODY),
      starterPage('Onboarding', ONBOARDING_BODY, 'Home'),
      starterPage('How we work', HOW_WE_WORK_BODY, 'Home'),
      starterPage('Tools & accounts', TOOLS_BODY, 'Home'),
    ],
    skills: [],
    suggested_sources: [],
  },
};
