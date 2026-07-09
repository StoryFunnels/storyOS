---
id: MN-044
title: Icons and colors for databases and spaces
status: todo
depends_on: []
size: M
---

**Ask (founder, 2026-07-09):** icons / colors instead of the uniform database glyph.

**Research.** Notion: any page takes an emoji or uploaded icon; picker = emoji grid with search + recent. Linear: teams/projects get an icon + color from a curated set; the color tints the icon everywhere it appears. Fibery: databases pick an icon from a set + accent color. Slack channels: emoji prefixes as folk taxonomy. Synthesis: **emoji as the icon vocabulary (zero assets, infinite set, renders everywhere incl. sidebar/tabs), plus an accent color; picker = search + category grid + recent; icon shows in sidebar, headers, view tabs, template previews**.

**Design.**

- `databases.icon` exists already (nullable, unused by UI); add `spaces.icon` and `color` for both (10-color palette = existing OPTION_COLORS).
- Emoji picker popover (own component: curated ~300 emoji across 8 categories + search by name, recent row persisted in localStorage — no heavy emoji-picker dependency).
- Entry points: click the icon slot next to the name in sidebar rows (creator+), database header, space header; template packs get default icons in definitions.
- Color tints the sidebar icon chip and the database header; falls back to the current neutral.

## Acceptance criteria

- [ ] Space + database icon (emoji) and color persisted via API; template definitions ship defaults
- [ ] Picker: search, categories, recents; keyboard navigable; removable ("no icon")
- [ ] Icon + color render in sidebar, database page header, workspace-home template previews
- [ ] Guests see icons; only creator+ can change them
