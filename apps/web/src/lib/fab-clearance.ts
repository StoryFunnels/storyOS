/**
 * #1120 — room a phone-width scroll region must leave at its end so its last row can scroll clear
 * of the floating Quick add button (`components/quick-add-fab.tsx`: `fixed bottom-5 right-4`,
 * `h-14 w-14`, `md:hidden`). 20px offset + 56px button = 76px; `pb-24` (96px) leaves a 20px gap.
 * Phones only: at `md` and up the button does not render, so the region keeps its normal padding.
 * `fab-clearance.unit.test.ts` reads the button's classes and fails if the two drift apart.
 */
export const FAB_CLEARANCE_PB = 'pb-24 md:pb-2';
