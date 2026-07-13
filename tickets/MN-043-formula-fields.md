---
id: MN-043
title: Formula fields — computed values with a safe expression language, plus user docs
status: done
depends_on: [MN-040]
size: XL
---

**Ask (founder, 2026-07-09):** a Formula field type, with instructions in docs on how to use it (the reference tool docs as the reference for tone and structure).

## Research

- **the reference tool**: expressions over the entity's fields (`[Estimate] * 2`, `If(IsEmpty([Due]), "—", Days([Due] - Today()))`), typed function library, one relation hop, read-only results recalculated on dependency change. Docs = short intro → recipe gallery → function reference. Errors show inline in the formula editor.
- **Notion formulas 2.0**: editor with autocomplete popup for fields and functions, live preview of the result under the input, typed errors ("Expected number, got text"). Property tokens are pills, not raw text — but serialize to names underneath.
- **Airtable**: the largest function library; the lesson is that ~20 functions cover >90% of real formulas (IF, math, string concat, date diff).
- **Coda**: everything-is-a-formula; too far for us. Confirms the ceiling, not the v1.

**Synthesis:** typed expressions over the record's own fields (plus lookups, which we already resolve), a small stdlib, save-time type checking, read-time evaluation, an editor with autocomplete + live preview, recipe-first docs.

## Design

### Expression language

- **Syntax**: field refs as `{Field Name}` (curly braces — friendlier to type than the reference tool's brackets, unambiguous vs our api_names); string literals `"…"`, numbers, `true/false`; operators `+ - * / %`, `== != > >= < <=`, `and or not`; parentheses; function calls `name(arg, …)`.
- **Stdlib v1 (~18 functions)**:
  - Logic: `if(cond, then, else)`, `is_empty(x)`, `coalesce(a, b, …)`
  - Text: `concat(…)`, `upper(s)`, `lower(s)`, `trim(s)`, `replace(s, find, repl)`, `length(s)`, `format(x)` (any → text)
  - Number: `round(n, places?)`, `abs(n)`, `min(…)`, `max(…)`
  - Date: `now()`, `today()`, `days_between(a, b)`, `add_days(d, n)`, `year(d)`, `month(d)`
- **Type system**: four result types — `text | number | checkbox | date`. Every AST node gets a static type at save; mismatches are save errors, not runtime surprises. `null` propagates (any op on null → null, except `is_empty`/`coalesce`); division by zero → null.
- **Field reference resolution**: the editor shows `{Display Name}`; we store the AST with **api_name** refs so renames never break formulas. On load for editing, api_names render back to current display names. Referencable: every field type that projects a scalar — text, number, checkbox, date, select (→ its label as text), url, email, lookup (its resolved value's type), formula (see cycles). NOT referencable in v1: multi_select, user, relation chips, rich_text.

### Where the code lives

- `packages/schemas/src/formula/` — tokenizer, recursive-descent parser → AST (plain JSON), type-checker, evaluator. Zero dependencies, no `eval`, functions whitelisted in a map. Shared verbatim by API (compute) and web (live preview + autocomplete metadata: each function declares name/signature/doc line — the reference docs and the autocomplete both generate from this table so they can't drift).
- API: field type `formula`, config `{ expression: string, ast: object, result_type: string }` — we store BOTH source text and compiled AST (evaluate the AST; keep the text for the editor).

### Validation at save (fields.service, like assertLookupConfig)

1. Parse — syntax errors with position → 422 with a caret snippet.
2. Every `{ref}` exists on the database and is a referencable type.
3. Type-check → the checked result type is stored as `result_type` (used by renderers and future filters).
4. **Cycle check**: build the formula-dependency graph for the database (formula → referenced formulas); reject if adding this edge creates a cycle. Depth cap 5.

### Evaluation at read time

- Extend the records read path after `attachLookups`: `attachFormulas(projected, defs)` — topologically sort the database's formula defs by dependency, evaluate per record against a value bag (projected values + resolved lookups). Pure CPU, no queries; ~µs per record per formula.
- Writes to formula values → 422 in the shared validator (same as lookup).
- Filtering/sorting by formulas: **out of scope v1** (query compiler default already errors cleanly). Documented in the ticket and the docs page.

### Editor UI (in AddFieldDialog / EditFieldDialog)

- Result type select (text/number/checkbox/date) — actually **inferred** from type-check and displayed as a read-only badge; no manual pick.
- `<textarea>` mono, 3 rows. Typing `{` opens a field autocomplete dropdown (arrow keys + Enter inserts `{Name}`); typing a letter at a call position offers function completions with signature hints.
- Below: **live preview** — evaluated against the first record of the database (or a synthetic empty record) with a "Preview uses: <record title>" note; parse/type errors render inline in red with position.
- "Learn formulas →" links to the docs page.

### Docs deliverable — `docs/product/formulas.md`

Structure mirrors the reference tool's guide: (1) 90-second intro with one worked example; (2) **Recipes** — Days until due, Overdue flag, Effort remaining, Health emoji from state, Full name concat, Budget utilization %, Age of record, Quarter label, Weighted score, Traffic-light checkbox; (3) Reference — every function with signature, one-line doc, example in/out (generated from the stdlib table); (4) Limits (no multi-hop, no filtering by formulas yet, 5-formula chains).

## Implementation plan

1. `packages/schemas/formula/`: tokenizer → parser → typechecker → evaluator + the function table; ~40 unit tests (precedence, null propagation, type errors, position reporting).
2. Field type plumbing: enum migration, config schema, save-time validation incl. cycle detection; `record-values` rejects writes.
3. `attachFormulas` in records read path + integration tests (arithmetic, if-over-select-label, date math, formula-over-lookup, formula-over-formula chain, cycle rejection).
4. Editor UI with autocomplete + live preview; `formula` in the type picker (icon: Sigma).
5. Cell/property rendering by result_type (reuse existing display components); read-only affordances.
6. Write docs page; link from editor; regenerate SDK.

## Edge cases

- Referenced field deleted → formula keeps evaluating with `null` for the missing ref AND the field editor shows a warning badge ("references a deleted field"); we do NOT cascade-delete formulas (unlike lookups) because the formula text is user work worth keeping.
- Referenced field type changes → re-type-check lazily at next save of the formula; at read, coercion failures yield null (never 500).
- Select option renamed → formulas compare against labels; docs recommend comparing via `{State}` == "Done" and note the rename hazard.
- Huge databases: evaluation is in-process per page (50 records × few formulas) — no caching needed in v1.

## Out of scope (v1)

Multi-hop traversal (`{Client.Owner.Email}`), aggregation over relations (`sum({Tasks.Estimate})` — that's Rollups, a future ticket), filtering/sorting by formula, custom user functions.

## Open questions (founder)

- Comfortable with `{Field Name}` syntax vs the reference tool's `[Field Name]`? (Curly chosen for typability; either is a 1-line tokenizer change.)
- Should formula results show in board cards / calendar chips by default? (Plan: yes, they're fields like any other.)

## Acceptance criteria

- [ ] Parser/evaluator in packages/schemas with unit tests (precedence, null propagation, type errors with positions, division-by-zero → null)
- [ ] `formula` creatable via API + UI; save-time parse/type/reference/cycle validation; writes 422
- [ ] Read path computes after lookups; renames safe (api_name refs); deleted refs degrade to null with editor warning
- [ ] Editor: `{` field autocomplete, function hints, live preview, inline errors, inferred result-type badge
- [ ] docs/product/formulas.md (recipes + generated reference) linked from the editor
- [ ] Integration tests: arithmetic, if-over-select, date math, formula-over-lookup, chain, cycle rejection
