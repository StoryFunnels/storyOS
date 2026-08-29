# Record history

Every field change on a record is logged: what changed, from what to what, who it was for, and
**what made the change**.

> **Where you can see this today.** The source label is recorded on every change and returned by
> `GET /workspaces/{ws}/databases/{db}/records/{rec}/versions/changes` (and by the MCP
> `get_history` tool). The record's in-app **activity panel does not show it yet** — it reads a
> different endpoint and renders only the actor and the field change. So this page describes an
> API-level field, not something you can currently read off the screen.

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

## Why it matters

Before this, every row said *human* — including rows written by automations and by MCP — because
the column existed and nothing ever wrote a non-default value. History that says everything was
typed is worse than history with no source column at all, because it reads as an answer.

## Where the label comes from

It is **derived from how the request authenticated**, never claimed by the caller:

- A browser session → `human`.
- The agent runtime → `agent`.
- The automation executor → `automation`.
- An API token → `agent` if the token was minted as an agent's, `mcp` otherwise.

That last one is the interesting case. The label lives on the **token row**, not in a request
header, precisely because a header is forgeable by any client — and provenance that its own
subject can claim is not provenance. Tyron mints a fresh, per-turn token marked as an agent's, so
Tyron's writes badge as **agent**, while still being attributed to the member who asked.

## One thing to know if you use the API

**An ordinary personal access token reads as `mcp`.** If you write records from your own script
with a PAT, those changes are badged `mcp` — not because they came from an MCP client, but because
an unmarked token is treated as one. The badge tells you a change came in over the API with a
token; it does not tell you which program held it.

`human` means a browser session and nothing else, so it is a reliable answer to "was a person at
the keyboard" — which is the question the badge exists to answer.

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
