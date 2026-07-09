---
id: MN-053
title: Template guide docs — every pack ships a README that teaches the workflow
status: done
depends_on: []
size: M
---

**From the Fibery review:** every Fibery template ships explanatory docs ("tips from fellow creators"); our packs install silently. Founder: "we need to have those documents with templates as well."

## Design
- `TemplateDef.guide: string` (markdown) — the workflow explanation: what the databases are, how they relate, the day-1 loop, customization tips.
- Gallery detail panel renders the guide above the schema preview (simple markdown-lite renderer: headings, bold, lists).
- After install, the response carries `guide`; the web shows a "How this works" panel on the landing database (dismissable) — v1: the gallery is the canonical home, plus a "Guide" button on the database header for template-created databases (store `template_slug` on the space? v1: skip persistence, gallery only + install toast linking back).

## Acceptance criteria
- [ ] All packs carry guides (written per template ticket)
- [ ] Gallery detail renders the guide (markdown-lite)
- [ ] API /templates returns guide text
