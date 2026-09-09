import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * #664 — tailwind-merge has to be TOLD that the role type scale is font sizes.
 *
 * `cn()` runs tailwind-merge so a caller's className can override a component's
 * default. Merging needs to know which utilities conflict, and it works that out
 * from Tailwind's OWN scales. `text-body` and `text-ink` are both custom theme
 * keys spelled `text-*`, so out of the box it guessed they were the same group
 * and kept the last one — silently deleting the font size:
 *
 *     twMerge('text-body text-ink')                  -> 'text-ink'
 *     twMerge('text-prose font-medium text-muted')   -> 'font-medium text-muted'
 *
 * The arbitrary-value form it could always parse (`text-[13px] text-ink` keeps
 * both, because `[13px]` is recognisably a length), which is why nobody saw this
 * until #624/#634 replaced those literals with role names. Two tickets then
 * shipped on top of the hole: #533's outline chip lost its 13px and #628's Label
 * and Input lost their 14px. Both LOOKED fine, because an element with no
 * font-size inherits one — and `body` happens to be 14px, so a label and its
 * input agreed by coincidence rather than by rule. That is the worst shape a bug
 * can take: the claim was "these now resolve from one scale" and they resolved
 * from nothing.
 *
 * Declaring the scale fixes every call site at once, including the ones nobody
 * has written yet. Keep this list in step with the `--text-*` steps in
 * globals.css; a step missing from here is a step that silently vanishes when
 * combined with a colour.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'meta', 'label', 'body', 'prose', 'title'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
