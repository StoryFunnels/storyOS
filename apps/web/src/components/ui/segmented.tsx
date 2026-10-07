import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import { useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * #738 — the one primitive the redesign prototypes needed that did not exist.
 *
 * Four sites had already hand-rolled this control, and the drift was not just
 * padding. Measured on main before this ticket:
 *
 *   slack/page.tsx        px-3   py-1.5  13px  selected: bg-primary
 *   automations-panel     px-2   py-0.5  12px  selected: bg-hover
 *   field-dialog-shared   px-2.5 py-1    12px  selected: bg-active
 *   calendar-view         px-2   py-0.5  12px  selected: bg-active
 *
 * THREE different selected treatments. To be precise about automations-panel,
 * because the tempting version of this claim is wrong: its unselected items had
 * `hover:text-ink` and NO hover background, so `bg-hover` as its selected
 * colour did not collide with anything at that site — it was an inconsistency,
 * not a live bug. Measured, `bg-hover` is rgb(245,243,239) against `bg-active`
 * rgb(231,224,206), so "selected" simply read far fainter in that one panel
 * than in the other two.
 *
 * It WOULD become a collision here, though, which is why the choice matters:
 * this primitive gives unselected items a real `hover:bg-hover` affordance that
 * site never had. Keeping `bg-hover` for selected would make a hovered
 * unselected item render identically to the selected one. `bg-active` is what
 * "this one is chosen" means; `bg-hover` is what "your pointer is here" means.
 *
 * So `subtle` (bg-active) is the default — what 2 of the 4 sites already did,
 * and the one that stays legible once hover is added. `solid` (bg-primary) is
 * kept as a real variant rather than normalised away: the Slack page uses it
 * for a primary method chooser that is the whole point of the step, and a
 * louder selected state there is a deliberate choice, not drift.
 *
 * Sizes are the two shapes the call sites converged on, expressed in the #624
 * role tokens rather than raw px — `text-body` (13px) and `text-label` (12px),
 * both already registered in lib/utils.ts's twMerge font-size classGroups per
 * #664, so no new key to register there.
 *
 * The inner radius is `calc(var(--radius-control) - 2px)`: the container has
 * `p-0.5` (2px), so a nested item at the full control radius bulges past its
 * own border. Only the Slack site got this right; the other three used plain
 * `rounded`, the same token-bypass #688 called out as "almost certainly an
 * oversight".
 *
 * A11y: this is a single-select, so it is a `radiogroup` with roving tabindex
 * and arrow-key navigation, not a row of buttons. None of the four hand-rolled
 * copies had any ARIA at all — a keyboard user could tab to each item but
 * nothing announced the group or which member was chosen.
 */
const segmentedItemVariants = cva(
  'rounded-[calc(var(--radius-control)-2px)] transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      size: {
        default: 'px-3 py-1.5 text-body',
        sm: 'px-2 py-0.5 text-label',
      },
      variant: { subtle: '', solid: '' },
      selected: { true: '', false: '' },
    },
    compoundVariants: [
      { variant: 'subtle', selected: true, class: 'bg-active font-medium text-ink' },
      { variant: 'subtle', selected: false, class: 'text-muted hover:bg-hover hover:text-ink' },
      { variant: 'solid', selected: true, class: 'bg-primary font-medium text-[var(--text-on-dark)]' },
      { variant: 'solid', selected: false, class: 'text-ink-secondary hover:bg-hover' },
    ],
    defaultVariants: { size: 'sm', variant: 'subtle', selected: false },
  },
);

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Native tooltip, for icon-only or abbreviated labels. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string>
  extends Omit<VariantProps<typeof segmentedItemVariants>, 'selected'> {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for screen readers, e.g. "Calendar mode". */
  label: string;
  className?: string;
  /** Per-item class, for the rare site that needs its own padding. */
  itemClassName?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size,
  variant,
  className,
  itemClassName,
}: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  /* Arrow keys move the selection, which is what a radiogroup does — Tab
     enters and leaves the group as a single stop. Wraps at both ends. */
  function onKeyDown(e: React.KeyboardEvent) {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    const usable = options.filter((o) => !o.disabled);
    if (usable.length < 2) return;
    e.preventDefault();
    const at = usable.findIndex((o) => o.value === value);
    const next = usable[(at + delta + usable.length) % usable.length];
    if (!next) return;
    onChange(next.value);
    // Keep focus on the group's selected item after the move.
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    });
  }

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-[var(--radius-control)] border border-border-default p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            disabled={o.disabled}
            /* Roving tabindex: the group is one tab stop, not N. */
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(segmentedItemVariants({ size, variant, selected }), itemClassName)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export { segmentedItemVariants };
