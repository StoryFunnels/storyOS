import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENTITY_COLORS } from '@storyos/schemas';
import { nextSpaceColor } from './space-color';

const P = DEFAULT_ENTITY_COLORS;
const sp = (color: string | null, createdAt: string, position = 0, personal = false) => ({ color, createdAt, position, personal });

describe('nextSpaceColor (#1094)', () => {
  it('starts at the first hue when no space has a colour yet', () => {
    expect(nextSpaceColor([])).toBe(P[0]);
    expect(nextSpaceColor([sp(null, '2026-01-01')])).toBe(P[0]);
  });
  it('is the hue after the most recently created coloured space', () => {
    expect(nextSpaceColor([sp(P[0], '2026-01-01'), sp(P[1], '2026-01-02')])).toBe(P[2]);
  });
  it('goes by creation time, not by list order or by an older space with a later hue', () => {
    expect(nextSpaceColor([sp(P[4], '2026-01-01'), sp(P[1], '2026-02-01')])).toBe(P[2]);
  });
  it('wraps round after the last hue', () => {
    expect(nextSpaceColor([sp(P[P.length - 1]!, '2026-01-01')])).toBe(P[0]);
  });
  it('ignores uncoloured spaces, a personal space, and a colour outside the palette (existing greys are left alone)', () => {
    const list = [sp(P[2], '2026-01-01'), sp(null, '2026-03-01'), sp(P[5], '2026-04-01', 0, true), sp('lime', '2026-05-01')];
    expect(nextSpaceColor(list)).toBe(P[3]);
  });
  it('falls back to position when the list has no creation times', () => {
    expect(nextSpaceColor([{ color: P[0], position: 0 }, { color: P[3], position: 1 }])).toBe(P[4]);
  });
  it('only ever returns a palette hue the API accepts as a space colour', () => {
    for (let i = 0; i < P.length; i++) expect(P).toContain(nextSpaceColor([sp(P[i]!, '2026-01-01')]));
  });
});

describe('colour on creation: wiring (#1094)', () => {
  const sidebar = readFileSync(join(__dirname, '../components/sidebar.tsx'), 'utf8');
  it('the one-click creator SENDS the colour with the create, so the space is born with it', () => {
    expect(sidebar).toMatch(/createSpace\.mutate\(\s*[\s\S]*\{ name: UNTITLED_SPACE, color: nextSpaceColor\(spaces\.data \?\? \[\]\) \}/);
  });
});
