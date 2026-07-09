---
id: MN-051
title: Calendar view — records on a month grid by date field
status: done
depends_on: [MN-038]
size: L
---

**Problem.** The Social Calendar and Content Pipeline templates literally model calendars — publish dates, due dates, meetings — but the only views are table and board. For JCM's content operation the month grid IS the workflow surface.

## Research

- **Notion calendar view**: month grid; records render as chips on their date; drag chip to another day = reschedule; click a day's empty area = quick-create with the date prefilled; per-view choice of which date property drives placement.
- **Airtable calendar**: date field chosen at view creation; optional end-date makes spans; color by single-select.
- **Fibery calendar**: same, plus multi-day spans.
- **Linear**: no calendar (cycles/timeline instead) — their domain is engineering; ours includes content, so calendar ranks above timeline for us.

**Synthesis:** third view type `calendar`; config = `date_field_id`; month navigation; chips with card fields; drag = date change; day-click = create-with-date. Spans (end date) explicitly deferred.

## Design

### Data & config

- `view_type` pgEnum + zod: add `'calendar'` (migration).
- `ViewConfig` gains `date_field_id?: string`; the existing `card_field_ids` (MN-042) doubles as chip fields; `filters`/`sorts` apply as everywhere (sorts affect within-day chip order).
- New-view dialog: Calendar card in the type picker; requires picking one of the database's date fields (same required-select pattern as board's group-by). Databases without date fields show the card disabled with hint "Needs a date field".

### Data fetching

- Month window query: reuse the records query endpoint with an injected filter `{and: [viewFilters..., {field: dateApi, op: 'gte', value: firstVisibleDay}, {field: dateApi, op: 'lte', value: lastVisibleDay}]}` — the 42-day grid window, not just the month (leading/trailing days shown). One request per month navigation, react-query cached by `[records, ws, db, 'cal', monthKey, configHash]`; limit 1000 with an overflow banner ("Showing first 1000 in this month").
- Records without a date value simply don't appear; a footer counter "N undated records" links to the table view filtered to `date is_empty` — keeps undated work discoverable (Notion hides them silently; we can do better cheaply).

### Rendering

- Month grid: 6×7, Monday-first (same Date math as MN-038's picker — extract shared helpers `monthMatrix`, `fmtDate` into a date util module).
- Day cell: date number (today ringed in accent, other-month days faint), up to 3 chips + "+N more" (popover listing the rest, scrollable).
- Chip: 1-line title + optional tiny renders of card fields (select chip colors shine here); click → entity page (same 200ms drag-guard as boards).
- Header: `‹ Month YYYY ›` + "Today" button; weekday row.
- Density: cells min-height 96px; the grid scrolls vertically if the viewport is short.

### Interactions

- **Drag to reschedule**: dnd-kit — each day cell a droppable (`day:2026-07-15`), each chip draggable; drop = `updateRecord.mutate({ [dateApi]: day })` with the existing optimistic cache path; time component preserved for datetime fields (only the date part changes). Read-only users: drag disabled.
- **Quick create**: click empty area of a day (not on a chip) → `createRecord.mutate({ name: 'Untitled', [dateApi]: day })` → navigate to the new record (same decision as board add-card).
- Keyboard: `←/→` month nav when the grid is focused; `t` = today. (Registered on the shared shortcut registry.)

### Toolbar

- The existing ViewToolbar renders with `viewType='calendar'`: filters + sorts as-is; the field-visibility slot shows the Card fields picker (shared with boards); plus a calendar-only "Date field ▾" select to re-point the view (patches `date_field_id`).

## Implementation plan

1. Enum migration + config schema + new-view dialog Calendar card with date-field requirement.
2. Shared date-util extraction from MN-038; month grid rendering with chips/overflow/today.
3. Month-window fetching with caching + overflow banner + undated counter.
4. Drag-reschedule + day quick-create + chip open (drag/click guard).
5. Toolbar wiring (card fields, date-field switcher); template packs: Social Calendar's "Posts" and client-space "Meetings" gain a default calendar view (definitions + installer already support view types — add `'calendar'`).
6. Browser-verify: create view, drag a post across days, quick-create, month nav, guest read-only.

## Edge cases

- Datetime fields: chips sort by time within the day; drag keeps HH:mm.
- Timezones: dates are stored as plain dates (date-only) or ISO datetimes; grid buckets datetimes by LOCAL day of the viewer — documented (matches Notion behavior).
- 100+ chips in one day: "+97 more" popover virtualizes if needed (simple max-height scroll first).
- The view's date field gets deleted → view renders an empty state "Pick a new date field" with the switcher (config points at a dead id — handle gracefully, don't crash).

## Out of scope

Multi-day spans (end-date field), week view, drag-to-create-range, ICS export/subscription (future "calendar feeds" ticket pairs well with the cloud tier), color-by-select rules (chips already show select chips via card fields).

## Acceptance criteria

- [ ] `calendar` view type creatable with required date field; disabled state without one; config persists and can be re-pointed
- [ ] Month grid with chips, +N overflow, today marker, month nav + Today, undated-records counter linking to a filtered table
- [ ] Drag chip → date updates (time preserved, optimistic, read-only blocked); day click → quick-create with date; chip click → record
- [ ] Toolbar filters/sorts/card-fields apply; templates ship a calendar view for Posts + Meetings
- [ ] Deleted-date-field degrades to a recover state, not a crash
