import { taskDnaDatabase, taskDnaRelations, taskDnaViews } from '../task-dna';
import type { TemplateDef } from '../types';

/** Creators category: coaches, consultants, authors, experts. */

export const coachingPractice: TemplateDef = {
  slug: 'coaching-practice',
  name: 'Coaching Practice',
  description: 'Clients, programs, sessions with notes, and action items — your whole practice, linked.',
  category: 'creators',
  scope: 'pack',
  space: 'Coaching',
    guide: `## How this works

**Clients** enroll in **Programs**; **Sessions** are the calendar spine; **Action Items** keep clients accountable between sessions.

## The loop

After each session: log notes, set the client's action items, schedule the next session. The week starts from the Sessions calendar.`,
  databases: [
    {
      key: 'clients',
      name: 'Clients', icon: '🤝',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Discovery', color: 'gray' }, { label: 'Proposal', color: 'blue' },
          { label: 'Active', color: 'green' }, { label: 'Paused', color: 'gold' },
          { label: 'Alumni', color: 'purple' },
        ]},
        { key: 'email', display_name: 'Email', type: 'email' },
        { key: 'phone', display_name: 'Phone', type: 'text' },
        { key: 'timezone', display_name: 'Timezone', type: 'text' },
        { key: 'start', display_name: 'Start Date', type: 'date' },
        { key: 'renewal', display_name: 'Renewal Date', type: 'date' },
        { key: 'price', display_name: 'Price Paid', type: 'number', config: { format: 'currency' } },
        { key: 'goal', display_name: 'Goal', type: 'text' },
        { key: 'progress', display_name: 'Progress', type: 'select', options: [
          { label: 'Just started', color: 'gray' }, { label: 'On track', color: 'green' },
          { label: 'Stuck', color: 'orange' }, { label: 'Breakthrough', color: 'gold' },
        ]},
      ],
    },
    {
      key: 'programs',
      name: 'Programs', icon: '🎓',
      fields: [
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: '1:1' }, { label: 'Group' }, { label: 'Cohort' }, { label: 'Course' }, { label: 'Retreat' },
        ]},
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Active', color: 'green' }, { label: 'Enrolling', color: 'blue' }, { label: 'Archived', color: 'brown' },
        ]},
        { key: 'price', display_name: 'Price', type: 'number', config: { format: 'currency' } },
        { key: 'length', display_name: 'Length', type: 'text' },
        { key: 'capacity', display_name: 'Capacity', type: 'number' },
        { key: 'enrolled', display_name: 'Enrolled', type: 'number' },
      ],
    },
    {
      key: 'sessions',
      name: 'Sessions', icon: '🗣️',
      fields: [
        { key: 'date', display_name: 'Date', type: 'date', config: { include_time: true } },
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Scheduled', color: 'blue' }, { label: 'Done', color: 'green' },
          { label: 'No-show', color: 'red' }, { label: 'Rescheduled', color: 'gold' },
          { label: 'Canceled', color: 'brown' },
        ]},
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Kickoff' }, { label: 'Regular' }, { label: 'Review' }, { label: 'Emergency' },
        ]},
        { key: 'recording', display_name: 'Recording', type: 'url' },
      ],
    },
    taskDnaDatabase({
      key: 'actions',
      name: 'Action Items',
      labels: ['homework', 'mine', 'follow-up'],
      withEstimates: false,
      extraFields: [
        { key: 'who', display_name: 'Who', type: 'select', options: [
          { label: 'Client', color: 'blue' }, { label: 'Me', color: 'gold' },
        ]},
      ],
    }),
  ],
  relations: [
    { key: 'client_program', database_a: 'clients', database_b: 'programs', cardinality: 'one_to_many', field_a_name: 'Program', field_b_name: 'Clients' },
    { key: 'session_client', database_a: 'sessions', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Sessions' },
    { key: 'action_client', database_a: 'actions', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Action items' },
    { key: 'action_session', database_a: 'actions', database_b: 'sessions', cardinality: 'one_to_many', field_a_name: 'Session', field_b_name: 'Action items' },
  ],
  views: [
    { database: 'clients', name: 'Client Board', type: 'board', group_by_field: 'status' },
    { database: 'clients', name: 'Renewals Coming', type: 'table', filters: [{ field: 'renewal', op: 'within', value: 'next_30_days' }], sorts: [{ field: 'renewal', direction: 'asc' }] },
    { database: 'sessions', name: 'Session Board', type: 'board', group_by_field: 'status' },
    { database: 'sessions', name: 'Upcoming', type: 'table', filters: [{ field: 'date', op: 'within', value: 'next_7_days' }], sorts: [{ field: 'date', direction: 'asc' }] },
    ...taskDnaViews('actions', 'Action Board'),
  ],
  records: [
    { key: 'prog', database: 'programs', values: { name: '1:1 Executive coaching (sample)', type: '1:1', status: 'Active', price: 6000, length: '6 months' } },
    { key: 'c1', database: 'clients', values: { name: 'Sarah M (sample)', status: 'Active', progress: 'On track', goal: 'Step into the CEO role' }, links: [{ relation: 'client_program', to: 'prog' }] },
    { key: 's1', database: 'sessions', values: { name: 'Session 4 — delegation (sample)', status: 'Done', type: 'Regular' }, links: [{ relation: 'session_client', to: 'c1' }] },
    { database: 'actions', values: { name: 'Write the delegation list (sample)', state: 'To Do', who: 'Client', labels: ['homework'] }, links: [{ relation: 'action_client', to: 'c1' }, { relation: 'action_session', to: 's1' }] },
    { database: 'actions', values: { name: 'Send the árticle on founder mode (sample)', state: 'Done', who: 'Me', assignee: '@me' }, links: [{ relation: 'action_client', to: 'c1' }] },
  ],
};

export const consulting: TemplateDef = {
  slug: 'consulting',
  name: 'Consulting Engagements',
  description: 'Proposal pipeline, engagements with hours budgets, and delivery boards.',
  category: 'creators',
  scope: 'pack',
  space: 'Consulting',
    guide: `## How this works

**Leads** become **Engagements** (with scope, rate and status); **Delivery Tasks** carry the work. The pipeline board on Engagements is the business at a glance.`,
  databases: [
    {
      key: 'clients',
      name: 'Clients', icon: '🤝',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Prospect', color: 'gray' }, { label: 'Active', color: 'green' },
          { label: 'Past', color: 'brown' },
        ]},
        { key: 'industry', display_name: 'Industry', type: 'select', options: [
          { label: 'SaaS' }, { label: 'Finance' }, { label: 'Health' }, { label: 'Retail' }, { label: 'Other' },
        ]},
        { key: 'email', display_name: 'Contact Email', type: 'email' },
        { key: 'website', display_name: 'Website', type: 'url' },
        { key: 'owner', display_name: 'Owner', type: 'user' },
      ],
    },
    {
      key: 'proposals',
      name: 'Proposals', icon: '🧾',
      fields: [
        { key: 'stage', display_name: 'Stage', type: 'select', options: [
          { label: 'Draft', color: 'gray' }, { label: 'Sent', color: 'gold' },
          { label: 'Negotiating', color: 'orange' }, { label: 'Won', color: 'green' },
          { label: 'Lost', color: 'brown' },
        ]},
        { key: 'value', display_name: 'Value', type: 'number', config: { format: 'currency' } },
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Audit' }, { label: 'Retainer' }, { label: 'Project' }, { label: 'Workshop' },
        ]},
        { key: 'sent', display_name: 'Sent Date', type: 'date' },
        { key: 'close', display_name: 'Expected Close', type: 'date' },
        { key: 'probability', display_name: 'Win Probability', type: 'select', options: [
          { label: '10%' }, { label: '25%' }, { label: '50%' }, { label: '75%' }, { label: '90%' },
        ]},
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
    {
      key: 'engagements',
      name: 'Engagements', icon: '💼',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Kickoff', color: 'blue' }, { label: 'Active', color: 'green' },
          { label: 'Wrapping', color: 'gold' }, { label: 'Done', color: 'teal' },
          { label: 'Renewed', color: 'purple' },
        ]},
        { key: 'start', display_name: 'Start Date', type: 'date' },
        { key: 'end', display_name: 'End Date', type: 'date' },
        { key: 'monthly', display_name: 'Monthly Value', type: 'number', config: { format: 'currency' } },
        { key: 'hours_budget', display_name: 'Hours Budget', type: 'number' },
        { key: 'hours_used', display_name: 'Hours Used', type: 'number' },
        { key: 'success', display_name: 'Success Criteria', type: 'text' },
      ],
    },
    taskDnaDatabase({
      key: 'deliverables',
      name: 'Deliverables & Tasks',
      labels: ['research', 'workshop', 'report', 'analysis', 'follow-up'],
    }),
  ],
  relations: [
    { key: 'proposal_client', database_a: 'proposals', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Proposals' },
    { key: 'engagement_client', database_a: 'engagements', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Engagements' },
    { key: 'engagement_proposal', database_a: 'engagements', database_b: 'proposals', cardinality: 'one_to_many', field_a_name: 'Proposal', field_b_name: 'Engagements' },
    { key: 'deliverable_engagement', database_a: 'deliverables', database_b: 'engagements', cardinality: 'one_to_many', field_a_name: 'Engagement', field_b_name: 'Deliverables' },
    ...taskDnaRelations('deliverables'),
  ],
  views: [
    { database: 'proposals', name: 'Pipeline Board', type: 'board', group_by_field: 'stage' },
    { database: 'proposals', name: 'Open', type: 'table', filters: [{ field: 'stage', op: 'has', values: ['Sent', 'Negotiating'] }] },
    { database: 'engagements', name: 'Engagement Board', type: 'board', group_by_field: 'status' },
    { database: 'engagements', name: 'Ending Soon', type: 'table', filters: [{ field: 'end', op: 'within', value: 'next_30_days' }] },
    { database: 'engagements', name: 'Engagement Timeline', type: 'timeline', start_date_field: 'start', end_date_field: 'end' },
    ...taskDnaViews('deliverables', 'Delivery Board'),
  ],
  records: [
    { key: 'c1', database: 'clients', values: { name: 'Meridian Health (sample)', status: 'Active', industry: 'Health' } },
    { key: 'prop', database: 'proposals', values: { name: 'Growth audit Q3 (sample)', stage: 'Won', value: 15000, type: 'Audit' }, links: [{ relation: 'proposal_client', to: 'c1' }] },
    { key: 'eng', database: 'engagements', values: { name: 'Meridian growth audit (sample)', status: 'Active', monthly: 5000, hours_budget: 40, hours_used: 12 }, links: [{ relation: 'engagement_client', to: 'c1' }, { relation: 'engagement_proposal', to: 'prop' }] },
    { database: 'deliverables', values: { name: 'Stakeholder interviews (sample)', state: 'In Progress', labels: ['research'], assignee: '@me', estimate: 8 }, links: [{ relation: 'deliverable_engagement', to: 'eng' }] },
    { database: 'deliverables', values: { name: 'Findings report (sample)', state: 'Backlog', labels: ['report'] }, links: [{ relation: 'deliverable_engagement', to: 'eng' }] },
  ],
};

export const authorStudio: TemplateDef = {
  slug: 'author-studio',
  name: 'Author Studio',
  description: 'Books, a manuscript board of chapters, research notes, launch tasks, and appearances.',
  category: 'creators',
  scope: 'pack',
  space: 'Writing',
    guide: `## How this works

**Chapters** with a manuscript board (Outline → Draft → Revised → Done), **Research Notes** linked to chapters, **Appearances** (podcasts, talks) and **Launch Tasks** for the campaign.

## The loop

Write in the chapter's rich text; move it across the board; park every source in Research Notes linked where it's used.`,
  databases: [
    {
      key: 'books',
      name: 'Books',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Idea', color: 'gray' }, { label: 'Proposal', color: 'blue' },
          { label: 'Writing', color: 'gold' }, { label: 'Editing', color: 'purple' },
          { label: 'Production', color: 'teal' }, { label: 'Published', color: 'green' },
        ]},
        { key: 'genre', display_name: 'Genre', type: 'text' },
        { key: 'target_wc', display_name: 'Target Word Count', type: 'number' },
        { key: 'current_wc', display_name: 'Current Word Count', type: 'number' },
        { key: 'deadline', display_name: 'Deadline', type: 'date' },
        { key: 'publisher', display_name: 'Publisher', type: 'text' },
        { key: 'agent', display_name: 'Agent', type: 'text' },
        { key: 'isbn', display_name: 'ISBN', type: 'text' },
      ],
    },
    {
      key: 'chapters',
      name: 'Chapters', icon: '📖',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Outline', color: 'gray' }, { label: 'Draft', color: 'gold' },
          { label: 'Revised', color: 'purple' }, { label: 'Final', color: 'green' },
        ]},
        { key: 'order', display_name: 'Order', type: 'number' },
        { key: 'wc', display_name: 'Word Count', type: 'number' },
        { key: 'theme', display_name: 'POV / Theme', type: 'text' },
      ],
    },
    {
      key: 'research',
      name: 'Research Notes', icon: '🧠',
      fields: [
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Interview' }, { label: 'Article' }, { label: 'Book' }, { label: 'Idea' }, { label: 'Quote' },
        ]},
        { key: 'source', display_name: 'Source', type: 'url' },
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'To read', color: 'blue' }, { label: 'Processed', color: 'green' },
        ]},
      ],
    },
    taskDnaDatabase({
      key: 'launch',
      name: 'Launch & Marketing',
      labels: ['podcast', 'newsletter', 'social', 'pr', 'events', 'ads'],
    }),
    {
      key: 'appearances',
      name: 'Appearances', icon: '🎙️',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Wishlist', color: 'gray' }, { label: 'Pitched', color: 'blue' },
          { label: 'Booked', color: 'gold' }, { label: 'Recorded', color: 'purple' },
          { label: 'Aired', color: 'green' },
        ]},
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Podcast' }, { label: 'Stage' }, { label: 'Webinar' }, { label: 'Guest post' },
        ]},
        { key: 'show', display_name: 'Show / Event', type: 'text' },
        { key: 'host', display_name: 'Host Contact', type: 'text' },
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'audience', display_name: 'Audience Size', type: 'number' },
        { key: 'link', display_name: 'Link', type: 'url' },
      ],
    },
  ],
  relations: [
    { key: 'chapter_book', database_a: 'chapters', database_b: 'books', cardinality: 'one_to_many', field_a_name: 'Book', field_b_name: 'Chapters' },
    { key: 'research_chapters', database_a: 'research', database_b: 'chapters', cardinality: 'many_to_many', field_a_name: 'Chapters', field_b_name: 'Research' },
    { key: 'launch_book', database_a: 'launch', database_b: 'books', cardinality: 'one_to_many', field_a_name: 'Book', field_b_name: 'Launch tasks' },
    ...taskDnaRelations('launch'),
  ],
  views: [
    { database: 'chapters', name: 'Manuscript Board', type: 'board', group_by_field: 'status' },
    { database: 'chapters', name: 'In Order', type: 'table', sorts: [{ field: 'order', direction: 'asc' }] },
    { database: 'research', name: 'Unprocessed', type: 'table', filters: [{ field: 'status', op: 'has', values: ['To read'] }] },
    { database: 'appearances', name: 'Pitch Board', type: 'board', group_by_field: 'status' },
    { database: 'appearances', name: 'Aired', type: 'table', filters: [{ field: 'status', op: 'has', values: ['Aired'] }] },
    ...taskDnaViews('launch', 'Launch Board'),
  ],
  records: [
    { key: 'book', database: 'books', values: { name: 'The Story Engine (sample)', status: 'Writing', target_wc: 60000, current_wc: 21500 } },
    { key: 'ch1', database: 'chapters', values: { name: 'Ch 1 — Why stories win (sample)', status: 'Final', order: 1, wc: 4200 }, links: [{ relation: 'chapter_book', to: 'book' }] },
    { database: 'chapters', values: { name: 'Ch 2 — The narrative arc (sample)', status: 'Draft', order: 2, wc: 3100 }, links: [{ relation: 'chapter_book', to: 'book' }] },
    { database: 'chapters', values: { name: 'Ch 3 — Villains and stakes (sample)', status: 'Outline', order: 3 }, links: [{ relation: 'chapter_book', to: 'book' }] },
    { database: 'research', values: { name: 'Campbell — hero journey notes (sample)', type: 'Book', status: 'Processed' }, links: [{ relation: 'research_chapters', to: 'ch1' }] },
    { database: 'launch', values: { name: 'Pitch 10 podcasts (sample)', state: 'To Do', labels: ['podcast'], assignee: '@me' }, links: [{ relation: 'launch_book', to: 'book' }] },
    { database: 'appearances', values: { name: 'The Creative Pen podcast (sample)', status: 'Pitched', type: 'Podcast', show: 'The Creative Pen' } },
  ],
};
