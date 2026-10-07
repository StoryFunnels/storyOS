---
title: Record history
description: Every field change is logged with who it's for and what actually made it — human, agent, automation, or MCP.
sidebar:
  order: 10
---

Every field change on a record is logged: what changed, from what to what, who it was for, and
**what made the change**.

The source label is recorded on every change and returned by
`GET /workspaces/{ws}/databases/{db}/records/{rec}/versions/changes` (and by the MCP
`get_history` tool), and it now renders in the record's **activity panel** too, as a small badge
next to the actor's name.

**`human` renders no badge at all.** It's the default a reader already assumes, and marking every
ordinary edit would bury the exceptions the badge exists to surface — `agent`, `automation` and
`mcp` each get their own labelled badge.

**A row with no source recorded gets its own explicit badge, never a silent fold into `human`.**
Anything written before this tracking shipped, or from an insert site an early rollout missed, has
`source: null` — and shows as *"Source not recorded"* rather than reading as an ordinary human
edit. Treating "unknown" and "human" as the same badge is the single easiest way to get this
wrong, so the two stay visually distinct.

## Two different questions

History answers two questions that are easy to confuse, and keeps them as separate columns.

**Who** — always a person. A member's name is on every row, including rows an agent or an
automation wrote. That is deliberate: an agent acts as the member who ran it, bounded by that
member's permissions, so the person who authorised the change is the person accountable for it.
Agents never appear as actors and never accumulate a permission surface of their own.

**What made it** — one of four:

| Badge | Means |
|---|---|
| **human** | Somebody typed it, in the app. |
| **agent** | An agent run produced it — including Tyron. |
| **automation** | An automation rule or a button action. |
| **mcp** | A write that arrived over the API with a personal access token. |

So "Ada changed Status to Done · automation" is not a contradiction. It means a rule Ada owns
fired, and the change is hers in the sense that matters for permissions and accountability.

## An agent write names the agent, not just its owner

An `agent`-badged row carries a third fact alongside who and what: **which configured Agent**
(from your workspace's Agents database) actually made the write — its name at the moment it wrote,
snapshotted so a later rename or deletion never rewrites what a historical row appears to say.

**The human owner is resolved from the credential, live, every request — never from a stale token
field and never something the agent supplies about itself.** An agent-scoped token whose Agent
record has been deleted, or whose owner is no longer an active member, is refused outright — there
is no fallback identity an agent's writes fall back to instead. A person is never blocked by this;
only an agent-scoped credential is.

**Query one agent's activity in bulk** — `GET /workspaces/:ws/agents/:agent/activity` (`from`/`to`
date range) or the `list_agent_activity` MCP tool — for "show me everything this agent did last
week," rather than reading one record's history at a time.

## Where the label comes from

It is **derived from how the request authenticated**, never claimed by the caller:

- A browser session → `human`.
- The agent runtime → `agent`.
- The automation executor → `automation`.
- An API token → `agent` if the token was minted as an agent's, `mcp` otherwise.

That last one is the interesting case. The label lives on the **token row**, not in a request
header, precisely because a header is forgeable by any client — and provenance that its own
subject can claim is not provenance.

## One thing to know if you use the API

**An ordinary personal access token reads as `mcp`.** If you write records from your own script
with a PAT, those changes are badged `mcp` — not because they came from an MCP client, but because
an unmarked token is treated as one. The badge tells you a change came in over the API with a
token; it does not tell you which program held it.

`human` means a browser session and nothing else, so it is a reliable answer to "was a person at
the keyboard" — which is the question the badge exists to answer.

![An activity feed showing a plain human edit next to an MCP-badged record creation](/images/activity-source-badge.png)

Above: a record created by a script authenticating with a personal access token — badged `mcp` —
next to an ordinary edit made in the app, which carries no badge at all.

## What a change looks like

Every change is stored **exactly as it was written** — a select's option id, not its label. That
faithfulness is the one thing a change log cannot give up: a stored label would quietly rewrite
itself every time somebody renamed an option.

The translating happens when you read it, so history shows you the same thing the record shows
you: field names, option labels, values rendered by type. Both `old_value` / `new_value` (the raw
stored values) and `old_display` / `new_display` (rendered for a human) come back, so you can have
either.

**Deleted fields and deleted options still render by name.** A field outliving the field is the
whole point of a change log, and a row that renders as a bare uuid because its column was removed
is exactly the moment you start doubting the history.

## Restoring

A previous version can be restored (`POST …/versions/{version}/restore`). The restore is itself a
change and appears in the log like any other, badged by whatever made it.

## Workspace-wide: the admin audit log

Everything above is scoped to one record. `GET /workspaces/{ws}/audit-log` (the MCP
`list_audit_log` tool) reads the **same** underlying data — admin-only, across every user and
every record in the workspace, filterable by actor, by one entity, and by date range (default: the
last 30 days).

- **No web page for this yet** — API and MCP only.
- **A removed member still appears by name** on their historical rows, the same no-FK design this
  whole page is built on.
- **Known, stated gap: structural deletions aren't captured.** Deleting a database, a view, or a
  space doesn't yet write a row here — only record-level create/update/delete/restore does. "Who
  deleted this record" is answerable today; "who deleted this database" isn't yet, and that's a
  named, separate piece of work, not an oversight quietly worked around.
