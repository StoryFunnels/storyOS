---
id: MN-051
title: Calendar view — records on a month grid by date field
status: todo
depends_on: [MN-038]
size: L
---

**Problem.** The social calendar and content pipeline templates literally model calendars, but the only views are table and board. Publish dates, due dates and meetings need a month grid.

**Research.** Notion calendar view: month grid, records as chips on their date, drag between days to reschedule, click day → quick create with the date prefilled. Airtable calendar: pick the date field at view creation, optional end-date for spans. Linear: cycle/roadmap timelines rather than calendars (their domain differs — ours includes content, so calendar wins first). Synthesis: **third view type `calendar`, config = date field (+ optional end-date field later), month navigation, chip drag = date change, day click = create with date**.

**Design.**

- `view_type` enum + registry: `calendar`; config gains `date_field_id`.
- View creation dialog: type picker gains Calendar (requires ≥1 date field; same pattern as board's group-by requirement).
- Month grid (6×7, Monday-first, same Date math as the MN-038 picker): each cell lists that day's records as chips (title + card fields subset); overflow "+N more" popover; today ringed.
- Interactions: drag chip → new date (existing update mutation; 200ms drag-vs-click guard like boards); click chip → entity page; click empty day area → create record with the date field prefilled (opens the new record page).
- Records query: reuse the existing filter AST (date within visible month range) — one query per month view, cached per month key.
- Filters/sorts toolbar applies as elsewhere; card fields picker shared with boards.

## Acceptance criteria

- [ ] Calendar view type creatable when the database has a date field; config persists date_field_id
- [ ] Month grid with chips, overflow popover, prev/next/today navigation
- [ ] Drag chip to another day updates the date (undo-friendly toast); click opens the record; day click quick-creates with the date set
- [ ] Toolbar filters apply; view respects hidden/card field settings; read-only users can't drag
