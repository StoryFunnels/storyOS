---
title: Copying a record into another database
description: Copy to… — an auto-matched field mapping, a dry-run preview, and per-row Skip, before anything is written.
sidebar:
  order: 9
---

**Copy to…** copies one or more records into a *different* database, matching fields automatically
and showing you exactly what will happen before it happens.

## Starting a copy

- **One record** — its `⋯` menu → **Copy to…**.
- **Several at once** — select their rows in a table, then the selection bar's `⋯` menu →
  **Copy to…**.

Pick a destination database (grouped by space) and StoryOS runs a **dry run** immediately.

## Reading the preview

Each source field gets one row, showing what StoryOS matched it to:

- **Mapped** — a destination field was found; the row shows its type.
- **Blocking** — the field has a value and no matching field exists in the destination, shown in
  red: *"'Name' has a value and no matching field in the destination. Map it, or skip it
  explicitly."* **Confirm stays disabled while any row is blocking.**
- **Ambiguous** — more than one destination field could take this value; the row names the other
  candidates.

Above the table: how many records **will create**, plus a warning count and a blocking count when
either is non-zero.

**Skip** is the one lever you have over a row today: check it to drop that field from the copy,
which is also how you clear a blocking row and unblock Confirm. **The mapping itself is read-only**
— you cannot manually repoint a field to a different destination, or resolve an ambiguous match
yourself. That's a real, current limitation, not a missing button you overlooked.

## Confirming

**Confirm** applies the copy for real. The dialog then shows how many records were created (with
any warnings) and a button to jump straight to the new record (one) or the destination database
(several).

## Two limits worth knowing before you rely on this

- **No manual remap or ambiguous-relation picker yet.** The API this dialog calls only accepts
  which rows to skip — not where to repoint one. If a field lands wrong or an ambiguous match
  isn't what you meant, skip it and set it by hand afterward.
- **The destination list isn't filtered to databases you can write to.** Picking one you only have
  read access to fails at the dry-run step with an error, rather than being hidden from the picker
  up front.
