---
id: MN-056
title: Customer Journey Map pack (simplified from Fibery's 9 databases to 3)
status: done
depends_on: [MN-053]
size: S
---

Fibery ships 9 databases (Journey, Stage, Action, Emotion, Goal, Opportunity, Pain point, Thought, Touch point). We compress without losing the method:

**Databases:** Journeys 🧭 (Persona text, Scope rich_text) ↔ Stages 👣 (Order number, Description) ↔ Insights 💡 (Kind select: Goal/Action/Thought/Emotion/Pain point/Opportunity — colored; Touchpoint text; Severity select Low/Med/High; Details rich_text). Journey one_to_many Stages; Stage one_to_many Insights.
**Views:** Insights board grouped by Kind, "Pain points" filtered table (Kind=Pain point, sort Severity), Stages table by Order.
**Guide:** walk the journey stage by stage; log everything as an Insight with a Kind; opportunities become tasks elsewhere (cross-pack tip).

## Acceptance criteria
- [ ] Pack + samples (one worked journey) + views + guide
