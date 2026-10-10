---
title: Organising the sidebar
description: Databases, documents, and views share the sidebar and one set of moves — drag, folders, and who sees what.
sidebar:
  order: 13
---

The sidebar is the list of things you navigate to. Three kinds of thing live in it, and you
arrange them the same way.

## What can be in it

Inside each **space**, at the root or in a **folder**:

- **Databases**
- **Documents**
- **Views** — including dashboards

A view still belongs to its database, wherever you put it. Those are two different facts:
*"which database's rows does this show"* has one answer forever, and *"where do I click to get
to it"* is something people rearrange weekly. Moving a view around the sidebar never changes what
it shows or who owns it, and deleting a database still takes its views with it wherever they sit.

## The rail and the panel

The sidebar is two parts. A narrow fixed **rail** on the far left holds StoryOS's own places —
the workspace switcher, **Home**, **Inbox**, **My Work**, **Runs** and **Settings** — as icons with
tooltips. It never grows, however much you build. Beside it, a resizable **panel** holds *this
workspace's* contents: a combined search-or-ask-Tyron box, a **Collections** row (Reviews, Business
Packs, Personal), then **Groups → Spaces → databases and views**. Resize the panel to make room; it
cuts long names off rather than ellipsising, and widening it is the way to read them.

**Group and space headers stay pinned as you scroll** — the group at the top, the space right below
it — so in a large workspace you can always tell which group and space you're in.

## Groups

A **group** collects spaces under a heading in the sidebar — "Clients", "Internal". It is
**presentational only**: putting a space in a group changes where it appears, never who can see it
or what it contains.

- **Make one** with **New group** at the top of the panel; **rename** or **delete** it from its menu.
  Deleting a group doesn't delete its spaces — they fall back to the ungrouped list.
- **Put a space in a group** by dragging it onto the group's header, or with **Move to group** on the
  space's menu (the keyboard route); **Remove from group**, or drag it into the ungrouped area, to
  take it out. An empty group still shows its header, so there is always somewhere to drop.
- **Reorder groups** by dragging a group's header up or down; spaces keep their own order inside it.
- Over MCP: `list_space_groups`, `create_space_group`, `update_space_group` (including `position`),
  `delete_space_group`, and `update_space`'s `group`.

## Views-only mode

The database-glyph button in the panel toggles **views-only mode**: every database row is hidden
while its views stay, so you see just the views you actually open. It is a personal setting for this
browser, not saved on the workspace — nobody else's sidebar changes. A space with no icon of its own
shows a coloured letter mark; one with an icon keeps its icon.

## Reordering spaces

Drag a space by its row to move it up or down the sidebar's top level, the same drag-and-drop
every other row in the sidebar uses. This is the space's own position, independent of what's
inside it — reordering a space never touches the order of its databases, documents or folders.

## Moving things

**Drag it.** Any of the three kinds, into a folder, out of one, or between folders.

- **Onto a folder** — puts it in that folder.
- **Onto the space root** — takes it out of whatever folder it was in.
- **Onto a row that lives somewhere else** — puts it where that row is. This is usually how you
  drag something *out* of a folder, because the thing you naturally aim at is a sibling at the
  destination rather than empty space.
- **Onto a row in the same container** — reorders.

There is also a **Move to…** entry in each row's `⋯` menu, for when dragging is awkward.

## Folders

Create a folder in a space and put anything in it. A folder can hold databases, documents and
views together — they are not separate lists.

**A folder's `⋯` menu:** Rename, Icon, New database, New document, Delete — wherever you have edit
access. A folder has no colour of its own (only databases and spaces do), so its icon picker is
icon-only.

**Create straight into a folder** rather than creating at the space root and dragging it in
afterwards — **New database** and **New document** are right there on the folder menu. An empty
folder offers the same two as buttons instead of a dead-end "Empty" label, since there is nothing
to drag yet.

**Deleting a folder does not delete what is inside it.** Everything in it moves back to the space
root — the confirmation names how many items and says so.

## Databases start collapsed

A database's views are hidden until you expand it, and StoryOS remembers which ones you had open.
Otherwise the sidebar opens at full height every time and you scroll past everything you were not
looking for.

## Account and workspace admin actions live behind one icon

Settings & members, Integrations, Connections, Webhooks, API tokens, and Keyboard shortcuts — plus
Sign out — sit in a menu behind the gear icon next to the workspace switcher, at the top of the
sidebar. None of it is a fixed row competing with the Spaces tree below it; each is still exactly
one click away, just via that menu instead of a permanent block between the tree and the bottom of
the sidebar. Settings & members, Integrations, Connections, and Webhooks only appear there for an
admin; API tokens needs at least contributor access; Keyboard shortcuts and Sign out show for
everyone.

## Who sees what

Access works in two layers, and they answer different questions:

- **The space is the door.** If you cannot see the space, you do not see anything in it.
- **Each source is the room.** A dashboard drawing on three databases shows you only the parts you
  can read — the rest renders as an explicit no-access state rather than a zero.

So putting a view in a space you share does not hand anyone the data behind it. See
[access & roles](/concepts/access-and-roles/) for the full guest-scoping model.
