import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #882 — WHICH credential (an `api_tokens` row) is acting in this request, so durable provenance rows can name it without every
 * write path having to thread it through (the #541 agent triplet is positional parameters through dozens of calls; this is the
 * one-line sibling). Entered once per request by `RequestMemoInterceptor` from `request.auth.tokenId`, which the auth guard sets only
 * for a personal access token. A session, an OAuth grant, a job or a script has NO store, so the answer is `null`: absence is
 * recorded as absence, never as a person.
 *
 * Leaf module with no imports of ours, because `db/schema.ts` reads it from a column default.
 */
/**
 * #1059 — WHO is acting, beside which credential: the person, what kind of actor (a human, an agent, an MCP client, an automation) and the
 * agent behind a token. Structural audit events (a space, database or view deleted, restored, restricted) are written deep inside services
 * that never took an actor, from REST and from MCP alike; this is how they are attributed without threading three parameters through every
 * caller. Same rule as `tokenId`: outside a request there is no store, and absence is recorded as absence, never as a person.
 */
export interface RequestActor {
  userId: string | null;
  source: 'human' | 'agent' | 'automation' | 'mcp' | null;
  agentId: string | null;
  agentName: string | null;
}

const store = new AsyncLocalStorage<{ tokenId: string | null; actor: RequestActor | null }>();

export function runWithCredential<T>(tokenId: string | null, fn: () => T, actor: RequestActor | null = null): T {
  return store.run({ tokenId, actor }, fn);
}

export function currentActor(): RequestActor | null {
  return store.getStore()?.actor ?? null;
}

export function currentCredentialId(): string | null {
  return store.getStore()?.tokenId ?? null;
}
