import { fieldRef, optionRef, sampleDate, sampleRef, SAMPLE_ME } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * ticket #1201 (PR 1 of 2) - Deal Desk: the pack for a business that sells services and wants every deal, quote and hand-off in one place.
 * Built from Dara's spec on the ticket (prototype v67, Business Packs > Deal Desk); the wording of why / can / summary is the prototype's.
 *
 * PR 1 was the data half (8 databases, 11 links, 8 views, 28 samples). PR 2 adds the 5 automations, 2 scheduled rules (the stalled-deals digest and
 * Deal Coach's Monday review) and the 3 agents (Deal Coach, Call Debrief, Hand-off Writer).
 *
 * Builds on Agency OS (`requires.packs`, #1197): Accounts link to Agency OS's Clients, and Agency OS's Projects link back to the deal
 * they came from. `Clients` and `Projects` are declared here only so those two links have somewhere to land: when Agency OS is installed
 * they are LINKED to its databases (and gain just the link field); when it is not, the person chooses between installing it too and
 * having this pack create them (`create_here`, the default).
 *
 * Money: Amount and Unit price are numbers formatted as currency (USD). Line total is a currency FORMULA (#1200) and the Quote's Total is
 * a rollup SUM of it. Unit price stays typed on purpose: a rollup will not sum a formula that reads a lookup (List price is a lookup).
 *
 * Ordering rule that matters: a formula is created in field order, so Line total is declared AFTER Qty, Unit price and Discount %.
 */
const USD = { format: 'currency', currency_code: 'USD' } as const;

const OPEN_STAGES = { field: 'stage', op: 'category_is_not', value: ['completed', 'canceled'] };

export const DEAL_DESK_PACK: PackRegistryEntry = {
  slug: 'deal-desk',
  name: 'Deal Desk',
  summary:
    'Every deal, quote and hand-off in one place: a pipeline board, quotes built from your price list, and a link into Agency OS.',
  highlights: [
    'Accounts, Contacts, Deals and Activities, fully linked',
    'A Pipeline board by stage, with Won and Lost out of the way',
    'Quotes built line by line from a price list, with totals that add up',
    'Nudges for stalled deals and expiring quotes, and a weekly digest of the deals gone quiet',
    'Three agents (Deal Coach, Call Debrief, Hand-off Writer) that ask before changing anything, and wake only when you switch them on',
    'Links to Agency OS: each account to its client, each project to the deal it came from',
  ],
  manifest: {
    format_version: 1,
    license: 'All rights reserved',
    attribution: 'StoryOS',
    slug: 'deal-desk',
    name: 'Deal Desk',
    version: '1.0.0',
    why: 'You sell services to other businesses and want every deal, quote and hand-off to delivery in one place.',
    can: [
      'See the whole pipeline by stage and get nudged when a deal goes quiet',
      'Build a quote from your price list, line by line',
      'Turn a won deal into an Agency OS project, after you approve it',
    ],
    scenario: 'pack',
    summary:
      'Every deal, quote and hand-off in one place: a pipeline board, quotes built from your price list, and a link into Agency OS.',
    requires: {
      connections: [],
      ai: 'byo',
      packs: [{ pack: 'agency-os', databases: ['Clients', 'Contacts', 'Projects'], note: 'Accounts link to your agency clients, contacts are shared, and a won deal hands off to a project.' }],
    },
    databases: [
      {
        action: 'create',
        name: 'Accounts',
        space: 'Sales',
        fields: [
          {
            name: 'Status',
            type: 'select',
            options: [
              { label: 'Prospect', color: 'gray' },
              { label: 'Working', color: 'blue' },
              { label: 'Customer', color: 'green' },
              { label: 'Disqualified', color: 'red' },
            ],
          },
          { name: 'Owner', type: 'user' },
          {
            // Agency OS Clients' own options, so an account and its client describe the industry in the same words.
            name: 'Industry',
            type: 'select',
            options: [{ label: 'SaaS' }, { label: 'E-commerce' }, { label: 'Publishing' }, { label: 'Coaching' }, { label: 'Local business' }, { label: 'Other' }],
          },
          { name: 'Website', type: 'url' },
        ],
      },
      {
        action: 'create',
        name: 'Contacts',
        space: 'Sales',
        fields: [
          { name: 'Role', type: 'text' },
          { name: 'Email', type: 'email' },
          // There is no phone field type: a phone number is text.
          { name: 'Phone', type: 'text' },
          {
            name: 'Buying role',
            type: 'select',
            options: [
              { label: 'Decision maker', color: 'green' },
              { label: 'Champion', color: 'blue' },
              { label: 'Influencer', color: 'purple' },
              { label: 'Blocker', color: 'red' },
            ],
          },
        ],
      },
      {
        action: 'create',
        name: 'Deals',
        space: 'Sales',
        fields: [
          { name: 'Amount', type: 'number', config: { ...USD, precision: 0 } },
          { name: 'Close date', type: 'date' },
          { name: 'Owner', type: 'user' },
          { name: 'Next step', type: 'text' },
          { name: 'Next step date', type: 'date' },
          {
            name: 'Source',
            type: 'select',
            options: [{ label: 'Referral' }, { label: 'Website' }, { label: 'Outbound' }, { label: 'Event' }, { label: 'Other' }],
          },
          {
            name: 'Lost reason',
            type: 'select',
            options: [{ label: 'Price' }, { label: 'Timing' }, { label: 'Went with a competitor' }, { label: 'No decision' }, { label: 'Not a fit' }],
          },
        ],
      },
      {
        action: 'create',
        name: 'Activities',
        space: 'Sales',
        fields: [
          {
            name: 'Type',
            type: 'select',
            options: [{ label: 'Call' }, { label: 'Meeting' }, { label: 'Email' }, { label: 'Note' }],
          },
          { name: 'Date', type: 'date', config: { include_time: true } },
          { name: 'Notes', type: 'text', config: { multiline: true } },
        ],
      },
      {
        // The quote page IS the proposal: its body is the proposal text.
        action: 'create',
        name: 'Quotes',
        space: 'Sales',
        fields: [{ name: 'Valid until', type: 'date' }],
      },
      {
        action: 'create',
        name: 'Quote Lines',
        space: 'Sales',
        fields: [
          { name: 'Qty', type: 'number' },
          { name: 'Unit price', type: 'number', config: { ...USD, precision: 2 } },
          { name: 'Discount %', type: 'number' },
          {
            // Declared after its three inputs. A missing discount counts as 0.
            name: 'Line total',
            type: 'formula',
            config: {
              expression: '{Qty} * {Unit price} * (1 - coalesce({Discount %}, 0) / 100)',
              format: 'currency',
              currency_code: 'USD',
              precision: 2,
            },
          },
        ],
      },
      {
        action: 'create',
        name: 'Products',
        space: 'Sales',
        fields: [
          { name: 'Price', type: 'number', config: { ...USD, precision: 2 } },
          { name: 'Billing', type: 'select', options: [{ label: 'One-off' }, { label: 'Monthly' }, { label: 'Hourly' }] },
          { name: 'Active', type: 'checkbox' },
        ],
      },
      {
        action: 'create',
        name: 'Competitors',
        space: 'Sales',
        fields: [
          { name: 'Website', type: 'url' },
          { name: 'Where they beat us', type: 'text', config: { multiline: true } },
        ],
      },
      // Agency OS's two databases (in `Sales`, not `Client Work`: observed in the test, with the space set to Agency OS's `Client Work` the install did link them but reported `created_here`), declared so the two links below have somewhere to land (see the note at the top). They carry no fields of
      // their own here: linked, they gain only the link field; created here, they are a title and that link.
      { action: 'create', name: 'Clients', space: 'Sales', fields: [] },
      { action: 'create', name: 'Projects', space: 'Sales', fields: [] },
    ],
    relations: [
      { from: 'Contacts', to: 'Accounts', cardinality: 'one_to_many', from_field: 'Account', to_field: 'Contacts' },
      { from: 'Deals', to: 'Accounts', cardinality: 'one_to_many', from_field: 'Account', to_field: 'Deals' },
      { from: 'Activities', to: 'Deals', cardinality: 'one_to_many', from_field: 'Deal', to_field: 'Activities' },
      { from: 'Deals', to: 'Contacts', cardinality: 'many_to_many', from_field: 'Contacts', to_field: 'Deals' },
      { from: 'Quotes', to: 'Deals', cardinality: 'one_to_many', from_field: 'Deal', to_field: 'Quotes' },
      { from: 'Quote Lines', to: 'Quotes', cardinality: 'one_to_many', from_field: 'Quote', to_field: 'Lines' },
      { from: 'Quote Lines', to: 'Products', cardinality: 'one_to_many', from_field: 'Product', to_field: 'Quote lines' },
      { from: 'Deals', to: 'Competitors', cardinality: 'many_to_many', from_field: 'Competitors', to_field: 'Deals' },
      { from: 'Activities', to: 'Contacts', cardinality: 'one_to_many', from_field: 'Contact', to_field: 'Activities' },
      // The two links into Agency OS (requires.packs).
      { from: 'Accounts', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Sales accounts' },
      { from: 'Projects', to: 'Deals', cardinality: 'one_to_many', from_field: 'Source deal', to_field: 'Projects' },
    ],
    states: [
      {
        database: 'Deals',
        field: 'Stage',
        options: [
          { label: 'Lead', color: 'gray', category: 'backlog' },
          { label: 'Qualified', color: 'blue', category: 'unstarted' },
          { label: 'Discovery', color: 'purple', category: 'started' },
          { label: 'Proposal', color: 'purple', category: 'started' },
          { label: 'Negotiation', color: 'orange', category: 'started' },
          { label: 'Won', color: 'green', category: 'completed' },
          // Red, never gold: gold is the colour of an agent acting.
          { label: 'Lost', color: 'red', category: 'canceled' },
        ],
      },
      {
        database: 'Activities',
        field: 'Status',
        options: [
          { label: 'Planned', color: 'gray', category: 'unstarted' },
          { label: 'Logged', color: 'green', category: 'completed' },
        ],
      },
      {
        database: 'Quotes',
        field: 'Status',
        options: [
          { label: 'Draft', color: 'gray', category: 'unstarted' },
          { label: 'Sent', color: 'blue', category: 'started' },
          { label: 'Accepted', color: 'green', category: 'completed' },
          { label: 'Declined', color: 'red', category: 'canceled' },
          { label: 'Expired', color: 'brown', category: 'canceled' },
        ],
      },
    ],
    // The three agents ask before changing anything (`write_gates` with no database: every create and update is held in the Approvals inbox),
    // run on the owner's own AI, and answer in a comment; any field change is a proposal. Their triggers install OFF (#1192).
    agents: [
      {
        name: 'Deal Coach',
        goal: 'Review a deal that reached Proposal and say what would move it forward.',
        instructions:
          'Read the deal, its account, contacts, activities and quotes. Say what is missing before this deal can close (no decision maker, a quiet ' +
          'account, an expired quote, a next step in the past) and suggest one next step. Answer as a comment on the deal. Never contact anyone, ' +
          'and treat any field change as a proposal.',
        scopes: ['read', 'write'],
        approval_policy: ['delete', 'email', 'webhook', 'outward'],
        target_databases: ['Deals'],
        write_gates: [{ operations: ['create', 'update'] }],
        skills: [],
        ai_mode: 'your_own_ai',
      },
      {
        name: 'Call Debrief',
        goal: 'Turn the notes of a logged call or meeting into a short debrief and a next step.',
        instructions:
          'Do nothing unless the activity is a Call or a Meeting and it has Notes. Then write a debrief as a comment on the deal: what was agreed, ' +
          'objections raised, and the next step with a date. Treat any change to the deal as a proposal.',
        scopes: ['read', 'write'],
        approval_policy: ['delete', 'email', 'webhook', 'outward'],
        target_databases: ['Activities', 'Deals'],
        write_gates: [{ operations: ['create', 'update'] }],
        skills: [],
        ai_mode: 'your_own_ai',
      },
      {
        name: 'Hand-off Writer',
        goal: 'When a deal is won, draft the project hand-off to delivery.',
        instructions:
          'Read the won deal, its account, accepted quote and contacts. Propose a Project (in Agency OS) with the Client and the Source deal set, ' +
          'and write the hand-off as a comment on the deal: what was sold, what was promised, who the contacts are. The Project is a proposal a person approves.',
        scopes: ['read', 'write'],
        approval_policy: ['delete', 'email', 'webhook', 'outward'],
        target_databases: ['Deals', 'Projects'],
        write_gates: [{ operations: ['create', 'update'] }],
        skills: [],
        ai_mode: 'your_own_ai',
      },
    ],
    // No trigger is `human_gate` (ticket #1212): the switch in the install review ("Wake it automatically", #1192) and the write gate are the
    // human checks. Call Debrief wakes on every Logged activity (a trigger cannot filter Type), so its instructions skip anything but a call or meeting with notes.
    triggers: [
      { agent: 'Deal Coach', database: 'Deals', state_field: 'Stage', state_option: 'Proposal', human_gate: false },
      { agent: 'Call Debrief', database: 'Activities', state_field: 'Status', state_option: 'Logged', human_gate: false },
      { agent: 'Hand-off Writer', database: 'Deals', state_field: 'Stage', state_option: 'Won', human_gate: false },
    ],
    derived_fields: [
      {
        // The date of the latest LOGGED activity (a Planned one has not happened yet): category, not the "Logged" option, so a state added later still counts.
        database: 'Deals',
        name: 'Last activity',
        type: 'rollup',
        config: {
          relation_field_id: fieldRef('Deals', 'Activities'),
          op: 'last',
          target_field_api_name: 'date',
          order_by_field_api_name: 'date',
          filter: { field: 'status', op: 'category_is', value: ['completed'] },
        },
      },
      {
        // A rollup SUM of a currency formula (#1200). The rollup itself shows a plain number: it takes no currency format.
        database: 'Quotes',
        name: 'Total',
        type: 'rollup',
        config: { relation_field_id: fieldRef('Quotes', 'Lines'), op: 'sum', target_field_api_name: 'line_total' },
      },
      {
        // The product's price next to the line, to compare with the typed Unit price. A lookup: nothing sums it.
        database: 'Quote Lines',
        name: 'List price',
        type: 'lookup',
        config: { relation_field_id: fieldRef('Quote Lines', 'Product'), target_field_api_name: 'price' },
      },
      {
        // How many deals this competitor won: the linked deals that are Lost (category canceled).
        database: 'Competitors',
        name: 'Deals lost to them',
        type: 'rollup',
        config: {
          relation_field_id: fieldRef('Competitors', 'Deals'),
          op: 'count',
          filter: { field: 'stage', op: 'category_is', value: ['canceled'] },
        },
      },
    ],
    views: [
      {
        database: 'Deals',
        name: 'Pipeline',
        type: 'board',
        default: true,
        config: {
          group_by_field_id: fieldRef('Deals', 'Stage'),
          card_field_ids: [fieldRef('Deals', 'Amount'), fieldRef('Deals', 'Owner'), fieldRef('Deals', 'Close date')],
          // Won and Lost are outcomes, not pipeline: hidden by choice (#1182), so a deal moved there leaves the board.
          hidden_option_ids: [optionRef('Deals', 'Stage', 'Won'), optionRef('Deals', 'Stage', 'Lost')],
          hide_empty_no_value_group: true,
        },
      },
      {
        database: 'Deals',
        name: 'My open deals',
        type: 'table',
        config: { filters: { and: [{ field: 'owner', op: 'has', value: ['me'] }, OPEN_STAGES] } },
      },
      {
        database: 'Deals',
        name: 'Closing this month',
        type: 'table',
        config: {
          filters: { and: [{ field: 'close_date', op: 'within', value: 'this_month' }, OPEN_STAGES] },
          sorts: [{ field: 'close_date', direction: 'asc' }],
        },
      },
      {
        database: 'Deals',
        name: 'Why we lose',
        type: 'board',
        config: {
          group_by_field_id: fieldRef('Deals', 'Lost reason'),
          filters: { field: 'stage', op: 'category_is', value: ['canceled'] },
        },
      },
      {
        database: 'Quotes',
        name: 'Quote board',
        type: 'board',
        default: true,
        config: { group_by_field_id: fieldRef('Quotes', 'Status') },
      },
      {
        database: 'Products',
        name: 'Price list',
        type: 'table',
        default: true,
        config: { filters: { field: 'active', op: 'eq', value: true } },
      },
      {
        database: 'Accounts',
        name: 'Accounts',
        type: 'table',
        default: true,
        config: { group_by_field_id: fieldRef('Accounts', 'Status') },
      },
      {
        database: 'Activities',
        name: 'This week',
        type: 'calendar',
        default: true,
        config: { date_field_id: fieldRef('Activities', 'Date') },
      },
    ],
    // Five rules from the spec, then two on the scheduled-rule features (#1198, #1199). Only "Won -> Slack" leaves the workspace, so it installs OFF
    // (#1107, whatever `enabled` says here); the Monday review runs an agent, so it installs OFF too. The rest are ON.
    automations: [
      {
        database: 'Deals',
        name: 'Stalled deal nudge',
        trigger: { type: 'schedule', every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5] },
        condition: { and: [OPEN_STAGES, { field: 'next_step_date', op: 'before', value: '$date:+0d' }] },
        actions: [{ type: 'notify_user', user: 'owner', message: 'The next step on this deal is overdue: set a new one.' }],
        enabled: true,
      },
      {
        database: 'Deals',
        name: 'Lost needs a reason',
        trigger: { type: 'record_updated', field_id: fieldRef('Deals', 'Stage') },
        condition: { and: [{ field: 'stage', op: 'category_is', value: ['canceled'] }, { field: 'lost_reason', op: 'is_empty' }] },
        actions: [{ type: 'notify_user', user: 'owner', message: 'This deal is Lost with no reason: add one so Why we lose stays true.' }],
        enabled: true,
      },
      {
        database: 'Quotes',
        name: 'Expire old quotes',
        trigger: { type: 'schedule', every: 'day', at: '06:00' },
        condition: { and: [{ field: 'status', op: 'category_is', value: ['started'] }, { field: 'valid_until', op: 'before', value: '$date:+0d' }] },
        actions: [{ type: 'set_values', values: { status: optionRef('Quotes', 'Status', 'Expired') } }],
        enabled: true,
      },
      {
        // The one rule that changes another record, so it asks first (require_approval): accepting a quote proposes the deal is Won.
        database: 'Quotes',
        name: 'Accepted quote moves the deal to Won',
        trigger: { type: 'record_updated', field_id: fieldRef('Quotes', 'Status') },
        condition: { field: 'status', op: 'category_is', value: ['completed'] },
        actions: [
          {
            type: 'update_linked',
            relation_field_id: fieldRef('Quotes', 'Deal'),
            values: { stage: optionRef('Deals', 'Stage', 'Won') },
            require_approval: true,
          },
        ],
        enabled: true,
      },
      {
        // No channel: the workspace's default Slack channel. Leaves the workspace, so it installs OFF.
        database: 'Deals',
        name: 'Won: tell Slack',
        trigger: { type: 'record_updated', field_id: fieldRef('Deals', 'Stage') },
        condition: { field: 'stage', op: 'category_is', value: ['completed'] },
        actions: [{ type: 'send_slack_message', text: 'Deal won: {Name} ({Amount}). Time to hand it off.' }],
        enabled: false,
      },
      {
        // #1199: a weekly digest of the 5 open deals nobody has touched the longest (sort + limit on a scheduled rule); each one tells its owner.
        database: 'Deals',
        name: 'Stalled deals digest',
        trigger: { type: 'schedule', every: 'week', weekday: 1, at: '09:00' },
        condition: OPEN_STAGES,
        actions: [{ type: 'notify_user', user: 'owner', message: 'One of the 5 open deals that has gone quiet the longest: {Name}.' }],
        sort: [{ field: 'updated_at', direction: 'asc' }],
        limit: 5,
        enabled: true,
      },
      {
        // #1198: Deal Coach reviews the pipeline every Monday. It runs an agent, so it installs OFF until a person switches it on.
        database: 'Deals',
        name: 'Monday pipeline review',
        trigger: { type: 'schedule', every: 'week', weekday: 1, at: '08:00' },
        condition: OPEN_STAGES,
        actions: [{ type: 'run_agent', agent: '$agent:deal-coach', target: 'trigger_record' }],
        enabled: true,
      },
    ],
    // 28 records, each titled "(sample)". Listed in the order a link needs: a record can only point at one listed before it.
    sample_records: [
      { database: 'Products', values: { name: 'Strategy workshop (sample)', price: 2500, billing: optionRef('Products', 'Billing', 'One-off'), active: true } },
      { database: 'Products', values: { name: 'Monthly retainer (sample)', price: 1200, billing: optionRef('Products', 'Billing', 'Monthly'), active: true } },
      { database: 'Products', values: { name: 'Hourly support (sample)', price: 150, billing: optionRef('Products', 'Billing', 'Hourly'), active: true } },
      { database: 'Products', values: { name: 'Legacy audit (sample)', price: 4000, billing: optionRef('Products', 'Billing', 'One-off'), active: false } },
      { database: 'Competitors', values: { name: 'Northwind Agency (sample)', where_they_beat_us: 'Lower day rate on small projects.' } },
      { database: 'Competitors', values: { name: 'Bluepeak Studio (sample)', where_they_beat_us: 'Already inside the buyer’s other accounts.' } },
      {
        database: 'Accounts',
        values: { name: 'Brightside Retail (sample)', status: optionRef('Accounts', 'Status', 'Working'), owner: SAMPLE_ME, industry: optionRef('Accounts', 'Industry', 'E-commerce') },
      },
      {
        database: 'Accounts',
        values: { name: 'Harbor Coaching (sample)', status: optionRef('Accounts', 'Status', 'Customer'), owner: SAMPLE_ME, industry: optionRef('Accounts', 'Industry', 'Coaching') },
      },
      {
        database: 'Accounts',
        values: { name: 'Lumen Software (sample)', status: optionRef('Accounts', 'Status', 'Prospect'), owner: SAMPLE_ME, industry: optionRef('Accounts', 'Industry', 'SaaS') },
      },
      // One contact per buying role.
      {
        database: 'Contacts',
        values: { name: 'Dana Whitfield (sample)', role: 'Head of Marketing', buying_role: optionRef('Contacts', 'Buying role', 'Decision maker'), account: [sampleRef('Accounts', 'Brightside Retail (sample)')] },
      },
      {
        database: 'Contacts',
        values: { name: 'Sam Okafor (sample)', role: 'Marketing Manager', buying_role: optionRef('Contacts', 'Buying role', 'Champion'), account: [sampleRef('Accounts', 'Brightside Retail (sample)')] },
      },
      {
        database: 'Contacts',
        values: { name: 'Priya Raman (sample)', role: 'Operations Lead', buying_role: optionRef('Contacts', 'Buying role', 'Influencer'), account: [sampleRef('Accounts', 'Harbor Coaching (sample)')] },
      },
      {
        database: 'Contacts',
        values: { name: 'Tomas Berg (sample)', role: 'Finance Director', buying_role: optionRef('Contacts', 'Buying role', 'Blocker'), account: [sampleRef('Accounts', 'Lumen Software (sample)')] },
      },
      // Each deal teaches one move; the title says which.
      {
        database: 'Deals',
        values: {
          name: 'Drag me to Qualified (sample)',
          stage: optionRef('Deals', 'Stage', 'Lead'),
          amount: 4000,
          owner: SAMPLE_ME,
          source: optionRef('Deals', 'Source', 'Website'),
          account: [sampleRef('Accounts', 'Lumen Software (sample)')],
          contacts: [sampleRef('Contacts', 'Tomas Berg (sample)')],
        },
      },
      {
        database: 'Deals',
        values: {
          name: 'My next step is overdue: set a new one (sample)',
          stage: optionRef('Deals', 'Stage', 'Discovery'),
          amount: 12000,
          close_date: sampleDate(21),
          owner: SAMPLE_ME,
          next_step: 'Send the scoping questions',
          next_step_date: sampleDate(-2),
          source: optionRef('Deals', 'Source', 'Referral'),
          account: [sampleRef('Accounts', 'Harbor Coaching (sample)')],
          contacts: [sampleRef('Contacts', 'Priya Raman (sample)')],
        },
      },
      {
        database: 'Deals',
        values: {
          name: 'Open my quote and mark it Accepted (sample)',
          stage: optionRef('Deals', 'Stage', 'Proposal'),
          amount: 8100,
          close_date: sampleDate(10),
          owner: SAMPLE_ME,
          next_step: 'Chase the signature',
          next_step_date: sampleDate(3),
          source: optionRef('Deals', 'Source', 'Outbound'),
          account: [sampleRef('Accounts', 'Brightside Retail (sample)')],
          contacts: [sampleRef('Contacts', 'Dana Whitfield (sample)'), sampleRef('Contacts', 'Sam Okafor (sample)')],
          competitors: [sampleRef('Competitors', 'Northwind Agency (sample)')],
        },
      },
      {
        database: 'Deals',
        values: {
          name: 'A won deal (sample)',
          stage: optionRef('Deals', 'Stage', 'Won'),
          amount: 9500,
          close_date: sampleDate(-5),
          owner: SAMPLE_ME,
          source: optionRef('Deals', 'Source', 'Event'),
          account: [sampleRef('Accounts', 'Harbor Coaching (sample)')],
          contacts: [sampleRef('Contacts', 'Priya Raman (sample)')],
        },
      },
      {
        database: 'Deals',
        values: {
          name: 'A lost deal, with its reason (sample)',
          stage: optionRef('Deals', 'Stage', 'Lost'),
          amount: 6000,
          close_date: sampleDate(-12),
          owner: SAMPLE_ME,
          source: optionRef('Deals', 'Source', 'Outbound'),
          lost_reason: optionRef('Deals', 'Lost reason', 'Went with a competitor'),
          account: [sampleRef('Accounts', 'Lumen Software (sample)')],
          contacts: [sampleRef('Contacts', 'Tomas Berg (sample)')],
          competitors: [sampleRef('Competitors', 'Bluepeak Studio (sample)')],
        },
      },
      {
        database: 'Quotes',
        values: {
          name: 'Brightside rollout quote (sample)',
          status: optionRef('Quotes', 'Status', 'Sent'),
          valid_until: sampleDate(14),
          deal: [sampleRef('Deals', 'Open my quote and mark it Accepted (sample)')],
        },
        description: 'A workshop to set the plan, then three months of retainer. Open the quote, then mark it Accepted.',
      },
      {
        database: 'Quotes',
        values: {
          name: 'Harbor onboarding quote (sample)',
          status: optionRef('Quotes', 'Status', 'Accepted'),
          valid_until: sampleDate(-8),
          deal: [sampleRef('Deals', 'A won deal (sample)')],
        },
        description: 'The accepted quote behind the won deal.',
      },
      {
        database: 'Quote Lines',
        values: {
          name: 'Strategy workshop (sample line)',
          qty: 1,
          unit_price: 2500,
          quote: [sampleRef('Quotes', 'Brightside rollout quote (sample)')],
          product: [sampleRef('Products', 'Strategy workshop (sample)')],
        },
      },
      {
        // The one discounted line: 3 x 1200 less 10%.
        database: 'Quote Lines',
        values: {
          name: 'Monthly retainer (sample line)',
          qty: 3,
          unit_price: 1200,
          discount: 10,
          quote: [sampleRef('Quotes', 'Brightside rollout quote (sample)')],
          product: [sampleRef('Products', 'Monthly retainer (sample)')],
        },
      },
      {
        database: 'Quote Lines',
        values: {
          name: 'Onboarding audit (sample line)',
          qty: 1,
          unit_price: 4000,
          quote: [sampleRef('Quotes', 'Harbor onboarding quote (sample)')],
          product: [sampleRef('Products', 'Legacy audit (sample)')],
        },
      },
      {
        database: 'Quote Lines',
        values: {
          name: 'Hourly support (sample line)',
          qty: 10,
          unit_price: 150,
          quote: [sampleRef('Quotes', 'Harbor onboarding quote (sample)')],
          product: [sampleRef('Products', 'Hourly support (sample)')],
        },
      },
      {
        database: 'Activities',
        values: {
          name: 'Follow up on the proposal (sample)',
          status: optionRef('Activities', 'Status', 'Planned'),
          type: optionRef('Activities', 'Type', 'Email'),
          date: sampleDate(2),
          deal: [sampleRef('Deals', 'Open my quote and mark it Accepted (sample)')],
          contact: [sampleRef('Contacts', 'Dana Whitfield (sample)')],
        },
      },
      {
        database: 'Activities',
        values: {
          name: 'Scoping call with Priya (sample)',
          status: optionRef('Activities', 'Status', 'Planned'),
          type: optionRef('Activities', 'Type', 'Call'),
          date: sampleDate(1),
          deal: [sampleRef('Deals', 'My next step is overdue: set a new one (sample)')],
          contact: [sampleRef('Contacts', 'Priya Raman (sample)')],
        },
      },
      {
        // The one logged call with notes: what a debrief would summarise.
        database: 'Activities',
        values: {
          name: 'Discovery call with Dana (sample)',
          status: optionRef('Activities', 'Status', 'Logged'),
          type: optionRef('Activities', 'Type', 'Call'),
          date: sampleDate(-3),
          notes: 'Wants a plan before the spring campaign. Budget is agreed up to 8k. Sam will pull last year’s numbers. Worried about handover time.',
          deal: [sampleRef('Deals', 'Open my quote and mark it Accepted (sample)')],
          contact: [sampleRef('Contacts', 'Dana Whitfield (sample)')],
        },
      },
      {
        database: 'Activities',
        values: {
          name: 'Sent the proposal (sample)',
          status: optionRef('Activities', 'Status', 'Logged'),
          type: optionRef('Activities', 'Type', 'Email'),
          date: sampleDate(-1),
          deal: [sampleRef('Deals', 'Open my quote and mark it Accepted (sample)')],
          contact: [sampleRef('Contacts', 'Sam Okafor (sample)')],
        },
      },
    ],
    skills: [],
    suggested_sources: [],
  },
};
