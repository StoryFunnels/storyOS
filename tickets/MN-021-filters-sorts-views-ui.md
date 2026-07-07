---
id: MN-021
title: Filters, sorts & saved views UI
status: todo
depends_on: [MN-016, MN-020]
size: L
---

The view toolbar: filter builder (field → op → value with per-type inputs; flat AND list in v1 UI; relative date options; "me" for user fields), multi-sort (≤3), hide/show fields panel, column widths persisted to the view. View tabs per database: create/rename/duplicate/delete, switch with URL state. Dirty-state handling: ad-hoc tweaks + explicit "Save to view".

## Acceptance criteria

- [ ] Filter builder covers the full op×type matrix; values input adapts per type (option picker, date presets, user picker)
- [ ] Filters + sorts + hidden fields + column widths round-trip through a saved view after full reload
- [ ] Ad-hoc changes don't mutate the shared view until "Save"; "Reset" discards
- [ ] View tabs switch via URL (deep-linkable); duplicate copies config
- [ ] Guests can use ad-hoc filters but see no save affordance
