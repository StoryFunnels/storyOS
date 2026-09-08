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
  **Copy to…**. The mapping is computed **once for the whole selection**, not once per record: a
  field blocks if *any* selected record has a value in it, so you resolve a schema mismatch a
  single time rather than once per row.

Pick a destination database (grouped by space) and StoryOS runs a **dry run** immediately. **Only
databases you can actually write to appear in the picker** — one where you only have viewer access
never shows up, rather than being offered and only failing once you've picked it.

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

**Skip** is the one lever this dialog gives you: check it to drop that field from the copy, which
is also how you clear a blocking row and unblock Confirm. **The dialog's own mapping is read-only**
— you cannot manually repoint a field or resolve an ambiguous match from here. That's a real,
current limitation of this specific screen, not a missing button you overlooked.

The underlying API and MCP's `copy_records` tool can already do more than this dialog exposes: an
`override` — source field to a specific destination field id — wins over the auto-match, and the
same parameter resolves an ambiguous relation by naming exactly which candidate to use. If the
dialog's read-only mapping is wrong for a field, an agent (or a direct API call) can remap it; the
web dialog itself just doesn't have that control yet.

## Confirming

**Confirm** applies the copy for real. The dialog then shows how many records were created (with
any warnings) and a button to jump straight to the new record (one) or the destination database
(several).

## What a bulk copy does — and doesn't — guarantee

With several records selected, the copy is genuinely atomic in one direction only: **if anything
in the batch fails partway through, everything already created for this copy is rolled back**, so
you never end up with, say, 30 of 50 records landed and no way to tell which. There's no partial
state to clean up by hand.

What that means in practice: a failed bulk copy is a clean do-over, not a resume. There's no
"retry only what didn't make it" — if the batch failed, you run the whole selection again from
scratch once you've fixed whatever caused the failure. For a very large selection, there's also no
progress indicator while it runs and no record-count cap enforced before you start mapping — the
copy just runs to completion or rolls back.

## Duplicating within the same database

A record's `⋯` menu also has plain **Duplicate**, for when you want a copy *in the same database*
— no destination picker, no mapping to review, one click.

- Every scalar field value, its relation links (both single-reference and many-to-many), and its
  description document all copy onto the new record. The title gets a **" (copy)"** suffix.
- **Comments and attachments copy too** — the full thread history (skipping anything already
  soft-deleted) and the actual files, byte-for-byte, not a shared reference to the originals.
  Copied comments don't re-notify whoever was `@`-mentioned in them; that mention already happened
  once, and duplicating a record isn't new activity from the people it names.
- **What doesn't copy**: any *owned* one-to-many collection — a duplicated parent never takes the
  original's children with it, since a child can only belong to one parent. `created_at`,
  `updated_at`, and `created_by` are fresh on the copy rather than carried over.
