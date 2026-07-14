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
  `next_30_days`.
- **User fields** accept the literal `"me"`.
- **Cursors** — responses page with keyset cursors; pass `next_cursor` back as `cursor`.
- **Relations** — relation fields return `[{id, title}]` chips; filter them with `has` / `is_empty`.

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
