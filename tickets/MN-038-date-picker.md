---
id: MN-038
title: Date picker v2 — one-click popover calendar with type-to-parse
status: todo
depends_on: []
size: M
---

**Problem (founder, 2026-07-09):** date editing uses the native `<input type="date">`, which renders the browser's default picker — visually foreign to the product (blue Chrome calendar on the warm canvas), demands too many clicks (click cell → click calendar glyph → navigate → pick), and shows a `dd.mm.yyyy` ghost that fights the ISO format we store.

**Research.** Notion: clicking a date property opens a popover immediately — a free-text input on top (parses "Jul 15", "2026-07-15") with a month grid below; single click on a day commits and closes; Clear/Today shortcuts at the bottom. Linear: the same shape plus natural-language parsing ("fri", "in 2 weeks") — the popover opens on first click, no intermediate focus state. Attio: popover calendar styled to their tokens. Common denominator: **one click to open, one click to commit, text entry for keyboard users, product-styled**.

**Design.** Own `DatePicker` popover component (no dependency; one month grid is ~60 lines of Date math), warm-token styled:

- Opens immediately when a date cell/property enters edit mode.
- Text input on top, pre-filled with the current value; parses `2026-07-15`, `15.07.2026`, `15/07/2026`, `Jul 15`, `15 jul`, `today`, `tomorrow`; Enter commits.
- Month grid below: ‹ › month arrows + month/year label, today ringed, current value filled; **clicking a day commits and closes** in one click.
- Footer: `Clear` · `Today`.
- `include_time` config: a time input row appears under the text input.
- Used by both the table `CellEditor` and the entity-page property row; Escape cancels, outside click commits typed text if valid.

## Acceptance criteria

- [ ] Native date input is gone from cells and entity pages; popover matches design tokens
- [ ] One click on a day commits and closes; typed formats above all parse; invalid text does not commit
- [ ] Clear and Today work; `include_time` fields show a time control and persist `HH:mm`
- [ ] Keyboard: Enter commits typed value, Escape cancels; table grid focus returns after commit
