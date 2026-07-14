---
title: Views
description: Look at one database's records as a table, board, or calendar — each with its own saved filters and sorts.
sidebar:
  order: 5
---

A **view** is a saved way of looking at a database's records. One dataset, many views — each with
its own filters, sorts, and visible fields. Every database keeps at least one view.

## View types

- **Table** — virtualized (fast on large databases), inline cell editing, multi-select for batch
  edits, and per-column widths. The default.
- **Board (kanban)** — group by a `select` field and drag cards between columns. Column order
  follows the option order; dragging within a column reorders records.
- **Calendar** — place records by a date field and drag to reschedule.

## Filters & sorts

Each view stores a **filter tree** and a list of **sorts**. The filter model is shared verbatim
with the [records query API](/api/querying/), so a view you build in the UI expresses exactly the
same query you'd send from code or an agent:

```json
{
  "filters": { "and": [ { "field": "state", "op": "eq", "value": "<in-progress-option-id>" } ] },
  "sorts": [ { "field": "due", "direction": "asc" } ]
}
```

References to deleted fields are dropped defensively at read time, so a view never breaks when
schema changes.

## Record ordering

Manual order (table default and within-column kanban order) is stored as a fractional index per
record — reordering touches only the moved record. Sorted views ignore manual order and use the
sort instead.
