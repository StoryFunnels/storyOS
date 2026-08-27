# ADR-0017 — Members: workspace people as a projected system database

**Status:** proposed — drafted from the implementation, awaiting founder review (#320)
**Supersedes:** nothing. **Builds on:** ADR-0002 (jsonb record storage), ADR-0006 (spaces as the guest-scoping unit), ADR-0007/0009 (the grant ladder), ADR-0012 (field → relation conversion).
**Implements the record that #128 promised and never wrote.**

## Why this document exists at all

#128 shipped. Members provisions per workspace, an accepted invite becomes a member
row within seconds, guests are included, tombstones work. The *build* is real and
verified.

What #128 did not produce was the ADR that was its headline deliverable. #145 —
the assignee cutover from a `user` field to a real Members relation — is a data
migration over every assignee value in every workspace, and its plan was supposed
to live here.

So this ADR is written **from the code**, deliberately. Almost everything below is
a decision that has already been made and shipped; writing it down is the work.
Where the code does not answer a question, this document says **OPEN** rather than
inventing an answer. There are nine of those and several are load-bearing.

---

## 1. The model: a per-workspace projection, not a global people table

**Decided, shipped.** `memberships` + better-auth `user` remain the identity source
of truth. The Members database is a **one-way projection** of them into ordinary
`databases` / `fields` / `records` rows (`members-db.service.ts:62-74`).

The alternative — a global People table that workspaces reference — was not taken,
and the code's reasoning holds up: a person's *name in a workspace* is workspace
data, while their *account* is not. Projecting per workspace means a Members row
can be related to, filtered on, rolled up and shown in a view like anything else,
without inventing a second kind of database.

**The cost, stated plainly:** one human in N workspaces is N Members rows with N
different record ids. Nothing in the code addresses whether that is intended.
**OPEN-1.**

**Memberships, not global users, is the unit.** A Members row is
"person-in-THIS-workspace". Role on the row is the *membership* role
(`admin | member | guest`) — never a grant role. Grants are not projected at all,
which is right: ADR-0007's ladder is per space/database and would not fit in one
column.

## 2. Identity: `is_system`, plus a name — and the name is the weak part

**Decided, shipped.** System databases are found by `databases.is_system`
(`db/schema.ts:283`), not by display name. `is_system` cannot be set over HTTP —
`createDatabaseSchema` does not carry it — so it cannot be forged
(`databases.service.ts:274-280`).

That flag exists because of a real incident (#317/#318): a user who made their own
database called "Members" was handed the projection, which then rewrote their
schema, wrote every colleague's email into their records, and stopped tombstoning
removals because the real projection was never found.

**The problem is not fully closed.** The lookup is still
`isSystem = true AND name = 'Members'` (`members-db.service.ts:99-108`), and any
user with `creator` can rename a database — no guard exempts a system one. Rename
"Members" and:

- `tombstoneMembership` becomes a silent no-op (`:318-319`),
- `resolveMembersForUsers` returns an empty map (`:356-357`),
- the next `ensureMembersDb` **provisions a second Members database** (`:134-161`).

That is the #318 failure class re-entered through a different door. There is also
no unique constraint expressing "one Members projection per workspace" — the only
defence is a deterministic `orderBy` so at least the same duplicate wins every time.

**Recommendation (needs a decision):** give system databases a *discriminator*
(e.g. `system_kind: 'members' | 'agents' | 'runs' | 'agent_triggers'`) with a unique
index on `(workspace_id, system_kind)`, and stop matching on name entirely. Agents
disambiguates by flag-plus-name too (`agents.service.ts:241`), so this is one fix
for two subsystems. **OPEN-2 — is this worth a migration now, or does it wait?**

## 3. The sync contract

**Decided, shipped.** An in-process event bus, not a DB trigger and not a job.

`MembershipEventsService` carries `membership_changed` / `membership_removed`;
`MembersProjectionSubscriber` handles them. The bus exists to break an import cycle
— `MembersDbModule` sits above `WorkspacesModule` — and that is documented at the
bus itself (`membership-events.service.ts:26-37`).

Three properties worth preserving, all deliberate:

- **Emitted after commit, always.** A projection hiccup never fails workspace
  creation or invite acceptance (`workspaces.service.ts:66-69`).
- **Serialised per workspace.** Two changes never interleave
  (`members-projection.subscriber.ts:49-60`).
- **Failures are warnings.** The projection is a cache with a backfill, not a
  transactional invariant.

Emit points: workspace created, invite accepted (member *or* guest), role changed,
member removed. Boot runs `backfillAll()` outside tests.

Copied from `user`: name (falling back to email, then `(unknown user)`), email,
image. From `memberships`: role. `active` is forced true on every sync, which is
how a re-joining member is reactivated.

### The gap: profile edits do not propagate

**This is a real defect, found while writing this ADR, not a design decision.**

An avatar change writes `user.image` directly (`users.controller.ts:64,74`) and
emits nothing. A display-name change goes through better-auth's client from the web
app and never touches API code at all
(`app/w/[ws]/settings/account/page.tsx:134`). Email change: no emit path found.

So a renamed user's Members row is **stale until their next role change or the next
API boot**. Every surface that reads Members shows the old name.

**GDPR erase has the same shape and worse consequences.** `GdprService.anonymize`
deletes the `memberships` row and wipes the `user` PII, but emits no event
(`gdpr.service.ts:320-444`). The Members row keeps the erased person's real name,
email and avatar, and stays `active = true`. For a surface whose whole job is
holding personal data, that is the wrong default.

**Recommendation:** emit `membership_changed` on profile update and on GDPR
anonymize. Small, and it closes both. Filed rather than fixed here because it is
not #320's scope — **these should become tickets.**

## 4. Field ownership

**Six projected fields** (`members-db.service.ts:166-203`): `name` (title),
`email`, `avatar` (url — there is no image field type), `role` (select mirroring
the membership enum), `active` (checkbox), `user_id` (text, hidden).

`user_id` is **the projection key** and is hidden rather than deleted (#319),
because `findMemberRow` locates a row by matching it. A user who deletes that
column breaks the projection silently.

**Ownership is convention, not enforcement.** None of the six is created with
`isSystem: true`, so none of the field-level guards
(`fields.service.ts:632-634,808,825`) applies. Email, Avatar, Role, Active and
User ID are ordinary renameable, retypeable, **deletable** fields.

**OPEN-3 — should the projected fields be marked `is_system`?** The guards already
exist; this is a one-line change per field plus a backfill. The argument against is
that it also blocks harmless things like reordering. The argument for is that
today a rename of `user_id` corrupts the projection with no error.

## 5. Permissions — the honest answer is "none"

**There is no write-protection on the Members database.** This is the most
consequential finding in this document and it is not written down anywhere else.

- Any **contributor** on the containing space can create, edit and delete Member
  rows by hand (`records.controller.ts:65,77-91`).
- Any **creator** can rename the database — see §2 — or **delete it outright**
  (`databases.controller.ts:79-88`). The projection would re-provision on the next
  `ensureMembersDb`, **losing every tombstone**, which is the one thing tombstones
  exist to prevent.
- A hand-created row with no `user_id` is invisible to `findMemberRow` and survives
  forever as a duplicate. No test covers this.

What `is_system` actually gates is **reads and exports**, never writes: excluded
from workspace export, pack export, the onboarding checklist and admin counts.
Members *is* returned by `GET /databases` and by MCP `list_databases`.

**OPEN-4 — what is the intended write model?** Three coherent answers: (a) read-only
except to the projection; (b) rows read-only, schema extendable so a workspace can
add its own columns like "Desk" or "Start date"; (c) leave it fully open and accept
that a workspace can break its own projection. The code currently implements (c) by
omission rather than by decision. **(b) is the recommendation** — it preserves the
"Members is a database like any other" promise while protecting the six columns the
projection owns.

**OPEN-5 — should Members appear in `list_databases`, MCP and the sidebar?** No code
decides this either way.

## 6. Guests and viewers

**Decided, shipped.** Guests **do** get rows — that is the point of a workspace
people list rather than a staff list. The `role` select carries `guest` explicitly.

"Viewer" is not a person type. It is a *grant* role from ADR-0007's ladder. A
viewer is a member or guest who happens to hold a viewer grant, and gets an
ordinary row. The Members database stores no grant information at all.

A guest invite without at least one grant is refused in the schema layer
(`packages/schemas/src/workspaces.ts:97-107`), and a grant-less guest is
non-billable.

## 7. Removal: tombstone, never delete

**Decided, shipped, and this one is firm.** Removing a member flips `active` to
false and keeps the row (`members-db.service.ts:317-330`). A hard delete would
orphan every record assigned to that person.

`resolveMembersForUsers` deliberately **includes** tombstoned rows: an assignee
pointing at a removed member resolves to their inactive row, never an error
(`:342-344`). Re-joining reactivates the same row rather than creating a second.

Removal deletes the membership, the member's personal views and their personal
space — "never records, never databases" (`members.service.ts:120-133`). That is
consistent with the personal-space ADR's rule that removal must really delete
personal content.

## 8. The assignee migration (#145) — what it actually costs

**Today** an assignee is a `user`-typed field holding a **bare better-auth user id**
as a JSON string, or an array of them when `multi`
(`packages/schemas/src/record-values.ts:235-245`). Writes accept an id, an email or
an exact display name and resolve against a directory built from `memberships` +
`user` — **not** from the Members database
(`records.service.ts:1502-1580`). That resolver exists because of MN-118, where
`assignee: 'Ievgen'` was stored verbatim: silent corruption with a success receipt.

**Phase 2 shipped a resolver, not a wiring.** `resolveMembersForUsers` has no
production caller — it appears only in its own definition and its test. Anyone
reading the code and concluding "Members already backs assignees" would be wrong,
and that misreading is exactly what this ADR is here to prevent.

**A cutover has to touch, at minimum:**

*Storage & validation* — the `user` branch of `record-values.ts`; `'user'` in
`creatableFieldTypeSchema` and `IMPORTABLE_FIELD_TYPES`; the `field_type` pg enum;
`userDirectory`/`resolveUserInputs`.

*Filters* — `query-compiler.ts` (`compileIdSet`, `presentExpr`, and `resolveMe`
for `value === 'me'`) and `findMeReference`, which blocks "me" inside filtered
rollups.

*Sorts* — `'user'` in `SORTABLE`; multi-user sort is refused today. Note that
sorting by assignee currently sorts by the **raw user id string**, not by name —
a relation would incidentally fix that, and it is worth saying so out loud because
it changes existing view output.

*Other reads* — search `DENSE_TYPES` and the My Work "assigned to me" predicate;
GDPR's `userFieldReferences` raw-SQL scan of both value shapes; assignment
notifications; public forms (which expose a member roster of id + name);
`notify_user` in automations; CSV import coercion; `referencedUserIds`.

*MCP* — the `user` op vocabulary, the `@me` rewriting, `'user'` in `create_field`,
and board `group_by`.

*Web* — `cells.tsx` display and editor, `useMembers` (**the UI's person source is
`GET /members`, not the Members database — it does not read Members at all today**),
board grouping, `groupable-fields`, form fields, paste, My Work grouping,
automations, mentions, record detail, add-field dialog.

**Sequencing recommendation.** ADR-0012 already designed guided, dry-run field →
relation conversion. #145 should be its first real consumer rather than a bespoke
migration: convert per field, dry-run first, keep the `user` type readable for a
release, and cut the UI over last. A big-bang enum change with no dry run over
"every assignee value in every workspace" is the version that goes wrong quietly.

**OPEN-6 — does the `user` field type survive the migration** as a lightweight
"just an account" type, or is it retired entirely once Members relations exist?

**OPEN-7 — a caution on ticket numbering.** The only in-repo reference to `#145`
(`fields.service.ts:784`) defers *relation traversal in computed names* to it, and
`tickets/MN-145.md` is an unrelated, done invites bug. Confirm the number before
building against it. This is the same stale-numbering hazard CLAUDE.md's version-
history block already had to correct in itself.

## 9. Remaining OPEN questions

- **OPEN-1** — N rows for one human across N workspaces: intended, or an accident?
- **OPEN-2** — add a `system_kind` discriminator + unique index, or live with name matching?
- **OPEN-3** — mark the six projected fields `is_system`?
- **OPEN-4** — the write model: locked, rows-locked-schema-open, or open? (recommendation: rows locked, schema open)
- **OPEN-5** — should Members be listed in `list_databases` / MCP / the sidebar?
- **OPEN-6** — does the `user` field type survive #145?
- **OPEN-7** — confirm #145 is the ticket this plan belongs to.
- **OPEN-8** — profile-edit and GDPR-erase propagation: file as tickets against this ADR.
- **OPEN-9** — what should happen when someone hand-edits or hand-creates a Members row? No guard, no test, no stated intent.
