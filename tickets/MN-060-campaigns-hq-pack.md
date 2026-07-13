---
id: MN-060
title: Campaigns HQ pack (the reference tool campaign-brief + product-marketing, merged)
status: done
depends_on: [MN-053]
size: M
---

Two ~70%-overlapping the reference tool templates (Campaign/Content/Audience/Key metric + Campaign/Content/Task/Channel) → one pack.

**Databases:** Campaigns 🚀 (Objective rich_text, Status select Draft/Brief Approved/Live/Wrapped, Start/End dates, Budget currency, Channel multi-select) ↔ Audiences 👥 (Profile rich_text, Size number) ↔ Key Metrics 🎯 (Target number, Actual number, Unit text) — Campaign one_to_many Metrics, many_to_many Audiences; Campaign Tasks ✅ DNA-lite; external relation Campaigns↔Articles (cross-pack, skip-note).
**Views:** Campaigns board by Status, timeline table (sorted by start), Metrics "Off target" (Actual < Target needs formula? v1: plain table), Tasks board.
**Guide:** brief IS the campaign record (objective rich text); metrics reviewed weekly; AI-brief tips replaced with our formula/lookup tips.

## Acceptance criteria
- [ ] Pack + samples + views + guide; replaces nothing (agency users may install alongside agency-crm)
