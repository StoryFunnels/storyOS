---
id: MN-102
title: Feed actions + List/Feed color-by (make them actionable & stylable)
status: todo
depends_on: [MN-091, MN-093]
size: M
---

## Founder feedback

- **Feed** is "amazing" but **not actionable enough** — it reads, it doesn't let you
  *do*. Add per-item quick actions.
- **List** rows can't yet be styled with colors — "review the Fibery docs." Add
  color-by (and confirm inline field chips read well).

## Scope

**Feed — actionable**
- Per-card quick actions row: **open**, **comment** (inline composer), **change a
  status/select inline**, **complete** (checkbox field), **assign** (people field).
  Editing a select/person/checkbox writes straight through the records API
  (optimistic) without leaving the feed.
- Keep the feed a left-aligned reading column (done in MN-100); actions sit in the
  card footer next to author/date.

**List & Feed — color**
- `color_by` (a select field) in the view config, exposed via a **Color** control in
  the toolbar (reuse the collection/board `color_by` pattern). List rows get a
  leading colored dot / left accent; Feed cards get a colored accent.
- Review List row styling vs Fibery (chip density, truncation, spacing).

## Acceptance criteria
- [ ] Feed cards have working inline actions (status/assignee/checkbox + comment + open).
- [ ] List & Feed support color-by a select field via a toolbar Color control.
- [ ] List rows read cleanly with chips + color, left-aligned.
