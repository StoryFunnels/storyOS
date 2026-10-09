import { describe, expect, it } from 'vitest';
import { cn } from './utils';

/**
 * #792 — `cn()` runs tailwind-merge, which only knows a custom font-size step if
 * it is declared. An undeclared step (`text-reading`) is read as a COLOUR, so it
 * "conflicts" with `text-ink-secondary` and is silently deleted: the element then
 * inherits whatever size is above it. CI never shows it; the block just renders
 * at 14px instead of 13px. Every step in globals.css must survive beside a colour.
 */
describe('cn() keeps every declared font-size step beside a colour', () => {
  for (const step of ['micro', 'meta', 'label', 'body', 'prose', 'reading', 'title']) {
    it(`text-${step}`, () => {
      expect(cn(`text-${step}`, 'text-ink-secondary')).toBe(`text-${step} text-ink-secondary`);
    });
  }
  it('still lets a later size override an earlier one', () => {
    expect(cn('text-body', 'text-title')).toBe('text-title');
  });
});
