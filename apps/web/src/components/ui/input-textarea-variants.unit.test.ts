import { describe, expect, it } from 'vitest';
import { inputVariants } from './input';
import { textareaVariants } from './textarea';

/**
 * #688/#689 — the same claim select-variants.unit.test.ts makes for
 * `ui/select.tsx` (#627): adopting the primitive must not restyle anything,
 * and a comment saying so decays the moment someone tunes a variant. So the
 * claim is a test, not a comment.
 *
 * The EXISTING strings below are copied verbatim from `git diff`'s removed
 * lines for the sites each size replaces (not retyped from memory), so a
 * drifted variant fails here instead of only in a screenshot nobody reruns.
 *
 * A test cannot tell you whether the pixels match; only that the classes do.
 * The visual check belongs in the browser and is recorded on the PR.
 */

// admin/page.tsx, import-wizard.tsx, dashboard-view.tsx, dashboard-widgets.tsx,
// confirm-dialog.tsx, form-view.tsx — the group-A `<input>` sites.
const INPUT_EXISTING_SM = 'h-8 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink';
// summary-widget-strip.tsx — the group-B site that got its own size, still on
// the plain `rounded` bypass this migration was also asked to fix.
const INPUT_EXISTING_XS = 'h-7 rounded border border-border-default bg-card px-1.5 text-[12px] text-ink placeholder:text-muted';

// button-actions-editor.tsx's Slack/webhook/HTTP-body textareas — the
// ticket's explicit "almost certainly an oversight" plain-`rounded` callout.
const TEXTAREA_EXISTING_SM = 'min-h-[56px] rounded border border-border-default bg-card px-2 py-1 text-[12px] text-ink';
// packs/submit/page.tsx's Summary/Screenshots fields — already on the token
// and already full-width; the ONLY site-level difference is that this one
// site keeps Tailwind's native `text-sm`/`px-3`/`py-2` instead of the custom
// scale, applied via its own className override, not claimed by `default`.
const TEXTAREA_EXISTING_DEFAULT = 'min-h-20 w-full rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2 text-sm text-ink';

/**
 * Classes the primitives add unconditionally that the hand-rolled markup
 * didn't always spell out — each one is a decision, not an oversight:
 * `flex`/`w-full` (Input) so a caller never has to remember the wrapper
 * layout; `w-full` (Textarea) ditto; `placeholder:text-muted` (#689 AC2 —
 * no future contrast sweep should have to find a broken placeholder by grep).
 */
const DELIBERATE_ADDITIONS = new Set(['flex', 'w-full', 'placeholder:text-muted']);

/**
 * Same normalisation select-variants.unit.test.ts uses (#634): the UI type
 * scale's role names resolve to the exact pixel values the arbitrary literals
 * they replace already rendered — verified in a browser, not assumed. Also
 * covers `min-h-14` (Tailwind's own 3.5rem/56px token) vs the arbitrary
 * `min-h-[56px]` literal it numerically equals.
 */
const TOKEN_EQUIVALENT: Record<string, string> = {
  'text-micro': 'text-[10px]',
  'text-meta': 'text-[11px]',
  'text-label': 'text-[12px]',
  'text-body': 'text-[13px]',
  'text-prose': 'text-[14px]',
  'text-title': 'text-[16px]',
  'min-h-14': 'min-h-[56px]',
};

const set = (s: string) =>
  new Set(
    s
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => TOKEN_EQUIVALENT[c] ?? c),
  );

function assertReproduces(got: string, want: string, label: string) {
  const gotSet = set(got);
  const wantSet = set(want);
  const extra = [...gotSet].filter((c) => !wantSet.has(c) && !DELIBERATE_ADDITIONS.has(c));
  const missing = [...wantSet].filter((c) => !gotSet.has(c));
  expect(extra, `${label} adds unexplained classes`).toEqual([]);
  expect(missing, `${label} drops classes the raw markup had`).toEqual([]);
}

describe('#688 — Input sm/xs reproduce the markup they replace', () => {
  it('sm matches the byte-identical group-A sites (h-8/px-2/text-body)', () => {
    assertReproduces(inputVariants({ size: 'sm' }), INPUT_EXISTING_SM, 'size "sm"');
  });

  it('xs matches summary-widget-strip.tsx, modulo the decided rounded->token fix', () => {
    const got = set(inputVariants({ size: 'xs' }));
    const want = set(INPUT_EXISTING_XS);
    const extra = [...got].filter((c) => !want.has(c) && !DELIBERATE_ADDITIONS.has(c));
    const missing = [...want].filter((c) => !got.has(c));
    expect(extra.sort()).toEqual(['rounded-[var(--radius-control)]']);
    expect(missing).toEqual(['rounded']);
  });

  it('pairs a height with a text size in every variant — the defect this primitive exists to stop', () => {
    for (const size of ['default', 'sm', 'xs'] as const) {
      const cls = inputVariants({ size });
      expect(cls, `size "${size}" has no height`).toMatch(/\bh-\d/);
      expect(cls, `size "${size}" has no text size`).toMatch(
        /\btext-(sm|base|lg|micro|meta|label|body|prose|title|\[\d+px\])(?![\w-])/,
      );
    }
  });
});

describe('#689 — Textarea sm/default reproduce the markup they replace', () => {
  it('sm matches button-actions-editor.tsx\'s plain-`rounded` sites, modulo the decided token fix', () => {
    // The one KNOWN, decided difference: `rounded` (4px) -> `--radius-control`
    // (6px), called out on #688/#689 as "almost certainly an oversight".
    const got = set(textareaVariants({ size: 'sm' }));
    const want = set(TEXTAREA_EXISTING_SM);
    const extra = [...got].filter((c) => !want.has(c) && !DELIBERATE_ADDITIONS.has(c));
    const missing = [...want].filter((c) => !got.has(c));
    expect(extra.sort()).toEqual(['rounded-[var(--radius-control)]']);
    expect(missing).toEqual(['rounded']);
  });

  it('default matches packs/submit.tsx\'s shape, modulo its own site-level text-sm/px-3/py-2 override', () => {
    // packs/submit.tsx keeps Tailwind's native text-sm/px-3/py-2 via its own
    // className override — that's a per-site decision the ticket recorded,
    // not something the primitive's shared `default` claims to reproduce.
    const got = set(textareaVariants({ size: 'default' }));
    const want = set(TEXTAREA_EXISTING_DEFAULT);
    const siteOverridden = new Set(['text-sm', 'px-3', 'py-2', 'text-[13px]', 'px-2', 'py-1.5']);
    const extra = [...got].filter((c) => !want.has(c) && !DELIBERATE_ADDITIONS.has(c) && !siteOverridden.has(c));
    const missing = [...want].filter((c) => !got.has(c) && !siteOverridden.has(c));
    expect(extra, 'default adds classes beyond its own text-size/padding decision').toEqual([]);
    expect(missing, 'default drops classes beyond the site-level override').toEqual([]);
  });

  it('pairs a min-height with a text size in every variant', () => {
    for (const size of ['default', 'sm'] as const) {
      const cls = textareaVariants({ size });
      expect(cls, `size "${size}" has no min-height`).toMatch(/\bmin-h-/);
      expect(cls, `size "${size}" has no text size`).toMatch(
        /\btext-(sm|base|lg|micro|meta|label|body|prose|title|\[\d+px\])(?![\w-])/,
      );
    }
  });

  it('always applies a placeholder rule (#689 AC2 — no future contrast sweep has to find it by grep)', () => {
    for (const size of ['default', 'sm'] as const) {
      expect(textareaVariants({ size })).toContain('placeholder:text-muted');
    }
  });
});
