import { describe, expect, it } from 'vitest';
import { brandIconSlug, isBrandIconRef, isEmojiShaped, isSetIconRef, setIconName } from '@storyos/schemas';
import { TEMPLATES } from '../src/templates/definitions';
import { SHOPIFY_CATALOGUE } from '../src/integrations/shopify-catalogue';
import { SOURCE_PROVIDER_REGISTRY } from '../src/sources/providers';

/**
 * #221 — every icon a SEED writes must be a ref the renderer can actually
 * resolve.
 *
 * The bug this pins was silent in a way worth spelling out. EntityIcon resolves
 * `set:<name>` and `brand:<slug>`; anything else that is not one of those falls
 * through to the legacy-emoji branch and is rendered as literal TEXT in a
 * 4-unit-wide box. So the YouTube templates, which stored a bare `film` /
 * `message-square` / `chart-line`, drew the clipped WORD "film" — and the
 * founder reported it as "the YouTube database doesn't have an icon".
 *
 * Nothing failed: not the typechecker (it's a `string`), not lint, not a test.
 * The same bare-name bug was sitting in the Shopify catalogue too, and while
 * fixing it I reached for `set:shopping-bag` and `set:folder`, neither of which
 * is in the curated set — a stale ref renders as the FALLBACK, so that would
 * have been the same defect wearing a prefix. This test is what catches all
 * three cases.
 *
 * Legacy EMOJI are tolerated on purpose: #251 retired them from the picker but
 * the renderer still draws a stored one, and migrating the ~57 that remain in
 * the template definitions is #222's job, not this test's. What must never
 * appear again is a bare name or an unresolvable ref.
 */
function assertRenderable(icon: string | null | undefined, where: string) {
  if (icon === null || icon === undefined || icon === '') return; // no icon is legitimate
  if (isEmojiShaped(icon)) return; // legacy, tolerated by the renderer — see #222

  // A prefixed-but-unresolvable ref renders as the fallback: no icon at all.
  if (isSetIconRef(icon)) {
    expect(setIconName(icon), `${where}: "${icon}" is not a name in the curated icon set`).toBeTruthy();
    return;
  }
  if (isBrandIconRef(icon)) {
    expect(brandIconSlug(icon), `${where}: "${icon}" is not a known brand slug`).toBeTruthy();
    return;
  }

  // Anything else is the original bug: rendered as literal clipped text.
  throw new Error(
    `${where}: icon "${icon}" is neither a set:/brand: ref nor an emoji, so it renders as literal text. Use "set:<name>" or "brand:<slug>".`,
  );
}

describe('seeded icons are renderable refs (#221)', () => {
  it('every template database icon resolves', () => {
    let checked = 0;
    for (const template of TEMPLATES) {
      for (const db of template.databases ?? []) {
        assertRenderable(db.icon, `template "${template.slug}" → database "${db.name}"`);
        checked += 1;
      }
      // `space` on a TemplateDef is a NAME, not an object with an icon — so
      // there is nothing to check here, and asserting on it would be theatre.
    }
    // Guard the guard: a refactor that renames `databases` would otherwise make
    // this test silently assert nothing.
    expect(checked).toBeGreaterThan(20);
  });

  it('every Shopify catalogue database icon resolves', () => {
    expect(SHOPIFY_CATALOGUE.length).toBeGreaterThan(0);
    for (const entry of SHOPIFY_CATALOGUE) {
      assertRenderable(entry.icon, `shopify catalogue → "${entry.name}"`);
    }
  });

  it('every source provider icon resolves', () => {
    const providers = [...SOURCE_PROVIDER_REGISTRY.values()];
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      // A provider need not declare one, but a declared ref must resolve —
      // `brand:apify` looked right and does not exist, which is how an
      // unresolvable ref gets shipped.
      assertRenderable(provider.icon, `source provider "${provider.id}"`);
    }
  });

  it('rejects the exact shapes that shipped broken', () => {
    // The original bug: a bare curated name with no prefix.
    expect(() => assertRenderable('film', 'x')).toThrow(/renders as literal text/);
    // The near-miss I nearly shipped while fixing it: prefixed but not in the set.
    expect(() => assertRenderable('set:shopping-bag', 'x')).toThrow();
    expect(() => assertRenderable('brand:not-a-real-brand', 'x')).toThrow();
  });

  it('accepts what the renderer resolves, including a legacy emoji', () => {
    expect(() => assertRenderable('set:film', 'x')).not.toThrow();
    expect(() => assertRenderable('brand:youtube', 'x')).not.toThrow();
    expect(() => assertRenderable('🚀', 'x')).not.toThrow();
    expect(() => assertRenderable(null, 'x')).not.toThrow();
  });
});
