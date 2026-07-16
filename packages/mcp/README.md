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
| `create_record` | Create a record; `values` by `api_name`, selects accept the **label**, relations accept an array of target **numbers/ids** (linked in the same write). |
| `update_record` | Merge-update (null clears); record by uuid or public number. Naming a relation sets it to exactly those targets. |
| `delete_record` | Trash a record (restorable 30 days). |
| `link_records` | Link a record to targets through a relation field. `replace: true` sets the link set to exactly `targets` — how you re-point or clear a one-to-many link. |
| `unlink_records` | Remove specific links from a relation field (the relation itself stays). |
| `add_comment` | Post a comment. |
| `attach_file` | Attach a file to a record — from a public `url` (fetched server-side) or inline `content_base64`; images get a thumbnail. |
| `list_attachments` / `delete_attachment` | List a record's files, or remove one by id. |
| `run_button` | Press a button field, running its automation actions. |

**Build / schema** (agents design the workspace, not just fill it)
| Tool | What it does |
|---|---|
| `list_spaces` / `create_space` | List / create spaces (a space holds databases). |
| `create_database` / `update_database` / `delete_database` | Create, rename/move, or delete a database (delete needs `confirm` = name). |
| `add_field` / `update_field` / `delete_field` / `change_field_type` | Manage fields; select options by label; convert a field's type (`dry_run` to preview). |
| `create_view` / `update_view` / `delete_view` | Manage views; accepts `group_by` / `card_fields` / date fields plus `filters` + `sorts`. |
| `create_relation` / `delete_relation` | Link two databases (one_to_many / many_to_many) — paired relation fields. |
| `reorder_fields` / `reorder_views` | Set field / view order by name. |

Conveniences: `query_records` / `get_record` return select values as **labels** (not option ids) and rich_text as **Markdown**; `create_record` / `update_record` accept **Markdown** on a rich_text field (headings, lists, links, code → parsed to blocks) and select **labels**; `create_record` reports any **unset** template fields.

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

> Not published to npm yet — run it from this repo's build. (Once published, the
> `npx -y @storyos/mcp` form below becomes the one-liner.)

**1. Get a token** — in StoryOS, sidebar → **API tokens** → create one for the
workspace you want. Copy the `mn_pat_…` (shown once; scoped to that workspace).

**2. Build the package** (once):

```bash
pnpm install
pnpm --filter @storyos/mcp build      # → packages/mcp/dist/index.js
```

**3a. Claude Code**

```bash
claude mcp add storyos \
  -e STORYOS_URL=https://app.storyos.dev \
  -e STORYOS_TOKEN=mn_pat_xxx \
  -- node /ABSOLUTE/PATH/to/repo/packages/mcp/dist/index.js
```

**3b. Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`)

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

`STORYOS_URL` is `https://app.storyos.dev` for the cloud box, or
`http://localhost:3001` for local dev (the default). Restart Claude, then ask it to
"list my StoryOS databases".

**Once published to npm**, replace the command with `npx -y @storyos/mcp` (no build,
no path).

## Hosted (Streamable HTTP) — no local process

For cloud use, run the same tools over HTTP so teammates connect with just a URL +
token (claude.ai / ChatGPT connectors, MCP Inspector, etc.) — no repo, no `node` path.

- Entry: `dist/http.js` (`pnpm --filter @storyos/mcp start:http`), listens on `PORT` (3002).
- Endpoint: `POST /mcp` (stateless Streamable HTTP); `GET /health` for liveness.
- **Auth is per-request**: each call sends its own PAT as `Authorization: Bearer mn_pat_…`,
  so one endpoint serves every user and the API scopes each response. No shared token.
- Deploy: the `mcp` service in `docker-compose.yml` runs it; route a subdomain
  (`mcp.your-domain.com → mcp:3002`) in your Caddy TLS drop-in (see
  `docker/tls.d/origin.caddy.example`).

Connect a client to `https://mcp.your-domain.com/mcp`:

```json
{
  "mcpServers": {
    "storyos": {
      "url": "https://mcp.your-domain.com/mcp",
      "headers": { "Authorization": "Bearer mn_pat_xxx" }
    }
  }
}
```

## Develop

```bash
pnpm --filter @storyos/mcp dev     # run from source over stdio (needs STORYOS_TOKEN)
pnpm --filter @storyos/mcp build   # compile to dist/
```
