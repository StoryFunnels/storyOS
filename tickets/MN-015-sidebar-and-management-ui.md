---
id: MN-015
title: Sidebar, spaces & database management UI
status: done
depends_on: [MN-014]
size: M
---

The workspace chrome: sidebar grouping databases under spaces (create/rename/reorder/delete for both; icons), workspace settings pages (name; members list with role management; invites incl. guest space-picker; copyable invite links), per-database trash view (list + restore soft-deleted records), role-aware UI gating (guests see no write affordances; members see no settings).

## Acceptance criteria

- [ ] Space + database CRUD from the UI, drag-reorder persisted
- [ ] Invite flow: member invite and guest invite (space multi-select required) both acceptable in an incognito window
- [ ] Role management: change role, remove member; last-admin protection surfaced in UI
- [ ] Trash: restore a deleted record from the database's trash view
- [ ] Guests: sidebar shows only scoped spaces; settings routes 404
