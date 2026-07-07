---
id: MN-009
title: Databases CRUD
status: done
depends_on: [MN-008]
size: S
---

`databases` table + endpoints (create takes `space_id`; move between spaces via PATCH). Creating a database provisions the implicit title field, system fields, and a default "All records" table view stub (fleshed out in MN-020). Hard delete with cascading fields/records/views, gated by a confirm flag; inbound relations listed in the error until the client passes `sever_relations: true`.

## Acceptance criteria

- [ ] CRUD via API with workspace + guest-space scoping tests
- [ ] Create provisions title field + default view; `api_slug` generated and stable
- [ ] Delete cascades fields/records/views; inbound relations block deletion unless explicitly severed
- [ ] Move between spaces updates guest visibility correctly (integration test)
- [ ] OpenAPI spec updated (drift check green)
