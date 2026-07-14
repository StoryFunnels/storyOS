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

## Personal access tokens

A [personal access token](/api/authentication/) (`mn_pat_…`) acts as **its creator** — same role,
same guest scoping. That's also an agent's blast radius: give an [MCP](/mcp/overview/) agent a
token scoped to one guest's spaces and it can only touch those.
