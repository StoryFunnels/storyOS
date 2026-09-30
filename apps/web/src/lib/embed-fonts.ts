import type { EmbedFontFamily } from '@storyos/schemas';

/**
 * #720 — the CSS variable each embed font family resolves to, and the label
 * the builder shows. Single source of truth for both `layout.tsx` (which
 * instantiates the `next/font/google` loaders under these same names) and
 * `embed-theme.ts`/`form-theme-panel.tsx` (which only need the variable name
 * as a string, never the loader itself — the loader is a build-time-only
 * concern of the root layout).
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
