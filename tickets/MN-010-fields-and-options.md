---
id: MN-010
title: Fields CRUD + select options + type-change matrix
status: todo
depends_on: [MN-009]
size: M
---

`fields` + `select_options` tables and endpoints. Types: text, number, checkbox, date, select, multi_select, url, email, user — each with a type-specific zod `config` schema. Stable `api_name` generation. Soft-delete for fields. Type changes limited to the compatibility matrix (anything→text; text→number/date best-effort; select↔multi_select) with a dry-run lossy count. Option CRUD with stable ids. See [docs/architecture/record-storage.md](../docs/architecture/record-storage.md) (field lifecycle).

## Acceptance criteria

- [ ] Every type creatable with valid config; invalid config → 422 with per-path details
- [ ] Field delete is soft; deleted fields excluded from all reads; relation-type fields rejected here (they arrive in MN-018 with their own lifecycle)
- [ ] Allowed type changes convert existing values in one transaction; dry-run returns the lossy count first; disallowed changes → 422 with explanation
- [ ] Option rename is O(1) (ids stored in records, labels resolved at read); option delete warns with usage count and nulls values on confirm
- [ ] `api_name` unique per database, survives display renames, regenerated names never collide
