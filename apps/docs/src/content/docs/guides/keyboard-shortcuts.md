---
title: Keyboard shortcuts
description: Every shortcut StoryOS has, and three ways to find them again without this page.
sidebar:
  order: 6
---

Every shortcut StoryOS has, and three ways to find them again without this page.

## Opening the cheat-sheet in the app

- Press **?** anywhere.
- **Keyboard shortcuts** in the sidebar.
- **Keyboard shortcuts** in the command palette (⌘K, or Ctrl+K on Windows and Linux).

Any of the three opens the same overlay, and the overlay renders the keys for *your* platform.

## The shortcuts

`⌘` below is the modifier key: **⌘ on a Mac, Ctrl on Windows and Linux.**

| Keys | Does |
|---|---|
| **⌘K** (Ctrl+K) | Search & commands |
| **⌘J** (Ctrl+J) | Ask Tyron |
| **⌘A** (Ctrl+A) | Select all loaded rows |
| **⌘Z** (Ctrl+Z) | Undo the last delete |
| **n** | New record (on a database) |
| **x** | Select row under cursor |
| **⇧ + click** | Select a range |
| **e** | Open record under cursor |
| **Enter** | Edit the focused cell |
| **Esc** | Clear selection / cancel edit |
| **?** | Keyboard shortcuts |

⇧, Enter and Esc read the same on every platform — only the modifier changes.

[Tyron](/concepts/tyron/) is on **⌘J**, not ⌘K, because the command palette has owned ⌘K since
long before Tyron existed and moving it would have broken a binding people already have. The
palette carries an **Ask Tyron** entry, so ⌘K still reaches Tyron in one more keystroke.

## What ⌘K shows you

**An empty box shows your recently-visited records** — not search results, since there's nothing
to search yet. Start typing and it switches to ranked results.

**Results are ranked by relevance, not just recency.** An exact title match comes first, then a
match at the start of the title, then a match at a word boundary ("plan" matching *Launch plan*),
then a bare substring anywhere in the title ("plan" inside *Unplanned*). Ties within the same tier
go to the shorter title, then whichever was updated more recently — so typing a title you already
know lands it first, instead of it being buried under whatever you touched an hour ago.

You can also create a new record directly from the palette, without opening the target database
first.

## When a shortcut deliberately does nothing

Three rules, and each of them is protecting you rather than misfiring:

- **A plain letter never fires while you are typing.** `n`, `x`, `e` and `?` do nothing inside a
  text box, a textarea, a select or any editable field — otherwise typing a note would create
  records. Modifier combos still work while typing, because ⌘Z and ⌘A mean something inside a
  text box too.
- **Nothing fires behind an open dialog.** While a modal is open the keyboard belongs to it,
  including modifier combos. This one exists because of a real data-loss path: editing a field in
  a dialog, pressing ⌘A, and having it select every row *behind* the dialog — where a follow-up
  Delete would trash them.
- **Undo covers the last delete**, not every action. It is a delete-undo, not a general history.

## Which key the app shows you

The app detects your platform and shows ⌘ or Ctrl accordingly. The *binding* is the same either
way — internally every shortcut is stored platform-neutrally as `mod+K` and only the display
differs, so the modifier is never sniffed to decide what a key does, only to decide what to print.

If the platform cannot be detected (during server rendering, before the page hydrates), the app
shows the Mac form and corrects it the moment it loads.

<!--
If you are editing this page: do not hardcode ⌘. Every shortcut hint here must name both forms —
"⌘K (Ctrl+K on Windows and Linux)" — or be written with an explicit note like the one above the
table. Showing a Windows reader ⌘ teaches them a shortcut that does nothing, which is worse than
teaching them nothing: it costs a try, and then trust.
-->
