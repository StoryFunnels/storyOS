---
title: Writing a pack manifest
description: The parts of a pack manifest that decide how an install behaves, and what a pack says about itself — why and can lines, option categories, agent AI mode and skills, and which automations install switched off.
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

## Automations that send things out install switched off

An automation whose actions leave the workspace or start an agent installs **switched off**, whatever
the manifest's `enabled` says.

| Action types | Install state |
|---|---|
| `send_email`, `send_slack_message`, `send_webhook`, `http_request`, `post_social` | Off (outward) |
| `run_agent` | Off (agent) |
| `set_values`, `create_record`, `create_records`, `add_comment`, `notify_user`, `update_linked` | As the manifest says |

A rule with several actions is off if any action is outward or runs an agent. An action type the server
does not recognise is treated as outward. A rule the manifest itself marks `enabled: false` stays off.

To switch some on at install, pass `enable_automations` with their labels, written
`Database.Rule name` as the preview lists them. Over MCP this is the `enable_automations` input of
`install_pack`; over REST it is `enable_automations` on the workspace's `packs/install` and
`packs/preview` calls. A label that matches no such rule is ignored.

The preview and the install result both report the outcome for each rule the install creates:

- **Preview:** `enabled_on_install`, and `switched_off_because` (`outward` or `agent`) when it is off for
  what it does.
- **Install result:** `enabled`, and the same `switched_off_because`.

A rule that already exists is left as it is, so the preview says nothing about it.
The web install screen does not list these switches yet; use the API or MCP.

## A pack without agents adds no Agentic OS space

Installing a pack whose manifest has no agents and no triggers does not create the *Agentic OS* space or
its Agents, Runs and Agent Triggers databases. The first agent or trigger created later, by any route,
creates them.
