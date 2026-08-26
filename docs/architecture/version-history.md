# Version history: change log, rich-text history, and restore

The design for StoryOS's version-history initiative (#321) — a Fibery-grade,
**field-level** change log with source attribution, rich-text document history,
plan-gated retention, and phased restore. This ADR is the design + codebase
inventory that gates the C2–C5 build (#363–#366); it defines the schema,
retention, capture path, and build order. No feature code lands with it.

> **TL;DR** — Add a **field-level change-event log** (`record_field_changes`),
> one row per changed field per write, each badged by **source**
> (`human` / `agent` / `automation` / `mcp`). **Done in #390** — the reference
> to "#330" throughout this document was stale numbering; #330 is an unrelated,
> closed billing-tip bug. Add
> **debounced rich-text snapshots** (`document_versions`). Keep the existing
> MN-231 whole-record `record_versions` snapshots as the **restore substrate**
> (whole-record restore ships first; per-field revert is a cheap fast-follow off
> the event log). Retention is **plan-gated and tiny**: Free retains nothing,
> Pro 1 day, Business 7 days, Enterprise 1 month — so storage stays small and
> write-amplification risk is bounded by the pruning window, not by traffic.
> Structural undelete extends the #229 trash to `databases` / `views` / `spaces`.
> This is history + restore, **not** point-in-time workspace backup (#320/#322).

## The target model (condensed research from #321)

**The reference tool** (the model we're matching) offers, per entity, a
**field-granularity change log**: every field update, comment, and reference,
each with who + when, shown as a diff with per-item restore; a separate
**text-history** view for rich-text documents (diff + restore); an
**admin audit log** spanning all users with filters; and structural
**undelete** of entities, fields, views, and databases.

**Notion** (the useful contrast, i.e. the ceiling of "good enough"): coarse
page snapshots (~10-min sessions), plan-gated retention (7 days / 30 days /
unlimited), **whole-page** restore only. It is explicitly *not* property-level,
*not* structural, *not* point-in-time, and "not a backup." Whole-page restore is
the cheapest thing that satisfies most users.

**Chosen model:** field-level capture (the reference-tool model — the event log
is where the product value is), with **whole-record restore first** (the Notion
pragmatism — cheapest, ships value immediately) and **per-field revert as a
documented fast-follow** built on the same event log. We get the richer data
model from day one without paying for the richer restore UI up front.

## What already exists (codebase inventory)

The durability plan already shipped its lower layers. **C2–C5 extend this
infrastructure; they do not replace it.**

### MN-231 whole-record snapshots + list/restore API — SHIPPED

This is the "list/restore APIs exist" from #321 (PR #115). It is a
**whole-record snapshot** system, not field-level:

- **Table** `record_versions` (`apps/api/src/db/schema.ts` ≈L732): one row per
  record write that changes stored data, holding the **FULL prior** `values`
  (jsonb) + `title`, plus `workspaceId`, `recordId`, `actorId` (text — a user
  id), `createdAt`. Index `record_versions_record_created_idx (record_id,
  created_at)`. **No retention/pruning job** ("deferred" per the schema comment).
- **Capture** is inline in `RecordsService.update()`
  (`apps/api/src/records/records.service.ts` ≈L1335), in the **same
  transaction** as the write, snapshotting the pre-write state. Only `update()`
  captures (create has no prior state; correct).
- **Read/restore API** `RecordVersionsController`
  (`apps/api/src/activity/record-versions.controller.ts`):
  `GET  /workspaces/:ws/databases/:db/records/:rec/versions` (cursor, newest
  first) and `POST …/versions/:version/restore`. Restore
  (`RecordsService.restoreVersion` ≈L1479) writes the FULL snapshot back (not a
  merge), snapshots the pre-restore state first (restore is reversible), and
  emits a `record.updated` activity event via `diffSnapshots`
  (`apps/api/src/records/record-diff.ts`) so a restore shows up in the trail
  like a normal edit.

**Implication for C2:** `record_versions` is the ideal **whole-record restore
substrate** — keep it. It is *not* a field-level log (each row is a full
snapshot, diffs are derived on read), so it cannot by itself answer "who changed
*this field* and when" cheaply, nor badge changes by source (it stores a bare
`actorId`). The new field-level log is additive.

### MN-027 activity trail — SHIPPED

- **Table** `activity_events` (schema ≈L706): `workspaceId`, nullable
  `recordId`, `actorId` (text), contract-grade `type` (e.g. `record.updated`,
  `record.deleted`, `record.restored`), `payload` jsonb (carries `diff` for
  updates), `createdAt`. Index on `(record_id, created_at)`. Doubles as the
  future webhook outbox (ADR-0004). Written in the same transaction as the
  mutation (see [overview.md](overview.md) request path step 5). **No
  retention/pruning job.**
- `ActivityService` / `ActivityController` render "what changed" per record.

**Implication:** `activity_events.payload.diff` already holds every old→new for a
record update, but it is a **denormalized jsonb blob keyed for display**, not a
queryable per-field row, and it carries no source label. The new log
normalizes this into `(field_id, old_value, new_value, source)` rows so per-field
revert and "changes to this field" queries are index-backed.

### Records write path — the capture hook point

- `RecordsService.update()` (≈L1273) and `.create()` (≈L1028) in
  `apps/api/src/records/records.service.ts` are the single choke points for
  field mutations. `update()` already computes a `diff` (`{ [fieldId]: { from,
  to } }`) inline and writes `activity_events` + `record_versions` in one
  transaction. **This is the natural hook for field-level capture** — the diff
  is already in hand; C2 fans it out into `record_field_changes` rows.
- All record reads/writes funnel through `RecordsRepository` + the filter-AST
  query compiler — the "one seam that matters" ([overview.md](overview.md)),
  which is why capture can live in one place.

### Soft-delete / trash (#229 "Remove vs Erase") — PARTIAL

Soft-delete (`deleted_at timestamptz`, nullable) exists on exactly four tables
(`apps/api/src/db/schema.ts`):

| Table | `deleted_at`? | Trash UI / restore |
|---|---|---|
| `records` (≈L288) | yes | `GET/POST …/records/trash`, `…/:rec/restore`, `batch-restore` (`records.controller.ts`) |
| `fields` (≈L229) | yes | via schema services |
| `space_documents` (≈L414) | yes | — |
| `comments` (≈L433) | yes | — |
| **`databases`** (≈L190) | **no** | — |
| **`views`** (≈L246) | **no** | — |
| **`spaces`** (≈L97) | **no** | — |
| `relations`, `select_options` | no | — |

Record trash: `RecordsService.softDelete/batchDelete/restore/listTrash`
(≈L1618–1760). `listTrash` hides rows older than `TRASH_RETENTION_DAYS = 30`
via a query cutoff — **but there is no purge cron**; the rows persist. There is
**no explicit hard-"Erase" endpoint** for record trash (GDPR erase in
`apps/api/src/gdpr` is a separate, user-PII-tombstone concern). So #229's
"Remove" (soft delete) is built for records/fields/documents/comments; "Erase"
(permanent) and **structural undelete of databases/views/spaces are gaps** the
version-history structural-undelete work (C5) must close.

### Attribution / AgentPrincipal — identity exists, and the source label now does too (#390)

> **Updated.** This section described the gap accurately and it is now closed:
> `RecordsService.update` takes an explicit `source`, set at the HTTP boundary
> (`auth.via === 'token'` ⇒ `mcp`), by the automation executor, and by the agent
> path that shares it. `actorUserId` is unchanged and still the PERSON — the
> label is a second axis, not a replacement (ADR-0010 §2).
>
> Known limit, stated rather than glossed: **Tyron's own writes land as `mcp`,
> not `agent`**, because Tyron drives the MCP with a minted PAT (ADR-0016) and
> is therefore indistinguishable from any other token at the HTTP boundary.
> Separating them needs a marker on the token itself.

#### The original gap, for context

- `AgentPrincipal` (`apps/api/src/agents/agent-principal.ts`): an agent **acts
  as its owner**, `{ userId, scope }`, scope = min(owner, agent-declared). The
  run is *attributed to the owner's userId*.
- The auth guard tags each request with `auth.via: 'session' | 'token' |
  'oauth'` (`apps/api/src/auth/auth.guard.ts` ≈L34) — a human session, a PAT/API
  token, or OAuth. MCP reaches the API as a **PAT** (`via: 'token'`, see
  `packages/mcp`). Agent runs call `RecordsService` **directly** with the
  owner's `actorId` (`apps/api/src/agents/agents.service.ts` ≈L623). Automation
  actions write through `apps/api/src/automations/actions.service.ts`.
- **The gap:** the write path stores only `actorId` (a user id). An agent write,
  an automation write, and a human write are today **indistinguishable** in
  `record_versions` / `activity_events` — all carry the owner's userId, no
  source discriminant. The *pieces* to know the source exist
  (`auth.via`, the `AgentPrincipal`, the automation/MCP call sites) but they are
  not threaded into the write as a single field.

**Implication for C2:** attribution requires threading a **`source` enum**
(`human` | `agent` | `automation` | `mcp`) into `RecordsService.update/create`
(and thus into the new log). Default `human` for `via: 'session'`; the agent
runtime sets `agent`, the automation job-runner sets `automation`, MCP-origin
PAT calls set `mcp`. This is a small, well-localized plumbing change, but it is
**net-new** — nothing captures source today.

### Plan / entitlement gating — reusable as-is

- `BillingService.getStatus(workspaceId) → { plan: 'free'|'pro'|'business'|
  'enterprise' }` and `EntitlementsService`
  (`apps/api/src/billing/entitlements.service.ts`) are the plan signal.
  `EntitlementsService.can(workspaceId, capability)` **short-circuits to `true`
  when `!stripe.enabled`** (self-hosted ⇒ unlimited) — the exact pattern
  retention gating should reuse.
- Plan catalogue as code in `apps/api/src/billing/plans.ts` (`PlanId`, `PLANS`).
  Retention windows belong here as a per-plan `historyRetentionDays` field.

### Rich-text documents — no history today

- `documents` (per-record BlockNote, schema ≈L379) and `space_documents`
  (≈L395) store current `content` jsonb + an **optimistic-concurrency `version`
  integer** (bumped on save for 409 detection) — **not** a history. There is no
  document-version table. Rich-text history is entirely net-new (C4).

## The schema

Two new tables. Both mirror the `record_versions` cascade shape and carry
`workspace_id` for tenant scoping and pruning.

### 1. Field-level change events — `record_field_changes`

```
record_field_changes
  id             uuid pk
  workspace_id   uuid not null → workspaces(id) on delete cascade
  database_id    uuid not null → databases(id)  on delete cascade
  record_id      uuid not null → records(id)    on delete cascade
  field_id       uuid          -- null ⇒ the promoted `title` column (matches record-diff.ts)
  actor_user_id  text          -- the attributed user (owner for agent runs), like activity_events.actorId
  source         enum('human','agent','automation','mcp') not null default 'human'
  old_value      jsonb         -- null for a create / first value
  new_value      jsonb
  created_at     timestamptz not null default now()

indexes:
  (record_id, created_at desc)          -- per-record history, newest first (cursor)
  (database_id, field_id, created_at)   -- "changes to this field" + per-field revert
  (workspace_id, created_at)            -- retention pruning by plan window
```

Notes / rationale:

- **Field granularity is the product.** One row per changed field per write.
  `update()` already produces the `{ [fieldId]: { from, to } }` diff; C2 fans it
  out. Title uses `field_id = null` (consistent with `record-diff.ts`).
- **`source` is the provenance badge (#390).** Enum, not free text, so the UI and audit-log
  filters are cheap. Default `human` keeps existing session writes correct
  without a code change at every call site.
- **`actor_user_id` stays a user id** (not a FK) — matches `activity_events` /
  `record_versions`, survives member deletion as a tombstone
  ([auth.md](auth.md): "removed users keep historical authorship"), and
  Drizzle enum-migration caveats don't bite a `text` column.
- **Relations** are *not* stored inline on records — they live in `record_links`
  (ADR-0002 / [record-storage.md](record-storage.md)). A relation change is a
  link add/remove, not a `values` diff, so relation history is **out of scope
  for `record_field_changes` v1** and captured (if at all) via `activity_events`
  link events. Per-field *revert of a relation* is explicitly deferred (see
  Risks).

### 2. Rich-text document history — `document_versions`

**Snapshots, not patches.** Recommendation: store whole-content snapshots.

```
document_versions
  id             uuid pk
  workspace_id   uuid not null → workspaces(id) on delete cascade
  document_id    uuid not null → documents(id)  on delete cascade   -- (+ a parallel path for space_documents)
  content        jsonb       -- full BlockNote block array at snapshot time
  content_text   text        -- extracted plain text, for diff rendering
  actor_user_id  text
  source         enum(... same four ...) not null default 'human'
  created_at     timestamptz not null default now()

indexes:
  (document_id, created_at desc)
  (workspace_id, created_at)   -- retention pruning
```

Why snapshots over patches:

- **Restore is a straight write-back** — no replaying a patch chain, exactly the
  reasoning MN-231 used for `record_versions` ("never reconstruct state from a
  chain of diffs").
- **BlockNote content is a JSON block tree, not linear text** — a robust
  operational-transform/patch format is real work and a real bug surface; a
  wrong patch corrupts a document. Snapshots can't corrupt.
- **The debounced cadence + tiny retention make size a non-issue** (below). A
  patch chain's only win is storage, and storage is already bounded by the plan
  window.

### 3. Structural undelete (extends #229 trash)

Add nullable `deleted_at timestamptz` to **`databases`, `views`, `spaces`** (and
consider `relations`) so they become soft-deletable + restorable, matching the
reference tool's structural undelete. `records`, `fields`, `space_documents`,
`comments` already have it. This is C5. It reuses the existing trash/restore
pattern (`deleted_at = null` to restore) rather than inventing a new mechanism.
Cascade semantics on restore (restoring a database must not resurrect records
the user separately erased) are the design risk to nail in C5.

## Retention (LOCKED — founder decision)

History is a **paid feature**. Windows, gated by plan:

| Plan | History retained | Rich-text history |
|---|---|---|
| **Free** | **none** (feature off) | none |
| **Pro** | **1 day** | 1 day |
| **Business** | **7 days** | 7 days |
| **Enterprise** | **1 month** (30 days) | 30 days |
| Self-hosted (`!stripe.enabled`) | unlimited (no pruning) | unlimited |

Encode as `historyRetentionDays` on each `PlanDef` in `plans.ts`
(`free: 0, pro: 1, business: 7, enterprise: 30`). Resolve per workspace through
the existing `BillingService.getStatus` → plan → window, reusing the
`EntitlementsService` self-host short-circuit for unlimited.

**Free = capture OFF, not capture-then-prune.** Recommendation: on Free, **do
not write** `record_field_changes` / `document_versions` / `record_versions`
rows at all. Rationale:

- The window is **zero** — capture-then-immediately-prune writes rows that can
  never be read by anyone, pure write amplification and pruning load for no
  product value.
- The check is one cheap plan lookup at the capture site (cache the plan per
  request). "Code uniformity" (always capture, prune later) is only worth it
  when the prune window is non-zero; here it buys nothing and costs every write.
- The `activity_events` trail (separate feature, not gated here) still records
  "what changed" for Free — we are gating **history/restore**, not the activity
  feed. So Free users are not blind, they just can't time-travel.

Trade-off to accept: a workspace **downgrading** to Free should have its history
pruned promptly (a one-shot prune on the downgrade webhook), and one **upgrading**
starts accumulating from the upgrade instant (no backfill — there's nothing to
backfill). Both are simple hooks off the existing Stripe subscription events
(`billing_events`).

### Pruning mechanism

A single scheduled job (daily is ample given the 1–30-day windows) deletes rows
older than the workspace's window:

```
delete from record_field_changes
  where created_at < now() - (plan window for workspace_id)
```

Do it **per plan tier**, not per workspace, to keep it set-based: resolve the
set of workspaces at each tier, then one ranged delete per tier keyed by the
`(workspace_id, created_at)` index. Same job prunes `document_versions`,
`record_versions`, and (decision below) optionally `activity_events`. This is
the pruning job MN-231 deferred — version-history is where it lands.

### Storage-growth estimate

Windows are the cap, not traffic. Rough envelope for an active Business
workspace (7-day window): say 50 active editors × 200 field edits/day ≈ 10k
change rows/day; a change row is ~150–400 bytes (two jsonb scalars + ids) ⇒
~1.5–4 MB/day ⇒ **~10–30 MB steady-state** at 7 days, before index overhead.
Enterprise (30 days) ≈ 4× that, tens of MB. Rich-text: a debounced snapshot is
larger (whole block tree, say 2–20 KB) but far rarer (one per debounce window
per edited doc); a heavy-docs workspace lands in the low hundreds of MB at 30
days. **Both are trivial** next to attachments and the records table itself.
Short windows are what make field-granularity affordable — the whole design
leans on this.

## Capture & performance

- **On the hot path only what must be transactional.** The pre-write snapshot
  must be consistent with the write, so *enqueueing* capture happens in the
  write transaction, but the **fan-out into `record_field_changes` rows should be
  cheap and can be batched** — a single multi-row insert built from the diff
  already computed in `update()`. Prefer a batched insert over N inserts.
  Rich-text snapshotting is **debounced** (founder decision: snapshot on save,
  debounced) — coalesce rapid saves so a burst of keystroke-saves yields one
  snapshot, not dozens. A short server-side debounce keyed by `(document_id,
  actor)` is the mechanism.
- **No-op suppression.** `update()` already early-returns when the diff is empty
  and no links changed (records.service.ts ≈L1306) — inherit that; never write a
  change row for a write that changed nothing. Also suppress field rows where
  `old_value === new_value` (the `diffSnapshots` JSON-equality check already does
  this).
- **Indexing.** The three indexes above cover the three access patterns
  (per-record timeline, per-field history/revert, retention prune). No GIN
  needed — we query by ids + time, never by value contents.
- **Write-path benchmarking.** Because this adds writes to the single busiest
  mutation path, C2 must land with a **before/after write-latency benchmark** on
  `update()` (a batch of field edits) — the ADR asserts capture is off the
  critical latency budget; the benchmark must prove it. If the synchronous
  fan-out shows up, move the row-insert to an after-commit hook fed by the
  in-transaction snapshot (the snapshot stays transactional; the derived rows do
  not have to be).

## Revert (phased)

1. **Whole-record restore — FIRST (C3).** Already shipped as MN-231
   `restoreVersion`. C3 is mostly **UI + polish**: surface the version list and
   a "Restore this version" action, badge each entry by `source`, and confirm
   restore-of-agent-write semantics. Cheapest, matches Notion, ships the
   headline feature.
2. **Per-field revert — FAST-FOLLOW (documented).** The `record_field_changes`
   log stores every `old_value` per field, so "revert this one field to its
   previous value" is a targeted `update()` with `{ [field_id]: old_value }` —
   which itself captures a new change row (revert is an edit, fully reversible,
   same as whole-record restore). No new storage; it's a thin service method +
   UI affordance over data C2 already writes. Explicitly a follow-up, not C3.

## Scope boundary

This initiative is **history + restore of live entities**. It is **not**:

- **Point-in-time workspace backup / restore** — that is export (#320) and
  backup (#322). History answers "what did this record/field/doc look like
  N hours ago, and put it back"; it does **not** answer "restore the entire
  workspace to 3pm Tuesday." Don't let retention windows get mistaken for a
  backup SLA — they are a short editing-safety net, the same honest framing
  Notion uses ("not a backup").
- **A cross-user compliance audit log with unlimited retention.** The
  `source`-badged change log is the substrate an admin audit view could later be
  built on, but an all-users, long-retention, filterable audit log (the
  reference tool's third pillar) is a **separate initiative** — flag it as such;
  it has different retention (compliance ⇒ long) and access-control (admin-only)
  requirements that conflict with the tiny plan windows here.

## Recommended build order

| Ticket | Scope | Depends on | Notes / gotchas |
|---|---|---|---|
| **C2 (#363)** | Field-level capture: `record_field_changes` table + migration; thread `source` through `RecordsService.update/create`; fan out the existing diff into batched rows; plan-gated Free=off; the shared **pruning job** (also prunes `record_versions`). | MN-231, #390 | **Extends** MN-231, does not replace it. One migration only (hard rule #1). The `source` plumbing is the real work — audit every write call site (session, agent runtime, automation job-runner, MCP-PAT). Land with the write-path benchmark. |
| **C3 (#364)** | Whole-record restore UX: version list + restore action + `source` badges, over the existing `RecordVersionsController`. | C2 (for source badges), MN-231 | Backend restore already exists — mostly `apps/web` + minor API for source. Hotspot file `r/[rec]/page.tsx` — coordinate per parallel-work lane rules. |
| **C4 (#365)** | Rich-text history: `document_versions` table + migration; debounced snapshot-on-save for `documents` + `space_documents`; text-history diff view + restore. | C2 (source enum, pruning job) | Snapshots not patches. Debounce server-side. Two document tables — mind both. |
| **C5 (#366)** | Structural undelete: add `deleted_at` to `databases` / `views` / `spaces` (+ maybe `relations`); trash/restore for them; close the #229 "Erase" gap. | #229 trash pattern | Cascade-on-restore semantics are the trap. One migration. |

**Extend vs replace, in one line:** MN-231 `record_versions` + its
list/restore API are **kept and extended** (they are the whole-record restore
substrate and C3's backend); the field-level log, source attribution, rich-text
history, structural undelete, and the pruning job are **additive**.

## Open decisions the founder should weigh in on

1. **`activity_events` retention.** It also has no pruning and grows unbounded;
   it's the webhook outbox *and* the human activity feed. Does it get pruned on
   the same plan windows as history, or does the activity feed stay (short,
   unbounded) independent of the paid history feature? (Recommend: prune the
   webhook-delivered events aggressively, keep a short activity feed for all
   plans — but this is a product call.)
2. **Relation-change history.** Relations aren't in `values`; do we badge/track
   relation add/remove in v1 (via `activity_events`) or defer entirely? (Recommend
   defer per-field relation revert; capture link events in the activity trail
   only.)
3. **Admin audit log** (all-users, long retention, filterable) — confirm it's a
   *separate* later initiative with its own retention, not folded into these
   plan windows.
4. **Downgrade pruning timing** — prune history immediately on downgrade to Free,
   or at next scheduled prune? (Recommend immediate, off the Stripe webhook.)

## Risks (be critical)

- **Write amplification on the busiest path.** Every field edit now writes N
  change rows on top of `activity_events` + `record_versions`. **Largely
  mitigated** by (a) short retention capping total size, (b) batched inserts,
  (c) Free=off removing the largest cohort, and (d) after-commit fan-out if the
  benchmark demands it — but it is the #1 thing to measure, not assume.
- **Double-counting agent writes.** An agent write already emits an
  `activity_events` row as the owner; adding a `source='agent'` change row is
  correct, but we must ensure a single logical write produces **one** set of
  change rows — not one for the agent tool call *and* another if the agent path
  re-enters `update()`. Audit the agent/automation call graph so capture fires
  exactly once per mutation.
- **Rich-text snapshot size.** Whole-content snapshots of large documents, even
  debounced, are the heaviest rows. The 30-day Enterprise window bounds it, but
  a pathological "huge doc saved often" case deserves a per-document snapshot
  cap or min-interval floor beyond the debounce.
- **Revert semantics on relations.** Reverting a record to an old snapshot does
  **not** currently restore its relation links (they're in `record_links`, not
  `values`), so a whole-record restore silently leaves relations at their
  current state. C3 must either document this limitation honestly in the UI or
  extend restore to reconcile `record_links` — a real scope decision, not a
  detail.
- **Source mislabeling.** If the `source` plumbing misses a call site, writes
  default to `human` and silently mis-attribute an agent/automation change. The
  default is safe (never *worse* than today, which has no label) but the audit
  value depends on completeness — hence "audit every write call site" is a C2
  acceptance criterion, with a test per source.
- **Migration serialization.** Four of the C-tickets each want a migration
  (`record_field_changes`, `document_versions`, `deleted_at` columns). Hard rule
  #1 allows **one migration in flight** — these must land sequentially through
  the merge queue, not in parallel.

## References

- Initiative: **#321** (research) → this ADR **#362** → build **#363** (C2) /
  **#364** (C3) / **#365** (C4) / **#366** (C5). Related but **out of scope**:
  **#320** (export), **#322** (backup). Attribution: **#390**. Trash: **#229**.
- Shipped substrate: **MN-231 / PR #115** (`record_versions` + list/restore),
  **MN-027** (`activity_events`).
- Code:
  `apps/api/src/db/schema.ts` (`recordVersions`, `activityEvents`, `records`,
  `fields`, `views`, `databases`, `spaces`, `documents`, `spaceDocuments`),
  `apps/api/src/records/records.service.ts` (`update`/`create`/`restoreVersion`/
  `softDelete`/`listTrash`),
  `apps/api/src/records/record-diff.ts` (`diffSnapshots`),
  `apps/api/src/activity/record-versions.controller.ts`,
  `apps/api/src/agents/agent-principal.ts` (`AgentPrincipal`),
  `apps/api/src/auth/auth.guard.ts` (`auth.via`),
  `apps/api/src/billing/entitlements.service.ts` (`can`, self-host
  short-circuit), `apps/api/src/billing/plans.ts` (`PlanDef` / `PLANS`).
- Related ADRs: [record-storage.md](record-storage.md) (values in jsonb,
  relations in `record_links`), [overview.md](overview.md) (the write path +
  activity outbox), [auth.md](auth.md) (actor tombstones), [ADR-0004](../decisions/ADR-0004-no-webhooks-v1.md)
  (activity_events as outbox).
