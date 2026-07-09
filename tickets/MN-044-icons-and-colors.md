---
id: MN-044
title: Icons and colors for databases and spaces
status: todo
depends_on: []
size: M
---

**Ask (founder, 2026-07-09):** icons / colors instead of the uniform database glyph.

## Research

- **Notion**: any page takes an emoji (or upload); picker = search + category grid + recent + skin-tone variants. Emoji everywhere: sidebar, tabs, breadcrumbs, mentions.
- **Linear**: teams and projects pick from a curated icon set + a color; the color tints the icon chip consistently across sidebar, boards, and mentions — color IS the recognition system.
- **Fibery**: databases pick icon + accent color; spaces are colored folders.

**Synthesis:** emoji as the icon vocabulary (zero asset pipeline, renders natively everywhere, infinitely expressive) + an accent color from our existing 10-color palette. The pair (emoji, color chip) is the visual identity of a database.

## Design

### Data model

- `databases.icon` (text, exists already — currently unused by UI) — stores the emoji character.
- Add `spaces.icon` (text, nullable) and `color` (text, nullable) to **both** `spaces` and `databases` — one additive migration. Color values = keys of OPTION_COLORS ('gold', 'teal', …), validated by zod enum.
- Template definitions: `TemplateDef.space` gains icon; each database def already has `icon` — fill them in for all 11 packs (🧭 Clients, ✅ Tasks, 📦 Deliverables, 📰 Articles, 🐛 Issues, 🏃 Sprints, 🚀 Releases, 📄 Product Docs, 🎯 Funnels, 📅 Posts, 🤝 Meetings…).

### API

- `PATCH /spaces/:id` and `PATCH /databases/:id` accept `icon` (emoji or null) + `color` (palette key or null). Icon validated as 1–4 unicode codepoints (covers ZWJ sequences), not arbitrary strings.
- Introspection + list endpoints already return icon; add color.
- Permission: same as rename — creator for databases, member+ for spaces (guests never).

### Emoji picker (own component, no dependency)

- `~300` curated emoji in 8 categories (Work 📌📋✅, Objects 📦🔧💡, Symbols ⭐🔥🎯, People 🤝👋, Nature 🌱☀️, Food ☕🍕, Travel 🚀✈️, Flags/misc) as a static array `{char, name, keywords}` — search filters by name/keyword.
- Layout: search input → "Recent" row (localStorage, last 12) → category grid (8 cols); footer "Remove icon".
- Rendered in a popover (same pattern as ColorDot palette); fully keyboard navigable (arrows + Enter).
- Color: a second row in the same popover — the 10 palette swatches (reuse the ColorDot grid).

### Where it renders

| Surface | Treatment |
|---|---|
| Sidebar database row | emoji replaces the Database glyph; color tints a subtle background chip |
| Sidebar space header | emoji before the name |
| Database page header | emoji + name; clicking the emoji opens the picker (creator) |
| Workspace switcher / template previews / Cmd+K rows (MN-048) | emoji before names |
| Board/table view tabs | unchanged (view icons stay functional) |

Fallback when unset: current Database glyph in neutral — nothing looks broken.

### Entry points for setting

1. Click the icon slot in the database page header (creator+).
2. Sidebar row ⋯ menu → "Icon & color".
3. Space header ⋯ menu → "Icon & color".
4. New-database dialog gets an optional icon button beside the name input.

## Implementation plan

1. Migration (spaces.icon, spaces.color, databases.color) + zod schemas + PATCH plumbing + tests.
2. EmojiPicker component (data table, search, recents, keyboard) + color row.
3. Wire the four entry points; render across sidebar/header/previews.
4. Template definitions get icons; installer passes them (already supported for databases).
5. Browser-verify each surface, light regression on sidebar dnd (icon must not break drag).

## Edge cases

- Emoji width in the virtualized sidebar rows — fixed-width span so alignment holds.
- OS emoji font differences — acceptable (native rendering is the point).
- Copy/pasted multi-emoji strings — validation truncates to the first grapheme cluster.

## Out of scope

Uploaded image icons, per-view icons, workspace-level logo (separate branding ticket someday).

## Acceptance criteria

- [ ] Space + database icon (emoji) and color persisted via API with validation; template packs ship defaults
- [ ] Picker: search, categories, recents, remove, keyboard navigation; color swatch row
- [ ] Renders in sidebar rows + space headers, database page header, template previews; neutral fallback
- [ ] Creator-gated editing; guests see but can't change; sidebar drag still works
