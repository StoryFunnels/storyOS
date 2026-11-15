import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Ticket #1291 — every PUBLIC, signed-out page answers an unknown / revoked / unpublished / private id with the SAME Quill 404
 * (real HTTP 404, no app shell, one way back: the marketing site), and answers a FAILED LOAD with a retry — never the 404.
 *
 * The route list is DERIVED from the app route table, not hand-listed: a page under app/ is public when it reads the
 * unauthenticated `/public/` API. A fifth public route added tomorrow is covered the moment it exists, and fails here until it
 * has its not-found and error boundary.
 */

const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const APP = __dirname;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const publicPages = walk(APP).filter((f) => f.endsWith('/page.tsx') && /\/api\/v1\/public\//.test(readFileSync(f, 'utf8')));
const routeOf = (f: string) => relative(APP, f).replace(/\/page\.tsx$/, '');

afterEach(() => vi.unstubAllGlobals());

describe('the public route table (derived)', () => {
  it('finds the four public routes', () => {
    expect(publicPages.map(routeOf).sort()).toEqual(['f/[token]', 'packs/[slug]', 's/[token]', 'v/[token]']);
  });

  for (const page of publicPages) {
    const dir = join(page, '..');
    describe(routeOf(page), () => {
      it('has the shared not-found and a retry error boundary', () => {
        const nf = readFileSync(join(dir, 'not-found.tsx'), 'utf8');
        expect(nf).toMatch(/PublicNotFound/);
        expect(nf).not.toMatch(/Sidebar|AppShell|\/w\//);
        const err = readFileSync(join(dir, 'error.tsx'), 'utf8');
        expect(err).toMatch(/^'use client'/);
        expect(err).toMatch(/PublicLoadError/);
      });
      it('resolves server-side through the one shared read and calls notFound() on null', () => {
        const src = strip(readFileSync(page, 'utf8'));
        expect(src).toMatch(/fetchPublicJson/);
        expect(src).toMatch(/notFound\(\)/);
        expect(src).not.toMatch(/'use client'/);
        expect(src).not.toMatch(/Form not found|Pack not found|View not found|isn’t available/);
      });
    });
  }
});

const PARAMS: Record<string, unknown> = {
  'f/[token]': { token: 'tok' },
  's/[token]': { token: 'tok' },
  'v/[token]': { token: 'tok' },
  'packs/[slug]': { slug: 'pack' },
};

describe('unknown vs failed, per route (behaviour)', () => {
  for (const page of publicPages) {
    const route = routeOf(page);
    const run = async () => {
      const mod = (await import(/* @vite-ignore */ page)) as { default: (p: unknown) => Promise<unknown> };
      return mod.default({ params: Promise.resolve(PARAMS[route]), searchParams: Promise.resolve({}) });
    };
    for (const status of [404, 403, 401, 400, 422]) {
      it(`${route}: HTTP ${status} from the API is the 404 (no distinction between never-existed and private)`, async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
        await expect(run()).rejects.toBe(NOT_FOUND);
      });
    }
    it(`${route}: a 500 is a load failure, NOT the 404`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
      const err = await run().catch((e: unknown) => e);
      expect(err).not.toBe(NOT_FOUND);
      expect(err).toMatchObject({ name: 'PublicLoadError', status: 500 });
    });
    it(`${route}: a network failure is a load failure, NOT the 404`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
      const err = await run().catch((e: unknown) => e);
      expect(err).not.toBe(NOT_FOUND);
      expect(err).toBeInstanceOf(TypeError);
    });
  }
});

describe('the pages themselves', () => {
  it('the public 404 is the Quill page with "Go to storyos.dev" to the marketing URL, and no workspace link', async () => {
    const { PublicNotFound } = await import('@/components/quill/not-found-view');
    const { MARKETING_URL } = await import('@/lib/marketing');
    const html = renderToStaticMarkup(createElement(PublicNotFound));
    expect(html).toContain('data-testid="not-found"');
    expect(html).toContain('This page doesn’t exist');
    expect(html).toContain('This was a page once.');
    expect(html).toContain(`href="${MARKETING_URL}"`);
    expect(html).toContain('Go to storyos.dev');
    expect(html).not.toMatch(/href="\/w\//);
    expect(html).not.toContain('Go home');
  });

  it('the load-failure page says it is not a 404 and offers a retry', async () => {
    const { PublicLoadError } = await import('@/components/quill/public-load-error');
    const html = renderToStaticMarkup(createElement(PublicLoadError, { error: new Error('x'), reset: () => {} }));
    expect(html).toContain('data-testid="public-load-error"');
    expect(html).toContain('Try again');
    expect(html).not.toContain('doesn’t exist');
  });

  it('the workspace 404 still says "Go home" (the shared body is not forked)', async () => {
    const { QuillNotFound } = await import('@/components/quill/not-found-view');
    const html = renderToStaticMarkup(createElement(QuillNotFound));
    expect(html).toContain('Go home');
    expect(html).toContain('This page doesn’t exist');
  });
});
