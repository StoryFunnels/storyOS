import type { EmbedFontFamily } from '@storyos/schemas';

/**
 * #720 — the CSS variable each embed font family resolves to, and the label
 * the builder shows. Single source of truth for both the `@font-face` rules in
 * `app/fonts/fonts.css` (which declare the faces under these same variable names; the
 * files are vendored, #797) and `embed-theme.ts`/`form-theme-panel.tsx` (which only need
 * the variable name as a string).
 *
 * `figtree` reuses `--font-figtree`, the variable `layout.tsx` already
 * declares for the app's own default — no second load, no extra bundle
 * weight for the option most embedders who like our defaults will pick.
 */
export const EMBED_FONT_VAR: Record<EmbedFontFamily, string> = {
  inter: '--font-embed-inter',
  figtree: '--font-figtree',
  'source-sans-3': '--font-embed-source-sans-3',
  'dm-sans': '--font-embed-dm-sans',
  'source-serif-4': '--font-embed-source-serif-4',
  'playfair-display': '--font-embed-playfair-display',
  'jetbrains-mono': '--font-embed-jetbrains-mono',
};

/** docs/design/form-embed-theming-spec.md §4's proposed table, verbatim. */
export const EMBED_FONT_LABELS: Record<EmbedFontFamily, string> = {
  inter: 'Inter — neutral grotesk',
  figtree: 'Figtree — StoryOS’s own',
  'source-sans-3': 'Source Sans 3 — humanist sans, warmer',
  'dm-sans': 'DM Sans — geometric sans',
  'source-serif-4': 'Source Serif 4 — serif body',
  'playfair-display': 'Playfair Display — display serif, editorial brands',
  'jetbrains-mono': 'JetBrains Mono — technical brands',
};
