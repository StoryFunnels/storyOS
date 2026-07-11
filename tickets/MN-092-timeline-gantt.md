---
id: MN-092
title: Timeline & Gantt views — records as bars over a time axis
status: todo
depends_on: [MN-091]
size: L
---

## Fibery parity

- **Timeline**: each record is a row with **start + end dates**, drawn as a bar on
  a horizontal, zoomable time axis (day/week/month/quarter). Drag to move, drag
  edges to reschedule. "each Entity is represented as a row with start and end dates."
- **Gantt** = **List + Timeline**: the timeline plus a left-hand hierarchical/row
  panel, **dependencies** (finish-to-start arrows), and grouping. Fibery frames it
  as "List View + Timeline View."

## What we need first (prereq)

- A way to express a **date range** per record. Options: (a) a new `date_range`
  field type (start+end), or (b) let a Timeline view pick **two** existing date
  fields (start field + end field). Recommend (b) for v1 (no schema change), add
  (a) later. Single-date records render as a short/point bar.
- Zoomable horizontal axis + virtualized rows; drag-move and edge-resize write the
  date field(s) via the records API.

## Scope

- v1 **Timeline**: `view_type = timeline`; view config picks start/end date fields;
  render bars, drag to reschedule, zoom levels, today marker. Filter/sort/color aware.
- v2 **Gantt**: add the left row panel + dependencies (needs a relation designated
  as "blocks/depends-on") + hierarchy. Bigger; separate pass.

## Acceptance criteria (v1 Timeline)

- [ ] `timeline` view type; config for start/end date fields (end optional).
- [ ] Records render as bars on a zoomable axis with a today marker.
- [ ] Drag-move and edge-resize persist the date field(s); filter/sort apply.
- [ ] Gantt (dependencies + hierarchy) tracked as a follow-up here.

Refs: [Timeline](https://the.fibery.io/@public/User_Guide/Guide/Timeline-View-12),
[Gantt](https://the.fibery.io/@public/User_Guide/Guide/Gantt-View-408).
