---
title: Personal space
description: A private area inside every workspace — documents and views only, invisible to everyone else, including admins.
sidebar:
  order: 11
---

Every member gets a **Personal** section in the sidebar, above the shared Spaces tree. It works
differently from an ordinary space on purpose:

> Only you can see this. If your account is removed, this content is deleted with it.

That's the actual copy the sidebar shows — not paraphrased, since a wording drift here would be a
support incident. Nobody else can see into your Personal space, **including admins**, and there is
no restore path once your account is gone.

## What it can hold

**Documents and views only.** There is no private database — a personal view is always a lens on a
**shared** database, never a place to keep data nobody else has. Deleting a record through a
personal view deletes it for everyone; deleting the view itself only removes your lens and touches
nothing else.

## Creating one

The section header's **+** becomes a **New…** dropdown once you have something in it:

- **New document** — a document only you can see, the same editor as anywhere else in StoryOS.
- **New view…** — opens a dialog: pick a **database** (grouped by space), give it a **name**
  (defaults to the type's own name if you leave it blank), and pick a **type** from a grid of
  seven: **Table, Board, Calendar, Gallery, List, Feed, Timeline**.

**Form and Dashboard are deliberately not offered here.** A form exists to collect *external*
submissions, which has nothing to do with a private lens; a dashboard is a space-level surface
that can span several databases, while a personal view — like every other view — always belongs to
exactly one. Neither fits the "quick private lens on shared data" the other seven cover.

Board, Calendar and Timeline carry the same requirements they do everywhere else, and the picker
disables what the target database can't support: **Board** needs a select, user, or one-to-many
relation field to group by; **Calendar** and **Timeline** both need a date field.

Once created, a view lists in the Personal section next to your documents, each with its own icon,
linking straight to `/w/{workspace}/d/{database}?view={id}`.

## A permission gap worth knowing

**Creating a personal view needs only *viewer* access on its database; deleting one needs
*editor*.** A member with view-only access to a database can create a private view over it, then
find they can't delete it themselves — the delete call refuses with a 403, shown as an ordinary
toast rather than a silent failure. Not yet resolved; if you hit it, an editor or admin on that
database can remove the view on your behalf.
