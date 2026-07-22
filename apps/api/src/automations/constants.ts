/**
 * Shared, dependency-free constants for the automations engine.
 *
 * MAX_FAILURES lives here — not in automations.service.ts, where it
 * originated — specifically so job-runner.service.ts (MN-253) can reuse it
 * without creating a module import cycle: actions.service.ts already imports
 * JobRunnerService, and automations.service.ts already imports
 * AutomationActionsService, so a job-runner.service.ts -> automations.service.ts
 * import would close the loop (actions -> job-runner -> automations ->
 * actions). TypeScript/Node's circular-require handling can leave a
 * mid-cycle class binding `undefined` at the moment a decorator captures it
 * for DI metadata — which is exactly what broke here: Nest failed to resolve
 * AutomationsService's `actions: AutomationActionsService` constructor
 * parameter (reported as index [2] being `undefined`) because the cycle
 * left `AutomationActionsService` unresolved at class-definition time. This
 * file has no imports, so it can never be the module that completes a cycle.
 */
export const MAX_FAILURES = 10;
