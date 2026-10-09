# ADR-0008: Outgoing webhooks over the activity-event outbox

- **Status:** accepted
- **Date:** 2026-07-16
- **Supersedes:** [ADR-0004](ADR-0004-no-webhooks-v1.md)

## Context

ADR-0004 deferred webhooks out of v1, but committed to the shape they'd take: every
mutation already writes an append-only `activity_events` row in its own transaction,
so that table is the outbox, and webhooks become "a subscriptions table + a
poller/dispatcher + signing + retries".

MN-032 (record-change webhooks) and MN-088 (a button's `send_webhook` action) are the
two halves of the same primitive — "when data changes" and "when a human decides" —
and MN-088 explicitly required sharing one sender rather than a second HTTP path.

## Decision

**Dispatch over the outbox, not the write path.** `scan()` turns new `activity_events`
into durable `webhook_deliveries` rows and advances a per-subscription cursor;
`flush()` sends what's due. A slow or dead receiver can therefore never stall or roll
back a record write, and nothing is lost if the process dies mid-send.

**One sender.** `webhook-sender.ts` owns signing, the HTTP call, the timeout and the
backoff schedule. Both the dispatcher and the button action go through it.

**Signing.** `X-StoryOS-Signature: sha256=HMAC(secret, "{timestamp}.{body}")`, with the
timestamp in its own header — Stripe's scheme. The timestamp is inside the signed
string so a captured payload can't be replayed. A subscription signs with its own
secret (shown once at create); a button webhook signs with a workspace-wide secret,
since it has a URL rather than a subscription.

**At-most-once per (subscription, event)** is enforced by a unique index, not by cursor
arithmetic — a rescan, a crash mid-pass or two replicas ticking must not double-deliver.
Cursor comparison happens in SQL: `created_at` is microsecond precision and a JS `Date`
is milliseconds, so a cursor round-tripped through JS lands *before* the event it just
saw and rescans it forever.

**Amended by #850 — what the scan actually guarantees.** The paragraph above said the scan
"advances a per-subscription cursor" and that "nothing is lost". Neither was true of the scan
itself. It read `created_at > cursor_at ORDER BY created_at LIMIT 200` and moved the cursor to
the last row's timestamp, which silently dropped events two ways: (1) a TIE — every event of one
transaction shares a `created_at`, so a tie spanning the 200-row batch lost its remainder (300
written, 200 delivered), and (2) a SLOW TRANSACTION — `created_at` is the transaction START time,
so a transaction that began before a scan and committed after it wrote rows stamped *behind* the
cursor and they were never delivered. Both were measured. The scan now re-reads a **lookback
window** behind the cursor (`WEBHOOK_SCAN_LOOKBACK_SECONDS`, default 300) and skips every event
already queued for that subscription; the unique index remains what makes delivery at-most-once,
and the window's floor is the subscription's own creation, so history is never replayed.

**The limit that remains, stated rather than hidden:** a transaction that stays open *longer than
the lookback* can still lose its events, because the cursor orders by transaction start, not by
commit. Delivery is therefore **at-most-once, and complete for transactions shorter than the
window**, not unconditionally complete. Closing that fully means ordering by commit visibility
(a transaction-id column compared against the snapshot's xmin), which needs a migration and is a
separate change. Keep the window above the longest transaction you permit.

**Retries:** 5 attempts, 1/2/4/8-minute backoff, then the delivery is marked failed and
the subscription shows the reason.

**Egress is treated as hostile.** The receiver URL is attacker-chosen by design (an
admin types it), so: https only, no loopback/private/link-local literals at save time,
and the hostname is re-resolved before **every** send — a DNS name can resolve into
private space or be re-pointed after saving. Without that, a signed, retried POST is an
SSRF probe into our own network.

## Consequences

- Delivery is at-least-once from the receiver's perspective (a 2xx lost in transit is
  retried); receivers should treat `X-StoryOS-Delivery` as an idempotency key.
- Latency is up to one tick (30s), not instant. Acceptable for the integration use
  case; SSE/realtime would ride the same outbox if we ever need instant.
- The `activity_events` type names are now load-bearing public contract, as ADR-0004
  warned. Renaming one is a breaking change.
