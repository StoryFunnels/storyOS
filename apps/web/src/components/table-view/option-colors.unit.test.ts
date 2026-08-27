import { describe, expect, it } from 'vitest';
import { PALETTE } from '@storyos/schemas';
import { OPTION_COLORS } from './option-colors';

/**
 * #399 — the CSS map must cover exactly the palette the API validates against.
 *
 * This file deliberately does NOT make `option-colors.ts` import the shared
 * palette. That module is import-free on purpose: it used to live in `cells.tsx`,
 * `ui/avatar` read it at module scope, and the cycle killed the public form page
 * in production with `Cannot access 'OPTION_COLORS' before initialization`. Its
 * own comment says "Keep this file import-free", and adding a dependency to fix
 * a duplication problem would trade a cosmetic bug for an outage.
 *
 * So the relationship is asserted here instead. Two artefacts, one checked
 * against the other — which is the same shape as `coverage.test.ts` for MCP
 * parity: derive the check, not the code.
 */
describe('the chip colour map matches the validated palette', () => {
  it('every palette colour has a style — or an agent can set one that renders as nothing', () => {
    const missing = PALETTE.filter((c) => !(c in OPTION_COLORS));
    expect(
      missing,
      'these colours pass validation but have no chip styling, so they would render unstyled',
    ).toEqual([]);
  });

  it('the map has no colours the API would reject', () => {
    // The other direction: a style for a value nobody can ever save is dead
    // weight, and it hides the fact that the two lists have drifted apart.
    const extra = Object.keys(OPTION_COLORS).filter((c) => !(PALETTE as readonly string[]).includes(c));
    expect(extra, 'these have styling but are not valid colours').toEqual([]);
  });
});
