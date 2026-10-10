import { z } from 'zod';
import { filterSchema } from './query';

/**
 * #231 — a validation rule BLOCKS a record write when the data it would leave behind is not valid. It is the
 * sibling of an automation (which reacts after the fact): a failed rule means the write did not happen.
 *
 *   create      — checked whenever a record is created.
 *   update      — checked when an update changes a field the rule REFERENCES (never on an unrelated edit, so a
 *                 rule added to a database full of non-conforming rows does not make them uneditable).
 *   transition  — checked when `transition.field` changes TO `transition.to` (or is created holding it).
 *
 * `condition` is what must be TRUE of the record after the write: the same filter language saved views and
 * rollup filters use, so cross-field rules need nothing extra. It may reference stored fields and relations,
 * not computed ones (formula, rollup, lookup, AI: they are derived after the write commits).
 */
export const validationRuleTriggerSchema = z.enum(['create', 'update', 'transition']);
export type ValidationRuleTrigger = z.infer<typeof validationRuleTriggerSchema>;

const transitionSchema = z.object({
  /** api_name of a select or workflow field. */
  field: z.string().trim().min(1),
  /** The option, by label or id. */
  to: z.string().trim().min(1),
});

export const createValidationRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    trigger: validationRuleTriggerSchema,
    transition: transitionSchema.optional(),
    condition: filterSchema,
    /** Shown to whoever's write is refused. */
    message: z.string().trim().min(1).max(500),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.trigger === 'transition' && !v.transition) {
      ctx.addIssue({ code: 'custom', path: ['transition'], message: 'a transition rule needs transition: { field, to }' });
    }
    if (v.trigger !== 'transition' && v.transition) {
      ctx.addIssue({ code: 'custom', path: ['transition'], message: 'transition is only for trigger "transition"' });
    }
  });
export type CreateValidationRuleInput = z.infer<typeof createValidationRuleSchema>;

/** The trigger is fixed at creation: to change it, delete the rule and declare another. */
export const updateValidationRuleSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  condition: filterSchema.optional(),
  message: z.string().trim().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateValidationRuleInput = z.infer<typeof updateValidationRuleSchema>;
