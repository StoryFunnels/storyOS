# v1 scope

The single source of truth for what v1 is. Anything not in the IN list is OUT, even when tempting.

## In v1

- **Workspace & people:** one workspace per instance (data model supports many; UI doesn't), email/password auth + env-gated Google OAuth, invites, roles **admin / member / guest**. Guests = read + comment, scoped to selected **spaces**.
- **Spaces:** named groups of databases; the unit of sidebar organization, template installation, and guest scoping.
- **Custom databases** with fields: title (built-in), text, number, single/multi select, date (± time), checkbox, user (single/multi), url, email, and system fields (created/updated at, created by).
- **Relations:** first-class, bidirectional (paired inverse fields), one-to-many and many-to-many, self-relations, cross-space relations.
- **Views:** Table (virtualized, inline edit) and Kanban (grouped by single-select, drag & drop). Filters (flat AND in UI; and/or ≤3 deep in API), multi-sort (≤3), hidden fields, saved named views per database.
- **Entity page:** fields panel, BlockNote rich-text description (single-editor, optimistic concurrency), navigable relation sections, comments with @mentions (email if SMTP configured), activity trail, attachments strip.
- **Attachments (tightly scoped):** upload/download/delete per record, image thumbnails, size caps, local-disk or S3-compatible storage. No file field type, no previews beyond images, no versioning, no folders.
- **Records lifecycle:** soft delete + 30-day per-database trash & restore.
- **API:** full `/api/v1` REST coverage of every UI action, filter-AST query endpoint, keyset cursors, personal access tokens, rate limiting, OpenAPI 3.1 + Scalar docs, generated TS SDK, batch record create.
- **Search:** `q=` title search (ILIKE + trigram) in record pickers and record lists. Nothing more.
- **Self-hosting:** `docker compose up -d` → Postgres + API + web (+ optional MinIO). Migrations run on boot. Documented backup/upgrade.
- **Templates:** Client Projects & Tasks, Content Pipeline, Blank — installed via ordinary API calls, with removable sample data and an onboarding checklist.

## Out of v1 — parking lot (v2+)

- Formulas & rollups; field validation rules (required/regex); 1:1 cardinality
- Automations / rules / recurring tasks
- Webhooks & event subscriptions (the `activity_events` table makes this a v1.1 add — [ADR-0004](../decisions/ADR-0004-no-webhooks-v1.md))
- Real-time co-editing, presence, live cursors (v1: refetch/polling + optimistic updates)
- Per-field / per-record / per-database permissions; custom roles; "lock schema to admins" toggle
- Calendar, timeline, list, gallery, chart views; dashboards
- OR / nested filter groups in the UI (API supports nesting; UI stays flat AND)
- Per-view manual ordering (one manual order per database in v1 — [ADR-0005](../decisions/ADR-0005-record-ordering.md))
- CSV import/export UI (migration from Fibery/spreadsheets happens via API batch-create)
- In-app notification inbox; comment threads & reactions; description version history
- Public share links & public forms; whiteboards
- File management beyond the attachments strip (folders, previews, quotas UI, file field type)
- SSO/SAML/OIDC beyond Google; SCIM; scoped/read-only API tokens; official published SDKs
- Full-text search across descriptions/comments (**known gap** — fast-follow candidate)
- Multi-workspace UI; i18n; mobile apps (responsive web only)
- AI features (the future paid layer); MCP server package (community can build on the API meanwhile)

## Known gaps accepted for v1

- No workspace-wide search beyond record titles.
- No notification center: mentions rely on email (SMTP-configured instances).
- Concurrent description edits resolve via 409 + "reload or overwrite" — no merging.
