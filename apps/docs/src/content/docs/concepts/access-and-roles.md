---
title: Access & roles
description: Admins, members, and space-scoped guests — restrict a space or database to the people who need it, or invite a client into exactly one space.
sidebar:
  order: 7
---

Access in StoryOS starts from three roles. By default a member can open every shared space and
database; an admin can [restrict a space or a database](#restricting-a-space-or-database) so that
only the people added to it can. **Space scoping** lets you invite a guest into exactly one space.

## Roles

| Capability | Admin | Member | Guest |
|---|---|---|---|
| Manage workspace, members, invites, tokens | ✅ | — | — |
| Edit schema (spaces, databases, fields, relations) | ✅ | ✅ | — |
| Create / edit / delete records & views | ✅ | ✅ | — |
| Read records & views (guest: scoped spaces only; member: not what is restricted) | ✅ | ✅ | ✅ |
| Comment | ✅ | ✅ | ✅ |

- **Members can edit schema** in v1 — a small-team trust model. A "lock schema to admins" toggle is
  planned.
- The **last admin** cannot demote or remove themselves.
- Removed or deactivated users keep their historical authorship in comments and activity.

## Admin-only Settings pages

**Members**, **Billing**, **Integrations**, **Connections** and **Webhooks** are for workspace
admins. The Settings menu leaves them out for a member or a guest, and a member or guest who opens
one by its address, from a bookmark or a link someone sent, gets a short notice in place of the
page: *"Billing is for workspace admins"*, with a line saying their role and to ask an admin. The
page's own controls and data requests are not loaded, so nothing on it looks usable and then fails.

## Settings asks before the consequential actions

Eight actions in Settings stop for a confirmation that names who or what is affected. Cancelling
leaves everything as it was.

- **Settings → Members:** changing a member's role (moving someone off admin, or onto it, is stated
  first), removing a member, and revoking a pending invite.
- **Settings → Account:** removing your photo, and signing out one of your other devices.
- **Settings → API tokens:** revoking a token.
- **Settings → Webhooks:** enabling or disabling a webhook.
- **Settings → Integrations → Google Calendar:** removing a database's calendar mapping.

Each dialog says what happens next: for example that a removed member loses access right away but
their comments and history stay, that a revoked invite link stops working, or that a revoked token
stops working immediately and cannot be recovered.

## Restricting a space or database

By default every member can open every shared space and database, as a creator. An admin can
instead mark a space or a database **Restricted**. A member then sees it only if an admin has
added them to it. Admins always see everything, so a restricted space can never end up with nobody
who can manage it. Nothing changes for an existing workspace until an admin restricts something.

**To restrict one:** an admin opens **Manage access** — from a space's `⋯` menu in the sidebar or
the **Manage access** button on the space's own page, or from a database's menu — and picks
**Restricted** instead of **Everyone in the workspace**. Only admins see the item and only admins
can change it, including through the API; someone holding `creator` on a database still cannot
change who it is shared with.

Switching to Restricted opens a confirmation first. It lists the members who can open the item now
and will not afterwards. Each has a **Keep as Editor** tick (a guest's tick keeps the role they
have), and ticked people are granted access before the flag is set, so nobody you meant to keep is
locked out in between. Switching back to **Everyone** also confirms, naming the members who gain
access. Adding a person, changing their role and removing them save as you click, and a removal
offers **Undo**. The people you added stay on the list when you open the item up again, so
restricting it again brings the same people back.

A restricted space or database shows a small lock in the sidebar, for the people who can see it.

### What a member without access sees

Nothing. The space or database is not in the sidebar, not in search, and a direct request for it
returns **404** with no name in the response, the same answer as for something that does not exist.
A guest is narrowed the same way (see [Guest scoping](#guest-scoping)).

### How the rules combine

- **Grants add; they never take access away.** On something that is not restricted, a member
  already has full access and a grant changes nothing. On something restricted, a member holds the
  role of the grants that apply, and where several apply the highest wins. A member granted
  `viewer` on one restricted database is a viewer there and a creator everywhere that is not
  restricted.
- **Restricting a space closes every database in it.** A grant on the space opens them again.
- **Restricting a database closes only that database**, and it can sit in a space everyone can see.
- **A database that is itself restricted is opened only by a grant on that database.** A grant on
  its space does not open it, so a confidential database inside a shared team space stays closed to
  people who merely hold the space grant. The dialog lists these people as not seeing it.
  Un-restricting a space does not open a database in it that is itself restricted.
- **A grant on a database makes its space appear** in that person's sidebar, holding only the
  databases they can open.
- **Not everything can be restricted.** A personal space (already private to its owner) and a
  system database such as Members are refused with a **422**. A **record-scoped grant** can be given
  to a guest but not to a member; for a member it is refused with a 422, so share the database
  instead.

### Who it applies to besides people

- A [personal access token](/api/authentication/) acts as its owner, with the owner's access
  checked on every call, so revoking a person's grant takes effect on the token's next request.
- A token [bound to specific spaces or databases](/api/authentication/#binding-a-token-to-specific-spaces-or-databases)
  never reaches more than its owner does. Bound to a space, it opens a restricted database inside
  that space only if its owner holds a grant directly on that database.
- An [MCP](/mcp/overview/) agent connected with a token has exactly that token's reach.
- **Removing a member deletes their grants**, so re-inviting them later does not bring old access
  back. **Inviting someone as a member can carry grants** (space or database); the invite is
  refused with a 422 if it carries a record-scoped grant for a member, or any grants for an admin,
  who already sees everything.
- A notification about something that later became restricted, and that you can no longer open, is
  hidden from your inbox; see [mentions and notifications](/concepts/mentions-and-notifications/).

### From the API and MCP

`restricted` is a boolean on a space and on a database. Set it with the same `PATCH` that renames
them, as an admin; the MCP `update_space` and `update_database` tools take `restricted` too. It is
read back on the space and database. Adding or removing a person's access is not an MCP tool: see
the end of [Sharing beyond a space](#sharing-beyond-a-space-access-grants).
Restricting and un-restricting appear in the [audit log](/concepts/record-history/#workspace-wide-the-admin-audit-log).

### Not built yet

Groups (people are added one at a time), record-scoped access for members, letting someone other
than an admin manage who has access, and inviting a brand-new person from the Manage access box.

The **workspace export** records which spaces and databases are restricted and who holds grants;
see [taking everything out](/concepts/workspaces-spaces-databases/#taking-everything-out).

## Guest scoping

Guests are invited to one or more specific [spaces](/getting-started/concepts/):

- Everything outside their spaces returns **404** — not 403 — so the product never leaks the
  existence of resources they can't see.
- Cross-space relation chips on records they *can* see render **name-only and non-navigable**.
- Guests can read and comment, but aren't `@`-mentionable in v1.
- **Filters, sorts and aggregates give a guest no signal about hidden data.** A rollup or lookup
  derived through a relation to something the guest can't fully read is treated, when they
  filter, sort or aggregate, as if it didn't exist: the refusal is the same as for a field that was
  never there. A relation filter only sees links to records the guest can read, so asking "is it
  linked to this record?" about a hidden record gets the same answer as for one that doesn't exist.
  The relation's own settings no longer name a database the guest can't reach. Admins, members and
  guests with a grant on the far side are unaffected. **This is about querying only.** It is not a
  promise that nothing derived from hidden data can show up anywhere else a guest looks; other
  surfaces are narrowed one at a time (see the read paths above), so test with a real restricted
  account if the difference matters to you.
- **A computed record title is computed from what the viewer may read.** A database whose record
  title is computed from other fields shows a guest (or a token bound to specific spaces or
  databases) the title with any lookup or rollup input they can't read replaced by "—", and someone
  who can read those inputs still sees the full title. The same narrowed title is used when they
  search, filter or sort by title, so it can't be probed. It covers record reads and lists, relation
  chips, search, recent, favourites, write responses, backlinks, relation link lists, CSV export,
  notifications and history. Public and portal shares have their own rule, described under
  [what a visitor sees](/concepts/views/#what-a-visitor-sees). **That list is what is covered; a
  surface not on it is not covered by this.** Two people
  seeing different titles for the same record is intended.

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
**Resend invitation** and **Revoke**. Revoke asks first, naming the email address.

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

Each grant carries a **role** — `viewer`, `commenter`, `contributor`, `editor`, or `creator` — the
same ladder at every scope, not a second set of names to learn. A grant is exactly one scope;
there's no such thing as a grant that's both space- and database-scoped.

**Where more than one grant applies, the highest wins.** A record-scoped `editor` grant beats a
database-scoped `viewer` grant on that same record, in either order you'd naturally check them.

**A record-scoped grant is for "this record and nothing else."** Sharing one record does not extend
to other records it links to. A guest whose **only** access to a database is one or more record
grants no longer gets a 404 on the whole database: they can list and query it, and **see only the
records they were granted**. Read paths that were narrowed to match, one phase at a time (ticket
#474):

- record **list and query**, aggregates, and lookup **by record number**;
- **relation chips, rollups and lookups** — a granted record doesn't reveal the titles of ungranted
  records it links to;
- **search, "my work" and recent**;
- **backlinks** ("Mentioned in");
- a record's **activity, version history and comments**, and its **document** (description);
- **sub-items** — a sub-item lives in the same database as its parent, but a grant on the parent
  does **not** reach it: the parent shows no chip, id or title for it, the sub-item is a 404 by id
  and absent from lists, and a rollup over sub-items counts only the ones the guest can see.
  Granting one sub-item widens only that one;
- **activity and mentions** — events that name another record (a link added or removed, a mention)
  are left out of a record-scoped guest's activity, comment feed and mention chips when the guest
  can't read that other record. They are dropped rather than blanked, so no "linked something" row
  hints that it exists. Admins and members still see the full trail;
- **CSV export**;
- **automation runs** — the runs list and detail, and re-running an action, check the grant on the
  record the run fired on, so a guest granted record A can't re-run something that fired on its
  sibling B.

A guest who already holds a space or database grant is unaffected — they see what that grant covers,
as before — and so is everyone who isn't a guest. The restriction is enforced by the API, not only
hidden in the app. This describes what was built phase by phase against a read-path inventory; if you
rely on it to keep one client's data from another's, test with a real restricted account.

**Space- and database-scoped grants have a real UI: Manage access**, the same dialog used to
[restrict a space or database](#restricting-a-space-or-database). Open it from a space's own page
or from the `⋯` menu of a space or database in the sidebar (admins only). On something everyone can
open it shows who has access and lets you add a guest; on something restricted it lists the people
added, each with a role dropdown and a remove button. **Record-scoped grants have no UI yet** —
creating or revoking one is still a direct REST API call. No MCP tool creates or removes a grant at any scope; that stays a human decision made
directly against the API, not something an agent does on its own. The MCP `list_grants` tool can
still read existing grants, record scope included.

## Personal access tokens

A [personal access token](/api/authentication/) (`mn_pat_…`) acts as **its creator** — same role,
same guest scoping, and the same [restricted](#restricting-a-space-or-database) spaces and
databases. That's also an agent's blast radius: give an [MCP](/mcp/overview/) agent a
token scoped to one guest's spaces and it can only touch those.
