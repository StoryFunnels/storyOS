---
id: MN-100
title: View polish — uniform new-view grid, disabled clarity, List/Feed left-align
status: done
depends_on: [MN-090, MN-092, MN-093]
size: S
---

## Founder feedback addressed

- **New-view dialog** had uneven rows (3 / 2 / 2 / 1). Now a uniform **2-column
  grid** of equal-size tiles (icon over label), 8 view types, 4 even rows.
- **Calendar / Timeline were disabled but looked clickable.** Disabled tiles now
  grey out and show the reason inline ("Needs a date field" / "Needs a select
  field") instead of a silent no-op.
- **List and Feed were centered.** Both are now **left-aligned** (List full-width to
  `max-w-5xl`, Feed a left-aligned reading column) to match the table.

## Acceptance criteria
- [x] New-view tiles are all the same size in an even grid.
- [x] Disabled view types show why they're disabled.
- [x] List and Feed render left-aligned, not centered.
