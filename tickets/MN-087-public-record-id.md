---
id: MN-087
title: Public sequential record ID — system field, pinned column, pretty URL
status: done
depends_on: [MN-083]
size: L
---

## Problem / intent

Every record needs a **human-readable, stable public ID** — a per-database
running number (Linear-style), e.g. `17`. It must:

- Appear in the **URL** after the title slug, e.g. `.../r/project-name-17`.
- Be a **system field**: shown as **column 1, before Name** by default (so two
  columns are pinned by default — ID + Name); can be hidden/shown; **cannot be
  deleted or edited**.
- Be **stable** — assigned once at creation, never changes on rename/reorder.

Separately confirmed already-present (no work): every record/database/space/
workspace/field already has a **UUID** primary key used for API / n8n / MCP
addressing; database & space UUIDs are never surfaced in the UI. This ticket adds
only the *human* sequential ID on records.

## Reference

Linear (`ENG-1234`), Jira (`PROJ-123`), Height, the reference tool (public id per DB) all use
a per-container running integer as the shareable, memorable handle — UUIDs are for
machines, the number is for humans and URLs.

## Design

**Data model**
- `records.number integer` — per-database sequential; unique index `(database_id, number)`.
- `databases.record_counter integer NOT NULL DEFAULT 0` — the allocator.
- Allocation is atomic inside the create transaction:
  `UPDATE databases SET record_counter = record_counter + :n RETURNING record_counter`,
  then assign the returned block of numbers to the batch. Gap-tolerant (a rolled-back
  create may skip a number — acceptable, matches Linear).
- **Backfill migration**: number existing records by creation order
  (`createdAt, id`) within each database; set each `record_counter` to its max.

**System field**
- New field type `id` (added to the `field_type` enum). Created on database
  creation as a system field at the front (title moves to position 1; id at 0).
- `isSystem = true` → existing guards already block edit + delete.
- Read-only, value = `records.number`, surfaced **top-level** as `number` (not in
  `values`, to keep the user-values map clean — like `created_at`); the table/detail
  render the ID column by reading `record.number`.
- Retrofit: post-migrate boot step (main.ts) adds the `id` system field to every
  existing database — can't run inside the migration since Postgres forbids using a
  freshly-added enum value in the same transaction it was added in.

**Table view (extends MN-083)**
- Default pinned/frozen columns = **two**: the `id` column then the title column.
- ID column renders the number (header “ID”, compact, right-aligned/muted).
- Hideable via “Hide fields”; not draggable out of first slot (stays leftmost).

**URL scheme**
- Record links build as `/w/{ws}/d/{db}/r/{slug(title)}-{number}`.
- `[rec]` route resolver accepts **either** form:
  - a UUID → use directly (back-compat: every existing link keeps working);
  - `…-{number}` → parse the trailing integer, resolve to the record.
- API: add `GET …/databases/{db}/records/by-number/{n}` (or accept `number` on the
  existing get) so the web can resolve slug-number → record. UUID path unchanged.

**API / SDK**
- Record payloads gain `number` (top-level) so API/n8n/MCP consumers can read the
  public id without parsing the URL. UUID `id` stays the canonical key.

## Acceptance criteria

- [x] New records get a gap-tolerant per-database sequential `number`, unique per db.
- [x] Existing records backfilled by creation order; counters set to max.
- [x] `id` is a system field: visible column 1 before Name by default, hideable,
      not editable, not deletable.
- [x] Two columns pinned/frozen by default in the table (ID + Name).
- [x] Record URLs read `…/r/{slug}-{number}`; both slug-number and legacy UUID URLs resolve.
- [x] Record JSON exposes `number` for API/n8n/MCP; UUID addressing still works.
- [x] Duplicate/batch create allocate fresh numbers correctly (no collisions).
- [x] API tests: allocation under concurrent creates, backfill, by-number lookup,
      system-field delete/edit rejection.
- [x] Verified live against the running dev server (founder session): `id` field
      first/system, records carry `number`, by-number resolves + 404s, id write→422.
      Table column render + pretty URL: typecheck + prod build clean; founder eyeball
      pending (sandbox browser can't reach the API).

## Open decision (blocks implementation)

**ID format** — plain per-database number (`project-name-17`, matches the founder's
example) vs a short per-database **prefix** (`PRJ-17`, Linear-style). **Chosen:
plain number.** Column shows `17`; URL `…/r/{slug}-17`; numbers repeat across
databases (the database is always in context).
