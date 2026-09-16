import type { CSSProperties } from 'react';

/**
 * #711 phase 1 — turn a form's stored theme config into inline custom
 * properties for the embedded form's wrapper.
 *
 * WHY INLINE CUSTOM PROPERTIES ARE THE WHOLE MECHANISM. globals.css wires
 * Tailwind through `@theme inline`, so a utility compiles to the RAW token
 * rather than to a `--color-*` indirection — verified in the built CSS:
 *
 *     .text-ink{color:var(--text-primary)}
 *
 * A custom property computes where it is DECLARED. Had the utility read
 * `var(--color-ink)` with `--color-ink: var(--text-primary)` set at `:root`,
 * overriding `--text-primary` further down the tree would change nothing.
 * Because the utility names the raw token, setting that token on any ancestor
 * re-resolves every utility beneath it. We are not building a second theming
 * system; we are passing values into the one that already exists.
 *
 * FOUR CONTROLS, SEVENTEEN TOKENS. The embedder sets `accent`, `surface`,
 * `text` and `radius`; everything else derives. Deriving is not a shortcut —
 * it is the point. #326 built the three-step text hierarchy (ink → muted →
 * faint) deliberately and #637/#669 spent six PRs defending it; three
 * free colour pickers would let an embedder flatten it in an afternoon.
 * Full rationale: docs/design/form-embed-theming-spec.md §1.
 *
 * THIS RE-VALIDATES WHAT THE API ALREADY VALIDATED, on purpose. The values
 * were checked by `hexColourSchema` on write, but they are rendered into a
 * style attribute on a page that is public and unauthenticated by design. A
 * renderer that trusts its input is one stored-config bug away from being an
 * injection point, so the check happens again at the point of use.
 */

/** Matches `hexColourSchema` in packages/schemas. Anchored; no alpha. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Stored shape (packages/schemas `viewConfig.form.theme`), as it arrives over the wire. */
export interface EmbedThemeConfig {
  accent?: string;
  surface?: string;
  text?: string;
  radius?: number;
}

function colour(v: unknown): string | null {
  return typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : null;
}

/** Control radius in px. The spec's range; anything else is dropped, not clamped. */
function radius(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 16 ? v : null;
}

/** sRGB relative luminance (WCAG 2.1) of a validated hex colour. */
function luminance(hex: string): number {
  const h = hex.slice(1);
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const channel = (i: number) => {
    const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The two candidates for a label sitting on `accent`. Near-black, not pure black. */
const ON_DARK_LIGHT = '#ffffff';
const ON_DARK_DARK = '#1c1917';

/**
 * The submit button's LABEL, derived from `accent` and never settable.
 *
 * A host who picks a pale yellow accent and keeps white text makes the form's
 * PRIMARY ACTION unreadable — the one control the whole page exists to get
 * clicked. So: whichever of white or near-black scores higher against the
 * accent. Where neither clears 4.5:1 the better one is still returned — the
 * button is the wrong place to fail closed, and the builder is where the
 * embedder gets told their accent is too mid-toned (phase 2, spec §6).
 */
function textOnAccent(accent: string): string {
  return contrast(ON_DARK_LIGHT, accent) >= contrast(ON_DARK_DARK, accent)
    ? ON_DARK_LIGHT
    : ON_DARK_DARK;
}

/** `color-mix` lets CSS do the blending where no contrast floor applies. */
const mix = (a: string, pct: number, b: string) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

/** Expand `#abc` to `#aabbcc` so the channel maths has one shape to handle. */
function expand(hex: string): string {
  const h = hex.slice(1);
  return h.length === 3
    ? `#${h
        .split('')
        .map((c) => c + c)
        .join('')}`
    : `#${h}`;
}

/** Blend two validated hex colours in sRGB — `pct`% of `a`. Returns hex. */
function blend(a: string, pct: number, b: string): string {
  const [x, y] = [expand(a).slice(1), expand(b).slice(1)];
  const ch = (i: number) => {
    const av = parseInt(x.slice(i * 2, i * 2 + 2), 16);
    const bv = parseInt(y.slice(i * 2, i * 2 + 2), 16);
    return Math.round((av * pct + bv * (100 - pct)) / 100);
  };
  return `#${[0, 1, 2].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A muted text step that is GUARANTEED to clear `floor` against the surface.
 *
 * The spec's fixed percentages (85 / 62 / 45) reproduce today's hierarchy
 * against today's palette, and the ticket flagged them as a starting point to
 * check against real host brands rather than a result. Checked: with
 * text #2c2419 on surface #fbf7ef -- a real warm-cream brand -- 62% put muted
 * text at 4.32:1, BELOW the 4.5:1 it needs and below the 5.44:1 the unthemed
 * form already achieves. A percentage cannot hold a contrast floor across
 * arbitrary host colours, because the floor depends on how far apart the two
 * colours are in the first place.
 *
 * So the percentage is a STARTING POINT and the floor is the rule: step back
 * toward the text colour until the ratio clears. Walking in 1% steps rather
 * than solving analytically because luminance is not linear in the blend and
 * 100 iterations of cheap arithmetic is not worth a closed form.
 */
function stepWithFloor(text: string, surface: string, startPct: number, floor: number): string {
  for (let pct = startPct; pct < 100; pct += 1) {
    const candidate = blend(text, pct, surface);
    if (contrast(candidate, surface) >= floor) return candidate;
  }
  return text;
}

/**
 * Inline custom properties for this form, or `undefined` when it has no theme.
 *
 * `undefined` rather than `{}` is deliberate and is the spec's §2: with no
 * config React emits no style attribute at all, so an existing embed stays
 * byte-identical to today rather than merely looking the same.
 */
export function embedThemeStyle(config: unknown): CSSProperties | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const cfg = config as EmbedThemeConfig;

  const accent = colour(cfg.accent);
  const surface = colour(cfg.surface);
  const text = colour(cfg.text);
  const r = radius(cfg.radius);

  const style: Record<string, string> = {};

  if (surface) {
    // The card is gone in embed mode (#711 phase 0), so `surface` is the INPUT
    // surface rather than a page background — which is why --bg-app is absent.
    style['--bg-card'] = surface;
    if (text) {
      style['--bg-hover'] = mix(surface, 94, text);
      style['--border-default'] = mix(surface, 88, text);
      style['--border-strong'] = mix(surface, 78, text);
    }
  }

  if (text) {
    style['--text-primary'] = text;
    // Mixing toward the SURFACE is what keeps the hierarchy intact: a themed
    // `text` still needs its muted steps re-derived, or the secondary text
    // keeps the old palette's relationship to a new ink.
    if (surface) {
      // Both colours known, so the floors can actually be enforced. 4.5:1 for
      // the two steps that carry real content (field help, descriptions);
      // 3:1 for --text-faint, which is the "Powered by StoryOS" attribution --
      // that matches what the unthemed form already does rather than quietly
      // fixing a pre-existing shortfall here (see #706).
      style['--text-secondary'] = stepWithFloor(text, surface, 85, 4.5);
      style['--text-muted'] = stepWithFloor(text, surface, 62, 4.5);
      style['--text-faint'] = stepWithFloor(text, surface, 45, 3);
    } else {
      // Surface unthemed, so it is whatever --bg-card resolves to at render
      // time and we cannot measure against it. CSS does the blend and the
      // floors do not apply -- the honest limitation of a text-only theme.
      style['--text-secondary'] = mix(text, 85, 'var(--bg-card)');
      style['--text-muted'] = mix(text, 62, 'var(--bg-card)');
      style['--text-faint'] = mix(text, 45, 'var(--bg-card)');
    }
  }

  if (accent) {
    style['--primary'] = accent;
    style['--primary-hover'] = mix(accent, 88, ON_DARK_DARK);
    style['--accent'] = accent;
    style['--accent-hover'] = mix(accent, 88, ON_DARK_DARK);
    style['--accent-soft'] = mix(accent, 14, surface ?? ON_DARK_LIGHT);
    style['--text-on-dark'] = textOnAccent(accent);
  }

  if (r !== null) {
    // Ratios of the control radius, taken from today's own scale
    // (chip 4, control 6, card 8, modal 12) so `radius: 6` reproduces it
    // exactly. Multiplicative, not additive: at `radius: 0` an additive scale
    // would leave a 6px modal corner, and a host with a hard-edged brand
    // expects every corner square. Rounded, because a fractional px radius
    // renders inconsistently across browsers.
    style['--radius-chip'] = `${Math.round((r * 2) / 3)}px`;
    style['--radius-control'] = `${r}px`;
    style['--radius-card'] = `${Math.round((r * 4) / 3)}px`;
    style['--radius-modal'] = `${r * 2}px`;
  }

  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

/**
 * #711 phase 2 — the builder's contrast warning.
 *
 * Exported because the BUILDER must compute the same number the renderer
 * enforces; two implementations of a contrast ratio would drift. `a` and `b`
 * must already be validated hex.
 */
export function contrastRatio(a: string, b: string): number {
  return contrast(a, b);
}

/**
 * The warning threshold, deliberately ABOVE the 4.5:1 the renderer enforces.
 *
 * The renderer's floor is the legal minimum, applied silently to the derived
 * muted steps. This is the number at which we tell a human their two chosen
 * colours are uncomfortable — a form that merely scrapes AA is still a form
 * nobody enjoys filling in, and the builder is the one place someone can still
 * change their mind cheaply.
 */
export const COMFORTABLE_CONTRAST = 7;

/**
 * "Fix for me" — the nearest text colour to the one the embedder chose that
 * clears COMFORTABLE_CONTRAST against their surface.
 *
 * Walks their colour toward the opposite pole of the surface rather than
 * jumping to black or white, so a host who picked a warm brown on cream gets a
 * DARKER WARM BROWN, not #000. Keeping their hue is the difference between a
 * correction they accept and one they immediately undo.
 *
 * Returns the input unchanged when it already clears.
 */
export function readableTextFor(text: string, surface: string): string {
  const t = colour(text);
  const s = colour(surface);
  if (!t || !s) return text;
  if (contrast(t, s) >= COMFORTABLE_CONTRAST) return t;
  const pole = luminance(s) > 0.5 ? ON_DARK_DARK : ON_DARK_LIGHT;
  for (let pct = 95; pct >= 0; pct -= 1) {
    const candidate = blend(t, pct, pole);
    if (contrast(candidate, s) >= COMFORTABLE_CONTRAST) return candidate;
  }
  return pole;
}
