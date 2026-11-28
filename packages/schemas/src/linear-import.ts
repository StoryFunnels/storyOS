import { z } from 'zod';

/**
 * Ticket #1393 — what a Linear import brings over.
 *
 * Two choices an admin makes before the first import:
 *
 *  - SCOPE: `open_and_recent` (the default) = every issue that is not closed, plus the issues closed (completed or canceled)
 *    in the last `LINEAR_RECENT_DAYS` days. `all` = everything Linear holds, however old.
 *  - HISTORY: each issue's change history (the IssueHistory timeline) is its own, slow stream of requests, so it is OFF unless
 *    asked for. Comments are always imported, and are not an option.
 *
 * Both are optional on the wire, and a caller that sends neither gets the defaults. The object is STRICT on purpose: a misspelt
 * key (`include_histroy`) must be refused, not ignored into the default the person did not mean to ask for.
 */
export const LINEAR_IMPORT_SCOPES = ['open_and_recent', 'all'] as const;
export const linearImportScopeSchema = z.enum(LINEAR_IMPORT_SCOPES);
export type LinearImportScope = z.infer<typeof linearImportScopeSchema>;

/** "Closed in the last N days" in the default scope. */
export const LINEAR_RECENT_DAYS = 90;

export const linearImportOptionsSchema = z
  .object({
    scope: linearImportScopeSchema.optional(),
    /** Fetch each in-scope issue's change history (slower). Default false. */
    include_history: z.boolean().optional(),
  })
  .strict();
export type LinearImportOptions = z.infer<typeof linearImportOptionsSchema>;

/** The options a run actually uses: every field decided. */
export interface ResolvedLinearImportOptions {
  scope: LinearImportScope;
  include_history: boolean;
}

export const DEFAULT_LINEAR_IMPORT_OPTIONS: ResolvedLinearImportOptions = { scope: 'open_and_recent', include_history: false };

/** Fill what was not sent. `fallback` is where an omitted field comes from (a stored choice, a paused import's); the defaults otherwise. */
export function resolveLinearImportOptions(input: LinearImportOptions | undefined, fallback: ResolvedLinearImportOptions = DEFAULT_LINEAR_IMPORT_OPTIONS): ResolvedLinearImportOptions {
  return { scope: input?.scope ?? fallback.scope, include_history: input?.include_history ?? fallback.include_history };
}
