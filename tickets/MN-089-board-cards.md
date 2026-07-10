---
id: MN-089
title: Board cards — richer, customizable, colored value markers ("triangles")
status: done
depends_on: [MN-042, MN-073]
size: M
---

## Problem

The Kanban board cards look plain — a title and, at best, a stacked list of raw
values. The founder wants Fibery-grade cards: compact chips per field, avatars for
people, colored dots for statuses, and — the signature — a small **colored
triangle marker** before each value chip that varies by field, which "makes it
LIVE." Cards must also be customizable (which fields show, card size).

Reference: Fibery board cards (founder screenshots) — each card shows a few field
chips; relations/people render as chips with a small colored marker + name; the
"Cards" panel controls the displayed fields, group-by, and card size.

## Design

- **Rich card rendering** (`BoardView` Card): title (clamped) + a wrap of compact
  value chips, one per selected card field with a non-empty value.
  - `select` / `multi_select`: existing colored `OptionChip` (tinted bg + dot).
  - `user`: avatar + name chip.
  - `relation`: chip(s) with the linked title.
  - `date` / `number` / `url` / `text` / `checkbox`: compact muted chip.
- **Colored triangle markers**: every non-select chip gets a small right-pointing
  triangle whose color is **stable per field** (hash of field id → warm palette),
  so each field reads as its own color across all cards — the "LIVE" look. Selects
  keep their own option colors (more meaningful than a field color).
- **Card size** (`config.card_size`: `small` | `medium` | `large`, default medium)
  — controls padding, title clamp, and chip density. Stored in the permissive view
  config JSON (no migration).
- **Customization UI**: the toolbar "Card fields" control becomes a small **Cards**
  popover — card-size selector + the per-field show/hide checkboxes.

## Acceptance criteria

- [x] Cards render selected fields as compact chips (select/multi-select colored,
      user as avatar+name, relation as titled chips, scalars muted).
- [x] Each non-select value chip shows a small colored triangle, stable per field
      (different fields → different colors).
- [x] Card size is configurable (small/medium/large) and persists in the view.
- [x] The Cards popover controls both card size and which fields appear.
- [x] Empty values are omitted; a card with no extra fields still shows its title.
- [x] Drag-to-move + open-on-click still work; drag overlay matches the card.
