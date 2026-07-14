---
title: Use StoryOS with AI (MCP)
description: The StoryOS MCP server exposes your workspace to AI agents — Claude first, ChatGPT-compatible by design — over the same public API the web app uses.
sidebar:
  order: 1
  label: Overview
---

The StoryOS [Model Context Protocol](https://modelcontextprotocol.io) server exposes your
workspace to AI agents — Claude first, ChatGPT-compatible by design. It's a thin, stateless
translator over the same `/api/v1` the web app uses, so it can never drift from the product, and
every response is scoped and validated server-side.

## Two ways to connect

- **[Local (stdio)](/mcp/connect/)** — run the server as a subprocess of your MCP client (Claude
  Code, Claude Desktop). Best for a single user on their own machine.
- **[Hosted (Streamable HTTP)](/mcp/hosted/)** — connect with just a URL and a token, no local
  process. Best for teammates and web clients (claude.ai / ChatGPT connectors, MCP Inspector).
  Cloud users can connect via a one-click [OAuth connector](/mcp/oauth/) instead of pasting a
  token.

## Why it doesn't hallucinate

- **Schema-first** — `describe_database` gives exact `api_name`s; the agent reads before it writes.
- **Validation-as-teacher** — the API's typed error is surfaced verbatim, so a wrong field or value
  comes back naming the problem and the model self-corrects in one turn.
- **Structured filters, not a query language** — nothing to invent; the operator × type matrix ships
  in `get_started`.
- **Never invent ids** — ids come only from `search` / `list_*` / a prior result; names and slugs
  are accepted and resolved server-side.

Because the MCP is a thin layer over the [public API](/api/overview/), an agent's blast radius is
exactly its token's [access grants](/concepts/access-and-roles/) — scope a PAT to one guest's
spaces and the agent can only touch those.

## Next steps

- [Tools reference](/mcp/tools/) — everything an agent can do.
- [Connect Claude Code & Desktop](/mcp/connect/).
- [Hosted MCP](/mcp/hosted/) and the [OAuth connector](/mcp/oauth/).
