---
id: MN-086
title: Entity page — full-width layout, right sidebar pinned to the edge
status: done
depends_on: [MN-071, MN-077]
size: S
---

## Problem

On a standard laptop screen (MacBook Pro 14"), the record/entity page wastes
horizontal space: the whole page (main body **+** right properties sidebar) is
wrapped in `mx-auto max-w-5xl`, so the content is capped at 1024px and centered.
That leaves a wide empty gutter on the **left of the main body** and on the
**right of the properties sidebar**.

The founder wants:
- The **right sidebar (Properties) pinned to the right edge** of the content area.
- The **main body to fill the whole space** between the left nav sidebar and the
  right properties sidebar.

Reference — Notion, Linear, the reference tool all run the record body full-bleed with the
metadata panel flush to the right edge; the capped-and-centered look is unusual
for a work OS.

## Acceptance criteria

- [x] The record page no longer applies `max-w-5xl mx-auto`; the container spans
      the full width between the app's left sidebar and the viewport right edge.
- [x] The Properties sidebar sits flush against the right edge (comfortable page
      padding only), not floating in from a centered column.
- [x] The main body grows to fill all remaining width; long collection tables and
      the description editor use the reclaimed space.
- [x] The header row (back link + star/fields/actions) spans the same full width.
- [x] Nothing regresses at narrow widths — below `lg` the sidebar still stacks
      under the body (existing responsive behavior preserved).
- [x] Verified in the browser at ~1512px (14" default scaled) that the gutters
      are gone and the sidebar is pinned right.
