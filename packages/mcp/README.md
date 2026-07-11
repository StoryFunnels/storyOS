# @storyos/mcp

The StoryOS [Model Context Protocol](https://modelcontextprotocol.io) server — it
exposes your StoryOS workspace to AI agents (Claude first; ChatGPT-compatible by
design). It's a thin, stateless translator over the same `/api/v1` the web app
uses, so it can never drift from the product, and every response is scoped and
validated server-side.

Design + roadmap: [`docs/product/mcp-plan.md`](../../docs/product/mcp-plan.md).
Ticket: [MN-076](../../tickets/MN-076-mcp-server.md).

## Tools

**Read**
| Tool | What it does |
|---|---|
| `get_started` | Orientation + a workspace map + the filter cheat-sheet. Call first. |
| `list_workspaces` | Workspaces the token can access. |
| `list_databases` | Databases in a workspace. |
| `describe_database` | A database's schema — exact `api_name`s, types, options, relation targets. **Read before writing.** |
| `search` | Full-text record search — turn a name into a real id. |
| `query_records` | Filter / sort / paginate records (structured filter AST). |
| `get_record` | One record in full, by uuid or public number. |

**Write** (each returns the resulting record; each 422 is surfaced verbatim)
| Tool | What it does |
|---|---|
| `create_record` | Create a record; `values` by `api_name`, selects accept the **label**. |
| `update_record` | Merge-update (null clears); record by uuid or public number. |
| `delete_record` | Trash a record (restorable 30 days). |
| `link_records` | Link a record to targets through a relation field. |
| `add_comment` | Post a comment. |
| `run_button` | Press a button field, running its automation actions. |

Hosted Streamable HTTP (for ChatGPT / claude.ai connectors without a local process)
is the remaining phase — it lands with the cloud tier (see MN-069).

## Why it doesn't hallucinate

- **Schema-first**: `describe_database` gives exact `api_name`s; you read before you write.
- **Validation-as-teacher**: the API's typed error is surfaced verbatim, so a wrong
  field/value comes back naming the problem and the model self-corrects in one turn.
- **Structured filters, not a query language**: nothing to invent; the op×type matrix
  ships in `get_started`.
- **Never invent ids**: they come only from `search` / `list_*` / a prior result;
  names and slugs are accepted and resolved server-side.

## Configure

Create a personal access token in StoryOS (**Settings → API**, `mn_pat_…`).

**Claude Code**

```bash
claude mcp add storyos -e STORYOS_URL=http://localhost:3001 -e STORYOS_TOKEN=mn_pat_xxx -- npx -y @storyos/mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "storyos": {
      "command": "npx",
      "args": ["-y", "@storyos/mcp"],
      "env": { "STORYOS_URL": "http://localhost:3001", "STORYOS_TOKEN": "mn_pat_xxx" }
    }
  }
}
```

`STORYOS_URL` defaults to `http://localhost:3001`; point it at your deployment
(e.g. `https://os.jamescookmedia.com`) in production.

## Develop

```bash
pnpm --filter @storyos/mcp dev     # run from source over stdio (needs STORYOS_TOKEN)
pnpm --filter @storyos/mcp build   # compile to dist/
```
