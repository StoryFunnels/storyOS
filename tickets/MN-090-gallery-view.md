---
id: MN-090
title: Gallery view — card grid
status: done
depends_on: [MN-089]
size: S
---

## Problem / feature parity

We have Table / Board / Calendar; the reference tool also offers a **Gallery** — records as a
responsive grid of cards (like a Board with no columns). Gallery shows visible
fields, supports filter/sort/color, and optionally a cover image. It's the natural
home for anything visual (content pieces, people, products).

the reference tool: "Gallery View — display images, group by rows/columns, customize visible
fields, filter, sort, color code." (basic version here = ungrouped grid.)

## Scope (v1)

- New `view_type` value `gallery`; renderer = responsive card grid reusing the
  MN-089 card (title + chips + colored triangles) and `card_field_ids` / `card_size`.
- Cards open the record on click; grid is filter/sort aware via the shared config.
- New-view dialog offers Gallery (no required config). Cover image + row/col
  grouping deferred.

## Acceptance criteria

- [x] `gallery` view type exists (enum + schema) and can be created.
- [x] Renders records as a responsive grid of MN-089 cards; respects card fields + size.
- [x] Filter / sort from the toolbar apply; clicking a card opens the record.
- [x] Empty state when no records.

Refs: [the reference tool Views](https://the.the reference tool.io/@public/User_Guide/Guide/Views-8).
