---
id: MN-106
title: MCP — make it usable (npm publish + hosted HTTP + connect UX)
status: todo
depends_on: [MN-076, MN-105]
size: M
---

## Why

The MCP works (read+write, MN-076) but isn't *usable* by anyone but us: the package is
`private` (so `npx @storyos/mcp` fails — you must clone + build), there's no hosted
endpoint for ChatGPT/claude.ai, and nothing in the app tells you how to connect.

## Scope

1. **Publish `@storyos/mcp` to npm** — flip `private`, add a build+publish CI workflow
   (provenance, version bump), so the documented `npx -y @storyos/mcp` one-liner works
   for stdio clients (Claude Desktop / Claude Code).
2. **Hosted Streamable HTTP endpoint** at `mcp.storyos.dev` (MN-105) — the server is
   already transport-agnostic (`buildServer()`); add an HTTP transport + per-request PAT
   (or OAuth) auth so **ChatGPT connectors and claude.ai** work without a local process.
3. **Connect UX in the app** — an "AI / MCP" settings page: create a PAT, copy the
   stdio config snippet, copy the hosted URL, "Add to Claude" deep-link where possible.
4. **Docs polish** — the package README (done) + a `docs.storyos.dev` "Use with Claude /
   ChatGPT" guide with a worked session; link from the app.
5. **Eval harness** (from the plan) — a small non-hallucination eval run in CI so
   "better than Notion/Fibery/Linear" is measured, not asserted.

## Acceptance criteria
- [ ] `npx -y @storyos/mcp` works after publish; version pinned + provenance.
- [ ] Hosted HTTP endpoint authenticates a PAT and serves the same 13 tools; a ChatGPT
      connector and claude.ai can read+write a workspace through it.
- [ ] In-app connect page (PAT + snippets + hosted URL); docs guide published.
