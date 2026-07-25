# Querying records

The workhorse is `POST /api/v1/workspaces/:ws/databases/:db/records/query`. Values are keyed by each field's stable `api_name`; discover schema first:

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

- Ops per type (full matrix: `docs/architecture/api-conventions.md`): `eq neq contains gt gte lt lte before after within has has_none is_empty not_empty`
- `within` accepts `today yesterday tomorrow last_7_days next_7_days this_month next_30_days`
- User fields accept the literal `"me"`
- Responses page with keyset cursors: pass `next_cursor` back as `cursor`
- Relation fields return `[{id, title}]` chips; filter them with `has` / `is_empty`

## System fields

Every database has built-in, read-only columns that are filterable **and** sortable
by these `api_name`s — no schema lookup needed, they are the same on every database:

| api_name | what | ops | sortable |
| --- | --- | --- | --- |
| `number` | sequential public record number | `eq neq gt gte lt lte is_empty not_empty` | yes |
| `id` | alias of `number` (the record's public handle) | same as `number` | yes |
| `created_at` | creation timestamp | `eq neq before after within is_empty not_empty` | yes |
| `updated_at` | last-modified timestamp | same as `created_at` | yes |
| `created_by` | creating user | `eq neq has has_none is_empty not_empty` (id or `"me"`) | yes |
| `updated_by` | last-modifying user | same as `created_by` | yes |

```bash
# "high-numbered, most-recent first": filter by number, sort by created_at
curl -s -X POST $API/api/v1/workspaces/$WS/databases/$DB/records/query \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' -d '{
  "filter": { "field": "number", "op": "gte", "value": 320 },
  "sorts": [{ "field": "created_at", "direction": "desc" }],
  "limit": 50
}' | jq

# "my records, oldest edits first"
curl -s -X POST $API/api/v1/workspaces/$WS/databases/$DB/records/query \
  -H "Authorization: Bearer $PAT" -H 'content-type: application/json' -d '{
  "filter": { "field": "created_by", "op": "eq", "value": "me" },
  "sorts": [{ "field": "updated_at", "direction": "asc" }]
}' | jq
```

An unsupported op for a system field (e.g. `contains` on `number`) returns `422`
naming the allowed ops.

## Writing

```bash
# create (batch endpoint /records/batch takes up to 100)
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
