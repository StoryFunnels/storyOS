---
title: Connect Claude Code & Desktop
description: Run the StoryOS MCP server locally over stdio and connect it to Claude Code or Claude Desktop.
sidebar:
  order: 3
---

The local transport runs the MCP server as a subprocess of your client over stdio — best for a
single user on their own machine. For teammates and web clients, use the
[hosted endpoint](/mcp/hosted/) instead.

## 1. Get a token

In StoryOS, open the sidebar → **API tokens** → create one for the workspace you want. Copy the
`mn_pat_…` value — it's shown once and scoped to that workspace. See
[authentication](/api/authentication/).

## 2. Build the package (once)

The package isn't published to npm yet, so run it from the repo build:

```bash
pnpm install
pnpm --filter @storyos/mcp build      # → packages/mcp/dist/index.js
```

## 3a. Claude Code

```bash
claude mcp add storyos \
  -e STORYOS_URL=https://app.storyos.dev \
  -e STORYOS_TOKEN=mn_pat_xxx \
  -- node /ABSOLUTE/PATH/to/repo/packages/mcp/dist/index.js
```

## 3b. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "storyos": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/to/repo/packages/mcp/dist/index.js"],
      "env": {
        "STORYOS_URL": "https://app.storyos.dev",
        "STORYOS_TOKEN": "mn_pat_xxx"
      }
    }
  }
}
```

`STORYOS_URL` is `https://app.storyos.dev` for the cloud instance, or `http://localhost:3001` for
local dev (the default). Restart Claude, then ask it to "list my StoryOS databases".

:::note
Once the package is published to npm, the command becomes `npx -y @storyos/mcp` — no build, no
path.
:::

## Develop

```bash
pnpm --filter @storyos/mcp dev     # run from source over stdio (needs STORYOS_TOKEN)
pnpm --filter @storyos/mcp build   # compile to dist/
```
