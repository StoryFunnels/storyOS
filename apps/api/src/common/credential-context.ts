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
const store = new AsyncLocalStorage<{ tokenId: string | null }>();

export function runWithCredential<T>(tokenId: string | null, fn: () => T): T {
  return store.run({ tokenId }, fn);
}

export function currentCredentialId(): string | null {
  return store.getStore()?.tokenId ?? null;
}
