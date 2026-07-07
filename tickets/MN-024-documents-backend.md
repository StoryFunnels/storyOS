---
id: MN-024
title: Documents backend (entity descriptions)
status: done
depends_on: [MN-011]
size: M
---

`documents` table (1:1 with record, lazily created; BlockNote JSON + extracted `content_text`; `version` int). `GET/PUT /records/:id/document` with optimistic concurrency: PUT carries the expected version → 409 with the current version on mismatch (single-editor by design — [v1-scope.md](../docs/product/v1-scope.md)). Size cap (~2 MB). Emits `document.edited` activity events (no diff).

## Acceptance criteria

- [ ] PUT with a stale version → 409 envelope including the current version; fresh PUT succeeds
- [ ] Content is schema-light (any JSON) but size-capped → 422 over the limit (documented as deliberate)
- [ ] `content_text` extracted on write (future search hook)
- [ ] Document deleted with its record; restore restores it
- [ ] Concurrency integration test: two writers, one 409
