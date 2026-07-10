---
id: MN-076
title: MCP server — expose the StoryOS API as Model Context Protocol tools
status: in-progress
depends_on: []
size: L
---

> **Phase 1 (read-only) shipped.** `packages/mcp` (`@storyos/mcp`), stdio + PAT auth,
> 7 tools: `get_started`, `list_workspaces`, `list_databases`, `describe_database`,
> `search`, `query_records`, `get_record`. Verified end-to-end against the live API
> (9/9 smoke checks incl. the validation-as-teacher error paths). Full design +
> phasing in [`docs/product/mcp-plan.md`](../docs/product/mcp-plan.md); package docs in
> `packages/mcp/README.md`. **Phase 2 (writes)** and **Phase 3 (resources, hosted
> Streamable HTTP for ChatGPT/claude.ai)** remain.

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
