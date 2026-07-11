---
id: MN-076
title: MCP server — expose the StoryOS API as Model Context Protocol tools
status: done
depends_on: []
size: L
---

> **Done (read + write).** `packages/mcp` (`@storyos/mcp`), stdio + PAT auth, **13
> tools**. Read: `get_started`, `list_workspaces`, `list_databases`,
> `describe_database`, `search`, `query_records`, `get_record`. Write:
> `create_record`, `update_record`, `delete_record`, `link_records`, `add_comment`,
> `run_button` — each returns the resulting record; the API's typed 422 is surfaced
> verbatim; select values accept human labels (MCP maps label→id). Verified
> end-to-end against the live API (14/14 in-memory smoke checks incl. the
> anti-hallucination paths). Design in [`docs/product/mcp-plan.md`](../docs/product/mcp-plan.md);
> usage in `packages/mcp/README.md`.
>
> **Remaining (own follow-up):** hosted **Streamable HTTP** endpoint so ChatGPT /
> claude.ai connectors work without a local process — ships with the cloud tier
> ([[MN-069]] cloud deploy). The server build is already transport-agnostic, so this
> is a small addition there. Resources/prompts optional niceties, deferred.

StoryOS is API-first precisely so an MCP server is a thin wrapper (vision.md, docs/api "build an MCP server"). An MCP server lets Claude/agents read and write a workspace: list databases, query records, create/update records, manage relations — the paid-cloud AI story and a strong differentiator.

## Design (to refine when we start)
- New package `packages/mcp` (or `apps/mcp`): a stdio + HTTP MCP server that authenticates with a StoryOS PAT and calls the public `/api/v1` via the generated SDK.
- Tools (thin over the API): `list_databases`, `get_database` (schema), `query_records` (filter AST), `create_record`, `update_record`, `link_records`, `add_comment`, `list_templates`/`apply_template`, `run_button`. Read tools first, then writes.
- Resources: database schemas as MCP resources so the agent can discover the shape.
- Auth: PAT via env/header; scope everything to the token's workspace + access grants (the API already enforces this).
- Ship: `npx @storyos/mcp` + docs; later, hosted per-workspace MCP endpoint on the cloud tier.

## Acceptance criteria
- [ ] MCP server connects with a PAT and lists a workspace's databases as tools/resources
- [ ] Query + create + update + link records through MCP, enforced by the same access rules
- [ ] Docs: connect from Claude Desktop / Claude Code; example session
