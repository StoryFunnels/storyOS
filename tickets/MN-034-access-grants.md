---
id: MN-034
title: Access grants — Fibery-style roles at space + database level
status: done
depends_on: [MN-032]
size: L
---

Implements [ADR-0007](../docs/decisions/ADR-0007-access-grants.md): guests get graded access (`viewer` / `commenter` / `editor` / `creator`) granted per space or per database (highest wins). "The client as user" = `editor` on their Client Space. Admin-only Share dialogs on spaces and databases manage grants; invites carry grants.

## Acceptance criteria

- [ ] `access_grants` table + data migration: existing guest `space_ids` become `commenter` space grants; column dropped
- [ ] AccessService resolves effective roles (admin/member fast paths; guests take max of db + space grants); no grant → 404
- [ ] Content endpoints enforce: records/links/attachments/documents/views writes = `editor`; comments = `commenter`; reads = `viewer`
- [ ] Schema endpoints enforce `creator` per database (guest with a creator grant CAN add fields there; editor cannot); relations need creator on both sides; database create/delete + spaces stay member+
- [ ] Grants CRUD API (admin): list per workspace/user, create for space or database, delete; guest invites accept `grants: [{space_id|database_id, role}]`
- [ ] Share dialog UI on space and database (sidebar menus): current people + roles, add person with role, remove; members page shows guests' grant chips
- [ ] Guest UI adapts by effective role: editor sees + New/editors/drag; commenter sees comment box only; viewer read-only
- [ ] Integration tests: role ladder per operation, db-grant-overrides-space, 404-without-grant, PAT of a granted guest
