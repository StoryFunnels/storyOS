---
id: MN-055
title: Content marketing upgrade — Topics, idea rating, writer workload
status: done
depends_on: [MN-053]
size: S
---

the reference tool `content-marketing`: Article ↔ Topic, idea capture → rating → publish, workload views.

**Changes to content-pipeline pack:** add Topics 🧠 db (Description, Search Volume number, Priority select) with many_to_many to Articles; Articles gain Rating (number 1–5) + Word Count (number) + Idea? covered by existing Status pipeline; new views: "Ideas to rate" (Status=Idea, sort Rating desc), "By writer" board (group by Author).
**Guide:** idea → rate → assign (watch the By-writer board for overload) → draft in rich text → publish; topics are SEO clusters.

## Acceptance criteria
- [ ] Pack updated + guide; existing installs unaffected (template changes apply to new installs only)
