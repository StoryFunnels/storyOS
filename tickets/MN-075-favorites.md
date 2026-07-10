---
id: MN-075
title: Favorites — star a record (and database) into a sidebar Favorites section
status: todo
depends_on: [MN-074]
size: M
---

Fibery lets you star any entity and pins it under Favorites in the sidebar. We have no favorites system. Founder asked for "star entity" alongside the entity actions (MN-074 shipped duplicate/copy-link/delete; star was split out because it needs storage + sidebar work).

## Design
- `favorites` table: (user_id, workspace_id, target_type 'record'|'database', target_id), unique per user+target. Per-user, not shared.
- Endpoints: list, add, remove.
- A star toggle on the entity header (and database header); a **Favorites** section at the top of the sidebar listing the current user's stars, each linking to the record/database.

## Acceptance criteria
- [ ] Star/unstar a record from its header; state persists per user
- [ ] Favorites section in the sidebar lists starred records + databases and navigates to them
- [ ] Verified in the browser
