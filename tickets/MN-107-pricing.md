---
id: MN-107
title: Pricing & packaging — how StoryOS makes money
status: todo
depends_on: []
size: M
---

## Principle (from vision.md)

**Capability is never paywalled.** The full engine — databases, relations, views,
automations, MCP, the agent runtime — is open-source (AGPL) and self-hostable for free,
BYO model key. We monetize **operating it for you**, not the features.

## What we sell (draft — decide the numbers)

- **Free / Self-host** — the whole product, run it yourself. $0. (Drives adoption +
  the open-source story; AGPL keeps hosted forks honest.)
- **Cloud Starter** — hosted, small team, sane limits (workspaces, storage, members,
  API/MCP calls). Low per-seat or flat per-workspace.
- **Cloud Team / Pro** — more seats, more storage, priority support, hosted MCP endpoint,
  SSO (later). Per-seat.
- **AI / Agentic add-on** — the money tier tied to [MN-109]: hosted model access
  (metered by tokens/runs), prebuilt agentic packs, run observability. Usage-based on
  top of a plan. This is where the vision monetizes.
- **Enterprise / dedicated** — per-customer isolated instance, custom limits, SLA,
  DPA/security review, invoicing. Annual.

## Open questions to resolve
- Per-seat vs per-workspace vs usage — likely **hybrid** (seat for collaboration,
  usage for AI). Where's the free-tier ceiling?
- Trial shape (14-day Pro? free tier forever + AI paid?).
- Billing stack (Stripe) + dunning + tax — ties to the admin panel (MN-104).
- Competitive anchors: the reference tool (~$10–17/mo/user), Airtable ($20–45), Notion ($8–15),
  Linear ($8–14). Position below the reference tool on base, differentiate hard on AI/agents.

## Deliverable
- A pricing page-worthy tier table + limits matrix, the metering model for AI, and the
  Stripe/entitlements plan the admin panel enforces. Then a `docs/product/pricing.md`
  and the marketing pricing page (MN-108).

## Acceptance criteria
- [ ] Tiers + limits matrix decided and written up; free/self-host stays fully capable.
- [ ] AI/agentic metering model defined (what's counted, how it's capped).
- [ ] Billing/entitlements approach chosen (Stripe + plan flags the app reads).
