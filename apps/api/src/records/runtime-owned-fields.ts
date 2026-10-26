import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #1062 — fields of an Agent run that only the agent runtime writes.
 *
 * `pending_action` is the staged action behind an approval gate, `run_class` is the metering boundary stamped at dispatch
 * ("your own AI is never metered" is a property of the code, MN-188), `cost` is what the run was charged. A member typing into
 * them through the records API or MCP produces data the runtime did not write; #1029 showed what a reader of such a field
 * costs. Fields a person is MEANT to set on a run (Surface, Commit or image, the name, the steps) are deliberately absent.
 */
export const RUNTIME_OWNED_RUN_FIELDS: readonly string[] = ['pending_action', 'run_class', 'cost'];

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
