---
title: API conventions
description: Resource layout, the query endpoint, the operator × type matrix, keyset pagination, and the single error envelope.
sidebar:
  order: 4
---

Base path **`/api/v1`**. JSON only. Auth: `Authorization: Bearer <token>` (session token or
`mn_pat_` PAT) or the session cookie (web). See [authentication](/api/authentication/).

## Resource layout

```
GET    /me
GET|POST         /workspaces
GET|PATCH|DELETE /workspaces/:ws
GET|POST         /workspaces/:ws/spaces          PATCH|DELETE /spaces/:space
GET|POST         /workspaces/:ws/members         POST /workspaces/:ws/invites
GET|POST         /workspaces/:ws/databases       (create takes space_id)
GET|PATCH|DELETE /workspaces/:ws/databases/:db
GET|POST         /.../databases/:db/fields       PATCH|DELETE /fields/:field
POST             /.../fields/:field/options      PATCH|DELETE per option
POST             /workspaces/:ws/relations        DELETE /relations/:rel
GET|POST         /.../databases/:db/records       (POST supports batch ≤100)
GET|PATCH|DELETE /.../records/:rec                 (:rec is a uuid — see below for a public number)
GET              /.../records/by-number/:number     ← resolve a public number to its record
POST             /.../databases/:db/records/query          ← the workhorse
POST             /.../records/:rec/move           { before_record_id? | after_record_id?, values? }
GET|PUT          /.../records/:rec/links/:field   (list/replace) · POST add · DELETE remove
GET|PUT          /.../records/:rec/document       (PUT requires expected version → 409)
GET|POST         /.../records/:rec/comments        PATCH|DELETE /comments/:id
GET|POST         /.../records/:rec/attachments     DELETE /attachments/:id
GET              /.../records/:rec/activity
GET|POST         /.../databases/:db/views          PATCH|DELETE /views/:view
POST             /workspaces/:ws/templates/:slug/apply
GET|POST         /me/tokens                        DELETE /me/tokens/:id
```

**A record's public number only resolves through `by-number/:number`.** Every write and read tool
in the [MCP surface](/mcp/tools/) accepts "a uuid or public number" for `record` because it does
this resolution for you — `get_record` given a plain number calls `by-number` first, then reads the
result the same way it would a uuid. Calling `GET .../records/:rec` directly with a bare number
instead of a uuid is not the same path and doesn't work; resolve the number to its uuid via
`by-number` first if you're calling the raw API without the MCP layer in between.

The complete, always-current list with schemas is the [API Reference](/api/reference/).

## The query endpoint

Filter trees don't fit in GET params, so `POST /records/query` carries them. `GET /records`
remains for the simple case (`?limit&cursor&q=` title search, default order).

```json
{
  "filter": { "and": [
      { "field": "f-uuid", "op": "eq", "value": "opt-uuid" },
      { "or": [ { "field": "f2", "op": "gt", "value": 5 },
                { "field": "f3", "op": "is_empty" } ] } ] },
  "sorts": [ { "field": "f2", "direction": "desc" } ],
  "q": "acme",
  "expand": ["project"],
  "limit": 50,
  "cursor": "opaque..."
}
```

Limits: nesting depth ≤ 3, ≤ 50 conditions, `limit` ≤ 200, `expand` one level.

## Two meanings of `id`

`id` means two different things in the same round trip — the one place this API is genuinely
inconsistent, kept deliberately:

- **In a filter or sort**, the api_name `id` is the record's **permanent number** (the "issue 759"
  people cite). `{ "field": "id", "op": "eq", "value": 759 }` finds record **number** 759.
- **In a record payload**, the top-level `id` is the record's **UUID** (`d211835f-…`), not the number.

So the record you get back from that filter has `record.id` set to a UUID, never `759`. A caller
who assumes one meaning applies in both places will write a filter that silently matches nothing.

The number's older api_name, `number`, still works in filters, sorts and formulas — it is
deprecated, not removed, so stored views don't break — but `id` is the name to use. The UI labels it
"ID" and never offers `number` as a field. To go from a number to a record's UUID, use
[`by-number`](#resource-layout) (or an `id` filter); the payload field is **not** being renamed,
because that would break every existing SDK, MCP and script caller for naming alone. This will be
revisited only at a major version.

## Operator × type matrix

| Op | text/url/email | number | date | checkbox | select | workflow | multi_select | user | relation |
|---|---|---|---|---|---|---|---|---|---|
| `eq` / `neq` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `contains` | ✅ | — | — | — | — | — | — | — | — |
| `not_contains` | ✅ | — | — | — | — | — | — | — | — |
| `gt` `gte` `lt` `lte` | — | ✅ | — | — | — | — | — | — | — |
| `before` / `after` / `within` | — | — | ✅ | — | — | — | — | — | — |
| `has` / `has_none` | — | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ (record ids) |
| `is_empty` / `not_empty` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ | ✅ |

`within` accepts relative ranges (`today`, `next_7_days`, `this_month`, …). User filters accept the
literal `"me"`, resolved server-side. An invalid op-for-type returns `422`.

**`not_contains` treats an unset field as a match** — `null`/empty counts as "doesn't contain X",
the same direction `is_empty` already goes, rather than being silently excluded the way a bare
negated `contains` would leave it.

**A `workflow` field filters exactly like `select`** — same ops, same option-**id** values (not
labels; the MCP tools resolve a label to its id for you, the raw API always wants the id). It's
easy to miss precisely because it's identical to `select` rather than its own thing — see the
[MCP tools](/mcp/tools/) page for how `describe_database` and `query_records`/`count_records`
make this discoverable and filterable by label over MCP.

## Bulk operations

Three tiers, by how many records you're touching:

| Selection | Use | Behaviour |
|---|---|---|
| up to **5,000** | `POST .../records/batch` (one patch, many records) · `POST .../records/batch-delete` · `POST .../records/batch-restore` | Answers in one call. Processed in chunks of 200 server-side; a failure on one record is **reported per record**, not a failed call. |
| up to **50,000** | `POST .../records/batch-jobs` with `{ op: "update" \| "delete", record_ids, values? }` | A durable background job. Returns a job id at once; poll `GET .../records/batch-jobs/:id`. |
| any update | `POST .../records/batch-update-undo` | Reverts a bulk **field edit** using the `restorable` list its response carried. |

- **An update's response carries `restorable`** — one `{ record_id, version_id }` pair per record
  actually changed. Pass that array back, verbatim, to `batch-update-undo` to restore each record
  to its exact pre-edit snapshot. Use the list from the call you want to undo; a stale list from an
  earlier call restores to the wrong point in time.
- **A job survives a restart.** It advances one chunk at a time and records its position only once
  a chunk is saved, so a crash resumes where it stopped rather than starting over or double-counting.
- **Polling a job** returns `status` (`queued`, `running`, `succeeded`, or `partially_failed`),
  `total` / `processed` / `succeeded`, a `failed` list of `{ record_id, message }`, and — for an
  update — the same `restorable` list, which feeds `batch-update-undo`. A job is never silently
  partial: per-record failures are listed, not dropped.
- **`values` is required for an update job** and omitted for a delete.

Over MCP: `update_records` and `delete_records` take up to **200** ids per call (the REST
endpoints above take 5,000), `undo_batch_update` takes the `restorable` list, and
`enqueue_bulk_record_job` / `get_bulk_record_job` are the large-selection pair.

## Pagination

Keyset cursors only — an opaque base64url of `{sort_values, id}`. Responses are
`{ "data": [...], "next_cursor": "..." | null, "has_more": true }`. No offset pagination anywhere.

## Errors — one envelope everywhere

```json
{ "error": { "code": "validation_failed", "message": "...",
             "details": [{ "path": "values.f-uuid", "message": "expected number" }],
             "request_id": "req_..." } }
```

Stable codes: `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_failed`,
`rate_limited`. Optimistic-concurrency conflicts return `409` with the current version in details.
Guest access to unshared spaces returns `not_found` (404), never 403 — the API doesn't leak
existence.

## Record payloads

Values are keyed by stable **`api_name`** in requests and responses (field UUIDs are internal).
Relation fields return `{id, title}` chips. System fields are read-only.

## Rate limiting

Keyed per PAT / per session. Default 300 req/min, configurable via `RATE_LIMIT_PER_MINUTE`. Over
the limit returns `429` with `Retry-After`.
