import { fieldRef, optionRef, SAMPLE_ME, sampleDate, sampleRef } from '@storyos/schemas';
import type { PackRegistryEntry } from '@storyos/schemas';

/**
 * The starter Business Packs (MN-221 / #163).
 *
 * #82 already flagged the six (seven) onboarding starters in
 * `templates/definitions/*.ts` as too simple for real agentic work — schema and
 * sample records, no automation, no agent, nothing that runs. This is their
 * pack-format rebuild, once MN-218's manifest shape existed to rebuild them
 * *into*: every pack below carries forward that starter's databases,
 * relations and sample data, plus what a Business Pack adds that a template
 * cannot — a workflow state with a human gate, a deterministic automation, and
 * an agent bound to a real state transition.
 *
 * ── The human gate, consistently ─────────────────────────────────────────────
 *
 * Every agent below is bound with `human_gate: true`. That is a deliberate,
 * repeated choice, not seven independent ones: each agent drafts something
 * outward-facing or otherwise consequential (a client welcome packet, a
 * follow-up email, session notes, a chapter's revision notes) at exactly the
 * state transition where a business would want a person to decide "yes, run
 * this now" rather than have it fire silently on every record that enters that
 * state (`trigger.subscriber.ts` skips auto-dispatch whenever
 * `human_gate === true` — see its doc). Pair that with each agent's
 * `approval_policy` (already gated on `outward`/`email` per ADR-0010 §4) and a
 * run is reviewed twice: once to launch it, once before anything leaves the
 * workspace.
 *
 * ── What's deliberately left out ─────────────────────────────────────────────
 *
 * No `skills` (#40) — none of the six needs one to demonstrate the loop, and a
 * placeholder skill would be exactly the kind of copy this format exists to
 * avoid. No cross-pack relations (`external_target_name` in the old template
 * DSL) — `ArchitectService.buildRelations` resolves `to` only against
 * databases *this same manifest* declares, so a relation into another pack's
 * database would 422 the moment that other pack is not already installed;
 * every pack below is deliberately self-contained and installs standalone. No
 * sample-record cross-links — `packSampleRecordSchema` carries `values` only
 * (no `links`, unlike the template DSL's), so sample records are illustrative
 * rows, not a linked demo dataset; each pack still ships enough of them, in
 * enough different states, to show the workflow's shape at a glance.
 *
 * ── Relationship to `templates/definitions/*.ts` ─────────────────────────────
 *
 * The old template definitions are untouched by this file: they still power
 * the "what are you working on?" intent-based onboarding
 * (`templates.service.ts` / `INTENTS`), which is a different install path than
 * `PacksService.install`. Rewiring that onboarding flow to install packs
 * instead of static templates is a follow-up, not part of this ticket's scope
 * (see the PR description) — today, these packs live in the Business Packs
 * gallery (`GET /packs/registry`, `apps/web/.../packs/page.tsx`) as the
 * fuller, agentic alternative for the same seven businesses.
 */
export const STARTER_PACKS: PackRegistryEntry[] = [
  // ── 1. Running an agency ──────────────────────────────────────────────────
  {
    slug: 'agency-os',
    name: 'Agency OS',
    summary:
      'Clients, contacts, projects and a full task system — the agency backbone.',
    highlights: [
      'Clients, Contacts, Projects and Tasks, fully related',
      'Client lifecycle: Lead → Onboarding → Active → Paused → Churned',
      'An "Onboarding Assistant" agent drafts a welcome packet — gated, your call to run it',
      'Notifies you when a project’s status changes',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'agency-os',
      name: 'Agency OS',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'Clients, projects and a task system to run an agency, with a gated onboarding agent and a ' +
        'project-status automation.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Clients',
          space: 'Client Work',
          fields: [
            { name: 'Owner', type: 'user' },
            {
              name: 'Industry',
              type: 'select',
              options: [
                { label: 'SaaS' },
                { label: 'E-commerce' },
                { label: 'Publishing' },
                { label: 'Coaching' },
                { label: 'Local business' },
                { label: 'Other' },
              ],
            },
            { name: 'Website', type: 'url' },
            { name: 'Contact Email', type: 'email' },
            { name: 'Monthly Value', type: 'number', config: { format: 'currency' } },
            { name: 'Client Since', type: 'date' },
            {
              name: 'Health',
              type: 'select',
              options: [
                { label: 'Great', color: 'green' },
                { label: 'OK', color: 'blue' },
                { label: 'At risk', color: 'orange' },
                { label: 'On fire', color: 'red' },
              ],
            },
          ],
        },
        {
          action: 'create',
          name: 'Contacts',
          space: 'Client Work',
          fields: [
            { name: 'Role', type: 'text' },
            { name: 'Email', type: 'email' },
            { name: 'Is Decision Maker', type: 'checkbox' },
          ],
        },
        {
          action: 'create',
          name: 'Projects',
          space: 'Client Work',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Scoping', color: 'gray', category: 'unstarted' },
                { label: 'Planning', color: 'blue', category: 'unstarted' },
                { label: 'Active', color: 'green', category: 'started' },
                { label: 'On Hold', color: 'gold', category: 'started' },
                { label: 'Delivered', color: 'teal', category: 'completed' },
                { label: 'Closed', color: 'brown', category: 'completed' },
              ],
            },
            { name: 'Lead', type: 'user' },
            { name: 'Due Date', type: 'date' },
            { name: 'Budget', type: 'number', config: { format: 'currency' } },
          ],
        },
        {
          action: 'create',
          name: 'Tasks',
          space: 'Client Work',
          fields: [
            {
              name: 'State',
              type: 'workflow',
              options: [
                { label: 'Triage', color: 'gray', category: 'backlog' },
                { label: 'Backlog', color: 'gray', category: 'backlog' },
                { label: 'To Do', color: 'blue', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'In Review', color: 'purple', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
                { label: 'Canceled', color: 'brown', category: 'canceled' },
              ],
            },
            {
              name: 'Priority',
              type: 'select',
              options: [
                { label: 'Urgent', color: 'red' },
                { label: 'High', color: 'orange' },
                { label: 'Medium', color: 'blue' },
                { label: 'Low', color: 'gray' },
              ],
            },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [{ label: 'design' }, { label: 'copy' }, { label: 'dev' }, { label: 'client-waiting' }],
            },
            { name: 'Assignee', type: 'user' },
            { name: 'Due Date', type: 'date' },
          ],
        },
      ],
      relations: [
        { from: 'Contacts', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Contacts' },
        { from: 'Projects', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Projects' },
        { from: 'Tasks', to: 'Projects', cardinality: 'one_to_many', from_field: 'Project', to_field: 'Tasks' },
        { from: 'Tasks', to: 'Tasks', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
        { from: 'Tasks', to: 'Tasks', cardinality: 'many_to_many', from_field: 'Blocked by', to_field: 'Blocks' },
      ],
      states: [
        {
          database: 'Clients',
          field: 'Status',
          options: [
            { label: 'Lead', color: 'gray', category: 'backlog' },
            { label: 'Onboarding', color: 'blue', category: 'started' },
            { label: 'Active', color: 'green', category: 'started' },
            { label: 'Paused', color: 'gold', category: 'started' },
            { label: 'Churned', color: 'brown', category: 'canceled' },
          ],
        },
      ],
      agents: [
        {
          name: 'Onboarding Assistant',
          goal: 'Draft a welcome packet and a first-week checklist when a new client enters onboarding.',
          instructions:
            'Read the client record and any linked contacts or projects. Draft a welcome email and a ' +
            'first-week checklist as a comment on the client. Never send anything to the client directly.',
          scopes: ['read', 'write'],
          approval_policy: ['email', 'outward'],
          target_databases: ['Clients', 'Projects'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Onboarding Assistant',
          database: 'Clients',
          state_field: 'Status',
          state_option: 'Onboarding',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Tasks',
          name: 'Task Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Tasks', 'State'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Tasks', 'Priority'), fieldRef('Tasks', 'Assignee'), fieldRef('Tasks', 'Due Date')],
          },
        },
        {
          database: 'Clients',
          name: 'Health Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Clients', 'Health'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Clients', 'Owner'), fieldRef('Clients', 'Monthly Value')],
          },
        },
      ],
      automations: [
        {
          database: 'Projects',
          name: 'Notify on project status change',
          trigger: { type: 'record_updated', field_id: fieldRef('Projects', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'A project’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Clients', values: { name: 'Acme Co (sample)', status: optionRef('Clients', 'Status', 'Onboarding'), health: optionRef('Clients', 'Health', 'OK'), owner: SAMPLE_ME, monthly_value: 4500 } },
        { database: 'Clients', values: { name: 'JCM (sample)', status: optionRef('Clients', 'Status', 'Active'), health: optionRef('Clients', 'Health', 'Great'), owner: SAMPLE_ME, monthly_value: 8200 } },
        { database: 'Clients', values: { name: 'Northwind (sample)', status: optionRef('Clients', 'Status', 'Active'), health: optionRef('Clients', 'Health', 'At risk'), owner: SAMPLE_ME, monthly_value: 2400 } },
        { database: 'Clients', values: { name: 'Bluebird Studio (sample)', status: optionRef('Clients', 'Status', 'Paused'), health: optionRef('Clients', 'Health', 'On fire'), owner: SAMPLE_ME, monthly_value: 1200 } },
        { database: 'Contacts', values: { name: 'Jane Doe (sample)', role: 'Marketing Director', client: [sampleRef('Clients', 'Acme Co (sample)')] } },
        { database: 'Projects', values: { name: 'Website refresh (sample)', status: optionRef('Projects', 'Status', 'Active'), client: [sampleRef('Clients', 'Acme Co (sample)')] } },
        { database: 'Tasks', values: { name: 'Wireframe landing page (sample)', state: optionRef('Tasks', 'State', 'In Progress'), priority: optionRef('Tasks', 'Priority', 'High'), assignee: SAMPLE_ME, due_date: sampleDate(3), project: [sampleRef('Projects', 'Website refresh (sample)')] } },
        { database: 'Tasks', values: { name: 'Write homepage copy (sample)', state: optionRef('Tasks', 'State', 'Triage'), priority: optionRef('Tasks', 'Priority', 'Medium'), assignee: SAMPLE_ME, due_date: sampleDate(7), project: [sampleRef('Projects', 'Website refresh (sample)')] } },
        { database: 'Tasks', values: { name: 'Set up analytics (sample)', state: optionRef('Tasks', 'State', 'To Do'), priority: optionRef('Tasks', 'Priority', 'Medium'), assignee: SAMPLE_ME, due_date: sampleDate(10) } },
        { database: 'Tasks', values: { name: 'Review brand assets (sample)', state: optionRef('Tasks', 'State', 'In Review'), priority: optionRef('Tasks', 'Priority', 'Urgent'), assignee: SAMPLE_ME, due_date: sampleDate(-2) } },
        { database: 'Tasks', values: { name: 'Kickoff call notes (sample)', state: optionRef('Tasks', 'State', 'Done'), priority: optionRef('Tasks', 'Priority', 'Low'), assignee: SAMPLE_ME, due_date: sampleDate(-5) } },
        { database: 'Tasks', values: { name: 'Prepare the first invoice (sample)', state: optionRef('Tasks', 'State', 'Backlog'), priority: optionRef('Tasks', 'Priority', 'Low'), assignee: SAMPLE_ME, due_date: sampleDate(21) } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 2. Onboarding a client ─────────────────────────────────────────────────
  {
    slug: 'client-portal',
    name: 'Client Portal',
    summary:
      'A per-client space you share with the client — tasks with a client-approval workflow, ' +
      'deliverables, meetings and requests.',
    highlights: [
      'Tasks, Deliverables, Meetings and Requests, ready to share with a guest',
      'Client Approval workflow: Not needed → Waiting → Approved → Changes requested',
      'An "Approval Drafter" agent drafts the approval-request message — gated, your call to run it',
      'Notifies you when a deliverable’s status changes',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'client-portal',
      name: 'Client Portal',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'A client-shareable space with tasks, deliverables, meetings and requests, a client-approval ' +
        'gate, and an agent that drafts the approval message.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Tasks',
          space: 'Client Portal',
          fields: [
            {
              name: 'State',
              type: 'workflow',
              options: [
                { label: 'Triage', color: 'gray', category: 'backlog' },
                { label: 'Backlog', color: 'gray', category: 'backlog' },
                { label: 'To Do', color: 'blue', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'In Review', color: 'purple', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
                { label: 'Canceled', color: 'brown', category: 'canceled' },
              ],
            },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [{ label: 'for-client' }, { label: 'waiting-on-client' }, { label: 'in-house' }],
            },
            { name: 'Assignee', type: 'user' },
            { name: 'Due Date', type: 'date' },
          ],
        },
        {
          action: 'create',
          name: 'Deliverables',
          space: 'Client Portal',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Draft', color: 'gray', category: 'unstarted' },
                { label: 'In Review', color: 'gold', category: 'started' },
                { label: 'Approved', color: 'green', category: 'started' },
                { label: 'Delivered', color: 'teal', category: 'completed' },
              ],
            },
            { name: 'Due Date', type: 'date' },
            { name: 'Link', type: 'url' },
          ],
        },
        {
          action: 'create',
          name: 'Meetings',
          space: 'Client Portal',
          fields: [
            { name: 'Date', type: 'date', config: { include_time: true } },
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Kickoff' }, { label: 'Weekly' }, { label: 'Review' }, { label: 'Ad-hoc' }],
            },
            { name: 'Recording', type: 'url' },
          ],
        },
        {
          action: 'create',
          name: 'Requests',
          space: 'Client Portal',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'New', color: 'blue', category: 'unstarted' },
                { label: 'Accepted', color: 'green', category: 'started' },
                { label: 'Declined', color: 'brown', category: 'canceled' },
                { label: 'Done', color: 'teal', category: 'completed' },
              ],
            },
            { name: 'Requested By', type: 'text' },
          ],
        },
      ],
      relations: [
        { from: 'Tasks', to: 'Tasks', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
        { from: 'Tasks', to: 'Tasks', cardinality: 'many_to_many', from_field: 'Blocked by', to_field: 'Blocks' },
        { from: 'Tasks', to: 'Deliverables', cardinality: 'one_to_many', from_field: 'Deliverable', to_field: 'Tasks' },
        { from: 'Tasks', to: 'Meetings', cardinality: 'one_to_many', from_field: 'From meeting', to_field: 'Action items' },
        { from: 'Requests', to: 'Tasks', cardinality: 'one_to_many', from_field: 'Task', to_field: 'Requests' },
      ],
      states: [
        {
          database: 'Tasks',
          field: 'Client Approval',
          options: [
            { label: 'Not needed', color: 'gray', category: 'unstarted' },
            { label: 'Waiting', color: 'gold', category: 'started' },
            { label: 'Approved', color: 'green', category: 'completed' },
            { label: 'Changes requested', color: 'red', category: 'started' },
          ],
        },
      ],
      agents: [
        {
          name: 'Approval Drafter',
          goal:
            'When a task needs client approval, draft a short approval-request message summarizing ' +
            'what’s ready and what the client needs to decide.',
          instructions:
            'Read the task and any linked deliverable. Draft the message as a comment. Never send ' +
            'anything to the client directly — a human sends it from the draft.',
          scopes: ['read', 'write'],
          approval_policy: ['email', 'outward'],
          target_databases: ['Tasks', 'Deliverables'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Approval Drafter',
          database: 'Tasks',
          state_field: 'Client Approval',
          state_option: 'Waiting',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Tasks',
          name: 'Shared Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Tasks', 'State'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Tasks', 'Assignee'), fieldRef('Tasks', 'Due Date'), fieldRef('Tasks', 'Client Approval')],
          },
        },
        {
          database: 'Tasks',
          name: 'Needs Approval',
          type: 'table',
          config: {
            filters: { field: 'client_approval', op: 'has', value: [optionRef('Tasks', 'Client Approval', 'Waiting')] },
          },
        },
        {
          database: 'Deliverables',
          name: 'Delivery Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Deliverables', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Deliverables', 'Due Date')],
          },
        },
      ],
      automations: [
        {
          database: 'Deliverables',
          name: 'Notify on deliverable status change',
          trigger: { type: 'record_updated', field_id: fieldRef('Deliverables', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'A deliverable’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Meetings', values: { name: 'Kickoff call (sample)', date: sampleDate(-6) } },
        { database: 'Deliverables', values: { name: 'Brand guideline v1 (sample)', status: optionRef('Deliverables', 'Status', 'In Review'), due_date: sampleDate(5) } },
        { database: 'Deliverables', values: { name: 'Homepage wireframes (sample)', status: optionRef('Deliverables', 'Status', 'Draft'), due_date: sampleDate(12) } },
        { database: 'Deliverables', values: { name: 'Logo pack (sample)', status: optionRef('Deliverables', 'Status', 'Approved'), due_date: sampleDate(-3) } },
        { database: 'Deliverables', values: { name: 'Launch checklist (sample)', status: optionRef('Deliverables', 'Status', 'Delivered'), due_date: sampleDate(-8) } },
        { database: 'Tasks', values: { name: 'Collect brand assets (sample)', state: optionRef('Tasks', 'State', 'In Progress'), client_approval: optionRef('Tasks', 'Client Approval', 'Not needed'), assignee: SAMPLE_ME, due_date: sampleDate(4) } },
        { database: 'Tasks', values: { name: 'Review the guideline draft (sample)', state: optionRef('Tasks', 'State', 'To Do'), client_approval: optionRef('Tasks', 'Client Approval', 'Waiting'), assignee: SAMPLE_ME, due_date: sampleDate(2) } },
        { database: 'Tasks', values: { name: 'Send the revised logo (sample)', state: optionRef('Tasks', 'State', 'In Review'), client_approval: optionRef('Tasks', 'Client Approval', 'Changes requested'), assignee: SAMPLE_ME, due_date: sampleDate(-1) } },
        { database: 'Tasks', values: { name: 'Approve the homepage wireframe (sample)', state: optionRef('Tasks', 'State', 'In Review'), client_approval: optionRef('Tasks', 'Client Approval', 'Waiting'), assignee: SAMPLE_ME, due_date: sampleDate(5) } },
        { database: 'Tasks', values: { name: 'Publish the style guide (sample)', state: optionRef('Tasks', 'State', 'Done'), client_approval: optionRef('Tasks', 'Client Approval', 'Approved'), assignee: SAMPLE_ME, due_date: sampleDate(-6) } },
        { database: 'Requests', values: { name: 'Add a pricing page (sample)', status: optionRef('Requests', 'Status', 'New'), requested_by: 'Client via email' } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 3. Starting a dev project ─────────────────────────────────────────────
  {
    slug: 'dev-project-os',
    name: 'Dev Project OS',
    summary:
      'Issues with a Triage inbox, sprints, and releases with changelogs.',
    highlights: [
      'Issues, Sprints, Releases and Product Docs, fully related',
      'Full task-DNA workflow: Triage → Backlog → To Do → In Progress → In Review → Done/Canceled',
      'A "Triage Bot" agent proposes type/priority/labels for new issues — gated, your call to run it',
      'Notifies you when a release ships',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'dev-project-os',
      name: 'Dev Project OS',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'Issues, sprints and releases for a dev team, with a gated triage agent and a release-status ' +
        'automation.',
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
              options: [
                { label: 'Urgent', color: 'red' },
                { label: 'High', color: 'orange' },
                { label: 'Medium', color: 'blue' },
                { label: 'Low', color: 'gray' },
              ],
            },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [
                { label: 'bug' },
                { label: 'feature' },
                { label: 'chore' },
                { label: 'docs' },
                { label: 'tech-debt' },
              ],
            },
            { name: 'Assignee', type: 'user' },
            { name: 'Due Date', type: 'date' },
            {
              name: 'Type',
              type: 'select',
              options: [
                { label: 'Bug', color: 'red' },
                { label: 'Feature', color: 'blue' },
                { label: 'Improvement', color: 'teal' },
                { label: 'Chore', color: 'gray' },
              ],
            },
          ],
        },
        {
          action: 'create',
          name: 'Sprints',
          space: 'Product',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Planned', color: 'gray', category: 'unstarted' },
                { label: 'Active', color: 'green', category: 'started' },
                { label: 'Done', color: 'brown', category: 'completed' },
              ],
            },
            { name: 'Start Date', type: 'date' },
            { name: 'End Date', type: 'date' },
            { name: 'Goal', type: 'text' },
          ],
        },
        {
          action: 'create',
          name: 'Releases',
          space: 'Product',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Planned', color: 'gray', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'Released', color: 'green', category: 'completed' },
              ],
            },
            { name: 'Date', type: 'date' },
            { name: 'Link', type: 'url' },
          ],
        },
        {
          action: 'create',
          name: 'Product Docs',
          space: 'Product',
          fields: [
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Spec' }, { label: 'Decision (ADR)' }, { label: 'Runbook' }, { label: 'Idea' }],
            },
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Draft', color: 'gray', category: 'unstarted' },
                { label: 'Agreed', color: 'green', category: 'completed' },
                { label: 'Superseded', color: 'brown', category: 'canceled' },
              ],
            },
            { name: 'Owner', type: 'user' },
          ],
        },
      ],
      relations: [
        { from: 'Issues', to: 'Sprints', cardinality: 'one_to_many', from_field: 'Sprint', to_field: 'Issues' },
        { from: 'Issues', to: 'Releases', cardinality: 'one_to_many', from_field: 'Release', to_field: 'Issues' },
        { from: 'Product Docs', to: 'Issues', cardinality: 'many_to_many', from_field: 'Issues', to_field: 'Docs' },
        { from: 'Issues', to: 'Issues', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
        { from: 'Issues', to: 'Issues', cardinality: 'many_to_many', from_field: 'Blocked by', to_field: 'Blocks' },
      ],
      states: [
        {
          database: 'Issues',
          field: 'State',
          options: [
            { label: 'Triage', color: 'gray', category: 'backlog' },
            { label: 'Backlog', color: 'gray', category: 'backlog' },
            { label: 'To Do', color: 'blue', category: 'unstarted' },
            { label: 'In Progress', color: 'gold', category: 'started' },
            { label: 'In Review', color: 'purple', category: 'started' },
            { label: 'Done', color: 'green', category: 'completed' },
            { label: 'Canceled', color: 'brown', category: 'canceled' },
          ],
        },
      ],
      agents: [
        {
          name: 'Triage Bot',
          goal: 'Read new issues in Triage and propose a type, priority and labels, with a one-line summary.',
          instructions:
            'Never change an issue’s state or assignee — only propose type/priority/labels as a ' +
            'comment. A human moves it out of Triage.',
          scopes: ['read', 'write'],
          approval_policy: ['outward'],
          target_databases: ['Issues'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Triage Bot',
          database: 'Issues',
          state_field: 'State',
          state_option: 'Triage',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Issues',
          name: 'Issue Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Issues', 'State'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Issues', 'Type'), fieldRef('Issues', 'Priority'), fieldRef('Issues', 'Assignee')],
          },
        },
        {
          database: 'Issues',
          name: 'Bugs',
          type: 'table',
          config: { filters: { field: 'type', op: 'has', value: [optionRef('Issues', 'Type', 'Bug')] } },
        },
        {
          database: 'Releases',
          name: 'Release Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Releases', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Releases', 'Date')],
          },
        },
      ],
      automations: [
        {
          database: 'Releases',
          name: 'Notify when a release ships',
          trigger: { type: 'record_updated', field_id: fieldRef('Releases', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'A release’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Sprints', values: { name: 'Sprint 12 (sample)', status: optionRef('Sprints', 'Status', 'Active'), goal: 'Ship the sharing flow' } },
        { database: 'Releases', values: { name: 'v1.4.0 (sample)', status: optionRef('Releases', 'Status', 'In Progress'), date: sampleDate(9) } },
        { database: 'Releases', values: { name: 'v1.3.2 (sample)', status: optionRef('Releases', 'Status', 'Released'), date: sampleDate(-12) } },
        { database: 'Releases', values: { name: 'v1.5.0 (sample)', status: optionRef('Releases', 'Status', 'Planned'), date: sampleDate(30) } },
        { database: 'Issues', values: { name: 'Share dialog loses focus (sample)', state: optionRef('Issues', 'State', 'In Progress'), type: optionRef('Issues', 'Type', 'Bug'), priority: optionRef('Issues', 'Priority', 'High'), assignee: SAMPLE_ME, release: [sampleRef('Releases', 'v1.4.0 (sample)')], sprint: [sampleRef('Sprints', 'Sprint 12 (sample)')] } },
        { database: 'Issues', values: { name: 'Add keyboard shortcuts (sample)', state: optionRef('Issues', 'State', 'Triage'), type: optionRef('Issues', 'Type', 'Feature'), priority: optionRef('Issues', 'Priority', 'Medium'), assignee: SAMPLE_ME } },
        { database: 'Issues', values: { name: 'Slow board scroll on 5k cards (sample)', state: optionRef('Issues', 'State', 'In Review'), type: optionRef('Issues', 'Type', 'Improvement'), priority: optionRef('Issues', 'Priority', 'High'), assignee: SAMPLE_ME } },
        { database: 'Issues', values: { name: 'Update dependency versions (sample)', state: optionRef('Issues', 'State', 'To Do'), type: optionRef('Issues', 'Type', 'Chore'), priority: optionRef('Issues', 'Priority', 'Low'), assignee: SAMPLE_ME } },
        { database: 'Issues', values: { name: 'Fix duplicate welcome emails (sample)', state: optionRef('Issues', 'State', 'Done'), type: optionRef('Issues', 'Type', 'Bug'), priority: optionRef('Issues', 'Priority', 'Urgent'), assignee: SAMPLE_ME } },
        { database: 'Issues', values: { name: 'Dark mode contrast pass (sample)', state: optionRef('Issues', 'State', 'Backlog'), type: optionRef('Issues', 'Type', 'Improvement'), priority: optionRef('Issues', 'Priority', 'Medium'), assignee: SAMPLE_ME } },
        { database: 'Product Docs', values: { name: 'Sharing model spec (sample)', type: optionRef('Product Docs', 'Type', 'Spec'), status: optionRef('Product Docs', 'Status', 'Agreed') } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 4. Launching a blog / content engine ──────────────────────────────────
  {
    slug: 'content-engine',
    name: 'Content Engine',
    summary:
      'Articles through an editorial board, topic clusters, and campaigns.',
    highlights: [
      'Articles, Topics and Campaigns, fully related',
      'Editorial workflow: Idea → Brief → Writing → Editing → Design → Ready → Published',
      'A "Draft Assistant" agent writes a first outline from the brief — gated, your call to run it',
      'Notifies you when an article’s stage changes',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'content-engine',
      name: 'Content Engine',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'An editorial pipeline with topic clusters and campaigns, a gated drafting agent, and a ' +
        'stage-change automation.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Articles',
          space: 'Content',
          fields: [
            {
              name: 'Content Type',
              type: 'select',
              options: [
                { label: 'Blog post' },
                { label: 'Newsletter' },
                { label: 'Case study' },
                { label: 'Landing page' },
              ],
            },
            { name: 'Author', type: 'user' },
            { name: 'Editor', type: 'user' },
            { name: 'Target Publish Date', type: 'date' },
            { name: 'Primary Keyword', type: 'text' },
            { name: 'Published URL', type: 'url' },
            { name: 'Word Count', type: 'number' },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [{ label: 'pillar' }, { label: 'seo' }, { label: 'launch' }, { label: 'evergreen' }],
            },
            { name: 'Idea Rating (1-5)', type: 'number' },
            { name: 'Draft', type: 'rich_text' },
          ],
        },
        {
          action: 'create',
          name: 'Topics',
          space: 'Content',
          fields: [
            {
              name: 'Priority',
              type: 'select',
              options: [
                { label: 'Now', color: 'red' },
                { label: 'Next', color: 'gold' },
                { label: 'Later', color: 'gray' },
              ],
            },
            { name: 'Search Volume /mo', type: 'number' },
          ],
        },
        {
          action: 'create',
          name: 'Campaigns',
          space: 'Content',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Planned', color: 'blue', category: 'unstarted' },
                { label: 'Running', color: 'gold', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
              ],
            },
            { name: 'Owner', type: 'user' },
            { name: 'Budget', type: 'number', config: { format: 'currency' } },
          ],
        },
      ],
      relations: [
        { from: 'Articles', to: 'Campaigns', cardinality: 'many_to_many', from_field: 'Campaigns', to_field: 'Articles' },
        { from: 'Articles', to: 'Topics', cardinality: 'many_to_many', from_field: 'Topics', to_field: 'Articles' },
      ],
      states: [
        {
          database: 'Articles',
          field: 'Stage',
          options: [
            { label: 'Idea', color: 'gray', category: 'backlog' },
            { label: 'Brief', color: 'blue', category: 'unstarted' },
            { label: 'Writing', color: 'gold', category: 'started' },
            { label: 'Editing', color: 'purple', category: 'started' },
            { label: 'Design', color: 'pink', category: 'started' },
            { label: 'Ready', color: 'teal', category: 'started' },
            { label: 'Published', color: 'green', category: 'completed' },
          ],
        },
      ],
      agents: [
        {
          name: 'Draft Assistant',
          goal: 'When an article enters Brief, draft a first outline from the brief and keyword to speed up the writer.',
          instructions:
            'Write into the Draft field as a starting outline, not a finished piece. Never change the ' +
            'Stage or publish anything.',
          scopes: ['read', 'write'],
          approval_policy: ['outward'],
          target_databases: ['Articles'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Draft Assistant',
          database: 'Articles',
          state_field: 'Stage',
          state_option: 'Brief',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Articles',
          name: 'Editorial Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Articles', 'Stage'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Articles', 'Author'), fieldRef('Articles', 'Content Type'), fieldRef('Articles', 'Target Publish Date')],
          },
        },
        {
          database: 'Articles',
          name: 'Ideas to rate',
          type: 'table',
          config: { filters: { field: 'stage', op: 'has', value: [optionRef('Articles', 'Stage', 'Idea')] } },
        },
        {
          database: 'Topics',
          name: 'Topic map',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Topics', 'Priority'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Topics', 'Search Volume /mo')],
          },
        },
      ],
      automations: [
        {
          database: 'Articles',
          name: 'Notify when an article’s stage changes',
          trigger: { type: 'record_updated', field_id: fieldRef('Articles', 'Stage') },
          actions: [{ type: 'notify_user', user: '@me', message: 'An article’s stage changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Campaigns', values: { name: 'Q3 launch (sample)', status: optionRef('Campaigns', 'Status', 'Running') } },
        { database: 'Articles', values: { name: 'Why stories beat pitches (sample)', stage: optionRef('Articles', 'Stage', 'Writing'), content_type: optionRef('Articles', 'Content Type', 'Blog post'), author: SAMPLE_ME, target_publish_date: sampleDate(6) } },
        { database: 'Articles', values: { name: 'Launch announcement (sample)', stage: optionRef('Articles', 'Stage', 'Brief'), content_type: optionRef('Articles', 'Content Type', 'Newsletter'), author: SAMPLE_ME, target_publish_date: sampleDate(10) } },
        { database: 'Articles', values: { name: 'Case study draft (sample)', stage: optionRef('Articles', 'Stage', 'Idea'), content_type: optionRef('Articles', 'Content Type', 'Case study'), author: SAMPLE_ME, target_publish_date: sampleDate(20) } },
        { database: 'Articles', values: { name: 'Pricing page rewrite (sample)', stage: optionRef('Articles', 'Stage', 'Editing'), content_type: optionRef('Articles', 'Content Type', 'Landing page'), author: SAMPLE_ME, target_publish_date: sampleDate(-2) } },
        { database: 'Articles', values: { name: 'Welcome email series (sample)', stage: optionRef('Articles', 'Stage', 'Published'), content_type: optionRef('Articles', 'Content Type', 'Newsletter'), author: SAMPLE_ME, target_publish_date: sampleDate(-9) } },
        { database: 'Topics', values: { name: 'Onboarding funnels (sample)', priority: optionRef('Topics', 'Priority', 'Now'), search_volume_mo: 2400 } },
        { database: 'Topics', values: { name: 'Story-led pricing (sample)', priority: optionRef('Topics', 'Priority', 'Next'), search_volume_mo: 880 } },
        { database: 'Topics', values: { name: 'Founder narratives (sample)', priority: optionRef('Topics', 'Priority', 'Later'), search_volume_mo: 320 } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 5. Writing a book ──────────────────────────────────────────────────────
  {
    slug: 'book-launch',
    name: 'Book Launch',
    summary:
      'A manuscript board of chapters, research notes, launch tasks and appearances.',
    highlights: [
      'Books, Chapters, Research Notes, Launch & Marketing and Appearances, fully related',
      'Manuscript workflow: Outline → Draft → Revised → Final',
      'A "Revision Assistant" agent proposes pacing/continuity notes — gated, your call to run it',
      'Notifies you when a chapter is finalized',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'book-launch',
      name: 'Book Launch',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'A manuscript board, research notes and a launch campaign, with a gated revision agent and a ' +
        'chapter-finalized automation.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Books',
          space: 'Writing',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Idea', color: 'gray', category: 'backlog' },
                { label: 'Proposal', color: 'blue', category: 'unstarted' },
                { label: 'Writing', color: 'gold', category: 'started' },
                { label: 'Editing', color: 'purple', category: 'started' },
                { label: 'Production', color: 'teal', category: 'started' },
                { label: 'Published', color: 'green', category: 'completed' },
              ],
            },
            { name: 'Genre', type: 'text' },
            { name: 'Target Word Count', type: 'number' },
            { name: 'Current Word Count', type: 'number' },
            { name: 'Deadline', type: 'date' },
          ],
        },
        {
          action: 'create',
          name: 'Chapters',
          space: 'Writing',
          fields: [
            { name: 'Order', type: 'number' },
            { name: 'Word Count', type: 'number' },
            { name: 'POV / Theme', type: 'text' },
          ],
        },
        {
          action: 'create',
          name: 'Research Notes',
          space: 'Writing',
          fields: [
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Interview' }, { label: 'Article' }, { label: 'Book' }, { label: 'Quote' }],
            },
            { name: 'Source', type: 'url' },
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'To read', color: 'blue', category: 'unstarted' },
                { label: 'Processed', color: 'green', category: 'completed' },
              ],
            },
          ],
        },
        {
          action: 'create',
          name: 'Launch & Marketing',
          space: 'Writing',
          fields: [
            {
              name: 'State',
              type: 'workflow',
              options: [
                { label: 'Triage', color: 'gray', category: 'backlog' },
                { label: 'Backlog', color: 'gray', category: 'backlog' },
                { label: 'To Do', color: 'blue', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'In Review', color: 'purple', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
                { label: 'Canceled', color: 'brown', category: 'canceled' },
              ],
            },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [{ label: 'podcast' }, { label: 'newsletter' }, { label: 'social' }, { label: 'pr' }],
            },
            { name: 'Assignee', type: 'user' },
          ],
        },
        {
          action: 'create',
          name: 'Appearances',
          space: 'Writing',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Wishlist', color: 'gray', category: 'backlog' },
                { label: 'Pitched', color: 'blue', category: 'started' },
                { label: 'Booked', color: 'gold', category: 'started' },
                { label: 'Aired', color: 'green', category: 'completed' },
              ],
            },
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Podcast' }, { label: 'Stage' }, { label: 'Webinar' }, { label: 'Guest post' }],
            },
            { name: 'Show / Event', type: 'text' },
            { name: 'Date', type: 'date' },
          ],
        },
      ],
      relations: [
        { from: 'Chapters', to: 'Books', cardinality: 'one_to_many', from_field: 'Book', to_field: 'Chapters' },
        { from: 'Research Notes', to: 'Chapters', cardinality: 'many_to_many', from_field: 'Chapters', to_field: 'Research' },
        { from: 'Launch & Marketing', to: 'Books', cardinality: 'one_to_many', from_field: 'Book', to_field: 'Launch tasks' },
        { from: 'Launch & Marketing', to: 'Launch & Marketing', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
        { from: 'Launch & Marketing', to: 'Launch & Marketing', cardinality: 'many_to_many', from_field: 'Blocked by', to_field: 'Blocks' },
      ],
      states: [
        {
          database: 'Chapters',
          field: 'Status',
          options: [
            { label: 'Outline', color: 'gray', category: 'unstarted' },
            { label: 'Draft', color: 'gold', category: 'started' },
            { label: 'Revised', color: 'purple', category: 'started' },
            { label: 'Final', color: 'green', category: 'completed' },
          ],
        },
      ],
      agents: [
        {
          name: 'Revision Assistant',
          goal:
            'When a chapter moves to Draft, propose revision notes — pacing, continuity, and where ' +
            'linked research notes should be cited.',
          instructions:
            'Write suggestions as a comment on the chapter. Never edit the chapter text directly or ' +
            'change its Status.',
          scopes: ['read', 'write'],
          approval_policy: ['outward'],
          target_databases: ['Chapters', 'Research Notes'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Revision Assistant',
          database: 'Chapters',
          state_field: 'Status',
          state_option: 'Draft',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Chapters',
          name: 'Manuscript Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Chapters', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Chapters', 'Order'), fieldRef('Chapters', 'Word Count')],
          },
        },
        {
          database: 'Chapters',
          name: 'In Order',
          type: 'table',
          config: { sorts: [{ field: 'order', direction: 'asc' }] },
        },
        {
          database: 'Appearances',
          name: 'Pitch Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Appearances', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Appearances', 'Type'), fieldRef('Appearances', 'Show / Event'), fieldRef('Appearances', 'Date')],
          },
        },
      ],
      automations: [
        {
          database: 'Chapters',
          name: 'Notify when a chapter is finalized',
          trigger: { type: 'record_updated', field_id: fieldRef('Chapters', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'A chapter’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Books', values: { name: 'The Story Engine (sample)', status: optionRef('Books', 'Status', 'Writing'), target_word_count: 60000, current_word_count: 21500 } },
        { database: 'Chapters', values: { name: 'Ch 1 — Why stories win (sample)', status: optionRef('Chapters', 'Status', 'Final'), order: 1, word_count: 3800 } },
        { database: 'Chapters', values: { name: 'Ch 2 — The narrative arc (sample)', status: optionRef('Chapters', 'Status', 'Draft'), order: 2, word_count: 4200 } },
        { database: 'Chapters', values: { name: 'Ch 3 — The turning point (sample)', status: optionRef('Chapters', 'Status', 'Revised'), order: 3, word_count: 3600 } },
        { database: 'Chapters', values: { name: 'Ch 4 — Resolution (sample)', status: optionRef('Chapters', 'Status', 'Outline'), order: 4, word_count: 600 } },
        { database: 'Research Notes', values: { name: 'Campbell — hero journey notes (sample)', type: optionRef('Research Notes', 'Type', 'Book'), status: optionRef('Research Notes', 'Status', 'Processed') } },
        { database: 'Launch & Marketing', values: { name: 'Pitch 10 podcasts (sample)', state: optionRef('Launch & Marketing', 'State', 'To Do') } },
        { database: 'Appearances', values: { name: 'The Creative Pen podcast (sample)', status: optionRef('Appearances', 'Status', 'Pitched'), type: optionRef('Appearances', 'Type', 'Podcast'), show_event: 'The Creative Pen', date: sampleDate(14) } },
        { database: 'Appearances', values: { name: 'Authors on Stage summit (sample)', status: optionRef('Appearances', 'Status', 'Booked'), type: optionRef('Appearances', 'Type', 'Stage'), show_event: 'Authors on Stage', date: sampleDate(40) } },
        { database: 'Appearances', values: { name: 'Writers Hour webinar (sample)', status: optionRef('Appearances', 'Status', 'Aired'), type: optionRef('Appearances', 'Type', 'Webinar'), show_event: 'Writers Hour', date: sampleDate(-10) } },
        { database: 'Appearances', values: { name: 'Indie Book Show (sample)', status: optionRef('Appearances', 'Status', 'Wishlist'), type: optionRef('Appearances', 'Type', 'Podcast'), show_event: 'Indie Book Show', date: sampleDate(60) } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 6. Running a coaching practice ────────────────────────────────────────
  {
    slug: 'coaching-os',
    name: 'Coaching OS',
    summary:
      'Clients enrolled in programs, sessions as the calendar spine, and action items for ' +
      'accountability.',
    highlights: [
      'Clients, Programs, Sessions and Action Items, fully related',
      'Session workflow: Scheduled → Done / No-show / Rescheduled / Canceled',
      'A "Session Notes Assistant" agent drafts notes and action items — gated, your call to run it',
      'Notifies you when a client’s status changes',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'coaching-os',
      name: 'Coaching OS',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'Clients, programs and sessions for a coaching practice, with a gated session-notes agent and ' +
        'a client-status automation.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Clients',
          space: 'Coaching',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Discovery', color: 'gray', category: 'unstarted' },
                { label: 'Proposal', color: 'blue', category: 'unstarted' },
                { label: 'Active', color: 'green', category: 'started' },
                { label: 'Paused', color: 'gold', category: 'started' },
                { label: 'Alumni', color: 'purple', category: 'completed' },
              ],
            },
            { name: 'Email', type: 'email' },
            { name: 'Start Date', type: 'date' },
            { name: 'Renewal Date', type: 'date' },
            { name: 'Price Paid', type: 'number', config: { format: 'currency' } },
            { name: 'Goal', type: 'text' },
          ],
        },
        {
          action: 'create',
          name: 'Programs',
          space: 'Coaching',
          fields: [
            {
              name: 'Type',
              type: 'select',
              options: [{ label: '1:1' }, { label: 'Group' }, { label: 'Cohort' }, { label: 'Course' }],
            },
            { name: 'Price', type: 'number', config: { format: 'currency' } },
            { name: 'Length', type: 'text' },
          ],
        },
        {
          action: 'create',
          name: 'Sessions',
          space: 'Coaching',
          fields: [
            { name: 'Date', type: 'date', config: { include_time: true } },
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Kickoff' }, { label: 'Regular' }, { label: 'Review' }, { label: 'Emergency' }],
            },
            { name: 'Recording', type: 'url' },
          ],
        },
        {
          action: 'create',
          name: 'Action Items',
          space: 'Coaching',
          fields: [
            {
              name: 'State',
              type: 'workflow',
              options: [
                { label: 'Triage', color: 'gray', category: 'backlog' },
                { label: 'Backlog', color: 'gray', category: 'backlog' },
                { label: 'To Do', color: 'blue', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'In Review', color: 'purple', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
                { label: 'Canceled', color: 'brown', category: 'canceled' },
              ],
            },
            {
              name: 'Who',
              type: 'select',
              options: [
                { label: 'Client', color: 'blue' },
                { label: 'Me', color: 'gold' },
              ],
            },
            { name: 'Due Date', type: 'date' },
          ],
        },
      ],
      relations: [
        { from: 'Clients', to: 'Programs', cardinality: 'one_to_many', from_field: 'Program', to_field: 'Clients' },
        { from: 'Sessions', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Sessions' },
        { from: 'Action Items', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Action items' },
        { from: 'Action Items', to: 'Sessions', cardinality: 'one_to_many', from_field: 'Session', to_field: 'Action items' },
      ],
      states: [
        {
          database: 'Sessions',
          field: 'Status',
          options: [
            { label: 'Scheduled', color: 'blue', category: 'unstarted' },
            { label: 'Done', color: 'green', category: 'completed' },
            { label: 'No-show', color: 'red', category: 'canceled' },
            { label: 'Rescheduled', color: 'gold', category: 'unstarted' },
            { label: 'Canceled', color: 'brown', category: 'canceled' },
          ],
        },
      ],
      agents: [
        {
          name: 'Session Notes Assistant',
          goal:
            'When a session is marked Done, draft session notes and suggested action items for the ' +
            'client from the coach’s raw notes.',
          instructions:
            'Draft into a comment on the session. Never message the client directly, and never create ' +
            'action items without a human confirming them first.',
          scopes: ['read', 'write'],
          approval_policy: ['email', 'outward'],
          target_databases: ['Sessions', 'Action Items'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Session Notes Assistant',
          database: 'Sessions',
          state_field: 'Status',
          state_option: 'Done',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Sessions',
          name: 'Session Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Sessions', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Sessions', 'Client'), fieldRef('Sessions', 'Date'), fieldRef('Sessions', 'Type')],
          },
        },
        {
          database: 'Clients',
          name: 'Client Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Clients', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Clients', 'Program'), fieldRef('Clients', 'Renewal Date')],
          },
        },
      ],
      automations: [
        {
          database: 'Clients',
          name: 'Notify on client status change',
          trigger: { type: 'record_updated', field_id: fieldRef('Clients', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'A client’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Programs', values: { name: '1:1 Executive coaching (sample)', type: optionRef('Programs', 'Type', '1:1'), length: '6 months' } },
        { database: 'Programs', values: { name: 'Leadership mastermind (sample)', type: optionRef('Programs', 'Type', 'Group'), length: '3 months' } },
        { database: 'Clients', values: { name: 'Sarah M (sample)', status: optionRef('Clients', 'Status', 'Active'), program: [sampleRef('Programs', '1:1 Executive coaching (sample)')], renewal_date: sampleDate(45), goal: 'Step into the CEO role' } },
        { database: 'Clients', values: { name: 'Marcus T (sample)', status: optionRef('Clients', 'Status', 'Discovery'), program: [sampleRef('Programs', '1:1 Executive coaching (sample)')], renewal_date: sampleDate(90) } },
        { database: 'Clients', values: { name: 'Priya K (sample)', status: optionRef('Clients', 'Status', 'Proposal'), program: [sampleRef('Programs', 'Leadership mastermind (sample)')], renewal_date: sampleDate(60) } },
        { database: 'Clients', values: { name: 'Dan O (sample)', status: optionRef('Clients', 'Status', 'Alumni'), program: [sampleRef('Programs', 'Leadership mastermind (sample)')], renewal_date: sampleDate(-20) } },
        { database: 'Sessions', values: { name: 'Session 4 — delegation (sample)', status: optionRef('Sessions', 'Status', 'Done'), type: optionRef('Sessions', 'Type', 'Regular'), client: [sampleRef('Clients', 'Sarah M (sample)')], date: sampleDate(-7) } },
        { database: 'Sessions', values: { name: 'Session 5 — the board deck (sample)', status: optionRef('Sessions', 'Status', 'Scheduled'), type: optionRef('Sessions', 'Type', 'Regular'), client: [sampleRef('Clients', 'Sarah M (sample)')], date: sampleDate(5) } },
        { database: 'Sessions', values: { name: 'Kickoff — Marcus (sample)', status: optionRef('Sessions', 'Status', 'Scheduled'), type: optionRef('Sessions', 'Type', 'Kickoff'), client: [sampleRef('Clients', 'Marcus T (sample)')], date: sampleDate(2) } },
        { database: 'Sessions', values: { name: 'Review — Priya (sample)', status: optionRef('Sessions', 'Status', 'Rescheduled'), type: optionRef('Sessions', 'Type', 'Review'), client: [sampleRef('Clients', 'Priya K (sample)')], date: sampleDate(12) } },
        { database: 'Action Items', values: { name: 'Write the delegation list (sample)', state: optionRef('Action Items', 'State', 'To Do'), who: optionRef('Action Items', 'Who', 'Client') } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },

  // ── 7. Consulting engagements ──────────────────────────────────────────────
  {
    slug: 'consulting-os',
    name: 'Consulting OS',
    summary:
      'Proposal pipeline, engagements with hours budgets, and delivery tasks.',
    highlights: [
      'Clients, Proposals, Engagements and Deliverables & Tasks, fully related',
      'Proposal pipeline: Draft → Sent → Negotiating → Won / Lost',
      'A "Follow-up Drafter" agent drafts the follow-up email — gated, your call to run it',
      'Notifies you when an engagement’s status changes',
    ],
    manifest: {
      format_version: 1,
      license: 'All rights reserved',
      attribution: 'StoryOS',
      slug: 'consulting-os',
      name: 'Consulting OS',
      version: '1.0.0',
      scenario: 'pack',
      summary:
        'A proposal pipeline and engagement tracker for consulting work, with a gated follow-up agent ' +
        'and an engagement-status automation.',
      requires: { connections: [], ai: 'byo' },
      databases: [
        {
          action: 'create',
          name: 'Clients',
          space: 'Consulting',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Prospect', color: 'gray', category: 'unstarted' },
                { label: 'Active', color: 'green', category: 'started' },
                { label: 'Past', color: 'brown', category: 'completed' },
              ],
            },
            {
              name: 'Industry',
              type: 'select',
              options: [{ label: 'SaaS' }, { label: 'Finance' }, { label: 'Health' }, { label: 'Retail' }],
            },
            { name: 'Contact Email', type: 'email' },
            { name: 'Owner', type: 'user' },
          ],
        },
        {
          action: 'create',
          name: 'Proposals',
          space: 'Consulting',
          fields: [
            { name: 'Value', type: 'number', config: { format: 'currency' } },
            {
              name: 'Type',
              type: 'select',
              options: [{ label: 'Audit' }, { label: 'Retainer' }, { label: 'Project' }, { label: 'Workshop' }],
            },
            { name: 'Sent Date', type: 'date' },
            { name: 'Expected Close', type: 'date' },
          ],
        },
        {
          action: 'create',
          name: 'Engagements',
          space: 'Consulting',
          fields: [
            {
              name: 'Status',
              type: 'workflow',
              options: [
                { label: 'Kickoff', color: 'blue', category: 'unstarted' },
                { label: 'Active', color: 'green', category: 'started' },
                { label: 'Wrapping', color: 'gold', category: 'started' },
                { label: 'Done', color: 'teal', category: 'completed' },
                { label: 'Renewed', color: 'purple', category: 'completed' },
              ],
            },
            { name: 'Start Date', type: 'date' },
            { name: 'End Date', type: 'date' },
            { name: 'Monthly Value', type: 'number', config: { format: 'currency' } },
            { name: 'Hours Budget', type: 'number' },
            { name: 'Hours Used', type: 'number' },
          ],
        },
        {
          action: 'create',
          name: 'Deliverables & Tasks',
          space: 'Consulting',
          fields: [
            {
              name: 'State',
              type: 'workflow',
              options: [
                { label: 'Triage', color: 'gray', category: 'backlog' },
                { label: 'Backlog', color: 'gray', category: 'backlog' },
                { label: 'To Do', color: 'blue', category: 'unstarted' },
                { label: 'In Progress', color: 'gold', category: 'started' },
                { label: 'In Review', color: 'purple', category: 'started' },
                { label: 'Done', color: 'green', category: 'completed' },
                { label: 'Canceled', color: 'brown', category: 'canceled' },
              ],
            },
            {
              name: 'Labels',
              type: 'multi_select',
              options: [{ label: 'research' }, { label: 'workshop' }, { label: 'report' }, { label: 'analysis' }],
            },
            { name: 'Assignee', type: 'user' },
          ],
        },
      ],
      relations: [
        { from: 'Proposals', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Proposals' },
        { from: 'Engagements', to: 'Clients', cardinality: 'one_to_many', from_field: 'Client', to_field: 'Engagements' },
        { from: 'Engagements', to: 'Proposals', cardinality: 'one_to_many', from_field: 'Proposal', to_field: 'Engagements' },
        { from: 'Deliverables & Tasks', to: 'Engagements', cardinality: 'one_to_many', from_field: 'Engagement', to_field: 'Deliverables' },
        { from: 'Deliverables & Tasks', to: 'Deliverables & Tasks', cardinality: 'one_to_many', from_field: 'Parent task', to_field: 'Sub-tasks' },
        { from: 'Deliverables & Tasks', to: 'Deliverables & Tasks', cardinality: 'many_to_many', from_field: 'Blocked by', to_field: 'Blocks' },
      ],
      states: [
        {
          database: 'Proposals',
          field: 'Stage',
          options: [
            { label: 'Draft', color: 'gray', category: 'unstarted' },
            { label: 'Sent', color: 'gold', category: 'started' },
            { label: 'Negotiating', color: 'orange', category: 'started' },
            { label: 'Won', color: 'green', category: 'completed' },
            { label: 'Lost', color: 'brown', category: 'canceled' },
          ],
        },
      ],
      agents: [
        {
          name: 'Follow-up Drafter',
          goal: 'When a proposal moves to Negotiating, draft a follow-up email addressing likely objections and next steps.',
          instructions:
            'Draft only — never send. Write the draft as a comment on the proposal for the owner to ' +
            'review and send.',
          scopes: ['read', 'write'],
          approval_policy: ['email', 'outward'],
          target_databases: ['Proposals', 'Clients'],
          skills: [],
          // "StoryOS doesn't sell AI, bring yours": a built-in pack's agents run on the owner's own AI (never metered, MN-188) unless a person picks otherwise.
          ai_mode: 'your_own_ai',
        },
      ],
      triggers: [
        {
          agent: 'Follow-up Drafter',
          database: 'Proposals',
          state_field: 'Stage',
          state_option: 'Negotiating',
          human_gate: true,
        },
      ],
      derived_fields: [],
      views: [
        {
          database: 'Proposals',
          name: 'Pipeline Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Proposals', 'Stage'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Proposals', 'Client'), fieldRef('Proposals', 'Value'), fieldRef('Proposals', 'Expected Close')],
          },
        },
        {
          database: 'Engagements',
          name: 'Engagement Board',
          type: 'board',
          config: {
            group_by_field_id: fieldRef('Engagements', 'Status'),
            // #1012 (Dara's review) — 2–3 fields a person acts on at a glance: who, how urgent, when, for whom. No free text or URLs. The grouped field is the column, so it is never listed (the board never shows it on a card).
            card_field_ids: [fieldRef('Engagements', 'Client'), fieldRef('Engagements', 'End Date'), fieldRef('Engagements', 'Monthly Value')],
          },
        },
      ],
      automations: [
        {
          database: 'Engagements',
          name: 'Notify on engagement status change',
          trigger: { type: 'record_updated', field_id: fieldRef('Engagements', 'Status') },
          actions: [{ type: 'notify_user', user: '@me', message: 'An engagement’s status changed.' }],
          enabled: true,
        },
      ],
      sample_records: [
        { database: 'Clients', values: { name: 'Meridian Health (sample)', status: optionRef('Clients', 'Status', 'Active'), industry: optionRef('Clients', 'Industry', 'Health') } },
        { database: 'Clients', values: { name: 'Atlas Logistics (sample)', status: optionRef('Clients', 'Status', 'Active') } },
        { database: 'Clients', values: { name: 'Orbit Software (sample)', status: optionRef('Clients', 'Status', 'Active') } },
        { database: 'Proposals', values: { name: 'Growth audit Q3 (sample)', stage: optionRef('Proposals', 'Stage', 'Negotiating'), type: optionRef('Proposals', 'Type', 'Audit'), value: 15000, client: [sampleRef('Clients', 'Meridian Health (sample)')], expected_close: sampleDate(14) } },
        { database: 'Proposals', values: { name: 'Retainer renewal (sample)', stage: optionRef('Proposals', 'Stage', 'Sent'), type: optionRef('Proposals', 'Type', 'Retainer'), value: 8000, client: [sampleRef('Clients', 'Atlas Logistics (sample)')], expected_close: sampleDate(21) } },
        { database: 'Proposals', values: { name: 'Pricing workshop (sample)', stage: optionRef('Proposals', 'Stage', 'Won'), type: optionRef('Proposals', 'Type', 'Workshop'), value: 4500, client: [sampleRef('Clients', 'Orbit Software (sample)')], expected_close: sampleDate(-4) } },
        { database: 'Proposals', values: { name: 'Brand audit (sample)', stage: optionRef('Proposals', 'Stage', 'Draft'), type: optionRef('Proposals', 'Type', 'Audit'), value: 6000, client: [sampleRef('Clients', 'Meridian Health (sample)')], expected_close: sampleDate(30) } },
        { database: 'Engagements', values: { name: 'Meridian growth audit (sample)', status: optionRef('Engagements', 'Status', 'Active'), monthly_value: 5000, client: [sampleRef('Clients', 'Meridian Health (sample)')], end_date: sampleDate(60), hours_budget: 40, hours_used: 12 } },
        { database: 'Engagements', values: { name: 'Atlas retainer (sample)', status: optionRef('Engagements', 'Status', 'Wrapping'), monthly_value: 3200, client: [sampleRef('Clients', 'Atlas Logistics (sample)')], end_date: sampleDate(10) } },
        { database: 'Engagements', values: { name: 'Orbit workshop (sample)', status: optionRef('Engagements', 'Status', 'Done'), monthly_value: 1500, client: [sampleRef('Clients', 'Orbit Software (sample)')], end_date: sampleDate(-15) } },
        { database: 'Engagements', values: { name: 'Harbor kickoff (sample)', status: optionRef('Engagements', 'Status', 'Kickoff'), monthly_value: 2800, client: [sampleRef('Clients', 'Meridian Health (sample)')], end_date: sampleDate(120) } },
        { database: 'Deliverables & Tasks', values: { name: 'Stakeholder interviews (sample)', state: optionRef('Deliverables & Tasks', 'State', 'In Progress') } },
      ],
      skills: [],
      suggested_sources: [],
    },
  },
];
