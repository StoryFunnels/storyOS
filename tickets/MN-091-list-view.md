---
id: MN-091
title: List view — compact grouped rows
status: done
depends_on: [MN-073]
size: S
---

## Problem / feature parity

the reference tool's **List** view is a compact, scannable stack of rows, optionally grouped
by a field (e.g. Status) with collapsible group headers — lighter than a table,
denser than a board. Great for backlogs and triage. (the reference tool's List also supports
hierarchy/depth; v1 here is a flat, groupable list.)

## Scope (v1)

- New `view_type` value `list`; renderer = vertical rows (title + a few inline
  field chips), optionally grouped by a single-select field with collapsible,
  counted group headers.
- Reuses the shared filter/sort config and `card_field_ids` for which fields show
  inline. Clicking a row opens the record; `+ New` per group / at the end.

## Acceptance criteria

- [x] `list` view type exists (enum + schema) and can be created.
- [x] Renders compact rows; optional group-by select with collapsible headers + counts.
- [x] Inline field chips honor the card-fields selection; filter/sort apply.
- [x] Row click opens the record; a new-record affordance creates in the group.

Refs: [the reference tool Views](https://the.the reference tool.io/@public/User_Guide/Guide/Views-8).
