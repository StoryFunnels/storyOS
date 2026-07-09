---
id: MN-067
title: StoryOS branding — logo, favicon, OG image, SEO meta
status: todo
depends_on: []
size: S
---

Founder: "we need the StoryOS Logo (and favicon, and OG) so please make sure you place that seo/design style of things around." Current state: a letter-"S" navy square, no favicon file, no social cards, default Next metadata.

## Design
- **Logo**: SVG wordmark + mark. Mark concept: an open-book / stacked-pages "S" in the warm palette (navy #0F1729 + gold #D4A017 on warm white #FAF7F1) — geometric, flat, works at 16px. Variants: mark-only, mark+wordmark (Figtree), dark + light.
- **Favicon**: /favicon.ico (multi-size) + favicon.svg + apple-touch-icon.png (180) generated from the mark.
- **OG image**: 1200×630 static (mark + wordmark + "The open-source work OS" on warm canvas) at /og.png; twitter:card summary_large_image.
- **Metadata**: Next `metadata` export in root layout — title template "%s · StoryOS", description, openGraph + twitter, icons, theme-color #FAF7F1.
- Replace the sidebar/workspace-switcher "S" square and auth-card logo with the mark.

## Acceptance criteria
- [ ] SVG mark + wordmark committed under apps/web/public/brand/
- [ ] favicon.ico/svg + apple-touch-icon served; browser tab shows the mark
- [ ] /og.png + full Next metadata (OG/Twitter/theme-color); login page + sidebar use the logo
