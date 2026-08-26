# Personal space: visibility, contents, and deletion

The rules for a per-member **Personal space** — who can see it, what it may hold,
what happens when someone leaves, and what deleting through it means. Decided on
paper first (#290) because all four are expensive to reverse once people have put
private notes in one.

> **TL;DR** — Personal is genuinely private: **not visible to admins, not in the
> export**. It holds **documents and views only**, never databases. A personal
> *view* is a window onto shared data, so deleting a record through it deletes it
> for everyone. Mentions inside personal content never notify. Moving content
> Publishing is a one-way MOVE; coming back is "Copy to My Space", a fork with no
> sync.

## 1. Visibility: private from everyone, including admins

**Decision.** A member's Personal space is visible only to that member. Workspace
admins cannot list, read, or search it. It is **excluded from workspace export**
and from backup-restore's user-facing output.

**Why.** "Personal" that an admin can read is not personal, and a feature people
don't trust is worse than no feature — they keep the private notes in another tool
and the workspace loses them anyway.

**The consequence, stated plainly.** When someone leaves, *their private documents
are unrecoverable.* Nobody can retrieve them: not their manager, not an owner, not
support. This is a deliberate trade, not an oversight.

Two obligations follow, and they are not optional:

- **Say so at the point of use.** The Personal section carries a one-line
  explanation ("Only you can see this. If your account is removed, this content is
  deleted with it."). Discovering this at offboarding is a support incident.
- **Deletion is real deletion.** When a member is removed, their personal content
  goes with them. Do not quietly retain it in the database while hiding it from the
  UI — that is the worst outcome: the privacy promise is broken *and* nobody can
  reach the content.

**Known limits of this stance.** It cannot satisfy legal hold, eDiscovery, or a
GDPR/DSAR export that must include everything a company holds about a person. An
operator with those obligations needs Personal disabled workspace-wide rather than
a back door added later — a back door would silently void the promise for everyone.
If that requirement appears, add an explicit, workspace-level "Personal spaces
disabled" setting; **do not** add admin visibility to the existing one.

## 2. Contents: documents and views. Not databases.

**Decision.** v1 holds **documents** and **views**. A Personal space may not contain
its own databases.

**Why.** A private database is a private *schema*: relations pointing into it,
rollups over it, and automations touching it would all have to reason about data
the reader can't see. That's a large surface for a leak, and the leak would be
silent. Documents and views cover the actual need — a scratchpad and a private lens
onto shared work.

The reference tool made the same call, and "no private databases" is their
single most-requested gap. Ours is a *deliberate v1 boundary*, not a permanent no —
**#296** tracks whether private databases become a differentiator later. Decide that
on its own evidence; don't let it leak in through a side door.

## 3. Deleting through a personal view

A personal **view** is a window onto shared data. The records in it belong to the
workspace. So:

**Decision.** Deleting a record through a personal view deletes it **for everyone** —
because it is the same record. The view is not a copy and not a container.

That is a genuine footgun: the surrounding UI says "Personal", which invites the
assumption that everything inside it is yours to discard. So:

- **The confirmation must name the blast radius**, not the view: *"Delete this
  record? It will be removed for everyone in the workspace — a personal view shows
  shared records, it doesn't own them."*
- **Deleting the personal VIEW is safe and must feel safe** — it removes the lens,
  never the records. Word it so the difference is obvious ("Remove this view? The
  records stay.").
- **A personal view cannot delete a DATABASE.** Schema-level destruction is not
  reachable from a personal lens, whatever the actor's role.
- Record deletion through a personal view still requires the actor's ordinary
  permission on that data. Personal grants nothing extra: it is a lens, never an
  escalation. A viewer with a personal view still cannot delete.

## 4. Mentions inside personal content never notify

**Decision.** An `@member` or `#record` mention written inside personal content
sends **no** notification and creates no inbox entry.

**Why.** A notification is a disclosure: "X wrote about you" leaks the existence,
timing, and often the subject of private content. Someone drafting a difficult
message about a colleague in their own scratchpad must not ping that colleague.

This is a **write-path rule, not a rendering rule** — suppress at emit time. Never
create the notification and then filter it on read: an inbox count, a digest email,
or a Slack delivery would leak what the UI hides.

Mentions still *render* and still link for the owner. The suppression is on
notification, not on the reference.

## 5. Publishing is a one-way move; coming back is a fork

**Decision (#293).** Personal → shared is a real **move**: the item leaves Personal
and lives in the shared space. The reverse is **"Copy to My Space"** — an
independent copy, owned by the user, with **no sync** between the two afterwards.

This supersedes an earlier draft of this ADR that called the pair "reversible". It
isn't a reversible re-point, and building one would be the wrong thing: two-way sync
between a private draft and a shared original is a merge problem nobody asked for.
A fork is honest about what it is.

Three rules make it safe:

- **The move confirmation says it is one-way and names the audience** — "This will be
  visible to everyone with access to <space>. You can copy it back later, but the
  copy won't stay in sync."
- **Publishing notifies at publish time.** Moving a doc that mentions people into a
  shared space *does* notify them then — that is the moment it stops being private,
  and the mention becomes a real one.
- **Moving out of Personal makes the item exportable again.** The export boundary
  follows the item's current container, never its history. Nothing to build, but it
  is asserted by a test so a refactor can't silently make the boundary sticky.

## Checklist — building a Personal-space slice (#291–#293)

- [ ] Enforcement is **server-side**, in the same grant path everything else uses.
      Never filter Personal content in the client — by then it's on the wire.
- [ ] Admin/owner roles get **no** implicit read. Test that an owner cannot reach
      another member's personal content by id, by search, by export, or by API.
- [ ] Export and backup-restore **exclude** personal content; a test asserts it.
- [ ] Notification suppression is at **emit** time; a test asserts no row is created,
      not merely that the UI hides one.
- [ ] Deleting through a personal view uses the blast-radius wording above.
- [ ] Databases cannot be created in, or deleted from, a Personal space.
- [ ] Publishing is a one-way move whose confirmation says so; "Copy to My Space"
      forks with no sync back.
- [ ] An item moved OUT of Personal is exportable again — asserted by a test.
