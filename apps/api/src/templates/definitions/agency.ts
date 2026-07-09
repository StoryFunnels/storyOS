import { taskDnaDatabase, taskDnaRelations, taskDnaViews } from '../task-dna';
import type { TemplateDef } from '../types';

/** Agency category — docs/product/template-library.md v2. Generous fields by design. */

export const clientWork: TemplateDef = {
  slug: 'client-work',
  name: 'Client Projects & Tasks',
  description: 'Clients, contacts, projects and a Linear-grade task system — the agency backbone.',
  category: 'agency',
  scope: 'pack',
  space: 'Client Work',
    guide: `## How this works

**Clients** anchor everything; **Projects** belong to a client; **Tasks** carry the daily work with the full Linear-style DNA (states, priorities, labels, sub-tasks, blockers). **Contacts** keep the humans attached to their companies.

## The loop

- New engagement: Client → Project → break into Tasks on the Task Board.
- Daily: everyone lives in **My Tasks**; the **Triage** view catches unsorted intake.
- Client health: update the Health field on Clients weekly — the Health board is the account review.`,
  databases: [
    {
      key: 'clients',
      name: 'Clients', icon: '🤝',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Lead', color: 'gray' }, { label: 'Onboarding', color: 'blue' },
          { label: 'Active', color: 'green' }, { label: 'Paused', color: 'gold' },
          { label: 'Churned', color: 'brown' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'industry', display_name: 'Industry', type: 'select', options: [
          { label: 'SaaS' }, { label: 'E-commerce' }, { label: 'Publishing' },
          { label: 'Coaching' }, { label: 'Local business' }, { label: 'Other' },
        ]},
        { key: 'size', display_name: 'Company Size', type: 'select', options: [
          { label: 'Solo' }, { label: '2–10' }, { label: '11–50' }, { label: '50+' },
        ]},
        { key: 'website', display_name: 'Website', type: 'url' },
        { key: 'email', display_name: 'Contact Email', type: 'email' },
        { key: 'phone', display_name: 'Phone', type: 'text' },
        { key: 'linkedin', display_name: 'LinkedIn', type: 'url' },
        { key: 'mrr', display_name: 'Monthly Value', type: 'number', config: { format: 'currency' } },
        { key: 'since', display_name: 'Client Since', type: 'date' },
        { key: 'health', display_name: 'Health', type: 'select', options: [
          { label: 'Great', color: 'green' }, { label: 'OK', color: 'blue' },
          { label: 'At risk', color: 'orange' }, { label: 'On fire', color: 'red' },
        ]},
        { key: 'source', display_name: 'Referral Source', type: 'text' },
      ],
    },
    {
      key: 'contacts',
      name: 'Contacts', icon: '👥',
      fields: [
        { key: 'role', display_name: 'Role', type: 'text' },
        { key: 'email', display_name: 'Email', type: 'email' },
        { key: 'phone', display_name: 'Phone', type: 'text' },
        { key: 'linkedin', display_name: 'LinkedIn', type: 'url' },
        { key: 'timezone', display_name: 'Timezone', type: 'text' },
        { key: 'decision_maker', display_name: 'Is Decision Maker', type: 'checkbox' },
        { key: 'birthday', display_name: 'Birthday', type: 'date' },
      ],
    },
    {
      key: 'projects',
      name: 'Projects', icon: '🗺️',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Scoping', color: 'gray' }, { label: 'Planning', color: 'blue' },
          { label: 'Active', color: 'green' }, { label: 'On Hold', color: 'gold' },
          { label: 'Delivered', color: 'teal' }, { label: 'Closed', color: 'brown' },
        ]},
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Retainer' }, { label: 'One-off' }, { label: 'Sprint' }, { label: 'Maintenance' },
        ]},
        { key: 'lead', display_name: 'Lead', type: 'user' },
        { key: 'team', display_name: 'Team', type: 'user', config: { multi: true } },
        { key: 'priority', display_name: 'Priority', type: 'select', options: [
          { label: 'Urgent', color: 'red' }, { label: 'High', color: 'orange' },
          { label: 'Medium', color: 'blue' }, { label: 'Low', color: 'gray' },
        ]},
        { key: 'start', display_name: 'Start Date', type: 'date' },
        { key: 'due', display_name: 'Due Date', type: 'date' },
        { key: 'budget', display_name: 'Budget', type: 'number', config: { format: 'currency' } },
        { key: 'billed', display_name: 'Billed', type: 'number', config: { format: 'currency' } },
      ],
    },
    taskDnaDatabase({
      key: 'tasks',
      name: 'Tasks',
      labels: ['design', 'copy', 'dev', 'ads', 'email', 'strategy', 'admin', 'client-waiting', 'internal'],
    }),
  ],
  relations: [
    { key: 'contact_client', database_a: 'contacts', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Contacts' },
    { key: 'project_client', database_a: 'projects', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Projects' },
    { key: 'task_project', database_a: 'tasks', database_b: 'projects', cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Tasks' },
    ...taskDnaRelations('tasks'),
  ],
  views: [
    { database: 'clients', name: 'Active Clients', type: 'table', filters: [{ field: 'status', op: 'has', values: ['Active', 'Onboarding'] }] },
    { database: 'clients', name: 'Health Board', type: 'board', group_by_field: 'health' },
    { database: 'projects', name: 'Projects Board', type: 'board', group_by_field: 'status' },
    { database: 'projects', name: 'By Due Date', type: 'table', sorts: [{ field: 'due', direction: 'asc' }] },
    ...taskDnaViews('tasks', 'Task Board'),
  ],
  records: [
    { key: 'jcm', database: 'clients', values: { name: 'JCM (sample)', status: 'Active', health: 'Great', industry: 'Publishing' } },
    { key: 'acme', database: 'clients', values: { name: 'Acme Co (sample)', status: 'Onboarding', health: 'OK', industry: 'SaaS' } },
    { database: 'contacts', values: { name: 'Jane Doe (sample)', role: 'Marketing Director', decision_maker: true }, links: [{ relation: 'contact_client', to: 'jcm' }] },
    { key: 'p1', database: 'projects', values: { name: 'Website refresh (sample)', status: 'Active', type: 'Sprint', priority: 'High' }, links: [{ relation: 'project_client', to: 'jcm' }] },
    { key: 'p2', database: 'projects', values: { name: 'Onboarding funnel (sample)', status: 'Planning', type: 'Retainer' }, links: [{ relation: 'project_client', to: 'acme' }] },
    { key: 't1', database: 'tasks', values: { name: 'Wireframe landing page (sample)', state: 'In Progress', priority: 'High', labels: ['design'], assignee: '@me', estimate: 5 }, links: [{ relation: 'task_project', to: 'p1' }] },
    { database: 'tasks', values: { name: 'Design hero section (sample)', state: 'To Do', priority: 'Medium', labels: ['design'] }, links: [{ relation: 'task_project', to: 'p1' }, { relation: 'tasks_parent', to: 't1' }] },
    { database: 'tasks', values: { name: 'Write homepage copy (sample)', state: 'Triage', labels: ['copy'] }, links: [{ relation: 'task_project', to: 'p1' }] },
    { database: 'tasks', values: { name: 'Kickoff checklist (sample)', state: 'Done', priority: 'Medium', labels: ['admin'], assignee: '@me' }, links: [{ relation: 'task_project', to: 'p2' }] },
    { database: 'tasks', values: { name: 'Waiting: brand assets from client (sample)', state: 'Backlog', labels: ['client-waiting'] }, links: [{ relation: 'task_project', to: 'p2' }] },
  ],
};

export const clientSpace: TemplateDef = {
  slug: 'client-space',
  name: 'Client Space',
  description: 'A per-client space you share with the client — tasks, deliverables, meetings, requests.',
  category: 'agency',
  scope: 'pack',
  space: 'New Client', // renamed at install from the intent's name prompt
    guide: `## How this works

This is the space you SHARE with a client (invite them as a guest with **editor** access — they work, they just can't touch structure). **Tasks** with a Client Approval state, **Deliverables**, **Meetings** and **Requests** for their asks.

## The loop

- Client requests come into **Requests**; you convert accepted ones into Tasks.
- Deliverables move to Client Approval; the client flips them from their side.
- Meeting notes live in Meetings — shared memory beats email threads.`,
  databases: [
    taskDnaDatabase({
      key: 'tasks',
      name: 'Tasks',
      labels: ['for-client', 'waiting-on-client', 'in-house'],
      withEstimates: false,
      extraFields: [
        { key: 'approval', display_name: 'Client Approval', type: 'select', options: [
          { label: 'Not needed', color: 'gray' }, { label: 'Waiting', color: 'gold' },
          { label: 'Approved', color: 'green' }, { label: 'Changes requested', color: 'red' },
        ]},
      ],
    }),
    {
      key: 'deliverables',
      name: 'Deliverables', icon: '📦',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Draft', color: 'gray' }, { label: 'In Review', color: 'gold' },
          { label: 'Approved', color: 'green' }, { label: 'Delivered', color: 'teal' },
        ]},
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Design' }, { label: 'Document' }, { label: 'Video' },
          { label: 'Campaign' }, { label: 'Website' }, { label: 'Report' },
        ]},
        { key: 'due', display_name: 'Due Date', type: 'date' },
        { key: 'link', display_name: 'Link', type: 'url' },
        { key: 'version', display_name: 'Version', type: 'number' },
      ],
    },
    {
      key: 'meetings',
      name: 'Meetings', icon: '☕',
      fields: [
        { key: 'date', display_name: 'Date', type: 'date', config: { include_time: true } },
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Kickoff' }, { label: 'Weekly' }, { label: 'Review' }, { label: 'Ad-hoc' },
        ]},
        { key: 'attendees', display_name: 'Attendees', type: 'user', config: { multi: true } },
        { key: 'recording', display_name: 'Recording', type: 'url' },
      ],
    },
    {
      key: 'requests',
      name: 'Requests', icon: '💬',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'New', color: 'blue' }, { label: 'Accepted', color: 'green' },
          { label: 'Declined', color: 'brown' }, { label: 'Done', color: 'teal' },
        ]},
        { key: 'requested_by', display_name: 'Requested By', type: 'text' },
        { key: 'requested_on', display_name: 'Requested On', type: 'date' },
      ],
    },
  ],
  relations: [
    ...taskDnaRelations('tasks'),
    { key: 'deliverable_tasks', database_a: 'tasks', database_b: 'deliverables', cardinality: 'one_to_many', field_a_name: 'Deliverable', field_b_name: 'Tasks' },
    { key: 'meeting_tasks', database_a: 'tasks', database_b: 'meetings', cardinality: 'one_to_many', field_a_name: 'From meeting', field_b_name: 'Action items' },
    { key: 'request_task', database_a: 'requests', database_b: 'tasks', cardinality: 'one_to_many', field_a_name: 'Task', field_b_name: 'Requests' },
  ],
  views: [
    { database: 'tasks', name: 'Shared Board', type: 'board', group_by_field: 'state' },
    { database: 'tasks', name: 'Waiting on Client', type: 'table', filters: [{ field: 'labels', op: 'has', values: ['waiting-on-client'] }] },
    { database: 'tasks', name: 'Needs Approval', type: 'table', filters: [{ field: 'approval', op: 'has', values: ['Waiting'] }] },
    { database: 'deliverables', name: 'Delivery Board', type: 'board', group_by_field: 'status' },
    { database: 'meetings', name: 'Upcoming', type: 'table', filters: [{ field: 'date', op: 'within', value: 'next_7_days' }], sorts: [{ field: 'date', direction: 'asc' }] },
    { database: 'meetings', name: 'Meeting Calendar', type: 'calendar', date_field: 'date' },
    { database: 'requests', name: 'Request Board', type: 'board', group_by_field: 'status' },
  ],
  records: [
    { key: 'm1', database: 'meetings', values: { name: 'Kickoff call (sample)', type: 'Kickoff' } },
    { key: 'd1', database: 'deliverables', values: { name: 'Brand guideline v1 (sample)', status: 'In Review', type: 'Document', version: 1 } },
    { key: 't1', database: 'tasks', values: { name: 'Collect brand assets (sample)', state: 'In Progress', labels: ['waiting-on-client'], approval: 'Not needed' }, links: [{ relation: 'meeting_tasks', to: 'm1' }] },
    { database: 'tasks', values: { name: 'Review the guideline draft (sample)', state: 'To Do', labels: ['for-client'], approval: 'Waiting' }, links: [{ relation: 'deliverable_tasks', to: 'd1' }] },
    { database: 'requests', values: { name: 'Add a pricing page (sample)', status: 'New', requested_by: 'Client via email' } },
  ],
};

export const agencyCrm: TemplateDef = {
  slug: 'agency-crm',
  name: 'Agency CRM',
  description: 'Lead pipeline with proposals — the board where the money happens.',
  category: 'agency',
  scope: 'pack',
  space: 'Sales',
    guide: `## How this works

A light pipeline: **Leads** move through stages; **Proposals** track what you sent and for how much. For the fuller Accounts/Contacts/Opportunities model, install **Sales CRM** instead.`,
  databases: [
    {
      key: 'leads',
      name: 'Leads', icon: '🧲',
      fields: [
        { key: 'stage', display_name: 'Stage', type: 'select', options: [
          { label: 'New', color: 'gray' }, { label: 'Contacted', color: 'blue' },
          { label: 'Call Booked', color: 'purple' }, { label: 'Proposal Sent', color: 'gold' },
          { label: 'Negotiating', color: 'orange' }, { label: 'Won', color: 'green' },
          { label: 'Lost', color: 'brown' },
        ]},
        { key: 'value', display_name: 'Deal Value', type: 'number', config: { format: 'currency' } },
        { key: 'probability', display_name: 'Probability', type: 'select', options: [
          { label: '10%' }, { label: '25%' }, { label: '50%' }, { label: '75%' }, { label: '90%' },
        ]},
        { key: 'source', display_name: 'Source', type: 'select', options: [
          { label: 'Referral' }, { label: 'Inbound' }, { label: 'Outbound' }, { label: 'Event' }, { label: 'Partner' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'company', display_name: 'Company', type: 'text' },
        { key: 'email', display_name: 'Contact Email', type: 'email' },
        { key: 'phone', display_name: 'Phone', type: 'text' },
        { key: 'website', display_name: 'Website', type: 'url' },
        { key: 'next_step', display_name: 'Next Step', type: 'text' },
        { key: 'next_step_date', display_name: 'Next Step Date', type: 'date' },
        { key: 'lost_reason', display_name: 'Lost Reason', type: 'select', options: [
          { label: 'Budget' }, { label: 'Timing' }, { label: 'Competitor' }, { label: 'Ghosted' }, { label: 'Bad fit' },
        ]},
      ],
    },
    {
      key: 'proposals',
      name: 'Proposals', icon: '🧾',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Draft', color: 'gray' }, { label: 'Internal Review', color: 'purple' },
          { label: 'Sent', color: 'gold' }, { label: 'Won', color: 'green' }, { label: 'Lost', color: 'brown' },
        ]},
        { key: 'value', display_name: 'Value', type: 'number', config: { format: 'currency' } },
        { key: 'sent', display_name: 'Sent Date', type: 'date' },
        { key: 'valid_until', display_name: 'Valid Until', type: 'date' },
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
  ],
  relations: [
    { key: 'proposal_lead', database_a: 'proposals', database_b: 'leads', cardinality: 'one_to_many', field_a_name: 'Lead', field_b_name: 'Proposals' },
  ],
  views: [
    { database: 'leads', name: 'Pipeline Board', type: 'board', group_by_field: 'stage' },
    { database: 'leads', name: 'Follow-ups Due', type: 'table', filters: [{ field: 'next_step_date', op: 'within', value: 'next_7_days' }], sorts: [{ field: 'next_step_date', direction: 'asc' }] },
    { database: 'leads', name: 'Won', type: 'table', filters: [{ field: 'stage', op: 'has', values: ['Won'] }] },
    { database: 'proposals', name: 'Proposal Board', type: 'board', group_by_field: 'status' },
  ],
  records: [
    { key: 'l1', database: 'leads', values: { name: 'Bluewater Publishing (sample)', stage: 'Proposal Sent', value: 12000, probability: '75%', source: 'Referral', company: 'Bluewater', next_step: 'Follow up on proposal' } },
    { database: 'leads', values: { name: 'Nordic Coaching Co (sample)', stage: 'Call Booked', value: 4500, source: 'Inbound' } },
    { database: 'leads', values: { name: 'Lost example (sample)', stage: 'Lost', lost_reason: 'Timing' } },
    { database: 'proposals', values: { name: 'Bluewater — funnel build (sample)', status: 'Sent', value: 12000 }, links: [{ relation: 'proposal_lead', to: 'l1' }] },
  ],
};

export const socialCalendar: TemplateDef = {
  slug: 'social-calendar',
  name: 'Social Media Calendar',
  description: 'Plan posts around calendar moments, across platforms, with an approval flow.',
  category: 'agency',
  scope: 'pack',
  space: 'Social',
  guide: `## How this works

**Posts** carry the content and the approval flow; **Moments** are the dates that matter (launches, holidays, awareness days) that posts hang on; **Platforms** hold each channel's specs and links (image sizes, character limits) so nobody googles them twice.

## The loop

- Quarterly: fill Moments first — they are the skeleton of the calendar.
- Weekly: create Posts against the next two weeks of Moments; move them Idea → Drafted → Approved → Scheduled → Published on the board.
- The **Content Calendar** view (by publish date) is the source of truth for what goes out when.

## Tips

- The Channel multi-select is for quick filtering; the Platforms relation is for specs — use both.
- Posts link to Articles when the Content Pipeline pack is installed (auto-wired cross-pack).`,
  databases: [
    {
      key: 'posts',
      name: 'Posts', icon: '📅',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Idea', color: 'gray' }, { label: 'Drafted', color: 'blue' },
          { label: 'Approved', color: 'purple' }, { label: 'Scheduled', color: 'gold' },
          { label: 'Published', color: 'green' },
        ]},
        { key: 'channel', display_name: 'Channel', type: 'multi_select', options: [
          { label: 'LinkedIn', color: 'blue' }, { label: 'X', color: 'gray' },
          { label: 'Instagram', color: 'pink' }, { label: 'YouTube', color: 'red' },
          { label: 'TikTok', color: 'purple' }, { label: 'Facebook', color: 'blue' },
        ]},
        { key: 'format', display_name: 'Format', type: 'select', options: [
          { label: 'Text' }, { label: 'Carousel' }, { label: 'Image' }, { label: 'Video' }, { label: 'Story' },
        ]},
        { key: 'publish', display_name: 'Publish Date', type: 'date', config: { include_time: true } },
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'hook', display_name: 'Hook', type: 'text' },
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
    {
      key: 'moments',
      name: 'Moments', icon: '📌',
      fields: [
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'kind', display_name: 'Kind', type: 'select', options: [
          { label: 'Launch', color: 'gold' }, { label: 'Holiday', color: 'green' },
          { label: 'Awareness Day', color: 'blue' }, { label: 'Season', color: 'teal' },
        ]},
        { key: 'notes', display_name: 'Notes', type: 'text', config: { multiline: true } },
      ],
    },
    {
      key: 'platforms',
      name: 'Platforms', icon: '📣',
      fields: [
        { key: 'handle', display_name: 'Profile URL', type: 'url' },
        { key: 'specs', display_name: 'Specs & Limits', type: 'rich_text' },
      ],
    },
  ],
  relations: [
    { key: 'post_article', database_a: 'posts', external_target_name: 'Articles', cardinality: 'one_to_many', field_a_name: 'Article', field_b_name: 'Posts' },
    { key: 'post_moment', database_a: 'posts', database_b: 'moments', cardinality: 'one_to_many', field_a_name: 'Moment', field_b_name: 'Posts' },
    { key: 'post_platforms', database_a: 'posts', database_b: 'platforms', cardinality: 'many_to_many', field_a_name: 'Platforms', field_b_name: 'Posts' },
  ],
  views: [
    { database: 'posts', name: 'Post Board', type: 'board', group_by_field: 'status' },
    { database: 'posts', name: 'Content Calendar', type: 'calendar', date_field: 'publish' },
    { database: 'posts', name: 'This Week', type: 'table', filters: [{ field: 'publish', op: 'within', value: 'next_7_days' }], sorts: [{ field: 'publish', direction: 'asc' }] },
    { database: 'moments', name: 'Moments calendar', type: 'calendar', date_field: 'date' },
  ],
  records: [
    { database: 'posts', values: { name: 'Why stories beat pitches (sample)', status: 'Drafted', channel: ['LinkedIn'], format: 'Text', hook: 'Your pitch is forgettable. Your story is not.' } },
    { database: 'posts', values: { name: 'Behind the scenes carousel (sample)', status: 'Idea', channel: ['Instagram', 'LinkedIn'], format: 'Carousel' } },
    { database: 'posts', values: { name: 'Client win announcement (sample)', status: 'Published', channel: ['LinkedIn', 'X'], format: 'Image' } },
    { database: 'moments', values: { name: 'Product launch (sample)', kind: 'Launch' } },
    { database: 'platforms', values: { name: 'LinkedIn (sample)' } },
  ],
};

export const funnels: TemplateDef = {
  slug: 'funnels',
  name: 'Funnels',
  description: 'Track marketing funnels with real numbers — opt-ins, conversions, revenue.',
  category: 'agency',
  scope: 'database',
    guide: `## How this works

One database, rich fields: each **Funnel** carries its type, live URL, traffic sources and the numbers that matter (visitors, opt-in %, conversion %, revenue). Installs into an existing space; links to Clients automatically when the Client Work pack is present.

## The loop

Update the numbers monthly; the **Live Funnels** view sorted by revenue is the portfolio review.`,
  databases: [
    {
      key: 'funnels',
      name: 'Funnels', icon: '🌊',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Idea', color: 'gray' }, { label: 'Building', color: 'gold' },
          { label: 'Testing', color: 'purple' }, { label: 'Live', color: 'green' },
          { label: 'Paused', color: 'orange' }, { label: 'Archived', color: 'brown' },
        ]},
        { key: 'type', display_name: 'Funnel Type', type: 'select', options: [
          { label: 'Webinar', color: 'purple' }, { label: 'VSL', color: 'red' },
          { label: 'Lead Magnet', color: 'blue' }, { label: 'Book Launch', color: 'gold' },
          { label: 'Evergreen', color: 'green' }, { label: 'Challenge', color: 'teal' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'launch', display_name: 'Launch Date', type: 'date' },
        { key: 'url', display_name: 'Funnel URL', type: 'url' },
        { key: 'traffic', display_name: 'Traffic Source', type: 'multi_select', options: [
          { label: 'Ads' }, { label: 'Organic' }, { label: 'Email' }, { label: 'Partner' },
        ]},
        { key: 'visitors', display_name: 'Visitors /mo', type: 'number' },
        { key: 'optin', display_name: 'Opt-in %', type: 'number', config: { format: 'percent' } },
        { key: 'conversion', display_name: 'Conversion %', type: 'number', config: { format: 'percent' } },
        { key: 'revenue', display_name: 'Revenue /mo', type: 'number', config: { format: 'currency' } },
      ],
    },
  ],
  relations: [
    { key: 'funnel_client', database_a: 'funnels', external_target_name: 'Clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Funnels' },
  ],
  views: [
    { database: 'funnels', name: 'Funnel Board', type: 'board', group_by_field: 'status' },
    { database: 'funnels', name: 'Live Funnels', type: 'table', filters: [{ field: 'status', op: 'has', values: ['Live'] }], sorts: [{ field: 'revenue', direction: 'desc' }] },
  ],
  records: [
    { database: 'funnels', values: { name: 'Webinar funnel (sample)', status: 'Live', type: 'Webinar', visitors: 3200, optin: 34, conversion: 4.2, revenue: 18500 } },
    { database: 'funnels', values: { name: 'Lead magnet — checklist (sample)', status: 'Building', type: 'Lead Magnet' } },
  ],
};

export const contentPipeline: TemplateDef = {
  slug: 'content-pipeline',
  name: 'Content Pipeline',
  description: 'Ideas rated, articles through an editorial board, organized by topic clusters.',
  category: 'agency',
  scope: 'pack',
  space: 'Content',
  guide: `## How this works

**Articles** flow Idea → Brief → Writing → Editing → Design → Ready → Published on the Editorial Board. **Topics** are your SEO clusters — articles link to them many-to-many. **Campaigns** group content pushes.

## The loop

- Capture every idea as an Article at Idea stage; score it with **Idea Rating** (1-5) — review the *Ideas to rate* view weekly and promote the winners to Brief.
- Draft in the rich-text **Draft** section right on the article; editors comment there.
- Watch the *By writer* board for overload before assigning.
- On publish: fill URL + Published Date; the article stays as the permanent content record.

## Tips

- Topics with Now priority and no linked articles = your gap list.
- Word count + primary keyword make the SEO retro possible later.`,
  databases: [
    {
      key: 'articles',
      name: 'Articles', icon: '📰',
      fields: [
        { key: 'stage', display_name: 'Stage', type: 'select', options: [
          { label: 'Idea', color: 'gray' }, { label: 'Brief', color: 'blue' },
          { label: 'Writing', color: 'gold' }, { label: 'Editing', color: 'purple' },
          { label: 'Design', color: 'pink' }, { label: 'Ready', color: 'teal' },
          { label: 'Published', color: 'green' },
        ]},
        { key: 'type', display_name: 'Content Type', type: 'select', options: [
          { label: 'Blog post' }, { label: 'Newsletter' }, { label: 'Case study' },
          { label: 'Landing page' }, { label: 'Video script' }, { label: 'Podcast notes' },
        ]},
        { key: 'author', display_name: 'Author', type: 'user' },
        { key: 'editor', display_name: 'Editor', type: 'user' },
        { key: 'target_date', display_name: 'Target Publish Date', type: 'date' },
        { key: 'published_date', display_name: 'Published Date', type: 'date' },
        { key: 'keyword', display_name: 'Primary Keyword', type: 'text' },
        { key: 'keywords', display_name: 'Secondary Keywords', type: 'text' },
        { key: 'url', display_name: 'Published URL', type: 'url' },
        { key: 'wc', display_name: 'Word Count', type: 'number' },
        { key: 'labels', display_name: 'Labels', type: 'multi_select', options: [
          { label: 'pillar' }, { label: 'seo' }, { label: 'launch' }, { label: 'evergreen' }, { label: 'client-work' },
        ]},
        { key: 'cta', display_name: 'CTA', type: 'text' },
        { key: 'rating', display_name: 'Idea Rating (1-5)', type: 'number' },
        { key: 'draft', display_name: 'Draft', type: 'rich_text' },
      ],
    },
    {
      key: 'topics',
      name: 'Topics', icon: '🧠',
      fields: [
        { key: 'priority', display_name: 'Priority', type: 'select', options: [
          { label: 'Now', color: 'red' }, { label: 'Next', color: 'gold' }, { label: 'Later', color: 'gray' },
        ]},
        { key: 'volume', display_name: 'Search Volume /mo', type: 'number' },
        { key: 'description', display_name: 'Description', type: 'text', config: { multiline: true } },
      ],
    },
    {
      key: 'campaigns',
      name: 'Campaigns', icon: '📣',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Planned', color: 'blue' }, { label: 'Running', color: 'gold' }, { label: 'Done', color: 'green' },
        ]},
        { key: 'goal', display_name: 'Goal', type: 'text' },
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'start', display_name: 'Start Date', type: 'date' },
        { key: 'end', display_name: 'End Date', type: 'date' },
        { key: 'budget', display_name: 'Budget', type: 'number', config: { format: 'currency' } },
        { key: 'channel', display_name: 'Channel', type: 'multi_select', options: [
          { label: 'Email' }, { label: 'Social' }, { label: 'Paid' }, { label: 'Partner' },
        ]},
      ],
    },
  ],
  relations: [
    { key: 'article_campaigns', database_a: 'articles', database_b: 'campaigns', cardinality: 'many_to_many', field_a_name: 'Campaigns', field_b_name: 'Articles' },
    { key: 'article_topics', database_a: 'articles', database_b: 'topics', cardinality: 'many_to_many', field_a_name: 'Topics', field_b_name: 'Articles' },
  ],
  views: [
    { database: 'articles', name: 'Editorial Board', type: 'board', group_by_field: 'stage' },
    { database: 'articles', name: 'Ideas to rate', type: 'table', filters: [{ field: 'stage', op: 'has', values: ['Idea'] }], sorts: [{ field: 'rating', direction: 'desc' }] },
    { database: 'articles', name: 'By writer', type: 'board', group_by_field: 'stage', sorts: [{ field: 'target_date', direction: 'asc' }] },
    { database: 'articles', name: 'Publish Schedule', type: 'table', sorts: [{ field: 'target_date', direction: 'asc' }] },
    { database: 'topics', name: 'Topic map', type: 'board', group_by_field: 'priority' },
    { database: 'campaigns', name: 'Campaign Board', type: 'board', group_by_field: 'status' },
  ],
  records: [
    { key: 'camp', database: 'campaigns', values: { name: 'Q3 launch (sample)', status: 'Running' } },
    { database: 'articles', values: { name: 'Why stories beat pitches (sample)', stage: 'Writing', type: 'Blog post', author: '@me', labels: ['pillar'] }, links: [{ relation: 'article_campaigns', to: 'camp' }] },
    { database: 'articles', values: { name: 'Launch announcement (sample)', stage: 'Brief', type: 'Newsletter' }, links: [{ relation: 'article_campaigns', to: 'camp' }] },
    { database: 'articles', values: { name: 'Case study draft (sample)', stage: 'Idea', type: 'Case study' } },
  ],
};
