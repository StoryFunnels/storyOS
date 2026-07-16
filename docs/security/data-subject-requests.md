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
