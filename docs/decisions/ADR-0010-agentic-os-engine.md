# ADR-0010: The agentic execution engine — defined agents, state triggers, runs & approvals

- **Status:** accepted
- **Date:** 2026-07-17
- **Source:** the "Agentic OS 2026" epic (Project #11) — MN-214 (agents as records), MN-215 (state-transition triggers), MN-216 (runs & approvals), MN-217 (the Architect). This ADR is the shared design those tickets and their decomposition build against.

## Context

Today an agent is something you **connect** — an external MCP client holding a PAT. Nothing inside the workspace *represents* an agent, so nothing in the workspace can run itself: every pipeline needs an outside orchestrator, and the only record of what an agent did is ordinary edit history.

The category bet (MN-109) is the inverse: an agent you **define** — a record with a goal, instructions, skills, allowed tools, a trigger, and a schedule — that the system runs on your behalf, shows its work, and pauses for your approval on the risky steps. Four tickets carry this, and they share enough mechanism that designing them separately would produce three incompatible half-engines. The forces:

- **BYO-AI must stay unmetered, by construction.** "Use your own AI, zero markup" is a public promise (MN-188): a run driven by the user's own model over MCP must be provably never counted. A run on managed StoryOS AI is metered. The engine cannot blur these.
- **Least privilege.** An agent must never act with more power than its owner (MN-134 token scopes).
- **Trust is the adoption bottleneck.** Users adopt autonomy gradually. They need to *see* every tool call and *approve* consequential actions **before** they happen — the website already sells "Approvals = the seatbelt."
- **State is the natural trigger.** The core loop is: record enters state S → agent runs with the record as context → writes back → advances or flags the state. This subsumes n8n-style "if X then Y" into the data model.
- **Reuse the plumbing we already have.** `activity_events` is already the transition outbox (ADR-0004, ADR-0008 webhooks), the Inbox already delivers notifications (#38), soft-delete already makes destructive record ops reversible.

The hard, genuinely missing primitive is an **execution runtime** — the thing that actually drives an LLM/tool loop. Everything else is data model and dispatch we can build on what exists.

## Decision

### 1. Agents and Runs are first-class records in system databases

Per workspace, two system-provided databases (like the existing system tables, not user-deletable):

- **Agents** — `name`, `goal`/`instructions` (rich text), `skills` (relation, once #40 lands), `allowed_tools` + `scopes` (a subset of MN-134 `read`/`write`/`admin`), `trigger` (`manual`/`state`/`schedule`), `target_databases`, `approval_policy` (which action classes require approval), `enabled`. Agent records **export/import** cleanly — they are what Business Packs (MN-218) bundle.
- **Runs** — `agent`, `trigger`, `input_record`, `status`, `run_class`, `cost`, timings, and a `steps` log (each tool call, with before/after diffs where cheap).

Making these records — not bespoke tables — means the whole product (views, filters, comments, permissions, export) works on agents and runs for free, and the Architect can build them through ordinary CRUD.

### 2. An agent runs as a constrained principal

Execution identity is a **scoped principal derived from the agent's owner, intersected with the agent's declared scopes** — never broader than either (MN-134). The same guard stack that gates a PAT gates an agent run. An agent with `write` scope can never call an `admin` route, regardless of its instructions.

### 3. A runtime seam, with classification at dispatch

The engine depends on an **`AgentRuntime` interface** (`execute(agent, context) → AsyncIterable<Step>`), not on any specific model. Two drivers implement it:

- **BYO-AI (MCP):** the user's own model drives the agent's tools over MCP. **Never metered, never counted** — this is enforced at the one place a run is classified: **dispatch stamps `run_class` on the Run record** (non-AI automation / your-own-AI / StoryOS AI, per MN-188) *before* any step executes. Your-own-AI is unmetered by construction, covered by a test.
- **Managed AI:** StoryOS's model; metered, decrements prepaid credits, records `cost`.

Manual runs and pure non-AI action steps work through this seam **without any LLM**, so MN-214's manual Run is shippable before the managed runtime exists.

### 4. Actions are staged, then applied — this is what makes approval and undo real

A step that would perform a **gated action** (per the agent's `approval_policy`: delete, outward webhook/email, `run_button`, or anything the owner marked) is **staged, not executed**. The run transitions to `waiting_approval`, the owner gets an Inbox item (#38) showing the *exact proposed action*, and:

- **Approve** → the staged action applies and the run resumes.
- **Reject** → the run cancels with **no side effects** (nothing was applied).

Because record deletes are soft (ADR-0009), applied destructive steps remain **undoable from the run view**. Superadmins see runs **cross-workspace with a kill-switch** (MN-104).

### 5. State transitions dispatch through the existing outbox, exactly once

A **binding** `(database, state, agent)` fires the agent when a record enters that state. Dispatch rides `activity_events` (already the transition record), keyed by the **transition event id** for **exactly-once** delivery; failures **retry with backoff** and land visibly in the Run as **dead-letter**. Two structural guards, both test-covered:

- **Loop protection:** an agent's own write that re-triggers its transition is bounded by a **per-record, per-agent cooldown** plus a **max-depth** counter carried in run lineage.
- **Human-gate states:** a state flagged `human_gate` never auto-fires an agent *out* of it — only a human move advances it. Checkpoints are first-class.

### 6. The Architect builds these records; it is not a second engine

MN-217 is a build-time client: from plain language it **proposes a plan** (entities, states, agents, gates), and **only after approval** creates them — reusing existing databases where sensible. Everything it builds is ordinary, hand-editable workspace config. It needs no engine privilege the CRUD API doesn't already expose.

### Sequencing

1. **Runtime seam** (the missing primitive) + **MN-214** agents database, scoped principal, **manual Run** (BYO/non-AI first).
2. **MN-216** Runs database, step log, **approval gates** (staging + Inbox), undo, superadmin.
3. **MN-215** state-transition **dispatch** (exactly-once, retry, loop protection, human gates, run-class at dispatch).
4. **MN-217** the Architect on top.

Prerequisites: MN-134 scopes (done), `activity_events` outbox + Inbox (done), MN-188 run classes (needed for metering — BYO path works without it), #40 skills (optional).

## Consequences

- **We reuse, not rebuild:** transitions ride `activity_events`, notifications ride the Inbox, reversibility rides soft-delete. The new surface area is the runtime seam, two system databases, the dispatcher, and the staging layer.
- **BYO-AI-is-free is a property of the code**, not a billing rule bolted on later — classification happens once, at dispatch, ahead of execution.
- **Staged actions** are the load-bearing idea: approval, reject-with-no-side-effects, and undo all fall out of "propose the action as data, apply it only on a gate pass."
- **The cost is the runtime and its sandboxing** — the genuinely hard, genuinely new part. The escape hatch is that manual runs and non-AI action steps are useful with zero LLM, so the data model and dispatch can land and be dogfooded before the managed runtime is trusted.
- **Rejected — an external orchestrator (n8n-style):** breaks the "the workspace runs itself" thesis, puts the pipeline's truth outside the data, and can't offer in-workspace approvals or run history. **Rejected — automations-only:** no agent identity, no least-privilege principal, no observability or approval ladder. **Rejected — bespoke per-agent code:** unshippable as a product primitive and impossible for the Architect to generate.
