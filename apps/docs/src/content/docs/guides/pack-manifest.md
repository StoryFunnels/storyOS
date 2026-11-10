---
title: Writing a pack manifest
description: The parts of a pack manifest that decide how an install behaves, and what a pack says about itself — why and can lines, option categories, agent AI mode and skills, sort and limit on scheduled automations, which automations install switched off, and that agent triggers do too.
sidebar:
  order: 10
---

A pack is a JSON **manifest**. This page covers the parts of it that say what a pack is for and the
parts that change what an install does to a workspace. For installing a pack, see [Creating a workspace](/guides/creating-a-workspace/)
and, over MCP, [Installing a pack into an existing space](/mcp/tools/#installing-a-pack-into-an-existing-space).
`export_pack` writes a manifest from a workspace; the rest of the shape is checked on install, and
a manifest that does not validate is refused with a 422 that names the path and, for an option or an
agent, its label or name.

## Why and can: what a pack says about itself

A manifest may carry two short texts that say why someone would want the pack. Both are optional.

| Field | What it holds | Limits |
|---|---|---|
| `why` | **One sentence** naming the situation the pack is for | 1 to 400 characters |
| `can` | What a person can do once it is installed, one line each | 1 to 3 lines, each 1 to 300 characters |

- **A second sentence is refused.** A full stop, `!` or `?` (optionally followed by a closing quote or
  bracket) with more text after it fails validation with the message `why must be a single sentence`. A
  sentence that only contains punctuation inside it, such as `Is it 3.5 weeks or 4?`, passes.
- **Empty is refused.** An empty `why`, an empty `can` list, a blank line in `can`, more than three lines,
  or a line over the limit fails validation.
- **Leaving them out is fine.** A manifest without `why` and `can` still validates and installs, so older
  community and exported manifests keep working. Every built-in pack declares both.
- **Export takes them too.** The `export_pack` input (REST: `POST /workspaces/:ws/packs/export`) accepts
  `why` and `can` and writes them onto the manifest it produces; without them the exported manifest
  carries neither.

### What the pack listing returns

`GET /packs/registry` (over MCP, `list_packs`) returns, for each built-in pack, besides its name and
summary:

- `why`: the sentence, or `null` when the manifest declares none.
- `can`: the lines, or an empty array.
- `relations`: the manifest's own relation rows, each with `from`, `to`, `cardinality`, `from_field` and
  `to_field`. A relation from a database to itself is listed like any other.

This lets a person, or an agent, say why a pack fits before installing it.

### The public preview, before signup

The two public routes, `GET /api/v1/public/packs/registry` and `GET /api/v1/public/packs/registry/:slug`,
need no login and return the same three fields, built by the same code as the listing above: `why` (a string,
or `null`), `can` (an array, empty when there is none) and `relations`. A pack with no copy returns `null`,
`[]` and `[]`, never a missing key. The list route returns each pack's `slug`, `name`, `summary`,
`highlights`, `why`, `can` and `relations`. The single-pack route adds `requires` and `contents` (the names
of its databases, views, automations, agents and skills). Neither returns the manifest, an id or anything
from a workspace.

## Option categories

Every option of a select or workflow field in a manifest (`fields[].options` and `states[].options`)
may carry a `category`: what *kind* of state it is.

| `category` | Meaning |
|---|---|
| `backlog` | Parked, not planned |
| `unstarted` | Planned, not begun |
| `started` | In progress |
| `completed` | Done |
| `canceled` | Abandoned |

`category` is optional, so a manifest written without it stays valid.

- **Omitted:** a **workflow** field works the category out from the option's label and position; a
  plain **select** option keeps none.
- **Declared:** your category is used.
- **Any other value is refused** on install, and the error names the option by its label.
- **Only a missing option gets the category.** An option the database already has is not rewritten.
- **Export keeps categories.** An exported manifest carries the category of each option that has one.
- **Update preview.** When an update would add options with declared categories, the preview data lists
  those categories (`categories`, by label) with the new labels.

## Agents: AI mode and skills

An agent in a manifest may declare:

- `ai_mode`: `non_ai`, `your_own_ai` or `storyos_ai`. In the product these read **Non-AI**, **Your own AI**
  and **StoryOS AI**. The built-in packs' agents declare `your_own_ai`, so they install as **Your own AI**.
  StoryOS AI is metered; your own AI is not.
- `skills`: a list of skill names. Each must match a skill bundled in the same manifest, or the install
  is refused.

If `ai_mode` is omitted, no mode is written, and the agent behaves as an agent with no mode set did before
(Non-AI). If `skills` is empty, nothing is written.

### Skills are looked up by name when a run starts

The install records the names on the agent's **Skills** field, one per line. It does not copy the skills.
Each run looks the names up again as the agent's owner, ignoring case and surrounding spaces, so an
edit to a skill is used from the next run.

If a name cannot be found (removed, renamed, or not visible to the owner), the run does not start. It
is recorded as failed, names each missing skill, and says to rename the skill back or re-attach the one
you want by editing the agent's Skills field.

When skills do load, the run record has a step listing them. A skill's instructions are cut at 6,000
characters, and the cut says how long the full text was.

### What a pack update does with AI mode

An update never changes an agent's AI mode on its own. When a new version declares a different mode from
the one the agent has, the update review shows the agent as a choice, with the current mode, the proposed
mode and, for StoryOS AI, a note that it is metered. The mode changes only if you choose to take the update.
If you keep yours, the rest of the agent is still brought up to date when you had not edited it.

### Export

`export_pack` writes each agent's `ai_mode` when one is set, and its skills. It bundles every skill an
exported agent names. If an exported agent names a skill you cannot see, the export is refused (422)
and names it.

## Views, and the one a database opens on

A manifest's `views` list creates views on its databases. Each entry names its `database`, a `name`, a
`type` and a `config`. A view may also carry `default: true`, which makes it the view its database
opens on instead of the plain **All records** list.

- **Only for a database the install creates.** A database that already existed keeps the default view it
  has, and `default` is not applied to it.
- **Only for a view the install creates.** A view that already exists is not re-pointed.
- **One default per database.** If a manifest marks two views of one database, the later one is the one
  the database opens on.
- **Optional.** Leaving it out changes nothing, so existing manifests are unaffected.
- **Uninstalling never removes it**, because a database's default view is never removed (see
  [Uninstalling a pack](/mcp/tools/#uninstalling-a-pack)).

The built-in [Team Board](/guides/team-board-pack/) pack uses it to make its Board the view Tasks opens on.

### Hiding a board's columns: `hidden_option_ids`

A `board` view's `config` may carry `hidden_option_ids`, a list of option references naming columns of
the board that are not to be drawn. It is not the same as **Hide empty groups**, which hides columns by
being empty; this names the columns, empty or not.

```json
{
  "database": "Leads",
  "name": "Active",
  "type": "board",
  "config": {
    "group_by_field_id": "$field:leads.stage",
    "hidden_option_ids": ["$option:leads.stage.won", "$option:leads.stage.lost"]
  }
}
```

- **References, like any option id in a manifest.** On install each `$option:` reference becomes the
  installing workspace's own option id, and `export_pack` writes them back as references by label. A
  reference to an option that does not exist is a 422, not a silent skip.
- **Select or workflow grouping only.** A board grouped by a person, a relation or a date has no option to
  hide. A non-empty list on such a board, on a view that is not a board, or naming an option of another
  field is refused by the API with a 422.
- **Cards are not removed from anything.** The setting only says which columns are not drawn; it does not
  change what the view's filter selects.
- **A deleted option drops out of the list** when the view is read, and changing the board's group-by
  field drops options that belong to the old field.
- **An empty list, or leaving it out, hides nothing.** Hiding every column is allowed.
- **Outside a manifest:** over MCP, `create_view` and `update_view` take `hidden_columns`, a list of option
  labels (or ids); `[]` shows every column again, and changing `group_by` without passing it clears the
  list. Over REST it is `hidden_option_ids` in the view's `config`.

The web board reads the setting and does not draw those columns. They are listed under **Hidden columns** in
the board's **Display** menu, each with a **Show** button; see
[Hiding chosen columns](/concepts/views/#hiding-chosen-columns).

### Filters in a manifest: relative days and state categories

A view's `filters` and an automation's `condition` use the same filter shape as the
[query API](/api/querying/). Two values are worth knowing when writing a manifest:

- `before` / `after` on a date field take `$date:-90d` or `$date:+3d`. The value is stored as written and
  resolved to a date every time the filter runs, so "not reviewed in 90 days" stays true as time passes.
  Team Wiki's **Needs review** view is `{ "field": "last_reviewed", "op": "before", "value": "$date:-90d" }`.
  This is different from the same token in a **sample record**, which is turned into a fixed date once, on
  the day of install.
- `category_is` / `category_is_not` on a workflow or select field take state categories (see
  [Option categories](#option-categories)).

### A rollup that counts by category

A rollup is declared in `derived_fields`, after the relations it needs. The built-in
[Team Board](/guides/team-board-pack/) pack counts a project's open tasks like this:

```json
{
  "database": "Projects",
  "name": "Open tasks",
  "type": "rollup",
  "config": {
    "relation_field_id": "$field:projects.tasks",
    "op": "count",
    "filter": { "field": "status", "op": "category_is_not", "value": ["completed", "canceled"] }
  }
}
```

Because the filter names categories, a completed or canceled state added to Status later is not counted as
open, and the rollup does not need editing. Naming the **Done** option instead (`has_none` with its
`$option:` reference) would count such a state as open until the filter was changed.

## Sample records and their description

`sample_records` entries each name a `database` and the `values` of the record. An entry may also carry
`description`: Markdown, up to 20,000 characters, written as the record's body (the text you see when you
open it). It is optional, so manifests without it still validate.

- **Written when the install creates the record.** A sample record that already exists is left as the
  person has it, body included.
- **Export includes it.** `export_pack` writes a sample record's body back as `description` when it has
  one, converted to Markdown.
- The built-in Team Wiki pack uses it for the text of its four starter pages.

## Automations that send things out install switched off

An automation whose actions leave the workspace or start an agent installs **switched off**, whatever
the manifest's `enabled` says.

| Action types | Install state |
|---|---|
| `send_email`, `send_slack_message`, `send_webhook`, `http_request`, `post_social` | Off (outward) |
| `run_agent` | Off (agent) |
| `set_values`, `create_record`, `create_records`, `add_comment`, `notify_user`, `update_linked` | As the manifest says |

A rule with several actions is off if any action is outward or runs an agent. An action type the server
does not recognise is treated as outward. A rule the manifest itself marks `enabled: false` also installs
off. Naming any of these in `enable_automations` (below) switches it on.

To switch some on at install, pass `enable_automations` with their labels, written
`Database.Rule name` as the preview lists them. Over MCP this is the `enable_automations` input of
`install_pack`; over REST it is `enable_automations` on the workspace's `packs/install` and
`packs/preview` calls. A label that matches no such rule is ignored.

The preview and the install result both report the outcome for each rule the install creates:

- **Preview:** `enabled_on_install`, and `switched_off_because` (`outward` or `agent`) when it is off for
  what it does.
- **Install result:** `enabled`, and the same `switched_off_because`.

A rule that already exists is left as it is, so the preview says nothing about it.

### In the web install review

The review lists each automation the install would create. One that installs off reads **Off until you turn
it on**, followed by why: *It sends things outside your workspace.*, *It runs an agent.*, or, for a rule the
pack itself ships off, *The pack ships it switched off.* Each has a switch. Turning one on changes the line
to **On once installed** and sends that rule's label as `enable_automations`; with no switch turned on,
nothing is sent and every one of them stays off. The review checks your choice with a second preview, and
shows a rule as on only when that preview says it would be.

## Scheduled automations: sort and limit

An automation whose trigger is `schedule` may carry `sort` and `limit`, to act on the top few records
instead of all that match, such as the five tickets that have gone longest without an update. They are the same two
keys the rule API takes (see [Automations](/concepts/automations/)).

```json
{
  "database": "Tickets",
  "name": "Stalled digest",
  "trigger": { "type": "schedule", "every": "day", "at": "09:00" },
  "sort": [{ "field": "updated_at", "direction": "asc" }],
  "limit": 5,
  "actions": [{ "type": "add_comment", "body_template": "Stalled" }]
}
```

- **`sort`:** up to 3 keys, each a field's `api_name` and a `direction` (`asc` or `desc`; `asc` when
  omitted). It names a field by `api_name`, not by `$field:` reference, so nothing is rewritten on install.
  A field the database does not have fails the install with a 4xx that names it, and nothing is left behind.
- **`limit`:** a whole number from 1 to 200.
- **Schedule triggers only.** `sort` or `limit` on any other trigger fails validation with the message
  `sort/limit (top-N selection) are only available on a schedule trigger`; over REST that is a 422.
- **Optional.** A rule without them behaves as before, and its export has neither key.
- **Export** writes `sort` and `limit` on a scheduled rule that has them, and omits both on one that does not.
- **Editing them counts as a change.** On uninstall, a rule whose `sort` or `limit` differs from what the
  install created is kept, with the reason `Changed since install.`, the same as an edit to its actions.

## Agent triggers install switched off

A pack's **state-bound agent triggers** ("wake this agent when Status becomes New") also install
**switched off**. A trigger that is on creates a wake for its agent every time a record reaches the state,
so an install would otherwise start an agent nobody chose. A manifest cannot switch one on: a trigger has
no `enabled` field, and one a file carries is dropped.

- The built-in packs do not set `human_gate`, so every one of their triggers installs off and wakes its
  agent by itself once a person switches it on. Anything an agent writes outward still waits in the
  approvals queue.
- A trigger with `human_gate: true` ("ask me before each run") is not held off. It never starts a run by
  itself: a person starts every run. It reports `enabled: true` and `human_gate: true`. A manifest can
  still set it; no built-in pack does.
- **The web install review does not list triggers yet.** It shows the automations (above) but no switch for a
  trigger, so a trigger is switched on at install through the API or MCP, as below. The preview does list them.
- To switch one on at install, pass `enable_agent_triggers` with its label, written
  `Agent ← Database.Field = State` as the preview lists it. Over MCP this is the `enable_agent_triggers`
  input of `install_pack`; over REST it is `enable_agent_triggers` on `packs/install` and `packs/preview`.
  A label that matches no trigger is ignored.
- **Preview:** a `triggers` list. Each trigger the install would create carries `enabled_on_install`,
  and `switched_off_because: "wakes_agent"` when it is off.
- **Install result:** each created trigger carries `enabled`, and the same `switched_off_because`.
- A trigger that already exists is never changed by a re-install or an update, in either direction: one
  a person switched on stays on, one they left off stays off. An update that adds a trigger adds it off.
- Existing installs are not changed. A plan the Architect builds, and a trigger a person creates by
  hand, are not pack installs and stay on.

## A pack without agents adds no Agentic OS space

Installing a pack whose manifest has no agents and no triggers does not create the *Agentic OS* space or
its Agents, Runs and Agent Triggers databases. The first agent or trigger created later, by any route,
creates them.
