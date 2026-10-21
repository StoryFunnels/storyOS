'use client';

import { createPortal } from 'react-dom';

/**
 * #972 — the dim layer behind a bottom sheet. It must NOT live inside the Radix content: Popper puts
 * `will-change: transform` on the content's wrapper, which makes the wrapper the containing block for any
 * `position: fixed` descendant, so a scrim in there is clipped to the sheet's own box. It is also not a SIBLING
 * of the content inside `Popover.Portal` (that portal renders `asChild` and takes exactly one child).
 *
 * So a panel renders this as a child, and it portals itself straight to `document.body`: it mounts and unmounts
 * with the panel, and fixed-positions against the viewport. Visible only under 768px (see `.phone-sheet-scrim`),
 * and click-through, so an outside press still reaches Radix and closes the sheet.
 */
export function PhoneSheetScrim() {
  if (typeof document === 'undefined') return null;
  return createPortal(<div aria-hidden className="phone-sheet-scrim" data-testid="phone-sheet-scrim" />, document.body);
}
