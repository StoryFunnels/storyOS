---
id: MN-039
title: Add-field affordance in the table header — visible, labeled, obvious
status: todo
depends_on: []
size: S
---

**Problem (founder, 2026-07-09):** the add-field control at the end of the table header is a bare 14px `+` in a 36px hover target — too small and not communicating what it does.

**Research.** Notion ends the header row with a full-height `+` column that highlights on hover and shows a tooltip; Airtable ends with a wide `+` column (~90px) that reads as "add a column"; Attio labels it "+ Add attribute" in the header. The shared trait: the control is a **column**, not an icon — as wide as a narrow field, with a label or clear hover state.

**Design.** Replace the 36px icon button with a header-height "+ New field" button (icon + label, ~100px), muted text that inks on hover, same border treatment as header cells so it reads as the next column. Keep it creator-gated as today.

## Acceptance criteria

- [ ] Header ends with a labeled "+ New field" control styled as a column stub
- [ ] Opens the AddFieldDialog; hidden below creator access
- [ ] Total grid width accounts for the wider control (no horizontal clipping)
