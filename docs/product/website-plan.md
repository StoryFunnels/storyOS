# storyos.dev — Marketing Website Plan

> Status: **planning + foundation**. The public front door at `storyos.dev` (app is
> `app.storyos.dev`, docs are `docs.storyos.dev` — see MN-105). Build tickets:
> **MN-110 … MN-137**.

## 1. Goals & audiences

**Goal:** convert the right people to *Start free* (`app.storyos.dev`), *Self-host*
(GitHub), or *Talk to us* — and make the **agentic business OS** positioning land in 5
seconds. Secondary: rank for "open-source work OS / Notion-alternative / self-hosted
database" and be the obvious answer when someone wants AI agents on their own data.

**Audiences:**
- **The builder / ops lead** (JCM-style) — wants to model their business and stop paying
  per-seat for a closed tool.
- **The technical founder / self-hoster** — wants open source, API-first, data ownership.
- **The AI-forward operator** (marketer/agency) — wants agents running their workflows on
  structured data (the differentiator).

## 2. Tech decision

**Astro** for `storyos.dev` (marketing) + **Astro Starlight** for `docs.storyos.dev`.
Content-first, near-zero JS (Lighthouse 95+), markdown/MDX-native, islands for the few
interactive bits, deploys independently. Tailwind with the ported StoryOS tokens.

### Repo split (decided) — the marketing site is NOT in the open-source repo
- **`storyos-website` (private repo)** → the **marketing site** (`storyos.dev`). It's a
  business/brand asset — keeping it out of the AGPL OSS repo means competitors can't fork
  our go-to-market, self-hosters don't pull it, and analytics/CRM secrets stay private.
- **`storyOS` (public OSS repo)** → keeps the **docs**: `docs/` content stays here (it
  documents the open product and versions with the code), and the Starlight docs-site
  build lives in **`apps/docs`** → `docs.storyos.dev`. Only the marketing site splits out.
- **Design sharing**: copy the ~15 brand CSS vars (cream/navy/gold + Figtree) into the
  website repo — trivial, no shared package. (A tiny `@storyos/tokens` package later if needed.)

### Hosting — **Cloudflare Pages** (both sites; DNS already on Cloudflare)
Git-connected, free, per-PR preview deploys, great for static Astro. `storyos-website`
repo → `storyos.dev`; OSS `apps/docs` → `docs.storyos.dev`. (Vercel/Netlify equivalent.)

## 3. Design system (port from the app)

Brand tokens (from `apps/web/src/app/globals.css`) — reuse verbatim so site and app feel
like one product:

| Token | Value | Use |
|---|---|---|
| App / page bg | `#faf7f1` (warm cream) | page background |
| Surface / card | `#ffffff` | cards, panels |
| Sidebar / muted | `#f4efe5` | alternating sections |
| Ink / primary | `#0f1729` (navy) | text, primary buttons |
| Accent | `#d4a017` (gold) | highlights, links, CTAs |
| Accent hover / soft | `#e8b830` / `#fbf3d8` | hover, tints |
| Radius | 6 / 8 / 12px | controls / cards / modals |
| Type | **Figtree** (+ system fallback) | everything |

- **Type scale**: display (hero) → h1 → h2 → h3 → body → small; generous line-height,
  tight display tracking. One font (Figtree) at multiple weights.
- **Components**: `Button` (primary navy / accent / ghost), `Container`, `Section`
  (alternating cream/white), `Nav`, `Footer`, `Card`, `Badge`, `FeatureRow`, `Stat`,
  `Tabs` (for the view switcher), `CodeBlock`, `CTA`.
- **Motion**: restrained — fade/slide on scroll, subtle hover lifts. No gratuitous parallax.
- **Dark mode**: ship both (the app is theme-aware); default follows system.
- **Imagery**: real product screenshots (the app's warm UI is the hero), plus simple
  diagrams for the agentic loop. Every image `<img>` optimized + responsive.

## 4. Sitemap / IA

```
storyos.dev
├─ /                      Home (the pitch)
├─ /product              Product overview (databases · relations · views)
│  └─ /product/views     The 8 view types, deep
├─ /agents               The agentic OS story (the differentiator)  ★
├─ /templates            Template packs gallery
├─ /use-cases           Solutions hub
│  ├─ /use-cases/marketing
│  ├─ /use-cases/agency
│  ├─ /use-cases/sales
│  └─ /use-cases/creators
├─ /pricing             Tiers (MN-107)
├─ /self-host           Own your data → GitHub + docs
├─ /ai                  Use with Claude / ChatGPT (MCP)
├─ /about              Vision / manifesto ("capability is never paywalled")
├─ /blog               Changelog + posts (content collection)
├─ /legal/privacy · /legal/terms · /legal/license (AGPL)
└─ CTAs everywhere → app.storyos.dev (Start free) · GitHub · docs.storyos.dev

docs.storyos.dev  (Starlight)
├─ Getting started · Self-hosting · Templates · Formulas · Automations
├─ Use with Claude/ChatGPT (MCP)  ★
└─ API reference (from OpenAPI)
```

## 5. Home page — section order

1. **Hero** — "The agentic operating system for your business." Subhead: model your
   business in real databases; run it with AI agents. CTAs: *Start free* · *Self-host*.
   Visual: a real workspace + an agent acting in it.
2. **What it is** — databases + real relations + one dataset, many views.
3. **View-type switcher** — Table / Board / Calendar / Gallery / List / Feed / Timeline /
   Form (tabbed, screenshots).
4. **The agentic layer** ★ — MCP = the agent's hands; the workspace = its memory; the
   loop diagram; "works with Claude & ChatGPT today."
5. **Templates** — install a whole business in a click (agency, marketing, sales, …).
6. **Own your data** — open source (AGPL), self-host, API-first, no lock-in.
7. **Pricing peek** — free/self-host forever; cloud + AI tiers.
8. **Final CTA** + newsletter.

## 6. What we'll have soon (feature narrative to sell)

Ship-ready today: 8 view types, relations, lookups, rollups, formulas, buttons,
automations, comments/mentions, attachments + editor image uploads, templates/packs,
CSV import, GitHub + Linear import, PATs, **the MCP server (read+write)**, self-host.
Coming (roadmap, foreshadow honestly): **agentic workflows** (`run_agent`, agent packs —
MN-109), **hosted MCP** (MN-106), email/notifications (MN-103), more integrations
(Slack, Google Calendar, native StoryFunnels/StoryPages — MN-099), forms v2 with public
sharing/embed (MN-101), admin/billing (MN-104/107). The site sells the vision but only
*claims* what's shipped; roadmap items are clearly framed as coming.

## 7. Non-negotiables

- **Performance**: Lighthouse ≥ 95 all categories; fonts self-hosted; images responsive.
- **SEO**: per-page title/description/OG, JSON-LD, `sitemap.xml`, `robots.txt`, canonical.
- **Analytics**: privacy-first (Plausible/Umami), no cookie-wall.
- **A11y**: semantic, keyboard-navigable, contrast-checked, reduced-motion honored.
- **Responsive**: mobile-first; the view switcher and nav collapse cleanly.

## 8. Build sequence (batches → tickets)

Implement in batches; **test + critique after each ticket** (the founder's rule).

- **Batch 1 — Foundation**: MN-110 scaffold · MN-111 design tokens/layout · MN-112 core
  components · MN-113 nav+footer · MN-114 SEO/OG framework · MN-115 analytics.
- **Batch 2 — Home**: MN-116 hero · MN-117 what-it-is · MN-118 view switcher · MN-119
  agentic section · MN-120 templates · MN-121 self-host/cloud · MN-122 open-source ·
  MN-123 final CTA + newsletter.
- **Batch 3 — Sub-pages**: MN-124 product + views · MN-125 agents page · MN-126 use-cases
  hub + 4 solution pages · MN-127 pricing · MN-128 AI/MCP page · MN-129 templates gallery
  · MN-130 self-host page · MN-131 about/manifesto · MN-132 blog/changelog · MN-133 legal.
- **Batch 4 — Docs**: MN-134 Starlight scaffold on docs.storyos.dev · MN-135 docs content
  + nav · MN-136 API reference from OpenAPI.
- **Batch 5 — Launch**: MN-137 deploy (storyos.dev + docs.storyos.dev, preview deploys) ·
  MN-138 perf/Lighthouse · MN-139 a11y/responsive pass · MN-140 per-page OG images.
