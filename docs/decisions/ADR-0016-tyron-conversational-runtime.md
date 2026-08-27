# ADR-0016: Tyron — the conversational agent runtime

Status: accepted · Epic 18 (#356–#364), parent #12 · Builds on ADR-0010

## Context

ADR-0010 gave us an agent engine: agents and runs as system databases, a
scoped principal, staged-actions-then-apply with approval gates, and an
`AgentRuntime` seam. What it deliberately did **not** give us is a
conversational runtime. `ManagedAiClient`'s own comment says so in as many
words — it is one-shot completions only, and a general chat/tool-loop client is
"the still-open, ADR-worthy scope `ManagedAiRuntime`'s comment declined to
invent under cover of a different ticket".

This is that ADR.

Tyron (#357) is a multi-turn assistant that drives real tools against the
user's workspace. The existing engine runs an *agent record* on a trigger with
a goal; Tyron runs a *conversation* where each turn may call several tools and
the next turn depends on what came back. Those are different shapes, and the
difference is the whole reason this needs deciding rather than extending.

Three facts from the codebase shaped what follows:

1. **The tool catalog already exists, once, in `packages/mcp/src/tools.ts`** —
   roughly a hundred tools over the HTTP API, with scope gating, argument
   coercion (#343/#365) and label resolution already solved.
2. **`AgentPrincipal` already means "acts as the owner, attributed to the
   owner"** (ADR-0010 §2). #357's attribution decision — *"it's always a person
   that ran the AI agent, never the agent himself"* — is already this codebase's
   model, not a new rule.
3. **`source` (#330) has never been written.** The `change_source` enum and the
   column exist and the history endpoint reads them, but the only insert
   (`records.service.ts`) never sets a value, so every row in the product is
   `'human'` by default. This is load-bearing for Tyron and is treated as part
   of the work, not an assumption.

## Decision

### 1. Tyron is an MCP *client* of our own MCP server. There is no second tool layer.

#357's hard rule is "one tool layer, not two", and the scar it cites is #343 —
four MCP tools that disagreed about the shape of a record because write paths
bypassed the read serialiser. The cheapest way to honour that rule is not to
share code but to **share the running service**: Tyron connects to the MCP
server we already build and deploy, over Streamable HTTP, with a token scoped
to the asking member.

The catalog is therefore **discovered at runtime** via `tools/list`. Tyron holds
no tool definitions of its own, so it cannot drift from the MCP: a tool added,
renamed, or scope-gated in `tools.ts` is immediately and identically true for
Tyron, with no second registration to update and nothing to keep in step.

It also means every Tyron tool call traverses the **real guard stack** —
`AuthGuard`, `WorkspaceAccessGuard`, scope enforcement, the same validators —
because it is an ordinary authenticated API call arriving the ordinary way.
ADR-0010 §2's promise that "the same guard stack that gates a PAT gates an agent
run" becomes literally true rather than analogous.

**Rejected — `apps/api` imports `packages/mcp` and drives `registerTools` with a
collector.** This works (the tool tests already drive it headlessly with a fake
server) and avoids a network hop. Rejected because it inverts the dependency
graph: `packages/mcp` talks to the API over HTTP, so having the API import the
MCP package makes the two mutually entangled, and the api image would need the
mcp build. The hop we avoid costs less than the coupling we would take on.

**Rejected — call the services in-process (`RecordsService`, `FieldsService`, …)
directly.** Fastest, and tempting because Tyron runs inside the API. Rejected
because it *is* the second tool layer the ticket forbids: every argument-shaping
and label-resolution behaviour in `tools.ts` (select labels, `space/database`
refs, markdown round-tripping, stringified-argument tolerance) would have to be
reimplemented or silently lost. That is #343 again, with a new name.

**The consequence, stated plainly: if the MCP service is down, Tyron is down.**
`docker-compose.yml` already runs it (`mcp:3002`, `depends_on: api`), and it is
already a supported production surface, so this adds an availability dependency
between two services we already operate — not a new deployment. `TYRON_MCP_URL`
defaults to the compose service address and is overridable; when it is unset or
unreachable, Tyron reports that it cannot reach its tools rather than degrading
into a chat box that pretends to act.

### 2. A short-lived, member-scoped token per turn — never a shared credential.

To call MCP as the member, Tyron needs a bearer token for that member. It mints
one from `TokensService` with the scope `AgentPrincipal` already derives
(`min(owner scope, declared scope)`; `admin`→admin, `member`→write,
`guest`→read), uses it for the turn, and discards it.

Never a long-lived service token, and never a shared one: a single credential
Tyron uses for everybody would be a permission surface of its own, which is the
exact thing ADR-0010 §2 and #357's attribution decision both exist to prevent.
Per-turn and member-scoped means the blast radius of a leaked token is one
member's own access for a few seconds.

Tokens minted this way are marked as agent-issued so they can be excluded from
the user's visible PAT list — a token the user did not create must not appear in
their settings as if they had.

### 3. Attribution: actor = the member, `source` = `agent`. Both, always.

ADR-0010 §2 already attributes a run to its owner, and #357 confirms it for
Tyron: `created_by` / `updated_by` name the person who asked. Tyron is never an
actor on a record and accumulates no permission surface.

That answers "who did this" and not "was this typed or generated", and those are
different questions. The second is #330's `source` badge. **So `source` must be
threaded through the record write path as part of this work** — it is not a
one-line check, because nothing has ever written a non-default value.

This is the load-bearing pair, and skipping either half is worse than skipping
both: actor-only makes generated changes indistinguishable from typed ones, and
`source`-only loses the accountable person. The failure mode of getting this
wrong is *invisible* — history that looks complete and is quietly missing the
one fact you went looking for.

MCP calls already stamp `source: 'mcp'`, which is a different and correct
answer: a human driving their own model over MCP is not the same event as
Tyron acting inside the product. Tyron's turns are `'agent'`.

### 4. Ceilings are enforced in the loop, and they are bug guards, not prices.

Three limits, all in the turn loop rather than at the model boundary, because
the loop is the only place that can see the whole conversation:

- **Tool calls per turn** — a cap with a clear stop message. A model looping on
  itself never finishes, which is broken at any price.
- **Turns per thread** — the same guard one level up.
- **The ~50-action check-in** — a bulk operation pauses after about fifty
  records, says how many remain, and continues only when asked.

#353 decided there is **no spend ceiling**. These are therefore commented as UX
and bug guards explicitly, so a future cost decision cannot remove them by
association. Per-workspace spend is *measured* (the AI-credits ledger already
exists) and not enforced.

### 5. It streams outcomes, never a tool trace.

The user sees an animation while work happens and then a plain statement of what
changed. No step-by-step log. The single agreed exception is a long build
(#363): a plain progress line plus a tick-list of what exists so far, because a
build takes tens of seconds and silence reads as broken.

A step failing mid-job **stops and reports** what did and did not happen. It
does not carry on with a broken assumption, and it does not silently roll back
work the user may want to keep — ADR-0010 §4's staged-actions model already
makes "applied" and "proposed" distinguishable, which is what lets this be an
honest report rather than a guess.

### 6. A thread is private, and privacy is suppressed at EMIT time — never filtered on read.

Threads are private to the member who created them, including from admins
(#359). That half is enforced by construction: every read goes through one
owner-scoped lookup with the owner id in the WHERE clause, and a miss is a 404
rather than a 403, because "that thread exists but is not yours" leaks the one
fact privacy exists to withhold.

**The half that is NOT yet enforced, and is written here so it is inherited
rather than rediscovered:** nothing in Tyron emits a notification, a digest or an
email today, so "a private thread is never surfaced in a notification" is
currently true only because there is nothing to surface it. #359 left that
acceptance criterion explicitly unticked rather than claiming it, on the grounds
that a test asserting the absence of a feature is theatre.

**The obligation lands on whatever feature first gives Tyron something to emit** —
#364's mentions, a future digest, an email summary. When it does:

- Suppress at the point of EMISSION, never by filtering on read. Personal space
  (#290) learned this the expensive way: a read filter protects the UI and leaks
  through every other delivery path, and a digest or an email is exactly where it
  escapes.
- The distinction to keep straight: **the conversation is private, its
  consequences are not.** What Tyron changed lands in the shared database and is
  visible to everyone — founder's framing, "result is always a state of the
  database / record". So a notification ABOUT a record Tyron changed is fine; one
  that quotes or names the thread is not.

Search is not a live risk and was checked: `apps/api/src/search/` indexes records
and documents, and a thread is neither. It becomes one only if a future semantic
index is ever pointed at conversations.

### Sequencing

1. **#357a** — this ADR, the MCP client seam, the turn loop, ceilings.
   Read-only tools. Nothing can be written, so nothing can be broken.
2. **#356** (panel, reusing `split-pane-ratio.ts`) + **#364** (agent avatar).
3. **#359** — threads, with a structured action record sufficient for #354 to
   replay a thread later.
4. **#358** + **#357b** — write safety, then write tools enabled, plus
   threading `source` through the write path (closing #330's gap).
5. **#362** starter cards, then **#363** build-from-a-sentence.
6. **#360** finding things — needs its own ADR: there is no vector
   infrastructure in this codebase at all, and the per-member permission
   isolation model has to be decided *before* an index exists, not retrofitted.
7. **#361** product knowledge — blocked on docs sweep #16 by design.

## Consequences

- **The catalog cannot drift**, because there is only one of it and Tyron reads
  it at runtime. This is the single biggest win and the reason for the hop.
- **Tyron inherits the guard stack for free**, including every future change to
  it, because it is an API client like any other.
- **A new availability edge**: api → mcp. Both are already operated together.
- **Latency is higher than in-process calls** — accepted, and the reason
  read-heavy paths (#360) are expected to want their own answer later rather
  than routing everything through tools.
- **`source` becomes real**, which is a small cross-cutting change to the record
  write path that pays off beyond Tyron: automations and MCP can set it too, and
  #330's badge stops being decorative.
- **Rejected — a bespoke Tyron tool layer** (see §1): it is the #343 defect
  class by construction, and nothing would fail to compile when the two drifted.
