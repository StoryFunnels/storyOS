---
title: Portal recipients
description: A client is a record, not a seat — a named external party with a revocable link, no account, no login, no billable seat.
sidebar:
  order: 18
---

A **portal recipient** is a named external party who can read a portal's published content —
without a user account, without an invitation email, and without ever counting toward your
billable seats. It's closer to a share link with a name attached than to a person who signs in.

This is a different tool from a [guest](/concepts/access-and-roles/): a guest is a real,
authenticating user who shows up on the Members page and becomes a billable seat once their grant
reaches `contributor` or higher. A recipient never does either of those things. Reach for a guest
when someone needs to work *inside* the workspace; reach for a recipient when dozens of clients
each need to read their own slice of one published view, and adding forty guest seats would make
the whole thing unaffordable.

## What a recipient is

- A **label** (their name — "Acme Co", not an account name), an optional **email** (for your own
  reference only, not used to send anything), and an optional **linked record** — the record in
  your own database that *is* this client, used to scope what they see (below).
- A server-generated, **opaque token** — never derived from the label, id, or creation time, so it
  can't be guessed from any of the other fields.
- Creating a recipient never creates a user, never sends an invitation, and never changes your
  billable seat count — whether you create one recipient or fifty.

## Creating and managing recipients

There's no web UI for this yet — it's API and MCP only:

- `POST /api/v1/workspaces/:ws/portal-recipients` (`create_portal_recipient`) — `label`, optional
  `email`, optional `linked_record_id`.
- `GET /api/v1/workspaces/:ws/portal-recipients` (`list_portal_recipients`) — read-only.
- `POST /api/v1/workspaces/:ws/portal-recipients/:recipient/revoke` (`revoke_portal_recipient`).

**Revoking is immediate — every access path closes at once**, not on the next cache expiry or the
next login attempt, because there is no session to expire: every request re-resolves the token
against the live row. The row itself stays after revoking, for audit; only a new recipient gets a
new token; revoking one is not reversible as a credential.

## Scoping a portal to its recipient

Naming a recipient by itself doesn't show them anything — a [published
view](/concepts/views/#sharing-a-view-publicly) has to be scoped to them. A share can name a
**recipient-scope field**: a relation (matched against the recipient's linked record) or a
text/email field (matched against the recipient's email). Once a share carries that rule, it stops
being an open link and becomes a portal — every request must resolve to a real, live recipient
token, and that recipient's rows are the only ones the query can ever return.

- **No token, or a revoked one, returns nothing — never everything.** A recipient-scoped share
  fails closed by default, the same direction every access-control default in StoryOS fails.
- **While recipient-scoping is active, no relation, lookup, rollup, or formula field is exposed at
  all** — even one an ordinary share's allowlist would otherwise include. A relation pointing at a
  row outside the recipient's scope is a proven leak shape here (it broke a database-level guest
  grant once, in a different feature); rather than try to scope traversal field-by-field, a
  recipient-scoped portal simply doesn't expose computed or relational data yet. Plain fields on
  the recipient's own rows still show normally.
- **Setting the recipient-scope field is a direct API call today** — the `share_view` MCP tool
  covers the ordinary allowlist/relation/indexable options but doesn't yet accept this field, so an
  agent wiring up a recipient-scoped portal needs the raw `POST .../views/{view}/share` call for
  that one property.
