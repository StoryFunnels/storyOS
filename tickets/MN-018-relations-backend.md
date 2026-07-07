---
id: MN-018
title: Relations backend
status: done
depends_on: [MN-011]
size: L
---

The heart of the product, server side. `relations` + `record_links` tables; create-relation endpoint provisioning the paired relation-fields on both databases (default names, independent renames); link/unlink/replace endpoints; linked-record `{id, title}` chips embedded in record reads with one-level `expand`; `EXISTS`-based relation filters added to the query compiler; cardinality enforced by partial unique index (409 on violation); relation-field delete cascades relation + links (both sides) behind an explicit confirm flag; self- and cross-space relations. Spec: [docs/architecture/meta-model.md](../docs/architecture/meta-model.md) §Relation/RecordLink.

## Acceptance criteria

- [ ] Creating a relation yields a field on both databases; both renameable independently; deleting either side (with confirm) removes both + all links
- [ ] Links visible from both sides; unlink removes both directions (single row)
- [ ] one_to_many uniqueness enforced → 409 with a helpful message; many_to_many unrestricted
- [ ] Record delete cascades its links; restore does not resurrect severed links to hard-deleted counterparts
- [ ] Query filter `has` / `has_none` / `is_empty` on relation fields compiles to EXISTS and is integration-tested in both directions
- [ ] Self-relation (Task blocks Task) round-trips
