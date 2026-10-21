import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Pool, PoolClient } from 'pg';

/**
 * Ticket #1010 (under #998) — a `Server-Timing` header on the two calls a database page makes first: how long the database took for this
 * response and how many statements it ran. The freeze reported on production could not be explained from a local rig (every call was
 * under 40 ms there, but each runs ~11 sequential statements, so latency to the real database multiplies them), and the numbers that
 * decide it are only on the server. The browser's Network panel shows this header under Timing.
 *
 * TIMINGS ONLY, by construction: the header is built from two numbers and nothing else (no ids, no SQL, no row data), and no
 * `Timing-Allow-Origin` is added, so this exposes nothing to another origin that the response did not already.
 *
 * How it is measured: the counter is an `AsyncLocalStorage` entered by `ServerTimingInterceptor` around ONE request's handler, so two
 * concurrent requests never see each other's numbers. `instrumentPool` wraps the pool's `query` and every client it hands out (which is
 * how a transaction's statements go), and does nothing at all outside a store, so every other request pays one `getStore()` call.
 */
interface Counter {
  statements: number;
  dbMs: number;
}
const counter = new AsyncLocalStorage<Counter>();

/** Run `fn` with a fresh counter; returns what it measured alongside its result. Exported for tests and for the interceptor. */
export async function measureDb<T>(fn: () => Promise<T>): Promise<{ result: T; statements: number; dbMs: number }> {
  const c: Counter = { statements: 0, dbMs: 0 };
  const result = await counter.run(c, fn);
  return { result, statements: c.statements, dbMs: c.dbMs };
}

type QueryFn = (...args: unknown[]) => unknown;

/**
 * Wrap one query function so each call counts as a statement on `c` and its duration is added to `c.dbMs`.
 *
 * `c` is passed in, never read from the async context here, on purpose: `pg-pool` hands a QUEUED `pool.query` to whoever releases a
 * client next, so inside the pool the "current" async context belongs to a different request. The counter has to be captured where the
 * request called the pool, which is what `instrumentPool` does.
 */
function timed(c: Counter, original: QueryFn, thisArg: object): QueryFn {
  return (...args: unknown[]) => {
    c.statements += 1;
    const started = performance.now();
    const done = () => {
      c.dbMs += performance.now() - started;
    };
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      // callback form: time until the callback fires
      args[args.length - 1] = (...cbArgs: unknown[]) => {
        done();
        return (last as QueryFn)(...cbArgs);
      };
      return original.apply(thisArg, args);
    }
    const out = original.apply(thisArg, args);
    // promise form: observe the settlement without replacing what the caller gets back
    if (out && typeof (out as PromiseLike<unknown>).then === 'function') (out as PromiseLike<unknown>).then(done, done);
    else done();
    return out;
  };
}

const wrapped = Symbol('server-timing-wrapped');

/**
 * Instrument a pool once, at the two places a request enters it, each reading the request's counter at the moment of the call:
 *  - `pool.query` (a single statement). The time includes waiting for a free connection, which is time the request really spent.
 *  - `pool.connect()` (a transaction): every statement on the checked-out client is attributed to the request that checked it out,
 *    and the client's `query` is put back as it was when it is released, so the pool's own internal use of the client is never counted.
 * Outside a request neither does anything beyond one `getStore()` call. Idempotent.
 */
export function instrumentPool(pool: Pool): Pool {
  const p = pool as Pool & { [wrapped]?: boolean };
  if (p[wrapped]) return pool;
  p[wrapped] = true;

  const query = pool.query.bind(pool) as unknown as QueryFn;
  p.query = ((...args: unknown[]) => {
    const c = counter.getStore();
    return c ? timed(c, query, pool)(...args) : query(...args);
  }) as unknown as Pool['query'];

  const connect = pool.connect.bind(pool) as unknown as (...a: unknown[]) => unknown;
  p.connect = ((...args: unknown[]) => {
    const c = counter.getStore();
    const out = connect(...args);
    // promise form only (what drizzle uses); the callback form is left alone
    if (!c || !out || typeof (out as Promise<PoolClient>).then !== 'function') return out;
    return (out as Promise<PoolClient>).then((client) => {
      const originalQuery = client.query;
      const originalRelease = client.release;
      client.query = timed(c, originalQuery as unknown as QueryFn, client) as unknown as PoolClient['query'];
      client.release = ((...a: unknown[]) => {
        client.query = originalQuery;
        client.release = originalRelease;
        return (originalRelease as unknown as QueryFn).apply(client, a);
      }) as unknown as PoolClient['release'];
      return client;
    });
  }) as unknown as Pool['connect'];
  return pool;
}

/** `db;dur=12.3;desc="11 statements", total;dur=18.0` — the whole header. */
export function serverTimingHeader(c: Counter, totalMs: number): string {
  const n = Math.round(c.statements);
  return `db;dur=${c.dbMs.toFixed(1)};desc="${n} ${n === 1 ? 'statement' : 'statements'}", total;dur=${totalMs.toFixed(1)}`;
}

/** Put on the handlers whose timings are worth reading (the database GET and records/query); adds the header, changes nothing else. */
@Injectable()
export class ServerTimingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const reply = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => unknown; sent?: boolean }>();
    const c: Counter = { statements: 0, dbMs: 0 };
    const started = performance.now();
    const stamp = () => {
      if (typeof reply?.header === 'function' && !reply.sent) reply.header('Server-Timing', serverTimingHeader(c, performance.now() - started));
    };
    return new Observable((subscriber) =>
      counter.run(c, () => {
        const subscription = next.handle().subscribe({
          next: (value) => {
            stamp();
            subscriber.next(value);
          },
          error: (error: unknown) => {
            stamp();
            subscriber.error(error);
          },
          complete: () => subscriber.complete(),
        });
        return () => subscription.unsubscribe();
      }),
    );
  }
}
