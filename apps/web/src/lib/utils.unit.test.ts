import { describe, expect, it } from 'vitest';
import { cn } from './utils';

/**
 * #664 — the guard for a bug that was invisible on screen.
 *
 * `cn()` runs tailwind-merge, which decides what conflicts from Tailwind's own
 * scales. The role type steps (#624/#634) are custom `text-*` theme keys, and so
 * are the text colours, so out of the box it treated them as one group and kept
 * the last — deleting the font size. Nothing broke visibly, because an element
 * with no font-size inherits one, and `body` is 14px: a Label and its Input
 * agreed by coincidence rather than by rule.
 *
 * These assert the SIZE SURVIVES A COLOUR. A regression here does not show up as
 * a wrong-looking screen; it shows up as a screen that is right for the wrong
 * reason, which is why it needs a test rather than an eye.
 */
describe('cn() keeps a role font size alongside a text colour (#664)', () => {
  const SIZES = ['text-micro', 'text-meta', 'text-label', 'text-body', 'text-prose', 'text-title'];
  const COLORS = ['text-ink', 'text-ink-secondary', 'text-muted', 'text-faint'];

  for (const size of SIZES) {
    for (const color of COLORS) {
      it(`${size} survives ${color}`, () => {
        const out = cn(size, color).split(' ');
        expect(out).toContain(size);
        expect(out).toContain(color);
      });
    }
  }

  it('keeps the size when other utilities sit between it and the colour', () => {
    // The exact shape ui/label.tsx uses.
    const out = cn('text-prose font-medium text-ink-secondary').split(' ');
    expect(out).toContain('text-prose');
    expect(out).toContain('text-ink-secondary');
  });

  it('keeps the size for the outline chip, whose class list comes from cva', () => {
    const out = cn(
      'inline-flex items-center gap-1 truncate rounded-[var(--radius-chip)] px-1.5 py-0.5',
      'border-[1.4px] border-border-strong text-body text-ink',
      'max-w-full',
    ).split(' ');
    expect(out).toContain('text-body');
    expect(out).toContain('text-ink');
  });

  it('STILL resolves two sizes against each other — last wins', () => {
    // The point is not "never merge text-*"; it is to classify the role steps
    // correctly. Two sizes must still conflict, or a caller could not override.
    expect(cn('text-body', 'text-title')).toBe('text-title');
    expect(cn('text-title text-body')).toBe('text-body');
  });

  it('leaves the arbitrary-value form working, as it always did', () => {
    const out = cn('text-[13px] text-ink').split(' ');
    expect(out).toContain('text-[13px]');
    expect(out).toContain('text-ink');
  });

  it('still merges ordinary conflicting utilities', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-ink', 'text-muted')).toBe('text-muted');
  });
});
