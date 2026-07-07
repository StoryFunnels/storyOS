# Build an MCP server for StoryOS

StoryOS is deliberately MCP-ready without shipping one: the API is fully introspectable, so a generic MCP server adapts to ANY workspace schema. If you build one — please share it with the community.

## The three calls that make it generic

1. **`GET /api/v1/workspaces`** → workspaces the token can see.
2. **`GET /api/v1/workspaces/:ws/databases`** then **`GET …/databases/:id`** → every database with its fields: `apiName`, `type`, select `options` (ids + labels), and for relation fields the `relation` object (`target_database_id`, `cardinality`, `inverse_field_id`). This is your tool schema.
3. **`POST …/records/query`** + the write endpoints → everything else.

## Suggested tool surface

| MCP tool | Maps to |
|---|---|
| `list_databases` | databases + field summaries |
| `query_records(database, filter?, sorts?, q?)` | `POST /records/query` (expose the filter AST as the input schema, enum ops per field type) |
| `get_record` / `create_record` / `update_record` | records CRUD (values keyed by `api_name`; resolve option labels → ids from introspection) |
| `link_records(record, field, targets)` | `PUT /records/:rec/links/:field` |
| `comment(record, text)` | `POST /records/:rec/comments` with `[{type:'text',text}]` |

## Practical notes

- Auth: one env var, `STORYOS_TOKEN` (`mn_pat_…`), plus `STORYOS_URL`.
- Cache introspection per session; it changes only when someone edits schema.
- Map the error envelope's `details[]` into tool errors — the API tells you exactly which value was rejected and why.
- Respect `429` + `Retry-After`.
- The full OpenAPI spec at `/api/v1/openapi.json` can generate your client (`openapi-typescript`, `openapi-fetch`) — that's exactly how the official web app is built.
