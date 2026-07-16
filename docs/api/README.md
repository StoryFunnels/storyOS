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

## The MCP story

We don't ship an MCP server in v1 — deliberately. The API is designed so anyone can build one: introspect schema (`GET /databases`, fields + relation metadata), query records (`POST /records/query`), mutate (`PATCH /records/:id`), all with a PAT. If the community builds it, the API did its job. A first-party MCP server (and a hosted one) is a post-v1 / cloud concern.
