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
workspace's* contents: a combined search-or-ask-Tyron box, your **Favorites**, an **AI** section
(**Skills**, **Agents**, **Automation runs**, **Business Packs**, and **Connect your AI** until an AI is
connected), then **Spaces**, with their groups, databases and views. The panel opens at a width that
shows most names in full. Resize it to make room; a width you drag to is kept. It cuts long names off
rather than ellipsising, and widening it is the way to read them.

An agent's runs and its triggers are no longer rows in the sidebar. Open the agent from **Agents**;
its page links to them. The workspace's **Members** database is not in the sidebar either, because
people are managed in **Settings**.

**Group and space headers stay pinned as you scroll** — the group at the top, the space right below
it — so in a large workspace you can always tell which group and space you're in.

## Groups

A **group** collects spaces under a heading in the sidebar — "Clients", "Internal". It is
**presentational only**: putting a space in a group changes where it appears, never who can see it
or what it contains.

- **Make one** with the **+** beside **Spaces** (its tooltip says **Add to Spaces**): the menu offers
  **New space**, **From template** and **New group**. **Rename** or **delete** a group from its menu.
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

## Hidden

A space or database you hide with **Hide from my sidebar** (in its `⋯` menu) leaves the main list and
goes to a **Hidden** section at the bottom of the sidebar, with a count beside the label. The section
is collapsed until you open it, and it remembers whether you did. Each row you hid has a **Show in my
sidebar** (eye) button that puts it back. Hiding is personal to you, on this device; nobody else's
sidebar changes.

Spaces that hold only the Agentic OS system databases are listed in Hidden too, since their databases
live under **AI**. They open from there, and they have no show button because StoryOS keeps them out
of the main list. Hidden lists only what you can already open: a space you have no access to does not
appear. Choosing a space from search opens that space's own page.

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

## Settings is one click on the gear

The **gear** in the rail opens Settings directly. While you are in Settings the sidebar shows the
Settings menu in place of the Spaces tree, and **Back to {workspace}** returns you to where you were.
Keyboard shortcuts and Sign out are in the account menu (your avatar). Which Settings pages you see
depends on your role; see [Settings](/settings/overview/).

## Who sees what

Access works in two layers, and they answer different questions:

- **The space is the door.** If you cannot see the space, you do not see anything in it.
- **Each source is the room.** A dashboard drawing on three databases shows you only the parts you
  can read — the rest renders as an explicit no-access state rather than a zero.

So putting a view in a space you share does not hand anyone the data behind it. See
[access & roles](/concepts/access-and-roles/) for the full guest-scoping model.
