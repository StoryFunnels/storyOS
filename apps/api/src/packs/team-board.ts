import { fieldRef, optionRef, SAMPLE_ME } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * ticket #1146 — Team Board: the pack for a team that wants one place to see who is doing what, in the first five minutes.
 * Built from the prototype's Team Board (the pack gallery card, its why/can lines, its "how it fits together" map and its install list),
 * and the wording below is that prototype's, not a rewrite of it.
 *
 * What is deliberately NOT here, because the prototype does not have it: a Status on Projects, any Labels options, an agent, a
 * second automation. The prototype's own install list names two views (Board, Assigned to me) and one automation; its gallery
 * count of "3 views" is not a third view this pack invents.
 *
 * Known limit: "Tell the assignee" fires when a task's Assignee is CHANGED (`record_updated` on that field). A task that is created
 * already assigned to someone does not notify them; that would take a second rule the prototype does not list.
 */
export const TEAM_BOARD_PACK: PackRegistryEntry = {
  slug: 'team-board',
  name: 'Team Board',
  summary:
    'A shared board your team works from on day one: To Do, In Progress, Done, with owners, due dates and labels already there.',
  highlights: [
    'Tasks: Status (To Do, In Progress, Done), Assignee, Due date, Labels, Project, Sub-tasks',
    'Projects: Owner, Target date, and every task that belongs to it',
    'A Board grouped by Status, and an Assigned to me view',
    'Tells the assignee when a task is assigned to them',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'team-board',
    name: 'Team Board',
    version: '1.0.0',
    why: 'Your team needs one place to see who is doing what this week.',
    can: [
      'Drag a task from To Do to Done, and everyone sees it move',
      'Open “Assigned to me” to see only your own work',
      'Assign a task and the person is told straight away',
    ],
    scenario: 'pack',
    summary:
      'A shared board your team works from on day one: To Do, In Progress, Done, with owners, due dates and labels already there.',
    requires: { connections: [], ai: 'none' },
    databases: [
      {
        action: 'create',
        name: 'Tasks',
        space: 'Team',
        fields: [
          { name: 'Assignee', type: 'user' },
          { name: 'Due date', type: 'date' },
          { name: 'Labels', type: 'multi_select' },
        ],
      },
      {
        action: 'create',
        name: 'Projects',
        space: 'Team',
        fields: [
          { name: 'Owner', type: 'user' },
          { name: 'Target date', type: 'date' },
        ],
      },
    ],
    relations: [
      // Every task belongs to a project; the Projects side collects its tasks ("and every task that belongs to it").
      { from: 'Tasks', to: 'Projects', cardinality: 'one_to_many', from_field: 'Project', to_field: 'Tasks' },
      // Sub-tasks: a task's parent is another task.
      { from: 'Tasks', to: 'Tasks', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
    ],
    states: [
      {
        database: 'Tasks',
        field: 'Status',
        options: [
          { label: 'To Do', color: 'blue', category: 'unstarted' },
          { label: 'In Progress', color: 'gold', category: 'started' },
          { label: 'Done', color: 'green', category: 'completed' },
        ],
      },
    ],
    agents: [],
    triggers: [],
    derived_fields: [],
    views: [
      {
        database: 'Tasks',
        name: 'Board',
        type: 'board',
        // "The space opens here": the database opens on the board, not on "All records".
        default: true,
        config: {
          group_by_field_id: fieldRef('Tasks', 'Status'),
          card_field_ids: [fieldRef('Tasks', 'Assignee'), fieldRef('Tasks', 'Due date'), fieldRef('Tasks', 'Labels')],
        },
      },
      {
        database: 'Tasks',
        name: 'Assigned to me',
        type: 'board',
        // `'me'` is resolved to whoever opens the view, so one shared view shows each teammate their own work.
        config: {
          group_by_field_id: fieldRef('Tasks', 'Status'),
          card_field_ids: [fieldRef('Tasks', 'Due date'), fieldRef('Tasks', 'Labels')],
          filters: { field: 'assignee', op: 'has', value: ['me'] },
        },
      },
    ],
    automations: [
      {
        database: 'Tasks',
        name: 'Tell the assignee',
        trigger: { type: 'record_updated', field_id: fieldRef('Tasks', 'Assignee') },
        // 'assignee' is the api_name of the person field: whoever the task is now assigned to.
        actions: [{ type: 'notify_user', user: 'assignee', message: 'A task was assigned to you.' }],
        enabled: true,
      },
    ],
    // Three teaching cards, all in To Do so the board is not empty and each shows one move. They are listed in the order they appear.
    sample_records: [
      { database: 'Tasks', values: { name: 'Drag me to In Progress', status: optionRef('Tasks', 'Status', 'To Do'), assignee: SAMPLE_ME } },
      { database: 'Tasks', values: { name: 'Open me and set a due date', status: optionRef('Tasks', 'Status', 'To Do') } },
      { database: 'Tasks', values: { name: 'Assign me to someone', status: optionRef('Tasks', 'Status', 'To Do') } },
    ],
    skills: [],
    suggested_sources: [],
  },
};
