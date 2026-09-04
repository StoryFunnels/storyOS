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

## Filtering and sorting like any other data

Because Agents and Runs are real databases, everything [views](/concepts/views/) already do —
filter by status, sort by start time, group a board by agent — works on your run history for free.
There's no separate agent-runs reporting surface to learn.
