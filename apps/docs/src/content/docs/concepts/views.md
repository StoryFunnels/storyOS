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

  ![The filter builder showing a top-level OR with a nested AND group inside it](/images/nested-filter-builder.png)
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

![A board grouped by due date, with weekly columns holding real cards](/images/board-by-due-date.png)

- **Columns come from your data, not a fixed calendar range.** Two records three years apart don't
  produce three years of empty monthly columns between them.
- **Dragging a card writes a date that re-buckets into the column you dropped it in** — a card
  never jumps to a different column the instant you release it.
- **Everything is computed in UTC**, so two people in different timezones see the same card in the
  same column.

## Board columns from a number field

A number field can group a board too, once it has **bins** — configure them from the field's Edit
dialog (its `⋯` menu on the header). Each bin gets a label and an upper edge; bins are contiguous
**by construction**, not by validation — editing one bin's edge is what sets the next bin's floor,
so there's no separate field to get out of sync and no gap or overlap to reject. The first bin is
always open at the bottom, the last always open at the top.

- **Until bins are configured, the field can't be picked as a group-by** — the picker disables it
  with "configure bins on this field first, from its ⋯ menu" rather than silently omitting it.
- **Columns render in bin order**, by their label, not the raw numbers.
- **Dropping a card into a bin's column writes that bin's own floor** — the same rule a date-grouped
  board already uses for its bucket's first day, so a card lands back in the column you dropped it
  in rather than bouncing to a neighbor.
- **A record with no value, or a value outside every bin, gets its own placeholder column** — the
  same "no value" shape every other group-by uses, not a second mechanism.

## Board columns from text or a lookup

A `text` or `lookup` field can group a board — one column per distinct value actually present in
your records, not a column for every value that could theoretically exist. Grouping by a `rollup`
or `formula` field isn't offered yet.

**These groupings are read-only: cards can't be dragged to a different column at all.** The drag
never starts — it's not that a drop is attempted and silently fails to save. There's nothing to
configure for this; it follows automatically from the field type, because a lookup or a formula's
value isn't something you'd write by moving a card, and this project treats a computed value the
same way whether it's grouping a board or rendering a cell.

## Changing what a board or list is grouped by

A board or list view's own tab menu (**⋯ → Change grouping…**) lets you switch its group-by field
after the fact — you're no longer stuck deleting and recreating the view to regroup it. The picker
offers the same fields, in the same disabled-with-a-specific-reason shape, as choosing a group-by
when you first create the view.

- **Everything else about the view is preserved** — column order, hidden-empty settings, card
  customization, filters. Regrouping changes one setting, not the whole view.
- **Switching to or from a date field handles the [week/month/quarter/year
  granularity](#board-columns-from-a-date-field) correctly**: choosing a date field offers it fresh,
  and switching away from one clears the old granularity rather than leaving it to resurface if you
  switch back to a date field later.
- **A list's grouping is optional; a board's isn't** — a board always needs something to make
  columns from, so Save stays disabled until you pick one.

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

**Table views only.** A board's group-by column or a dashboard's tiles and widgets have no single
set of records to allowlist the way a table's rows do, so **Share…** doesn't appear on the tab
menu for anything but a table view.

**A personal view can never be published — not even by its own owner.** Personal space's whole
premise is invisibility to everyone else, including admins; a public, anonymous URL is a
categorically stronger exposure than "visible only to me," so the server refuses outright rather
than adding a second permission branch to get right and maintain forever. It refuses as a plain
**404**, the same way a personal view is already invisible to everyone but its owner everywhere
else — the endpoint doesn't confirm one exists at that id. Revoking an already-published link
(**Stop sharing**) stays open regardless, since removing exposure is always safe.

### Publishing one

A table view's **⋯ menu** carries **Share…**, opening a dialog with:

- **Visible columns** — every field, checked by default except relations; a computed field
  (rollup, lookup, formula) is labelled **(computed)** and can still be checked, since exposing it
  is a decision you make, not something that happens by leaving it alone.
- **Related records to include** — off by default, one checkbox per relation field. A related
  record is its own data, not this view's, so including it is a second, separate decision.
- **Allow search engines to index this page** — off by default.

**Publish** mints the link and flips the dialog to a **Live** badge with a copyable **Link**
(`/v/{token}`) and an **Embed** snippet (an `<iframe>` pointed at the same link with `?embed=1`,
dropping the page's outer chrome for a cleaner in-page embed). Editing the allowlist and publishing
again keeps the **same token**, so a link someone already has never breaks because you changed
which columns show.

Publish, reload, and reopen **Share…** and the dialog correctly reads **Live** with the working
link. (An earlier build of this feature had `cleanViewConfig()` stripping a view's share config
back out on every read, so the dialog always reread "Not published" regardless of what publish had
actually done; fixed in #559.)

### What a visitor sees

A plain, unauthenticated page: the view's name, the database's name, a table of the allowlisted
columns, and **Load more** if there's another page. An unpublished or unrecognised token reads
*"This link doesn't exist or is no longer public"* — the same page a mistyped link produces, so a
visitor can never tell "revoked" from "never existed." That page answers a real HTTP **404**, not
a 200 with a "not found" message on it — the distinction a browser hides but a link-unfurling bot
(Slack, iMessage, Twitter/X) reads directly.

**Sharing the link itself previews correctly** — the view's actual name and database, not a
generic homepage title, and images resolve against your real domain rather than `localhost`.

**Known gaps, today:**

- **Column headers and cell values are best-effort.** The public payload carries a field's
  `api_name` and `type` only — no display label, no select-option colors — so headers fall back to
  a humanized api_name (`due_date` → "Due Date") and select/multi-select values show their raw
  option id rather than a coloured label.
- **The "Powered by StoryOS" footer always shows**, even on a paid plan — there's no plan-gated
  hiding yet for a published view, unlike a public form.

This is also reachable directly over the API (`POST`/`DELETE .../views/{view}/share`,
`GET /public/views/{token}`) and MCP (`share_view`, `unshare_view`).

## An empty view versus a broken one

If a view cannot load its records it says so, with an error and a retry. It does **not** render as
an empty table.

This distinction is worth knowing because the failure it replaced was silent: a rejected filter, a
deleted field, a saved view that stopped validating after a schema change, or the API being
briefly down all used to produce the same screen as a database with nothing in it. *"No records"*
read as *"all my data is gone."*

So: an empty view means nothing matched. If something went wrong, you will be told.
