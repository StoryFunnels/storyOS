---
id: MN-109
title: Agentic OS — run_agent automations, Agents database, agentic packs
status: todo
depends_on: [MN-047, MN-076, MN-106]
size: XL
---

## Vision

Full design: [`docs/product/agentic-vision.md`](../docs/product/agentic-vision.md).
StoryOS is where a business lives; agents are how it runs. The MCP already lets a human
drive an agent against a workspace (assistive). This ticket builds **triggered** and
(later) **autonomous** agent workflows on top of the existing automations engine.

## Phased scope

**Phase A — `run_agent` automation action** (extends MN-047)
- New action type: run an AI agent with `{ prompt, tool_scope (MCP subset), target,
  model }` on a trigger (schedule / record event / button). The engine binds the MCP
  tools + a **scoped PAT** and runs the loop server-side.
- **Approval gate**: agent output is a set of proposed record changes surfaced in the
  inbox / on a button; a human approves or rejects (opt-in autonomy).
- **Run log**: inputs, tool calls, records touched, tokens/cost — per run, feeding the
  activity log + an observability view.
- Guardrails: allowed-action allowlist, step/cost caps, dry-run.

**Phase B — Agents as records (dogfood the model)**
- An **Agents / Workflows database** — each agent is a record (`name, goal, scope,
  schedule, enabled, last_run, run_log`), editable and templatable like anything else.

**Phase C — Agentic template packs**
- Ship flagship packs = databases + views + agents + schedules, one install. First:
  **Content Marketing Autopilot** (the founder's own job — sharpest demo), then Agency
  Client Ops and Sales Pipeline Copilot.

**Phase D — Autonomy + hosted model tier**
- Policy-bounded autonomous runs; hosted/metered model access (monetization, MN-107);
  inbound triggers (email/webhook → record) so agents have work to react to.

## Acceptance criteria (Phase A, the first shippable slice)
- [ ] `run_agent` action runs a scoped agent on a trigger and records a run log.
- [ ] Proposed changes require human approval before writing (configurable per agent).
- [ ] Guardrails enforced (scope, allowed actions, cost cap); everything audit-logged.
- [ ] One end-to-end demo: an agent advances a content record through a pipeline stage.
