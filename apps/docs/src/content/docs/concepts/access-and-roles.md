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

## Who counts toward billing

**Settings → Billing** shows **Billable seats** — admins and members always count; a guest counts
only once their grant reaches `contributor` or higher. **A viewer or commenter guest is free**,
whatever the total member count on the Members page looks like — pending invites don't count
either, whether they resolve to a paid role or not. The billing page names exactly this rule in
its own caption, with a link to Members, precisely so the two numbers can be reconciled rather
than left to look like a discrepancy.

## Pending invitations

An invite that hasn't been accepted shows a **Pending** badge on Settings → Members, with
**Resend invitation** and **Revoke**.

**Resending mints a fresh link — the old one stops working.** It's not a reminder email pointing
at the same URL; the invite's token and its 7-day expiry both reset, so a stale copy of the
original link left in an old email thread no longer gets anyone in.

**Throttled to one resend per minute**, per invite — a repeat click inside that window is refused
with a plain "wait a minute" message rather than silently sending twice.

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
