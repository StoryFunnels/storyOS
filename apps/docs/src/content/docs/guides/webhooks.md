---
title: Webhooks
description: An outbound subscription — StoryOS calls a URL you name whenever something happens, with a signing secret shown once and a delivery log.
sidebar:
  order: 7
---

An outbound subscription: StoryOS calls a URL you name whenever something happens, so another
tool finds out without polling.

This is a different feature from an automation's **Send a webhook** action (see
[automations](/concepts/automations/)). That one fires from a single rule, on the record that
triggered it. A webhook subscription is workspace-wide (or scoped to one database), fires on
whichever event types you pick, and exists on its own — no rule required.

## Creating one

**Settings → Webhooks → New webhook**, admin only. You give it:

- A **URL** — must be `https`, and must not point at a private or loopback host.
- A **database**, or **All databases**.
- One or more **events**: `record.created`, `record.updated`, `record.deleted`,
  `record.restored`, `relation.linked`, `relation.unlinked`, `comment.created`.

## The signing secret is shown exactly once

Creating a webhook mints a signing secret and shows it to you in that moment, in that dialog,
never again. StoryOS signs every delivery with it (HMAC-SHA256, Stripe's scheme — the timestamp is
inside the signed string, so a captured payload can't be replayed later against a receiver that
checks age) so your endpoint can confirm a request really came from StoryOS. Most no-code tools
(n8n, Make, Zapier) don't check the signature at all; it matters if you're verifying authenticity
yourself. Copy it now — there is no way to retrieve it afterwards, only to delete the webhook and
make a new one.

## If a delivery fails

Retried up to 5 times with backoff (1, 2, 4, 8 minutes), then marked failed for good. Anything
other than a 2xx counts as a failure, including a network error. The delivery log shows each
attempt's status code and error, so "I registered a webhook and nothing arrived" is answerable
from the log rather than a guess.

## Whose access a webhook acts with

A webhook is a standing read into an outside system, made on someone's behalf, so it never reads more
than that person can. Its **owner** is the person who created it, and only a workspace admin can own
one. The webhook list shows each webhook's `owner_id`, and a `paused_reason` when it is paused.

- **Deliveries pause when the owner is no longer an active admin**: demoted, removed from the
  workspace, or never recorded. While a webhook is paused nothing new is queued and nothing already
  queued is sent. The reason on the list says which case it is.
- **An admin resumes it by taking ownership**: `PATCH` the webhook with `take_ownership: true`, or
  `update_webhook` with `take_ownership` over MCP. It does not advance past what it missed, so what
  happened while it was paused is then delivered, under the new owner's access.
- **Older webhooks were given an owner.** A webhook created before owners were recorded was assigned
  to the workspace's longest-serving active admin. In a workspace with no active admin it stays paused
  until an admin takes it over.
- **For an admin-owned webhook nothing changes**, since an admin reads every record.

## What you can rely on, and what you can't

- **Each event is queued at most once per webhook** — at most, not exactly: see the limit below
  for the one case where an event is never queued. A database guarantee (a unique key on webhook and
  event) means your endpoint is not sent the same event twice because of a scan running again.
  Your own retries (above) can still resend an event whose delivery failed, so write the receiver to
  tolerate a repeat.
- **Delivery order is oldest first, but not strict.** An event written by a slow transaction is
  delivered late rather than dropped, so a later event can arrive before it.
- **A write that stays uncommitted for longer than the lookback can be missed.** StoryOS looks back
  over a window (5 minutes by default; self-hosted operators set `WEBHOOK_SCAN_LOOKBACK_SECONDS`) so a
  transaction that commits late is still found. One held open **longer than that window** writes
  events the webhook never queues. The window is a bound, not a proof. The limit is real: if you run
  long manual database transactions on a self-hosted instance, keep them well under the window.
- **A busy instance may not scan every webhook.** Each pass looks at up to 100 enabled webhooks across
  the whole instance, in no particular order. Beyond 100 enabled webhooks in total, some are not
  scanned on a given pass. This is a known limit that is being tracked separately.
- **A miss is logged, not redelivered.** Self-hosted operators get a warning while a long transaction
  is open and an error naming the event after the fact (`webhook.long_transaction`,
  `webhook.lost_events`). The error can false-alarm right after you change a webhook's database or add an
  event type to it, because older events that now match look as though they were never sent.

## Managing one over the API or MCP

`list_webhooks`, `list_webhook_deliveries`, `update_webhook`, `delete_webhook` — all admin-scoped,
same as the app. `list_webhooks` never returns the signing secret.

**There is no `create_webhook` tool, deliberately.** Creating one mints a secret that is shown
exactly once — a tool result is a transcript, and a secret that lands in one can't be un-shown.
Create a webhook in the app; manage, debug, and delete it from either surface.

This doesn't limit what an automation rule can do — a rule's own **Send a webhook** action is
fully reachable through `create_automation`, with no subscription involved.
