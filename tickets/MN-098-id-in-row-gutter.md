---
id: MN-098
title: Table — move the public id into the row gutter (kill the dead column)
status: done
depends_on: [MN-087]
size: S
---

## Problem

The public id (MN-087) rendered as its own frozen ~56px column, sitting right after
the always-present 56px row-actions gutter (checkbox / open / delete, all invisible
until hover). Result: a wide band of dead space to the left of the number that
couldn't be narrowed or removed. Founder: "I can't make it smaller and everything on
the left of the number is stuck."

## Fix (Airtable / Notion / Linear pattern)

- Render the record **number inside the leftmost gutter** by default; on row hover
  (or in selection mode) it fades to the checkbox + open + delete actions. One 56px
  gutter now carries both — no dead space, no separate column.
- Drop the standalone `id` column from the table (`id` added to `HIDDEN_TYPES`); the
  header gutter shows a small `#`. The id system field still exists for the entity-page
  badge, pretty URLs, and the API/MCP — it's just not a table column anymore.

## Acceptance criteria

- [x] The number shows in the gutter by default; hover reveals checkbox/open/delete.
- [x] No separate ID column; the left band is a single compact gutter.
- [x] Selection mode still works (checkbox visible); typecheck + build clean.
