# StoryOS MCP Server — Design Plan

> Status: **planning** (no code yet). This is the design we'll turn into tickets.
> Companion to the ticket [MN-076](../../tickets/MN-076-mcp-server.md).

## 1. Why an MCP, and why ours can be better

StoryOS is API-first by construction: the web app is just client #1 of a versioned,
OpenAPI-described REST API, and **every write is validated server-side against the live
schema** (unknown field → typed 422 with the offending path). That property is exactly
what an MCP needs to be *non-hallucinated*. The MCP is therefore a **thin, stateless
translation layer** over `/api/v1` — no business logic of its own, nothing to drift.

The bet: agents fail on work-OS tools for three reasons — (a) they invent field/property
names, (b) they invent record/database IDs, (c) they invent query syntax. We beat all
three with **schema-first grounding + validation-as-teacher + structured (not free-text)
filters + label-friendly writes**. Ease and correctness come from the same place.

## 2. Review of the incumbents (observed this session)

### Linear MCP (used directly)
- **Shape:** ~50 tools — `list_*` (rich filters + cursor pagination), `get_*` (by id),
  `save_*` (create-or-update **upsert**), plus `list_issue_labels`, `create_issue_label`,
  `list_cycles`, `list_comments`, `save_comment`, `list_users`, `search_documentation`, …
- **Good ideas to steal:** human-friendly resolution (`team: "StoryFunnels"` *or* an ID;
  `assignee: "me"`), **upsert** `save_*` (fewer tools, less "does it exist?" reasoning),
  cursor pagination everywhere, and a `search_documentation` tool for grounding.
- **Weakness:** Linear's schema is fixed, so it never has to teach the model the *user's*
  custom fields — a luxury we don't have (our databases are user-defined). We must expose
  schema explicitly.

### the reference tool MCP (tool surface observed)
- **Shape:** very granular — `schema`, `schema_detailed`, a generic `query` (the reference tool's own
  query language), `create_databases`, `create_entities`, `update_entities`, and a tool
  **per field type** (`create_single_select_fields`, `create_multi_select_fields`,
  `create_formula_field`, `create_workflow_field`, …), plus `its orientation tool` — a meta-tool
  that *teaches the agent how to use the reference tool*.
- **Good ideas to steal:** `schema`/`schema_detailed` for grounding, and the `its orientation tool`
  orientation tool (we'll do a tighter `get_started`).
- **Weaknesses to beat:** (1) the raw **query language** is a hallucination magnet — the model
  guesses syntax and gets opaque errors. (2) ~40 narrow tools bloat the tool list and dilute
  selection. (3) Schema-mutating tools (create fields/databases) are powerful but dangerous for
  an agent and rarely the point.

### Notion MCP (from general knowledge; server needs OAuth, not testable here)
- **Shape:** small, high-level — `search`, `fetch` (page/db by URL), `create-pages`,
  `update-page`, `create-comment`, database query. Markdown-first, URL-addressed.
- **Good ideas to steal:** small surface, URL/link addressing, markdown round-trips read nicely.
- **Weaknesses to beat:** database **property** hallucination (Notion's schema isn't surfaced
  crisply before writes), markdown↔block round-tripping loses structure, and filters are a
  fiddly nested JSON the model gets wrong.

**Synthesis:** Linear's upsert + human-friendly resolution + pagination, the reference tool's explicit
schema + orientation tool, Notion's small surface — minus the reference tool's raw query language and
Notion's property guessing. Our differentiator is that the **API already enforces the schema**,
so wrong writes fail loudly and *usefully*.

## 3. Design principles (how we're "easier + non-hallucinated")

1. **Schema-first.** `describe_database` returns exact `api_name`, type, select options
   (id **and** label **and** color), and relation targets. The agent reads before it writes.
2. **Validation-as-teacher.** Writes go straight to the API; a bad field returns the API's
   typed 422 (`{path, message}`) **verbatim** so the model self-corrects in one turn instead
   of guessing again. We never silently "fix" input.
3. **Structured filters, never a query language.** Filtering uses the *same* filter AST the
   app uses (`{field, op, value}` with and/or). The op×type matrix ships in the tool
   description and in `get_started`. No syntax to invent.
4. **Label-friendly writes.** Select/multi-select/person values accept the human **label or
   name** and resolve to IDs server-side (the record validator already resolves labels→ids for
   selects); the agent uses words, not UUIDs.
5. **Never invent IDs.** IDs only ever come from `search`, `list_*`, or a prior tool result.
   `search` exists precisely so "the Acme project" becomes a real ID.
6. **Read-back after write.** Create/update return the resulting record (values keyed by
   `api_name`) so the model sees ground truth, not its own assumption.
7. **Minimal, high-leverage surface (~16 tools).** Fewer, well-described tools beat 40 narrow
   ones for tool-selection accuracy.
8. **Compact payloads + pagination.** Query returns projected records (title + values), keyset
   cursors, `limit` ≤ 200 — no giant dumps.
9. **Stateless + contract-locked.** The server calls `/api/v1` through the generated
   `@storyos/sdk`; CI already drift-checks the OpenAPI spec, so the MCP can *never* fall out of
   sync with the product.

## 4. Architecture

```
Claude Desktop / Claude Code / any MCP client
        │  (stdio, or Streamable HTTP when hosted)
        ▼
@storyos/mcp   ── stateless translator ──▶  StoryOS /api/v1  (PAT auth)
  · @modelcontextprotocol/sdk (server)         · access grants enforced here
  · @storyos/sdk (typed openapi-fetch client)  · schema validation here (422)
```

- **Package:** `packages/mcp`, published as `@storyos/mcp`. Depends on `@storyos/sdk`
  (already generated from our OpenAPI) so requests are the exact product contract.
- **Transport:** **stdio** first (Claude Desktop / Claude Code, local). **Streamable HTTP**
  second (hosted, per-workspace) for the cloud/AI tier.
- **Auth:** a StoryOS **Personal Access Token** (`mn_pat_…`) via env `STORYOS_TOKEN`, plus
  `STORYOS_URL` (default `http://localhost:3001`, later `https://app.storyos.dev`). The PAT
  already carries the user's identity + access grants; the API returns 404 for anything out of
  scope, so the MCP inherits security for free. No new authz code in the MCP.
- **Workspace:** optional `STORYOS_WORKSPACE` default; otherwise tools take a `workspace`
  arg (name or id, resolved).
- **Zero business logic:** the MCP maps tool → SDK call → response shaping. Nothing to test
  beyond wiring; correctness lives in the (already-tested) API.

## 5. Tool catalog (v1 target ≈ 16)

**Orientation**
- `get_started(workspace?)` — one call that returns: how these tools fit together, the op×type
  filter cheat-sheet, and a compact map of the workspace (spaces → databases → field summary).
  The antidote to cold-start guessing. (Our tight take on the reference tool's `its orientation tool`.)

**Discovery / schema (grounding)**
- `list_workspaces()` → the PAT's workspaces.
- `list_databases(workspace)` → spaces + databases (id, name, icon, record count).
- `describe_database(database)` → fields (`api_name`, type, config, select options with
  id+label+color, relation → target database), views. **The tool the model must read before
  writing.**
- `search(workspace, query, limit?)` → `{id, title, database}` across records; the
  reference-resolver ("find the Acme client").

**Read**
- `query_records(database, filter?, sorts?, limit?, cursor?)` → the workhorse. `filter` is the
  structured AST; returns compact records + a `next_cursor`.
- `get_record(record)` → one record: values by `api_name`, resolved relation chips
  (`{id, title}`), rollups/formulas computed, description as plain text/markdown.

**Write** (each returns the resulting record; each 422 surfaces the API's field-level detail)
- `create_record(database, values)` — `values` by `api_name`; selects/persons accept labels.
- `update_record(record, values)` — merge; `null` clears a field.
- `delete_record(record, confirm?)` — soft delete (restorable 30 days); `confirm:true` guard.
- `link_records(record, relation_field, targets)` / `unlink_records(...)` — targets by id or,
  where unambiguous, by title (resolved via `search`).
- `add_comment(record, body)` — supports `@mentions` by member name.

**Do / automate**
- `run_button(record, button)` — press a button field; runs its configured actions
  (set fields / create linked / comment / notify / update-linked) as the token holder.
- `apply_template(workspace, template, options?)` — install one of the 19 packs (great for
  "set me up a CRM").

**Deferred (phase 3):** schema mutation (`create_database`, `add_field`) — powerful but the
main risk surface; gate behind an explicit opt-in. Automations CRUD. Attachment upload.

## 6. Resources & prompts (MCP niceties, phase 3)
- **Resources:** `storyos://ws/{id}/db/{id}/schema` — each database's schema as an attachable
  resource, so a client can prime context without spending a tool call.
- **Prompts:** a few starters — "Weekly status from my open tasks", "Set up a lightweight CRM",
  "Triage my inbox" — that chain the tools.

## 7. Anti-hallucination, concretely (the headline)
| Failure mode elsewhere | Our guard |
|---|---|
| Invents a field/property name | `describe_database` gives exact `api_names`; a bad write → 422 naming the field |
| Invents a database / record ID | IDs only from `search`/`list_*`; `search` resolves names → IDs |
| Invents query syntax | Structured filter AST; op×type matrix in the tool doc + `get_started` |
| Guesses a select option | Options (id+label) in schema; writes accept the **label**; bad value → 422 lists valid options |
| Over-fetches / dumps | Projected records, `limit`, keyset cursors |
| Acts on stale schema | Schema tools are live; SDK is CI-drift-checked against the product |
| "Did it work?" ambiguity | Writes return the resulting record (read-back) |

We can **measure** this: a small eval harness (tasks like "create a High-priority task
assigned to Dana in the Website project") that asserts the agent (1) reads schema, (2) uses
correct `api_names`, (3) recovers from a deliberately wrong field via the 422. Non-hallucination
becomes a number we can put on the box.

## 8. Packaging & distribution
- **Local (v1):** `npx @storyos/mcp`, configured with `STORYOS_URL` + `STORYOS_TOKEN`.
  Ship copy-paste snippets for **Claude Desktop** (`claude_desktop_config.json`) and
  **Claude Code** (`claude mcp add`). Because it's the public API + a PAT, self-hosters get the
  MCP for free — on brand with "capability is never paywalled."
- **Hosted (later):** a per-workspace **Streamable HTTP** endpoint on the cloud tier with OAuth,
  so claude.ai / ChatGPT connectors work without a local process. This is a natural paid-AI
  surface.

## 9. Phasing
- **Phase 1 — read-only (safe, high value):** `get_started`, `list_workspaces`,
  `list_databases`, `describe_database`, `search`, `query_records`, `get_record`. Agents can
  answer anything about a workspace with zero write risk. Ship + docs + eval harness.
- **Phase 2 — writes:** `create_record`, `update_record`, `delete_record`, `link/unlink`,
  `add_comment`, `run_button`, `apply_template`. Validation surfacing is the whole game.
- **Phase 3 — advanced:** resources, prompts, schema mutation (opt-in), automations CRUD,
  hosted HTTP + OAuth.

## 10. Decisions to confirm before we ticket it
1. **Package home:** `packages/mcp` → npm `@storyos/mcp`. (Recommend yes.)
2. **Surface size:** minimal ~16 high-leverage tools (recommend) vs work-OS-style granular.
3. **Filtering:** structured AST + cheat-sheet (recommend) vs a natural-language filter the MCP
   compiles. AST is the non-hallucination play; NL can come later as sugar.
4. **Write values:** accept labels/names for select/person and resolve server-side (recommend
   yes — ease + fewer ID lookups).
5. **First milestone:** local stdio + PAT, Phase 1 read-only. (Recommend — usable in a day,
   zero write risk, great demo.)
6. **Eval harness:** build the non-hallucination eval alongside Phase 1 so "better than
   Notion/the reference tool/Linear" is measured, not asserted.
