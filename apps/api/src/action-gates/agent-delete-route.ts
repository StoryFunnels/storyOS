import { SetMetadata } from '@nestjs/common';
import type { AgentDeleteKind } from './agent-delete-hold.service';

/** #1178 — metadata key of a handler that holds an agent's delete (see HoldsAgentDeletes). */
export const HOLDS_AGENT_DELETES_KEY = 'storyos:holdsAgentDeletes';

/**
 * #1178 — marks a route that can DELETE shared content and that a Runner run credential can reach: its service calls
 * `AgentDeleteHoldService.holdIfAgentPolicy` after the service's own access checks, so an agent whose `approval_policy` lists `delete`
 * has the call staged for a person (202) instead of performed. The marker does not hold anything by itself; it is what the sweep
 * (test/run-credential-outward-sweep.test.ts) and run-credential-delete-policy.test.ts enumerate, so a delete route cannot be added
 * without either carrying it or being classified as clearing only the member's own state (test/helpers/outward-audit.ts).
 */
export const HoldsAgentDeletes = (kind: AgentDeleteKind) => SetMetadata(HOLDS_AGENT_DELETES_KEY, kind);
