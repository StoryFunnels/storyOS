---
title: Workspaces, spaces and databases
description: The three levels of container, which question each answers, and how to give any of them a one-line description.
sidebar:
  order: 0
---

Three levels of container. Most tools have some version of this and give you no help deciding
what goes where, so here is the short answer first, then the reasoning.

| Level | The question it answers | Example |
|---|---|---|
| **Workspace** | What is this company doing here? | *Acme — our client work, from first call to final invoice.* |
| **Space** | What is this area of work? | *Delivery — active client projects and everything they need.* |
| **Database** | What belongs in this table? | *Voices — tone-of-voice profiles we write in, one per publication.* |

A newcomer asks those three questions in that order. So does a model. That ordering is the whole
design.

## Workspace

The outermost boundary. Members, billing, connections, agents and every space live inside one
workspace, and nothing crosses between two of them. If you are wondering whether to make a second
workspace, the test is whether the *people* differ — separate workspaces are for separate groups,
not for separate projects.

### Taking everything out

**Settings → Export**, admin only. Downloads a single `.zip` with every space, database, field
schema, record, the relation graph, and every attachment's actual file — streamed rather than
built in memory first, so it works the same way on a large workspace as a small one. StoryOS is
built with no lock-in: this is the whole workspace, not a sample.

**System databases (Members and the rest of the Agentic OS pack) are not included** — their
content is either personal data or internal machinery, not the work product this export exists to
hand you.

## Space

A named area of work inside a workspace, holding databases, dashboards, documents and folders.
Spaces are how a workspace stays navigable once it has more than a dozen databases. They carry an
icon and a colour, so the sidebar is scannable rather than a list of similar words. See
[organising the sidebar](/concepts/organising-the-sidebar/) for how things move between spaces and
folders.

### Opening a space

Click a space's name in the sidebar (the caret still just collapses it) and it opens its own page:

- **Identity** — icon, name, and its [description](#every-level-can-say-what-it-is-for) if it has
  one.
- **Access** — three groups: workspace members, space-level grants, and database-scoped grants
  within the space. A guest sees an honest one-line explanation instead of this section, since the
  underlying endpoints refuse a non-member anyway — never a silently empty section or a doomed
  "Manage access" button.
- **Ontology** — one database as a **centre chip** (whichever one has the most relations in this
  space), with everything it relates to along four axes — up, down, left, right — as chip lists
  **grouped by space**, the far space's name a small label above each cluster. Click a chip's
  chevron to jump straight to that relation's own field on the far database. **Nothing is
  positioned by geometry** — no circle, no spokes, no satellites, no edge labels — so there's
  nothing left to overlap as a space grows. A relation's cardinality and field name show only on
  hover or keyboard focus, never drawn at rest.

  **Only databases related to the centre appear here.** An unrelated database in the same space
  isn't hidden from you — it's simply not part of this diagram; the **Contents** list below still
  names every database in the space regardless of whether it has a relation to draw.

  **One `+` on the centre chip** — "Add a relation from *this database*" — opens the same relation
  dialog the [relations](/concepts/relations/) page does, never a second mechanism. There isn't one
  `+` per axis: axis placement is balance-only and carries no direction, so four buttons that all
  do the identical thing would imply a choice the diagram doesn't actually offer.

  **Known limitation:** on a space with many related databases, the diagram can overflow its own
  card below roughly 870px of viewport width, rather than reflowing — a narrow browser window, not
  only a phone. Give it a wide window (or a small space) if you're capturing it.
- **Contents** — a plain list, for when the sidebar is collapsed and you need the same information
  without it.

**Access here follows the same door-and-room rule as everywhere else.** A space you cannot see
doesn't render this page at all ("Nothing here you can access, or this space does not exist.");
inside a space you *can* see, each database on the ontology diagram is independently gated —
one you cannot read is simply absent, no chip, no placeholder, no count.

## Database

A table of records with typed fields, its own [views](/concepts/views/), buttons and
[automation rules](/concepts/automations/). This is where the actual work lives — see
[databases & fields](/concepts/databases-and-fields/) for the field types it can hold.

### Duplicating a database

A database's `⋯` menu has **Duplicate** — one click, no dialog, no name to type first. It copies
the **schema only** by default (fields, views, buttons, automations), not the records in it, and
takes you straight to the new copy.

A relation pointing at a database outside the copy, or a formula/lookup/rollup that depends on
one, can't come along unchanged — StoryOS tells you exactly what it skipped and why, rather than
silently producing a database that looks complete but is quietly missing pieces.

### A database's own Relations page

A database's `⋯` menu also has **Relations** — this database at the center, every database it
relates to as a node around it, one line per relation, labelled with both fields' names and the
cardinality. Click a related database to jump straight to it.

**This page navigates; it doesn't edit.** **+ New relation** opens the exact same relation-creation
dialog you'd reach from a field's own `⋯` menu — not a second, inline editor — and there's no way
to rename, redirect, or change an existing relation's cardinality from here. That's deliberate:
cardinality changes are destructive (many-to-one throws data away), and a second surface that also
claims to edit relations is how the two would eventually disagree about what's true. Renaming or
reshaping an existing relation still goes through the field editor, same as always.

**Self-relations don't draw a spoke** — both sides point at the database that's already the
center, so there's no separate node to draw a line to. They're simply not shown on this page.

## Every level can say what it is for

Each of the three carries an optional one-line **description** — plain text, not a rich-text
document. The MCP tools cap it at 200 characters, which is the right length: it is a purpose line,
not a README.

**Why bother.** One sentence — *"Voices — tone-of-voice profiles we write in, one per
publication"* — tells a reader more than fifteen field definitions do. It is the cheapest context
the product can hand the next person who opens this thing, and the next person is very often not
you.

### Where it shows up

- **Under the database title**, as a single line. Only when set: an unset description renders
  nothing at all — no placeholder, no reserved empty row. Absent means absent.
- **As the sidebar row's tooltip**, when you hover a database.
- **In the empty state** of a database with no records yet — the moment someone most needs to know
  what is supposed to go in here.
- **In `list_workspaces`, `list_spaces`, `list_databases` and `describe_database`** over MCP, which
  is what makes it useful to an agent.

### Setting one

- **Database or space** — its context menu (the sidebar row's `⋯`) has **Add description** (or
  **Edit description**, once one exists), opening a small dialog.
- **Workspace** — **Settings → General**, an inline field with its own Save. The workspace has no
  context menu to hang a dialog on, so this is a page rather than a popover; the 200-character
  limit, the trim, and clearing to `null` on an emptied box work identically to the dialog. Only an
  admin can change it.

Typing over 200 characters shows the overage in red and disables Save rather than silently cutting
your sentence off; a box left as whitespace only clears to no description at all, the same as
deleting the text.

You can also set one over the API or MCP — `create_database` / `update_database`, `create_space` /
`update_space`, `update_workspace` all take `description`, and the update tools accept `null` to
clear it — which is the only way to set one **at creation**, since the create dialogs in the app
don't have a description field yet. If you skip it there, add it afterwards from the menu or the
General page; it is never thrown away.

> **Not the record description.** A database also has `description_hidden` and `description_order`,
> which configure the per-*record* description block — a versioned rich-text document that appears
> on each record. That is a different feature that happens to share a prefix. This page is about the
> database's own one-line purpose.

## Deleting a database, view, or space

All three go to a trash you can restore from, the same guarantee a deleted **record** already
had — StoryOS marks the row rather than erasing it outright.

- **A database's own Trash** (its `⋯` menu) lists that database's deleted records *and* views
  together, one place to undo either.
- **Settings → Trash**, admin-only, lists deleted **spaces** and **databases** workspace-wide.
  Restoring a space brings back every database it held automatically — you don't separately
  restore each one.
