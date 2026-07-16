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
