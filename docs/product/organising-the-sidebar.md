# Organising the sidebar

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

## Who sees what

Access works in two layers, and they answer different questions:

- **The space is the door.** If you cannot see the space, you do not see anything in it.
- **Each source is the room.** A dashboard drawing on three databases shows you only the parts you
  can read — the rest renders as an explicit no-access state rather than a zero.

So putting a view in a space you share does not hand anyone the data behind it.
