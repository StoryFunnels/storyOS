---
title: Data model reference
description: The canonical schema-of-schemas — how StoryOS models user-defined structure, and how records are stored.
sidebar:
  order: 8
---

This is the canonical model behind everything in StoryOS — the schema-of-schemas. Every entity is
an API resource with a stable ID and `created_at` / `updated_at` timestamps.

## Entities

- **Workspace** — the tenant boundary. Has many spaces, memberships, and API tokens.
- **Space** — a named group of databases; the unit of guest scoping and template installation.
  Every database belongs to exactly one space.
- **Database** — a user-defined type. Owns fields, records, and views, plus a built-in title field.
- **Field** — a column definition: `display_name`, stable `api_name`, `type`, and type-specific
  `config`. Soft-deletes. See [databases & fields](/concepts/databases-and-fields/).
- **SelectOption** — first-class rows (never inline strings) with stable IDs; records store option
  ids, so renaming is O(1).
- **Relation** — ties database A to database B with a cardinality (`one_to_many` / `many_to_many`);
  creates two paired relation-fields. See [relations](/concepts/relations/).
- **RecordLink** — one row per link between two records; serves both directions with no dual-write.
- **Record** — a row: `title` (a promoted real column), `values` (JSONB, keyed by field id),
  `position`, authorship, and a 30-day soft-delete trash.
- **Document** — a record's rich-text description (1:1, lazily created), stored as block JSON with
  optimistic-concurrency versioning.
- **View** — a table or board over a database, with a filter tree, sorts, grouping, and hidden
  fields in `config`. See [views](/concepts/views/).
- **Comment** — rich-lite body with `@`-mentions extracted **server-side** on write.
- **ActivityEvent** — an append-only, server-written audit trail of every mutation.
- **Attachment** — a file on a record; local disk or S3-compatible storage.
- **User / Membership / ApiToken** — identity, workspace role + guest scoping, and PATs. See
  [access & roles](/concepts/access-and-roles/).

## Relationship summary

```
Workspace 1─N Space 1─N Database 1─N Field ──(select)── 1─N SelectOption
Workspace 1─N Membership N─1 User
Workspace 1─N ApiToken  N─1 User
Database  1─N Record 1─1 Document
Database  1─N View
Relation  ties (Database A, Database B); has 2 relation Fields; 1─N RecordLink
Record    1─N Comment · 1─N ActivityEvent · 1─N Attachment · N─N Record (via RecordLink)
```

## How records are stored

Records live in one table with a JSONB `values` column keyed by field id. This keeps schema
changes as runtime API calls (no DDL when a user adds a field) while staying fast at self-host
scale.

Per-type JSON encoding:

| Field type | Encoding |
|---|---|
| text, url, email | string |
| number | JSON number |
| checkbox | boolean |
| date | ISO-8601 string |
| select | option id |
| multi_select | array of option ids |
| user | user id (array if multi) |
| title | promoted to the real `title` column |
| relation | stored in RecordLink, **not** in `values` |

The service layer is the schema enforcer: a well-tested validator checks every incoming `values`
payload against the live fields (type, coercion, option existence, unknown-field rejection) and
returns per-path `422`s. Reads project through **live** fields only, so values from a deleted field
are invisible. Relation values are joined from RecordLink and returned as `{id, title}` chips.

Filtering and sorting go through an isolated query compiler that translates the shared
[filter AST](/api/querying/) into parameterized SQL with type-aware casts — the same filter model
used by views and the API.
