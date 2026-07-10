---
id: MN-071
title: Entity page v2 — pinned fields, two-column layout, layout-independent reorder
status: done
depends_on: [MN-038, MN-042]
size: L
---

The record page is one long single-column list of properties. On a 12-field issue (e.g. imported from Linear) you scroll past the whole viewport of stacked fields before reaching the description — "not usable enough" (founder, on the live instance). Research of how the best tools present an entity card:

- **Fibery**: configurable layout, collapsible field groups, **pinned** fields, multi-**column** arrangement, drag-and-drop that is independent of the table's columns.
- **Linear** (what JCM migrates from): compact right-hand properties, every property a click-to-edit pill, scannable.
- **Notion / Attio**: hover-highlighted rows, inline edit everywhere, pin/hide, "+ add property", 2-up density.

Our gaps: single column (no density), no pinning/emphasis, relations use a weak "edit" text link, and — worst — dragging a field here reshuffles **table columns** because both read the same global `position`.

## Design (no backend/migration — all via field `config`, which is merged + permissive)
- **Two-column responsive grid** for properties (1 col < 720px). Relations and long values may span full width. This is the headline density win.
- **Pinned fields** (`config.entity_pinned`): render first in an emphasized full-width group; ⋯ menu gains Pin / Unpin.
- **Layout-independent order** (`config.entity_order`, number): entity-page drag writes this, used only here (fallback to `position`). Table column order (`position`) is no longer disturbed. dnd-kit `rectSortingStrategy` for the grid.
- **Polished property cells**: whole cell is a hover-highlighted click target; label above value; relations get inline chips + a real "+ add" affordance (not an "edit" link); clearer empty state.
- Keep: hidden-fields section, "+ Add a field", rich_text full-width sections, attachments, description, comments/activity, all access gating.

## Acceptance criteria
- [x] Properties render two-up on wide screens, single column on narrow; far less vertical scroll
- [x] Pin/Unpin from the ⋯ menu; pinned fields lead in an emphasized group; state persists per database
- [x] Drag-reorder on the record page reorders only the record page — table columns are untouched
- [x] Relations edit inline (chips + add) without the plain-text "edit" link; every cell is click-to-edit with hover affordance
- [x] Verified in the browser at desktop and narrow widths (screenshots)
