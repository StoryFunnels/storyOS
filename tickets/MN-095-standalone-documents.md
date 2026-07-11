---
id: MN-095
title: Standalone documents — space-level rich docs (not tied to a record)
status: done
depends_on: []
size: M
---

> **Done.** New `space_documents` table + `SpaceDocumentsService/Controller`
> (create / list / get / update / delete, single-editor optimistic concurrency →
> 409). Sidebar: each space's "+" is now a menu (New database / New document); docs
> render under databases and open a full-page BlockNote editor at `/w/{ws}/doc/{id}`
> with title + autosave. Verified end-to-end (create v1 → edit v2 → stale 409 →
> delete → 404). **Deferred:** starring docs (favorites are record/database-only —
> needs a `document` target type) and drag-reorder of docs.

## Fibery parity

Fibery lets you create **Documents** directly in a space (sidebar), independent of
any database — a rich-text page (specs, wikis, meeting notes) that lives in the
nav tree next to databases and views. We currently only have per-record
descriptions (the `documents` table is keyed by `record_id`).

## Scope

- A space-scoped document entity: `{ id, space_id, title, icon, content (BlockNote),
  content_text, position }` — either a new `space_documents` table or generalize
  `documents` with an optional `space_id` and nullable `record_id`.
- Sidebar: documents appear under their space (with databases); create via the
  space "+" menu; open in a full-page BlockNote editor (reuse the description editor).
- Optimistic-concurrency save (version) like record docs; favorite-able (MN-075).

## Acceptance criteria

- [ ] Create/rename/delete a standalone document in a space; it shows in the sidebar.
- [ ] Full-page rich editor with autosave + version guard.
- [ ] Can be starred; survives reload; scoped by space access.

Refs: [Fibery Views](https://the.fibery.io/@public/User_Guide/Guide/Views-8).
