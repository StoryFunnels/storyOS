# Workspace export format (`.zip`)

StoryOS is a no-lock-in tool, so a workspace owner can take **everything** out of a
workspace in one download (#320). This is the on-disk format of that export — the
contract a future importer will read.

## Access

Owner/admin only. The endpoint is gated with `@MinRole('admin')` (the same gate as
Members, Billing and the GDPR tooling) and, for API tokens, `@RequiresScope('admin')`.
A regular member or guest gets `403`.

```
GET /api/v1/workspaces/:ws/export/workspace.zip
```

The response is `application/zip`, streamed as an attachment
(`workspace-<slug>-<YYYY-MM-DD>.zip`). It is built lazily — record pages and
attachment bytes are pulled one at a time as the response is read, so a large
workspace is never buffered into memory. Attachments are read through the shared
storage seam (`getStorage()`, see MN-029), so the export is identical on a local-disk
or an S3/MinIO deployment.

## Layout

```
manifest.json
spaces/<space-slug>/<database-slug>.json
relations.json
attachments/<attachment-id>/<filename>
```

Slugs are sanitised (no path separators, control chars or `..`) and de-duplicated,
so no two entries can collide or escape the archive on extraction (zip-slip safe).

### `manifest.json`

Workspace metadata, the format version, the export timestamp, and an index of every
space and database (with the in-archive `path` of each database file).

```jsonc
{
  "format": "storyos-workspace-export",
  "format_version": 1,
  "exported_at": "2026-07-25T12:00:00.000Z",
  "workspace": { "id": "…", "name": "Acme", "slug": "acme" },
  "counts": { "spaces": 2, "databases": 5, "relations": 3, "attachments": 12 },
  "spaces": [
    {
      "id": "…", "name": "Product", "slug": "product", "icon": null, "color": null,
      "databases": [
        { "id": "…", "name": "Tasks", "api_slug": "tasks", "path": "spaces/product/tasks.json" }
      ]
    }
  ]
}
```

### `spaces/<space>/<database>.json`

The database's **schema** and **all of its records**.

- `fields[]` — the full field schema: `id`, `api_name`, `display_name`, `type`,
  `config` (the raw per-type config JSON), `position`, `is_system`, and — for
  `select`/`multi_select` — the `options[]` (`id`, `label`, `color`, `position`).
- `records[]` — every non-trashed record: `id`, `number` (the public per-database
  id), `title`, `position`, `created_by`, `created_at`, `updated_at`, and `values`.
  - `values` is keyed by **field id** (the stable uuid, not the renameable
    `api_name`) — the raw stored form (ADR-0002). Select values are option ids,
    resolvable against that field's `options[]`.
  - `attachments[]` on a record points at the files: `{ id, filename, mime, size,
    path }`, where `path` is the entry under `attachments/` holding the bytes.

Records are keyed by their uuid `id`, which is what the relation graph references —
so the graph is fully reconstructable from ids alone.

### `relations.json`

The relation graph, independent of any one database:

- `relations[]` — the relation definitions (schema edges): `id`, `database_a_id`,
  `database_b_id`, `field_a_id`, `field_b_id`, `cardinality`.
- `links[]` — the actual links: `{ relation_id, from_record_id, to_record_id }`,
  every id a stable record/relation uuid.

### `attachments/<attachment-id>/<filename>`

The actual attachment bytes. A record reaches them via its `attachments[].path`.
Thumbnails are not exported (they are re-derivable from the original). If an
attachment's bytes have gone missing underneath the export (deleted concurrently),
the reference stays in the record JSON but the file is simply absent — a partial
object never aborts the whole export.

## What is not (yet) included

Views, standalone space documents, record rich-text document bodies, comments and
activity history are out of scope for v1 — the export covers the structural data
model (spaces, databases, field schema, records + values, relations, attachments).
These are candidates for a `format_version` bump.

## Import

There is no importer yet. The format is designed to make one possible: stable uuid
keys throughout, schema captured alongside data, and a version field to gate on. An
importer would create spaces/databases/fields from each database file, remap ids if
it cannot preserve them, load records, then replay `relations.json`.
