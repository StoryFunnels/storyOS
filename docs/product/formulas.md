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
| `switch(x, c1, r1, …, default)` | results' type | Compare `x` to each case, return the matching result | `switch({State}, "Done", 100, "Doing", 50, 0)` |
| `contains(s, find)` | checkbox | Text contains text | `contains({Notes}, "urgent")` |
| `starts_with(s, p)` / `ends_with(s, p)` | checkbox | Prefix / suffix test | `ends_with({File}, ".pdf")` |
| `left(s, n)` / `right(s, n)` | text | First / last N characters | `right({Phone}, 4)` |
| `substring(s, start, len)` | text | Characters from a **1-based** start | `substring({Code}, 5, 3)` |
| `find(s, search)` | number | Position (1-based), `0` when absent | `find({Email}, "@")` |
| `split(s, sep, n)` | text | The Nth part after splitting | `split({Email}, "@", 2)` |
| `ceil(n)` / `floor(n)` | number | Round up / down | `ceil({Hours})` |
| `mod(a, b)` | number | Remainder | `mod({Count}, 2)` |
| `sqrt(n)` / `pow(a, b)` | number | Square root / power | `pow({Base}, 2)` |
| `sum(…)` | number | Add the arguments | `sum({Fees}, {Tax})` |
| `day(d)` / `weekday(d)` | number | Day of month / of week (1 = Mon) | `weekday({Due})` |
| `hour(d)` / `minute(d)` | number | Time parts, UTC | `hour({Started})` |
| `date_diff(a, b, unit)` | number | Whole `"days"`/`"weeks"`/`"months"`/`"years"` | `date_diff({Start}, today(), "months")` |
| `add_months(d, n)` | date | Shift months, clamped to a shorter month | `add_months({Start}, 3)` |
| `end_of_month(d)` | date | Last day of that month | `end_of_month({Invoiced})` |
| `is_before(a, b)` / `is_after(a, b)` | checkbox | Date comparison | `is_before({Due}, today())` |
| `workdays_between(a, b)` | number | Weekdays a → b (ignores holidays) | `workdays_between({Opened}, today())` |
| `to_number(s)` / `to_date(s)` | number / date | Cast text, empty when unparseable | `to_number({Code})` |
| `nullif(a, b)` | a's type | Empty when `a` equals `b` | `nullif({Status}, "Unknown")` |

`and`, `or` and `not` are **operators**, not functions — write `{Done} and {Approved}`, never
`and({Done}, {Approved})`. They're listed alongside the functions in the editor's help panel.

`sum()` adds its own arguments. To add up values across a **relation**, use a Rollup field and then
reference the rollup.

## Limits (v1)

One database at a time (no `{Client.Owner}` traversal — use a Lookup field first, then reference
the lookup; for aggregation use a Rollup field, then reference the rollup), no filtering or
sorting views by formula values yet, 5-level formula chains, deleted referenced fields degrade
the result to empty with a warning in the field editor.
