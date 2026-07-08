# ADR-0007: Access grants — Fibery-style roles at space and database level

- **Status:** accepted
- **Date:** 2026-07-08
- **Supersedes:** the guest model in ADR-0006 (spaces remain the default sharing unit; the binary read+comment guest becomes the weakest grant, not the only one)

## Context

First real-world need (founder, day 1): a client should be able to *work* in their space — create and edit tasks, drag boards, comment — without being able to change schema or manage people. The v1 guest (read + comment, space-scoped) is too weak; member is too strong. Fibery's model fits: share a scope with a person at a role.

## Decision

**Workspace roles stay:** `admin` (everything + people/access management), `member` (full creator access to all content), `guest` (NO default access — only what grants give).

**New `access_grants` table:** `(workspace_id, user_id, space_id XOR database_id, role)` where role ∈

| Role | Can |
|---|---|
| `viewer` | read records, views, entity pages |
| `commenter` | + comment (the old guest) |
| `editor` | + create/edit/delete/restore records, links, attachments, descriptions, **manage views** — "the client as user" |
| `creator` | + schema inside the scope: fields, options, database rename |

**Resolution:** effective role for a database = admin → admin; member → creator; guest → `max(database grant, containing-space grant)` — highest wins, database grant can only add, never subtract. No grant at all → 404 (existence stays hidden).

**Operation → minimum role:** read `viewer` · comment `commenter` · records/links/attachments/documents/views `editor` · fields/options/database-edits `creator` · relations `creator` on **both** databases · spaces structure + database create/delete → members/admins only · members/invites/grants → admin.

**Migration:** existing `memberships.space_ids` for guests convert to `commenter` space grants; the column is dropped.

## Consequences

- Guest invites carry grants (scope + role) instead of bare space ids; admins manage grants from Share dialogs on spaces and databases.
- The guards change shape: schema/content controllers assert per-database access via an AccessService instead of blanket `MinRole('member')` — a guest with a `creator` grant can add fields to *that* database.
- PATs inherit the creator's grants automatically (they act as the user).
- Per-record permissions and custom roles remain out (v2+); `editor`-created views are shared views (no private views in v1).
