import { describe, expect, it } from 'vitest';
import { selectVariants } from './select';

/**
 * #627 — the point of this primitive is that adopting it does not restyle
 * anything, and a comment claiming that decays the moment someone tunes a
 * variant. So the claim is a test.
 *
 * The three strings below are the ACTUAL dominant class strings found on raw
 * `<select>` elements in apps/web/src when the primitive was written (19, 16
 * and 11 call sites respectively — see the ticket #623 audit). If a variant
 * drifts away from the markup it was built to replace, the migration stops
 * being a rename and this fails.
 *
 * A test cannot tell you whether the pixels match; only that the classes do.
 * The visual check belongs in the browser and is recorded on the PR.
 */
const EXISTING = {
  default:
    'h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink',
  sm: 'h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink',
  xs: 'h-6 rounded border border-border-default bg-card px-1 text-[12px] text-ink',
} as const;

/** Classes the primitive adds on purpose; every one needs a stated reason. */
const DELIBERATE_ADDITIONS = new Set([
  // Inert unless the select is disabled. 113 of the 114 raw selects had no
  // disabled treatment at all, so this is an improvement that cannot regress a
  // rendered pixel on an enabled control.
  'disabled:cursor-not-allowed',
  'disabled:opacity-50',
]);

/**
 * #634 — the UI type scale replaced the arbitrary sizes with role-named tokens,
 * and this test started failing on the RENAME even though nothing rendered
 * differently. That failure was the guard working: the class string genuinely
 * changed. But the comparison it makes is about reproducing the markup's
 * RESULT, so it now normalises a token back to the literal it is defined as.
 *
 * Every pair below was verified in a browser to compute identically — e.g.
 * `text-body` and `text-[13px]` both resolve to 13px / 19.5px, because the
 * scale's values were chosen to match what the arbitrary sizes already
 * rendered. If a token's value is ever changed, these pairs stop being true and
 * this map is the thing that has to be revisited — which is the point of
 * spelling them out rather than stripping text-* from the comparison.
 */
const TOKEN_EQUIVALENT: Record<string, string> = {
  'text-micro': 'text-[10px]',
  'text-meta': 'text-[11px]',
  'text-label': 'text-[12px]',
  'text-body': 'text-[13px]',
  'text-prose': 'text-[14px]',
  'text-title': 'text-[16px]',
};

const set = (s: string) =>
  new Set(
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => TOKEN_EQUIVALENT[c] ?? c),
  );

describe('#627 — Select variants reproduce the markup they replace', () => {
  it('adds nothing to `default` and `sm` beyond the disabled treatment', () => {
    for (const size of ['default', 'sm'] as const) {
      const got = set(selectVariants({ size }));
      const want = set(EXISTING[size]);
      const extra = [...got].filter((c) => !want.has(c) && !DELIBERATE_ADDITIONS.has(c));
      const missing = [...want].filter((c) => !got.has(c));
      expect(extra, `variant "${size}" adds unexplained classes`).toEqual([]);
      expect(missing, `variant "${size}" drops classes the raw markup had`).toEqual([]);
    }
  });

  it('differs from the small raw selects ONLY by the radius token', () => {
    // The h-6 raw selects use bare `rounded` (4px) while the token is 6px.
    // Adopting the token here is intentional, and it IS a 2px visual change at
    // those 11 call sites — asserted so it stays a known, single difference
    // rather than becoming an unnoticed pile of them.
    const got = set(selectVariants({ size: 'xs' }));
    const want = set(EXISTING.xs);
    const extra = [...got].filter((c) => !want.has(c) && !DELIBERATE_ADDITIONS.has(c));
    const missing = [...want].filter((c) => !got.has(c));
    expect(extra).toEqual(['rounded-[var(--radius-control)]']);
    expect(missing).toEqual(['rounded']);
  });

  it('pairs a height with a text size in every variant', () => {
    // The defect this primitive exists to stop: a control whose text size is
    // left to inheritance, so it changes depending on where it is mounted.
    for (const size of ['default', 'sm', 'xs'] as const) {
      const cls = selectVariants({ size });
      expect(cls, `variant "${size}" has no height`).toMatch(/\bh-\d/);
      // NOT `\])\b` — a word boundary after `]` never matches, so that version
      // failed on `text-[13px]` while quietly passing on `text-sm`.
      // The role names (#634) count as a size too — that is the whole point of
      // the scale, and a variant sized with one is not "left to inheritance".
      expect(cls, `variant "${size}" has no text size`).toMatch(
        /\btext-(sm|base|lg|micro|meta|label|body|prose|title|\[\d+px\])(?![\w-])/,
      );
    }
  });

  it('defaults to the same shape as Input, so a select and an input can sit in one row', () => {
    // ui/input.tsx is `h-9 … px-3 text-sm`. Heights and text sizes must agree;
    // the horizontal padding legitimately differs because a native select
    // reserves room for its own chevron.
    const cls = selectVariants({});
    expect(cls).toContain('h-9');
    expect(cls).toContain('text-sm');
  });
});
