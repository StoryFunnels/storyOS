import type { TemplateDef } from '../types';

/** People & Ops category (MN-062, MN-063) — from the template research. */

export const orgChart: TemplateDef = {
  slug: 'org-chart',
  name: 'Org Chart',
  description: 'Teams, people and reporting lines — the company directory that stays current.',
  category: 'people',
  scope: 'pack',
  space: 'People',
  guide: `## How this works

**Teams** group **Team Members**; every member links to a **Manager** (a self-relation on the same database), which is your reporting line. The Account field ties a directory entry to a real workspace user, so mentions and assignments connect.

## Keeping it current

- New joiner → one record: Role, Team, Manager, Started, Location.
- The **By team** board is the living org chart; **Managers** answers "who reports to whom" — open any manager and their reports are on the record.
- Offboarding: don't delete — clear the Team and note the end in the record; history stays intact.

## Tips

- A dedicated hierarchy view (real org-chart boxes) is on the roadmap; the manager relation you fill today will power it as-is.`,
  databases: [
    {
      key: 'teams',
      name: 'Teams', icon: '🏢',
      fields: [
        { key: 'department', display_name: 'Department', type: 'select', options: [
          { label: 'Delivery', color: 'blue' }, { label: 'Marketing', color: 'pink' }, { label: 'Sales', color: 'gold' },
          { label: 'Operations', color: 'teal' }, { label: 'Leadership', color: 'purple' },
        ]},
        { key: 'mission', display_name: 'Mission', type: 'text', config: { multiline: true } },
      ],
    },
    {
      key: 'members',
      name: 'Team Members', icon: '👤',
      fields: [
        { key: 'role', display_name: 'Role', type: 'text' },
        { key: 'location', display_name: 'Location', type: 'text' },
        { key: 'started', display_name: 'Started', type: 'date' },
        { key: 'email', display_name: 'Email', type: 'email' },
        { key: 'account', display_name: 'Account', type: 'user' },
      ],
    },
  ],
  relations: [
    { key: 'team_members', database_a: 'members', database_b: 'teams', cardinality: 'one_to_many', field_a_name: 'Team', field_b_name: 'Members' },
    { key: 'manager', database_a: 'members', database_b: 'members', cardinality: 'one_to_many', field_a_name: 'Manager', field_b_name: 'Reports' },
  ],
  views: [
    { database: 'members', name: 'Directory', type: 'table', sorts: [{ field: 'started', direction: 'desc' }] },
    { database: 'teams', name: 'Teams', type: 'table' },
  ],
  records: [
    { key: 't1', database: 'teams', values: { name: 'Delivery (sample)', department: 'Delivery', mission: 'Ship client work on time, every time.' } },
    { key: 'p1', database: 'members', values: { name: 'Ievgen K (sample)', role: 'Founder', location: 'Kyiv', account: '@me' }, links: [{ relation: 'team_members', to: 't1' }] },
    { database: 'members', values: { name: 'Max R (sample)', role: 'Producer', location: 'Warsaw' }, links: [{ relation: 'team_members', to: 't1' }, { relation: 'manager', to: 'p1' }] },
  ],
};

export const timeOff: TemplateDef = {
  slug: 'time-off',
  name: 'Time Off',
  description: 'Vacations, sick leave and overtime — who is out, when, and is it approved.',
  category: 'people',
  scope: 'pack',
  space: 'Time Off',
  guide: `## How this works

**Team Members** hold each person's annual allocation; **Time Off** records one absence each (kind, start, end, days); **Public Holidays** keep the calendar honest.

## The flow

- Requesting = creating a Time Off record with Kind, Start, End and Days.
- Approving = the manager ticking **Approved** (watch the Pending approval view).
- The **Who's out** calendar is the team's availability at a glance — check it before scheduling anything.

## Tips

- Automatic balance: add a Rollup field **Days Used** (sum of Days through the Time Off relation) on Team Members, then a Formula **Balance** = \`{Annual Allocation (days)} - {Days Used}\`.
- Log overtime as its own Kind — compensate it consciously instead of losing it.`,
  databases: [
    {
      key: 'members',
      name: 'Team Members', icon: '👤',
      fields: [
        { key: 'allocation', display_name: 'Annual Allocation (days)', type: 'number' },
        { key: 'country', display_name: 'Country', type: 'text' },
        { key: 'account', display_name: 'Account', type: 'user' },
      ],
    },
    {
      key: 'timeoff',
      name: 'Time Off', icon: '🌴',
      fields: [
        { key: 'kind', display_name: 'Kind', type: 'select', options: [
          { label: 'Vacation', color: 'green' }, { label: 'Sick', color: 'red' },
          { label: 'Overtime comp', color: 'purple' }, { label: 'Unpaid', color: 'gray' },
        ]},
        { key: 'start', display_name: 'Start', type: 'date' },
        { key: 'end', display_name: 'End', type: 'date' },
        { key: 'days', display_name: 'Days', type: 'number' },
        { key: 'approved', display_name: 'Approved', type: 'checkbox' },
        { key: 'notes', display_name: 'Notes', type: 'text' },
      ],
    },
    {
      key: 'holidays',
      name: 'Public Holidays', icon: '📅',
      fields: [
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'country', display_name: 'Country', type: 'text' },
      ],
    },
  ],
  relations: [
    { key: 'member_timeoff', database_a: 'timeoff', database_b: 'members', cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off' },
  ],
  views: [
    { database: 'timeoff', name: "Who's out", type: 'calendar', date_field: 'start' },
    { database: 'timeoff', name: 'Pending approval', type: 'table', filters: [{ field: 'approved', op: 'eq', value: false }] },
    { database: 'timeoff', name: 'This month', type: 'table', filters: [{ field: 'start', op: 'within', value: 'this_month' }] },
    { database: 'holidays', name: 'Holidays', type: 'table', sorts: [{ field: 'date', direction: 'asc' }] },
  ],
  records: [
    { key: 'me1', database: 'members', values: { name: 'Ievgen K (sample)', allocation: 24, country: 'UA', account: '@me' } },
    { database: 'timeoff', values: { name: 'Summer break (sample)', kind: 'Vacation', days: 5 }, links: [{ relation: 'member_timeoff', to: 'me1' }] },
    { database: 'holidays', values: { name: 'Independence Day (sample)', country: 'UA' } },
  ],
};
