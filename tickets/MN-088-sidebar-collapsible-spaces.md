---
id: MN-088
title: Sidebar — collapsible space groups (+ collapse-all) so the tree scales
status: done
depends_on: []
size: S
---

## Problem

The left sidebar lists every space with all its databases expanded. For a real
workspace (JCM already has ~10 spaces × many databases) this grows unmanageably
fast — you scroll forever and can't find anything. the reference tool'solves this with a
collapsible workspace → space → database tree (disclosure triangles); ours looks
cleaner only because it isn't packed yet.

## Design

- Each **space header** gets a disclosure chevron; clicking it collapses/expands
  that space's database list. Collapsed state persists per user, per space, in
  `localStorage` (`storyos:space-collapsed:{spaceId}`) — no backend needed.
- A collapsed space shows just its header (name + count), so the whole workspace
  map stays scannable at a glance.
- The chevron must not trigger the space drag handle (stop pointer propagation).
- Keep the small type scale (space header 11px, rows 13px) — density is the point;
  don't be afraid of the small font (founder's note).
- The header row remains the drag handle and keeps its hover actions
  (new database / rename / icon / access / delete).

## Acceptance criteria

- [x] Each space can be collapsed/expanded via a chevron; state persists across reloads.
- [x] Collapsing hides that space's database rows; the header (with a small db count)
      stays visible.
- [x] Toggling collapse does not start a space drag or navigate.
- [x] Existing space actions (add db, rename, icon, access, delete) still work.
- [x] Font/density unchanged (stays compact).
