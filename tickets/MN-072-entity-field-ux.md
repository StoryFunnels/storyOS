---
id: MN-072
title: Entity field UX + popover bugs — anchoring, collapse, hide-when-empty, number steppers, collection cap
status: done
depends_on: [MN-071]
size: L
---

Founder QA on the live entity page turned up a batch of bugs and gaps. Each must be reproduced and re-verified in the browser (not just typechecked).

## Bugs (reproduced)
- **Sidebar select/user popover detaches** — clicking Priority opens the option list at the bottom of the sidebar, not under the field. Cause: `OptionList`/`DatePicker`/`RelationEditor` are `absolute top-full` but MN-071's `ScalarValue` dropped the `relative` anchor the old row had. Fix: anchor the editor.
- **Collection add-editor clipped** — the relation picker in a collection is cut off by the card's `overflow-hidden` (screenshot: "Search or create Tasks…" overlaps the list). Fix: move the add affordance out of the clipped card.

## Gaps
- **Collapsible fields** — a chevron per field/section to collapse its value (and collapse a collection list to just its header + count). Persist `config.entity_collapsed`.
- **Hide when empty** — per-field ⋯ toggle `config.hide_when_empty`; an empty field with the flag drops into the hidden bucket (editors can still reveal; viewers never see it).
- **Number steppers** — number editor responds to ArrowUp/ArrowDown and shows +/- stepper buttons.
- **Collection cap** — a to-many list shows the first 20 rows, then "Show all N" (the 105-issue wall).

## Acceptance criteria
- [x] Sidebar select/user/date/relation editors open anchored under the field; nothing detaches or clips — verified in browser
- [x] Each field/section collapses & expands; state persists; collections collapse to header+count
- [x] "Hide when empty" hides empty flagged fields from the page; setting a value brings them back
- [x] Number fields step with arrow keys and on-screen +/- buttons
- [x] Collections cap at 20 with a working "Show all" — verified on a 100+ item relation
