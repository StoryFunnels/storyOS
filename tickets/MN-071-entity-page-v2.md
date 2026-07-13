---
id: MN-071
title: Entity page v2 — right sidebar, body collections, pinned top strip
status: done
depends_on: [MN-038, MN-042]
size: L
---

The record page is one long single-column list of properties. On a 12-field issue (e.g. imported from Linear) you scroll past the whole viewport of stacked fields before reaching the description — "not usable enough" (founder, on the live instance). Research of how the best tools present an entity card:

- **the reference tool**: configurable layout, collapsible field groups, **pinned** fields, multi-**column** arrangement, drag-and-drop that is independent of the table's columns.
- **Linear** (what JCM migrates from): compact right-hand properties, every property a click-to-edit pill, scannable.
- **Notion / Attio**: hover-highlighted rows, inline edit everywhere, pin/hide, "+ add property", 2-up density.

Our gaps: single column (no density), no pinning/emphasis, relations use a weak "edit" text link, and — worst — dragging a field here reshuffles **table columns** because both read the same global `position`.

## Design (no backend/migration — all via field `config`, merged + permissive)
Three zones, matching the reference tool/Attio:
- **Right sidebar** — scalar properties + single references (State, Priority, dates, selects, Sprint, Release…), compact label-above, click-to-edit, drag-to-reorder. Has a **field picker** ("+") to pull any field into it.
- **Main body** — title, top strip, then **collections** (to-many relations) rendered as working lists, scalars moved to body, rich-text sections, attachments, description, comments/activity.
- **Top strip** — a few **pinned** essentials as inline chips under the title. Empty by default.

Zone assignment: `config.entity_zone` ∈ top|sidebar|body (default: collections+rich → body, everything else → sidebar). **Collections and rich text are forced to the body** — they never sit in the top/sidebar. Move between zones via each field's ⋯ menu ("Move to top strip / sidebar / main body") or the zone pickers; drag reorders within a zone (`config.entity_order`, independent of table `position`). To-many vs single reference detected via relation cardinality/side.

## Acceptance criteria
- [x] Right sidebar holds scalar properties; main body holds collections as lists + description; top strip holds pinned essentials
- [x] Collections (to-many relations) always render in the body — never top/sidebar; long URL/ID fields don't overlap
- [x] Move any movable field between zones from the ⋯ menu or zone picker; drag reorders within a zone without touching table columns
- [x] Verified in the browser on a collection-heavy issue (dev-project pack) at desktop and narrow widths, plus a working move-to-top-strip
