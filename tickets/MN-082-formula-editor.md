---
id: MN-082
title: Formula field — autocomplete + functions helper + working docs link in Add Field
status: done
depends_on: [MN-043]
size: M
---

Bug: the Add Field dialog's Formula input is a plain textarea — no `{field}` autocomplete, no function reference, and the "Learn formulas" link is dead. A richer FormulaEditor already exists (MN-043); it isn't wired into Add Field.

## Design
- Use the existing FormulaEditor (with `{` field autocomplete + live preview) in the Add Field / field dialogs instead of the plain textarea.
- Add a compact functions helper (list of the 19 stdlib functions with signatures) beside/below the editor, insert-on-click.
- Point "Learn formulas →" at the real docs (docs/product/formulas.md or the hosted docs route).

## Acceptance criteria
- [x] Add Field → Formula shows autocomplete for `{fields}` and a functions helper
- [x] The docs link resolves to the formulas guide
- [x] Verified in browser
