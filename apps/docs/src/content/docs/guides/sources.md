---
title: Sources
description: A scheduled sync from an external provider — YouTube, Shopify, Apify, social engagement — that upserts into a database on its own, plus its MCP tools.
sidebar:
  order: 8
---

A source is a scheduled sync: StoryOS pulls from an external provider — YouTube, Shopify, Apify,
or a social platform's engagement — and upserts the result into one of your databases, on its own
schedule, without a rule or a script.

This is different from [CSV import](/guides/migrate-data/), which is a one-time file. A source
keeps running.

## Setting one up

Database `⋯` menu → **Sync from…**.

1. **Pick a provider.** Each names the connection it needs (Google, Shopify, a bearer token, an
   Apify actor…) — connect that first under **Settings → Connections** if you haven't.
2. **Configure it.** Provider-specific: a YouTube channel, an Apify actor's input, a Shopify
   shop's scope. The dialog validates each field as you go.
3. **Map fields.** Every field the provider returns gets pointed at a field in your database —
   an existing one or a new one, the same choice CSV import gives you. Some providers support
   **Discover fields**, which reads the remote schema live and proposes a mapping instead of
   asking you to know it in advance.
4. **Pick the key field.** One mapped field becomes the **external key** — the provider's own id
   for the row. This is what makes a sync an *upsert*: the same YouTube video or Shopify product
   updates its existing record instead of duplicating it every run.
5. **Set a schedule.** Every 15 minutes, hourly, or daily — plus provider-specific recurrence for
   providers that support it.

## While it runs

- **Status** is `active`, `paused`, or `error`. A source flips to `error` on its own — most often
  because the connection it depends on was deleted — and its creator is notified.
- **Each run** is logged: fetched / created / updated counts, and the error if it failed. Open a
  source to see its run history, the same log `list_source_runs` reads.
- **Deleting a source does not delete the records it created.** It stops the sync; what already
  landed in the database stays.

## Managing one over the API or MCP

`list_source_providers`, `discover_source_fields`, `create_source`, `update_source`,
`delete_source`, `sync_source`, `list_source_runs` cover the same setup, run, and inspect flow the
app's dialog does — including the discover-then-map shape, so an agent proposes a field mapping
for you to see rather than guessing one blind.

**The connection itself is created in the app, not over MCP.** `create_source` takes a
`connection_id` — never a secret — so no credential can land in a tool argument or a transcript.
Connect the provider under Settings → Connections first; a source only ever references it by id.

Two read-only tools answer the two questions an agent needs before it can name a `connection_id`:
`list_connections` (what's **already** connected in this workspace, and its id) and
`list_connection_providers` (what **could** be connected — every provider type this instance
supports, its auth kind, and whether it's actually available here). Neither returns a secret.
