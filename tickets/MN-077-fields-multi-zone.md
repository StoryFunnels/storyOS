---
id: MN-077
title: Entity card — a field can appear in multiple zones + top-strip empty state
status: done
depends_on: [MN-071]
size: M
---

Founder: "I want to see the same field a few times — in the right sidebar AND in the top strip." Today `config.entity_zone` is a single value, so a field lives in exactly one zone. Also the top strip only renders when it has fields, so there's no way to discover/populate it.

## Design
- Replace single `entity_zone` with `entity_zones: Zone[]` (a field can be shown in any subset of {top, sidebar, body}). Keep back-compat: read `entity_zone` as a one-element array when `entity_zones` absent. Collections/rich still forced to body.
- Move menu becomes toggles: "Show in top strip / sidebar / main body" (checkable), so a field can be in several at once (removing from all = effectively hidden).
- Top strip ALWAYS renders (even empty) with a subtle "+ pin a field" affordance and an icon hint, so the zone is discoverable.
- Per-zone `entity_order` becomes per-(field,zone) ordering — store `entity_order` as before but scoped; simplest: keep a single order and let each zone sort by it (good enough).

## Acceptance criteria
- [x] The same field can be shown in both the sidebar and the top strip simultaneously
- [x] Move menu shows checkable zone toggles; unchecking all hides the field
- [x] Top strip is always visible with an add-field affordance, even when empty
- [x] Verified in browser
