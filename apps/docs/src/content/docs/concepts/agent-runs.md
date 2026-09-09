---
title: Agent runs
description: Every agent execution is an ordinary record in the Agentic OS space — status, live steps, and human approval gates you already watch through the Inbox.
sidebar:
  order: 16
---

Every time an agent runs, StoryOS provisions an **"Agentic OS" space** holding two databases —
**Agents** (what an agent is, its Goal and its scopes) and **Runs** (every execution). Both are
ordinary databases: you can open, filter, and sort them exactly like any other data, because
that's what they are.

## What a Run record shows

- **Status** — the run's current state, including **Waiting approval** for a run that's paused on
  a human decision.
- **Steps** — a live, human-readable log of what the run has done so far, rendered as rich text
  rather than raw tool-call JSON.
- **Input record** — the record the run was launched against, if it was launched against one.
- Which **agent** ran it, and its **Run class** (manual / automation / …), so a burst of automated
  runs doesn't read the same as one you triggered yourself.

## Human approval, through the Inbox you already watch

A run that needs a decision surfaces it in the **same Inbox** used for everything else that asks
for your attention — not a second, agent-specific approvals screen to remember to check. The
run's own record carries the staged action underneath (hidden from the record view by default,
since it's the machinery behind the readable Inbox card, not something you'd normally open the
record to read directly), so approving or rejecting from the Inbox is acting on the same run you
could also find and inspect in the Runs database.

## Giving an agent memory across sessions

An agent's context resets between runs — nothing it learned last time is available this time,
unless somewhere durable holds onto it. The same "it's just a database" principle behind Agents
and Runs is the recipe: a plain database, one row per fact, works because everything a database
already gives you — access grants, filtering, comments, an audit trail — applies to a saved fact
for free, rather than needing a bespoke memory store with its own viewer built from scratch.

**Shape that works well:** a short **title**, a rich-text **body**, a **type** (a small, closed
set — something like *Behavioral/Correction*, *Project state*, *Person/Agent context*, *Reference
pointer* — keeps facts scannable and stops "what currently is true" from being stored the same way
as "how to always act," since the first kind goes stale and the second mostly doesn't), a **scope**
relation to your Agents database (empty means shared workspace-wide; set to one agent means private
to it), and optional **origin** relations back to whatever record the fact came from — a ticket, a
document, another fact — so provenance is a real link, not a sentence claiming one.

**An agent's recall is one filter:** its own private facts, plus every shared one —
`{or: [{scope is_empty}, {scope has <this agent's record id>}]}` over `query_records`/MCP. No
bespoke query language, no separate recall endpoint.

**Write through the ordinary record tools — `create_record`, `update_record`, `delete_record`** —
so a fact is never a second write path with its own rules. The convention worth writing down
alongside the database itself: before saving a new fact, an agent should check whether a relevant
one already exists and **update or delete it rather than add a duplicate** — nothing in the schema
enforces this, so an unmaintained memory database silently turns into noise the same way any
unmaintained table does.

**Known limitation, honestly:** filtering by scope works for a handful of facts, but nothing here
adds full-text or keyword search — as the number of saved facts grows, finding the *right* one
may need more than a filter can offer. That's an open question this pattern doesn't answer, not a
solved one.

## Filtering and sorting like any other data

Because Agents and Runs are real databases, everything [views](/concepts/views/) already do —
filter by status, sort by start time, group a board by agent — works on your run history for free.
There's no separate agent-runs reporting surface to learn.
