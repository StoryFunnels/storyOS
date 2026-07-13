# Meta-model — the canonical data model

The schema-of-schemas: how the system models user-defined structure. All entities are API resources with UUIDv7 ids and `created_at` / `updated_at`. System tables sketch at the bottom.

## Entities

### Workspace
The tenant boundary. `name`, `slug`, `settings` (SMTP status, attachment limits). Has many: Spaces, Memberships, ApiTokens. v1 UI supports one workspace per instance, but everything is workspace-scoped in the data model so multi-workspace is additive later.

### Space
A named group of databases and **the unit of guest scoping and template installation**. `workspace_id`, `name`, `icon`, `position`. Every database belongs to exactly one space; a "General" space is auto-created. Rationale in [ADR-0006](../decisions/ADR-0006-spaces.md).

### Database
A user-defined type ("Tasks", "Articles"). `space_id`, `name`, `icon`, `api_slug` (stable). Has many: Fields, Records, Views. Always owns one built-in title field (required, undeletable) and system fields.

### Field
A column definition. `database_id`, `display_name`, `api_name` (stable slug, unique per database, auto-generated, admin-editable with warning), `type`, `config` (JSONB, type-specific), `position`, `is_system`, `deleted_at` (soft delete).

| Type | Config |
|---|---|
| `title` | — (built-in, one per database) |
| `text` | `{multiline: bool}` |
| `number` | `{precision, format: plain\|percent\|currency, currency_code?}` |
| `select` / `multi_select` | options live in SelectOption |
| `date` | `{include_time: bool}` |
| `checkbox` | — |
| `user` | `{multi: bool}` |
| `url`, `email` | — |
| `relation` | `{relation_id, side: a\|b}` |
| `created_at`, `updated_at`, `created_by` | system, read-only |

### SelectOption
First-class rows with stable IDs — **never inline strings**. `field_id`, `label`, `color`, `position`. Records store option **ids**: renaming an option is O(1) and instant; kanban column order = option order; deleting an option is an explicit, counted operation.

### Relation
First-class object: `workspace_id`, `database_a_id`, `database_b_id`, `field_a_id`, `field_b_id`, `cardinality` (`one_to_many` | `many_to_many`; side `a` is the "many" side for one_to_many). Creating a relation always creates **two** relation-fields (one per database) pointing at the shared `relation_id`. Self-relations (`database_a == database_b`) and cross-space relations allowed. 1:1 deferred.

Why paired-inverse-fields (the reference tool/Airtable model): uniform rendering (views iterate `fields[]`, no special cases), both directions always navigable by construction (no orphaned one-way links), clean introspectable API for generic clients/MCP, one source of truth for links.

### RecordLink
One row per link: `relation_id`, `from_record_id`, `to_record_id`. `UNIQUE (relation_id, from_record_id, to_record_id)`; partial unique index on `(relation_id, from_record_id)` when cardinality is one_to_many; `ON DELETE CASCADE` from records. One row serves both sides — no dual-write divergence; reverse lookups are indexed queries; relation filters compile to `EXISTS`.

### Record
A row. `database_id`, `title` (promoted real column — makes search, pickers, and activity rendering trivial), `values` (JSONB keyed by field UUID — see [record-storage.md](record-storage.md)), `position` (fractional index), `created_by`, `updated_by`, `deleted_at` (soft delete, 30-day trash). Relation values are **not** in `values` — they live in RecordLink, joined at read time.

### Document
The entity description, 1:1 with a record, lazily created. `record_id`, `content` (BlockNote JSON), `content_text` (extracted plain text for future search). Single-editor: optimistic concurrency via expected `updated_at`/version → 409 on mismatch, UI offers reload/overwrite. Size-capped (~2 MB).

### View
`database_id`, `name`, `type` (`table` | `board`), `position`, `created_by`, `config` JSONB:

```json
{
  "filters": { "and": [ {"field": "<field_id>", "op": "eq", "value": "<opt_id>"} ] },
  "sorts": [ {"field": "<field_id>", "direction": "asc"} ],
  "hidden_field_ids": ["..."],
  "group_by_field_id": "...",
  "card_field_ids": ["..."],
  "column_widths": { "<field_id>": 240 }
}
```

The filter model is shared verbatim with the records query API. References to deleted fields are dropped defensively at read time. Every database keeps ≥1 view.

### Comment
`record_id`, `author_id`, `body` (rich-lite JSON: bold/italic/links/code + mention nodes), `mentions: [user_id]` — extracted **server-side** from the body on write, never trusted from the client; triggers email when SMTP is configured. Edit/delete own; admins delete any; soft delete. Guests can comment.

### ActivityEvent
`workspace_id`, `record_id`, `actor_id` (PAT resolves to owning user), `type` (`record.created`, `record.updated`, `record.restored`, `relation.linked`, `relation.unlinked`, `comment.created`, `document.edited`, `attachment.added`), `payload` (field-level diffs `{field_id: {from, to}}`; option ids/record chips resolved at render time), `created_at`. Written server-side in the same transaction as the mutation. Append-only. Not writable via API. Future webhook outbox.

### Attachment
`record_id`, `filename`, `size`, `mime`, `storage_key`, `uploaded_by`. Storage driver: local disk (default) or S3-compatible (config). Per-file size cap (default 20 MB). Image thumbnails only; no previews, versioning, folders, or file field type.

### User / Membership / ApiToken
- **User** (better-auth managed): `email`, `name`, `image`, `email_verified`, `deactivated_at`. Deactivated users keep historical authorship.
- **Membership:** `workspace_id`, `user_id`, `role` (`admin` | `member` | `guest`), `space_ids` (guest scoping; null for non-guests), `status` (`pending` | `active`), `invited_by`. Unique per (workspace, user).
- **ApiToken:** `user_id`, `workspace_id`, `name`, `token_hash` (SHA-256), `token_prefix`, `last_used_at`, `revoked_at`. Acts as its creator (same role and scoping). Plaintext shown once.

## Role matrix (v1 — whole-workspace, no per-database perms)

| Capability | Admin | Member | Guest |
|---|---|---|---|
| Manage workspace, members, tokens | ✅ | — | — |
| Edit schema (spaces/databases/fields/relations) | ✅ | ✅ | — |
| Create/edit/delete records & views | ✅ | ✅ | — |
| Read records/views (guest: scoped spaces only) | ✅ | ✅ | ✅ |
| Comment | ✅ | ✅ | ✅ |

Members can edit schema in v1 (small-team trust model); a "lock schema to admins" toggle is parked. Guest cross-space relation chips render **name-only, non-navigable**; unshared spaces return 404.

## Record ordering

One fractional-index `position` string per record per database (LexoRank-style, `fractional-indexing` npm). Table default order and kanban within-column order both read it. Sorted views ignore it. Rationale + per-view-ordering upgrade path in [ADR-0005](../decisions/ADR-0005-record-ordering.md).

## Entity-relationship summary

```
Workspace 1─N Space 1─N Database 1─N Field ──(select)── 1─N SelectOption
Workspace 1─N Membership N─1 User
Workspace 1─N ApiToken  N─1 User
Database  1─N Record 1─1 Document
Database  1─N View
Relation  ties (Database A, Database B); has 2 Fields (type=relation); 1─N RecordLink
Record    1─N Comment · 1─N ActivityEvent · 1─N Attachment · N─N Record (via RecordLink)
```

## System schema sketch (Postgres)

better-auth owns `users`, `sessions`, `accounts`, `verifications`.

```
workspaces       id, name, slug (uq), settings jsonb
spaces           id, workspace_id FK, name, icon, position
memberships      id, workspace_id FK, user_id FK, role, space_ids uuid[] null,
                 status, invited_by         UNIQUE (workspace_id, user_id)
invites          id, workspace_id FK, email, role, space_ids uuid[] null,
                 token_hash, expires_at, accepted_at
api_tokens       id, user_id FK, workspace_id FK, name, token_hash (uq),
                 token_prefix, last_used_at, revoked_at

databases        id, space_id FK, name, icon, api_slug, position
fields           id, database_id FK, display_name, api_name, type, config jsonb,
                 position, is_system, deleted_at
select_options   id, field_id FK, label, color, position
relations        id, workspace_id FK, database_a_id FK, database_b_id FK,
                 field_a_id FK, field_b_id FK, cardinality

records          id, database_id FK, title text, values jsonb DEFAULT '{}',
                 position text, created_by FK, updated_by FK, deleted_at
                 -- gin(values jsonb_path_ops) · btree(database_id, position)
                 -- btree(database_id, created_at, id) · gin(title gin_trgm_ops)
record_links     id, relation_id FK, from_record_id FK, to_record_id FK
                 UNIQUE (relation_id, from_record_id, to_record_id) · CASCADE

views            id, database_id FK, name, type, config jsonb, position, created_by FK
documents        id, record_id FK (uq), content jsonb, content_text, version int
comments         id, record_id FK, author_id FK, body jsonb, deleted_at
activity_events  id, workspace_id FK, record_id FK, actor_id FK, type text,
                 payload jsonb, created_at    -- INDEX (record_id, created_at DESC)
attachments      id, record_id FK, filename, size, mime, storage_key, uploaded_by FK
```
