/**
 * Warm-tuned chip colours (docs/design/design-system.md).
 *
 * A LEAF module, deliberately: it imports nothing, so importing it can never
 * start a cycle. This table used to live in `cells.tsx`, which imports
 * `ui/avatar` — and `ui/avatar` imported the table straight back, reading it at
 * MODULE SCOPE. Whenever a route's graph made `cells.tsx` the first of the pair
 * to evaluate, avatar ran while `OPTION_COLORS` was still in its temporal dead
 * zone and the whole page died with:
 *
 *   ReferenceError: Cannot access 'OPTION_COLORS' before initialization
 *
 * That is exactly what took out the PUBLIC FORM page (`/f/[token]`) in
 * production: it imports `OptionChip` from `cells.tsx` and nothing that pulls
 * avatar in first, so it always lost the race. Every authenticated page loaded
 * avatar earlier by luck and looked fine.
 *
 * Keep this file import-free. Anything reading these values at module scope
 * (avatar's `COLOR_KEYS`, icon-picker's `COLOR_NAMES`) must import from HERE,
 * never from `cells.tsx`.
 */
export const OPTION_COLORS: Record<string, string> = {
  gray: '#64748B',
  brown: '#9C6B43',
  gold: '#B7791F',
  orange: '#E4551F',
  red: '#DC2626',
  pink: '#DB2777',
  purple: '#7C3AED',
  blue: '#2563EB',
  teal: '#0D9488',
  green: '#15803D',
  lime: '#4D7C0F',
  cyan: '#0E7490',
  indigo: '#4F46E5',
  magenta: '#A21CAF',
  rose: '#E11D48',
};
