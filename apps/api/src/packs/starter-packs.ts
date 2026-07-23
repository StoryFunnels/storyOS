import { fieldRef, optionRef } from '@storyos/schemas';
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
      'Clients, contacts, projects and a full task system — the agency backbone. A client entering ' +
      'Onboarding gates in an assistant that drafts their welcome packet.',
    highlights: [
      'Clients, Contacts, Projects and Tasks, fully related',
      'Client lifecycle: Lead → Onboarding → Active → Paused → Churned',
      'An "Onboarding Assistant" agent drafts a welcome packet — gated, your call to run it',
      'Notifies you when a project’s status changes',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Scoping', color: 'gray' },
                { label: 'Planning', color: 'blue' },
                { label: 'Active', color: 'green' },
                { label: 'On Hold', color: 'gold' },
                { label: 'Delivered', color: 'teal' },
                { label: 'Closed', color: 'brown' },
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
              type: 'select',
              options: [
                { label: 'Triage', color: 'gray' },
                { label: 'Backlog', color: 'gray' },
                { label: 'To Do', color: 'blue' },
                { label: 'In Progress', color: 'gold' },
                { label: 'In Review', color: 'purple' },
                { label: 'Done', color: 'green' },
                { label: 'Canceled', color: 'brown' },
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
            { label: 'Lead', color: 'gray' },
            { label: 'Onboarding', color: 'blue' },
            { label: 'Active', color: 'green' },
            { label: 'Paused', color: 'gold' },
            { label: 'Churned', color: 'brown' },
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
          config: { group_by_field_id: fieldRef('Tasks', 'State') },
        },
        {
          database: 'Clients',
          name: 'Health Board',
          type: 'board',
          config: { group_by_field_id: fieldRef('Clients', 'Health') },
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
        { database: 'Clients', values: { name: 'Acme Co (sample)', status: optionRef('Clients', 'Status', 'Onboarding'), health: optionRef('Clients', 'Health', 'OK') } },
        { database: 'Clients', values: { name: 'JCM (sample)', status: optionRef('Clients', 'Status', 'Active'), health: optionRef('Clients', 'Health', 'Great') } },
        { database: 'Contacts', values: { name: 'Jane Doe (sample)', role: 'Marketing Director' } },
        { database: 'Projects', values: { name: 'Website refresh (sample)', status: optionRef('Projects', 'Status', 'Active') } },
        { database: 'Tasks', values: { name: 'Wireframe landing page (sample)', state: optionRef('Tasks', 'State', 'In Progress') } },
        { database: 'Tasks', values: { name: 'Write homepage copy (sample)', state: optionRef('Tasks', 'State', 'Triage') } },
      ],
      skills: [],
    },
  },

  // ── 2. Onboarding a client ─────────────────────────────────────────────────
  {
    slug: 'client-portal',
    name: 'Client Portal',
    summary:
      'A per-client space you share with the client — tasks with a client-approval workflow, ' +
      'deliverables, meetings and requests. A task waiting on approval gates in a draft response.',
    highlights: [
      'Tasks, Deliverables, Meetings and Requests, ready to share with a guest',
      'Client Approval workflow: Not needed → Waiting → Approved → Changes requested',
      'An "Approval Drafter" agent drafts the approval-request message — gated, your call to run it',
      'Notifies you when a deliverable’s status changes',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Triage', color: 'gray' },
                { label: 'Backlog', color: 'gray' },
                { label: 'To Do', color: 'blue' },
                { label: 'In Progress', color: 'gold' },
                { label: 'In Review', color: 'purple' },
                { label: 'Done', color: 'green' },
                { label: 'Canceled', color: 'brown' },
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
              type: 'select',
              options: [
                { label: 'Draft', color: 'gray' },
                { label: 'In Review', color: 'gold' },
                { label: 'Approved', color: 'green' },
                { label: 'Delivered', color: 'teal' },
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
              type: 'select',
              options: [
                { label: 'New', color: 'blue' },
                { label: 'Accepted', color: 'green' },
                { label: 'Declined', color: 'brown' },
                { label: 'Done', color: 'teal' },
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
            { label: 'Not needed', color: 'gray' },
            { label: 'Waiting', color: 'gold' },
            { label: 'Approved', color: 'green' },
            { label: 'Changes requested', color: 'red' },
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
          config: { group_by_field_id: fieldRef('Tasks', 'State') },
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
          config: { group_by_field_id: fieldRef('Deliverables', 'Status') },
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
        { database: 'Meetings', values: { name: 'Kickoff call (sample)' } },
        { database: 'Deliverables', values: { name: 'Brand guideline v1 (sample)', status: optionRef('Deliverables', 'Status', 'In Review') } },
        { database: 'Tasks', values: { name: 'Collect brand assets (sample)', state: optionRef('Tasks', 'State', 'In Progress'), client_approval: optionRef('Tasks', 'Client Approval', 'Not needed') } },
        { database: 'Tasks', values: { name: 'Review the guideline draft (sample)', state: optionRef('Tasks', 'State', 'To Do'), client_approval: optionRef('Tasks', 'Client Approval', 'Waiting') } },
        { database: 'Requests', values: { name: 'Add a pricing page (sample)', status: optionRef('Requests', 'Status', 'New'), requested_by: 'Client via email' } },
      ],
      skills: [],
    },
  },

  // ── 3. Starting a dev project ─────────────────────────────────────────────
  {
    slug: 'dev-project-os',
    name: 'Dev Project OS',
    summary:
      'Issues with a Triage inbox, sprints and releases with changelogs. A new issue in Triage gates ' +
      'in a bot that proposes its type, priority and labels.',
    highlights: [
      'Issues, Sprints, Releases and Product Docs, fully related',
      'Full task-DNA workflow: Triage → Backlog → To Do → In Progress → In Review → Done/Canceled',
      'A "Triage Bot" agent proposes type/priority/labels for new issues — gated, your call to run it',
      'Notifies you when a release ships',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Planned', color: 'gray' },
                { label: 'Active', color: 'green' },
                { label: 'Done', color: 'brown' },
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
              type: 'select',
              options: [
                { label: 'Planned', color: 'gray' },
                { label: 'In Progress', color: 'gold' },
                { label: 'Released', color: 'green' },
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
              type: 'select',
              options: [
                { label: 'Draft', color: 'gray' },
                { label: 'Agreed', color: 'green' },
                { label: 'Superseded', color: 'brown' },
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
            { label: 'Triage', color: 'gray' },
            { label: 'Backlog', color: 'gray' },
            { label: 'To Do', color: 'blue' },
            { label: 'In Progress', color: 'gold' },
            { label: 'In Review', color: 'purple' },
            { label: 'Done', color: 'green' },
            { label: 'Canceled', color: 'brown' },
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
          config: { group_by_field_id: fieldRef('Issues', 'State') },
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
          config: { group_by_field_id: fieldRef('Releases', 'Status') },
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
        { database: 'Releases', values: { name: 'v1.4.0 (sample)', status: optionRef('Releases', 'Status', 'In Progress') } },
        { database: 'Issues', values: { name: 'Share dialog loses focus (sample)', state: optionRef('Issues', 'State', 'In Progress'), type: optionRef('Issues', 'Type', 'Bug') } },
        { database: 'Issues', values: { name: 'Add keyboard shortcuts (sample)', state: optionRef('Issues', 'State', 'Triage'), type: optionRef('Issues', 'Type', 'Feature') } },
        { database: 'Product Docs', values: { name: 'Sharing model spec (sample)', type: optionRef('Product Docs', 'Type', 'Spec'), status: optionRef('Product Docs', 'Status', 'Agreed') } },
      ],
      skills: [],
    },
  },

  // ── 4. Launching a blog / content engine ──────────────────────────────────
  {
    slug: 'content-engine',
    name: 'Content Engine',
    summary:
      'Articles through an editorial board, topic clusters, and campaigns. An article entering Brief ' +
      'gates in an assistant that drafts the first outline.',
    highlights: [
      'Articles, Topics and Campaigns, fully related',
      'Editorial workflow: Idea → Brief → Writing → Editing → Design → Ready → Published',
      'A "Draft Assistant" agent writes a first outline from the brief — gated, your call to run it',
      'Notifies you when an article’s stage changes',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Planned', color: 'blue' },
                { label: 'Running', color: 'gold' },
                { label: 'Done', color: 'green' },
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
            { label: 'Idea', color: 'gray' },
            { label: 'Brief', color: 'blue' },
            { label: 'Writing', color: 'gold' },
            { label: 'Editing', color: 'purple' },
            { label: 'Design', color: 'pink' },
            { label: 'Ready', color: 'teal' },
            { label: 'Published', color: 'green' },
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
          config: { group_by_field_id: fieldRef('Articles', 'Stage') },
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
          config: { group_by_field_id: fieldRef('Topics', 'Priority') },
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
        { database: 'Articles', values: { name: 'Why stories beat pitches (sample)', stage: optionRef('Articles', 'Stage', 'Writing') } },
        { database: 'Articles', values: { name: 'Launch announcement (sample)', stage: optionRef('Articles', 'Stage', 'Brief') } },
        { database: 'Articles', values: { name: 'Case study draft (sample)', stage: optionRef('Articles', 'Stage', 'Idea') } },
        { database: 'Topics', values: { name: 'Onboarding funnels (sample)', priority: optionRef('Topics', 'Priority', 'Now') } },
      ],
      skills: [],
    },
  },

  // ── 5. Writing a book ──────────────────────────────────────────────────────
  {
    slug: 'book-launch',
    name: 'Book Launch',
    summary:
      'A manuscript board of chapters, research notes, launch tasks and appearances. A chapter ' +
      'entering Draft gates in an assistant that proposes revision notes.',
    highlights: [
      'Books, Chapters, Research Notes, Launch & Marketing and Appearances, fully related',
      'Manuscript workflow: Outline → Draft → Revised → Final',
      'A "Revision Assistant" agent proposes pacing/continuity notes — gated, your call to run it',
      'Notifies you when a chapter is finalized',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Idea', color: 'gray' },
                { label: 'Proposal', color: 'blue' },
                { label: 'Writing', color: 'gold' },
                { label: 'Editing', color: 'purple' },
                { label: 'Production', color: 'teal' },
                { label: 'Published', color: 'green' },
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
              type: 'select',
              options: [
                { label: 'To read', color: 'blue' },
                { label: 'Processed', color: 'green' },
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
              type: 'select',
              options: [
                { label: 'Triage', color: 'gray' },
                { label: 'Backlog', color: 'gray' },
                { label: 'To Do', color: 'blue' },
                { label: 'In Progress', color: 'gold' },
                { label: 'In Review', color: 'purple' },
                { label: 'Done', color: 'green' },
                { label: 'Canceled', color: 'brown' },
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
              type: 'select',
              options: [
                { label: 'Wishlist', color: 'gray' },
                { label: 'Pitched', color: 'blue' },
                { label: 'Booked', color: 'gold' },
                { label: 'Aired', color: 'green' },
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
            { label: 'Outline', color: 'gray' },
            { label: 'Draft', color: 'gold' },
            { label: 'Revised', color: 'purple' },
            { label: 'Final', color: 'green' },
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
          config: { group_by_field_id: fieldRef('Chapters', 'Status') },
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
          config: { group_by_field_id: fieldRef('Appearances', 'Status') },
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
        { database: 'Chapters', values: { name: 'Ch 1 — Why stories win (sample)', status: optionRef('Chapters', 'Status', 'Final'), order: 1 } },
        { database: 'Chapters', values: { name: 'Ch 2 — The narrative arc (sample)', status: optionRef('Chapters', 'Status', 'Draft'), order: 2 } },
        { database: 'Research Notes', values: { name: 'Campbell — hero journey notes (sample)', type: optionRef('Research Notes', 'Type', 'Book'), status: optionRef('Research Notes', 'Status', 'Processed') } },
        { database: 'Launch & Marketing', values: { name: 'Pitch 10 podcasts (sample)', state: optionRef('Launch & Marketing', 'State', 'To Do') } },
        { database: 'Appearances', values: { name: 'The Creative Pen podcast (sample)', status: optionRef('Appearances', 'Status', 'Pitched'), type: optionRef('Appearances', 'Type', 'Podcast') } },
      ],
      skills: [],
    },
  },

  // ── 6. Running a coaching practice ────────────────────────────────────────
  {
    slug: 'coaching-os',
    name: 'Coaching OS',
    summary:
      'Clients enrolled in programs, sessions as the calendar spine, and action items for ' +
      'accountability. A session marked Done gates in an assistant that drafts the notes.',
    highlights: [
      'Clients, Programs, Sessions and Action Items, fully related',
      'Session workflow: Scheduled → Done / No-show / Rescheduled / Canceled',
      'A "Session Notes Assistant" agent drafts notes and action items — gated, your call to run it',
      'Notifies you when a client’s status changes',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Discovery', color: 'gray' },
                { label: 'Proposal', color: 'blue' },
                { label: 'Active', color: 'green' },
                { label: 'Paused', color: 'gold' },
                { label: 'Alumni', color: 'purple' },
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
              type: 'select',
              options: [
                { label: 'Triage', color: 'gray' },
                { label: 'Backlog', color: 'gray' },
                { label: 'To Do', color: 'blue' },
                { label: 'In Progress', color: 'gold' },
                { label: 'In Review', color: 'purple' },
                { label: 'Done', color: 'green' },
                { label: 'Canceled', color: 'brown' },
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
            { label: 'Scheduled', color: 'blue' },
            { label: 'Done', color: 'green' },
            { label: 'No-show', color: 'red' },
            { label: 'Rescheduled', color: 'gold' },
            { label: 'Canceled', color: 'brown' },
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
          config: { group_by_field_id: fieldRef('Sessions', 'Status') },
        },
        {
          database: 'Clients',
          name: 'Client Board',
          type: 'board',
          config: { group_by_field_id: fieldRef('Clients', 'Status') },
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
        { database: 'Clients', values: { name: 'Sarah M (sample)', status: optionRef('Clients', 'Status', 'Active'), goal: 'Step into the CEO role' } },
        { database: 'Sessions', values: { name: 'Session 4 — delegation (sample)', status: optionRef('Sessions', 'Status', 'Done'), type: optionRef('Sessions', 'Type', 'Regular') } },
        { database: 'Action Items', values: { name: 'Write the delegation list (sample)', state: optionRef('Action Items', 'State', 'To Do'), who: optionRef('Action Items', 'Who', 'Client') } },
      ],
      skills: [],
    },
  },

  // ── 7. Consulting engagements ──────────────────────────────────────────────
  {
    slug: 'consulting-os',
    name: 'Consulting OS',
    summary:
      'Proposal pipeline, engagements with hours budgets, and delivery tasks. A proposal entering ' +
      'Negotiating gates in an assistant that drafts the follow-up.',
    highlights: [
      'Clients, Proposals, Engagements and Deliverables & Tasks, fully related',
      'Proposal pipeline: Draft → Sent → Negotiating → Won / Lost',
      'A "Follow-up Drafter" agent drafts the follow-up email — gated, your call to run it',
      'Notifies you when an engagement’s status changes',
    ],
    manifest: {
      format_version: 1,
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
              type: 'select',
              options: [
                { label: 'Prospect', color: 'gray' },
                { label: 'Active', color: 'green' },
                { label: 'Past', color: 'brown' },
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
              type: 'select',
              options: [
                { label: 'Kickoff', color: 'blue' },
                { label: 'Active', color: 'green' },
                { label: 'Wrapping', color: 'gold' },
                { label: 'Done', color: 'teal' },
                { label: 'Renewed', color: 'purple' },
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
              type: 'select',
              options: [
                { label: 'Triage', color: 'gray' },
                { label: 'Backlog', color: 'gray' },
                { label: 'To Do', color: 'blue' },
                { label: 'In Progress', color: 'gold' },
                { label: 'In Review', color: 'purple' },
                { label: 'Done', color: 'green' },
                { label: 'Canceled', color: 'brown' },
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
            { label: 'Draft', color: 'gray' },
            { label: 'Sent', color: 'gold' },
            { label: 'Negotiating', color: 'orange' },
            { label: 'Won', color: 'green' },
            { label: 'Lost', color: 'brown' },
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
          config: { group_by_field_id: fieldRef('Proposals', 'Stage') },
        },
        {
          database: 'Engagements',
          name: 'Engagement Board',
          type: 'board',
          config: { group_by_field_id: fieldRef('Engagements', 'Status') },
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
        { database: 'Proposals', values: { name: 'Growth audit Q3 (sample)', stage: optionRef('Proposals', 'Stage', 'Negotiating'), value: 15000, type: optionRef('Proposals', 'Type', 'Audit') } },
        { database: 'Engagements', values: { name: 'Meridian growth audit (sample)', status: optionRef('Engagements', 'Status', 'Active'), monthly_value: 5000, hours_budget: 40, hours_used: 12 } },
        { database: 'Deliverables & Tasks', values: { name: 'Stakeholder interviews (sample)', state: optionRef('Deliverables & Tasks', 'State', 'In Progress') } },
      ],
      skills: [],
    },
  },
];
