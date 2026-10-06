import { describe, expect, it } from 'vitest';
import { hasDbMarker } from './db-marker';

describe('hasDbMarker (#811)', () => {
  it('draws nothing when a database has neither an icon nor a colour — no empty slot', () => {
    for (const [icon, color] of [[null, null], [undefined, undefined], ['', ''], [null, ''], ['', null]] as const) {
      expect(hasDbMarker(icon, color), `${icon}/${color}`).toBe(false);
    }
  });

  // What the rule must KEEP: a configured database still gets its mark.
  it('draws the mark when there is an icon, a colour, or both', () => {
    expect(hasDbMarker('set:rocket', null)).toBe(true);
    expect(hasDbMarker(null, 'blue')).toBe(true);
    expect(hasDbMarker('set:rocket', 'blue')).toBe(true);
  });
});
