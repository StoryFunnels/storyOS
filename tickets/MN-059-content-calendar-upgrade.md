---
id: MN-059
title: Content Calendar upgrade — Calendar Moments + Platforms database
status: todo
depends_on: [MN-053]
size: S
---

Fibery `content-calendar`: Calendar moment, Content, Platform. The stealable idea = **Moments** (holidays, launches, awareness days) as records content attaches to.

**Changes to social-calendar pack:** add Moments 📅 db (Date, Kind select Holiday/Launch/Awareness Day/Season, Notes) one_to_many to Posts; add Platforms 📣 db (Specs rich_text — image sizes, char limits; Handle url) many_to_many to Posts (keeps the existing Channel multi-select for quick filtering; guide explains both); Posts calendar view exists since MN-051.
**Guide:** plan Moments a quarter out; hang Posts on Moments; the calendar is the source of truth.

## Acceptance criteria
- [ ] Pack updated + guide
