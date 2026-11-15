/**
 * Ticket #1277 item 6 (Otto's ruling, 2026-11-13) — the record peek has exactly two tabs: Details (what the peek always showed) and
 * Comments (the full page's CommentsPanel). Activity is full-page only; adding it here is the thing the ruling declined.
 */
export type PeekTab = 'details' | 'comments';

export const PEEK_TABS: ReadonlyArray<{ value: PeekTab; label: string }> = [
  { value: 'details', label: 'Details' },
  { value: 'comments', label: 'Comments' },
];
