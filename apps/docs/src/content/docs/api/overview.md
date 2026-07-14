---
title: API overview
description: The public StoryOS REST API — versioned under /api/v1, generated from an OpenAPI spec, the same API the web app uses.
sidebar:
  order: 1
---

The web app is client #1 of a public REST API — everything the UI does, you can do. The API is
versioned under **`/api/v1`**, JSON only, and its OpenAPI spec is generated from the code, so the
contract is always accurate.

## Base URL

- **Cloud** — `https://app.storyos.dev/api/v1`
- **Self-hosted** — `{API_URL}/api/v1` (your instance also serves interactive docs at
  `{API_URL}/api/docs` and the raw spec at `{API_URL}/api/v1/openapi.json`).

## Authentication

Send `Authorization: Bearer <token>` with either a session token or a **personal access token**
(`mn_pat_…`). A PAT acts as its creator — same role, same [guest scoping](/concepts/access-and-roles/).
See [authentication](/api/authentication/).

## What you can do

- **Introspect schema** — list databases, fields, and relation metadata.
- **Query records** — a filter AST with sorts, keyset cursors, and one-level expand. See
  [querying](/api/querying/).
- **Mutate** — create (single or batch ≤ 100), update (null clears a field), delete (soft),
  link relations, comment, and attach files.
- **Manage structure** — spaces, databases, fields, options, relations, and views are all API
  resources.

## The reference

The full, always-current reference is generated from the OpenAPI spec:

- **[API Reference →](/api/reference/)** — every operation, request/response schema, and status
  code.

For the design rules behind the API (resource layout, the query endpoint, error envelope, the
operator × type matrix, pagination), read the [conventions](/api/conventions/).

## Build clients

The API is designed so you can build any client — including an MCP server — with schema
introspection plus query and mutate endpoints. See
[build an MCP server](/api/build-an-mcp-server/), or use the
[first-party MCP server](/mcp/overview/).
