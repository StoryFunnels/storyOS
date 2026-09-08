# StoryOS design system

**Direction (founder-set):** Attio's app aesthetic — clean, dense, tool-like: near-white surfaces, subtle 1px borders, small radii, restrained color, sentence case — but **warmer**, borrowing the palette DNA from theborderlandsfoundation.org (warm whites, stone grays, navy + gold). Implemented as the Tailwind theme in MN-014; this doc is the source of truth for tokens.

## Palette

Warm neutrals instead of Attio's cool grays. Background is warm white, never pure white. Derived from the Borderlands token set (same stone/warm/navy/gold families, tuned for app density).

```css
:root {
  /* Surfaces */
  --bg-app:        #FAF7F1;  /* app canvas — warm white */
  --bg-sidebar:    #F4EFE5;  /* sidebar / panels — warm alt */
  --bg-card:       #FFFFFF;  /* cards, popovers, table rows */
  --bg-hover:      #F5F3EF;  /* row/item hover (stone-50) */
  --bg-active:     #ECE6D8;  /* selected item (warm-200) */

  /* Text */
  --text-primary:  #0F1729;  /* navy-900 — near-black with warmth */
  --text-secondary:#3D3A30;  /* stone-700 */
  --text-muted:    #6B6658;  /* stone-500 */
  --text-faint:    #B5B0A5;  /* stone-300 — placeholders, meta */
  --text-on-dark:  #FAF7F1;

  /* Borders — 1px, everywhere, instead of shadows */
  --border-default:#E8E5DF;  /* stone-100 */
  --border-strong: #D9D4C8;  /* between warm-200 and stone-300 */

  /* Brand & actions */
  --primary:       #0F1729;  /* navy-900 — primary buttons (Attio-style near-black) */
  --primary-hover: #1A2545;  /* navy-800 */
  --accent:        #D4A017;  /* gold-500 — selection, focus, brand moments */
  --accent-hover:  #E8B830;  /* gold-400 */
  --accent-soft:   #FBF3D8;  /* gold-100 — highlighted rows, callouts */
  --focus-ring:    0 0 0 3px rgba(212, 160, 23, 0.25);

  /* Status */
  --success:       #2D7A4F;
  --error:         #C0392B;
  --warning:       #B8860B;  /* gold-600 */
  --info:          #3D5296;  /* navy-500 */
}
```

**Select-option colors** (user-pickable, for tags/kanban columns). Fifteen, and
the source of truth is
[`table-view/option-colors.ts`](../../apps/web/src/components/table-view/option-colors.ts),
not this list — the table is a leaf module every field surface imports, so the
code cannot drift from itself the way this doc did:

gray `#64748B` · brown `#9C6B43` · gold `#B7791F` · orange `#E4551F` ·
red `#DC2626` · pink `#DB2777` · purple `#7C3AED` · blue `#2563EB` ·
teal `#0D9488` · green `#15803D` · lime `#4D7C0F` · cyan `#0E7490` ·
indigo `#4F46E5` · magenta `#A21CAF` · rose `#E11D48`

~~gray `#B5B0A5`, brown `#8B6F47`, gold `#D4A017`, orange `#D97E36`, red
`#C0392B`, pink `#C05B7E`, purple `#7E5BA6`, blue `#3D5296`, teal `#057160`,
green `#2D7A4F`~~ — **this doc was wrong on all ten** (ticket #639). The shipped
table is stock Tailwind 600/500 and has five more colours; not one documented
value matched. Nobody noticed because nothing reads the doc at build time. If
you change the palette, change `option-colors.ts` and re-derive this list.

**Value chips (#281 shape, #207 fill):** select-field badges (State, Priority,
Type, Project, …) and relation-entity chips (Blocked By, Blocker for, …) share
one 4px-radius shape but opposite treatments, so a category value and a link to
another record are never visually confused:
- *Select-value badge* — a **soft tint** of the option's own colour (13% alpha
  fill) with the ink derived from that same colour per theme, sentence case at
  11px/medium. #281 originally specified a solid fill with white uppercase text;
  **#207 deliberately replaced it** because in a dense table that read as a wall
  of loud colour. The soft tint is the decision, not drift.
- *Relation-entity chip* — outline only, ~1.4px `--border-strong`, no fill,
  normal-case text at body size/weight. The deliberate visual inverse of the
  badge above.
The ink is `.option-tint` in `globals.css`, not a literal: `color-mix` toward
black on light and toward white on dark, at 60%. Measured across all 15 colours
× both themes, worst case 5.27:1 (ticket #638). Do not hard-code a chip text
colour — a literal is theme-blind, which is the bug #638 fixed.


## Typography

- **UI font: Figtree** (Google Fonts; weights 400/500/600/700) — warm, friendly, highly legible; the Borderlands family, works great at app density. Fallback `-apple-system, Segoe UI, sans-serif`.
- **Mono: JetBrains Mono** — api_names, tokens, code.
- App scale is denser than a marketing site: base **14px** (`0.875rem`) for UI chrome and table cells; 16px for entity-page prose; 13px for meta/labels. Headings semibold (600), never black weights in-app.
- **Sentence case always** — buttons, headers, labels. Never ALL CAPS (tracking-wide caps allowed only for tiny section labels in the sidebar).

## Shape & depth

- Radii (Attio-ish, compact): controls/inputs/cells **6px**, cards/popovers **8px**, modals **12px**, avatars **full**. Value chips (select badges + relation-entity chips, #281) are the one deliberate exception: **4px** (`--radius-chip`), not a pill — see "Value chips" above.
- Depth comes from **1px borders + subtle bg shifts**, not shadows. Shadows only on floating elements: popover `0 4px 12px rgba(15,23,41,0.08)`, modal `0 20px 50px rgba(15,23,41,0.15)`.
- Focus: `--focus-ring` — 3px of `--accent` at 25% alpha, drawn as an `outline`
  at offset **0** (ticket #633). It was 2px-offset once; an offset ring on a
  dense grid clipped against the neighbouring cell, and drawing it as
  `box-shadow` erased whatever elevation the element already had, since both
  wanted the same property.

## Density & spacing

8px grid. App chrome is compact: 32px row height in tables, 28px inputs in toolbars, 36px default buttons, 12px card padding, 8px gaps. Entity-page prose area gets generous spacing (Attio record-page feel: narrow centered column, roomy line-height 1.6).

## Voice in UI

Plain, quiet, confident. No exclamation marks, no "awesome". Empty states teach ("Create a database to model anything — clients, articles, posts"), never celebrate.

## Dark mode

Not in v1. The palette maps cleanly later (navy-950 canvas, stone-derived text); tokens are CSS variables from day one so it's additive.

## Component reference (MN-014+)

shadcn/ui components restyled with these tokens. Key look decisions: primary button = navy-900 fill / warm-white text; secondary = white fill + 1px border; destructive = `--error` outline until confirm; kanban cards = white on `--bg-app` with 1px border, 8px radius; sidebar = `--bg-sidebar` with sectioned spaces, active item `--bg-active` + gold left-edge indicator (2px).
