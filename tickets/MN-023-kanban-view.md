---
id: MN-023
title: Kanban view UI
status: todo
depends_on: [MN-021, MN-022]
size: L
---

Board view type: grouped by a single-select field (columns = options in option order + "No value"); dnd-kit drag between and within columns → the `move` endpoint with optimistic updates; cards show title + configured `card_field_ids`; per-column "+ Add"; column record counts. Views with an active sort disable manual drag-reorder (communicated in UI).

## Acceptance criteria

- [ ] Drag across columns updates the select value; drag within a column reorders; both survive reload
- [ ] Optimistic UI reconciles cleanly when the API call fails (card snaps back + toast)
- [ ] Board respects the view's filters and hidden/card field config
- [ ] Per-column add pre-sets the column's option value
- [ ] 60fps with 500 cards; a Playwright smoke covers one drag end-to-end
