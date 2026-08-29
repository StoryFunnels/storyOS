# Data protection & GDPR

StoryOS ships operator tooling to fulfil GDPR (and comparable) **data-subject
requests** — the right of access (export) and the right to erasure — without a
database console. Both actions are **workspace-admin only** and available in the
UI and over the API. (MN-233)

## Right of access — export everything about a user

- **UI:** Settings → Members → **Export** next to a member. Downloads a
  machine-readable JSON file.
- **API:** `GET /api/v1/workspaces/{ws}/members/{member}/gdpr/export`
  (admin token / admin scope).

The export gathers, within the workspace: the person's profile (name, email,
avatar, timestamps), their membership and access grants, the records they
authored or last edited, the comments they wrote, their activity trail, their
favourites, their notifications, API-token **metadata** (never the secret), the
files they uploaded, and every record that references them in a `user`-type
field. Token hashes, passwords, and other secrets are never included.

## Right to erasure — anonymize a user

- **UI:** Settings → Members → **Erase**. A confirmation dialog requires you to
  type the member's email; it spells out that the action is irreversible.
- **API:** `POST /api/v1/workspaces/{ws}/members/{member}/gdpr/anonymize`
  (admin token / admin scope).

Erasure is an **anonymization to a tombstone**, chosen so that shared work stays
usable while the personal data is removed:

- The person's identity is wiped — name becomes “Deleted user”, email is
  replaced with a non-routable placeholder, the avatar is cleared.
- All **sessions, sign-in credentials (password/OAuth), and API tokens are
  destroyed**, so the account can never authenticate again.
- Their **access to the workspace is removed** — membership, access grants,
  favourites, and notifications are deleted.
- **Comments, records, and history are kept**, still linked by an opaque id that
  now resolves to the tombstone. This preserves the integrity of threads and
  audit trails that other people rely on, while no longer attributing them to a
  named individual. Attribution across the app renders as “Deleted user” /
  “(deactivated)”.

### The Members database is erased too

Members is a **first-class database** in the workspace, not just an internal table — its rows are
visible, assignable and linkable like any other. Its entire content is personal data, so an
erasure has to reach it, and it does:

- The member's row is **overwritten**, not just deactivated. Name, email and avatar are replaced
  with the same anonymised values written to the account itself, and the row is marked inactive.
- **The row survives, deliberately.** Deleting it would orphan every record assigned to that
  person. So the person stops being identifiable while their assignments stay resolvable — the
  same tombstone-plus-overwrite trade the rest of the erasure makes.

This is worth stating explicitly because it is a place an incomplete erasure would have been
invisible: Members is excluded from workspace export, so an export would not have revealed a stale
name sitting in it.

**Every workspace, not just the one that asked.** An account is global, so the erasure overwrites
the person's Members row in *every* workspace they belong to. Only the workspace that requested it
marks them inactive — a GDPR request in one workspace is not a resignation from another.

> **Know this before you add fields to Members.** The erasure overwrites **name, email and avatar**.
> Any *additional* field your workspace has added to the Members database — a phone number, a home
> address, a personal note — is **not** touched, and will survive the erasure. If you extend
> Members with personal data, clearing it is currently your responsibility, not the erasure's.

Note the distinction from an ordinary **removal**, which is not an erasure: removing someone marks
their Members row inactive and **keeps** the name, email and avatar, on purpose, so that a record
assigned to them still resolves to a human. That is exactly the wrong behaviour for an erasure,
which is why the two are separate operations rather than one with a flag.

The last remaining admin of a workspace cannot be erased — promote another admin
first. Because a person is a single account, wiping the identity is inherently
global; a workspace admin's erase additionally strips access only within their
own workspace.

## Retention

- **Records** use soft-delete with a 30-day trash before permanent removal.
- **Fields** are soft-deleted; orphaned values are ignored on read.
- **Databases** are hard-deleted behind a typed-name confirmation.
- Erasure/anonymization takes effect immediately and is not reversible.

## Residency

StoryOS is self-hosted: all data lives in **the single Postgres instance you
run**, in the region you deploy it to, plus your configured attachment storage
(local disk or an S3-compatible bucket you control). There are no StoryOS-side
data stores in the self-hosted deployment.

## DPA & subprocessors

When you self-host, **you are the data controller and processor** — StoryOS (the
project) does not receive or process your users' data, so no DPA with the project
is required. Your own subprocessor list is whatever infrastructure you run
StoryOS on (your cloud provider, your object storage, your SMTP provider).

For the **managed hosting** offering (not part of self-hosted StoryOS), a Data
Processing Agreement and a maintained subprocessor list are published separately
before any customer data is processed.
