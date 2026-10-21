import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The skeleton reads the sidebar's cached database list through react-query; the API client is not
// constructible outside the app runtime, and the list is seeded straight into the cache below.
vi.mock('@/lib/api', () => ({ api: {}, apiFetch: vi.fn() }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { DatabasePageSkeleton, SKELETON_ROWS } = await import('./database-page-skeleton');

function render(seed?: Array<{ id: string; name: string; icon?: string | null; color?: string | null }>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) qc.setQueryData(['databases', 'w1'], seed);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(DatabasePageSkeleton, { ws: 'w1', db: 'd2' })),
  );
}

describe('DatabasePageSkeleton (#998): the click is answered with the page, not a bare "Loading…"', () => {
  it('names the database it is opening when the sidebar already knows it', () => {
    const html = render([{ id: 'd1', name: 'Projects' }, { id: 'd2', name: 'Tasks' }]);
    expect(html).toContain('Tasks');
    expect(html).not.toContain('Projects');
    expect(html).toContain('aria-label="Loading Tasks"');
  });

  it('draws a grey bar in place of the name when the list is not cached — never another database\'s name', () => {
    const html = render([{ id: 'd1', name: 'Projects' }]);
    expect(html).not.toContain('Projects');
    expect(html).toContain('aria-label="Loading"');
  });

  it('is a busy status region with a fixed number of grid rows, and never the bare text it replaced', () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/h-9 items-center/g)).toHaveLength(SKELETON_ROWS);
    expect(html).not.toMatch(/>Loading…</);
  });

  it('pulses only for people who have not asked for reduced motion', () => {
    expect(render()).toContain('motion-safe:animate-pulse');
    expect(render()).not.toMatch(/(?<!motion-safe:)animate-pulse/);
  });
});
