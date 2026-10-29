import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #1104 — two pieces of ambient context for the per-agent write gate (agent_write_gates).
 *
 * Both are opt-in per call site, the same shape as `asAgentRuntime` (#1062): a new caller of RecordsService must CHOOSE to
 * carry either, so neither can be picked up by accident.
 */

/**
 * WHICH agent a run is acting as. A REST/MCP write carries it as `req.auth.agentId`; the run executor writes through
 * ActionsService, whose many call sites into RecordsService do not take an agent id, so the dispatching code sets it here
 * for the duration of one inline apply. Read ONLY when `source === 'agent'`.
 */
const actingAgent = new AsyncLocalStorage<{ agentId: string; agentName: string }>();

export function asActingAgent<T>(agent: { agentId: string; agentName: string }, fn: () => T): T {
  return actingAgent.run(agent, fn);
}

export function currentActingAgent(): { agentId: string; agentName: string } | undefined {
  return actingAgent.getStore();
}

/**
 * The write inside `fn` is the one a person just APPROVED, so it must not be held again (an approved write that re-checked
 * the same gate would stage a second approval forever and never apply). Set only by the approval executor, after it has
 * re-validated the staged write.
 */
const approvedWrite = new AsyncLocalStorage<true>();

export function asApprovedAgentWrite<T>(fn: () => T): T {
  return approvedWrite.run(true, fn);
}

export function isApprovedAgentWrite(): boolean {
  return approvedWrite.getStore() === true;
}
