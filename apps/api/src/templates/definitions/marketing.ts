import type { TemplateDef } from '../types';

/**
 * Marketing category (MN-054, 056, 057, 058, 060, 061) — from the Fibery
 * template review (docs/product/fibery-template-review.md). Every pack ships
 * a guide (MN-053).
 */

export const meetings: TemplateDef = {
  slug: 'meetings',
  name: 'Meetings & Action Items',
  description: 'Capture notes for any meeting and make sure action items actually get done.',
  category: 'marketing',
  scope: 'pack',
  space: 'Meetings',
  guide: `## How this works

Two databases carry the whole ritual: **Meetings** hold the notes, **Action Items** hold the follow-through. Every action item links back to the meeting that created it, so nothing floats.

## The loop

- Before: create the Meeting, set Type and Date, add Attendees.
- During: take notes in the rich-text Notes section on the meeting record.
- Before closing: turn every decision into an Action Item with an Owner and a Due date — an unowned action item is a wish.
- Daily: everyone checks **My open items**; weekly: sweep the Open-by-owner board for overload.

## Tips

- Recurring standup? Duplicate yesterday's meeting record and clear the notes.
- The **Meetings calendar** doubles as the team's meeting load report — too dense is a signal.`,
  databases: [
    {
      key: 'meetings',
      name: 'Meetings', icon: '🗓️',
      fields: [
        { key: 'type', display_name: 'Type', type: 'select', options: [
          { label: 'Daily', color: 'gray' }, { label: '1-on-1', color: 'teal' }, { label: 'Client', color: 'gold' },
          { label: 'Project Status', color: 'blue' }, { label: 'Retro', color: 'purple' },
        ]},
        { key: 'date', display_name: 'Date', type: 'date', config: { include_time: true } },
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Scheduled', color: 'gray' }, { label: 'Held', color: 'green' }, { label: 'Cancelled', color: 'brown' },
        ]},
        { key: 'attendees', display_name: 'Attendees', type: 'user', config: { multi: true } },
        { key: 'notes', display_name: 'Notes', type: 'rich_text' },
      ],
    },
    {
      key: 'actions',
      name: 'Action Items', icon: '✅',
      fields: [
        { key: 'done', display_name: 'Done', type: 'checkbox' },
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'due', display_name: 'Due', type: 'date' },
        { key: 'priority', display_name: 'Priority', type: 'select', options: [
          { label: 'High', color: 'red' }, { label: 'Medium', color: 'gold' }, { label: 'Low', color: 'gray' },
        ]},
      ],
    },
  ],
  relations: [
    { key: 'meeting_actions', database_a: 'actions', database_b: 'meetings', cardinality: 'one_to_many', field_a_name: 'Meeting', field_b_name: 'Action Items' },
  ],
  views: [
    { database: 'meetings', name: 'Calendar', type: 'calendar', date_field: 'date' },
    { database: 'meetings', name: 'Upcoming', type: 'table', filters: [{ field: 'date', op: 'within', value: 'next_7_days' }], sorts: [{ field: 'date', direction: 'asc' }] },
    { database: 'actions', name: 'Open by owner', type: 'board', group_by_field: 'priority', filters: [{ field: 'done', op: 'eq', value: false }] },
    { database: 'actions', name: 'My open items', type: 'table', filters: [{ field: 'owner', op: 'has', values: ['@me'] }, { field: 'done', op: 'eq', value: false }] },
  ],
  records: [
    { key: 'm1', database: 'meetings', values: { name: 'Weekly status (sample)', type: 'Project Status', status: 'Held' } },
    { database: 'actions', values: { name: 'Send updated timeline to client (sample)', owner: '@me', priority: 'High' }, links: [{ relation: 'meeting_actions', to: 'm1' }] },
    { database: 'actions', values: { name: 'Book venue for offsite (sample)', priority: 'Medium' }, links: [{ relation: 'meeting_actions', to: 'm1' }] },
  ],
};

export const customerJourney: TemplateDef = {
  slug: 'customer-journey',
  name: 'Customer Journey Map',
  description: 'Map every stage of the customer experience and mine it for opportunities.',
  category: 'marketing',
  scope: 'pack',
  space: 'Customer Journey',
  guide: `## How this works

Fibery models this with nine databases; we compress to three without losing the method: **Journeys** (one per persona), **Stages** (the steps, ordered), **Insights** (everything you learn, tagged with a Kind).

## The method

- Create a Journey per persona and its Stages in order (Awareness → Consideration → Purchase → Onboarding → Advocacy is the classic spine).
- Walk each stage and log **Insights**: what the customer does (Action), wants (Goal), thinks (Thought), feels (Emotion), where it hurts (Pain point), and what you could do about it (Opportunity).
- The **Insights board** grouped by Kind is your map; the **Pain points** view sorted by severity is your backlog input.

## Tips

- Every Opportunity should eventually become a task in your work space — copy the title across, or wire an automation.
- Touchpoint names ("pricing page", "onboarding email 2") make insights actionable — always fill them.`,
  databases: [
    {
      key: 'journeys',
      name: 'Journeys', icon: '🧭',
      fields: [
        { key: 'persona', display_name: 'Persona', type: 'text' },
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Mapping', color: 'gold' }, { label: 'Validated', color: 'green' }, { label: 'Stale', color: 'brown' },
        ]},
        { key: 'scope', display_name: 'Scope & Notes', type: 'rich_text' },
      ],
    },
    {
      key: 'stages',
      name: 'Stages', icon: '👣',
      fields: [
        { key: 'order', display_name: 'Order', type: 'number' },
        { key: 'description', display_name: 'Description', type: 'text', config: { multiline: true } },
      ],
    },
    {
      key: 'insights',
      name: 'Insights', icon: '💡',
      fields: [
        { key: 'kind', display_name: 'Kind', type: 'select', options: [
          { label: 'Goal', color: 'blue' }, { label: 'Action', color: 'teal' }, { label: 'Thought', color: 'purple' },
          { label: 'Emotion', color: 'pink' }, { label: 'Pain point', color: 'red' }, { label: 'Opportunity', color: 'green' },
        ]},
        { key: 'touchpoint', display_name: 'Touchpoint', type: 'text' },
        { key: 'severity', display_name: 'Severity', type: 'select', options: [
          { label: 'High', color: 'red' }, { label: 'Medium', color: 'gold' }, { label: 'Low', color: 'gray' },
        ]},
        { key: 'details', display_name: 'Details', type: 'rich_text' },
      ],
    },
  ],
  relations: [
    { key: 'journey_stages', database_a: 'stages', database_b: 'journeys', cardinality: 'one_to_many', field_a_name: 'Journey', field_b_name: 'Stages' },
    { key: 'stage_insights', database_a: 'insights', database_b: 'stages', cardinality: 'one_to_many', field_a_name: 'Stage', field_b_name: 'Insights' },
  ],
  views: [
    { database: 'insights', name: 'Map (by kind)', type: 'board', group_by_field: 'kind' },
    { database: 'insights', name: 'Pain points', type: 'table', filters: [{ field: 'kind', op: 'has', values: ['Pain point'] }] },
    { database: 'stages', name: 'Stages in order', type: 'table', sorts: [{ field: 'order', direction: 'asc' }] },
  ],
  records: [
    { key: 'j1', database: 'journeys', values: { name: 'New client onboarding (sample)', persona: 'Marketing lead at a 20-person company', status: 'Mapping' } },
    { key: 's1', database: 'stages', values: { name: 'Consideration (sample)', order: 2 }, links: [{ relation: 'journey_stages', to: 'j1' }] },
    { database: 'insights', values: { name: 'Pricing page does not answer "what happens after I pay" (sample)', kind: 'Pain point', severity: 'High', touchpoint: 'Pricing page' }, links: [{ relation: 'stage_insights', to: 's1' }] },
    { database: 'insights', values: { name: 'Add a 90-second onboarding video (sample)', kind: 'Opportunity', touchpoint: 'Pricing page' }, links: [{ relation: 'stage_insights', to: 's1' }] },
  ],
};

export const eventPlanning: TemplateDef = {
  slug: 'event-planning',
  name: 'Event Planning',
  description: 'Tasks, budget and timeline for events that actually run on time.',
  category: 'marketing',
  scope: 'pack',
  space: 'Events',
  guide: `## How this works

**Events** hold the what/when/where and the budget; **Event Tasks** are the checklist; **Expenses** log every cost with a category and a Paid flag.

## The loop

- Create the Event, set the Date and Budget.
- Break the work into Event Tasks immediately — venue, catering, speakers, promo — each with an Owner and Due date.
- Log every Expense the moment it's committed, not when the invoice arrives. The **By category** board shows where the money goes; **Unpaid** is your liabilities list.

## Tips

- The Events **calendar** is the master timeline — put internal deadlines on it as zero-cost events if it helps.
- Budget-vs-actual totals per event arrive with rollup fields; until then the expense board grouped by category answers "where is it going".`,
  databases: [
    {
      key: 'events',
      name: 'Events', icon: '🎪',
      fields: [
        { key: 'date', display_name: 'Date', type: 'date' },
        { key: 'venue', display_name: 'Venue', type: 'text' },
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Planning', color: 'gold' }, { label: 'Confirmed', color: 'blue' }, { label: 'Done', color: 'green' }, { label: 'Cancelled', color: 'brown' },
        ]},
        { key: 'budget', display_name: 'Budget', type: 'number', config: { format: 'currency', currency_code: 'USD' } },
        { key: 'expected', display_name: 'Expected Attendees', type: 'number' },
        { key: 'brief', display_name: 'Brief', type: 'rich_text' },
      ],
    },
    {
      key: 'tasks',
      name: 'Event Tasks', icon: '✅',
      fields: [
        { key: 'state', display_name: 'State', type: 'select', options: [
          { label: 'To Do', color: 'gray' }, { label: 'In Progress', color: 'gold' }, { label: 'Done', color: 'green' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'due', display_name: 'Due', type: 'date' },
      ],
    },
    {
      key: 'expenses',
      name: 'Expenses', icon: '💳',
      fields: [
        { key: 'amount', display_name: 'Amount', type: 'number', config: { format: 'currency', currency_code: 'USD' } },
        { key: 'category', display_name: 'Category', type: 'select', options: [
          { label: 'Venue', color: 'blue' }, { label: 'Catering', color: 'gold' }, { label: 'Marketing', color: 'pink' },
          { label: 'Travel', color: 'teal' }, { label: 'Production', color: 'purple' }, { label: 'Other', color: 'gray' },
        ]},
        { key: 'paid', display_name: 'Paid', type: 'checkbox' },
        { key: 'vendor', display_name: 'Vendor', type: 'text' },
      ],
    },
  ],
  relations: [
    { key: 'event_tasks', database_a: 'tasks', database_b: 'events', cardinality: 'one_to_many', field_a_name: 'Event', field_b_name: 'Tasks' },
    { key: 'event_expenses', database_a: 'expenses', database_b: 'events', cardinality: 'one_to_many', field_a_name: 'Event', field_b_name: 'Expenses' },
  ],
  views: [
    { database: 'events', name: 'Calendar', type: 'calendar', date_field: 'date' },
    { database: 'tasks', name: 'Task Board', type: 'board', group_by_field: 'state' },
    { database: 'expenses', name: 'By category', type: 'board', group_by_field: 'category' },
    { database: 'expenses', name: 'Unpaid', type: 'table', filters: [{ field: 'paid', op: 'eq', value: false }] },
  ],
  records: [
    { key: 'e1', database: 'events', values: { name: 'Client summit (sample)', status: 'Planning', venue: 'TBD', budget: 15000, expected: 80 } },
    { database: 'tasks', values: { name: 'Shortlist three venues (sample)', state: 'In Progress', owner: '@me' }, links: [{ relation: 'event_tasks', to: 'e1' }] },
    { database: 'expenses', values: { name: 'Venue deposit (sample)', amount: 2500, category: 'Venue', paid: true, vendor: 'Loft 44' }, links: [{ relation: 'event_expenses', to: 'e1' }] },
  ],
};

export const videoProduction: TemplateDef = {
  slug: 'video-production',
  name: 'Video Production',
  description: 'From idea to published: scripts, shoots, edits and costs in one pipeline.',
  category: 'marketing',
  scope: 'pack',
  space: 'Video',
  guide: `## How this works

**Videos** move through a stage pipeline (Idea → Script → Shoot → Edit → Review → Published); the script lives ON the video as rich text. **Production Tasks** carry the legwork; **Expenses** track gear, locations, talent.

## The loop

- New concept → create a Video at Idea; write the Brief.
- Script stage: draft in the Script section — comments happen right there.
- Shoot/Edit: tasks per shoot day; the **Publish calendar** holds the schedule.
- Published: fill the URL; the pipeline board tells the whole story at standup.

## Tips

- If you also run the Client Work pack, videos auto-link to Clients (the installer wires the relation when the Clients database exists).
- Track per-platform cuts as separate Videos linked to the same tasks — cheaper than modeling "deliverables".`,
  databases: [
    {
      key: 'videos',
      name: 'Videos', icon: '🎬',
      fields: [
        { key: 'stage', display_name: 'Stage', type: 'select', options: [
          { label: 'Idea', color: 'gray' }, { label: 'Script', color: 'purple' }, { label: 'Shoot', color: 'gold' },
          { label: 'Edit', color: 'orange' }, { label: 'Review', color: 'blue' }, { label: 'Published', color: 'green' },
        ]},
        { key: 'publish', display_name: 'Publish Date', type: 'date' },
        { key: 'platform', display_name: 'Platform', type: 'select', options: [
          { label: 'YouTube', color: 'red' }, { label: 'Shorts', color: 'orange' }, { label: 'TikTok', color: 'teal' },
          { label: 'Instagram', color: 'pink' }, { label: 'Client delivery', color: 'blue' },
        ]},
        { key: 'length', display_name: 'Length (min)', type: 'number' },
        { key: 'url', display_name: 'Published URL', type: 'url' },
        { key: 'brief', display_name: 'Brief', type: 'rich_text' },
        { key: 'script', display_name: 'Script', type: 'rich_text' },
      ],
    },
    {
      key: 'tasks',
      name: 'Production Tasks', icon: '✅',
      fields: [
        { key: 'state', display_name: 'State', type: 'select', options: [
          { label: 'To Do', color: 'gray' }, { label: 'In Progress', color: 'gold' }, { label: 'Done', color: 'green' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'due', display_name: 'Due', type: 'date' },
      ],
    },
    {
      key: 'expenses',
      name: 'Expenses', icon: '💳',
      fields: [
        { key: 'amount', display_name: 'Amount', type: 'number', config: { format: 'currency', currency_code: 'USD' } },
        { key: 'category', display_name: 'Category', type: 'select', options: [
          { label: 'Gear', color: 'blue' }, { label: 'Location', color: 'teal' }, { label: 'Talent', color: 'pink' },
          { label: 'Music', color: 'purple' }, { label: 'Post-production', color: 'orange' },
        ]},
        { key: 'paid', display_name: 'Paid', type: 'checkbox' },
      ],
    },
  ],
  relations: [
    { key: 'video_tasks', database_a: 'tasks', database_b: 'videos', cardinality: 'one_to_many', field_a_name: 'Video', field_b_name: 'Tasks' },
    { key: 'video_expenses', database_a: 'expenses', database_b: 'videos', cardinality: 'one_to_many', field_a_name: 'Video', field_b_name: 'Expenses' },
    { key: 'video_client', database_a: 'videos', external_target_name: 'Clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Videos' },
  ],
  views: [
    { database: 'videos', name: 'Pipeline', type: 'board', group_by_field: 'stage' },
    { database: 'videos', name: 'Publish calendar', type: 'calendar', date_field: 'publish' },
    { database: 'tasks', name: 'This week', type: 'table', filters: [{ field: 'due', op: 'within', value: 'next_7_days' }] },
    { database: 'expenses', name: 'All costs', type: 'table', sorts: [{ field: 'amount', direction: 'desc' }] },
  ],
  records: [
    { key: 'v1', database: 'videos', values: { name: 'Brand story 60s (sample)', stage: 'Script', platform: 'YouTube', length: 1 } },
    { database: 'tasks', values: { name: 'Location scout (sample)', state: 'To Do', owner: '@me' }, links: [{ relation: 'video_tasks', to: 'v1' }] },
    { database: 'expenses', values: { name: 'Lens rental (sample)', amount: 180, category: 'Gear' }, links: [{ relation: 'video_expenses', to: 'v1' }] },
  ],
};

export const campaignsHq: TemplateDef = {
  slug: 'campaigns-hq',
  name: 'Campaigns HQ',
  description: 'Brief, launch and measure marketing campaigns — objectives, audiences and metrics in one place.',
  category: 'marketing',
  scope: 'pack',
  space: 'Campaigns',
  guide: `## How this works

One pack replaces two Fibery templates (Campaign Brief + Product Marketing). **Campaigns** carry the brief as structured fields + a rich-text Objective; **Audiences** are reusable across campaigns; **Key Metrics** hold target vs actual; **Campaign Tasks** carry execution.

## The loop

- Brief = the campaign record. Write the Objective, set dates and Budget, link Audiences, define 2–4 Key Metrics with targets.
- Status **Brief Approved** is the gate — nothing ships from Draft.
- While Live, update Metric actuals weekly; the campaign record IS the status report.
- Wrap: set Status Wrapped, write the retro into the Objective doc's end.

## Tips

- Audiences are a library — write them once, link them everywhere.
- If the Content Pipeline pack is installed, campaigns link to Articles automatically (cross-pack relation).`,
  databases: [
    {
      key: 'campaigns',
      name: 'Campaigns', icon: '🚀',
      fields: [
        { key: 'status', display_name: 'Status', type: 'select', options: [
          { label: 'Draft', color: 'gray' }, { label: 'Brief Approved', color: 'purple' }, { label: 'Live', color: 'green' }, { label: 'Wrapped', color: 'brown' },
        ]},
        { key: 'start', display_name: 'Start', type: 'date' },
        { key: 'end', display_name: 'End', type: 'date' },
        { key: 'budget', display_name: 'Budget', type: 'number', config: { format: 'currency', currency_code: 'USD' } },
        { key: 'channels', display_name: 'Channels', type: 'multi_select', options: [
          { label: 'Email', color: 'blue' }, { label: 'Social', color: 'pink' }, { label: 'Paid', color: 'gold' },
          { label: 'SEO', color: 'green' }, { label: 'Events', color: 'purple' }, { label: 'Partners', color: 'teal' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'objective', display_name: 'Objective & Brief', type: 'rich_text' },
      ],
    },
    {
      key: 'audiences',
      name: 'Audiences', icon: '👥',
      fields: [
        { key: 'size', display_name: 'Estimated Size', type: 'number' },
        { key: 'profile', display_name: 'Profile', type: 'rich_text' },
      ],
    },
    {
      key: 'metrics',
      name: 'Key Metrics', icon: '🎯',
      fields: [
        { key: 'target', display_name: 'Target', type: 'number' },
        { key: 'actual', display_name: 'Actual', type: 'number' },
        { key: 'unit', display_name: 'Unit', type: 'text' },
      ],
    },
    {
      key: 'tasks',
      name: 'Campaign Tasks', icon: '✅',
      fields: [
        { key: 'state', display_name: 'State', type: 'select', options: [
          { label: 'To Do', color: 'gray' }, { label: 'In Progress', color: 'gold' }, { label: 'Done', color: 'green' },
        ]},
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'due', display_name: 'Due', type: 'date' },
      ],
    },
  ],
  relations: [
    { key: 'campaign_metrics', database_a: 'metrics', database_b: 'campaigns', cardinality: 'one_to_many', field_a_name: 'Campaign', field_b_name: 'Key Metrics' },
    { key: 'campaign_tasks', database_a: 'tasks', database_b: 'campaigns', cardinality: 'one_to_many', field_a_name: 'Campaign', field_b_name: 'Tasks' },
    { key: 'campaign_audiences', database_a: 'campaigns', database_b: 'audiences', cardinality: 'many_to_many', field_a_name: 'Audiences', field_b_name: 'Campaigns' },
    { key: 'campaign_articles', database_a: 'campaigns', external_target_name: 'Articles', cardinality: 'many_to_many', field_a_name: 'Articles', field_b_name: 'Campaigns (HQ)' },
  ],
  views: [
    { database: 'campaigns', name: 'By status', type: 'board', group_by_field: 'status' },
    { database: 'campaigns', name: 'Timeline', type: 'table', sorts: [{ field: 'start', direction: 'asc' }] },
    { database: 'metrics', name: 'Scoreboard', type: 'table' },
    { database: 'tasks', name: 'Execution board', type: 'board', group_by_field: 'state' },
  ],
  records: [
    { key: 'c1', database: 'campaigns', values: { name: 'Fall launch (sample)', status: 'Draft', channels: ['Email', 'Social'], budget: 8000, owner: '@me' } },
    { key: 'a1', database: 'audiences', values: { name: 'Marketing leads, 10-50 employees (sample)', size: 12000 } },
    { database: 'metrics', values: { name: 'Signups (sample)', target: 500, unit: 'signups' }, links: [{ relation: 'campaign_metrics', to: 'c1' }] },
    { database: 'tasks', values: { name: 'Draft launch email (sample)', state: 'To Do' }, links: [{ relation: 'campaign_tasks', to: 'c1' }] },
    { database: 'campaigns', values: { name: '(link sample)' }, links: [{ relation: 'campaign_audiences', to: 'a1' }] },
  ],
};

export const salesCrm: TemplateDef = {
  slug: 'sales-crm',
  name: 'Sales CRM',
  description: 'Accounts, contacts and a real opportunity pipeline — lighter than a CRM, stronger than a spreadsheet.',
  category: 'marketing',
  scope: 'pack',
  space: 'Sales',
  guide: `## How this works

Four databases mirror how deals actually move: **Accounts** (companies) hold **Contacts** (people) and **Opportunities** (deals with a stage, amount and close date); **Sales Tasks** keep the next step explicit.

## The discipline

- Every Opportunity has a **Next Step** filled in — an opportunity without one is stalled by definition.
- The **Pipeline** board is the single source of truth; move cards, don't edit stages in tables.
- **Closing this month** is the Monday meeting view.
- Log calls/emails as Sales Tasks with a Due date; check **My tasks due** daily.

## Tips

- Won/Lost stay on the board — slide them out with a filter when the columns get heavy.
- Probability is yours to calibrate: 10/25/50/75 works until you have data.
- Per-stage pipeline value totals arrive with rollup fields.`,
  databases: [
    {
      key: 'accounts',
      name: 'Accounts', icon: '🏢',
      fields: [
        { key: 'industry', display_name: 'Industry', type: 'select', options: [
          { label: 'SaaS', color: 'blue' }, { label: 'E-commerce', color: 'gold' }, { label: 'Agency', color: 'pink' },
          { label: 'Finance', color: 'green' }, { label: 'Other', color: 'gray' },
        ]},
        { key: 'size', display_name: 'Size', type: 'select', options: [
          { label: '1-10', color: 'gray' }, { label: '11-50', color: 'teal' }, { label: '51-200', color: 'blue' }, { label: '200+', color: 'purple' },
        ]},
        { key: 'website', display_name: 'Website', type: 'url' },
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'notes', display_name: 'Notes', type: 'rich_text' },
      ],
    },
    {
      key: 'contacts',
      name: 'Contacts', icon: '👤',
      fields: [
        { key: 'email', display_name: 'Email', type: 'email' },
        { key: 'phone', display_name: 'Phone', type: 'text' },
        { key: 'role', display_name: 'Role', type: 'text' },
        { key: 'primary', display_name: 'Primary', type: 'checkbox' },
      ],
    },
    {
      key: 'opportunities',
      name: 'Opportunities', icon: '💰',
      fields: [
        { key: 'stage', display_name: 'Stage', type: 'select', options: [
          { label: 'Prospect', color: 'gray' }, { label: 'Qualified', color: 'teal' }, { label: 'Proposal', color: 'blue' },
          { label: 'Negotiation', color: 'gold' }, { label: 'Won', color: 'green' }, { label: 'Lost', color: 'brown' },
        ]},
        { key: 'amount', display_name: 'Amount', type: 'number', config: { format: 'currency', currency_code: 'USD' } },
        { key: 'close', display_name: 'Close Date', type: 'date' },
        { key: 'probability', display_name: 'Probability %', type: 'number' },
        { key: 'next_step', display_name: 'Next Step', type: 'text' },
      ],
    },
    {
      key: 'tasks',
      name: 'Sales Tasks', icon: '✅',
      fields: [
        { key: 'done', display_name: 'Done', type: 'checkbox' },
        { key: 'owner', display_name: 'Owner', type: 'user' },
        { key: 'due', display_name: 'Due', type: 'date' },
      ],
    },
  ],
  relations: [
    { key: 'account_contacts', database_a: 'contacts', database_b: 'accounts', cardinality: 'one_to_many', field_a_name: 'Account', field_b_name: 'Contacts' },
    { key: 'account_opps', database_a: 'opportunities', database_b: 'accounts', cardinality: 'one_to_many', field_a_name: 'Account', field_b_name: 'Opportunities' },
    { key: 'opp_tasks', database_a: 'tasks', database_b: 'opportunities', cardinality: 'one_to_many', field_a_name: 'Opportunity', field_b_name: 'Tasks' },
  ],
  views: [
    { database: 'opportunities', name: 'Pipeline', type: 'board', group_by_field: 'stage' },
    { database: 'opportunities', name: 'Closing this month', type: 'table', filters: [{ field: 'close', op: 'within', value: 'this_month' }], sorts: [{ field: 'amount', direction: 'desc' }] },
    { database: 'accounts', name: 'All accounts', type: 'table' },
    { database: 'tasks', name: 'My tasks due', type: 'table', filters: [{ field: 'owner', op: 'has', values: ['@me'] }, { field: 'done', op: 'eq', value: false }], sorts: [{ field: 'due', direction: 'asc' }] },
  ],
  records: [
    { key: 'acc1', database: 'accounts', values: { name: 'Northwind Traders (sample)', industry: 'E-commerce', size: '11-50', owner: '@me' } },
    { database: 'contacts', values: { name: 'Dana Fuentes (sample)', email: 'dana@northwind.example', role: 'Head of Growth', primary: true }, links: [{ relation: 'account_contacts', to: 'acc1' }] },
    { key: 'opp1', database: 'opportunities', values: { name: 'Website + funnel retainer (sample)', stage: 'Proposal', amount: 24000, probability: 50, next_step: 'Send revised proposal' }, links: [{ relation: 'account_opps', to: 'acc1' }] },
    { database: 'tasks', values: { name: 'Follow up on proposal (sample)', owner: '@me' }, links: [{ relation: 'opp_tasks', to: 'opp1' }] },
  ],
};
