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
- For an agent on **Your own AI**, a run stays **Queued** until a Runner finishes it. Run now, a
  delegation, a rule or a state change no longer ends such a run as Succeeded at once; see
  [Agents on your own AI](#agents-on-your-own-ai) and [What a Runner run records](#what-a-runner-run-records).

## Agents on your own AI

An agent whose **AI mode** is **Your own AI** is not run inside StoryOS. When something should wake
it, StoryOS puts a job in a queue (a **wake**) and a **Runner** picks it up. The Runner is a small
open-source program that runs on the agent owner's own computer and drives the owner's own AI tool,
on the owner's own subscription. StoryOS decides *when* the agent should look at a record; the
tool does the work, through StoryOS's tools, as that agent. At the time of writing, Claude Code is
the tool the Runner can drive. A Runner set to use Cursor claims nothing, and its jobs wait.

### What wakes an agent

| Reason | What happened |
|---|---|
| `assigned` | A record's agent field (such as *Next*) was set to the agent. This needs a binding for that field, made with `create_agent_trigger` and its `relation_field` option (an admin tool). |
| `state_change` | A record reached the state an existing state trigger watches. |
| `mention` | The agent was @-mentioned in a **comment**. A mention in a document or a rich-text field wakes nothing. |
| `automation` | An automation rule's **Run an agent** action ran, including one on a schedule. |
| `manual` | Someone used **Run now**, or delegated a record to the agent (`run_agent`, `delegate_to_agent`). |
| `approval_decided` | An approval the agent's own write had asked for was approved or rejected. The verdict is on the wake. |

A run that ends without commenting on its record can also be woken once more
([below](#when-a-run-ends-without-a-comment)); that wake's reason is `must_comment`.

**Who can wake an agent.** A wake is created only if the person whose action caused it can see both
the record and the agent, and the agent's owner can read the record too. The agent must be enabled,
on **Your own AI**, and its owner an active member. Content in a personal space never wakes anything.
When any of these fails, no wake is created.

**Repeats merge.** While a wake for the same agent and record is waiting or running, another event
joins it instead of making a second one: five comments in a minute, while the first is still waiting,
are one wake and one Run. The wake counts how many events merged, per reason. An event that arrives
while the job is running is not lost and does not start a second session alongside it: one fresh
wake follows when the first finishes.

**An agent can wake another agent**, by @-mentioning it in a comment it writes during a run. The
chain is cut at 2 hops. When a mention is not acted on because of that, the comment's response says so
in `agent_wakes[]` (`woken: false` with a message). A comment from an agent token that is not a Runner
run wakes nothing.

**A wake exists before the Runner does.** Every enabled Your-own-AI agent gets wakes even when it has
no Runner yet, so a count of "N waiting" is real. A wake that nobody picks up for **7 days** is
canceled, and its Run with it. Canceling a Queued or Running Run cancels its wake too.

### Where a wake stands

The API (`GET /workspaces/{ws}/agent-wakes`) and the MCP tool `list_agent_wakes` report one derived
`run_state` per wake. Read it as given rather than working it out from other fields:

| `run_state` | Meaning |
|---|---|
| `waiting_for_runner` | No Runner is assigned to the agent, or its Runner is not turned on. |
| `runner_offline` | The Runner has stopped checking in; the state carries since when. |
| `waiting_for_limit` | The tool's subscription limit was reached; the state carries until when, and which tool. |
| `waiting_for_turn` | The agent, or its Runner, is already working on another job; they take one at a time. |
| `running` | A Runner holds the job. |
| `needs_approval` | The Run is waiting for a person's approval. |
| `done`, `failed`, `canceled` | The job ended. |

`get_agent_wake_summary` returns counts instead: per agent, its Runner (null when none), whether it
can run, and how many wakes are waiting, plus the total waiting and how many enabled Your-own-AI
agents have no working Runner. Both tools list only wakes whose record and agent you can read; a
hidden one is neither shown nor counted. The Run's **Trigger** column has no value for `assigned`,
`mention` or `approval_decided`: those read *State change* (assigned) or *Manual* (the other two), and
the **Wake reason** field holds the real reason.

### The credential a run uses

When a Runner takes a job, StoryOS issues a credential for that one run. It acts as the agent
and nothing else:

- **Its reach is the smallest of three things:** the agent owner's role, the scopes the agent
  declares, and read-and-change. It is never admin. An agent that declares no scopes gets read only,
  and an agent owned by a guest gets no credential.
- **It is short-lived.** It ends when the run completes, is canceled, or the Runner stops renewing
  its 90-second lease, and a Runner removed from the workspace loses the credential of anything it held.
- **A person cannot create one**, and it does not appear in your list of API tokens.
- **Gated writes still wait for a person.** An approval gate, an agent's approval policy and the
  [outward-action rule](/concepts/approval-gates/#when-an-agents-write-fires-an-outward-action) all apply.
- **History names the run.** Changes it makes are badged `agent` and carry the run and the Runner;
  see [the audit log](/concepts/record-history/#when-the-agent-ran-on-a-runner).

## What a Runner run records

A Runner run fills these fields on its Run, in the **Runs** database. StoryOS writes them; an attempt
to write one directly is refused with a `422`:

| Field | Holds |
|---|---|
| **Wake reason** | The reason the job was created. |
| **Runner**, **Tool**, **Tool version** | The machine's name and the tool as they were at the time, so a later rename does not rewrite history. |
| **Exit** | *OK*, *Error*, *Limit reached*, *Aborted* or *Timeout*. |
| **Tokens in**, **Tokens out** | What the tool reported. |
| **Summary** | What the tool said it did, cut at 2,000 characters; a cut says how many were reported. |
| **Session id** | The tool's session id, when it gave one. |
| **Limit resumes at** | When a limit stop lets the run continue. |

The **Steps** log gets one line per attempt: what ended it, on which Runner and tool, and the tokens.

- **Tokens add up across the attempts of one Run** (a limit stop and its resume, a second attempt
  after a missing comment). When the tool reports none, the fields stay **empty**; StoryOS does not
  write a zero for "not reported". If one attempt reported and another did not, the total covers the
  reporting attempts and the Steps log says which attempt gave none.
- **A limit stop resumes by itself.** When the tool reports that its subscription limit was reached, the
  job returns to the queue, the Runner is paused, and the run continues at the time the tool gave.
  If the tool gave no time, or one already in the past, the retry is in 1 hour. A time more than 7
  days away is cut to 7 days. The Steps log says which of these happened, so the time shown is not
  presented as the tool's when it is not.
- **A Runner that stops answering loses its jobs back to the queue.** After three lost leases on one
  job it fails and the agent's owner is notified.

### When a run ends without a comment

An agent on a Runner is told to finish by commenting on its record. If a run on a record ends
**OK** with no comment from that run on the record, it is woken once more (reason `must_comment`,
the same job and the same Run). If it ends that way a second time, the Run fails and the agent's
owner gets a notification. This check applies to jobs that have a record and to runs that exit OK:
a run that ends in an error, a timeout or an abort is already a visible failure and is not woken
again for this.

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
