# ADR-0004: No webhooks in v1

- **Status:** superseded by [ADR-0008](ADR-0008-outgoing-webhooks.md) (2026-07-16)
- **Date:** 2026-07-07

## Context

Webhooks are the most-requested integration primitive, but doing them properly requires delivery guarantees, retries with backoff, signing, endpoint management UI, and failure observability — a real subsystem. v1's integration story is the pull API + PATs.

## Decision

No webhooks in v1. **But:** every mutation already writes an append-only `activity_events` row in the same transaction (server-derived, never client-supplied). This table is the future webhook **outbox** — v1.1 webhooks become: a `webhook_subscriptions` table + a poller/dispatcher over `activity_events` + signing + retries. No schema rework.

## Consequences

- Scripts poll `POST /records/query` (with `updated_at` filters) or `GET /records/:id/activity` in the meantime.
- The activity-event type taxonomy (`record.created`, `record.updated`, `relation.linked`, `comment.created`, ...) must be treated as a public-contract-to-be: name types carefully from day 1.
- SSE/realtime UI updates can later ride the same outbox.

## Superseded (2026-07-16)

Webhooks shipped in MN-032/MN-088. The plan above held exactly: `activity_events`
was the outbox, and delivery was added as a `webhook_subscriptions` table plus a
dispatcher over it — **no schema rework**, as predicted. The type taxonomy being
treated as a public contract from day 1 is what made the payload contract free.

See [ADR-0008](ADR-0008-outgoing-webhooks.md).
