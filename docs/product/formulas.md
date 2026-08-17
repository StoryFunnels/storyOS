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

A rollup can also **pick one** related record instead of aggregating them all (#286): choose
*Latest* or *Earliest*, the field to order by, and the field to show. "Last Ticket" = order the
linked Issues by `Number`, show their `Name`; leave the shown field empty and the rollup becomes a
clickable link to that record. The optional rollup filter applies first, so "latest Invoice that is
still unpaid" works. These are sortable and filterable like any other rollup (#300) — the value is
stored and refreshed whenever the winning record or the link set changes.

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
| `min(…)` / `max(…)` | number | Smallest / largest — also across a link | `max({A}, {B})` |
| `now()` / `today()` | date | Current moment / date | `today()` |
| `days_between(a, b)` | number | Whole days a → b | `days_between(today(), {Due})` |
| `add_days(d, n)` | date | Shift a date | `add_days({Start}, 7)` |
| `year(d)` / `month(d)` | number | Date parts | `year({Due})` |
| `switch(x, c1, r1, …, default)` | results' type | Compare `x` to each case, return the matching result | `switch({State}, "Done", 100, "Doing", 50, 0)` |
| `contains(s, find)` | checkbox | Text contains text — or a link contains a record ([below](#is-a-record-linked-242)) | `contains({Notes}, "urgent")` |
| `starts_with(s, p)` / `ends_with(s, p)` | checkbox | Prefix / suffix test | `ends_with({File}, ".pdf")` |
| `left(s, n)` / `right(s, n)` | text | First / last N characters | `right({Phone}, 4)` |
| `substring(s, start, len)` | text | Characters from a **1-based** start | `substring({Code}, 5, 3)` |
| `find(s, search)` | number | Position (1-based), `0` when absent | `find({Email}, "@")` |
| `split(s, sep, n)` | text | The Nth part after splitting | `split({Email}, "@", 2)` |
| `ceil(n)` / `floor(n)` | number | Round up / down | `ceil({Hours})` |
| `mod(a, b)` | number | Remainder | `mod({Count}, 2)` |
| `sqrt(n)` / `pow(a, b)` | number | Square root / power | `pow({Base}, 2)` |
| `sum(…)` | number | Add the arguments — or a field across a link | `sum({Fees}, {Tax})` |
| `count(link, cond?)` | number | Count linked records ([across a link](#across-a-link-298)) | `count({Issues})` |
| `avg(…)` | number | Average of the arguments, or across a link | `avg({Issues.Estimate})` |
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

## Across a link (#298)

`count`, `sum`, `avg`, `min` and `max` also reach through a **relation**, so you don't need a
Rollup field just to total something up:

```
count({Issues})                              how many Issues are linked
count({Issues}, {Issues.State} = "Done")     only the ones matching a condition
sum({Issues.Estimate})                       add up a field across every linked record
avg({Issues.Estimate})                       and the same for avg / min / max
```

The rules, all enforced by the editor as you type:

- `count` takes the **link itself** — `count({Issues})`, never `count({Issues.State})`.
- `sum`/`avg`/`min`/`max` take a **field through the link** — `sum({Issues.Estimate})` — and that
  field must be a number.
- The optional second argument is a condition evaluated **against each linked record**, so
  `{Issues.State}` inside it means "that issue's state".
- **One hop only.** `{A.B.C}` is not supported: every hop multiplies the rows read, and a feature
  that quietly degrades as your data grows is worse than one that isn't offered.
- An empty link gives `0` for `count` and **empty** for the rest — deliberately matching Rollup, so
  the two never disagree. ("No data" and "adds up to zero" are different answers.)

### Is a record linked? (#242)

`contains` also answers "is this record one of the linked ones", matched on the record's **#id**:

```
contains({Issues}, 42)                       is issue #42 linked to this record
if(contains({Blockers}, 7), "⚠️", "")         and it composes like any true/false value
```

It matches on the **#id deliberately, never the name.** The workaround this replaces was joining
the linked records' names into one string and searching it — which silently breaks the moment one
name contains another ("Acme" inside "Acme Corp"). Passing text raises a save-time error rather
than doing a comparison that usually works.

An empty link is `false`, not an error. One hop only, like the aggregates.

### Formula or rollup?

Both compute the same number over the same records. The difference is where the number lives:

| | Formula aggregate | Rollup field |
|---|---|---|
| Written | inline, in the formula editor | configured as its own field |
| Sort / filter a view by it | yes | yes |
| Shows up as its own column | no | yes |
| Its own filter over the linked records | as a second argument to `count` | a filter in the field config |
| Pick ONE related record (latest / earliest) | no | yes |

Both are materialized and both refresh when a linked record or a link changes (#300), so
sorting and filtering work either way. Reach for the **formula** when the number is part of a
larger expression (`sum({Issues.Estimate}) > 40`) or you just want it inline; reach for a
**Rollup** when you want it as its own column, or when you want the one thing only it does —
picking a single related record. See [rollups](#with-rollups-mn-064).

## Limits (v1)

Field traversal is one hop and aggregate-only: `{Client.Owner}` as a plain value still needs a
Lookup field, which you then reference. 5-level formula chains. Deleted referenced fields degrade
the result to empty with a warning in the field editor. Views can be sorted and filtered by a formula that
depends only on its own record OR that aggregates across a link (#300). A formula reaching a
**Lookup** still can't be sorted or filtered — nothing recomputes a stored copy of a lookup — and
the API says so explicitly rather than returning an empty page.
