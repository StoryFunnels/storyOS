# API conventions

Locked in [ADR-0003](../decisions/ADR-0003-api-conventions.md). Base path **`/api/v1`**. JSON only. Auth: `Authorization: Bearer <token>` (session token or `mn_pat_` PAT) or the better-auth cookie (web).

## Resource layout

```
POST   /auth/*                                   (better-auth mounted)
GET    /me
GET|POST         /workspaces
GET|PATCH|DELETE /workspaces/:ws
GET|POST         /workspaces/:ws/spaces          PATCH|DELETE /spaces/:space
GET|POST         /workspaces/:ws/members         POST /workspaces/:ws/invites
GET|POST         /workspaces/:ws/databases       (create takes space_id)
GET|PATCH|DELETE /workspaces/:ws/databases/:db
GET|POST         /.../databases/:db/fields       PATCH|DELETE /fields/:field
POST             /.../fields/:field/options      PATCH|DELETE per option
POST             /workspaces/:ws/relations       DELETE /relations/:rel
GET|POST         /.../databases/:db/records      (POST supports batch ≤100)
GET|PATCH|DELETE /.../records/:rec
POST             /.../databases/:db/records/query          ← the workhorse
POST             /.../records/:rec/move          { before_record_id? | after_record_id?, values? }
GET|PUT          /.../records/:rec/links/:field  (list/replace) · POST add · DELETE remove
GET|PUT          /.../records/:rec/document      (PUT requires expected version → 409)
GET|POST         /.../records/:rec/comments      PATCH|DELETE /comments/:id
GET|POST         /.../records/:rec/attachments   DELETE /attachments/:id
GET              /.../records/:rec/activity
GET|POST         /.../databases/:db/views        PATCH|DELETE /views/:view
POST             /workspaces/:ws/templates/:slug/apply
GET|POST         /me/tokens                      DELETE /me/tokens/:id
GET /openapi.json · GET /docs (Scalar) · GET /healthz
```

## The query endpoint

`POST /records/query` — filter trees don't fit GET params (Notion's API made the same call). `GET /records` remains for the simple case (`?limit&cursor&q=` title ILIKE, default position order).

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

`within` accepts relative ranges: `today`, `next_7_days`, `this_month`, etc. User filters accept the literal `"me"` token, resolved server-side. Invalid op-for-type → 422.

## Pagination

Keyset cursors only — opaque base64url of `{sort_values, id}`. Response: `{ "data": [...], "next_cursor": "..." | null, "has_more": true }`. No offset pagination anywhere.

## Errors — one envelope everywhere

```json
{ "error": { "code": "validation_failed", "message": "...",
             "details": [{ "path": "values.f-uuid", "message": "expected number" }],
             "request_id": "req_..." } }
```

Stable codes: `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_failed`, `rate_limited`. Optimistic-concurrency conflicts: `409` + the current version/`updated_at` in details. Guest access to unshared spaces: `not_found` (404), never 403.

## Record payloads

Values keyed by stable **`api_name`** in API responses/requests (field UUIDs internally). Relation fields return `{id, title}` chips. System fields read-only.

## Rate limiting

`@nestjs/throttler`, keyed per PAT / per session. Default 300 req/min, env-configurable (self-hosters can raise; per-plan limits are a managed-cloud concern). `429` + `Retry-After`.

## OpenAPI

Generated at build from nestjs-zod DTOs → committed to `docs/api/openapi.json` (contract diffs are reviewable in PRs) → served at `/api/v1/openapi.json` → SDK regenerated → CI drift check. Scalar UI at `/api/docs`.
