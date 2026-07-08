---
id: MN-033
title: Template-first onboarding — nobody starts from blank
status: done
depends_on: [MN-032]
size: L
---

**Problem (from the first real user session, 2026-07-08):** templates are only offered at workspace creation. Every later entry point — "+ New database", "New space" — produces a blank, title-only database. The founder created three databases and landed on empty grids. Nobody wants to start with a blank space; blank is the fallback, never the default path.

**Principle:** every creation surface leads with templates and keeps "Blank" as an explicit, equal option. Templates must show what they install *before* installing (databases, fields, views — a schema preview card, not just a name).

## Scope

**Template model** (backend):
- Two template scopes: **packs** (multi-database + relations, install into a new space — what exists today) and **single-database templates** (one database with fields/options/views, install into a chosen space).
- `GET /templates` gains `scope`, `category` (agency, creators, dev, …) and returns a schema preview payload (databases → field names/types, views, relation summary).
- `POST /workspaces/:ws/templates/:slug/apply` accepts `{ space_id? }` for database-scoped templates; sample data optional via `{ include_samples: boolean }` (default true).
- Template definitions move to a `category` + `scope`-tagged registry (see docs/product/template-library.md for the catalog).

**The intent question** (founder direction, 2026-07-08): the gallery leads with
**"What are you working on?"** — running an agency / onboarding a new client /
starting a dev project / launching a blog / writing a book / coaching /
consulting / something else. Each intent maps to a (template, scope) install;
"Onboarding a new client" is a RECURRING job: it installs a **Client Space**
(space-scoped, client-shareable) with the space pre-named after the client and
finishes on the guest-invite dialog (spaces are the guest-scoping unit,
ADR-0006). Intent mapping lives in docs/product/template-library.md.

**Entry points** (web):
1. **New database dialog** → two tabs: "From template" (gallery filtered to scope=database + the databases of packs, installable individually) / "Blank". Template cards show field chips + view badges.
2. **New space** → after naming, offer "Start this space from a template pack" (or empty).
3. **Workspace home empty state** → template gallery front and center (replaces the current text-only checklist step 1).
4. **Workspace creation** (exists) → upgrade the picker to the same gallery component with schema previews and category filter.
5. A blank database's empty grid gets a "Structure this database from a template" affordance until it has ≥1 non-title field.

**Explicitly out:** community/user-defined templates (export-workspace-as-template stays v2 parking lot); AI schema suggestions (future paid layer — note the seam: the gallery component should accept a dynamically generated template object).

## Acceptance criteria

- [ ] Creating a database from the sidebar defaults to the template gallery; "Blank" is one click, never removed
- [ ] Template cards preview the full schema (fields with types, views, relations) before install
- [ ] A pack's individual databases are installable standalone into any space (relations to non-installed databases are skipped with a note)
- [ ] `include_samples: false` installs structure only; sample records remain tracked/removable as today
- [ ] The gallery opens with the intent question; every intent installs the mapped template at the right scope; "New client" pre-fills the space name and ends on the guest-invite dialog
- [ ] Categories filter the gallery (agency / creators / dev)
- [ ] Task-DNA databases install with self-relations (Parent/Blocked-by) and 'me'-filtered saved views working
- [ ] Empty-state surfaces: workspace home and blank-database grid both route into the gallery
- [ ] Integration tests: database-scoped install into an existing space; pack install with samples off; preview payload matches what install creates
