---
title: Split-screen panels
description: Open a linked record — or the next row in a queue — beside what you're already looking at, instead of navigating away from it.
sidebar:
  order: 17
---

Clicking a relation chip, or a row in a list, opens that record in a panel **beside** the page
you're on rather than replacing it. Desktop only (`md` breakpoint and above) — on a narrower
screen, or with a modifier held (⌘/Ctrl/Shift-click, middle-click), it falls through to an ordinary
navigation or a new tab, exactly like before this existed.

## Two ways a panel opens

- **From inside a record, clicking a relation** *stacks* a new panel. Click another relation
  inside *that* panel and it stacks again — each click pushes one more panel onto the right.
- **From a list — My Work, or any table/board/gallery/list/feed/timeline view** — clicking a row
  *swaps* the one open panel's record in place. This is the queue-triage case: walking down a list
  reuses the same panel rather than leaving a rail behind for every row you passed.

Only **one panel stays expanded at a time** either way. Opening or expanding a second one docks the
previously-active panel to a peek-rail on the right — a thin strip showing its name, click to bring
it back.

## Walking a queue with the keyboard

In **My Work**, once a record is open in the panel, **↑ / ↓** move to the next or previous item in
the same list and swap the panel to show it — no re-navigation, no lost scroll position. The arrows
are only armed while a record is open, and they never hijack input: typing in a field, a filter
box, or any editable element takes the keystroke instead.

## Controls, and they're the same everywhere

Every pane — the original page you were on *and* every opened panel — carries the same three
controls:

- **Collapse** — dock the pane to its own peek-rail. The original page rails to the **left**;
  panels always rail to the **right**, so collapsing never jumps a pane across the screen.
- **Maximize / Restore** — one pane fills the whole split area; every other participant docks to
  its rail. Restore brings back the shared side-by-side pair.
- **Close** — removes a panel entirely. Closing the *original* page's own pane instead restores it
  (there's always something on the left).

A list surface (My Work, a database view) gets a thin control strip with the same three buttons
**only while a split is open** — with nothing open it renders exactly as it always did, no extra
chrome.

**The divider between the two panes is draggable** — drag to resize, double-click or press Home to
reset to an even split, or focus it and use the arrow keys.

## What this doesn't cover yet

**Search results** and **My Work's own visual redesign** are separate, unshipped work — this page
describes the split-panel mechanism itself, not either of those.
