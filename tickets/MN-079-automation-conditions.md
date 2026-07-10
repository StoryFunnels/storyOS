---
id: MN-079
title: Automation conditions — fix "op…" label, add more filter operators
status: done
depends_on: [MN-050]
size: S
---

Screenshot: the automation "Only if" condition op dropdown shows a bare "op…" placeholder (confusing) and offers too few operators.

## Design
- The op `<select>` in the rule condition renders a real, labeled op per field type (reuse OPS_BY_TYPE from the view toolbar) instead of "op…".
- Offer the full op set per type (eq/neq/contains/gt/lt/before/after/within/has/has_none/is_empty/not_empty) matching the filter engine.
- Value control matches the op input (text/number/date/options/relative/boolean/none).

## Acceptance criteria
- [x] Condition op dropdown shows named operators appropriate to the field type; no "op…"
- [x] Value input matches the operator; a saved rule with a real condition evaluates correctly
- [x] Verified in browser
