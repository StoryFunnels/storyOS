import { fieldRef, optionRef, SAMPLE_ME } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * ticket #1148 — Dev Tracker: the pack for a team that wants bugs and features in one queue, in Linear's first five minutes.
 * Built from the prototype's Dev Tracker (v50: the gallery card, its why/can lines, its "how it fits together" map and its install list)
 * and Dara's answers on the ticket, and the wording below is that prototype's.
 *
 * It is a NEW sibling of `dev-project-os`, not a retune of it (Otto's decision on the ticket): `dev-project-os` is untouched, so an
 * installed Dev Project OS is never changed by this pack, and `dev-project-os-frozen.json` in the tests pins that.
 *
 * Where each shape comes from. The Linear importer (`apps/api/src/integrations/linear.service.ts`) is the source for the shapes, so a team
 * moving from Linear lands somewhere familiar:
 *  - Priority options and colours: the importer's Issues database (`Priority`: Urgent red, High gold, Medium blue, Low gray).
 *  - Projects.State: the importer's `PROJECT_STATE_LABEL` / `PROJECT_STATE_COLOR` / `PROJECT_STATE_CATEGORY` (Backlog, Planned, In Progress,
 *    Paused, Completed, Canceled).
 *  - Sprints: the importer's Number, Start Date, End Date (without the Linear ID); relations Issue to Sprint, Issue to Project, and
 *    Parent Issue / Sub-issues. Labels are a multi-select here (Bug, Feature, Improvement), not a database: three labels do not need one.
 *  - Issues.State: the six Linear-shaped states plus Canceled, with the categories #1105 stores; Triage is the first option, so a new issue lands in it.
 *
 * What is deliberately NOT here: a Specs database (Long-form docs are Team Wiki's job), a Type field (the Triage agent suggests Labels and
 * Priority), and any view the prototype does not list. The gallery counts "4 views", and these are the four.
 *
 * Known limit: the Active board is filtered to To Do, In Progress and In Review, but a view config cannot hide a board COLUMN, so Triage,
 * Backlog, Done and Canceled still show as empty columns on it.
 */
export const DEV_TRACKER_PACK: PackRegistryEntry = {
  slug: 'dev-tracker',
  name: 'Dev Tracker',
  summary:
    'Issues that land in Triage, a board of active work, My issues, projects, sprints and releases: shaped like the Linear importer, so a team moving from Linear lands somewhere familiar.',
  highlights: [
    'Issues: State (Triage to Canceled), Priority, Assignee, Labels, Estimate, Due date, Project, Sprint, Release, Sub-issues',
    'Projects, Sprints and Releases, linked to the issues they hold; a release page is the changelog',
    'Active, My issues, Triage and Projects views; the space opens on Active',
    'Tells the assignee, and a Triage agent that suggests Labels and Priority and flags a likely duplicate',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'dev-tracker',
    name: 'Dev Tracker',
    version: '1.0.0',
    why: 'You build software and want bugs and features in one queue, next to the rest of your work.',
    can: [
      'Drop in a bug and it lands in Triage for someone to sort',
      'Put issues into projects and sprints, the way Linear does',
      'Ship a release, and its page becomes the changelog',
    ],
    scenario: 'pack',
    summary:
      'Issues that land in Triage, a board of active work, My issues, projects, sprints and releases: shaped like the Linear importer, so a team moving from Linear lands somewhere familiar.',
    requires: { connections: [], ai: 'byo' },
    databases: [
      {
        action: 'create',
        name: 'Issues',
        space: 'Product',
        fields: [
          {
            name: 'Priority',
            type: 'select',
            // The Linear importer's own options and colours.
            options: [
              { label: 'Urgent', color: 'red' },
              { label: 'High', color: 'gold' },
              { label: 'Medium', color: 'blue' },
              { label: 'Low', color: 'gray' },
            ],
          },
          { name: 'Assignee', type: 'user' },
          { name: 'Labels', type: 'multi_select', options: [{ label: 'Bug' }, { label: 'Feature' }, { label: 'Improvement' }] },
          { name: 'Estimate', type: 'number' },
          { name: 'Due date', type: 'date' },
        ],
      },
      {
        action: 'create',
        name: 'Projects',
        space: 'Product',
        fields: [
          { name: 'Lead', type: 'user' },
          { name: 'Target date', type: 'date' },
        ],
      },
      {
        action: 'create',
        name: 'Sprints',
        space: 'Product',
        fields: [
          { name: 'Number', type: 'number' },
          { name: 'Start date', type: 'date' },
          { name: 'End date', type: 'date' },
        ],
      },
      {
        action: 'create',
        name: 'Releases',
        space: 'Product',
        // The release's own page (its description) is the changelog.
        fields: [{ name: 'Release date', type: 'date' }],
      },
    ],
    relations: [
      { from: 'Issues', to: 'Projects', cardinality: 'one_to_many', from_field: 'Project', to_field: 'Issues' },
      { from: 'Issues', to: 'Sprints', cardinality: 'one_to_many', from_field: 'Sprint', to_field: 'Issues' },
      { from: 'Issues', to: 'Releases', cardinality: 'one_to_many', from_field: 'Release', to_field: 'Issues' },
      { from: 'Issues', to: 'Issues', cardinality: 'one_to_many', from_field: 'Parent issue', to_field: 'Sub-issues' },
    ],
    states: [
      {
        database: 'Issues',
        field: 'State',
        // Triage is first, so a new issue lands in it (#1088).
        options: [
          { label: 'Triage', color: 'gray', category: 'backlog' },
          { label: 'Backlog', color: 'gray', category: 'backlog' },
          { label: 'To Do', color: 'blue', category: 'unstarted' },
          { label: 'In Progress', color: 'gold', category: 'started' },
          { label: 'In Review', color: 'purple', category: 'started' },
          { label: 'Done', color: 'green', category: 'completed' },
          { label: 'Canceled', color: 'red', category: 'canceled' },
        ],
      },
      {
        database: 'Projects',
        field: 'State',
        // The importer's PROJECT_STATE_* tables, label for label.
        options: [
          { label: 'Backlog', color: 'gray', category: 'backlog' },
          { label: 'Planned', color: 'blue', category: 'unstarted' },
          { label: 'In Progress', color: 'gold', category: 'started' },
          { label: 'Paused', color: 'orange', category: 'started' },
          { label: 'Completed', color: 'green', category: 'completed' },
          { label: 'Canceled', color: 'red', category: 'canceled' },
        ],
      },
      {
        database: 'Releases',
        field: 'Status',
        options: [
          { label: 'Planned', color: 'gray', category: 'unstarted' },
          { label: 'Released', color: 'green', category: 'completed' },
        ],
      },
    ],
    agents: [
      {
        name: 'Triage',
        goal: 'Read each new issue in Triage, suggest its Labels and Priority, and flag a likely duplicate.',
        instructions:
          'Suggest Labels (Bug, Feature or Improvement) and a Priority for each new issue, and say if it looks like a duplicate of an ' +
          'existing issue, naming it. Never change an issue’s State or Assignee. Your edits are held for a person to approve.',
        scopes: ['read', 'write'],
        approval_policy: ['outward'],
        target_databases: ['Issues'],
        // The agent asks before changing anything: its updates to Issues are held in the Approvals inbox (#1104).
        write_gates: [{ operations: ['update'], database: 'Issues' }],
        skills: [],
        // "StoryOS doesn't sell AI, bring yours": a built-in pack's agent runs on the owner's own AI (#1106).
        ai_mode: 'your_own_ai',
      },
    ],
    triggers: [{ agent: 'Triage', database: 'Issues', state_field: 'State', state_option: 'Triage', human_gate: true }],
    derived_fields: [],
    views: [
      {
        database: 'Issues',
        name: 'Active',
        type: 'board',
        // "The space opens here".
        default: true,
        config: {
          group_by_field_id: fieldRef('Issues', 'State'),
          // "Assignee and Priority show on every issue".
          card_field_ids: [fieldRef('Issues', 'Priority'), fieldRef('Issues', 'Assignee')],
          filters: {
            field: 'state',
            op: 'has',
            value: [optionRef('Issues', 'State', 'To Do'), optionRef('Issues', 'State', 'In Progress'), optionRef('Issues', 'State', 'In Review')],
          },
          hide_empty_no_value_group: true,
        },
      },
      {
        database: 'Issues',
        name: 'My issues',
        type: 'table',
        config: {
          group_by_field_id: fieldRef('Issues', 'State'),
          // `'me'` is resolved to whoever opens the view, so one shared view shows each person their own open issues.
          filters: {
            and: [
              { field: 'assignee', op: 'has', value: ['me'] },
              { field: 'state', op: 'has_none', value: [optionRef('Issues', 'State', 'Done'), optionRef('Issues', 'State', 'Canceled')] },
            ],
          },
        },
      },
      {
        database: 'Issues',
        name: 'Triage',
        type: 'table',
        config: {
          filters: { field: 'state', op: 'has', value: [optionRef('Issues', 'State', 'Triage')] },
          sorts: [{ field: 'created_at', direction: 'desc' }],
        },
      },
      {
        database: 'Projects',
        name: 'Projects',
        type: 'board',
        config: {
          group_by_field_id: fieldRef('Projects', 'State'),
          card_field_ids: [fieldRef('Projects', 'Lead'), fieldRef('Projects', 'Target date')],
        },
      },
    ],
    automations: [
      {
        database: 'Issues',
        name: 'Tell the assignee',
        trigger: { type: 'record_updated', field_id: fieldRef('Issues', 'Assignee') },
        // 'assignee' is the api_name of the person field: whoever the issue is now assigned to.
        actions: [{ type: 'notify_user', user: 'assignee', message: 'An issue was assigned to you.' }],
        enabled: true,
      },
      {
        // A rule has ONE trigger, and `record_updated` does not fire for an issue that is created already assigned, so the same job is
        // done by a second rule on `record_created`, with the condition "Assignee is not empty" (an unassigned new issue tells nobody).
        // The two triggers are disjoint (creation vs a later change), so one event never produces two notifications.
        database: 'Issues',
        name: 'Tell the assignee of a new issue',
        trigger: { type: 'record_created' },
        condition: { field: 'assignee', op: 'not_empty' },
        actions: [{ type: 'notify_user', user: 'assignee', message: 'An issue was assigned to you.' }],
        enabled: true,
      },
    ],
    // Four teaching cards: one in Triage, one each in To Do, In Progress and In Review (so Active is not empty), and the To Do one is
    // assigned to the installer (so My issues is not empty). Sample cards are seeded without running the rules: they notify nobody.
    sample_records: [
      { database: 'Issues', values: { name: 'Triage me: set a priority, then move me out of Triage', state: optionRef('Issues', 'State', 'Triage') } },
      { database: 'Issues', values: { name: 'Drag me to In Progress', state: optionRef('Issues', 'State', 'To Do'), assignee: SAMPLE_ME } },
      { database: 'Issues', values: { name: 'Open me and add a project', state: optionRef('Issues', 'State', 'In Progress') } },
      { database: 'Issues', values: { name: 'Move me to Done when you have checked me', state: optionRef('Issues', 'State', 'In Review') } },
    ],
    skills: [],
    suggested_sources: [],
  },
};
