---
id: MN-025
title: Entity page UI
status: todo
depends_on: [MN-019, MN-024]
size: L
---

Where a record becomes a workspace. Full-page route `/w/:ws/d/:db/r/:record` + peek panel over views (same component); title; properties panel reusing the table's cell editors; linked-record sections per relation field (mini-list with add/remove/create-inline, navigable chips, breadcrumb back); BlockNote editor with debounced autosave and the 409 conflict banner ("reload / overwrite"). Tabs for Comments (MN-026), Activity (MN-027), Attachments (MN-030) land in their tickets.

## Acceptance criteria

- [ ] Every field editable from the properties panel; edits reflect in the underlying view without reload
- [ ] BlockNote content saves (debounced) and survives reload; slash menu, headings, lists, checkboxes, code, quotes, links work
- [ ] Stale-version save surfaces the conflict banner — no silent data loss
- [ ] Relation sections navigate both directions with breadcrumb/back preserved
- [ ] Deep link works from a fresh session (auth redirect round-trip)
