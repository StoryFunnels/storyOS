---
title: Access & roles
description: Admins, members, and space-scoped guests — invite a client into exactly one space and keep everything else invisible.
sidebar:
  order: 7
---

Access in StoryOS is workspace-wide with three roles, plus **space scoping** for guests so you can
invite a client into exactly one space.

## Roles

| Capability | Admin | Member | Guest |
|---|---|---|---|
| Manage workspace, members, invites, tokens | ✅ | — | — |
| Edit schema (spaces, databases, fields, relations) | ✅ | ✅ | — |
| Create / edit / delete records & views | ✅ | ✅ | — |
| Read records & views (guest: scoped spaces only) | ✅ | ✅ | ✅ |
| Comment | ✅ | ✅ | ✅ |

- **Members can edit schema** in v1 — a small-team trust model. A "lock schema to admins" toggle is
  planned.
- The **last admin** cannot demote or remove themselves.
- Removed or deactivated users keep their historical authorship in comments and activity.

## Guest scoping

Guests are invited to one or more specific [spaces](/getting-started/concepts/):

- Everything outside their spaces returns **404** — not 403 — so the product never leaks the
  existence of resources they can't see.
- Cross-space relation chips on records they *can* see render **name-only and non-navigable**.
- Guests can read and comment, but aren't `@`-mentionable in v1.

This is what lets you drop a client into their project space to check status and leave comments,
while every other client's work stays invisible.

## Sharing beyond a space: access grants

Space scoping decides which **spaces** a guest can see at all. **Access grants** are the finer
tool underneath it, and they come in three scopes:

| Scope | Reaches |
|---|---|
| **Space** | Every database in that space |
| **Database** | One database |
| **Record** | One record |

Each grant carries a **role** — `viewer`, `commenter`, `contributor`, or `editor` — the same
ladder at every scope, not a second set of names to learn. A grant is exactly one scope; there's
no such thing as a grant that's both space- and database-scoped.

**Where more than one grant applies, the highest wins.** A record-scoped `editor` grant beats a
database-scoped `viewer` grant on that same record, in either order you'd naturally check them.

**Record-scoped grants reach only that one record's read and write** — sharing one record does not
extend to other records it links to. Restricting what a record grant alone lets someone find
through search or a list is a separate, not-yet-built piece; this scope answers "can they open and
edit this specific record", not "what shows up when they search."

**No sharing UI exists yet, and no MCP tool creates or removes a grant** — granting and revoking
access is deliberately a human decision made over the REST API directly, not something an agent
does on its own. The MCP `list_grants` tool can still read existing grants, record scope included.
Don't expect a "Share this record" button in the app; it isn't there.

## Personal access tokens

A [personal access token](/api/authentication/) (`mn_pat_…`) acts as **its creator** — same role,
same guest scoping. That's also an agent's blast radius: give an [MCP](/mcp/overview/) agent a
token scoped to one guest's spaces and it can only touch those.
