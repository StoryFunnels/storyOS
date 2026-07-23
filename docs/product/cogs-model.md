# StoryOS cost-of-goods / consumption model (MN-167)

**Status:** closes the last open item on MN-167's acceptance criteria — "infra cost
per workspace still to be modelled." Everything else on MN-167 (managed-AI
margin/cap, MN-168 automation-run caps, managed-tier provider choice) was already
decided before this doc; see the ticket (StoryOS backlog #58) for that history.

**Feeds:** MN-107 (pricing), MN-168 (metering thresholds), MN-109/MN-189 (AI add-on).

**What's new here vs. what's already in code:** `apps/api/src/admin/cost-attribution.ts`
already turns real usage into a live per-workspace cost/margin view (built for MN-194,
"makes MN-167's paper COGS model live" — it names this ticket in its own header
comment). That file already prices three of the ticket's cost drivers (hosted
calls, storage, email) and amortizes a $500/month fixed pool (compute + Postgres +
Cloudflare + Stripe's base fee) across workspaces. What it does **not** yet cover —
bandwidth/egress, backups, logs/monitoring, and PostHog — is quantified below for
the first time, and the whole thing is assembled into the low/typical/heavy
scenarios, blended margins, and break-even line the ticket's acceptance criteria
ask for. **No code changed as part of this doc** — this is the analysis deliverable,
written against the numbers the code already encodes plus new estimates for the
gaps.

---

## 1. Inputs, and where each one comes from

| Input | Value | Source |
|---|---|---|
| Free plan | $0, 2 seats included, 100 automation runs/mo cap | `apps/api/src/billing/plans.ts` |
| Pro plan | $29/mo, 3 seats included, 1,000 automation runs/mo cap | same |
| Business plan | $99/mo, 5 seats included, 10,000 automation runs/mo cap | same |
| Enterprise | negotiated out-of-band, unlimited seats/runs by default | same — no self-serve price to project |
| Seat overage | $12/seat/mo beyond the included tier, Pro and Business alike | same |
| Managed AI (StoryOS AI) markup | token cost × 10 | same, revised 2026-07-18 from ×5 — explicitly a provisional placeholder pending real usage data |
| Managed AI spend cap | $200/workspace/month default, user-adjustable | same |
| Managed AI provider | OpenAI + Gemini; Claude/ChatGPT stay BYO and unmetered | ticket AC, already DONE |
| Hosted call cost | $0.00005/call | `cost-attribution.ts` — "conservative per-call estimate," not measured per-tenant |
| Storage cost | $0.023/GB-month | `cost-attribution.ts` — S3 Standard list price |
| Email cost | $0.001/send | `cost-attribution.ts` — Resend list-price ballpark |
| Fixed platform pool (as coded) | $500/month, instance-wide | `cost-attribution.ts` — compute + Postgres + Cloudflare + Stripe's *base* fee, amortized proportional to workspace count |
| Margin-floor flag | 20% | `cost-attribution.ts` — flags a paying workspace below this, doesn't block anything |
| Real AI cost today | $0 | `AI_COST_IS_PLACEHOLDER = true` — `ManagedAiRuntime` isn't wired up yet (MN-214r); the ledger column sums to zero honestly rather than faking precision |
| Attachment upload cap | 20 MB/file | `apps/api/src/config/env.ts` (`ATTACHMENT_MAX_BYTES`) |
| Rate limit | 300 req/min per token/session | same (`RATE_LIMIT_PER_MINUTE`) |
| Storage **plan** cap | **none exists today** | `entitlements.service.test.ts` explicitly asserts `storageLimit` is *not* one of the entitlement keys — storage is metered for cost visibility (above) but not capped or gated per plan |
| Production host | Kamatera VPS, `root@185.237.15.102` | `DEPLOY-CHEATSHEET.md` — tier (RAM/CPU/disk) is **not documented anywhere in the repo**; self-hosting.md's "1 GB RAM / 1 vCPU is plenty for a small team" is a *minimum self-host* recommendation, not the production tier |

### Assumptions made where the repo has no real number (stated explicitly, not presented as fact)

These four are the ticket's own remaining cost drivers that nothing in-repo prices yet:

| Driver | Assumption | Basis |
|---|---|---|
| **Backups** | $20/month, instance-wide, fixed | Typical VPS snapshot/pg_dump-to-object-storage cost at small scale; Kamatera's exact snapshot pricing isn't documented for our tier |
| **Logs/monitoring** | $25/month, instance-wide, fixed | A lightweight hosted log/APM tier (or marginal cost of self-hosting on the existing box); nothing is wired up in code today |
| **PostHog** | $0 actual today, $25/month planning buffer | **Not integrated anywhere in the codebase** (`grep -r posthog` returns nothing) — PostHog Cloud's free tier (1M events/mo) likely covers current scale entirely; the buffer is for when/if it ships |
| **Bandwidth/egress** | ~$0 incremental today, $15/month heavy-scale buffer | StoryOS's payload is JSON API + UI assets, not media-heavy; Kamatera VPS tiers bundle several TB/month. This becomes a real line once attachment *downloads* (not uploads) scale — not before |

Also worth flagging: the code's $500 fixed bucket lumps in "Stripe's own fees," but
card processing (2.9% + $0.30/charge) is **revenue-proportional**, not fixed. This
model breaks that out as its own variable line per workspace instead (see §2) —
more accurate than amortizing it as a flat instance-wide cost, and it's a small
delta either way. This is a documentation note, not a code change.

**Revised fixed platform pool used below:** $500 (as coded) + $20 (backups) + $25
(logs/monitoring) + $25 (PostHog buffer) + $15 (bandwidth/egress buffer) =
**$585/month, instance-wide.**

---

## 2. Per-workspace variable cost — low / typical / heavy, per plan

Variable cost = hosted calls + storage + email + card-processing fee (one charge/mo).
Fixed-pool amortization is handled separately in §3, because — as the code already
does — it depends on total workspace count, not on any one workspace's plan.

### Free ($0 revenue by design — MN-107 subsidizes this tier)

| Usage | Seats | Runs/mo | Storage | Emails/mo | Variable cost/mo |
|---|---|---|---|---|---|
| Low | 1 | 10 | 0.5 GB | 20 | **$0.03** |
| Typical | 2 | 50 | 2 GB | 80 | **$0.13** |
| Heavy (at the 100-run cap) | 2 | 100 | 5 GB | 150 | **$0.27** |

No card fee (no charge on Free). Even at the top of Free's usage cap, the variable
cost of running one Free workspace is under $0.30/month — the real cost of Free
isn't its usage, it's the fixed-cost share (§3).

### Pro ($29 base, 3 seats included, 1,000-run cap)

| Usage | Seats | Runs/mo | Storage | Emails/mo | Revenue | Variable cost | Margin (variable-only) |
|---|---|---|---|---|---|---|---|
| Low | 3 | 100 | 5 GB | 200 | $29.00 | $1.46 | 95.0% |
| Typical | 4 (+1 seat) | 500 | 20 GB | 800 | $41.00 | $2.77 | 93.2% |
| Heavy (at the run cap) | 6 (+3 seats) | 1,000 | 60 GB | 2,000 | $65.00 | $5.62 | 91.4% |

### Business ($99 base, 5 seats included, 10,000-run cap)

| Usage | Seats | Runs/mo | Storage | Emails/mo | Revenue | Variable cost | Margin (variable-only) |
|---|---|---|---|---|---|---|---|
| Low | 5 | 1,000 | 20 GB | 500 | $99.00 | $4.18 | 95.8% |
| Typical | 8 (+3 seats) | 5,000 | 100 GB | 3,000 | $135.00 | $9.77 | 92.8% |
| Heavy (at the run cap) | 15 (+10 seats) | 10,000 | 300 GB | 10,000 | $219.00 | $24.05 | 89.0% |

### Enterprise — illustrative only, not a real quote

Enterprise has no self-serve price (negotiated, out-of-band per `plans.ts`), so
there's no revenue number to run margin on. For a sanity check of the unit
economics at real scale: 25 seats, 50,000 runs, 1 TB storage, 30,000 emails costs
about **$56/month in variable cost** (invoiced, not card-processed, so no Stripe
fee assumed). Whatever an Enterprise deal is priced at, the compute/storage/email
floor is cheap — the premium those deals command is for support, SLA, and security
review, none of which this model prices.

**Headline finding:** per-workspace variable cost stays under 9% of plan revenue
even at the *top* of each plan's usage cap. The automation-run caps MN-168 already
ships are doing real work here — they keep the one per-unit-cheap-but-summable
driver (hosted calls) far below anywhere it could matter. **Storage is the one
driver with no plan cap today** (confirmed via `entitlements.service.test.ts`) —
see §5.

---

## 3. Blended gross margin per plan — fixed-cost amortization

The $585/month fixed pool (§1) is shared across every workspace on the instance,
proportional to workspace count — same allocation method `cost-attribution.ts`
already uses. Per-workspace fixed-cost share at illustrative instance sizes:

| Total workspaces (instance-wide) | Fixed cost per workspace |
|---|---|
| 10 | $58.50 |
| 50 | $11.70 |
| 200 | $2.93 |

Fully-loaded margin (variable + fixed share) at **typical** usage:

| Plan | N=10 workspaces | N=50 workspaces | N=200 workspaces |
|---|---|---|---|
| Free | −$58.63/mo (subsidy) | −$11.83/mo (subsidy) | −$3.05/mo (subsidy) |
| Pro | **−49.4%** (negative) | **64.7%** | **86.1%** |
| Business | 49.4% | 84.1% | 90.6% |

**This is the real headline:** blended margin depends far more on total instance
scale (how many workspaces share the fixed $585 pool) than on any individual
workspace's usage tier. At very small scale (~10 workspaces total), a single Pro
workspace can go margin-negative purely from carrying its share of fixed platform
cost — not from anything it did. By ~50 workspaces, both paid plans are solidly
profitable; by ~200, margins approach the ~90%+ ceiling that variable costs alone
allow. Business is more resilient at low scale because its higher price absorbs
the fixed share more comfortably.

---

## 4. Break-even usage line

Two different questions hide under "break-even," and the ticket's cost-driver list
implies both — this model answers each separately rather than picking one:

**(a) Per-workspace usage break-even** — how much would *one* workspace have to
consume to erase its own plan's revenue in variable cost alone?

| Plan | Runs needed | Storage needed | Emails needed |
|---|---|---|---|
| Pro ($29) | ~580,000/mo | ~1,261 GB | ~29,000/mo |
| Business ($99) | ~1,980,000/mo | ~4,304 GB | ~99,000/mo |

Runs and emails are already impossible to reach — the run cap stops that path an
order of magnitude earlier (1,000/10,000 vs. 580k/1.98M). **Storage is the one
column with no cap**, and while ~1.2–4.3 TB is a lot for a single Business
workspace's databases + attachments, it is not impossible for a heavy user of
attachments over enough years — see §5's recommendation.

**(b) Fleet break-even** — given that no realistic single workspace threatens its
own plan's margin, the real break-even question is *how many paying workspaces
does it take to cover the $585/month fixed pool?* Using an illustrative adoption
mix (60% Free / 30% Pro / 10% Business, all at "typical" usage), the blended
contribution per workspace across the whole mix is about **$23.91/workspace/mo**
(Free contributes slightly negative, Pro ~$38.23, Business ~$125.24, weighted).

**Break-even ≈ $585 ÷ $23.91 ≈ 25 total workspaces** at that mix — roughly **11
paying workspaces** (8 Pro + 3 Business at a 60/30/10 split) covering the other 14
Free workspaces riding along. This is the number MN-107/MN-168 should treat as
"the instance needs to convert" before the fixed platform cost is fully covered;
below it, Free's subsidy is the entire margin call, not a per-workspace usage
problem.

---

## 5. Recommendation feeding MN-168 (metering thresholds)

- **Automation-run caps (already shipped, MN-168/#79):** confirmed adequate. Even
  at the caps, hosted-call cost is a rounding error against plan revenue (§2).
  No change recommended.
- **Storage has no plan-level cap or flag today.** Given how cheap storage is per
  GB ($0.023), a hard block isn't warranted — but a **soft flag** (same
  detection-only spirit as `MARGIN_FLOOR_PERCENT`, not a block) at generous
  thresholds would close the one open per-workspace break-even path in §4a
  without affecting any realistic user:
  - Free: flag above ~10 GB
  - Pro: flag above ~100 GB
  - Business: flag above ~500 GB

  These are 2–8× the "heavy" scenario modeled in §2, so they won't fire on normal
  usage — they exist purely to catch the pathological case (or abuse) before it
  reaches the multi-hundred-GB range where storage cost actually starts to bite.
- **Managed AI (StoryOS AI) margin/cap:** already decided and out of scope for this
  update — ×10 markup structurally guarantees ~90% gross margin on that line
  regardless of usage, protected independently by the $200/workspace/month hard
  cap. Nothing here changes that.

---

## 6. Summary (for MN-107 / the pricing discussion)

- Variable cost per workspace is cheap and well-bounded by existing caps: **under
  9% of plan revenue even at the top of each plan's usage cap** (Pro 91.4%,
  Business 89.0% margin at "heavy," variable-only).
- **Fixed platform cost ($585/mo, revised from the $500 already coded to add
  backups/logs/PostHog/bandwidth buffers) is the dominant margin lever, not
  per-workspace usage.** Blended margin swings from negative (Pro, at ~10 total
  workspaces) to ~86–91% (at ~200 total workspaces) purely as a function of scale.
- **Break-even is roughly 11 paying workspaces** (at an illustrative 60/30/10
  Free/Pro/Business mix) to cover the fixed pool — this is the number to watch
  as an early-scale health check, not any individual workspace's consumption.
- **Storage is the one uncapped cost driver.** Recommend a soft flag (not a
  hard cap) at 10/100/500 GB for Free/Pro/Business respectively, feeding MN-168.
- Managed-AI margin/cap and provider choice were already decided before this
  update and are unchanged.
- **Confidence:** the three drivers already coded (hosted calls, storage, email)
  rest on public list prices, not measured per-tenant billing — clearly labeled as
  operator-set rates in `cost-attribution.ts` itself. The four new drivers modeled
  here (backups, logs/monitoring, PostHog, bandwidth) are estimates with no
  in-repo grounding at all, stated as such throughout. Revisit both categories
  once real Kamatera/Resend/PostHog invoices exist to reconcile against — the same
  spirit as the AI markup's own "provisional, revisit once real data exists" note.
