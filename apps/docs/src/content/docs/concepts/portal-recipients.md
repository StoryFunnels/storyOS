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
- A **signed token** (HMAC), never a bare random string — it embeds the recipient's id and a
  version number, verified without a database read before the request ever reaches the row, so a
  tampered or forged token is rejected outright rather than merely failing to match.
- An optional **expiry**: an expired token is refused the exact same way a revoked one is — no
  visible difference in the error, so a caller can't distinguish "revoked" from "simply timed out."
- Creating a recipient never creates a user, never sends an invitation, and never changes your
  billable seat count — whether you create one recipient or fifty.

## Creating and managing recipients

There's no web UI for this yet — it's API and MCP only:

- `POST /api/v1/workspaces/:ws/portal-recipients` (`create_portal_recipient`) — `label`, optional
  `email`, `linked_record_id`, and `expires_at` (an ISO datetime; absent means it never expires).
- `GET /api/v1/workspaces/:ws/portal-recipients` (`list_portal_recipients`) — read-only.
- `POST /api/v1/workspaces/:ws/portal-recipients/:recipient/revoke` (`revoke_portal_recipient`).
- `POST /api/v1/workspaces/:ws/portal-recipients/:recipient/rotate` (`rotate_portal_recipient`) —
  issues a fresh token for the same recipient and invalidates the old one **atomically**: there's
  no moment where both work, and none where neither does. Use this when a link may have leaked but
  the recipient themselves is still legitimate — revoke throws them out entirely; rotate just
  changes their key.

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

## Seeing what a client actually saw

`GET /api/v1/workspaces/:ws/portal-activity` (`list_portal_activity`) — admin-only, filterable by
recipient and/or published view — records every recipient-scoped access: which recipient, which
view, when, and whether it was **served** or **rejected** (with a reason for the latter).

- **"Served" answers "did they look", not "did they see rows"** — a fail-closed scope that
  legitimately returns zero rows still counts as served; the log isn't a second row-level audit,
  just an access record.
- **No IP address or user-agent is ever recorded, by design.** The operator's actual question is
  whether a client looked, which needs neither, and a client didn't consent to being profiled by the
  agency running their portal.
- **A revoked recipient's history survives revocation.** Cutting off a client's future access is a
  different action from erasing the record of what you already showed them — the second one is
  exactly what someone reaches for this log to check.
- **A garbage or expired token that never resolves to a real recipient is never logged here** — this
  is an audit trail for identified clients, not a generic hit counter for anonymous requests.
- **A logging failure never blocks the portal itself.** If the write fails, the client still sees
  their content; the failure is visible to you, not to them.
