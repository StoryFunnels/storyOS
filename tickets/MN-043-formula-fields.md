---
id: MN-043
title: Formula fields — computed values with a safe expression language, plus user docs
status: todo
depends_on: [MN-040]
size: XL
---

**Ask (founder, 2026-07-09):** a Formula field type, with instructions in docs on how to use it (Fibery docs as the reference for tone and structure).

**Research.** Fibery formulas: an expression language over the entity's fields (`[Estimate] * 2`, `If(IsEmpty([Due]), "—", ...)`), typed functions (text/number/date/logic), references traverse relations one hop, results are typed and read-only, recalculated on dependency change; docs are a function reference + cookbook of recipes. Notion formulas 2.0: editor with autocomplete, field tokens, live preview of the result, error messages inline. Airtable: same shape, huge function library. Common core: **typed expressions over the record's own fields (+ one relation hop via lookups), read-only computed results, an editor with field autocomplete and live preview, and docs that lead with recipes, not grammar**.

**Design (v1 scope, deliberately smaller than Fibery):**

- New field type `formula`, config `{ expression: string, result_type: 'text'|'number'|'checkbox'|'date' }`.
- Expression language: field references as `{Field Name}` (resolved to api names), literals, `+ - * / %`, comparison + `and/or/not`, and a small stdlib — `if(cond, a, b)`, `concat`, `upper/lower/trim`, `round/abs/min/max`, `now()`, `days_between(a, b)`, `is_empty(x)`. No loops, no chained lookups in v1.
- **Own recursive-descent parser + evaluator in `packages/schemas`** (shared: API computes, web previews live). No `eval`, no third-party expression engine — the AST is data, the evaluator whitelists functions. Type-checked at save (result must match `result_type`); cycles between formulas rejected.
- Computed **at read time** in the records read path after lookups resolve (formulas may reference lookup values); writes rejected like lookups. Filtering/sorting by formula values out of scope v1 (same rule as lookups).
- Editor UI: textarea with `{` -> field autocomplete dropdown, live preview against a sample record, inline parse/type errors.
- **Docs deliverable:** `docs/product/formulas.md` — Fibery-style: 10 recipes first ("Days until due", "Effort left", "Health emoji"), then the full function reference with signatures and examples; linked from the field editor's "Learn formulas" link.

## Acceptance criteria

- [ ] Parser/evaluator in packages/schemas with unit tests (precedence, type errors, division-by-zero → null, unknown field/function errors)
- [ ] `formula` creatable via API + UI; save-time validation (parse, type-check, reference existence, no formula→formula cycles)
- [ ] Read path computes values after lookups; writes 422; renaming a referenced field keeps formulas working (store api_name refs, display pretty names)
- [ ] Editor with field autocomplete + live preview + inline errors
- [ ] docs/product/formulas.md with recipes + reference; "Learn formulas" link in the editor
- [ ] Integration tests: arithmetic over number fields, if() over select, date math, formula-over-lookup
