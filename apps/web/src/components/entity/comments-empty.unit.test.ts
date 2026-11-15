import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => {} }), usePathname: () => '/' }));
// The composer is a BlockNote editor (client-only) and is not what is under test: the thread above it is.
vi.mock('@/lib/theme', () => ({ useTheme: () => ({ resolved: 'light' }) }));
vi.mock('@/lib/preferences', () => ({ useDateFormat: () => ({ dateTime: (d: string) => d, date: (d: string) => d }) }));
vi.mock('@blocknote/react', () => ({ useCreateBlockNote: () => ({}) }));
vi.mock('@blocknote/mantine', () => ({ BlockNoteView: () => null }));
vi.mock('./mentions', () => ({ MentionScope: ({ children }: { children: unknown }) => children, MentionSuggestionMenus: () => null, mentionSchema: {} }));

import { CommentsPanel } from './panels';

/*
 * Ticket #1277 item 10 — the Comments tab of a record (full page side panel AND the peek's Comments tab: one component) says
 * "No comments yet." through the shared EmptyState list variant when the thread LOADED empty. Rendered here with the thread's
 * query pre-seeded, so what a person SEES is asserted, not the source text.
 */
const KEY = ['comments', 'w', 'd', 'r'];
function render(seed: { data?: unknown[]; error?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed.data) qc.setQueryData(KEY, seed.data);
  const el = createElement(
    QueryClientProvider,
    { client: qc },
    createElement(TooltipProvider, null, createElement(CommentsPanel, { ws: 'w', db: 'd', rec: 'r', members: [], currentUserId: 'u', isAdmin: false })),
  );
  return renderToStaticMarkup(el);
}
const comment = { id: 'c1', author: { id: 'u', name: 'Ada' }, body: [{ type: 'text', text: 'First!' }], created_at: '2026-11-01T10:00:00Z', source: 'human' };

describe('the Comments tab empty state (ticket #1277 item 10)', () => {
  it('a thread that loaded empty says "No comments yet." as the list variant: one muted line, no heading, no button', () => {
    const out = render({ data: [] });
    expect(out).toContain('data-empty-state="list"');
    expect(out).toContain('No comments yet.');
    expect(out).not.toContain('<h3');
  });
  it('KEEPS: a thread with a comment shows the comment and NOT the empty line', () => {
    const out = render({ data: [comment] });
    expect(out).toContain('First!');
    expect(out).not.toContain('No comments yet');
  });
  it('KEEPS: a thread that has not loaded yet claims nothing (no "No comments yet" about an unread thread)', () => {
    expect(render({})).not.toContain('No comments yet');
  });
});
