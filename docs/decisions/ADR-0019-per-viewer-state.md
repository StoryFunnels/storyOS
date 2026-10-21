# ADR-0019: Per-viewer state: one primitive for overlays, separate for owned objects and lists

- **Status:** accepted (2026-10-20); built in ticket #973 (see "Implementation" at the end).
- **Ticket:** #952 (the question), raised by Dara while designing views at scale. Pinned view tabs (ticket #932) are built on whatever this decides.
- **Companion:** none. Every claim below cites the file and line it was read from, at `origin/main` on 2026-10-20.

## Context

"One shared object, personalised per viewer" exists several times, each built separately. The question was whether that is one thing.

### The inventory

| # | State | Where it is stored | Keyed by | Who may write | On removal / on GDPR erasure |
|---|---|---|---|---|---|
| 1 | **Personal filter** on a shared view (#259) | `user_preferences.preferences.viewFilters[viewId]`, one jsonb blob per user (`apps/api/src/db/schema.ts:1120`; `apps/api/src/users/preferences.service.ts:97`, `:108`, `:136`) | user id (primary key) then view id inside the blob | `viewer` on the view's database (`views/personal-filter.controller.ts:37`) | removal: kept. erasure: the WHOLE blob is deleted, for every workspace (`gdpr/gdpr.service.ts:526`) |
| 2 | **Personal collection view** on an embedded relation (#736) | the same blob, `collectionFilters[fieldId]` (`preferences.service.ts:172`, `:184`, `:209`) | user id then relation field id | `viewer` (`fields/personal-collection-view.controller.ts:59`) | as 1 |
| 3 | **Personal views** (the view is the owned object) | `views.owner_user_id` (`schema.ts:478`), listed by owner in `views/space-views.service.ts:130`, guarded at `:256`, `:335`, `:368`, `:425` | owner | the owner only | removal: hard-deleted (`workspaces/members.service.ts:150`) |
| 4 | **Personal space** and its documents | `spaces.owner_user_id` (`schema.ts:206`) | owner | the owner only, private from admins (`docs/architecture/personal-space.md`) | removal: hard-deleted (`members.service.ts:153`) |
| 5 | **Favourites** | `favorites` table, unique on (user, target type, target) (`schema.ts:1127`; `favorites/favorites.service.ts:62`, `:155`, `:167`) | user, workspace | the user | removal: kept. erasure: deleted for that workspace (`gdpr.service.ts:561`) |
| 6 | **Watchers** | `record_watchers` (`schema.ts:1098`) | user, record | the user | neither path deletes them (no `record_watchers` delete in `members.service.ts` or `gdpr.service.ts`) |
| 7 | **Notifications and their read state** | `notifications` (`schema.ts:1064`) | user | system writes, the user marks read | removal: kept. erasure: deleted for that workspace (`gdpr.service.ts:572`) |
| 8 | **My-work layout, sidebar prefs, activation dismissals, notification toggles, regional formats** | the same blob as 1 and 2 (`preferences.service.ts:29` onward) | user id | the user | as 1 |
| 9 | **Pinned view tabs** (proposed, ticket #932) | not built | | | |

Guest rules today: 1 and 2 need only `viewer` on the database, so a guest with a database grant may set them. A guest with no access cannot reach the endpoints at all (404). Nothing checks access on READ of the stored value, because it is only ever read through those same endpoints and through the export (`export/export.service.ts:109`), which also goes through an access check.

### Two defects in the existing storage, found while inventorying

1. **A lost update, reproduced.** Items 1, 2 and 8 share one jsonb blob and every write is read-modify-write of the WHOLE blob (`preferences.service.ts:108` onward: `get()`, spread, upsert). Two concurrent personal-filter writes for two different views race: in a throwaway test, **10 of 12 rounds lost one of the two** (PUT both concurrently, GET both, one filter gone). A person with two tabs open, or a client that saves two overrides in a burst, silently loses one. Nothing errors.
2. **No owner, and two removal paths that disagree.** The blob is keyed by user id ONLY: no workspace column, no foreign key. Plain removal (`members.service.ts:130-165`) hard-deletes personal views and the personal space and the member's grants, but leaves the member's overlays (1, 2), favourites (5), watchers (6), notifications (7) and the blob's per-workspace entries (8). A re-invited person gets that state back, the same class of surprise ticket #945 fixed for grants. GDPR erasure (`gdpr.service.ts:526-575`) cleans most of it, but because the blob is global it deletes the user's ENTIRE preferences row, so erasing someone from ONE workspace wipes their preferences (notification toggles, regional formats, my-work layouts) in every OTHER workspace they belong to. Watchers survive both paths.

## Decision (recommendation)

**Three kinds of per-viewer state, two storage shapes. Not one primitive for everything.**

1. **Owned objects stay separate: items 3 and 4.** They are *content* with an owner: they have their own identity, are listed, renamed, deleted, and (for a personal view) carry a full `ViewConfig`. `owner_user_id` on the row is the right shape, privacy is already decided (`personal-space.md`), and removal already hard-deletes them. Do not fold them into anything.
2. **Lists with their own query patterns stay separate: items 5, 6, 7.** They are paged and fanned out by TARGET (who watches this record, who gets this notification), which a generic key-value table serves badly. Keep their tables, but **make removal consistent** (below).
3. **Overlays on a shared object become ONE primitive: items 1, 2, 9 and anything of that shape later.** An overlay is `(user, workspace, kind, target) -> small jsonb`, meaning "this viewer's override of that shared thing". Recommended shape:

   `viewer_state(user_id text, workspace_id uuid references workspaces on delete cascade, kind text, target_id uuid, data jsonb, updated_at)`, unique on `(user_id, kind, target_id)`.

   - **One row per override, so writes cannot race each other** (the defect above disappears by construction: two views are two rows).
   - **A registry of kinds**, each with a validator for `data` and a resolver for `target_id` to its database, so access is checked the same way for every kind: the viewer needs `viewer` on the target's database (`assertAccess`), exactly as 1 and 2 do now. A new overlay is a new registry entry, not a new table, controller and ADR.
   - **Survives losing access, hidden.** If a viewer's grant is removed the row stays but is unreachable (the endpoints 404 without access); if the grant returns the override returns. That is the behaviour today and nobody has asked for different. **Admins cannot read another person's overlay**, as today.
   - **Deleted with the target** (kind-specific, e.g. a deleted view removes its overlays) **and with the membership** (delete by user and workspace).
4. **Item 8 (preferences) stays a per-user blob**, because it is genuinely per-user, not per-object, but the two override maps (`viewFilters`, `collectionFilters`) move out of it into `viewer_state`. The blob then holds only settings, and a lost update there is at least not data about a specific object.

## Consequences

- **Fixes a real data-loss defect** (the lost update) and the orphan problem for overlays, with one migration.
- **Pinned view tabs (ticket #932) become a registry entry**, not a fourth implementation. If this decision is not made by the time #932's build starts, #932 should use `viewer_state` anyway: building on the old blob would inherit the race.
- **Cost:** one migration (new table, backfill from the blob's two maps, then drop the keys), a kind registry, and moving two controllers' storage. The controllers' URLs and shapes do not change, so the web client and MCP are untouched.
- **A removal-cleanup pass for items 5 to 7** (favourites, watchers, notifications by user and workspace on `removeMember`, and watchers in erasure) is needed whichever way the rest goes. This is independent of the primitive and could ship first. With overlays in `viewer_state` (workspace-scoped), erasure stops deleting a person's preferences in workspaces they remain in.
- **Not decided here:** whether notifications should survive removal for audit (they are not content a person owns); that is a product call.

## What would make this the wrong call

If overlays stay at two kinds and #932 is dropped, the lost-update fix alone (store each override under its own jsonb key with an atomic `jsonb_set` upsert, no new table) is smaller and enough. The primitive pays for itself at the third kind, which #932 is.

## Implementation (ticket #973)

- **Table:** `viewer_state(user_id, workspace_id, kind, target_id, data, updated_at)`, primary key `(user_id, kind, target_id)`, `workspace_id` cascades. Migration `0114` creates it, backfills the old blob's `viewFilters` and `collectionFilters` (the workspace resolved through the view's / field's database; entries whose view or field no longer exists are dropped, soft-deleted ones kept) and removes the two keys from the blob. It is idempotent.
- **Registry:** `apps/api/src/viewer-state/viewer-state.kinds.ts`. Kinds: `view_filter` (target = view), `collection_view` (target = relation field), `pinned_tabs` (target = database; registered for ticket #966, no endpoint yet). `ViewerStateService` gives every kind the same access check (`viewer` on the target's database) and a single atomic upsert per write.
- **Unchanged:** the personal-filter and personal-collection-view endpoints keep their URLs and response shapes; the generic `GET /users/me/preferences` no longer returns the two maps (nothing read them there).
- **Removal and erasure:** removing a member now deletes their overrides, favourites and watches in that workspace. Notifications are left alone (still undecided). GDPR erasure additionally deletes overrides and watches for the workspace. **A correction to the inventory above:** erasure is ACCOUNT-level (it also deletes the person's sessions, accounts and OAuth tokens), so deleting their whole preferences row is consistent with it; it is not a bug that it spans workspaces, and it is unchanged.
