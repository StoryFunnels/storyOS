---
title: Formulas
description: Compute a field's value from a record's other fields — 19 functions, field references, and 5-level chains.
sidebar:
  order: 4
---

A **formula** field computes its value from a record's other fields. It recalculates on every
read — always current, never stored, never editable. Reference fields as `{Field Name}` (renames
are safe: a formula tracks the field, not its name).

```
if({Estimate} > 5, "big", "small")
```

Add one via **New field → Formula**. The editor autocompletes fields when you type `{`, shows the
result type, and previews the value against a real record as you type.

## Recipes

| What you want | Formula |
|---|---|
| Days until due | `days_between(today(), {Due})` |
| Overdue flag | `days_between(today(), {Due}) < 0` |
| Effort remaining | `{Estimate} - {Spent}` |
| Budget utilization % | `round({Spent} / {Budget} * 100, 1)` |
| Health emoji | `if({State} == "Done", "🟢", if({Priority} == "Urgent", "🔴", "🟡"))` |
| Full label | `concat({Name}, " — ", {State})` |
| Safe default | `coalesce({Nickname}, {Name})` |
| Weighted score | `{Impact} * 2 + {Confidence} - {Effort}` |
| Kickoff deadline | `add_days({Start}, 14)` |

## Language

- **Field refs** — `{Estimate}`, `{State}`: text, number, checkbox, date, select (compares its
  **label**), url, email, [lookups](/concepts/lookups-and-rollups/), and other formulas (chains up
  to 5 deep; cycles are rejected).
- **Literals** — `42`, `3.14`, `"text"`, `true`, `false`.
- **Operators** — `+ - * / %`, comparisons `== != > >= < <=`, logic `and or not`. `+` concatenates
  when either side is text.
- **Empty values propagate** — any math over an empty field is empty; division by zero is empty, so
  formulas never error at read time. Use `coalesce(…, 0)` for defaults.

## Function reference

| Function | Returns | What it does |
|---|---|---|
| `if(cond, a, b)` | a/b's type | Branch on a condition |
| `is_empty(x)` | checkbox | True when empty |
| `coalesce(a, b, …)` | first arg's type | First non-empty argument |
| `concat(…)` | text | Join values as text |
| `upper(s)` / `lower(s)` | text | Change case |
| `trim(s)` | text | Strip whitespace |
| `replace(s, find, repl)` | text | Replace every occurrence |
| `length(s)` | number | Character count |
| `format(x)` | text | Any value as text |
| `round(n, places?)` | number | Round to N decimals |
| `abs(n)` | number | Absolute value |
| `min(…)` / `max(…)` | number | Smallest / largest |
| `now()` / `today()` | date | Current moment / date |
| `days_between(a, b)` | number | Whole days a → b |
| `add_days(d, n)` | date | Shift a date |
| `year(d)` / `month(d)` | number | Date parts |

## Limits

One database at a time (use a [lookup or rollup](/concepts/lookups-and-rollups/) to reach related
data), no filtering or sorting views by formula values yet, 5-level chains. Deleting a referenced
field degrades the result to empty with a warning in the field editor.
