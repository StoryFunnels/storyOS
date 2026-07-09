---
id: MN-045
title: User avatars — pictures for people everywhere a person appears
status: done
depends_on: [MN-029]
size: M
---

**Ask (founder, 2026-07-09):** pictures for the users.

## Research

- **Linear**: avatar or initials on a deterministic per-user color; shown at 16–32px on issues, boards, pickers, comments. The insight: at a glance, *color+shape* identifies a teammate faster than reading a name.
- **Notion / Slack**: upload with client-side crop/resize; graceful initials fallback; Google-auth users inherit their Google photo.
- **better-auth**: already has `user.image` (populated by Google OAuth when configured) — the column exists, only upload + rendering are missing.

**Synthesis:** one `Avatar` component (image → initials fallback on a stable hashed color), upload through the existing attachments storage driver, threaded through every person surface.

## Design

### Avatar component (`components/ui/avatar.tsx`)

- Props: `{ userId, name, image?, size: 16|20|24|32 }`.
- Image path: rounded-full `<img>` with `onError` → fallback (covers dead URLs).
- Fallback: initials = first letters of the first two words of the name (1 char at size 16); background = `OPTION_COLORS[hash(userId) % 10]` at ~20% opacity with the full-strength color as text — stable across sessions and clients because it hashes the id, not the name.
- Optional `title` tooltip with the full name at small sizes.

### Upload flow

- New **account popover**: the bare user-name text in the header becomes a button → popover with Avatar (large), name, email, "Change photo", "Sign out" (moves Sign out from the sidebar footer — cleaner shell).
- "Change photo" → file input (png/jpg/webp, ≤5MB pre-resize) → client-side downscale to 256×256 (canvas, cover-crop centered) → `POST /users/me/avatar` (multipart).
- API stores via the existing `StorageDriver` under `avatars/<userId>.webp` (overwrite semantics — one file per user, no versioning), then updates `user.image` to the serving URL. `GET /files/avatars/:userId` serves with long cache + cache-buster query param on update.
- "Remove photo" → clears `user.image`, falls back to initials.
- Auth: only self; PATs can't change avatars (session-only route).

### Render surfaces (each swaps text → Avatar + name)

1. Person-field **cells** (table): 20px avatar + name, comma-stacked for multi.
2. Person **property rows** (entity page): 24px + name.
3. Person **pickers** (OptionList user branch): 20px in each row.
4. **Comments**: 24px beside author (replaces the plain bold name).
5. **Mention chips** in comment bodies: 16px inline.
6. **Members page**: 32px per row.
7. **Board cards**: 16px avatar-only for assignee-type card fields (name in tooltip).
8. Account popover: 64px.

Members data already flows through `useMembers` — extend its payload with `image` (members endpoint already returns `user.image`; verify and thread through `memberList`).

## Implementation plan

1. Avatar component + hash-color util; storybook-style test page not needed — verify in situ.
2. API route (multipart, storage driver, user.image update, serve route) + tests (upload/replace/remove, size cap, wrong mime).
3. Account popover in the header (photo controls + sign out relocation).
4. Thread `image` through members queries; swap the 8 surfaces.
5. Browser-verify: initials fallback, upload round-trip, comments and board cards.

## Edge cases

- Same initials collisions — color differentiates (id hash, not name hash).
- Deleted users on old comments — activity stores actor id; render "?" avatar in neutral when the member is gone.
- Local storage driver in self-host: served through the API like attachments (no direct fs path leaks); S3 driver returns signed or public URL per existing driver contract.

## Out of scope

Cropping UI (auto center-crop only), animated avatars, org logos, presence dots.

## Acceptance criteria

- [ ] Avatar component: image with error fallback → initials on stable per-user palette color, 4 sizes
- [ ] Upload/replace/remove via account popover; client resize to 256px; stored through the storage driver (works on local + S3)
- [ ] All 8 surfaces render avatars; multi-person fields stack cleanly
- [ ] API tests: upload happy path, oversized/wrong-type rejected, remove falls back
