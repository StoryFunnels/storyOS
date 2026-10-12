import { z } from 'zod';

/**
 * #598 — workspace-wide nomination of ONE `workflow` field per database (#172, #189).
 *
 * Two steps, deliberately: a read-only SCAN that reports what looks like a lifecycle ("status") select
 * in every database the caller can read, and an APPLY that converts chosen ones through the existing
 * per-field conversion (`POST /fields/:field/change-type`, unchanged). The apply defaults to a DRY RUN:
 * changing a field's type is a schema change, so converting must be asked for explicitly
 * (`dry_run: false`), never fall out of a default.
 */
export const workflowNominationItemSchema = z.object({
  database_id: z.uuid(),
  field_id: z.uuid(),
});
export type WorkflowNominationItem = z.infer<typeof workflowNominationItemSchema>;

export const applyWorkflowNominationSchema = z.object({
  nominations: z.array(workflowNominationItemSchema).min(1).max(50),
  /** Default TRUE: report what would happen and change nothing. */
  dry_run: z.boolean().default(true),
});
export type ApplyWorkflowNominationInput = z.infer<typeof applyWorkflowNominationSchema>;

export const workflowCandidateConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const workflowCandidateSchema = z.object({
  field_id: z.uuid(),
  display_name: z.string(),
  api_name: z.string(),
  confidence: workflowCandidateConfidenceSchema,
  reasons: z.array(z.string()),
  option_labels: z.array(z.string()),
});

export const workflowNominationDatabaseSchema = z.object({
  database_id: z.uuid(),
  database_name: z.string(),
  /**
   * `has_workflow`: it already has its one workflow field (nothing to nominate).
   * `candidates`: one or more selects look like a lifecycle; `ambiguous` says there is more than one and a
   * person must choose, because a database can hold only one workflow field.
   * `none`: nothing in it looks like a lifecycle.
   */
  status: z.enum(['has_workflow', 'candidates', 'none']),
  existing_workflow: z.object({ field_id: z.uuid(), display_name: z.string() }).nullable(),
  ambiguous: z.boolean(),
  candidates: z.array(workflowCandidateSchema),
});

export const workflowNominationScanSchema = z.object({
  databases: z.array(workflowNominationDatabaseSchema),
  summary: z.object({
    databases_scanned: z.number().int(),
    with_workflow: z.number().int(),
    with_candidates: z.number().int(),
    ambiguous: z.number().int(),
  }),
});
export type WorkflowNominationScan = z.infer<typeof workflowNominationScanSchema>;

export const workflowNominationResultSchema = z.object({
  database_id: z.string(),
  field_id: z.string(),
  /** converted: applied. would_convert: dry run. skipped: nothing to do. error: refused, with `reason`. */
  status: z.enum(['converted', 'would_convert', 'skipped', 'error']),
  reason: z.string().nullable(),
});

export const workflowNominationApplyResultSchema = z.object({
  dry_run: z.boolean(),
  results: z.array(workflowNominationResultSchema),
});
export type WorkflowNominationApplyResult = z.infer<typeof workflowNominationApplyResultSchema>;
