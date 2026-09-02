---
title: Removing a member, and GDPR requests
description: Remove, Export, and Erase are three different actions in Settings → Members — offboarding, subject access, and irreversible erasure.
sidebar:
  order: 5
---

Settings → Members → a member's row, admin only. Three different actions, not one "delete member"
button, because they answer three different requests.

## Remove

Revokes the member's access to this workspace. **Their comments and history stay, still
attributed to them** — nothing they wrote disappears, and you can re-invite them later. This is
the ordinary offboarding action: someone left the team, not a legal request.

## Export

Downloads everything StoryOS holds about this member — a GDPR **subject access** request. Profile,
membership, access grants, authored records and comments, activity, favorites, notifications, API
tokens, attachments, files, and every field elsewhere in the workspace that references them.

## Erase

Fulfils a GDPR **erasure** ("right to be forgotten") request. **Irreversible, and requires typing
the member's name to confirm.** It:

- Wipes their identity to an anonymous tombstone (name, email, avatar).
- Destroys their sessions, sign-in credentials, and API tokens.
- Removes their access to every workspace they belonged to.
- Clears every custom column on their row in the auto-provisioned **Members** database — not just
  the built-in fields. If an admin added "Home address" or "Phone" as an ordinary column, erasure
  clears those too, in every workspace the person is a member of.

**Their comments and history stay in place, but are no longer attributed to a real person** — the
same non-destructive shape as **Remove**, plus the actual erasure of personal data. This is the
distinction worth holding onto: *Remove* takes away access without touching what they wrote,
*Erase* is for when the data itself must go.

## What erasure does not (yet) reach

- **Other system databases** provisioned the same way as Members — Agents, Runs, and the rest of
  the Agentic OS pack accept admin-added custom columns and are not touched by an erasure either.
  A known gap, not silently assumed safe.
- **The subject-access export** does not include the Members-database row itself, before or after
  an erasure — it covers the categories listed above, not a dump of every system database's
  fields.

Neither is a reason to avoid Erase; both describe the edge of what it currently covers.
