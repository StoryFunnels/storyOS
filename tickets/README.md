# v1 backlog

32 tickets, sequenced for a solo founder + AI agents. **Walking skeleton** (curl-able API end to end) lands at MN-012; first demo-able UI slice at MN-016; full v1 at MN-032. Work them in order unless `depends_on` says otherwise; parallel tracks are possible after MN-012 (backend track MN-018/020/022/024 vs UI track MN-014→017).

## Conventions

- One file per ticket: `MN-###-slug.md`
- YAML frontmatter:

```yaml
---
id: MN-001
title: Monorepo scaffold
status: todo        # todo | in_progress | done
depends_on: []      # ticket ids
size: S             # S | M | L
---
```

- Body: one-paragraph description + acceptance criteria (3–6 bullets) + pointers into docs/.
- An agent can be pointed at a ticket file as the work spec; PRs/commits reference the ID (`MN-012: ...`).
- When a ticket ships, flip `status: done` in the same PR.

## Sequence

| # | Ticket | Size | Depends on |
|---|---|---|---|
| MN-001 | [Monorepo scaffold](MN-001-monorepo-scaffold.md) | S | — |
| MN-002 | [Docs skeleton in-repo + founding ADRs](MN-002-docs-and-adrs.md) | S | 001 |
| MN-003 | [CI pipeline](MN-003-ci-pipeline.md) | S | 001 |
| MN-004 | [Postgres + Drizzle foundation + test harness](MN-004-postgres-drizzle-foundation.md) | M | 001 |
| MN-005 | [API skeleton: config, errors, OpenAPI plumbing](MN-005-api-skeleton.md) | M | 004 |
| MN-006 | [Auth: email/password + sessions](MN-006-auth-email-password.md) | M | 005 |
| MN-007 | [Google OAuth (env-gated)](MN-007-google-oauth.md) | S | 006 |
| MN-008 | [Workspaces, spaces, memberships, roles, invites](MN-008-workspaces-spaces-memberships.md) | M | 006 |
| MN-009 | [Databases CRUD](MN-009-databases-crud.md) | S | 008 |
| MN-010 | [Fields CRUD + select options](MN-010-fields-and-options.md) | M | 009 |
| MN-011 | [Records CRUD (JSONB) + value validator](MN-011-records-crud.md) | L | 010 |
| MN-012 | [Records query engine](MN-012-records-query-engine.md) | L | 011 |
| MN-013 | [Generated SDK package](MN-013-sdk-package.md) | S | 012 |
| MN-014 | [Web skeleton: auth + app shell](MN-014-web-skeleton.md) | M | 013 |
| MN-015 | [Sidebar, spaces & database management UI](MN-015-sidebar-and-management-ui.md) | M | 014 |
| MN-016 | [Table view (virtualized, inline edit)](MN-016-table-view.md) | L | 015 |
| MN-017 | [Field management UI](MN-017-field-management-ui.md) | M | 016 |
| MN-018 | [Relations backend](MN-018-relations-backend.md) | L | 011 |
| MN-019 | [Relations UI](MN-019-relations-ui.md) | M | 016, 018 |
| MN-020 | [Views backend](MN-020-views-backend.md) | M | 012 |
| MN-021 | [Filters, sorts & saved views UI](MN-021-filters-sorts-views-ui.md) | L | 016, 020 |
| MN-022 | [Record ordering + move endpoint](MN-022-record-ordering-move.md) | S | 011 |
| MN-023 | [Kanban view UI](MN-023-kanban-view.md) | L | 021, 022 |
| MN-024 | [Documents backend (descriptions)](MN-024-documents-backend.md) | M | 011 |
| MN-025 | [Entity page UI](MN-025-entity-page.md) | L | 019, 024 |
| MN-026 | [Comments + @mentions](MN-026-comments-mentions.md) | M | 025 |
| MN-027 | [Activity log](MN-027-activity-log.md) | M | 025 |
| MN-028 | [API tokens (PATs) + rate limiting](MN-028-api-tokens-rate-limiting.md) | M | 008 |
| MN-029 | [Attachments backend](MN-029-attachments-backend.md) | M | 011 |
| MN-030 | [Attachments UI](MN-030-attachments-ui.md) | S | 025, 029 |
| MN-031 | [Self-host: Docker images + compose](MN-031-docker-self-host.md) | M | 014, 029 |
| MN-032 | [Seed templates + onboarding](MN-032-templates-onboarding.md) | M | 018, 023, 026 |

## MUST-story → ticket mapping

Every [M] story in [docs/product/user-stories.md](../docs/product/user-stories.md) is covered:

| Stories | Tickets |
|---|---|
| A1, A5 (signup, login) | MN-006, MN-014 |
| A2–A4 (invites, guests, roles) | MN-008, MN-015 |
| B1 (spaces) | MN-008, MN-015 |
| B2, B7 (databases) | MN-009, MN-015 |
| B3, B5, B6 (fields, options) | MN-010, MN-017 |
| B4 (relations) | MN-018, MN-019 |
| C1, C2 (record entry, table) | MN-011, MN-016 |
| C3 (kanban) | MN-022, MN-023 |
| C4–C7 (filters, sorts, hidden fields, saved views) | MN-012, MN-020, MN-021 |
| C8 (record picker) | MN-019 |
| C9 (trash & restore) | MN-011, MN-015 |
| D1, D2 (entity page, relation traversal) | MN-024, MN-025 |
| D3, D4, D7 (comments, mentions, guest comments) | MN-026 |
| D5 (activity) | MN-027 |
| D6 (attachments) | MN-029, MN-030 |
| E1 (PATs) | MN-028 |
| E2–E6 (API coverage, query, introspection, OpenAPI) | MN-005, MN-009–012, MN-018 |
| F1, F2 (templates, onboarding) | MN-032 |

## Post-v1 tickets (all done)

| # | Ticket | Size | Depends on |
|---|---|---|---|
| MN-033 | [Template-first onboarding — nobody starts from blank](MN-033-template-first-onboarding.md) | L | 032 |
| MN-034 | [Access grants — Fibery-style roles at space + database level](MN-034-access-grants.md) | L | 032 |
| MN-035 | [Agency template packs + Task DNA installer](MN-035-agency-template-packs.md) | L | 033, 034 |
| MN-036 | [Creators template packs](MN-036-creators-template-packs.md) | M | 035 |
| MN-037 | [Dev template packs](MN-037-dev-template-packs.md) | M | 035 |

## Field & editing UX wave (founder feedback 2026-07-09)

| # | Ticket | Size | Depends on |
|---|---|---|---|
| MN-038 | [Date picker v2 — one-click popover with type-to-parse](MN-038-date-picker.md) | M | — |
| MN-039 | [Add-field affordance in the table header](MN-039-add-field-affordance.md) | S | — |
| MN-040 | [Lookup fields — related record's field through a relation](MN-040-lookup-fields.md) | L | 018 |
| MN-041 | [Rich Text field type — separated from plain Text](MN-041-rich-text-fields.md) | M | 025 |
| MN-042 | [Hide and reorder fields — entity pages and views](MN-042-hide-reorder-fields.md) | M | — |

## Team-adoption wave (planned 2026-07-09 — computed fields, identity, automation, daily-driver surfaces)

Goal: everything JCM needs to move its daily work in. Sources: founder asks (formulas, icons, avatars, buttons, workflows) + a Linear feature review (command palette, inbox/My Issues, batch editing, keyboard fluency) + the two adoption gates (calendar for content, CSV import from Fibery).

| # | Ticket | Size | Depends on |
|---|---|---|---|
| MN-043 | [Formula fields + user docs](MN-043-formula-fields.md) | XL | 040 |
| MN-044 | [Icons and colors for databases and spaces](MN-044-icons-and-colors.md) | M | — |
| MN-045 | [User avatars everywhere people appear](MN-045-user-avatars.md) | M | 029 |
| MN-046 | [Button fields — one-click manual actions](MN-046-buttons.md) | L | — |
| MN-047 | [Automations — event + scheduled rules](MN-047-automations.md) | XL | 046 |
| MN-048 | [Global search + command palette (Cmd+K)](MN-048-command-palette-search.md) | L | — |
| MN-049 | [Notifications inbox + My Work](MN-049-inbox-my-work.md) | L | 045 |
| MN-050 | [Table power pack — multi-select, batch edit, shortcuts](MN-050-table-power.md) | L | — |
| MN-051 | [Calendar view](MN-051-calendar-view.md) | L | 038 |
| MN-052 | [CSV import + Fibery migration guide](MN-052-csv-import.md) | L | — |

Suggested order: 044 → 045 → 048 → 050 → 049 → 051 → 052 → 046 → 047 → 043 (visual quick wins → daily-driver surfaces → adoption gates → automation stack → formulas last, hardest and depends on the lookup machinery being battle-tested).

Template catalog plan (agency + creators packs): [docs/product/template-library.md](../docs/product/template-library.md).

## Post-v1 parking lot (ADR-noted, not ticketed)

Webhooks (outbox exists — [ADR-0004](../docs/decisions/ADR-0004-no-webhooks-v1.md)) · formulas/rollups · automations · realtime (polling → SSE) · per-view ordering · RLS · full-text search on documents · MCP server package · CSV import UI.
