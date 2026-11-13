import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isUnreadRow, notificationActorClass, notificationRowStateClass } from './notification-unread';

/** Ticket #1279 — unread is visible on the full Inbox page, one marker on both surfaces, a selected row stays selected. */
describe('notificationRowStateClass', () => {
  it('tints an unread row and leaves a read row plain', () => {
    expect(notificationRowStateClass({ unread: true })).toBe('bg-hover-soft');
    expect(notificationRowStateClass({ unread: false })).toBe('');
  });
  it('a selected row is bg-active whether it is read or unread, never the unread tint', () => {
    expect(notificationRowStateClass({ unread: true, selected: true })).toBe('bg-active');
    expect(notificationRowStateClass({ unread: false, selected: true })).toBe('bg-active');
  });
});

describe('notificationActorClass', () => {
  it('weights the unread actor heavier than the read one', () => {
    expect(notificationActorClass(true)).toBe('font-semibold');
    expect(notificationActorClass(false)).toBe('font-medium');
  });
});

describe('isUnreadRow', () => {
  it('comes from the real read flag', () => {
    expect(isUnreadRow({ read_at: null })).toBe(true);
    expect(isUnreadRow({ read_at: '2026-11-11T10:00:00Z' })).toBe(false);
  });
  it('keeps an archived row out of the unread look (history is not new)', () => {
    expect(isUnreadRow({ read_at: null }, { archivedView: true })).toBe(false);
  });
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
describe.each([
  ['the full-page inbox', '../app/w/[ws]/inbox/page.tsx'],
  ['the inbox slide-over', './inbox-panel.tsx'],
] as const)('%s', (_n, path) => {
  const text = read(path);
  it('draws unread through the shared marker, not its own bg-hover-soft/dot', () => {
    expect(text).toContain("from '@/components/notification-unread'");
    expect(text).toMatch(/<UnreadDot \/>/);
    expect(text).not.toMatch(/'bg-hover-soft'/);
    expect(text).not.toMatch(/\bh-1\.5 w-1\.5\b/);
  });
});

describe('the slide-over header icon buttons', () => {
  const text = read('./inbox-panel.tsx');
  it('both carry an accessible name', () => {
    expect(text).toContain('aria-label="Open full inbox"');
    expect(text).toContain('aria-label="Close inbox"');
  });
});
