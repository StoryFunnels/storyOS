---
id: MN-095
title: Standalone documents — space-level rich docs (not tied to a record)
status: todo
depends_on: []
size: M
---

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
