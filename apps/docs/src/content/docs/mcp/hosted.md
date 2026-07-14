---
title: Hosted MCP (HTTP + PAT)
description: Connect teammates and web clients to StoryOS over Streamable HTTP with just a URL and a personal access token.
sidebar:
  order: 4
---

The hosted transport runs the same [tools](/mcp/tools/) over HTTP, so teammates connect with just a
URL and a token — no repo, no `node` path. It's ideal for claude.ai / ChatGPT connectors, MCP
Inspector, and any web client.

- **Endpoint** — `POST /mcp` (stateless Streamable HTTP); `GET /health` for liveness.
- **Auth is per-request** — each call sends its own PAT as `Authorization: Bearer mn_pat_…`, so one
  endpoint serves every user and the API scopes each response. There's no shared token.

## Connect a client

Point your MCP client at the endpoint and send your token:

```json
{
  "mcpServers": {
    "storyos": {
      "url": "https://mcp.storyos.dev/mcp",
      "headers": { "Authorization": "Bearer mn_pat_xxx" }
    }
  }
}
```

On the cloud instance the endpoint is `https://mcp.storyos.dev/mcp`. On a self-hosted box it's
`https://mcp.your-domain.com/mcp`.

## Self-host the endpoint

The `mcp` service in `docker-compose.yml` runs the HTTP server. Expose it by routing a subdomain to
it in your Caddy TLS drop-in:

```
mcp.your-domain.com  →  mcp:3002
```

The service reads:

| Variable | Purpose |
|---|---|
| `STORYOS_URL` | Where the MCP server calls the API (defaults to the internal `api` service). |
| `PORT` | Listen port (`3002`). |

For a one-click connector experience (no pasted token), enable the
[OAuth connector](/mcp/oauth/).
