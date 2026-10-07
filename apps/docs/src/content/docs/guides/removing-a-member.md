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
tokens, attachments, files, and their own row in the auto-provisioned **Members** database
(built-in fields plus any admin-added custom columns).

**This only works before erasure.** The endpoint is addressed by the membership, so once that
membership is gone — because the person was erased, or because their last workspace membership
ended — it returns **404**, deliberately: there's no other stable way to identify whose data to
export at that point without working against the erasure it would be describing. Export while the
membership still exists if you'll need this later.

## Erase

Fulfils a GDPR **erasure** ("right to be forgotten") request. **Irreversible, and requires typing
the member's name to confirm.** It:

- Wipes their identity to an anonymous tombstone (name, email, avatar).
- Destroys their sessions, sign-in credentials, and API tokens.
- Removes their access to every workspace they belonged to.
- Clears every custom column on their row in the auto-provisioned **Members** database — not just
  the built-in fields. If an admin added "Home address" or "Phone" as an ordinary column, erasure
  clears those too, in every workspace the person is a member of.
- Clears the erased person's id from **every `user`-type field, on every database in the
  workspace** — not just Members. A multi-person field loses just their id; a single-person field
  pointing at them is cleared entirely. This reaches any database, not only system-provisioned
  ones.

**Their comments and history stay in place, but are no longer attributed to a real person** — the
same non-destructive shape as **Remove**, plus the actual erasure of personal data. This is the
distinction worth holding onto: *Remove* takes away access without touching what they wrote,
*Erase* is for when the data itself must go.

**`Created by` / `Updated by` lineage is never touched, on purpose.** Erasure removes a person as a
*value* on a field — a Person field pointing at them, a Members row — not their authorship of a
record. Audit history keeps its shape.

## What erasure does not reach, and won't

**Free text.** If an admin typed someone's name into a text field, a comment, or a Goal/Notes
field, erasure does not find or scrub it. **No mechanism anywhere in StoryOS — on any database,
Members included — scans free text for a match to a person.** This is a deliberate, accepted
residual risk, not an oversight to be fixed later: content-scanning for PII is a different, much
larger feature, and this page states the boundary rather than implying a guarantee that doesn't
exist.

**Non-`user` custom columns on other system databases.** Agents, Runs, and the rest of the Agentic
OS pack accept admin-added custom columns, exactly like Members — but unlike Members, none of them
is "a row that IS a specific person," so there's no single anchor row to clear the way a Members
row gets cleared. Nulling a Run's own Goal or Steps on someone's erasure would also destroy the
debugging record those databases exist to preserve. A `user`-type field added to any of these
**is** cleared by the rule above; a `text` or `rich_text` field an admin free-typed a name into is
not, for the same free-text reason as everywhere else.
