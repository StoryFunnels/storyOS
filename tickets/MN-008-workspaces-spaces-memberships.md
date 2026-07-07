---
id: MN-008
title: Workspaces, spaces, memberships, roles, invites
status: todo
depends_on: [MN-006]
size: M
---

The tenancy layer. Workspace CRUD (creator becomes admin; default "General" space auto-created). Space CRUD (name, icon, position). Invites: email + role (+ required `space_ids` for guests), hashed token, accept endpoint, resend/revoke; copyable link fallback when SMTP is absent. `WorkspaceAccessGuard` resolving role + guest space scoping per request. Role matrix and 404-for-unshared-spaces rule per [docs/architecture/auth.md](../docs/architecture/auth.md) and [ADR-0006](../docs/decisions/ADR-0006-spaces.md).

## Acceptance criteria

- [ ] Non-member requests against a workspace → 404; guest requests against unshared spaces → 404 (not 403)
- [ ] Role matrix enforced by guard-level policy (schema/record/view writes blocked for guests; settings blocked for members) with per-role integration tests
- [ ] Guest invite requires ≥1 space id; invite accept creates an active membership with the right scoping
- [ ] Last admin cannot demote or remove themselves; removed users keep historical authorship
- [ ] Spaces reorder via position; databases will attach to spaces in MN-009
