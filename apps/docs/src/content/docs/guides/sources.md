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

## Three providers worth knowing in more detail

**YouTube** is template-first: Settings → Integrations → YouTube offers three ready-made
databases (Videos, Comments, Metrics) instead of asking you to build one and map fields by hand.
Pick a template and it creates the database *and* attaches the matching source in one step. It
syncs the **connected account's own channel** — there's no channel picker for the common case.

**Shopify** provisions its whole catalogue at once: **Create the product catalogue** builds three
linked databases — Products, Variants, Collections — with the variant→product and
collection→product relations already wired, rather than three separate sources you'd otherwise
set up and relate by hand. Once connected, product and collection changes in Shopify also arrive
by **webhook** in real time, on top of the regular schedule — you don't wait for the next sync
tick to see a price change.

**Shopify products is also the one provider with write-back today** — an `out`/`both`-mapped field
edit in StoryOS pushes back out to Shopify. Scope is deliberately narrow: only product-level
scalars — title, status, vendor, product type, tags — push back out. **Variant fields (SKU, price,
inventory) don't push yet**; they're a separate Shopify resource and a deliberate follow-up, not an
oversight. A rejected write lands as an errored source run naming Shopify's own error, and never
rolls back your StoryOS-side edit — a retry re-pushes it.

**Social engagement** (Meta Page comments, X mentions, LinkedIn organization engagement) pulls
comments and mentions from those platforms into a database on the same schedule as any other
source. **This is ingest only** — it brings activity in; it does not post, reply, or otherwise
write back to the platform.

## Two-way sync: writing back to the provider

A source can also push your edits **out** to the provider, not just pull its data in — a field
mapped with direction `out` (push-only, never overwritten by a pull) or `both` sends its new value
back the moment you save it in StoryOS. This is opt-in and provider-specific: as of this writing,
**Shopify products** is the one provider that actually implements it. Setting it up is API/MCP-only
today — there's no web dialog toggle yet, so a source's `config` needs `write_back: true` set
directly (`update_source` / `create_source`, or a raw API call); an `out`/`both` field mapping alone
pushes nothing without it.

**Hold pushes for approval.** Set `require_approval_for_push: true` on the source's config and
every push waits in your **Inbox** instead of firing immediately — the same approval card
[a gated automation action](/concepts/automations/#sending-email) uses, showing a before→after
preview of exactly what would change. Approve it and the write goes out; reject it and nothing is
ever sent. Either way it's logged.

**Every push attempt is in the source's run log** — held, sent, rejected, or failed — with the
field-level diff, so there's a full audit trail of what StoryOS changed externally and who allowed
it, the same run history [any source](#while-it-runs) already keeps.

**A pull-caused push can't loop.** If StoryOS pulls a change, and that pull's own write would
trigger a push, and that push would somehow trigger another pull — the chain is capped at two hops
and refused rather than allowed to ping-pong forever; the run log names the cap when it's hit rather
than failing silently.

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
