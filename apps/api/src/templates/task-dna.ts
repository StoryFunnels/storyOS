import type {
  TemplateDatabaseDef,
  TemplateFieldDef,
  TemplateRelationDef,
  TemplateViewDef,
} from './types';

/**
 * Task DNA (docs/product/template-library.md, Linear-informed): the shared
 * task recipe every pack composes — Triage inbox + Canceled states, priority,
 * labels, estimates, sub-tasks and blocked-by self-relations, and the
 * Board/Triage/My Tasks/Due This Week view set.
 */
export interface TaskDnaOptions {
  key: string;
  name: string;
  labels: string[];
  extraFields?: TemplateFieldDef[];
  withEstimates?: boolean;
  boardName?: string;
}

export const TASK_STATES = [
  { label: 'Triage', color: 'gray' },
  { label: 'Backlog', color: 'gray' },
  { label: 'To Do', color: 'blue' },
  { label: 'In Progress', color: 'gold' },
  { label: 'In Review', color: 'purple' },
  { label: 'Done', color: 'green' },
  { label: 'Canceled', color: 'brown' },
];

export const TASK_PRIORITIES = [
  { label: 'Urgent', color: 'red' },
  { label: 'High', color: 'orange' },
  { label: 'Medium', color: 'blue' },
  { label: 'Low', color: 'gray' },
];

export function taskDnaDatabase(opts: TaskDnaOptions): TemplateDatabaseDef {
  const fields: TemplateFieldDef[] = [
    { key: 'state', display_name: 'State', type: 'select', options: TASK_STATES },
    { key: 'priority', display_name: 'Priority', type: 'select', options: TASK_PRIORITIES },
    {
      key: 'labels',
      display_name: 'Labels',
      type: 'multi_select',
      options: opts.labels.map((label) => ({ label })),
    },
    { key: 'assignee', display_name: 'Assignee', type: 'user' },
    { key: 'due', display_name: 'Due Date', type: 'date' },
    ...(opts.withEstimates !== false
      ? ([
          { key: 'estimate', display_name: 'Estimate (pts)', type: 'number' },
          { key: 'effort', display_name: 'Effort spent', type: 'number' },
        ] as TemplateFieldDef[])
      : []),
    ...(opts.extraFields ?? []),
  ];
  return { key: opts.key, name: opts.name, fields };
}

/** Sub-tasks + blocked-by self-relations for a DNA database. */
export function taskDnaRelations(key: string): TemplateRelationDef[] {
  return [
    {
      key: `${key}_parent`,
      database_a: key,
      database_b: key,
      cardinality: 'one_to_many',
      field_a_name: 'Parent task',
      field_b_name: 'Sub-tasks',
    },
    {
      key: `${key}_blocked`,
      database_a: key,
      database_b: key,
      cardinality: 'many_to_many',
      field_a_name: 'Blocked by',
      field_b_name: 'Blocks',
    },
  ];
}

export function taskDnaViews(key: string, boardName = 'Board'): TemplateViewDef[] {
  return [
    { database: key, name: boardName, type: 'board', group_by_field: 'state' },
    {
      database: key,
      name: 'Triage',
      type: 'table',
      filters: [{ field: 'state', op: 'has', values: ['Triage'] }],
    },
    {
      database: key,
      name: 'My Tasks',
      type: 'table',
      filters: [
        { field: 'assignee', op: 'has', values: ['@me'] },
        { field: 'state', op: 'has_none', values: ['Done', 'Canceled'] },
      ],
      sorts: [{ field: 'due', direction: 'asc' }],
    },
    {
      database: key,
      name: 'Due This Week',
      type: 'table',
      filters: [{ field: 'due', op: 'within', value: 'next_7_days' }],
      sorts: [{ field: 'due', direction: 'asc' }],
    },
  ];
}
