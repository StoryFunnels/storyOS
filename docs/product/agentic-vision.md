# StoryOS as an Agentic Operating System for Business

> Status: **vision / planning**. The bet behind everything else. Companion ticket:
> [MN-109](../../tickets/MN-109-agentic-os.md).

## 1. The thesis

Most "AI in a work tool" is a chat box bolted onto the side. StoryOS is the opposite:
the workspace **is** the agent's operating environment. Your databases are its
long-term memory and its hands; the MCP ([MN-076](../../tickets/MN-076-mcp-server.md))
is already the read/write substrate. An agent doesn't "integrate with" StoryOS — it
**runs your business inside it**: reads the schema, queries state, creates and updates
records, links them, presses buttons, comments for humans, and leaves an audit trail.

The product we're building: **a business runs on structured data + repeatable
processes; agents operate that structure toward goals, with humans approving the
consequential moves.** StoryOS supplies the structure (databases, relations, views,
automations) and the guardrails; agents supply the labor.

Why we're positioned to win this specifically:
- **Stable, described schema** → agents don't hallucinate fields (api_names + live
  `describe_database` + server-side 422s that teach).
- **Everything is already an API** → the MCP is thin; new agent capability = new tool,
  not new plumbing.
- **Relations + rollups + formulas** → agents reason over connected data, not flat rows.
- **Automations + buttons + activity log** → the substrate for triggering agents and
  recording what they did.
- **Self-hostable + PAT-scoped** → an agent's blast radius is a token's access grants;
  enterprises can run the whole thing on their own box.

## 2. What an "agentic workflow" is here

A named, goal-directed agent run bound to a workspace:

```
Agent = { goal/prompt, scope (which databases + which grant), tools (MCP subset),
          trigger (schedule | record event | button | inbound), approval policy,
          run log }
```

Three interaction shapes, in order of trust:
1. **Assistive** (today, via MCP): a human drives Claude/ChatGPT against the workspace.
2. **Triggered** (next): an automation action "run agent" fires on an event/schedule;
   the agent proposes changes; a human approves via a button/notification.
3. **Autonomous** (later, gated): the agent acts within a policy (scope + cost cap +
   allowed actions), escalating only edge cases to a human.

The workspace is the memory. The MCP is the hands. Automations are the nervous system.
The activity log is the black box. Approval gates are the seatbelt.

## 3. Agentic workflows by business type

Concrete recurring workflows — each maps to databases we already template + an agent
loop. (★ = strong first demo.)

### Marketing / content (OWOX-style — the founder's own job) ★
- **Content pipeline autopilot**: idea → SERP/keyword research → brief → draft → SEO
  pass → editorial review → schedule. Agent moves records across the Board stages,
  fills briefs, drafts in the description, flags gaps; human approves each gate.
- **Backlog groomer**: dedupe ideas, cluster by topic, score by potential, propose the
  next N to write.
- **Competitor / SERP watch**: weekly scan → new rows in a "Signals" database with a
  digest comment.
- **Social repurposing**: published article → draft N platform posts into a Content
  Calendar with the 4:5 / square variants.
- **Weekly marketing report**: query the pipeline + calendar + campaigns → a Feed post
  / doc summarizing what shipped, what's stuck, what's next.

### Agency / client services (JCM) ★
- **Client onboarding**: new Client record → spins up the standard Projects/Tasks/
  Deliverables, drafts a kickoff doc, schedules the first milestones.
- **Status roll-up**: per client, roll up open tasks / at-risk deliverables → a status
  Feed the account lead skims each morning; auto-drafts the client update.
- **Meeting → action items**: transcript/notes doc → extracts tasks, assigns, links to
  the project.

### Sales / CRM
- **Lead triage + enrichment**: inbound lead → enrich, score, route, draft the first
  follow-up for approval.
- **Pipeline hygiene**: flag stale opportunities, missing next-steps, deals slipping.
- **Deal risk digest**: weekly summary of at-risk deals with the "why".

### Ops / product / PM
- **Standup digest**: what moved, what's blocked, what's due — posted to a Feed.
- **Sprint assist**: groom the backlog, estimate, propose a sprint from capacity.
- **Blocker escalation**: detect blocked > N days → notify + draft the unblock ask.

### Creators / authors
- **Publishing calendar**: keep the calendar full N weeks out; repurpose long-form.
- **Audience Q&A triage**: inbound questions → categorize, draft answers, route.

## 4. What we need to build to make this real (capability roadmap)

The MCP already unlocks shape #1. To reach #2 and #3:

1. **Agent runs as a first-class automation action** (extends
   [MN-047](../../tickets/MN-047-automations.md)): a new action `run_agent` — prompt +
   tool scope + target — triggered by schedule / record event / button. The engine
   calls a model with the MCP tools bound and a scoped token.
2. **Agents/Workflows database (dogfood our own model)**: agents are just records —
   `{ name, goal, scope, schedule, enabled, last_run, run_log }`. Editable like anything
   else; shippable as templates.
3. **Human-in-the-loop primitives**: "proposed changes" that a human approves/rejects
   (a diff surfaced in the inbox / on a button), so autonomy is opt-in per workflow.
4. **Run log + observability**: every agent action already flows through the API →
   activity log; add a per-run view (inputs, tool calls, records touched, cost).
5. **Guardrails**: per-agent scoped PAT (grants), allowed-action allowlist, cost/step
   caps, dry-run mode.
6. **Agentic template packs**: e.g. "Content Marketing Autopilot", "Agency Client Ops",
   "Sales Pipeline Copilot" = databases + views + the agents + schedules, one install.
7. **Hosted model access** (paid tier): so cloud users don't wire their own key; metered.
8. **Triggers in / out**: inbound email/webhook → record (intake for agents); outbound
   notify (Slack/email) so agents can reach humans where they are.

## 5. Monetization tie-in

Consistent with "capability is never paywalled": the **engine is open-source and
self-hostable** — bring your own model key and run agents for free. We monetize the
**managed agentic layer**: hosted model access (metered), hosted MCP endpoint,
prebuilt agentic packs, run observability, and support. See the pricing plan
([MN-107](../../tickets/MN-107-pricing.md)).

## 6. Sequencing

1. **Now**: MCP read+write (done) → assistive workflows work today (shape #1).
2. **Next**: `run_agent` automation action + Agents database + run log (shape #2,
   with approval gates). Ship one flagship pack — **Content Marketing Autopilot** —
   as the demo, because it's the founder's own job and the sharpest story.
3. **Then**: autonomy policies + guardrails + hosted model tier (shape #3) + more packs.

The whole company vision compresses to one sentence: **StoryOS is where your business
lives, and agents are how it runs.**
