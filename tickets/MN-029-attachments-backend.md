---
id: MN-029
title: Attachments backend
status: todo
depends_on: [MN-011]
size: M
---

`attachments` table + endpoints (upload multipart, list, download, delete) behind a **storage driver interface** with two implementations: local disk (default, volume-mounted) and S3-compatible (MinIO/S3, env-configured). Per-file size cap (default 20 MB, env-configurable), MIME sniffing, image thumbnail generation (images only — sharp). Emits `attachment.added` activity events. Scope guardrails per [v1-scope.md](../docs/product/v1-scope.md): no previews beyond image thumbs, no versioning, no folders, no file field type.

## Acceptance criteria

- [ ] Upload/list/download/delete round-trip on both drivers (integration tests run against local disk + MinIO container)
- [ ] Over-cap upload → 422 before the body is fully buffered (streaming limit)
- [ ] Downloads authorize through workspace/guest scoping (a guest can't fetch attachments from unshared spaces — 404)
- [ ] Image uploads get a thumbnail; non-images don't error
- [ ] Deleting a record cleans up its attachment objects (or marks them for the cleanup job — pick one, document it)
