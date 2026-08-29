# MCP tools — what changed, and the fast paths

StoryOS ships a first-party MCP server (`packages/mcp`) advertising **127 tools**. This guide
covers the tools most likely to change how you work, not all 127 — the server itself is the
complete reference, and `get_started` is the in-band tour.

**Scopes.** Every tool has a minimum scope of `read`, `write` or `admin`. The catalog you are
offered is your token's scope intersected with those floors, so a read-only token never sees a
mutating tool at all. If a tool you expect is missing, check the token before checking the server.

## Build a workspace in one call, not ninety

Creating a database field by field costs one round trip per field. Three tools remove that.

| Tool | Scope | What it does |
|---|---|---|
| `list_packs` | read | The built-in Business Pack gallery — ready-made workspaces. |
| `install_pack` | admin | Installs one by slug. Idempotent. |
| `propose_schema` | admin | Turns a plain-language goal into a **plan**. Creates nothing. |
| `build_schema` | admin | Builds an approved plan — every database, field, relation and state in one call. |

**Check `list_packs` first.** If a pack already matches the goal, installing it is the fastest
possible "build me a workspace" and you skip planning entirely.

`install_pack` takes `preview: true`, which shows exactly what it would create and creates
nothing. On a workspace that already has data, do that first.

Otherwise the path is **propose → show the human → build**:

1. `propose_schema { workspace, goal }` returns a plan of databases, fields, relations and
   states, each marked create-new or reuse-existing. It writes nothing.
2. Show the plan to the person. This step is the point of splitting the two calls.
3. `build_schema { workspace, plan }` — pass the plan back **verbatim**. Do not reshape it: the
   server re-validates it and answers a malformed plan with a 422 naming the bad part, and an
   edited plan turns that into a confusing error. You get back a summary of what was created
   versus reused, with ids.

`propose_schema` takes an optional `mode`. Omit it for the free deterministic planner;
`storyos_ai` is metered against the workspace's AI credits.

## Batch record writes

| Tool | Scope | Limit | Failure behaviour |
|---|---|---|---|
| `create_records` | write | 100 per call | **Atomic** — all succeed or none do. |
| `update_records` | write | 200 per call | **Per-record** — partial failures are reported individually. |

The difference matters. `create_records` will not leave you half-imported. `update_records` will
apply to the records it could and tell you which it could not — read the response rather than
assuming a 200 means all 200 changed.

`create_records` takes `records: [{ values }]` keyed by `api_name`, exactly as `create_record`
does. `update_records` takes `record_ids` plus one `values` patch applied to every one of them —
the "set status to Done for everything in this view" shape.

## "The records in this view"

`query_records` takes a **`view`** argument (id or name) and applies that view's saved filter and
sorts. A pasted `?view=<uuid>` link works directly, so "work everything in here" is one call and
nobody has to translate the link into a filter by hand.

Your own `filter` / `sorts` override the view's, so "this view, but only the overdue ones" is
expressible.

One thing to know before you cache anything: **`me` in a view's filter is resolved by the server
against the calling identity.** The same view returns different rows for different callers. That
is correct, not a bug — but it means "the records in this view" is not a global answer.

## Descriptions — a one-line purpose at three levels

Workspace, space and database each carry an optional plain-text purpose line, max 200 characters.
It is not a rich-text document.

`list_workspaces`, `list_spaces`, `list_databases` and `describe_database` all return it, which is
the entire point. One line — *"Voices — tone-of-voice profiles we write in, one per publication"* —
tells a model more than fifteen field definitions do.

The three levels answer three questions in the order a newcomer or a model actually asks them:

- **Workspace** — what is this company doing here?
- **Space** — what is this area of work?
- **Database** — what belongs in this table?

`create_database` / `update_database` / `create_space` / `update_space` / `update_workspace` all
take `description`; the update tools accept `null` to clear it. **Set it at creation.** You already
know the purpose at that moment, and left unset the sentence is thrown away at the only point it
existed.

> Not to be confused with the record description block, which is configured by
> `description_hidden` / `description_order`. Those share a prefix with this and nothing else.

`update_space` and `update_workspace` are themselves new: `update_space` renames a space or sets
its icon, colour or description; `update_workspace` renames the workspace or sets its top-level
description. Both change only the fields you pass.

## Colours, and editing select options

**A database created without a `color` gets a random one.** That is how a set of databases ends up
with two purples. When you are building several in a row, pass distinct colours deliberately.

`create_database`, `update_database`, `create_space` and `update_space` take `color` from the
palette: `gray`, `brown`, `gold`, `orange`, `red`, `pink`, `purple`, `blue`, `teal`, `green`,
`lime`, `cyan`, `indigo`, `magenta`, `rose`. Anything else is rejected — there is no `navy`.

`update_field` can now **rename, recolour and remove** existing select options, not only add them.
Before this, an option created grey stayed grey forever.

- `add_options` — new choices.
- `update_options` — `{ option, label?, color?, icon? }`. **Non-destructive.** Option ids are
  stable and records point at the id, not the text, so every record holding an option keeps its
  value through a rename or a recolour.
- `remove_options` — `{ option, confirm?, reassign_to? }`. **Refuses with a usage count** when
  records still hold the option, unless you pass `confirm`. Read that count before confirming, and
  use `reassign_to` to move the holders onto another option instead of clearing them.

Options are addressed **by label**, because `describe_database` shows labels and never option ids.

## Relations link in the same write

`create_record` and `update_record` accept relation values directly: `{ project: [12] }` takes an
array of target record **numbers or ids** and links them as part of the same write. There is no
follow-up `link_records` call.

If you learned otherwise — that relation values in `values` were accepted and silently dropped —
that was true and is not any more.

## When your writes suddenly fail on argument shape

A client negotiates tool schemas **once, when it connects**. If your session connected before the
server was last deployed, your tool definitions can be stale, and the symptom is that arguments
start being rejected on shape for no reason you changed.

**Reconnect.** Do not retry different argument shapes — you will be guessing against a schema your
client cannot see. `get_started` prints the tool-argument schema version and the server version, so
you can tell whether yours is behind.

## What else is reachable

Beyond schema, records and views, the catalog covers most of the product. The tools worth knowing
exist, grouped by what you would be trying to do.

### Views

`create_view` / `update_view` / `delete_view`, plus `get_view`, `reorder_views`,
`create_space_view` and friends for space-level ones.

Two that save real work:

- **`duplicate_view`** copies a view with its filters, sorts, grouping and columns. Build the board
  once, duplicate it, change the one thing that differs — cheaper and safer than rebuilding a
  config by hand, which is where a filter gets subtly wrong.
- **`set_default_view`** chooses what people land on when they open a database. Worth setting
  deliberately after building several: creating the right board and leaving the wrong view in
  front of everyone is doing the work and then hiding it. This changes what **every** member sees.

### Personal surfaces

- **`get_my_work`** — the three things a person actually opens, for the identity your token belongs
  to: `assigned`, `created`, `recent` or `favorites`.
- **`set_personal_filter`** narrows a view **for you only**, leaving what teammates see untouched —
  "the team board, but just my rows". `clear: true` removes it.
- **`set_favorite`** stars something.

Note the contrast with `set_default_view` above: one changes your own view of a thing, the other
changes everyone's.

### Notifications and comments

**`list_notifications`** answers "what should I look at" — assignments, mentions, comments, state
changes and approval requests, newest first, for your token's identity. Also `get_unread_count`,
`mark_notifications`, `watch_record`, `list_watchers`, and the `add_comment` /
`update_comment` / `delete_comment` trio.

### Relations, and linking after an import

- **`list_relations`** returns the whole relation graph in one call — what is connected to what,
  both sides resolved. This is how you find out what a workspace's shape actually is.
- **`set_auto_link`** teaches a relation to link itself: give it field pairs, and a record links
  whenever **all** the pairs match (this database's `customer_email` equals the target's `email`).
- **`run_auto_link`** applies those rules to records that already exist.

**Setting a rule links nothing retroactively** — that is what `run_auto_link` is for. Together
these are the tool that pays for itself after an import: `create_records` writes 100 rows in one
call, and `run_auto_link` links them in one more instead of a hundred `link_records` calls.

### Documents and folders

`list_documents` / `get_document` / `create_document` / `update_document` / `delete_document`, and
`list_folders` / `create_folder` / `update_folder` / `delete_folder`.

**The two halves sit at different scopes**, and it is worth knowing before you plan a sequence: a
`write` token can create a document but **not** the folder to file it in — folder tools are `admin`.
That mirrors the API's own decorations rather than smoothing them over.

### Packs, templates and skills

`list_packs` / `install_pack` / `uninstall_pack` / `list_installed_packs` /
`browse_pack_marketplace` / `export_pack`, plus `list_templates` / `apply_template` and
`remove_sample_data` for clearing a pack's example rows.

Skills: `list_skills`, `get_skill`, `create_skill`, `update_skill`, `delete_skill`, `run_skill`,
`export_skill`, `list_skill_templates`.

### Agents

`get_agents`, `setup_agents`, `run_agent`, `delegate_to_agent`, `create_agent_trigger`,
`get_run_quota` and `rerun_action`.

### Membership and access — deliberately read-only

`list_members`, `list_grants` and `list_invites` read. **There is no tool to invite someone, remove
them, or change a role or a permission.** That is a decision, not a gap: those actions affect other
*people* rather than data, so they stay human.

`list_grants` is the one to reach for when somebody reports that a database is missing for them and
present for you — a grant, or its absence, is usually the answer.

## What to do when a tool is missing

Two different causes, and they need different fixes:

- **Not in your catalog at all** — your token's scope is below the tool's floor. A `write` token
  cannot see `install_pack` (`admin`). Reissue the token; the tool is not broken.
- **Present but refusing** — the API is the enforcement, and the scope map only stops you calling
  something doomed. A refusal names what it wanted. Read it rather than retrying.

Floors are not always where you would guess: a `write` token can create a document but **not** the
folder to file it in (`list_folders`/`create_folder` and friends are `admin`). That mirrors the
API's own decorations rather than smoothing them over, precisely so you do not call a doomed tool.
