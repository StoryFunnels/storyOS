---
id: MN-054
title: Meetings & Action Items pack
status: todo
depends_on: [MN-053]
size: S
---

Fibery `meetings`: Meeting ↔ Action Item, "capture notes, track action items execution."

**Databases:** Meetings 🗓 (Type select: Daily/1-on-1/Client/Project Status/Retro; Date (datetime); Attendees (multi-user); Notes rich_text; Status select Scheduled/Held/Cancelled) ↔ Action Items ✅ (Done checkbox; Owner user; Due date; Priority select) — one_to_many Meeting→Action Items.
**Views:** Meetings calendar (date), Upcoming (within next_7_days), Action Items "Open by owner" board, "My open items" (@me + not done).
**Guide:** the meeting loop — capture during, assign before closing, review "My open items" daily.

## Acceptance criteria
- [ ] Pack + samples + views + guide; installs clean; intent "Running meetings that stick" NOT added (gallery-only template)
