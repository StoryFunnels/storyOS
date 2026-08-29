# Working in a view

Things a view does that are easy to miss.

## Hiding columns

**Hide fields** in the view toolbar turns any column off — including **Created at** and **Updated
at**. Every column a table draws can be hidden; there is no column you are stuck with.

The choice is part of the view, so it survives a reload and everyone looking at that view sees the
same columns. Want them for yourself only? Make your own view.

## Field order: the grid and the record panel

A record's properties panel starts out following the **database order** — drag a column in the
grid and the panel follows.

You can also arrange the panel on its own, for when the order that reads well on a record is not
the order that reads well as a table. Once you do, the panel stops following the grid, and it
**says so**: a line appears reading *"Arranged for records, so it no longer follows the database
order"*, with a **Follow the database order** link that puts it back.

Two orders is a reasonable thing to want. Two orders that *look* like one is not — which is why
the notice appears at all, and why it stays quiet until a database actually has its own
arrangement.

## An empty view versus a broken one

If a view cannot load its records it says so, with an error and a retry. It does **not** render as
an empty table.

This distinction is worth knowing because the failure it replaced was silent: a rejected filter, a
deleted field, a saved view that stopped validating after a schema change, or the API being
briefly down all used to produce the same screen as a database with nothing in it. *"No records"*
read as *"all my data is gone."*

So: an empty view means nothing matched. If something went wrong, you will be told.
