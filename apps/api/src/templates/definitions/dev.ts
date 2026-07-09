import { taskDnaDatabase, taskDnaRelations, taskDnaViews } from '../task-dna';
import type { TemplateDef } from '../types';

/** Dev category: the wedge is dev work living NEXT TO content, clients, funnels. */

const issueDna = () =>
  taskDnaDatabase({
    key: 'issues',
    name: 'Issues',
    labels: ['bug', 'feature', 'chore', 'docs', 'design', 'tech-debt', 'good-first-issue'],
    extraFields: [
      {
        key: 'type',
        display_name: 'Type',
        type: 'select',
        options: [
          { label: 'Bug', color: 'red' },
          { label: 'Feature', color: 'blue' },
          { label: 'Improvement', color: 'teal' },
          { label: 'Chore', color: 'gray' },
        ],
      },
    ],
  });

export const devProject: TemplateDef = {
  slug: 'dev-project',
  name: 'Dev Project',
  description: 'Issues with a Triage inbox, lightweight sprints, releases with changelogs, and specs.',
  category: 'dev',
  scope: 'pack',
  space: 'Product',
    guide: `## How this works

The Linear model, self-hosted: **Issues** with full task DNA (Triage → Backlog → To Do → In Progress → In Review → Done/Canceled, priorities, labels, sub-issues, blockers), **Sprints**, **Releases** with changelogs, and **Product Docs** for specs and ADRs.

## The loop

- Everything lands in **Triage**; sweep it daily.
- Sprint planning: drag from Backlog into the sprint; the Issue Board is standup.
- Ship: link issues to a Release; the release page is the changelog.`,
  databases: [
    issueDna(),
    {
      key: 'sprints',
      name: 'Sprints', icon: '🏃',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Planned', color: 'gray' }, { label: 'Active', color: 'green' }, { label: 'Done', color: 'brown' },
        ]},
        { key: 'start', display_name: 'Start Date', type: 'date' },
        { key: 'end', display_name: 'End Date', type: 'date' },
        { key: 'goal', display_name: 'Goal', type: 'text' },
        { key: 'velocity', display_name: 'Velocity (pts)', type: 'number' },
      ],
    },
    {
      key: 'releases',
      name: 'Releases', icon: '🚀',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Planned', color: 'gray' }, { label: 'In Progress', color: 'gold' }, { label: 'Released', color: 'green' },
        ]},
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
    {
      key: 'docs',
      name: 'Product Docs', icon: '📚',
      fields: [
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Spec' }, { label: 'Decision (ADR)' }, { label: 'Runbook' }, { label: 'Idea' },
        ]},
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Draft', color: 'gray' }, { label: 'Agreed', color: 'green' }, { label: 'Superseded', color: 'brown' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
      ],
    },
  ],
  relations: [
    { key: 'issue_sprint', database_a: 'issues', database_b: 'sprints', cardinality: 'one_to_many', field_a_name: 'Sprint', field_b_name: 'Issues' },
    { key: 'issue_release', database_a: 'issues', database_b: 'releases', cardinality: 'one_to_many', field_a_name: 'Release', field_b_name: 'Issues' },
    { key: 'doc_issues', database_a: 'docs', database_b: 'issues', cardinality: 'many_to_many', field_a_name: 'Issues', field_b_name: 'Docs' },
    ...taskDnaRelations('issues'),
  ],
  views: [
    ...taskDnaViews('issues', 'Issue Board'),
    { database: 'issues', name: 'Bugs', type: 'table', filters: [{ field: 'type', op: 'has', values: ['Bug'] }] },
    { database: 'releases', name: 'Release Board', type: 'board', group_by_field: 'status' },
    { database: 'docs', name: 'Open Specs', type: 'table', filters: [{ field: 'status', op: 'has', values: ['Draft'] }] },
  ],
  records: [
    { key: 'sprint', database: 'sprints', values: { name: 'Sprint 12 (sample)', status: 'Active', goal: 'Ship the sharing flow' } },
    { key: 'rel', database: 'releases', values: { name: 'v1.4.0 (sample)', status: 'In Progress' } },
    { key: 'i1', database: 'issues', values: { name: 'Share dialog loses focus (sample)', state: 'In Progress', type: 'Bug', priority: 'High', labels: ['bug'], assignee: '@me', estimate: 3 }, links: [{ relation: 'issue_sprint', to: 'sprint' }, { relation: 'issue_release', to: 'rel' }] },
    { database: 'issues', values: { name: 'Add keyboard shortcuts (sample)', state: 'Triage', type: 'Feature', labels: ['feature'] } },
    { database: 'issues', values: { name: 'Fix flaky auth test (sample)', state: 'Backlog', type: 'Chore', labels: ['tech-debt'] }, links: [{ relation: 'issues_blocked', to: 'i1' }] },
    { database: 'issues', values: { name: 'Write sharing docs (sample)', state: 'To Do', type: 'Improvement', labels: ['docs'] }, links: [{ relation: 'issue_release', to: 'rel' }] },
    { database: 'docs', values: { name: 'Sharing model spec (sample)', type: 'Spec', status: 'Agreed' }, links: [{ relation: 'doc_issues', to: 'i1' }] },
  ],
};

export const soloDev: TemplateDef = {
  slug: 'solo-dev',
  name: 'Solo Dev',
  description: 'Issues + releases, zero ceremony — for shipping on vibes and a changelog.',
  category: 'dev',
  scope: 'pack',
  space: 'Product',
    guide: `## How this works

Issues + Releases, zero ceremony. Triage catches ideas, the board runs the day, the **Changelog** view (Releases by date) is your public history.`,
  databases: [
    taskDnaDatabase({
      key: 'issues',
      name: 'Issues',
      labels: ['bug', 'feature', 'chore', 'idea'],
    }),
    {
      key: 'releases',
      name: 'Releases', icon: '🚀',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Planned', color: 'gray' }, { label: 'In Progress', color: 'gold' }, { label: 'Released', color: 'green' },
        ]},
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
  ],
  relations: [
    { key: 'issue_release', database_a: 'issues', database_b: 'releases', cardinality: 'one_to_many', field_a_name: 'Release', field_b_name: 'Issues' },
    ...taskDnaRelations('issues'),
  ],
  views: [
    ...taskDnaViews('issues', 'Board'),
    { database: 'releases', name: 'Changelog', type: 'table', sorts: [{ field: 'date', direction: 'desc' }] },
  ],
  records: [
    { key: 'rel', database: 'releases', values: { name: 'v0.2.0 (sample)', status: 'Planned' } },
    { database: 'issues', values: { name: 'Dark mode (sample)', state: 'Triage', labels: ['feature'] } },
    { database: 'issues', values: { name: 'Fix onboarding crash (sample)', state: 'In Progress', priority: 'Urgent', labels: ['bug'], assignee: '@me' }, links: [{ relation: 'issue_release', to: 'rel' }] },
  ],
};
