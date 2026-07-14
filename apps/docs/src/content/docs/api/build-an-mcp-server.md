---
title: Build an MCP server
description: The StoryOS API is designed so anyone can build a generic client — introspect schema, query records, mutate — over any workspace.
sidebar:
  order: 5
---

StoryOS ships a [first-party MCP server](/mcp/overview/), but the API is deliberately designed so
**anyone** can build one — or any other generic client — over any workspace. This guide sketches
the pattern.

:::tip
If you just want to use StoryOS from Claude or ChatGPT, use the
[first-party MCP server](/mcp/overview/) — you don't need to build anything.
:::

## The three moves

Everything a generic client needs is three capabilities, all available with a single
[personal access token](/api/authentication/):

1. **Introspect schema** — `GET /workspaces/:ws/databases` and the database detail endpoint expose
   fields (with stable `api_name`s and types) and relation metadata. This is what lets a client
   present real tools instead of guessing field names.
2. **Query records** — `POST /records/query` with the structured [filter AST](/api/querying/): no
   query language to invent, just a typed filter tree, sorts, and cursors.
3. **Mutate** — `POST /records` (single or batch), `PATCH /records/:id` (null clears a field),
   `DELETE /records/:id` (soft), and the links endpoints for relations.

## Why this stays honest

- **Schema-first** — read `describe_database` before writing, so tools reflect the live schema.
- **Validation-as-teacher** — the API returns a typed `422` naming the offending field/value, so a
  client (or the model behind it) can self-correct.
- **Stable ids from the server** — ids come from `search` / `list_*` / prior results; names and
  slugs are accepted and resolved server-side, so a client never fabricates ids.

## Scope and safety

A PAT acts as its creator, with the same role and [guest space scoping](/concepts/access-and-roles/).
That means a client's blast radius is exactly the token's grants — scope a token to one space and a
generic client (or agent) can only touch that space.

## Reference

- [API overview](/api/overview/) and [conventions](/api/conventions/)
- [Querying records](/api/querying/) — the filter AST in depth
- [API Reference](/api/reference/) — every operation and schema
- The [first-party MCP server](/mcp/overview/) is a working example of exactly this pattern.
