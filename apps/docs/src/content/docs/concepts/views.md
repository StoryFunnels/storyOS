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

### Building a filter

- **Nested And/Or groups** — a condition can itself be a group, so "State is Urgent AND (Owner is
  me OR Owner is unset)" is one filter, not a workaround.
- **Global vs Personal scope** — a Global filter is part of the saved view, so everyone who opens
  it sees the same thing. A **Personal** filter layers on top of the shared one, for you only, and
  can only *narrow* what Global already shows — it's ANDed in at query time, never a way to see
  something the view's Global filter excludes.
- **A dynamic "Me"** value on any user field (including `created_by`/`updated_by`) — pick **Me**
  instead of naming yourself, and the same shared view resolves to "assigned to whoever is
  looking" for every person who opens it, per-viewer, at the backend.
- **Rich value pickers** — select/multi-select/user fields get searchable, removable chips instead
  of a raw list; dates get the same calendar picker as everywhere else in the app, with **Today**
  and **Clear**.

**Not built:** per-database tabs for filtering across several databases at once. A view models
exactly one database, and the filter format has no shape for "this condition applies only when
browsing database B" — it isn't a missing UI control, it's an unmodelled case.

## Record ordering

Manual order (table default and within-column kanban order) is stored as a fractional index per
record — reordering touches only the moved record. Sorted views ignore manual order and use the
sort instead.

## Hiding columns

**Hide fields** in the view toolbar turns any column off — including **Created at** and **Updated
at**. Every column a table draws can be hidden; there is no column you are stuck with.

The choice is part of the view, so it survives a reload and everyone looking at that view sees the
same columns. Want them for yourself only? Make your own view.

## Filtering, sorting and hiding from the column header

A table column's own header menu carries filter and sort — not only the toolbar. Sort cycles
ascending → descending → clear on repeated clicks. Drag the column header itself to reorder
columns.

**A filtered column shows a glyph on its own header**, always visible rather than only on hover,
because an active filter is state you need to see at a glance, not something to discover by
hunting. Its menu carries **Clear filter on this field**, and **Hide field** — which writes the
same hidden-fields list the toolbar's Fields panel owns, so hiding a column from the header and
from the toolbar can never disagree about which columns are actually hidden.

## Field order: the grid and the record panel

A record's properties panel starts out following the **database order** — drag a column in the
grid and the panel follows.

You can also arrange the panel on its own, for when the order that reads well on a record is not
the order that reads well as a table. Once you do, the panel stops following the grid, and it
**says so**: a line appears reading *"Arranged for records, so it no longer follows the database
order"*, with a **Follow the database order** link that puts it back.

## Board columns

A board's columns come from whatever it is grouped by, and two settings control them
independently of how the cards inside are sorted.

### Column order

- **Natural** — the grouping source's own order. For a select or a workflow that is the option
  order, which somebody chose deliberately, so it is usually what you want. For a person or a
  relation it is whatever order the API returned, which carries no intent at all.
- **Alphabetical**
- **By count**

**Rearranging a board never rewrites the grouping field's options.** Column order belongs to the
*view*, so your board cannot quietly change a schema that every other view reads.

### Hiding empty columns

**Hide empty groups** drops columns with no cards. A board scrolls sideways, so empty columns push
the real work off-screen.

**The "no value" column has its own separate switch**, and that is on purpose. *"No Epic"* is a
different question from *"an epic with no issues"* — the ungrouped column is usually the triage
pile, which makes it the most important one on the board. Sweeping it away along with the empty
real groups would be the obvious implementation and the wrong one.

## Board columns from a date field

Group a board by a **date** field instead of a select, and its columns become periods — week,
month, quarter, or year, your choice. Dragging a card into a different column **changes the
record's date** to land back in that column — the difference between a static report and a
roadmap you can actually reschedule by dragging.

- **Columns come from your data, not a fixed calendar range.** Two records three years apart don't
  produce three years of empty monthly columns between them.
- **Dragging a card writes a date that re-buckets into the column you dropped it in** — a card
  never jumps to a different column the instant you release it.
- **Everything is computed in UTC**, so two people in different timezones see the same card in the
  same column.

## Sharing a view publicly

A view can be published to a **public, read-only URL** — no sign-in required to view it — with an
explicit allowlist of which fields travel. Nothing is exposed by default:

- **Only the fields you name appear.** A computed field (rollup, lookup, or formula) is included
  only when explicitly allowlisted — never automatically, even though it would otherwise render
  normally to a signed-in viewer.
- **Related records don't travel along by default.** Sharing a view doesn't hand out the data
  behind its relations just because a relation field happens to be on the allowlist.
- **The link's token is the only credential** — the same posture as a [public
  form](/guides/client-portals/). Anyone who has the link can view; nobody without it can guess
  their way in.

**No web page or share-dialog UI exists yet.** This is reachable over the API
(`POST`/`DELETE .../views/{view}/share`, `GET /public/views/{token}`) and MCP (`share_view`,
`unshare_view`) only — there's no button in the app to click yet.

## An empty view versus a broken one

If a view cannot load its records it says so, with an error and a retry. It does **not** render as
an empty table.

This distinction is worth knowing because the failure it replaced was silent: a rejected filter, a
deleted field, a saved view that stopped validating after a schema change, or the API being
briefly down all used to produce the same screen as a database with nothing in it. *"No records"*
read as *"all my data is gone."*

So: an empty view means nothing matched. If something went wrong, you will be told.
