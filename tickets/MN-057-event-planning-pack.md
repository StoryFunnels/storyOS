---
id: MN-057
title: Event Planning pack
status: done
depends_on: [MN-053]
size: S
---

the reference tool `event-planning`: Event, Expense, Task, Category; "track budget, see which category is most expensive."

**Databases:** Events 🎪 (Date, Venue, Status select Planning/Confirmed/Done, Budget number currency, Attendees Expected number) ↔ Event Tasks ✅ (DNA-lite: State, Owner, Due) ↔ Expenses 💳 (Amount currency, Category select Venue/Catering/Marketing/Travel/Production/Other, Paid checkbox, Vendor text).
**Views:** Events calendar, Expenses "By category" board, Tasks board, "Unpaid" table.
**Guide:** checklist-first planning; budget-vs-actual totals arrive with rollups (MN-064) — until then group expenses by category on the board.

## Acceptance criteria
- [ ] Pack + samples + views + guide; rollup dependency noted in guide, not blocking
