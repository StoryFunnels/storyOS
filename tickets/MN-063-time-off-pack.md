---
id: MN-063
title: Time Off pack (Vacations Pro, simplified; balances blocked on rollups)
status: done
depends_on: [MN-053]
size: S
---

the reference tool `vacations-pro` = 8 databases + computed remaining days + Slack commands. The computation needs rollups (MN-064); Slack is out of scope. The daily value — "who is out, when, is it approved" — needs neither.

**Databases:** Team Members 👤 (Annual Allocation days number, Country text) ↔ Time Off 🌴 (Kind select Vacation/Sick/Overtime comp/Unpaid — colored; Start date; End date; Days number (manual v1, formula once rollups land); Approved checkbox; Notes) + Public Holidays 📅 (Date, Country text).
**Views:** Time Off calendar ("who's out"), "Pending approval" (Approved unchecked), "This month", Holidays table.
**Guide:** request = create a Time Off record; approver checks Approved; balances = MN-064 preview documented.

## Acceptance criteria
- [ ] Pack + samples + views + guide
