# API docs

The API contract is code-generated — this folder holds the committed spec and human guides.

- **`openapi.json`** — generated from the NestJS route definitions at build time (ticket MN-005), committed so contract changes show up in PR diffs, served live at `/api/v1/openapi.json`, rendered at `/api/docs` (Scalar). *Not present until the API skeleton exists.*
- Conventions (auth, errors, cursors, the query endpoint, op×type matrix): [../architecture/api-conventions.md](../architecture/api-conventions.md)
- Icons & background colours for databases/spaces (`set:<name>` and the palette): [../icons.md](../icons.md)

## Guides (to be written alongside the relevant tickets)

| Guide | Ships with |
|---|---|
| `guides/authentication.md` — sessions, PATs, curl examples | MN-028 |
| `guides/querying.md` — filter AST, cursors, expand, batch create | MN-012 |
| `guides/build-an-mcp-server.md` — schema introspection → generic tools over any workspace | MN-028 |
| `guides/mcp-tools.md` — the first-party MCP server: fast paths, batch writes, scopes | #394 |

## The MCP story

**StoryOS now ships a first-party MCP server** (`packages/mcp`), advertising 127 tools. See
[guides/mcp-tools.md](guides/mcp-tools.md) for the fast paths and the scope model, and call
`get_started` for the in-band tour.

That was not always the plan, and the original reasoning still holds for anyone building their
own: the API is designed so that you can. Introspect schema (`GET /databases`, fields + relation
metadata), query records (`POST /records/query`), mutate (`PATCH /records/:id`), all with a PAT —
see [guides/build-an-mcp-server.md](guides/build-an-mcp-server.md).
