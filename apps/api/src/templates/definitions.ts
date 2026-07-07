/**
 * Starter template definitions — the machine-readable form of
 * docs/product/templates.md. Installed via the ordinary service layer
 * (same code paths as the public API), so templates prove the API.
 */

export interface TemplateFieldDef {
  key: string; // stable key within the template for cross-references
  display_name: string;
  type: 'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multi_select' | 'url' | 'email' | 'user';
  config?: Record<string, unknown>;
  options?: Array<{ label: string; color?: string }>;
}

export interface TemplateRelationDef {
  key: string;
  database_a: string; // many side
  database_b: string;
  cardinality: 'one_to_many' | 'many_to_many';
  field_a_name: string;
  field_b_name: string;
}

export interface TemplateViewDef {
  database: string;
  name: string;
  type: 'table' | 'board';
  group_by_field?: string; // "<db>.<fieldKey>"
  filters?: unknown;
  sorts?: Array<{ field: string; direction: 'asc' | 'desc' }>; // api_names resolved at install
}

export interface TemplateRecordDef {
  database: string;
  values: Record<string, unknown>; // field keys; select values by option LABEL
  links?: Array<{ relation: string; to: string }>; // to = record key
  key?: string;
}

export interface TemplateDef {
  slug: string;
  name: string;
  description: string;
  space: string;
  databases: Array<{ key: string; name: string; icon?: string; fields: TemplateFieldDef[] }>;
  relations: TemplateRelationDef[];
  views: TemplateViewDef[];
  records: TemplateRecordDef[];
}

export const TEMPLATES: TemplateDef[] = [
  {
    slug: 'client-work',
    name: 'Client Projects & Tasks',
    description: 'Clients → Projects → Tasks with boards — run client work end to end.',
    space: 'Client Work',
    databases: [
      {
        key: 'clients',
        name: 'Clients',
        fields: [
          { key: 'status', display_name: 'Status', type: 'select', options: [
            { label: 'Active', color: 'green' }, { label: 'Paused', color: 'gold' }, { label: 'Churned', color: 'gray' },
          ]},
          { key: 'owner', display_name: 'Owner', type: 'user' },
          { key: 'website', display_name: 'Website', type: 'url' },
          { key: 'contact_email', display_name: 'Contact Email', type: 'email' },
        ],
      },
      {
        key: 'projects',
        name: 'Projects',
        fields: [
          { key: 'status', display_name: 'Status', type: 'select', options: [
            { label: 'Planning', color: 'blue' }, { label: 'Active', color: 'green' },
            { label: 'On Hold', color: 'gold' }, { label: 'Done', color: 'gray' },
          ]},
          { key: 'lead', display_name: 'Lead', type: 'user' },
          { key: 'start_date', display_name: 'Start Date', type: 'date' },
          { key: 'due_date', display_name: 'Due Date', type: 'date' },
        ],
      },
      {
        key: 'tasks',
        name: 'Tasks',
        fields: [
          { key: 'state', display_name: 'State', type: 'select', options: [
            { label: 'Backlog', color: 'gray' }, { label: 'To Do', color: 'blue' },
            { label: 'In Progress', color: 'gold' }, { label: 'Review', color: 'purple' },
            { label: 'Done', color: 'green' },
          ]},
          { key: 'assignee', display_name: 'Assignee', type: 'user' },
          { key: 'priority', display_name: 'Priority', type: 'select', options: [
            { label: 'Low', color: 'gray' }, { label: 'Medium', color: 'blue' },
            { label: 'High', color: 'orange' }, { label: 'Urgent', color: 'red' },
          ]},
          { key: 'due', display_name: 'Due Date', type: 'date' },
          { key: 'estimate', display_name: 'Estimate h', type: 'number' },
        ],
      },
    ],
    relations: [
      { key: 'project_client', database_a: 'projects', database_b: 'clients', cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Projects' },
      { key: 'task_project', database_a: 'tasks', database_b: 'projects', cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Tasks' },
    ],
    views: [
      { database: 'projects', name: 'Projects Board', type: 'board', group_by_field: 'projects.status' },
      { database: 'tasks', name: 'Task Board', type: 'board', group_by_field: 'tasks.state' },
      { database: 'tasks', name: 'Due This Week', type: 'table', filters: { field: 'due_date', op: 'within', value: 'next_7_days' }, sorts: [{ field: 'due_date', direction: 'asc' }] },
    ],
    records: [
      { key: 'jcm', database: 'clients', values: { name: 'JCM (sample)', status: 'Active' } },
      { key: 'acme', database: 'clients', values: { name: 'Acme Co (sample)', status: 'Paused' } },
      { key: 'p1', database: 'projects', values: { name: 'Website refresh (sample)', status: 'Active' }, links: [{ relation: 'project_client', to: 'jcm' }] },
      { key: 'p2', database: 'projects', values: { name: 'Brand audit (sample)', status: 'Planning' }, links: [{ relation: 'project_client', to: 'acme' }] },
      { database: 'tasks', values: { name: 'Collect brand assets (sample)', state: 'Done', priority: 'Medium' }, links: [{ relation: 'task_project', to: 'p1' }] },
      { database: 'tasks', values: { name: 'Wireframe the landing page (sample)', state: 'In Progress', priority: 'High', estimate: 8 }, links: [{ relation: 'task_project', to: 'p1' }] },
      { database: 'tasks', values: { name: 'Write homepage copy (sample)', state: 'To Do', priority: 'High' }, links: [{ relation: 'task_project', to: 'p1' }] },
      { database: 'tasks', values: { name: 'Competitor scan (sample)', state: 'Backlog', priority: 'Low' }, links: [{ relation: 'task_project', to: 'p2' }] },
      { database: 'tasks', values: { name: 'Kickoff call notes (sample)', state: 'Review', priority: 'Medium' }, links: [{ relation: 'task_project', to: 'p2' }] },
    ],
  },
  {
    slug: 'content-pipeline',
    name: 'Content Pipeline',
    description: 'Articles with an editorial board, tied to campaigns.',
    space: 'Content',
    databases: [
      {
        key: 'articles',
        name: 'Articles',
        fields: [
          { key: 'stage', display_name: 'Stage', type: 'select', options: [
            { label: 'Idea', color: 'gray' }, { label: 'Brief', color: 'blue' },
            { label: 'Writing', color: 'gold' }, { label: 'Editing', color: 'purple' },
            { label: 'Ready', color: 'teal' }, { label: 'Published', color: 'green' },
          ]},
          { key: 'content_type', display_name: 'Content Type', type: 'select', options: [
            { label: 'Blog post' }, { label: 'Case study' }, { label: 'Landing page' }, { label: 'Newsletter' },
          ]},
          { key: 'author', display_name: 'Author', type: 'user' },
          { key: 'target_date', display_name: 'Target Publish Date', type: 'date' },
          { key: 'keyword', display_name: 'Primary Keyword', type: 'text' },
          { key: 'url', display_name: 'Published URL', type: 'url' },
        ],
      },
      {
        key: 'campaigns',
        name: 'Campaigns',
        fields: [
          { key: 'status', display_name: 'Status', type: 'select', options: [
            { label: 'Planned', color: 'blue' }, { label: 'Running', color: 'gold' }, { label: 'Done', color: 'green' },
          ]},
          { key: 'owner', display_name: 'Owner', type: 'user' },
          { key: 'start', display_name: 'Start Date', type: 'date' },
          { key: 'end', display_name: 'End Date', type: 'date' },
        ],
      },
    ],
    relations: [
      { key: 'article_campaigns', database_a: 'articles', database_b: 'campaigns', cardinality: 'many_to_many', field_a_name: 'Campaigns', field_b_name: 'Articles' },
    ],
    views: [
      { database: 'articles', name: 'Editorial Board', type: 'board', group_by_field: 'articles.stage' },
      { database: 'articles', name: 'Publish Schedule', type: 'table', sorts: [{ field: 'target_publish_date', direction: 'asc' }] },
    ],
    records: [
      { key: 'launch', database: 'campaigns', values: { name: 'Q3 launch (sample)', status: 'Running' } },
      { database: 'articles', values: { name: 'How we model client work (sample)', stage: 'Writing' }, links: [{ relation: 'article_campaigns', to: 'launch' }] },
      { database: 'articles', values: { name: 'Open-source announcement (sample)', stage: 'Brief' }, links: [{ relation: 'article_campaigns', to: 'launch' }] },
      { database: 'articles', values: { name: 'Kanban vs table views (sample)', stage: 'Idea' } },
      { database: 'articles', values: { name: 'Self-hosting guide (sample)', stage: 'Published' } },
    ],
  },
];
