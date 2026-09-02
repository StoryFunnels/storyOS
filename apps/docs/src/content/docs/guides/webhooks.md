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

## Managing one over the API or MCP

`list_webhooks`, `list_webhook_deliveries`, `update_webhook`, `delete_webhook` — all admin-scoped,
same as the app. `list_webhooks` never returns the signing secret.

**There is no `create_webhook` tool, deliberately.** Creating one mints a secret that is shown
exactly once — a tool result is a transcript, and a secret that lands in one can't be un-shown.
Create a webhook in the app; manage, debug, and delete it from either surface.

This doesn't limit what an automation rule can do — a rule's own **Send a webhook** action is
fully reachable through `create_automation`, with no subscription involved.
