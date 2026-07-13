# User stories

Legend: **[M]** MUST (v1 blocker) · **[S]** SHOULD (v1 if time, else fast-follow) · **[L]** LATER (parked, see [v1-scope.md](v1-scope.md)).

Personas: **builder** (admin), **member**, **guest** — see [vision.md](vision.md). Ticket mapping lives in [../../tickets/README.md](../../tickets/README.md).

## Epic A — Auth, workspace & membership

- **A1 [M]** As a builder, I want to sign up with email + password and create a workspace so that my company has a home.
  - Signup → email verification → "create workspace" (name, slug); creator becomes admin
  - Sessions via httpOnly cookie; the flow calls the public API only
- **A2 [M]** As a builder, I want to invite members by email with a role (admin / member) so that my team can work.
  - Invite creates pending membership + emails (or copyable link when SMTP is absent); re-invite resends; admin can revoke pending invites
- **A3 [M]** As a builder, I want to invite a guest scoped to specific spaces so that clients see only their own work.
  - Guest invite requires selecting ≥1 space; guest sees only those spaces' databases, records, views, entity pages
  - The API enforces scoping (not UI-only); unshared spaces return 404
  - Records in unshared spaces referenced by relations render as name-only chips, not navigable
- **A4 [M]** As an admin, I want to change roles and remove people so that access stays correct.
  - Removed users keep historical authorship (comments/activity show name, marked deactivated); last admin cannot demote themselves
- **A5 [M]** As any user, I want to log in / log out / reset password.
- **A6 [S]** As a builder, I want to configure SMTP for my self-hosted instance so invites and mention emails send. (Env-var config + test-send button; features degrade gracefully without it.)
- **A7 [S]** As a user, I want to update my profile (name, avatar) so mentions and person fields are recognizable.
- **A8 [S]** As a user, I want to sign in with Google (env-gated; hidden when the instance has no Google credentials).
- **A9 [L]** Multiple workspaces per user with a switcher. (v1: one workspace per instance; data model must not preclude many.)

## Epic B — Schema builder (spaces, databases, fields, relations)

- **B1 [M]** As a builder, I want to create a space (named group of databases) so the sidebar stays organized.
  - Workspace ships with a default "General" space; spaces have name + icon; databases belong to exactly one space; spaces reorderable
- **B2 [M]** As a builder, I want to create a database with a name and icon so I can model a new concept.
  - Created with the built-in title field and system fields; appears in sidebar under its space; default "All records" table view auto-created
- **B3 [M]** As a builder, I want to add fields of type text, number, single-select, multi-select, date, checkbox, user, url, email so records carry the data I need.
  - Each type has a config panel; fields have a display name and a stable auto-generated `api_name`; adding a field never rewrites existing records
- **B4 [M]** As a builder, I want to create a **relation field between two databases, choosing cardinality (one-to-many or many-to-many), with the inverse field appearing automatically on the other database** — the heart of the product.
  - Creating "Tasks.Project → Projects" auto-creates "Projects.Tasks" (collection) with sensible default names, both editable independently
  - Deleting either side deletes the whole relation after an explicit confirmation naming both fields
  - Self-relations (database → itself) and cross-space relations supported
- **B5 [M]** As a builder, I want to edit select options (add, rename, recolor, reorder, delete) so workflows evolve.
  - Options have stable IDs — renaming is O(1), no data rewrite; deleting warns with the count of records using it and clears the value on confirm
- **B6 [M]** As a builder, I want to rename / reorder / delete fields.
  - Deleting warns with record count; `api_name` stays stable across display renames; field order is per-database default, overridable per view
- **B7 [M]** As a builder, I want to rename, move (between spaces), and delete a database.
  - Delete requires typing the database name; deleting a database with inbound relations lists them and severs on confirm
- **B8 [S]** As a builder, I want to duplicate a database (schema only, or schema + records) to iterate on structure safely.
- **B9 [S]** As a builder, I want field descriptions (help text on the entity page) so members fill fields correctly.
- **B10 [S]** As a builder, I want a workspace-level schema overview (all databases + relations, as a list) to see the model at a glance.
- **B11 [L]** Formula and rollup fields · 1:1 cardinality · field validation rules (required, regex).

## Epic C — Data entry & views

- **C1 [M]** As a member, I want to create a record from any view (inline "+ New") so capture is instant.
  - New record inherits view context (kanban column sets the group-field value; unambiguous equality filters pre-fill); name edits inline
- **C2 [M]** As a member, I want a table view with inline editing of every field type so bulk data work is fast.
  - Click-to-edit cells per type; Enter commits, Esc cancels, arrow-key navigation; column resize/reorder persisted on saved views
- **C3 [M]** As a member, I want a kanban board grouped by a single-select field so I can run a workflow visually.
  - One column per option in option order + "No value" column; drag between columns updates the field; drag within a column persists manual order; cards show title + configurable fields
- **C4 [M]** As a member, I want to filter a view by any field so I see only what matters.
  - v1 UI filter model = flat AND list; per-type operators (see [../architecture/api-conventions.md](../architecture/api-conventions.md)); date supports relative values (today, next 7 days, this month); filters apply server-side
- **C5 [M]** As a member, I want multi-level sort (≤3 keys); absence of sort = manual order.
- **C6 [M]** As a member, I want to hide/show fields per view so views stay focused.
- **C7 [M]** As a builder, I want to save named views per database so the team shares consistent lenses.
  - Views store type + full config (filters, sorts, group-by, hidden fields, card fields, column widths); admins and members create/edit; guests read-only; every database keeps ≥1 view
- **C8 [M]** As a member, I want to set relation values via a searchable record picker so linking is effortless.
  - Searches target database by title; "+ Create '<name>'" inline; respects cardinality (single vs multi chips)
- **C9 [M]** As a member, I want to delete and restore records so mistakes aren't fatal.
  - Soft delete; excluded everywhere; per-database trash restores within 30 days; links to a trashed record hidden, restored intact
- **C10 [S]** As a member, I want a "me" token in user-field filters so one saved "My Tasks" view works for everyone.
- **C11 [S]** As a member, I want ad-hoc (unsaved) filter/sort tweaks on top of a saved view that don't persist for others.
- **C12 [S]** As a member, I want to group a board by a user field (columns = assignees).
- **C13 [S]** As a member, I want bulk-edit in table view (select N rows → set field / delete).
- **C14 [L]** Calendar/timeline/list/gallery views · OR/nested filter groups in UI · per-view manual ordering · CSV import/export UI.

## Epic D — Entity page & collaboration

- **D1 [M]** As a member, I want an entity page showing all fields plus a rich-text description so each record is a workspace of its own.
  - Opens as a peek panel from views and as a full page with a stable URL; field panel reuses table cell editors
  - Description = BlockNote document: headings, lists, checkboxes, code, quotes, links, inline images; single-editor with optimistic concurrency (409 + "reload or overwrite" banner) — explicitly NOT real-time collaborative
- **D2 [M]** As a member, I want relation fields on the entity page rendered as navigable linked-record sections so I can traverse the graph (Task → Project → Client).
  - To-many side renders as a mini-list with add / remove / create-inline; chips open the linked record; breadcrumb/back preserved
- **D3 [M]** As a member, I want to comment on a record so discussion lives with the work.
  - Chronological thread; author + timestamp; edit/delete own comments (admins can delete any)
- **D4 [M]** As a member, I want to @mention teammates in comments so I can pull people in.
  - `@` opens member picker (guests not mentionable in v1); mentioned user gets an email with excerpt + deep link when SMTP is configured, otherwise skipped with an admin banner
- **D5 [M]** As a member, I want an activity trail on each record so I can see what changed.
  - Events: record created, field changed (old → new, actor, time), relation linked/unlinked, comment added, record restored
  - Derived server-side in the same transaction as the mutation; never client-supplied; append-only
- **D6 [M]** As a member, I want to attach files to a record so briefs and assets live with the work.
  - Upload via button or drag-drop; list shows filename, size, uploader, date; download; delete; image thumbnails
  - Per-file size limit configurable (default 20 MB); storage = local disk or S3-compatible; no previews for non-images, no versioning
- **D7 [M]** As a guest, I want to comment on records I can see so client feedback happens in-tool.
- **D8 [S]** As a member, I want to copy a record link and see recently visited records.
- **D9 [L]** In-app notification inbox · comment threads & reactions · real-time presence/co-editing · description version history.

## Epic E — API & tokens

- **E1 [M]** As a builder, I want to create named API tokens (PATs) so machines can act.
  - Created in Settings → API; shown once; stored hashed; list shows name/created/last-used; revocable; inherits creator's role and guest scoping; `Authorization: Bearer mn_pat_...`
- **E2 [M]** As a developer, I want a versioned REST API (`/api/v1`) covering 100% of UI actions so anything is scriptable.
  - Resources: workspaces, spaces, databases, fields, relations, select options, records, views, documents, comments, attachments, members, invites, tokens, activity
  - UUIDv7 ids; cursor pagination; consistent error envelope; rate-limit headers
- **E3 [M]** As a developer, I want to query records with filters/sorts via the API using the same filter model as views.
  - `POST /databases/:id/records/query` with `{filter, sorts, q, cursor, limit}`; values keyed by stable `api_name`; relations returned as `{id, name}` chips with one-level `expand`
- **E4 [M]** As a developer, I want schema introspection (`GET /databases`, `GET /databases/:id` with fields + relation metadata) so generic clients (MCP servers!) adapt to any workspace.
- **E5 [M]** As a developer, I want an accurate OpenAPI 3.1 spec at `/api/v1/openapi.json` + reference docs at `/api/docs`.
  - Generated from the same route definitions the server enforces; examples per endpoint; a "Build an MCP server" guide
- **E6 [M]** As a developer, I want record create/update/delete via API, including linking/unlinking relations.
- **E7 [S]** As a developer, I want batch record creation (≤100 per call) so imports and scripts are efficient. (This is the the reference tool-migration path.)
- **E8 [S]** As an admin, I want basic per-token rate limiting so a runaway script can't take down the instance.
- **E9 [L]** Webhooks · scoped/read-only tokens · official published SDKs (community can generate from OpenAPI).

## Epic F — Onboarding & templates

- **F1 [M]** As a builder, I want to pick a starter template (Client Projects & Tasks / Content Pipeline / Blank) during workspace creation so I get value in minutes.
  - Template install = ordinary API calls; sample records clearly marked with a "Remove sample data" button
- **F2 [M]** As a builder, I want an empty-state checklist (create database → add relation → invite teammate → build a board) so first-session activation is guided.
- **F3 [S]** As a builder, I want to install a template into an existing workspace later (adds a new space).
- **F4 [L]** Community template gallery · export-workspace-as-template.

---

**Counts:** 27 MUST · 14 SHOULD · 10 LATER (51 stories).
