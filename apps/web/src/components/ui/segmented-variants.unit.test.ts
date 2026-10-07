import { describe, expect, it } from 'vitest';
import { segmentedItemVariants } from './segmented';

/**
 * #738 — same claim input-textarea-variants.unit.test.ts makes for #688/#689:
 * adopting the primitive must not restyle the sites it replaces, and a comment
 * saying so decays the moment someone tunes a variant. So it is a test.
 *
 * The EXISTING strings are copied verbatim from `git diff`'s removed lines,
 * not retyped from memory.
 *
 * A test cannot tell you whether the pixels match, only that the classes do.
 * The visual check belongs in the browser and is recorded on the PR.
 */

// calendar-view.tsx (month/week/day) and automations-panel.tsx (List/Canvas).
const EXISTING_SM_BOX = 'px-2 py-0.5';
// field-dialog-shared.tsx — the one site with a third padding, deliberately
// adopting `sm` instead. Kept here to document what changed, not to assert it.
const EXISTING_FIELD_DIALOG_BOX = 'px-2.5 py-1';
// slack/page.tsx — the `solid` chooser.
const EXISTING_DEFAULT_BOX = 'px-3 py-1.5';

describe('segmented sizes match the sites they replace', () => {
  it('sm keeps calendar-view and automations-panel byte-identical in box metrics', () => {
    const cls = segmentedItemVariants({ size: 'sm' });
    for (const c of EXISTING_SM_BOX.split(' ')) expect(cls).toContain(c);
  });

  it('default keeps the slack chooser byte-identical in box metrics', () => {
    const cls = segmentedItemVariants({ size: 'default' });
    for (const c of EXISTING_DEFAULT_BOX.split(' ')) expect(cls).toContain(c);
  });

  it('field-dialog-shared genuinely changes — its third padding is gone', () => {
    // Guards the DECISION, not the old look: if someone reintroduces px-2.5/py-1
    // as a size, this fails and they have to argue for a third size on purpose.
    const all = (['sm', 'default'] as const).map((size) => segmentedItemVariants({ size }));
    for (const cls of all) expect(cls).not.toContain(EXISTING_FIELD_DIALOG_BOX.split(' ')[0]);
  });
});

describe('type sizes come from the #624 role scale, not raw px', () => {
  it('sm is text-label (12px) — what three of the four sites hand-rolled', () => {
    expect(segmentedItemVariants({ size: 'sm' })).toContain('text-label');
  });

  it('default is text-body (13px) — what the slack chooser hand-rolled', () => {
    expect(segmentedItemVariants({ size: 'default' })).toContain('text-body');
  });

  it('no variant emits a raw text-[Npx]', () => {
    for (const size of ['sm', 'default'] as const)
      for (const variant of ['subtle', 'solid'] as const)
        for (const selected of [true, false])
          expect(segmentedItemVariants({ size, variant, selected })).not.toMatch(/text-\[\d/);
  });
});

describe('the selected state is bg-active, never bg-hover', () => {
  /**
   * automations-panel used `bg-hover` for its SELECTED tab. That was not a live
   * bug there — its unselected items had no hover background to collide with —
   * but it read far fainter than the other groups' `bg-active`
   * (rgb(245,243,239) vs rgb(231,224,206), measured in the browser). It becomes
   * a real collision under this primitive, which DOES give unselected items
   * `hover:bg-hover`. Hence the guard.
   */
  it('subtle selected uses bg-active', () => {
    expect(segmentedItemVariants({ variant: 'subtle', selected: true })).toContain('bg-active');
  });

  it('no selected variant uses bg-hover as its own background', () => {
    for (const variant of ['subtle', 'solid'] as const) {
      const cls = segmentedItemVariants({ variant, selected: true });
      // `hover:bg-hover` would be fine; a bare `bg-hover` is the bug.
      expect(cls.split(' ')).not.toContain('bg-hover');
    }
  });

  it('unselected still gets its hover affordance', () => {
    expect(segmentedItemVariants({ variant: 'subtle', selected: false })).toContain('hover:bg-hover');
  });

  it('solid selected stays the louder primary treatment the slack page chose', () => {
    const cls = segmentedItemVariants({ variant: 'solid', selected: true });
    expect(cls).toContain('bg-primary');
    expect(cls).toContain('text-[var(--text-on-dark)]');
  });
});

describe('the nested radius uses the control token, not plain rounded', () => {
  /**
   * The container has p-0.5 (2px), so an item at the full control radius bulges
   * past its own border. Only slack/page.tsx got this right; the other three
   * used plain `rounded` — the token-bypass #688 called "almost certainly an
   * oversight" and fixed for its own group-B sites.
   */
  it('emits calc(var(--radius-control) - 2px)', () => {
    expect(segmentedItemVariants({})).toContain('rounded-[calc(var(--radius-control)-2px)]');
  });

  it('never emits a bare `rounded`', () => {
    expect(segmentedItemVariants({}).split(' ')).not.toContain('rounded');
  });
});
