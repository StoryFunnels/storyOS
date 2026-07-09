---
id: MN-048
title: Global search + command palette (Cmd+K)
status: todo
depends_on: []
size: L
---

**Problem.** No way to find a record by name across databases; navigation is sidebar-only. Linear's single most-loved surface is Cmd+K: search + navigate + act from the keyboard, and a team living in the tool hits it hundreds of times a day.

**Research.** Linear: one palette for everything — fuzzy search over issues/projects, then contextual actions ("assign to…", "change state…") ranked by context; recent items when empty; sub-100ms feel. Notion: Cmd+K = search-first with recent pages, quick create. Slack: Cmd+K channel switcher. Synthesis: **one modal, three row kinds (records, places, actions), recents-when-empty, fully keyboard driven, backed by a fast title search endpoint**.

**Design.**

- API: `GET /workspaces/:ws/search?q=` — trigram/ILIKE search over `records.title` (GIN index exists) scoped to the caller's visible databases (access grants respected), plus database/space name matches; returns top 20 grouped by database.
- Web: `Cmd+K` / `Ctrl+K` opens the palette (own component; no cmdk dependency): input, grouped results (Records / Databases & spaces / Actions), arrow-key navigation, Enter opens.
- Actions in v1: "New record in <current database>", "New database", "Browse templates", "Invite people", "Go to settings". Contextual: current database's views listed for quick switching.
- Empty state: 10 most recently updated records the user can see.
- Latency: debounced 150ms, results streamed from one endpoint; measure p50 < 150ms on 50k records.

## Acceptance criteria

- [ ] Search endpoint with access-grant scoping + p50 < 150ms @ 50k records (perf test)
- [ ] Cmd+K everywhere in the app; keyboard-only flow (arrows, Enter, Escape)
- [ ] Records grouped by database with icons; databases/spaces navigable; actions section incl. quick create
- [ ] Recents on empty query; guests only see what their grants allow (test)
