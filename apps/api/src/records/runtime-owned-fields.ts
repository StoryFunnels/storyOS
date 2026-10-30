import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #1062 — fields of an Agent run that only the agent runtime writes.
 *
 * `pending_action` is the staged action behind an approval gate, `run_class` is the metering boundary stamped at dispatch
 * ("your own AI is never metered" is a property of the code, MN-188), `cost` is what the run was charged. A member typing into
 * them through the records API or MCP produces data the runtime did not write; #1029 showed what a reader of such a field
 * costs. Fields a person is MEANT to set on a run (Surface, Commit or image, the name, the steps) are deliberately absent.
 *
 * #1133: the run record a Runner run leaves (wake reason, Runner, tool, tool version, exit, tokens in/out, summary, session id and
 * when a subscription limit lets it resume). Tokens a person or an agent could type onto a Run would be numbers nobody measured.
 */
export const RUNTIME_OWNED_RUN_FIELDS: readonly string[] = [
  'pending_action',
  'run_class',
  'cost',
  'wake_reason',
  'runner',
  'tool',
  'tool_version',
  'exit',
  'tokens_in',
  'tokens_out',
  'summary',
  'session_id',
  'limit_resumes_at',
];

const store = new AsyncLocalStorage<true>();

/**
 * Marks the writes made inside `fn` as the agent runtime's own. Opt-in per call site and default-deny everywhere else, so a new
 * caller of RecordsService must CHOOSE to be the runtime — it cannot become one by accident, and a new REST/MCP path cannot
 * forget to deny.
 */
export function asAgentRuntime<T>(fn: () => T): T {
  return store.run(true, fn);
}

export function isAgentRuntimeWrite(): boolean {
  return store.getStore() === true;
}
