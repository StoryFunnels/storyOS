import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HISTORY_RETENTION_NOTE } from './record-history-copy';

/** Ticket #1386 — the History dialog's retention sentence says what is true: a window by plan, removal from 2026-12-27, restore ends with it. */
describe('History dialog retention note (ticket #1386)', () => {
  it('names the plan window and the date the removal starts, and says removed changes cannot be restored', () => {
    expect(HISTORY_RETENTION_NOTE).toMatch(/plan/i);
    expect(HISTORY_RETENTION_NOTE).toContain('27 December 2026');
    expect(HISTORY_RETENTION_NOTE).toMatch(/removed automatically/);
    expect(HISTORY_RETENTION_NOTE).toMatch(/no longer be restored/);
  });

  it('does not promise deletion in the present tense (nothing is deleted before the date) or the old "pruned automatically" claim', () => {
    expect(HISTORY_RETENTION_NOTE).not.toMatch(/pruned/i);
    expect(HISTORY_RETENTION_NOTE).not.toMatch(/\bare (being )?(pruned|deleted|removed)\b(?! automatically)/);
    // every removal clause is tied to the date: no "older changes are removed" without "From 27 December 2026" before it
    expect(HISTORY_RETENTION_NOTE.indexOf('27 December 2026')).toBeLessThan(HISTORY_RETENTION_NOTE.indexOf('removed'));
  });

  it('does not state a day count (the exact number sits behind an admin-only endpoint, and a stale number would be a second source)', () => {
    expect(HISTORY_RETENTION_NOTE).not.toMatch(/\b\d+ days?\b/);
  });

  it('the dialog renders THIS constant, not a literal of its own', () => {
    const src = readFileSync(new URL('./record-history.tsx', import.meta.url), 'utf8');
    expect(src).toContain('{HISTORY_RETENTION_NOTE}');
    expect(src).not.toMatch(/pruned automatically/);
  });
});
