---
title: Querying records
description: Filter, sort, and paginate records with the StoryOS query endpoint and its structured filter AST.
sidebar:
  order: 3
---

The workhorse is `POST /api/v1/workspaces/:ws/databases/:db/records/query`. Values are keyed by
each field's stable `api_name`, so discover the schema first:

```bash
curl -s $API/api/v1/workspaces/$WS/databases -H "Authorization: Bearer $PAT" | jq '.[].id'
curl -s $API/api/v1/workspaces/$WS/databases/$DB -H "Authorization: Bearer $PAT" \
  | jq '.fields[] | {apiName, type}'
```

## Filters, sorts, cursors

```bash
curl -s -X POST $API/api/v1/workspaces/$WS/databases/$DB/records/query \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' -d '{
  "filter": { "and": [
    { "field": "state", "op": "has_none", "value": ["<done-option-id>"] },
    { "field": "due", "op": "within", "value": "next_7_days" }
  ]},
  "sorts": [{ "field": "due", "direction": "asc" }],
  "limit": 50
}' | jq
```

- **Operators per type** (full matrix in the [conventions](/api/conventions/)):
  `eq neq contains gt gte lt lte before after within has has_none is_empty not_empty`.
- **`within`** accepts `today`, `yesterday`, `tomorrow`, `last_7_days`, `next_7_days`, `this_month`,
  `next_30_days`. The family partitions cleanly around today, so a record never matches two of
  these at once: `last_N_days` is **inclusive** of today (today back through today−(N−1)), while
  `next_N_days` is **exclusive** of today (tomorrow through today+N) — `today` itself is its own
  filter and only ever matches that.
- **`before` / `after` also accept a relative day**, written `$date:-90d` (90 days ago) or
  `$date:+3d` (3 days from now): a sign, one to four digits, then `d`. The server turns it into a
  calendar date when the filter runs, counting days in UTC, so a filter such as "not reviewed in 90
  days" stays true as the days pass instead of freezing on the date you wrote it. A view, a
  scheduled automation's selection, an automation condition and a record query all read it the
  same way. It works with `before` and `after` only (not `eq`, `gt` or `within`), and a
  `$date:` value that is not in this form is refused with a `422`. The web filter builder shows and
  authors it as, for example, "more than 90 days ago".
- **`category_is` / `category_is_not`** filter a **workflow** or **select** field by the *state
  category* of its option instead of naming options. The value is one category, or a non-empty
  array of them: `backlog`, `unstarted`, `started`, `completed`, `canceled`. For example, the open
  tasks of a project are `{ "field": "status", "op": "category_is_not", "value": ["completed", "canceled"] }`.
  - **It follows the options.** The categories are matched against the field's options when the
    query runs, so an option someone adds later in a finished category is counted as finished
    without editing the filter. Moving an existing option to another category recomputes rollups
    that filter by category.
  - **`category_is_not` is the exact complement.** A record with no value, or whose option has no
    category (only a select option can lack one), is "not in" every category.
  - **A category no option has is not an error**: `category_is` matches nothing and
    `category_is_not` matches everything. A name that is not one of the five is a `422`, and so is
    either op on a `multi_select`, whose options have no category.
  - Over MCP, `query_records` and `count_records` pass these values through as written; category
    names are not option labels, so nothing is translated. The web filter builder authors and reads
    them as **is in category** and **is not in category** on Status and select fields; see
    [Filtering by state category](/concepts/views/#operators).
- **User fields** accept the literal `"me"`.
- **Cursors** — responses page with keyset cursors; pass `next_cursor` back as `cursor`.
- **Relations** — relation fields return `[{id, title}]` chips; filter them with `has` / `is_empty`.
- **Sorting by a choice field** — a `select`, `workflow` or `multi_select` sorts by the **position of
  its option** in the field's own option order (descending reverses it), not by label and not by
  option id. A `multi_select` sorts by the position of its **first stored value**. A value whose
  option no longer exists sorts with the empty values, which follow `nulls` (last by default), and
  ties break by record id. Paging walks the same order, so a cursor never repeats or skips a record.
- **Sorting by a relation** — a **single-valued** relation (the "Parent" side of a one-to-many)
  sorts by the **title of the linked record**; records with no link follow the usual empty-values
  placement. A **multi-valued** relation (the "many" side of a one-to-many, or either side of a
  many-to-many) can't be sorted — there is no single value to order by — and is refused with a
  `422`, the same as a multi-person field. The same list of sortable types drives the app's sort
  picker, so what a view can offer and what the API accepts agree.

## Counting and aggregating

Don't count by paging `records/query` and tallying — it is paginated, so a client-side count is the
size of one page. Ask the database:

- **`POST .../records/aggregate`** — one number: `{ op, field?, filter?, q? }`, where `op` is
  `count` (default), `sum`, `avg`, `min` or `max` (the last four need a number `field`). Takes the
  same filter AST as a query.
- **`POST .../records/aggregate/grouped`** — one number **per group**, in one query: the same body
  plus `group_by` (a field api_name) and, for a date field, `group_by_granularity` (`week`, `month`,
  `quarter`, `year`; each group's key is that bucket's start date). Returns
  `{ op, field, group_by, groups: [{ key, label?, value }], filtered, exact: true }`. This is what a
  board column's true size comes from.
- **Groupable fields:** select, workflow, multi-select, checkbox, a single-person user field, a date
  (with granularity), a number with configured bins (key is the bin index, `label` its name), the
  single side of a one-to-many relation, text, and lookup.
- **Keys are raw** — a select's option **id**, not its label. A record with no value is in the
  `null` group.
- **A multi-select counts a record in every option it has**, so group totals can add up to more than
  the number of records; a checkbox's keys are `"true"` and `"false"`.
- **Access applies to totals too:** a guest's counts cover only what they can see, the same as a list.

Over MCP these are `count_records` and `count_records_grouped`.

## Writing

```bash
# create (the batch endpoint /records/batch takes up to 100)
curl -s -X POST $API/api/v1/workspaces/$WS/databases/$DB/records \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' \
  -d '{"values": {"name": "New task", "estimate": 3}}'

# update (null clears a field)
curl -s -X PATCH $API/api/v1/workspaces/$WS/databases/$DB/records/$REC \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' \
  -d '{"values": {"state": "<option-id>"}}'

# link relations (not part of values)
curl -s -X PUT $API/api/v1/workspaces/$WS/databases/$DB/records/$REC/links/$FIELD \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' \
  -d '{"record_ids": ["<target-record-id>"]}'
```

For every operation's full schema, see the [API Reference](/api/reference/).
