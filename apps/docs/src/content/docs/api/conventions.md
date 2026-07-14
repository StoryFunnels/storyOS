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
GET|PATCH|DELETE /.../records/:rec
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

## Operator × type matrix

| Op | text/url/email | number | date | checkbox | select | multi_select | user | relation |
|---|---|---|---|---|---|---|---|---|
| `eq` / `neq` | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | — |
| `contains` | ✅ | — | — | — | — | — | — | — |
| `gt` `gte` `lt` `lte` | — | ✅ | — | — | — | — | — | — |
| `before` / `after` / `within` | — | — | ✅ | — | — | — | — | — |
| `has` / `has_none` | — | — | — | — | ✅ | ✅ | ✅ | ✅ (record ids) |
| `is_empty` / `not_empty` | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ | ✅ |

`within` accepts relative ranges (`today`, `next_7_days`, `this_month`, …). User filters accept the
literal `"me"`, resolved server-side. An invalid op-for-type returns `422`.

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
