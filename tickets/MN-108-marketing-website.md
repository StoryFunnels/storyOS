---
id: MN-108
title: Marketing website + docs site on storyos.dev
status: todo
depends_on: [MN-105, MN-107]
size: M
---

## Why

The **apex `storyos.dev` is the marketing site** — a front door that is NOT the app
(the app lives on `app.storyos.dev`, docs on `docs.storyos.dev` — see MN-105). It sells
the vision (agentic business OS), shows the product, and routes to sign-up / self-host /
docs.

## Scope

**Marketing site** (`storyos.dev`):
- Hero: "the agentic operating system for your business" — the one-liner + a strong
  visual (a real workspace + an agent working in it).
- Sections: what it is (databases + views + relations), the 8 view types, templates /
  packs, **the agentic story** (MN-109) as the differentiator, self-host vs cloud,
  open-source (AGPL), pricing (MN-107), social proof / screenshots.
- CTAs: **Start free → app.storyos.dev** · Self-host (GitHub) · Read the docs
  (docs.storyos.dev) · Use with Claude (MCP).
- SEO/OG (reuse MN-067 branding), fast, static-first.

**Docs site** (`docs.storyos.dev`):
- Generate from the repo `docs/` (a static docs generator — e.g. Nextra / Docusaurus /
  Astro Starlight). Guides: getting started, self-hosting, templates, formulas,
  automations, **use with Claude/ChatGPT (MCP)**, API reference (from OpenAPI).

## Build approach
- Keep it separate from the app (its own small Next/Astro project or a `apps/marketing`)
  so it deploys independently and stays fast. Decide in ticket.

## Acceptance criteria
- [ ] storyos.dev landing live with the vision, product, pricing, and clear CTAs.
- [ ] docs.storyos.dev live, generated from `docs/`, incl. the MCP guide + API reference.
- [ ] Branding/OG/SEO consistent; both fast and mobile-clean.
