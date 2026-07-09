# Formulas

A **Formula** field computes its value from the record's other fields. It recalculates on every
read — always current, never stored, never editable. Reference fields as `{Field Name}`
(renames are safe: formulas track the field, not its name).

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
| Quarter label | `concat("Q", round((month({Due}) + 2) / 3), " ", format(year({Due})))` |
| Weighted score | `{Impact} * 2 + {Confidence} - {Effort}` |
| Kickoff deadline | `add_days({Start}, 14)` |

### With rollups (MN-064)

Rollup fields aggregate related records (count / sum / avg / min / max) and formulas can
reference them like any number field. The vacations story end-to-end:

1. On **Team Members**, add a rollup **Days Used** = *sum* of `Days` through the Time Off relation.
2. Add a formula **Balance** = `{Allocation} - {Days Used}`.

Other favorites: event budget vs actual (`{Budget} - {Spent}` where Spent is a sum-rollup over
Expenses), pipeline value per client (sum-rollup over Opportunity `Amount`), and simple counts
("Open requests" = count-rollup, no target field needed).

## Language

- **Field refs**: `{Estimate}`, `{State}` — text, number, checkbox, date, select (compares its
  **label**), url, email, lookups, and other formulas (chains up to 5 deep, cycles rejected).
- **Literals**: `42`, `3.14`, `"text"`, `true`, `false`.
- **Operators**: `+ - * / %`, comparisons `== != > >= < <=`, logic `and or not`. `+` concatenates
  when either side is text.
- **Empty values propagate**: any math over an empty field is empty; division by zero is empty —
  formulas never error at read time. Use `coalesce(…, 0)` for defaults.

## Function reference

| Function | Returns | What it does | Example |
|---|---|---|---|
| `if(cond, a, b)` | a/b's type | Branch on a condition | `if({Urgent}, "⚠️", "")` |
| `is_empty(x)` | checkbox | True when empty | `is_empty({Due})` |
| `coalesce(a, b, …)` | first arg's type | First non-empty argument | `coalesce({Alias}, {Name})` |
| `concat(…)` | text | Join values as text | `concat({Name}, "!")` |
| `upper(s)` / `lower(s)` | text | Change case | `upper({Code})` |
| `trim(s)` | text | Strip whitespace | `trim({Raw})` |
| `replace(s, find, repl)` | text | Replace every occurrence | `replace({Slug}, " ", "-")` |
| `length(s)` | number | Character count | `length({Name})` |
| `format(x)` | text | Any value as text | `format({Estimate})` |
| `round(n, places?)` | number | Round to N decimals | `round(10/3, 2)` |
| `abs(n)` | number | Absolute value | `abs({Delta})` |
| `min(…)` / `max(…)` | number | Smallest / largest | `max({A}, {B})` |
| `now()` / `today()` | date | Current moment / date | `today()` |
| `days_between(a, b)` | number | Whole days a → b | `days_between(today(), {Due})` |
| `add_days(d, n)` | date | Shift a date | `add_days({Start}, 7)` |
| `year(d)` / `month(d)` | number | Date parts | `year({Due})` |

## Limits (v1)

One database at a time (no `{Client.Owner}` traversal — use a Lookup field first, then reference
the lookup; for aggregation use a Rollup field, then reference the rollup), no filtering or
sorting views by formula values yet, 5-level formula chains, deleted referenced fields degrade
the result to empty with a warning in the field editor.
