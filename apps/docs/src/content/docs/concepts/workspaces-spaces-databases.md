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
- **Ontology** — a diagram of the space's databases and the relations between them: nodes for
  databases, edges for relations, self-relations fanned out so their labels don't collide, and a
  cross-space relation drawn as a dashed satellite node naming the other space.
- **Contents** — a plain list, for when the sidebar is collapsed and you need the same information
  without it.

**Access here follows the same door-and-room rule as everywhere else.** A space you cannot see
doesn't render this page at all ("Nothing here you can access, or this space does not exist.");
inside a space you *can* see, each database on the ontology diagram is independently gated —
one you cannot read is simply absent, no node, no placeholder, no count.

## Database

A table of records with typed fields, its own [views](/concepts/views/), buttons and
[automation rules](/concepts/automations/). This is where the actual work lives — see
[databases & fields](/concepts/databases-and-fields/) for the field types it can hold.

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
