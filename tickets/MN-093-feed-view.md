---
id: MN-093
title: Feed view — continuous stream of large rich cards
status: done
depends_on: [MN-089]
size: M
---

## feature parity

**Feed** shows records as a continuous, scrollable stream of large cards, each
surfacing the record's rich content (description preview) + key fields — built for
reviewing incoming feedback, notes, or updates. the reference tool: "Track activity and updates
in a continuous stream… scroll through notes… in a large format."

## Scope (v1)

- New `view_type = feed`; renderer = single-column, reverse-chronological (or
  sort-config) stack of wide cards: title, description preview (BlockNote →
  `richTextPreview`), the card fields (MN-089 chips), author + timestamp.
- Reuses the shared query/filter/sort + `card_field_ids`. Click opens the record.

## Acceptance criteria

- [x] `feed` view type; wide single-column cards with description preview + fields.
- [x] Honors filter/sort; default newest-first; click opens record.
- [x] Reasonable performance via paginated "Load more" (full virtualization deferred).

Refs: [the reference tool Views](https://the.the reference tool.io/@public/User_Guide/Guide/Views-8).
