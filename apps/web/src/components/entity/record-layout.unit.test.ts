import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_PANEL_TABS, RECORD_SIDE_MIN_W, RECORD_SPLIT_QUERY, recordLayoutMode } from './record-layout';

// Ticket #1277 — the breakpoint split of the record page: Activity / Comments / About is a side column from 900px and stacks under the
// fields below it. The desktop half is the one that must not move.
describe('recordLayoutMode', () => {
  it('is split at 900px and wider, so the desktop layout keeps its side column', () => {
    for (const w of [900, 901, 1024, 1270, 1920]) expect(recordLayoutMode(w)).toBe('split');
  });

  it('stacks below 900px: phones, and the 768-899px band the side column never fitted in', () => {
    for (const w of [320, 375, 390, 767, 768, 899]) expect(recordLayoutMode(w)).toBe('stacked');
  });

  it('keeps the breakpoint at exactly 900 (899 and 900 sit on opposite sides)', () => {
    expect(RECORD_SIDE_MIN_W).toBe(900);
    expect(recordLayoutMode(RECORD_SIDE_MIN_W - 1)).toBe('stacked');
    expect(recordLayoutMode(RECORD_SIDE_MIN_W)).toBe('split');
  });

  it('derives the media query that mounts the side column from the same number', () => {
    expect(RECORD_SPLIT_QUERY).toBe('(min-width: 900px)');
  });
});

describe('the record page source agrees with the helper', () => {
  const src = readFileSync(join(__dirname, 'record-detail.tsx'), 'utf8');

  it('hides the side column below the helper breakpoint with the matching Tailwind literal', () => {
    expect(src).toContain(`min-[${RECORD_SIDE_MIN_W}px]:flex`);
  });

  it('offers the same three tabs in the same order in both layouts', () => {
    expect(RECORD_PANEL_TABS.map((t) => t.value)).toEqual(['activity', 'comments', 'about']);
    expect(src.match(/options=\{RECORD_PANEL_TABS\}/g)?.length).toBe(2);
  });
});
