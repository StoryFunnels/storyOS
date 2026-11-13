import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { entityGateView } from '@/components/quill/entity-gate';
import {
  combineEntityStates,
  entityQueryOptions,
  entityState,
  errorStatus,
  isGoneError,
} from '@/lib/entity-state';
import { withSafeErrors } from '@/lib/http-error';

vi.mock('next/navigation', () => ({ useParams: () => ({ ws: 'ws-1' }) }));

/** What `api.ts` hands a page when a call fails: the error envelope, with the status the safe-fetch stamped on it. */
const envelope = (status: number, code = 'whatever') => ({ error: { code, message: 'x', meta: { status } } });
const q = (over: Partial<Parameters<typeof entityState>[0]>) => ({ isPending: false, isError: false, error: null, data: undefined, ...over });

describe('404 and 403 are one fact, "not here for you" (a guest must not learn a database exists)', () => {
  it('reads the status the safe-fetch stamped, whatever specific code the API chose', () => {
    expect(errorStatus(envelope(404, 'database_not_found'))).toBe(404);
    expect(isGoneError(envelope(404))).toBe(true);
    expect(isGoneError(envelope(403))).toBe(true);
    // a 404 and a 403 produce the SAME state, byte for byte
    expect(entityState(q({ isError: true, error: envelope(404) }))).toEqual(entityState(q({ isError: true, error: envelope(403) })));
  });

  it('is NOT gone for anything that is not a 404/403: 401, 422, 429, 5xx, the network', () => {
    for (const status of [400, 401, 409, 422, 429, 500, 502, 503, 504]) expect(isGoneError(envelope(status))).toBe(false);
    expect(isGoneError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isGoneError(null)).toBe(false);
    expect(isGoneError(undefined)).toBe(false);
    expect(isGoneError('404')).toBe(false);
    expect(isGoneError({ error: { code: 'not_found', message: 'a code alone is not a status' } })).toBe(false);
  });
});

describe('entityState: loading, ready, gone and failed are four different answers', () => {
  it('a query still in flight is loading, and only that', () => {
    expect(entityState(q({ isPending: true }))).toEqual({ kind: 'loading' });
  });
  it('404 or 403 is gone, never a spinner', () => {
    expect(entityState(q({ isError: true, error: envelope(404) }))).toEqual({ kind: 'gone' });
    expect(entityState(q({ isError: true, error: envelope(403) }))).toEqual({ kind: 'gone' });
  });
  it('a network error or a 5xx is FAILED, never gone: we do not know the thing is missing', () => {
    for (const error of [new TypeError('Failed to fetch'), envelope(500), envelope(502), envelope(503)]) {
      expect(entityState(q({ isError: true, error }))).toEqual({ kind: 'failed', error });
    }
  });
  it('data wins: a background refetch that fails does not take a loaded page away', () => {
    expect(entityState(q({ isError: true, error: envelope(404), data: { id: 'a' } }))).toEqual({ kind: 'ready' });
    expect(entityState(q({ isError: true, error: new TypeError('x'), data: { id: 'a' } }))).toEqual({ kind: 'ready' });
  });
  it('a lookup that settled with nothing is gone (a skill or space not in the list you may read)', () => {
    expect(entityState(q({ data: null }))).toEqual({ kind: 'gone' });
  });
  it('several answers combine: gone beats failed beats loading beats ready', () => {
    const ready = { kind: 'ready' } as const;
    const loading = { kind: 'loading' } as const;
    const gone = { kind: 'gone' } as const;
    const failed = { kind: 'failed', error: 1 } as const;
    expect(combineEntityStates(ready, ready)).toEqual(ready);
    expect(combineEntityStates(ready, loading)).toEqual(loading);
    expect(combineEntityStates(loading, failed)).toEqual(failed);
    expect(combineEntityStates(failed, gone, loading)).toEqual(gone);
  });
});

describe('what each answer draws', () => {
  it('gone draws OUR 404 with its way back; failed draws a Retry and is NOT the 404; the rest draw nothing', () => {
    const gone = renderToStaticMarkup(entityGateView({ kind: 'gone' }) as never);
    expect(gone).toContain('data-testid="not-found"');
    expect(gone).toContain('This page doesn’t exist');
    expect(gone).toContain('href="/w/ws-1"');

    const failed = renderToStaticMarkup(entityGateView({ kind: 'failed', error: new TypeError('Failed to fetch') }, () => undefined) as never);
    expect(failed).not.toContain('data-testid="not-found"');
    expect(failed).not.toContain('This page doesn’t exist');
    expect(failed).toContain('Try again');

    expect(entityGateView({ kind: 'loading' })).toBeNull();
    expect(entityGateView({ kind: 'ready' })).toBeNull();
  });
});

describe('a gone entity is not retried, and not refetched by the next observer (that refetch was the endless spinner)', () => {
  it('retry: never for 404/403, once for anything else', () => {
    expect(entityQueryOptions.retry(0, envelope(404))).toBe(false);
    expect(entityQueryOptions.retry(0, envelope(403))).toBe(false);
    expect(entityQueryOptions.retry(0, envelope(500))).toBe(true);
    expect(entityQueryOptions.retry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(entityQueryOptions.retry(1, envelope(500))).toBe(false);
  });
  it('an errored query is not retried on mount, and a gone one is not refetched on window focus', () => {
    expect(entityQueryOptions.retryOnMount).toBe(false);
    expect(entityQueryOptions.refetchOnWindowFocus({ state: { status: 'error', error: envelope(404) } })).toBe(false);
    expect(entityQueryOptions.refetchOnWindowFocus({ state: { status: 'error', error: envelope(500) } })).toBe(true);
    expect(entityQueryOptions.refetchOnWindowFocus({ state: { status: 'success', error: null } })).toBe(true);
  });
});

describe('the safe fetch stamps the status the SDK drops (the SDK returns the body, not the response)', () => {
  const json = { 'content-type': 'application/json' };
  const run = async (res: Response) => withSafeErrors(async () => res)('http://x/');

  it('a JSON error envelope gains meta.status and keeps everything else', async () => {
    const res = await run(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found', request_id: 'r1' } }), { status: 404, headers: json }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found', request_id: 'r1', meta: { status: 404 } } });
  });
  it('existing meta is kept, and a body that is not the envelope is left alone', async () => {
    const res = await run(new Response(JSON.stringify({ error: { code: 'x', message: 'm', meta: { retry_after_seconds: 3 } } }), { status: 429, headers: json }));
    expect((await res.json()).error.meta).toEqual({ retry_after_seconds: 3, status: 429 });
    const other = await run(new Response(JSON.stringify(['not', 'an', 'envelope']), { status: 500, headers: json }));
    expect(await other.json()).toEqual(['not', 'an', 'envelope']);
  });
  it('a success is untouched', async () => {
    const res = await run(new Response(JSON.stringify({ ok: true }), { status: 200, headers: json }));
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ── The route table, read from the filesystem ────────────────────────────────────────────────────────────────────────────────────────────
// A hand list of "the pages that handle a missing thing" is how this ticket came to exist: six pages each drew their own, and a
// new one would have drawn a seventh. So the set of routes is DERIVED (every page.tsx under the app router whose path has a dynamic
// segment, one that names a thing), and each must be classified: either carried by the shared gate, or exempt with a reason. A route
// added tomorrow fails here until it is; a route deleted fails here until its line is.
const SRC = fileURLToPath(new URL('..', import.meta.url));
const APP = join(SRC, 'app');

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === 'page.tsx' ? [full] : [];
  });
}
/** `w/[ws]/d/[db]/r/[rec]` for the page at `.../w/[ws]/d/[db]/r/[rec]/page.tsx`. */
const routeOf = (file: string) => relative(APP, file).split(sep).slice(0, -1).join('/');
/** A dynamic segment that names a thing (not the workspace itself, not the catch-all, which IS the 404). */
const namesAThing = (route: string) => route.split('/').some((s) => /^\[[^.\]][^\]]*\]$/.test(s) && s !== '[ws]');

/** Where the gate lives for each thing-page: the file that calls `entityGateView(` / renders `<QuillNotFound`. */
const CARRIER: Record<string, string> = {
  'w/[ws]/d/[db]': 'app/w/[ws]/d/[db]/page.tsx',
  'w/[ws]/d/[db]/r/[rec]': 'components/entity/record-detail.tsx',
  'w/[ws]/d/[db]/relations': 'app/w/[ws]/d/[db]/relations/page.tsx',
  'w/[ws]/d/[db]/trash': 'app/w/[ws]/d/[db]/trash/page.tsx',
  'w/[ws]/doc/[doc]': 'app/w/[ws]/doc/[doc]/page.tsx',
  'w/[ws]/v/[view]': 'app/w/[ws]/v/[view]/page.tsx',
  'w/[ws]/s/[space]': 'app/w/[ws]/s/[space]/page.tsx',
  'w/[ws]/skills/[id]': 'app/w/[ws]/skills/[id]/page.tsx',
  'w/[ws]/agents/[agent]': 'components/runners/agent-page.tsx',
  'w/[ws]/reviews/[owner]/[repo]/[number]': 'app/w/[ws]/reviews/[owner]/[repo]/[number]/page.tsx',
  'w/[ws]/settings/integrations/[provider]': 'app/w/[ws]/settings/integrations/[provider]/page.tsx',
};
/** Public, signed-out pages reached by a shared link. They have no workspace to go Home to and their own not-found; unifying them
 *  is a separate decision (ticket #1291, deferred on the ticket). */
const EXEMPT: Record<string, string> = {
  'f/[token]': 'public form: own not-found, no shell',
  's/[token]': 'public share: own not-found, no shell',
  'v/[token]': 'public view: own not-found, no shell',
  'packs/[slug]': 'public pack landing: own not-found, no shell',
};
const GONE_STRING = /(Item|Document|View|Agent|Pack) not found|There is no integration called|Nothing here you can access|does not exist, or is not shared/;
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('every route that names a thing draws the one not-found page (derived from the route table)', () => {
  const routes = pages(APP).map(routeOf).filter(namesAThing).sort();

  it('the derived route table is non-trivial (the script found the routes, not zero)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
    expect(routes).toContain('w/[ws]/d/[db]');
    expect(routes).toContain('w/[ws]/d/[db]/r/[rec]');
  });

  it('every such route is carried by the shared gate or exempt with a reason, and nothing stale is listed', () => {
    expect(routes.filter((r) => !(r in CARRIER) && !(r in EXEMPT)), 'a route that names a thing and is not classified').toEqual([]);
    expect([...Object.keys(CARRIER), ...Object.keys(EXEMPT)].filter((r) => !routes.includes(r)), 'a classified route that no longer exists').toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
  });

  for (const [route, file] of Object.entries(CARRIER)) {
    it(`${route} reads its thing through the gate and keeps no one-off wording`, () => {
      const src = read(file);
      expect(src, `${file} must route a gone/failed answer through the shared gate`).toMatch(/entityGateView\(|<QuillNotFound/);
      expect(src).not.toMatch(GONE_STRING);
    });
  }

  it('the database page never waits on an errored query: the skeleton is only for "loading"', () => {
    const src = read('app/w/[ws]/d/[db]/page.tsx');
    expect(src).not.toMatch(/if \(database\.isLoading\) return/);
    expect(src).toMatch(/dbState\.kind === 'loading'/);
  });
});
