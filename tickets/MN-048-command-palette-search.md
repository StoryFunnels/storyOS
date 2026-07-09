---
id: MN-048
title: Global search + command palette (Cmd+K)
status: done
depends_on: []
size: L
---

**Problem.** No way to find a record by name across databases; navigation is sidebar-only clicks. Linear's most-loved surface is Cmd+K — a team living in a tool invokes it hundreds of times a day. This is the single highest-leverage "feels professional" feature on the list.

## Research

- **Linear**: one palette: type → fuzzy results over issues/projects/docs; with an issue focused, the same palette becomes an action menu ("Assign to…", "Set state…"); recents when empty; instant (<100ms perceived).
- **Notion**: Cmd+K/Cmd+P search-first, recents, "Create new page: <query>" as a bottom row.
- **Slack**: Cmd+K as pure switcher — proof that even navigation-only palettes carry a product.
- **Raycast/VS Code**: `>` prefix toggles command mode — a clean way to separate search vs actions without tabs.

**Synthesis:** one modal, results in three groups (Records / Places / Actions), recents when empty, entirely keyboard-driven, backed by one fast grant-scoped endpoint. Contextual record actions (Linear's killer half) deferred to a follow-up — navigation + create actions ship first.

## Design

### API — `GET /workspaces/:ws/search?q=&limit=20`

- **Records**: `ILIKE '%q%'` over `records.title` using the existing `pg_trgm` GIN index, joined to databases for name/icon, **scoped by access**: admins/members see all; guests get `database_id IN (visibleDatabaseIds)` from the existing AccessService visibility helpers (same logic as list endpoints — factor a `visibleDatabaseIds(membership)` if not already exposed).
- **Places**: databases + spaces by name match (cheap, in the same response).
- Ranking v1: exact-prefix first, then `similarity(title, q)` desc, then `updated_at` desc; cap 15 records + 5 places.
- **Recents**: `GET /workspaces/:ws/recent` — last 10 records the user touched: reuse `activity_events` (actor = me, newest per record) — zero new writes.
- Response includes `database: {id, name, icon}` per row for grouped rendering.
- Perf gate: extend the existing records-query perf test — p50 < 150ms at 50k records.

### Web — the palette

- Global `Cmd+K` / `Ctrl+K` listener in the workspace layout (ignores when a dialog is already open); plus a **sidebar "Search" entry** in the new top nav section (revised per founder's Fibery screenshot: Home / Search / Inbox sit above spaces as first-class rows).
- Own component (~200 lines, no cmdk dep): fixed top-center modal, input, grouped list, footer hint row (`↑↓ navigate · ↵ open · esc close`).
- **Sections**:
  1. *Records* — icon of their database + title + database name right-aligned; Enter → entity page.
  2. *Databases & spaces* — Enter → database page / first database of space.
  3. *Actions* (always visible, filtered by query): New record in current database (when on one — opens creation like table's "+ New" then navigates), New database…, New space…, Browse templates, Invite people, Settings. Each = icon + label + optional shortcut hint.
- Empty query → Recents section + Actions.
- Debounce 150ms; stale-response guard (only latest query renders); loading shimmer only after 300ms (avoid flicker).
- Selection model: single flat index across groups; arrows wrap; hover syncs.

### Keyboard entry map (foundation for MN-050's shortcuts)

- Introduce a tiny `useGlobalShortcuts` registry (one keydown listener, checks not-in-input) — Cmd+K registers here; MN-050 adds `n`, `?` etc. to the same registry so we never stack conflicting listeners.

## Implementation plan

1. Search + recent endpoints with access scoping; perf test at 50k; SDK regen.
2. Shortcut registry + palette shell (open/close/focus trap/no body scroll).
3. Results rendering with groups, keyboard nav, actions wiring.
4. Recents; empty/loading/no-results states ("No matches for 'x' — press Enter to create a record named this" as a stretch nicety, only on a database page).
5. Browser-verify: search across template workspaces, guest-scoping test (guest account sees only granted space's records), latency check.

## Edge cases

- Guests with database-level grants (no space grant) — visibility must come from the same helper the sidebar uses, not a re-derivation.
- Very short queries (1 char) — still search (trigram handles it), but rank prefix matches hard first.
- Records titled "Untitled" flood — rank `updated_at` desc within equal similarity so fresh work surfaces.
- Palette inside dialogs — Cmd+K is a no-op while a Radix dialog is open (focus-trap conflicts are not worth it in v1).

## Out of scope

Content search (descriptions/comments — needs tsvector work, separate ticket), contextual per-record actions, search filters (`in:Tasks`), fuzzy-typo matching beyond trigram.

## Acceptance criteria

- [ ] Search endpoint: title trigram + places, grant-scoped, p50 < 150ms @ 50k (perf test); recents endpoint from activity
- [ ] Cmd+K opens everywhere in the workspace shell; full keyboard flow; fully mouse-usable too
- [ ] Groups: Records (db icon + name), Places, Actions (quick-create set); recents on empty
- [ ] Guest scoping proven by integration test; stale-response guard (no flicker of wrong results)
- [ ] Shared shortcut registry that MN-050 can extend
