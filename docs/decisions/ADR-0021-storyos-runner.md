# ADR-0021: The StoryOS Runner — an open-source worker that wakes hired agents inside the customer's own Claude Code or Cursor

- **Status:** proposed (2026-10-29). Needs Otto's review and Ievgen's approval **on ticket #1128** before any Runner build ticket moves to ToDo. The open questions at the end have a recommendation each. **Rulings so far (Otto, 2026-10-29, on ticket #1128):** questions 1, 4, 5, 6, 8, 10 and 11 are accepted as recommended and are folded in below. Questions 2, 3, 7 and 9 are still with Ievgen, so this stays **proposed**. §11 (the app-facing API) was added the same day at Otto's request. His second round of rulings (confirmed: owner-only Runners, derived `offline_since`, chosen tool per Runner, no server hire; confirmed on a condition: wakes for Runner-less agents; changed: **v1 is Runner-only, the API-key option is hidden until a workspace's own-key connection exists**; overruled in part: **an unactivated pending Runner expires inside the 10-minute pairing window**) is folded in below.
- **Ticket:** #1128 (ADR first), epic "StoryOS Runner: hired agents run on your own subscription". Design input: Dara's prototype v42 and her comment on ticket #1129.
- **Builds on:** [ADR-0010](ADR-0010-agentic-os-engine.md) (agents, runs, approvals, the runtime seam), [ADR-0016](ADR-0016-tyron-conversational-runtime.md) (a short-lived member-scoped token per turn; actor = the member, `source` = `agent`), [ADR-0007](ADR-0007-access-grants.md) (grants), [ADR-0017](ADR-0017-members-people-model.md) (who a person is).
- **Supersedes:** nothing. **Amends:** nothing. Where this ADR finds a gap in an earlier one it says so and does not edit it.
- **Not decided here:** the licence, the contributor terms and the tools' own subscription terms. Those are flagged in §9 and Open question 7 for Ievgen and legal. Nothing in this ADR is code or a migration.

Paths are repo-relative. `api/` means `apps/api/src/` and `mcp/` means `packages/mcp/src/`. Every `file:line` below was checked against `origin/main` at `2f587feb` on 2026-10-29. Where something could not be checked it says **not verified**.

## Context

Ievgen's direction (2026-10-29): hired StoryOS agents should be able to run on the customer's own machine, inside the customer's own Claude Code or Cursor, on the customer's own subscription. The server never holds a model key for those agents, so there is no per-token cost to StoryOS and none to the customer beyond the plan they already pay for. The piece that does this is a small program the customer installs, **the Runner**. It is open source (Apache-2.0), and the hosted server stays AGPL.

Today an agent can be driven three ways, and none of them is "wake the customer's own Claude Code":

- **Not at all.** `non_ai`: a deterministic dry run (`api/agents/agent-runtime.ts:223`).
- **By StoryOS's model.** `storyos_ai`: metered, bounded, one-shot completions only (`api/agents/managed-ai-client.ts:3-13` says in so many words that it is not a tool loop).
- **By the person's own AI, by hand.** `your_own_ai`: "the user's model drives the tools over MCP. NEVER metered" (`api/agents/agent-runtime.ts:106-109`). The runtime is a handoff page, not an executor: it yields a step log that tells the connected AI what the agent's goal and scope are and then stops (`api/agents/agent-runtime.ts:276-300`). Nothing wakes that AI. A person has to open their client and ask.

The Runner is the missing half of `your_own_ai`: the thing that opens the client for them, when there is work. That is why this ADR reuses the run class instead of adding a fourth. ADR-0010 §3's guarantee ("your own AI is never metered, classified at dispatch") then holds for Runner runs with no new rule.

What is true on `origin/main` today (premise check, posted on ticket #1128):

- **No Runner work exists.** No pairing, heartbeat, long-poll, runner token or wake queue anywhere in `apps`, `packages`, `docs`, `scripts` or `.github`. No open PR touches `docs/decisions` or `apps/api/drizzle`.
- **Agents, Runs and Agent Triggers are system databases** provisioned per workspace (`api/agents/agents.service.ts:283-300`, `:714-717`). A Run's statuses already include **Queued**, Running, Waiting approval, Succeeded, Failed, Canceled (`api/agents/agents.service.ts:572-577`), and its run class is stamped at dispatch before anything executes (`api/agents/agents.service.ts:1127-1128`, `:1179`).
- **An agent token already exists.** `api_tokens.agent_id` + `origin = 'agent'` (`api/db/schema.ts:853`, `:865`); the guard re-resolves the agent's *current* owner on every request and refuses if there is none (`api/auth/auth.guard.ts:193-200`, `api/agents/agent-identity.ts:30-54`); its `source` comes from the token row, not a header (`api/auth/auth.guard.ts:237`). Writes stamp `agent_id` and a snapshot of `agent_name` on `activity_events`, `record_versions`, `record_field_changes` and `comments` (`api/db/schema.ts:713-714`, `:1236-1243`, `:1288-1289`, `:1345-1347`).
- **The principal is already `min(owner's scope, agent's declared scope)`** (`api/agents/agent-principal.ts:27-31`, `:49-69`).
- **Gated writes are already held for approval, per agent** (#1104: `api/action-gates/agent-write-gates.service.ts:12`, `:88`), and an approval can only be decided by a person (`api/auth/assert-human-source.ts:13-18`).
- **A durable claim loop already exists** for server-side jobs: `FOR UPDATE SKIP LOCKED` plus a reaper that returns stuck rows to the queue (`api/automations/job-runner.service.ts:109`, `:213-245`).
- **A published open package and its release workflow already exist**: `@storyos/mcp` (`.github/workflows/npm-publish.yml:3-9`, `:28`), with a precedent for "tell the client it is behind" (`mcp/schema-version.ts:1-25`).

And four things the build tickets assume that are **not** true today. They are the reason this ADR is not a formality, and each is answered below:

1. **"Assignee set to an agent" has no place to live.** `Issues.Assignee` is a `user` field holding a person's user id; agents are records in the Agents database, not users (ADR-0017; assignees are bare user ids). Only `Next` is a relation to Agents, and `Next` is a workspace-defined field, not a built-in. (§1, Open question 1.)
2. **An agent cannot be @-mentioned.** Mentions know two kinds, `user` and `record` (`api/mentions/mentions.service.ts:21`, `:33-36`), and creating a comment emits no domain event (`api/events/domain-events.service.ts:4` lists four record event types, none for comments). (§1.)
3. **The credential has no expiry and no run.** `api_tokens` has no `expires_at`, `run_id` or `runner_id` (`api/db/schema.ts:822-877`). A comment in `api/agents/tyron/tyron.service.ts:361` says a stranded token "expires"; I found no expiry mechanism for it to rely on. (§4.)
4. **There is no "hire".** No code on `main` mentions hiring an agent. The hire card in Dara's design is new on the server side as well as in the web app. (§3, build-order check.)

## Decision

### 1. The wake queue

**Decision.** A **wake** is a durable row meaning "this agent should look at this record now, for this reason". It is not the run and it carries no record text. One table, `agent_wakes`, separate from `automation_jobs`.

```
agent_wakes
  id, workspace_id, agent_id (no FK: agents are soft-deletable records, as api_tokens.agent_id)
  record_id, database_id            nullable together (a schedule wake has no record)
  reason        assigned | mention | schedule | manual | approval_decided | must_comment | retry
  requested_by  the user whose action caused it (for the access check; null for a schedule)
  source_key    UNIQUE — idempotency, built from the event id (comment id, link event, approval id)
  depth         loop-guard depth carried from the cause (see below)
  status        queued | claimed | done | failed | canceled
  runner_id, claim_nonce, lease_expires_at, attempts, not_before
  rewake        bool — a repeat arrived while this one was claimed
  run_id        the Run record this wake produces (created at enqueue, status Queued)
  reasons       jsonb, the distinct reasons merged into this wake, with counts
```

**Which events wake an agent**, each tied to the thing that already exists or the thing that does not:

| Source | Mechanism | Exists today? |
|---|---|---|
| State change | The existing binding `(database, state field, state option, agent)`. `trigger.subscriber.ts` keeps its logic: transition-not-resave (`api/agents/trigger.subscriber.ts:117-119`), human gate (`:111`), enabled agent (`:148`), owner still a member (`:150-158`). Only the last step changes: for an agent whose `AI mode` is `Your own AI` it enqueues a wake instead of calling `dispatchRun` (`:171-183`); see §11 for why this is not limited to agents that already have a Runner. | Yes, reused |
| Assigned (relation) | A new binding kind on the same Agent Triggers database: *"when relation field F on database D links to this agent"*. It fires on the existing `record_linked` domain event, which already carries `relationFieldId` and `linkDirection` (`api/events/domain-events.service.ts:26`, `:45`); only `link` fires. This is how `Issues.Next` wakes an agent, and **it is the only way an agent is woken by assigning a record in v1** (ruling on Q1: an agent as an assignee or in the people picker is deferred to its own ticket; #1130 drops "Assignee"). | Event: yes. Binding kind: **new** |
| @-mention | A third mention kind `agent`, parsed beside `user` and `record` (`api/mentions/mentions.service.ts:33-36`), and a wake emitted from the comment write path (`api/comments/comments.service.ts:243-307`) at **emit time**. | **New** |
| Schedule | An automation rule's `run_agent` action (`api/agents/agents.service.ts:363-368` records that this is how a schedule runs; the action is `api/automations/actions.service.ts:815`). The executor enqueues a wake for a Runner-assigned agent. | Yes, reused |
| Manual | `POST …/agents/:agent/run` and `…/delegate` (`api/agents/agents.controller.ts:84`, `:97`; MCP `run_agent`, `delegate_to_agent`, `mcp/tools.ts:800-801`). | Yes, reused |
| Approval decided | When a held agent write or a parked run is approved or rejected (`api/agents/agents.controller.ts:114`, `:128`; `api/automations/approvals.controller.ts:73`), a wake with `reason = approval_decided` and the decision in its context. | Decision path: yes. Wake: **new** |

**Coalescing and "one run per agent and record at a time".** A partial unique index on `(agent_id, record_id) WHERE status IN ('queued','claimed')` makes the second wake for the same pair an `INSERT … ON CONFLICT DO UPDATE` that bumps a counter and merges `reasons`. Five comments in a minute are one run that sees five comments, not five runs. If the matching wake is already **claimed**, the repeat sets `rewake = true` and the completion of the running wake enqueues one fresh wake, so a comment that lands mid-run is never lost and never runs concurrently with the run it follows. A schedule or manual wake with no record coalesces on `(agent_id) WHERE record_id IS NULL`.

**Loop guards carry over.** ADR-0010 §5's max depth of 2 (`api/agents/trigger.subscriber.ts:13`) applies to every source: a wake carries `depth`; a write made under a run credential (§4) emits events with `depth + 1`, and a comment an agent writes that mentions another agent is such a write. The in-memory per-record cooldown (`:42`, `:160-166`) does not survive a restart and is not shared between replicas; for Runner-assigned agents the durable coalescing above replaces it.

**Access, and what a wake may leak.** A wake is created only if the person whose action caused it can read the record, and only if the agent's **owner** can too, because the agent acts as its owner (`api/agents/agent-identity.ts:30-54`). The check is `effectiveForDatabase`, which returns null instead of throwing (CLAUDE.md, "Where a view lives"). When it fails, nothing is created and the response is the one a non-existent id gets (the 404 convention, `api/tokens/tokens.service.ts:92-93`). Content in a personal space, and a private thread, **never wakes**: suppression is at emit time, not a read-time filter (CLAUDE.md, Personal space; ADR-0016 §6). A guest-authored mention wakes nothing unless the guest could read the record and the agent (ADR-0007).

**Alternative considered: reuse `automation_jobs`.** Rejected. Its claim loop (`api/automations/job-runner.service.ts:233-245`) claims *every* `queued` row in the process and runs it through an executor registry (`api/db/schema.ts:1976` indexes `(status, next_attempt_at)` for exactly that), so a wake row there would be executed by the server. Its reaper's clock is the row's own `timeoutClass` (`api/automations/job-runner.service.ts:213-232`), not a lease held by a remote party. We reuse the **pattern** (idempotency key, `SKIP LOCKED`, reaper), not the table.

**Alternative considered: one wake per event.** Rejected: it multiplies runs and burns the customer's subscription on duplicates.

**Where the wake is created, honestly.** The state-change subscriber listens on the in-process event bus (`api/agents/trigger.subscriber.ts:31-35`, `:56-58`), not on the `activity_events` outbox that ADR-0010 §5 describes. A crash between commit and enqueue therefore loses the wake, exactly as it loses a state-change agent run today. `source_key` makes a *replay* safe; it does not make the *first* delivery durable. See Open question 8.

### 2. The claim protocol

**Decision.** Outbound only. The Runner makes HTTPS requests to the StoryOS API and never accepts one: no inbound port, works behind NAT, works through a corporate proxy.

- `POST /runner/v1/claim` is a **long poll**. The Runner says how many wakes it can take (its local concurrency, default 1, #1134). The server holds the request up to ~25 s and answers with 0..N claimed wakes (each with its lease and a run credential, §4) or `204`.
- **The claim is atomic**, in the shape `job-runner.service.ts` already uses: one `UPDATE … WHERE id IN (SELECT … WHERE status = 'queued' AND eligible FOR UPDATE SKIP LOCKED LIMIT n) RETURNING` that sets `status = 'claimed'`, `runner_id`, a fresh `claim_nonce` and `lease_expires_at = now() + 90 s`. A second concurrent claim gets none of the same rows. A claim by a runner that does not own the agent gets nothing, with the same empty answer.
- **Eligible** means: the Runner is `active`, not revoked and not paused (`paused_until`, #1137); the agent is assigned to this Runner, is enabled and not budget-paused (#1138); the agent's owner is still an active member (`api/agents/trigger.subscriber.ts:148-158`); `not_before` has passed.
- **The lease.** The Runner renews it every 30 s with `POST /runner/v1/wakes/:id/heartbeat` (carrying the nonce); each renewal pushes `lease_expires_at` forward and doubles as the Runner's liveness signal (§3). A hard ceiling (30 min per run, recommended) stops a session that heartbeats forever.
- **A lost lease.** The reaper returns an expired `claimed` wake to `queued` with `attempts + 1`. After 3 attempts it becomes `failed`, the Run record says "the Runner stopped answering", and the agent's owner is told once. The Runner that lost it learns on its next call: `409 lease_lost`. It must **kill the session** and discard the result.
- **The fence is the credential, not the nonce.** A stale Runner could still hold a live session making tool calls. So the run credential is revoked the moment the lease expires (§4); its next MCP call is a 401. A nonce alone could not stop a session already running.
- **Completion.** `POST /runner/v1/wakes/:id/complete` with the adapter result (§5). It is idempotent on `(id, claim_nonce)`: a retry after a dropped response returns the same answer. It writes the Run record, revokes the credential, sets `done`, and enqueues the rewake if one is pending.
- **Delivery is at-least-once, not exactly-once.** After a lost lease the same wake can run twice. The record and its comments are the agent's memory (§6), so the second run sees what the first already did; the must-comment backstop (#1133) catches the rest. This is stated rather than promised away.

**Alternative considered: WebSocket.** Deferred, not rejected. It gives lower wake-to-start latency, but it needs sticky connections, proxy upgrade support and reconnect state, and it adds a second protocol to version. A 25 s long poll is plain HTTPS, loses nothing a user can feel for a work queue, and the wake-to-start time is a number #1141 measures. If dogfood shows it matters, a WebSocket carrying the same messages is a transport swap, not a redesign.

**Alternative considered: the Runner polls MCP or a records view for "my work".** Rejected: it has no atomic claim, no lease and no coalescing, so two Runners would double-run.

### 3. Registering a Runner: pairing, the runner token, heartbeat, offline

**Pairing (Dara's design, kept as designed).** In the app, **Add a Runner** shows a **6-character, single-use code that lives about 10 minutes**; `npx @storyos/runner` asks for it; the person types it; the Runner exchanges it for a runner token. No password and no pasted token.

- The code is issued only to a **signed-in session** (the `SESSION_ONLY` rule, `api/auth/auth.guard.ts:130-132`), never to a token or an AI connection, and never to a **guest** (guests cannot create a PAT, `api/tokens/tokens.service.ts:28-36`; a Runner credential is at least that powerful).
- Stored hashed; 6 characters from an unambiguous alphabet (no 0/O, 1/I/L); exchange is rate-limited per IP and capped at a small number of wrong guesses before the code is burned.
- The exchange creates a Runner row `status = pending` and a token, **and that pending Runner expires with the pairing window**: if the person has not pressed Done 10 minutes after the code was issued (they pressed Cancel, or closed the tab, or walked away), the same sweeper that marks Runners offline (§3, below) revokes it and its token. There is no longer-lived "connected but not turned on" state to draw or to leave lying around. **The token does nothing until the person presses Done in step 3 of Dara's flow** ("connected; it found Claude Code and Cursor; which should agents use?"). That existing confirm becomes the activation. A stranger who guesses a live code gets a pending token and the real person sees an unexpected "connected" in the app. This adds no screen to Dara's design; it gives one of her existing buttons a security job. See Open question 4.

**The runner token is not a PAT.** `mn_pat_…` tokens are accepted by the general guard on every workspace route (`api/auth/auth.guard.ts:181`). A runner token (`mn_run_…`) is a separate credential, stored in its own `runners` table, accepted by a separate guard, **valid only on `/runner/v1/*`**, and refused everywhere else. A leaked runner token cannot read a record. What it can do is claim wakes for its own agents and thereby obtain run credentials (§4), so the damage is bounded by the agents assigned to that Runner, and revoking the Runner ends it.

```
runners
  id, workspace_id, user_id (the person whose machine/subscription), name (machine name, as reported — unverified)
  token_hash, token_prefix
  status        pending | active | revoked
  tools         jsonb, what the Runner detected: claude-code / cursor, versions, capabilities (§5)
  runner_version, protocol_version
  last_seen_at, offline_notified_at, paused_until, pause_reason
```

**Agent → Runner assignment** ("Runs on …" in the design) is a row in a small `runner_agents(agent_id UNIQUE, runner_id)` table, **not a field on the Agent record**. Routing an agent's instructions to a particular computer is a security decision; a record field can be edited by anyone who can edit the Agents database. Setting it is an act of the agent's owner (or an admin). An agent in `Your own AI` mode with no assignment is not run by anything: its wakes wait (§11), which is exactly the hire card's "You can hire it now; it starts work once it has a Runner" (the "or an API key" half of Dara's sentence is out of v1, §11). Agents in `Non-AI` and `StoryOS AI` mode keep today's behaviour.

**Who may assign what to whom.** In v1 an agent may be assigned only to a Runner **owned by the agent's own owner**. The agent reads records as its owner and its prompts, tool results and record text then pass through that person's machine and model account; assigning it to a colleague's Runner would hand the colleague data they might not be allowed to read. See Open question 2.

**Heartbeat and offline.** Every claim poll and every lease heartbeat sets `last_seen_at` (throttled to one write a minute, the way `api_tokens.last_used_at` is, `api/tokens/tokens.service.ts:217`). A sweeper marks a Runner **offline** when `last_seen_at` is older than 120 s. The agents it runs then show "Runner offline since 18:40" (derived, nothing stored per agent) and **each agent's owner is notified once per offline episode**: `offline_notified_at` is set on the notification and cleared on return, and the notification goes through `NotificationsService.notify` (`api/notifications/notifications.service.ts:160`). Waiting wakes stay queued and are claimed when the Runner returns. **A laptop that sleeps is offline.** That is correct and the UI says so; "agents work overnight" needs an always-on machine (guide, #1134).

**Revoke.** Removing a Runner sets `revoked`, returns its claimed wakes to the queue, revokes every live run credential minted for it, and refuses its token on the next call. Nothing the Runner already wrote is deleted: the audit trail names the Runner that did it, and the row stays.

**Alternative considered: RFC 8628 device authorization** (the Runner shows the code, the person types it in the app). It is the standard shape and a better fit against a guessing attack, because the code is displayed by the thing that asks for the credential. Dara's flow runs the other way and her ticket (#1129) fixes it as the design; the pending-until-Done activation above closes the same hole without redrawing it. If Ievgen prefers the standard flow, nothing else in this ADR changes.

### 4. Identity: one short-lived credential per run, acting as the agent

**Decision.** At claim, the **server** mints a run credential. The Runner never chooses its scope, never mints, never keeps it past the run. The session uses it for StoryOS's MCP tools. It is the existing agent token, with three additions, not a new kind of credential.

What is reused, unchanged:

- `TokensService.create` already mints a token for an Agent record, requires the minter to be that agent's owner or an admin, and writes `origin = 'agent'`, `agent_id` (`api/tokens/tokens.service.ts:38-90`, `:117-134`). The Runner path calls the same check server-side (`resolveAgentIdentity`, `api/agents/agent-identity.ts:30-54`) instead of a session minting it.
- The guard re-resolves the agent's current owner on every request, so a credential outlives neither the agent nor its owner's membership (`api/auth/auth.guard.ts:193-200`).
- **`actor` = the agent's owner, `source` = `agent`**, both always (ADR-0016 §3; CLAUDE.md). The owner is `effectiveUserId` (`api/auth/auth.guard.ts:199`). `source` comes from the token row `origin`, **not a header** (`api/auth/auth.guard.ts:237`; `api/db/schema.ts:845-847` explains why a header would be forgeable). The Runner sends no provenance header and the server would ignore one.
- Scope is `deriveAgentPrincipal(owner scope, agent's declared scopes)` (`api/agents/agent-principal.ts:49-69`): never above the owner's role, never above what the agent declares, `read` if it declares nothing.

What is **new**, and is the content of #1132:

1. `api_tokens.expires_at`, and the guard and `resolve()` refuse a token past it (`api/tokens/tokens.service.ts:196-233`). The expiry **slides with the lease** (90 s past the last heartbeat) and is hard-revoked at completion, lease loss, Runner revoke and agent disable. The session holds a fixed token string; only the server-side expiry moves.
2. `api_tokens.run_id` and `api_tokens.runner_id`, and the same two ids (plus a `runner_name` snapshot, for the reason `agent_name` is a snapshot, `api/db/schema.ts:1243`) stamped next to `agent_id` on `activity_events`, `record_versions`, `record_field_changes` and `comments`. The audit line then reads **"Sales assistant · run 42 · Ievgen's MacBook"**: the agent's name from the snapshot, the run's public number from `run_id`, the machine from `runner_name`. Today those four tables carry the agent and no run.
3. The per-run credential is **filtered out of "my tokens"** (`api/tokens/tokens.service.ts:146-164` filters on user and revocation only). ADR-0016 §2 says agent-issued tokens are excluded from the person's list; the code on `main` does not implement that, so #1132 must.

This reconciles the **#652 lesson** ("every action looked like Ievgen's") with the **CLAUDE.md rule** (actor = the member): the `actor` column stays the agent's owner, who is the accountable person and is what already exists; the *displayed* attribution leads with the agent, the run and the Runner. The Runner's person never appears unless they are also the owner. #1132's wording ("never as the person whose subscription runs it") is satisfied when the Runner's person *is* the owner only because the actor column is not the label. Open question 5 asks Otto and Ievgen to confirm that is the intended reading.

**The credential's reach, and a cap.** An admin-owned agent that declares `admin` would get an admin-scoped credential, and every route under `@MinRole('admin')` then needs only that scope (`api/auth/auth.guard.ts:36-41`; `api/agents/agents.controller.ts:46` is one such controller: `run`, `delegate`, `triggers`). Recommendation: **cap a Runner run credential at `write`**. An agent on someone's laptop that can also create webhooks, edit grants and spawn other agents is the exact "delegation widens its own blast radius" that ADR-0010 and the #441 exclusion exist to prevent (`docs/architecture/restricted-access-inventory.md:261`). Open question 3.

### 5. The adapter contract

**Decision.** One adapter per tool, inside the Runner package, behind one interface. The Runner owns the claim loop, the lease, the folders and the reporting; an adapter owns **only** "run the tool once, for this wake, and say what happened".

```ts
interface RunnerAdapter {
  readonly id: 'claude-code' | 'cursor' | 'codex' | 'local-openai';
  /** Is the tool installed, logged in, and what can it do? Never throws. */
  detect(): Promise<{ installed: boolean; version?: string; loggedIn?: boolean; capabilities: Capabilities }>;
  execute(wake: WakeContext, signal: AbortSignal): Promise<AdapterResult>;
}

interface WakeContext {
  wakeId: string; runId: string; reason: WakeReason; depth: number;
  agent: { id: string; name: string; instructions: string; skills: string[]; role: string; targetDatabases?: string };
  record?: { id: string; databaseId: string; ref: string };   // an id and a reference, never the record's text
  mcp: { url: string; token: string };                         // the run credential (§4)
  workdir: string;                                             // the per-agent folder (§6)
  allowedNativeTools: string[];                                // §7, empty by default
  protocol: number;
}

interface AdapterResult {
  exit: 'ok' | 'error' | 'limit_reached' | 'aborted' | 'timeout';
  usage: { tokensIn: number; tokensOut: number } | null;       // null = the tool did not report it. NEVER zero-filled
  sessionId?: string;
  summary: string;                                             // capped, truncation says so
  limitReachedUntil?: string;                                  // ISO time, only when exit = 'limit_reached'
  error?: string;
  toolVersion: string;
}

interface Capabilities {
  usageReporting: 'full' | 'partial' | 'none';
  limitDetection: boolean;
  nativeToolAllowlist: 'enforced' | 'advisory' | 'none';
  mcpInjection: boolean;
  headless: boolean;
}
```

**Rules that make the contract honest:**

- **`usage` is `null` when the tool did not say.** Never `0`. A zero is a quantity and the most dangerous one (CLAUDE.md, Tyron rules). Budgets (#1138) and the sharing reserve (#1137) must read `null` as "not measurable" and **say so on the Runners page**, which is #1137's AC3.
- **Gaps are reported, not faked** (#1136 AC3). `Capabilities` is what the Runner shows on the Runners page and in the docs. An adapter that cannot enforce a tool allowlist says `advisory` or `none`, and the Runner refuses to run an agent whose role requires an allowlist the adapter cannot enforce.
- **No record text in `WakeContext`.** The agent reads the record and its comments through MCP under the run credential, which is also where the access check lives. One source of truth, no copy that goes stale between claim and start. This does **not** make injection impossible (a tool result is also text a model can obey); §7 says what actually holds.

**The Claude Code adapter** (#1135) maps onto the installed CLI. These flags were **checked against `claude --help` on this machine (2.1.104)**: `-p/--print`, `--output-format json|stream-json`, `--mcp-config` with `--strict-mcp-config` (so the session sees only the StoryOS server and not the person's other MCP servers), `--allowedTools` / `--disallowedTools`, `--permission-mode`, `--session-id <uuid>`, `--resume`, `--no-session-persistence`, `--add-dir`, `--append-system-prompt`, `--bare`. Two facts from that help text matter: `-p` **skips the workspace-trust dialog**, so the Runner must be the one that chooses the folder; and there is **no `--max-turns`** in 2.1.104, so a runaway session is bounded by the Runner's timeout, not by the tool. **Not verified here:** the exact shape of the JSON result, which fields carry token usage, and how a subscription limit presents. #1135's first act is to run it and quote it.

**The Cursor adapter** (#1136): **not verified at all** (`cursor-agent` is not installed on this machine). The contract above deliberately assumes nothing about it. #1136's premise check decides which `Capabilities` it can claim.

**Codex (#1142) and local AI apps (#1143), as an extension, not a second contract.** LM Studio and Ollama serve a model, not an agent, so the `local-openai` adapter needs the Runner's own small loop: a bounded tool loop against the app's OpenAI-compatible endpoint, calling StoryOS's MCP tools with the run credential. It implements the *same* `execute`. The loop must carry ADR-0016 §4's ceilings (tool calls per turn, turns per thread; bug guards, not prices) and CLAUDE.md's rule that tool results are capped and **say so** in the text the model reads, because a small model that silently loses half a result produces confident wrong answers. The grounding rule ("a quantity about workspace data must come from a tool call this turn", `api/agents/tyron/grounding.ts`) lives in the AGPL API; the Apache Runner may not import it (§9), so either the rule is re-implemented in the Runner's loop or the server enforces it. This ADR recommends re-implementing the small ceiling set and leaving grounding to the server-side tools (counts come from `count_records`, never from the model). Small local models and long tool chains are a known weak spot and #1143's docs say which tasks to avoid.

### 6. The session model

**Decision.** **A fresh headless session per wake. The record and its comments are the memory.** The session id is stored on the Run record for diagnosis, not for resuming.

- Each wake starts with: the agent's current instructions and skills (resolved when the wake *starts*, the way skills already are, `api/agents/agent-runtime.ts:135-163`, so an edit to the agent applies to the next wake), the wake reason, and one record reference.
- The agent works through MCP, **comments on the record with what it did or why it stopped**, and hands off by changing the record's state or `Next`. That comment is also the human-visible trail (`delegate_to_agent` already works this way: it "posts its outcome back ON the record as a comment, with a link to the full Run", `mcp/tools.ts:6251-6262`).
- **Per-agent working folder:** `<runner home>/agents/<workspace id>/<agent id>/`. The Runner writes the instructions file into it at the start of each wake and clears its scratch subfolder at the end. It is the session's working directory and the only directory it is given (`--add-dir` is not used to widen it).
- **The must-comment backstop** (#1133) lives server-side: a run that ends without a comment on its record is re-woken once with `reason = must_comment`, then failed visibly and its owner told.

**Alternative considered: resume a session per record.** Rejected. A resumed session carries yesterday's context and yesterday's injected text; it burns subscription on re-reading; it hides the agent's memory inside one machine, so moving the agent to another Runner or reading what it did becomes impossible; and it makes "what did the agent know when it acted" unanswerable from StoryOS. StoryOS is the system of record. A wake that needs more continuity should write it onto the record.

### 7. The security model

**What a runner token can and cannot do.** Can: claim wakes for agents assigned to its own Runner, heartbeat, complete. Cannot: call any `/workspaces/:ws/*` route, read a record, pair or revoke a Runner, see another Runner's wakes, claim for a disabled or ownerless agent, or work in another workspace. A guest cannot pair one.

**What a run credential can and cannot do.** It is the existing agent token (§4), so every guard on a PAT applies: the scope ceiling (`api/auth/auth.guard.ts:121-146`), the admin-role rule (`:36-41`), account-level routes refused (`:130-132`), per-database access for a guest owner, and the `read` scope a guest's role derives (`api/agents/agent-principal.ts:27-31`). Specifically:

- It **cannot approve or reject anything.** `assertHumanSource` refuses any non-`human` source (`api/auth/assert-human-source.ts:13-18`); a run credential's source is `agent`. MCP exposes no approve tool at all (`:10-12`). #1132 adds a test that a run credential gets 403 on every approval route.
- It **cannot pair a Runner, mint a credential, or change who may do what.** Those routes are session-only or admin, and MCP has no grants/invites/members tools at any scope (`docs/architecture/restricted-access-inventory.md:261`).
- Its writes are **held for approval** where the manager declared a gate (#1104: `api/action-gates/agent-write-gates.service.ts:88`), because the gate keys on `source = 'agent'` plus the agent id.

**What is NOT verified, and is a precondition for #1135.** The per-agent write gate holds `create` and `update` (`api/action-gates/agent-write-gates.service.ts:12`); deletes have their own workspace gate (#542); the agent's `approval_policy` of delete / webhook / email / run_button / outward (`api/agents/agents.service.ts:508-512`) is checked where a run *stages* a proposed action (`api/agents/agents.service.ts:1062-1081`, `:1646-1700`), which is the path a server-run agent takes. A Runner-driven agent calls MCP tools directly and never goes through staging. **I have not verified that every MCP tool that has an outward effect (send email or Slack, run a button, create or test an automation with an `http_request` or webhook action, post to social) is either gated or unreachable for a credential with `source = 'agent'` at `write` scope.** #1135 must produce that list, tool by tool, against `mcp/tools.ts`, and a failing entry blocks the adapter. "Anything outward still goes through StoryOS approvals" (#1128) is true only if that list is clean.

**The risk that is new, and is on the customer's machine, not ours.** A headless session in a folder, driven by text that other people wrote (a comment, a record, a form submission), with a shell tool available, is remote code execution by prompt injection. The defences are in code and in config, never in the prompt (CLAUDE.md: "the system prompt is not a mechanism"):

1. **Native tools are off by default.** The Claude Code session is given only the StoryOS MCP server (`--strict-mcp-config`) and an `--allowedTools` list that names its tools, with no `Bash`, no file write outside the folder, no web fetch. Enabling a native tool is a per-agent choice by the manager, shown on the Runners page as "This agent may run commands on Ievgen's MacBook". Open question 6.
2. **No bypassed permission checks by default.** `--permission-mode` is never `bypassPermissions` unless the manager explicitly allows it for that agent (#1135). Whether `-p` denies a tool outside the allowlist silently or fails the run is **not verified**; #1135 AC2 is the test.
3. **Record text is data.** It reaches the model as a tool result, with the wake instructions telling it so. That lowers the chance and **does not remove it**, which is why 1 and 2 exist and why #1140 is a gate before any customer installs the Runner.
4. **The agent folder is Runner-controlled.** The Runner creates it, writes only its own files in it, and clears scratch each wake, so injected text cannot leave a file for the next wake to obey.
5. **Secrets.** The run credential reaches the tool through a 0600 MCP config file inside the folder or an environment variable, never argv, never logged, deleted at the end of the run. The runner token sits in the Runner's own home directory, 0600. The Runner's logs redact both. (The server has `api/common/redact-secrets.ts`; it is AGPL, so the Runner carries its own, §9.)
6. **Data leaves our servers for the customer's model provider**, under the customer's account and terms. That is the point of the feature and must be said once, plainly, in the install docs.

**No exfiltration channel through the queue.** A wake carries ids, a reason and counts, never record text, so a Runner token that claims wakes learns that something happened on a record, not what it said. It does learn the agent's instructions at claim time (it must run them). Instructions are therefore not a place for secrets; the docs say so.

### 8. Protocol versioning

**Decision.** Two integers and one rule. The Runner sends its **package version** and its **protocol number** on every request. The server answers with its **supported protocol range**. These are compatibility headers, not provenance: nothing about who or what wrote anything is read from them (§4).

- Inside one protocol number, changes are **additive only** and unknown fields are ignored on both sides.
- A breaking change bumps the number. The server supports the current and the previous number for at least 90 days (recommended).
- A Runner below the minimum gets `426` with a structured body (`runner_upgrade_required`, the minimum version, and the one command that updates it). The Runner prints it, stops claiming, and reports `outdated` so the Runners page says **"needs an update"**, not "offline" (the two need different fixes).
- A server **older** than the Runner (self-managed) answers `404` on `/runner/v1/*` or advertises a range below the Runner's; the Runner says "this server is older than the Runner; install `@storyos/runner@<n>`".
- Tool CLI versions are not part of the protocol. An adapter declares the range it was tested against; outside it the Runner **warns** in `status` and still runs, and every Run records `toolVersion` so a regression can be traced.
- Precedent for the idea: `mcp/schema-version.ts:1-25` (#365), which exists because a client that connected before a deploy kept sending a shape the server no longer accepted, and it looked like a data problem. The Runner's version is advertised at connect and re-checked at every claim, not once.

### 9. The Apache-2.0 package inside an AGPL monorepo

**Decision (mechanics).** Ievgen decided (2026-10-29) that `packages/runner` is Apache-2.0 with its own LICENSE and the server stays AGPL. This section says **how the repo carries both**. Everything marked **FLAG** is for Ievgen or legal; I have not decided it.

Today everything is AGPL-3.0-or-later: the root `LICENSE`, `NOTICE:4-5`, `"license": "AGPL-3.0-or-later"` in the root and each of `packages/config`, `schemas`, `sdk`, `mcp` `package.json`, the dual-licence policy `docs/licensing.md:1-38`, and the CLA's right to relicense every contribution (`CLA.md:28-40`). The dependency gate `scripts/license-check.mjs` already allow-lists Apache-2.0 for *dependencies* and scans only dependencies.

- **Directory and files.** `packages/runner/` with its own `LICENSE` (Apache-2.0 text), its own `NOTICE` (Apache §4(d)), `"license": "Apache-2.0"`, and an SPDX line (`SPDX-License-Identifier: Apache-2.0`) at the top of each source file so a copied file carries its licence. The root `NOTICE` and `docs/licensing.md` gain one paragraph naming the exception and the directory.
- **The one-way rule, the one that matters most.** Apache-2.0 code may be used inside an AGPL work; AGPL code may **not** be pulled into an Apache package without making the combination AGPL. So `packages/runner` **must not depend on** `@storyos/schemas`, `@storyos/sdk`, `@storyos/mcp`, `@storyos/config` or `apps/api`, directly or transitively, and must not copy code from them. It defines its own wire types (a small zod schema file, `packages/runner/src/protocol/`); `apps/api` (AGPL) imports *those* for its contract tests. One definition, flowing from Apache to AGPL only. #1134's AC3 ("the repo's licence docs say so") is necessary and not sufficient; the boundary needs a **CI check** (a `license:check` extension or lint rule that fails if `packages/runner`'s dependency graph reaches an AGPL workspace package).
- **A tighter dependency allow-list for the Runner.** The repo-wide list admits LGPL, GPL and MPL families as compatible with an AGPL product (`scripts/license-check.mjs:30-55`). The Runner's own list should be permissive only (MIT, ISC, BSD, Apache-2.0, 0BSD), so nobody who embeds the Runner inherits copyleft from a transitive dependency.
- **Publishing.** `@storyos/runner` to npm (Dara's command is `npx @storyos/runner`) from the existing workflow pattern: a tag trigger (`runner-v*`), `pnpm --filter … publish --access public`, `NPM_TOKEN` (`.github/workflows/npm-publish.yml:3-9`, `:28`). Versioned independently of the server. `--provenance` is worth adding and needs the workflow's `id-token` permission (not verified that the current workflow grants it).
- **Contributor terms. FLAG (legal).** The CLA exists so the project can relicense contributions, including under commercial terms (`CLA.md:28-40`), and a `Signed-off-by` is the acceptance (`CONTRIBUTING.md:56`, `.github/workflows/dco.yml`). Whether contributions to an *Apache* package should still go through that CLA is a decision with real trade-offs: keeping it preserves the option to relicense the Runner; dropping it (Apache §5 inbound = outbound) is what most outside contributors to an open package expect and removes a barrier. I recommend the existing DCO + CLA for v1, because the alternative is irreversible once outside contributions land, but this is legal's call.
- **FLAG (legal): the other open items.** (a) The copyright holder line (`NOTICE:7` says it moves to the company once incorporated). (b) **Trademark**: Apache §6 grants no trademark rights, and "StoryOS" in a package name and a command needs a policy saying what a fork may call itself. (c) **Patents**: Apache §3 grants an express patent licence for the Runner's code; legal should confirm that is acceptable. (d) Whether a third-party Runner implementation of the open protocol is welcome (the protocol and its types being Apache makes it possible).

### 10. What the Runner is not

No billing and no metering (a `your_own_ai` run is never metered, ADR-0010 §3). No inbound server. No remote shell. Not a way to run agents when the customer's computer is off: an "API key" option for that is **out of v1** and hidden until a workspace's own-key connection exists (its own ticket, §11). Not a second agent engine: agents, runs, triggers, approvals and MCP tools are the existing ones.

### 11. App-facing API: one contract for the web and for MCP

Added 2026-10-29 at Otto's request, after Iris's premise check on #1139 found that this ADR pinned the Runner-facing paths and named no app-facing one. **Proposed here, not yet approved.** Paths are under `/api/v1/workspaces/{ws}` (the prefix the MCP coverage rules match on, `mcp/coverage.ts:37`). Everything here lives in a **new `RunnersController`**, guarded like the agents one (`AuthGuard`, `WorkspaceAccessGuard`) but **without `@MinRole('admin')`**: `AgentsController` carries it on the whole class (`api/agents/agents.controller.ts:46`), so a member could not call anything placed there, and members are who pair Runners.

**Common rules.** A non-member gets the guard's 404. Every *write* below requires a **signed-in session**: a token, an OAuth connection and a run credential are refused with 403, the same rule as minting a token (`api/tokens/tokens.controller.ts:35-39`, `:57-58`). Pairing is also refused to **guests** with a sentence (the #1091 rule, `api/tokens/tokens.service.ts:28-36`). Reads are open to any token with `read` scope.

| | Verb and path | Who | Body → response | MCP tool |
|---|---|---|---|---|
| a | `POST /runners/pairing-codes` | session, active non-guest member | → `201 {id, code, expires_at}`. One live code per person and workspace: issuing a new one burns the previous unused one, so live guessable codes do not accumulate. | none (excluded) |
| b | `GET /runners/pairing-codes/{id}` | session, the person who issued it | → `{status: waiting \| connected \| expired \| cancelled, runner?: {id, name, tools}}`. Polled about every 2 s by the pairing dialog. `connected` means the Runner exchanged the code and a `pending` Runner row exists; `expired` is reported once the 10-minute window has passed without Done. | none (excluded) |
| b′ | `DELETE /runners/pairing-codes/{id}` (Cancel) | session, the issuer | → `204`. Burns the code **and revokes the pending Runner it produced**, immediately instead of at the window's end. | none (excluded) |
| c | `POST /runners/{id}/activate` (Done) | session, the Runner's owner | `{tool}` → the Runner. `409` unless `pending` and still inside the pairing window (a late Done gets `409 pairing_expired`, and the person starts again); `422` if `tool` is not in the Runner's detected `tools`. | none (excluded) |
| d | `GET /runners` | session or `read` token; **the caller's own Runners only** | → `{data: Runner[]}` (below) | `list_runners` |
| d′ | `PATCH /runners/{id}` | session, owner | `{tool}` → the Runner (change which tool agents use) | none (excluded) |
| e | `DELETE /runners/{id}` | session, owner | → `204` (revoke, §3). Also the way to remove a `pending` one. | none (excluded) |
| f | `PUT /runner-assignments/{agent}`, `GET` the same | session (PUT), `read` (GET); the agent's owner or an admin | `{runner_id: uuid \| null}` → `{runner?: {id, name}}`. Writes only the `runner_agents` row (§3). `422` unless the agent's `AI mode` is `Your own AI` (set when it is hired); `422` unless the Runner is the agent owner's own and is `active`. `null` unassigns; the agent's wakes then wait. | read: inside `list_agent_wakes`'s summary; PUT none (excluded) |
| g | `GET /agent-wakes?agent=&record=&cursor=&limit=` | any `read` caller, filtered (below) | → `{data: Wake[], next_cursor}` | `list_agent_wakes` |
| h | `GET /agent-wakes/summary` | any `read` caller, filtered | → `{agents: [{agent_id, runner?: {id, name}, can_run, waiting}], waiting_total, agents_that_cannot_run}` | `get_agent_wake_summary` |

The Runner-facing paths (`POST /runner/v1/pair`, `/claim`, `/wakes/{id}/heartbeat`, `/complete`) authenticate with the runner token or, for `pair`, the code alone, and have no MCP tool.

**The `Runner` object:** `id, name, status (pending | active | revoked), connection (online | offline | paused | outdated | tool_missing | revoked), tools[], chosen_tool, runner_version, paired_at, last_seen_at, offline_since, paused_until, pause_reason, agents[{id, name}]`. `connection` and `offline_since` are derived (below). A `pending` Runner is returned (the open pairing dialog needs it) but lives at most 10 minutes, so the Runners page has no "not turned on yet" row to draw.

**Why the writes have no MCP tool.** Pairing, activating, switching the tool, removing a Runner and assigning an agent to one decide **where an agent's instructions and the workspace's data go**. A model, including the agent itself, must not be able to route its own prompts, pair a machine or cut off its peers. This is the #441 and #859 shape (`docs/architecture/restricted-access-inventory.md:261`; `api/auth/assert-human-source.ts:13-18`), and each needs an entry in `EXCLUDED` in `mcp/coverage.ts` saying so, with the reason above (#397, `mcp/coverage.ts:35`). The reads are real tools, so an agent-first workspace can see what its agents are waiting on.

**Decisions, each with its reason:**

- **Where the chosen tool is stored.** `runners.chosen_tool`, nullable until Done, set by (c) and changed by (d′). It is **per Runner, not per agent**, because Dara's step 3 asks "which should agents use?" once, per computer. `runners.tools` stays the *detected* list, refreshed on every claim; if the chosen tool is no longer detected the Runner stops claiming and `connection` reads `tool_missing` (the UI names the tool). A per-agent override is not v1.
- **`offline_since` is derived, not stored.** It is `last_seen_at` whenever `status = active` and `now − last_seen_at > 120 s`, and null otherwise. A stored column would need a second writer that races the heartbeat and can disagree with `last_seen_at`; derived, there is one source of truth and "Offline since 18:40" is literally the last time we heard from it, which is what the sentence means. `offline_notified_at` (§3) is notification de-duplication only and is never shown.
- **Who lists and removes whose Runners: the owner, for everyone, admins included.** Otto's AC already says members and admins "see their own Runners", and a Runner is one person's machine and subscription. A request for someone else's Runner id is a **404, indistinguishable from a nonexistent id**: ADR-0018 decision (b) (restricted content "hidden completely"; `docs/decisions/ADR-0018-restricted-spaces-and-databases.md:17`), applied here to existence. ADR-0018 (a) ("admins always see restricted content", `:16`) is about workspace content an admin administers, not a colleague's computer, and is deliberately not extended. An admin who must act on a departed person's Runner does not need to see it: removing or deactivating a member makes the agent owner check fail (`api/agents/agent-identity.ts:30-54`, `api/agents/trigger.subscriber.ts:148-158`), so nothing is claimable, and the sweeper revokes the Runners of a member who is no longer active. An admin-wide list is a later, separate decision.
- **v1 is Runner-only; the "API key on StoryOS" option is hidden.** Otto's ruling: positioning rules out an "API key" that means StoryOS's key plus prepaid credits, which is all `StoryOS AI` is on main (`api/agents/managed-ai-client.ts:122-124`, `api/billing/ai-credits.service.ts:40`; there is no per-customer key). So there is **no per-agent API-key persistence and no assignment transaction** in this ADR: endpoint (f) writes one row, and a Runner is the only way an agent runs on this path. The "Runs on" menu lists Runners and "Add a Runner…" only; Dara's API-key card and menu entry are hidden, and the hire card's "or an API key" wording is dropped. An option that means the workspace's **own** key arrives later, as a separate ticket gated on that connection existing; it will need its own persistence decision then, and nothing here should be read as having made it. Agents already in `Non-AI` or `StoryOS AI` mode are untouched (`api/agents/agents.service.ts:494-503`, `api/agents/agent-runtime.ts:433-444`).
- **What Hire calls: the web creates an Agents record through the existing records API; #1131 does not add a server hire.** No hire exists on main. The record route already works from the web, MCP and the Architect (ADR-0010 §1, §6) and the agent is valid in every intermediate state, which is exactly the design's "hiring is never blocked". The web sets `AI mode = Your own AI` (the mode a Runner serves), `Enabled`, and **declares scopes** (an agent that declares none gets `read`, `api/agents/agent-principal.ts:60-64`, so it could comment on nothing), then calls (f) if a Runner is chosen. **Who may hire in v1: admins, plus members who can create records in the Agents database; never guests.** That is a requirement, **not a verified fact**: #1131's premise check must establish who can create Agents records on main today, that a guest is refused, and that a guest's attempt reads as the existing refusal rather than a 500. *Costs:* two calls, not atomic (a failure leaves an agent with no Runner, which is a legitimate, visible "waiting" state); the pack must exist, and provisioning is admin-only (`api/agents/agents.controller.ts:57`), so a member hiring into a workspace with no Agents database gets "ask an admin" until an admin has provisioned it; *Alternative:* a server `POST /agents/hire` that provisions, creates, sets defaults and assigns atomically, with its own MCP tool. Better once hire carries more logic (budgets, #1138; role templates), and not needed to ship #1131. Otto confirms.

**Wakes for an agent with no Runner yet.** To show "N records waiting for it" (design, first-time moment), a wake must exist before a Runner does. So the §1 sources enqueue a wake for **every enabled agent whose `AI mode` is `Your own AI`**, assigned or not; it waits as `waiting_for_runner`. A queued wake **expires after 7 days** and is cancelled with a reason, the same default approvals use (`api/db/schema.ts:2083` carries `expires_at … interval '7 days'`), so a forgotten agent does not hoard a queue. **This changes today's behaviour for `Your own AI` agents:** the handoff Run that `YourOwnAiRuntime` writes (`api/agents/agent-runtime.ts:276-300`) is replaced by a queued wake. **Condition (Otto): #1130's premise check lists every consumer of today's `Your own AI` handoff Run (code, MCP tools, the web, docs, any workspace using it) before that Run is replaced.** I have not done that; until it is done and the list is on the ticket, the replacement does not ship. Confirmed on that condition.

**`run_state`: ONE server-derived field on every row of (g) and on each Run.** `run_state: {state, since?, until?, runner_name?, tool?}`. The web and MCP render it and never recompute it. Dara's states (#1129) and their derivation, first match wins:

1. `needs_approval`: the Run is `Waiting approval`.
2. `running`: the wake is `claimed`. Carries `runner_name` and `since`.
3. `done`: the Run is `Succeeded`.
4. `failed` / `canceled`: the Run is `Failed` / `Canceled`. **Dara did not draw these**; they exist and need a design.
5. For a `queued` wake, in this order: the agent's Runner is `pending`, revoked or none → `waiting_for_runner`; the Runner is `offline` → `runner_offline` with `since = offline_since`; the Runner's `paused_until` is in the future → `waiting_for_limit` with `until` and `tool = chosen_tool`; the agent or Runner already has a claimed wake → `waiting_for_turn` ("one job at a time"); otherwise `waiting_for_runner`.

`until` is an instant; the client formats "14:00" in the viewer's timezone. The limit time has **one source, `runners.paused_until`**, set when a run ends `limit_reached`; the Run keeps "limit reached, resumes at" as history (#1133) but the live state never reads it.

**Visibility and counts.** (g) and (h) return a wake only if the viewer can read its record (`effectiveForDatabase` is non-null) **and** can read the Agents database; anything else is omitted and **not counted**, so a count never reveals what a 404 would hide (ADR-0018 (b)). (h) `waiting` is queued wakes, `can_run` is "enabled and has a Runner that is `active` or `StoryOS AI`", and `agents_that_cannot_run` feeds the sidebar number. **One honest gap:** these counts are wakes, and a wake is created by a *transition or link after the agent could run*. A record already sitting in the trigger state when the agent was hired (Dara's "1 client is waiting: Acme Co", JCM's real data) is **not** a wake and will read 0. Recommendation: do not backfill automatically (hiring would wake an agent on every historical record); add a one-click "start with the 1 record already waiting" that enqueues `manual` wakes, as a separate small ticket. Otto confirms.

**Record page (Iris's gap on AC7).** After setting an agent in a record's agent field, `GET /agent-wakes?record={id}` returns the wake and its `run_state`, which is how the web can say "woken" or "waiting for a Runner" without a new endpoint.

## Consequences

- **Good.** No second tool layer, no second approval mechanism, no second identity: a Runner run is a `your_own_ai` run, acting through an agent token, held by the existing gates, written to the existing Runs database. The new surface is small and listed: two tables (`agent_wakes`, `runners`) plus `runner_agents`, four columns on the credential and the audit tables, three new trigger/mention hooks, and the package.
- **Costs.** Four new schema surfaces means four migrations' worth of work, and the one-migration-in-flight rule (CLAUDE.md rule 1) serialises them: they must land in build order (see the table). An agent mention changes the comment write path, which is shared and hot.
- **Residual risk we accept and name.** Prompt injection on the customer's machine is reduced by code (no native tools, no bypass, scoped credential, gates) and **not eliminated**. #1140 is the gate before anyone outside the team installs it.
- **Dependence on the tools' terms.** Whether unattended headless runs on a consumer subscription are within Anthropic's and Cursor's terms is not something this repo can answer. Open question 7.
- **Escape hatches.** Long poll to WebSocket is a transport swap. `storyos_ai` and `non_ai` are untouched; the `your_own_ai` handoff Run is replaced only after the consumer list in §11 exists. Removing the Runner package removes no server behaviour a customer relies on without it.

## Open questions

Each has a recommendation. Ruled by Otto and accepted: 1, 4, 5, 6, 8, 10, 11. Still open with Ievgen (or legal): 2, 3, 7, 9. The questions raised by §11 are listed after the numbered ones.

1. **Can an agent be an assignee?** **Ruled (Otto): accepted.** `Issues.Assignee` is a `user` field and agents are not users, yet #1139 says agents appear in the people picker and #1130 says "Assignee". *Recommendation:* in v1 only a **relation to the Agents database** (like `Next`) wakes an agent. Making an agent assignable means either projecting agents into the Members database (ADR-0017, which has no place for a non-person today) or a new field type; neither is a small change and both touch a model ADR-0017 marks as having nine open questions. Decide it as its own ticket; #1139's picker and #1130's "Assignee" wait on it.
2. **Agent owner ≠ Runner owner.** **Open: with Ievgen.** *Recommendation:* not in v1. An agent may run only on a Runner paired by its own owner (§3). Otherwise the agent's data and prompts travel to a person who may have no access to them. Revisit when an explicit "share this agent's data with that person's machine" consent exists.
3. **Cap on a run credential.** **Open: with Ievgen.** *Recommendation:* `write`, never `admin`, unless an admin marks one agent "may change workspace settings" (§4).
4. **Pairing activation.** **Ruled (Otto): accepted; Dara has written the UI sentence.** *Recommendation:* the token is `pending` until the person presses Done in the app (§3). Needs Dara's agreement that Done is that confirm, and a sentence in the UI that says so.
5. **Attribution wording.** **Ruled (Otto): accepted.** #1132 says the agent is recorded "never as the person whose subscription runs it"; CLAUDE.md says actor = the member. *Recommendation:* `actor` stays the agent's owner and the *label* leads with agent, run and Runner (§4). Otto confirms #1132's wording means that.
6. **Native tools and permission bypass.** **Ruled (Otto): accepted.** *Recommendation:* off by default; a per-agent opt-in by the manager, visible on the Runners page; `bypassPermissions` not offered in v1 at all, to be added only if a real agent cannot do its job without it.
7. **The tools' subscription terms. (Ievgen / legal.)** **Open.** Are unattended, headless runs of Claude Code and Cursor on a personal or team plan permitted, and does it change for a plan shared across a company? *Recommendation:* get a written answer before #1141's dogfood scales past one machine; the Runner only ever invokes the customer's own installed CLI and never reads its login, which is the posture least likely to be a problem.
8. **Outbox or in-process bus for wake sources.** **Ruled (Otto): accepted.** ADR-0010 §5 promises outbox-keyed exactly-once; the subscriber is the in-process bus (§1). *Recommendation:* ship with `source_key` idempotency now and say so in the docs; move the wake sources to the outbox as its own ticket if dogfood (#1141 counts "comments missed") shows loss.
9. **The licence and contributor items in §9. (Ievgen / legal.)** **Open.** CLA over an Apache package, trademark policy, patent grant, copyright holder. *Recommendation:* DCO + CLA for v1, written trademark policy before publishing, and a CI boundary check before the first commit lands in `packages/runner`.
10. **Numbers.** **Ruled (Otto): accepted; tuned from #1141's data.** Lease 90 s, heartbeat 30 s, offline after 120 s, long poll 25 s, 3 attempts, 30-minute run ceiling, 10-minute pairing code, 90-day protocol overlap. *Recommendation:* ship these as named constants and read them off #1141's two weeks of data rather than defending them now.
11. **Binding the run credential to `target_databases` (#543).** **Ruled (Otto): accepted.** Resource binding is deny-by-default and only 14 source files apply `@ResourceScopable` (`api/access/resource-scope.ts:12-21`; `api/auth/auth.guard.ts:164-175`), so a bound credential would lose most MCP tools. *Recommendation:* do not bind in v1; rely on scope, the owner's own access and the gates; revisit if #1135's tool list shows the reachable set is acceptable.

**Raised by §11, for Otto and Dara** (none of these is Ievgen's):

12. **API key on StoryOS. Ruled (Otto): hidden in v1; v1 is Runner-only.** A workspace-own-key connection is a separate later ticket. Dara's API-key card, menu entry and hire-card wording come out of v1.
13. **Hire from the web, no server hire in #1131.** **Ruled (Otto): confirmed.** *Recommendation:* as §11; a server `POST /agents/hire` later if hire gains logic. Who may hire (admins and members who can create Agents records, never guests) is a requirement #1131's premise check verifies.
14. **`Your own AI` agents enqueue wakes even with no Runner**, replacing the handoff Run. **Ruled (Otto): confirmed on a condition:** #1130's premise check lists every consumer of the handoff Run before it is replaced.
15. **The first-time count reads 0 for records already in the trigger state.** *Recommendation:* no automatic backfill; a one-click catch-up as a small follow-up ticket.
16. **Pending pairing expiry. Ruled (Otto): overruled in part.** Cancel revokes the pending Runner at once, and an unactivated pending Runner expires within the 10-minute pairing window whether it was cancelled or the tab was closed. No 24-hour sweeper and no "Not turned on yet" row; Dara's open question on #1139 is answered by this.
17. **Failed and canceled run states** are not in Dara's design. *Recommendation:* she draws them.

## Build-order check

Each build ticket, the section it implements, and whether this ADR changes its premise. **Recommended order: #1131 → #1130 → #1132 → #1133 → #1134/#1135 → #1136 → #1137 → #1138 → #1142 → #1143**, with the web ticket #1139 after #1131 and #1140 before any customer.

| Ticket | Implements | Premise changed by this ADR? |
|---|---|---|
| **#1130** wake queue and atomic claim | §1, §2 | **Yes, two ways.** (a) "Assignee" is dropped (ruling on Q1): Assignee is a `user` field and agents are not users. Only a relation-to-Agents binding is in scope. (b) AC2 (concurrent claims) needs a Runner identity that #1131 creates; **#1131 should go first**, or #1130 ships with a test-only runner row. It also gains the @-mention work on the comment write path (§1). **Condition: its premise check lists every consumer of today's `Your own AI` handoff Run before it is replaced (§11).** |
| **#1131** pairing, runner tokens, heartbeat, offline | §3 | Yes, additions: the token is `pending` until Done (Open question 4); runner token is a separate credential, not a PAT; `runner_agents` assignment; pairing refused to guests; "hire" does not exist on the server yet. AC4 ("only sees wakes for agents assigned to it") is §2's eligibility rule. Needs a `coverage.ts` entry: pair / claim / complete have no MCP tool by design (a model must not pair or complete its own Runner), while reading the queue and the Runners does (#397). **Its premise check must also verify who can create Agents records on main (admins and members who can, never guests), and the pending Runner expires with the 10-minute pairing window (§3, §11).** |
| **#1132** per-run credential | §4 | **Yes.** It is not "issue a short-lived credential" from scratch: it extends the existing agent token with `expires_at`, `run_id`, `runner_id` and stamps those on four audit tables. It owns a migration, so it must wait for #1130 and #1131's. Add: filter run credentials out of "my tokens"; cap at `write` (Open question 3). |
| **#1133** run record, limit state, must-comment | §2, §5, §6 | Small. The Runs database already has Queued/Running/Failed and Started/Finished fields (`api/agents/agents.service.ts:572-577`, `:595-598`); #1133 adds tokens, `limit reached, resumes at` and the tool/Runner. `usage` is nullable, never zero (§5). |
| **#1134** the Runner package | §2, §3, §5, §6, §9 | Yes: **no dependency on any AGPL workspace package**, own wire types, tighter dependency allow-list, CI boundary check, independent tag and publish. AC3 ("licence docs say so") is not enough alone. |
| **#1135** Claude Code adapter | §5, §6, §7 | Yes: a precondition, not an AC. The **outward-tool gate audit** (§7) must be done first. `--permission-mode` behaviour under `-p`, the JSON result and limit signal are **not verified** and are its first task. Native tools off by default. |
| **#1136** Cursor adapter | §5 | No change; its premise check (what Cursor's CLI supports) is untouched and unverified here. |
| **#1137** limits and sharing | §2, §5 | Small: `paused_until` on the Runner; `usage = null` means "cannot measure", which is AC3's wording. |
| **#1138** budgets | §1, §5 | Small: a budget pause makes the agent ineligible at claim (§2). Tokens from `null` usage cannot be summed; the page must say "not measured" instead of showing 0. |
| **#1139** web | §3 | **Yes.** AC7 becomes "set an agent from the record's agent field" (ruling on Q1), not the people picker. Every app-facing path it calls is in §11; the hire card has no server hire behind it by design (§11). |
| **#1140** security review | §7 | Unchanged; §7's unverified list is its starting scope. Gate before customers, as written. |
| **#1141** dogfood | all | Unchanged. Its measurements (comments missed, double claims, lost leases, wake-to-start) are exactly what Open questions 8 and 10 need. |
| **#1142** Codex adapter | §5 | No change; premise check first. |
| **#1143** local AI apps | §5 | The adapter section designs it as an extension, as the ticket asked. The loop must restate ADR-0016 §4's ceilings and CLAUDE.md's truncation rule and cannot import the grounding module (§9). |

## What this ADR did not verify

- Cursor's CLI, Codex's CLI, and the output shape and limit behaviour of `claude -p` (only its flags were checked, on 2.1.104).
- That every outward-capable MCP tool is gated or unreachable for an agent credential (§7). This is the largest gap.
- Whether `--provenance` publishing is permitted by the current npm workflow.
- Who may create Agents records (so who can hire, and that a guest cannot), and every consumer of the `Your own AI` handoff Run (§11). Both are assigned to the #1131 and #1130 premise checks.
- No code was run and no database was touched. Every statement about "what exists" is from reading `origin/main`, and each `file:line` was re-read against it.
