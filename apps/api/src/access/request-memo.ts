import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * #861 — a memo whose lifetime IS one HTTP request, and nothing wider.
 *
 * `AccessService` resolves a guest's `access_grants` many times per request (4-6 measured). The
 * answer cannot change mid-request, so it is computed once and reused. The hazard is the one
 * MN-125 shipped before ("revoking access reported success while access silently persisted"):
 * a cache that outlives the request honours a revoked grant. So this is deliberately NOT a
 * module-level map, a TTL cache or anything keyed on a user across requests:
 *
 *  - The store is an `AsyncLocalStorage` entered by `RequestMemoInterceptor` around ONE request's
 *    handler, and created fresh for it. When that request's handler finishes the store is
 *    unreachable. There is no other place it lives.
 *  - Outside a request (a job, a script, a test calling a service directly) there is NO store, and
 *    `memoize` simply runs the loader every time: no memo, no staleness.
 *  - The grant-writing paths call `forgetGrants()` so a request that changes grants and then
 *    reads them sees its own writes.
 */
const store = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/** The loader's result, memoised for the rest of THIS request; uncached outside a request. */
export function memoizeForRequest<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = store.getStore();
  if (!memo) return load();
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const pending = load().catch((error: unknown) => {
    memo.delete(key); // never memoise a failure
    throw error;
  });
  memo.set(key, pending);
  return pending;
}

/** Drop every memoised entry whose key starts with `prefix` (called by the writers of that data). */
export function forgetForRequest(prefix: string): void {
  const memo = store.getStore();
  if (!memo) return;
  for (const key of memo.keys()) if (key.startsWith(prefix)) memo.delete(key);
}

/** Opens one memo per request. Registered once, globally, by AccessModule. */
@Injectable()
export class RequestMemoInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return new Observable((subscriber) =>
      store.run(new Map(), () => {
        const subscription = next.handle().subscribe(subscriber);
        return () => subscription.unsubscribe();
      }),
    );
  }
}
