import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  INBOX_ROW_AVATAR_SIZE,
  INBOX_ROW_LINE,
  INBOX_ROW_PADDING,
  INBOX_ROW_TIME_CLASS,
  isUnreadRow,
  notificationActorClass,
  notificationRowStateClass,
} from './notification-unread';

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

/** Ticket #1279 item 5 — the dense page row, and what it must KEEP. */
describe('the dense full-page row', () => {
  const text = read('../app/w/[ws]/inbox/page.tsx');
  it('is 10px/20px padding, an 18px avatar and a 10px faint time', () => {
    expect(INBOX_ROW_PADDING).toBe('px-5 py-2.5');
    expect(INBOX_ROW_AVATAR_SIZE).toBe(18);
    expect(INBOX_ROW_TIME_CLASS).toBe('text-micro text-faint');
    expect(INBOX_ROW_LINE).toBe('leading-4');
  });
  it('draws the row from those, not from its own 12px padding / 24px avatar / 11px time', () => {
    expect(text).toContain('INBOX_ROW_PADDING');
    expect(text).toContain('size={INBOX_ROW_AVATAR_SIZE}');
    expect(text).toContain('INBOX_ROW_TIME_CLASS');
    expect((text.match(/INBOX_ROW_LINE/g) ?? []).length).toBeGreaterThanOrEqual(4); // import + the actor line + the record line + the snippet line
    expect(text).not.toMatch(/WhoAvatar who=\{notificationWho\(n\)\} size=\{24\}/);
    expect(text).not.toMatch(/text-meta text-faint/);
  });
  it('keeps the unread cues the density change must not cost: dot, heavier actor, selected-over-unread', () => {
    expect(text).toMatch(/<UnreadDot \/>/);
    expect(text).toContain('notificationActorClass(unread)');
    expect(text).toContain('notificationRowStateClass({ unread, selected:');
  });
  it('shows an agent with the shared agent mark at the row size, not a re-drawn one', () => {
    const who = read('./approvals/who.tsx');
    expect(who).toContain('<AgentAvatar');
    expect(who).toMatch(/size === 18 \? 'sm'/);
  });
});
