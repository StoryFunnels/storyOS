import { z } from 'zod';

/**
 * The filter AST — shared verbatim between saved views and POST /records/query
 * (ADR-0003). Flat AND in the v1 UI; the API allows and/or nesting ≤ 3 deep,
 * ≤ 50 conditions total.
 */

export const filterOpSchema = z.enum([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after',
  'within',
  'has',
  'has_none',
  'is_empty',
  'not_empty',
]);
export type FilterOp = z.infer<typeof filterOpSchema>;

export const relativeDateRangeSchema = z.enum([
  'today',
  'yesterday',
  'tomorrow',
  'last_7_days',
  'next_7_days',
  'this_month',
  'next_30_days',
]);
export type RelativeDateRange = z.infer<typeof relativeDateRangeSchema>;

export interface FilterCondition {
  field: string; // api_name
  op: FilterOp;
  value?: unknown;
}

export type FilterNode = FilterCondition | { and: FilterNode[] } | { or: FilterNode[] };

const conditionSchema = z.object({
  field: z.string().min(1),
  op: filterOpSchema,
  value: z.unknown().optional(),
});

const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    conditionSchema,
    z.object({ and: z.array(filterNodeSchema).min(1) }),
    z.object({ or: z.array(filterNodeSchema).min(1) }),
  ]),
);

function measure(node: FilterNode): { depth: number; conditions: number } {
  if ('and' in node || 'or' in node) {
    const children = 'and' in node ? node.and : (node as { or: FilterNode[] }).or;
    let depth = 0;
    let conditions = 0;
    for (const child of children) {
      const m = measure(child);
      depth = Math.max(depth, m.depth);
      conditions += m.conditions;
    }
    return { depth: depth + 1, conditions };
  }
  return { depth: 0, conditions: 1 };
}

export const filterSchema = filterNodeSchema.superRefine((node, ctx) => {
  const { depth, conditions } = measure(node);
  if (depth > 3) ctx.addIssue({ code: 'custom', message: 'filter nesting exceeds 3 levels' });
  if (conditions > 50) ctx.addIssue({ code: 'custom', message: 'filter exceeds 50 conditions' });
});

export const sortSchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export const queryRecordsSchema = z.object({
  filter: filterSchema.optional(),
  sorts: z.array(sortSchema).max(3).default([]),
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type QueryRecordsInput = z.infer<typeof queryRecordsSchema>;
