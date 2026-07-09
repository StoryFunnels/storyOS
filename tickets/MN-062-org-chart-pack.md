---
id: MN-062
title: Org Chart pack (+ hierarchy view noted as future view type)
status: todo
depends_on: [MN-053]
size: S
---

Fibery `org-chart`: Team ↔ Employee, manager self-relation, org-chart + employee-map views.

**Databases:** Teams 🏢 (Department select, Mission text) ↔ Team Members 👤 (Role text, Location text, Started date, Email, user field "Account" linking to workspace user) + **Manager self-relation** (one_to_many, machinery proven by task DNA sub-tasks).
**Views:** "Managers" board (group by Team), Members table by team, "New joiners" (Started within last 30d? within op exists — last_7_days only; use sort desc), Teams table.
**Future view gap:** a real org-chart/hierarchy view type — recorded here, not blocking.
**Guide:** keep the directory in StoryOS not spreadsheets; manager links power reporting-line queries.

## Acceptance criteria
- [ ] Pack + samples + views + guide; hierarchy view explicitly deferred
