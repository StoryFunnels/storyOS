# Where a view lives: ownership, placement, and the sidebar tree

The rules for **where a view belongs and where it appears** — two different
questions that the same table has to answer. Decided on paper first (#349)
because four tickets depend on the answer (#347, #304, #306, #348) and one part
of it amends a comment in `schema.ts` that was itself written to stop a question
being re-litigated.

> **TL;DR** — A view keeps its **owning database**. It *additionally* gets a
> **place in the sidebar tree**, next to documents. Ownership and placement are
> different columns. `database_id` becomes nullable so a dashboard can exist
> without one, guarded by a CHECK: **a view has a database XOR a space**. A
> view's home falls out of its columns — there is no `placement` enum. Access is
> **space for the door, each source for the room**. No user-mode toggle.

## 1. Placement is separate from ownership

**Decision.** A view continues to belong to its database. Being reachable from
the sidebar is a *placement* fact, stored separately, and does not change who
owns the view or what deleting the database does to it.

**Why.** The two questions have different right answers. "Which database's rows
does this view show" is a data question with one answer forever. "Where do I
click to get to it" is an organisation question people change weekly. Collapsing
them means re-parenting a view every time someone tidies their sidebar, and
re-parenting is how cascade-delete semantics get quietly broken.

**Consequence.** `onDelete: 'cascade'` from `databases` keeps doing real work: a
view dies with the database whose rows it shows, wherever it happened to sit in
the tree.

## 2. The tree is `Space → Folder → ( Database | Document | View )`

**Decision.** Views become the third leaf type in the existing sidebar tree.

**How much of this already exists — corrected 2026-08-21.** An earlier revision
of this ADR claimed "mixed leaf types in one folder already render". **That was
wrong**, and the correction matters because it changes what #347 costs.

What is actually true:

| Piece | State |
|---|---|
| `space_folders` table (MN-096) | Exists, used |
| `databases.folderId` | Exists, returned, rendered, draggable |
| `space_documents.folderId` | **Column exists — never returned by the API, never rendered** |
| views in the tree | Nothing at all |

`FolderSection` in `apps/web/src/components/sidebar.tsx` takes a `databases`
prop and only that. `SpaceDocumentsService.list` returns
`{ id, space_id, title, icon }` — no `folder_id`. So documents are a leaf type
that was given the column and never wired up, and **folders today hold databases
only.**

Two consequences:

- The tree is **not** yet multi-type. Adding views makes it multi-type for the
  first time, so `FolderSection` has to generalise rather than take one more prop.
- **There is no document drag handler to reuse.** The pattern to follow is the
  DATABASE one (`moveToFolder` → `updateDatabase({folder_id})` plus the dnd-kit
  `onDatabaseDragEnd`). Any instruction to "reuse the document handler" is
  pointing at something that does not exist.

Documents being half-wired is its own small gap — worth finishing while
`FolderSection` is being generalised, since it is then nearly free — but it is
not a prerequisite for views.

**Therefore: do not introduce a fourth container.** Anything that wants a home in
the sidebar becomes a leaf type on this tree. A "dashboard container", a "board
group", a "saved query object" — each would be a parallel hierarchy with its own
folder semantics, ordering, and access rules to keep in sync.

## 3. A view has a database XOR a space, enforced by a CHECK

**Decision.** `views.database_id` becomes nullable. `views.space_id` is added,
nullable. A database CHECK enforces exactly one:

```sql
CHECK ((database_id IS NULL) <> (space_id IS NULL))
```

**Why nullable at all.** A dashboard (#306) and a multi-source view (#348) have
no single owning database. Modelling them as "a view of one database that
ignores its database" is the fiction that produced #304 — tiles that inherited a
source they had no business inheriting.

**Why XOR rather than "at least one".** A view with both set has two possible
homes, so every read needs a tiebreak rule, and a tiebreak rule applied in five
places gets applied inconsistently in the sixth. `space_id` for a
database-owned view is resolved by **joining through the database**, never
stored — one source of truth.

**Precedent.** `access_grants_scope_xor` (MN-125) is the same shape, and it
exists because the service "always checked" a scope invariant that turned out
not to hold. A CHECK is cheaper than the incident.

**The CHECK is a backstop, not the error message.** `POST/PATCH /views` must
reject a body setting both, with a message naming the rule. A 500 from a
constraint violation is not an API contract.

## 4. A view's home falls out of its columns — no `placement` enum

**Decision.**

| `database_id` | `folder_id` | Where it renders |
|---|---|---|
| set | null | Nested under its database. **The default for every view today.** |
| set | set | In that folder, out of the database's children. |
| null | null | At the space root (`space_id` required). |
| null | set | In that folder. |

**One home at a time, never two.** A view nested under its database *and* pinned
to a folder would need a de-duplication rule in the tree renderer and an answer
for what the breadcrumb says. Dragging a view into a folder **moves** it, exactly
as it does for a document.

**Why no enum.** A `placement` column would be derivable from the other two and
could disagree with them. Derived state that can go stale is a bug generator; the
columns already encode the answer unambiguously.

## 5. #291's privacy rule survives intact — only the ownership half is amended

The comment on `views.ownerUserId` currently reads:

> *"A view belongs to its DATABASE and always has — a personal view is a private
> WINDOW onto shared data, not a private container."*

**Still true, and load-bearing:** `ownerUserId` is the privacy signal;
`createdBy` is not. A personal view is a private **window** onto shared data, not
a private container. Deleting a record through one deletes it for everyone, and
the confirmation names that blast radius. A personal view **placed in a folder is
still personal** — `notOthersPersonalView` applies to sidebar-placed views
exactly as it does to tabs.

**Amended:** "and always has" a database stops being universally true once a
dashboard has no database.

**State both halves whenever this is cited.** An unqualified "that comment is out
of date" invites the reader to discard the privacy half too, and the privacy half
is the one that leaks if forgotten.

**A personal view does NOT get `space_id` pointing at the personal space.**
`personal-space.md` §2 holds that a personal space contains documents and views
and **never databases** — precisely because a private container for shared data
is the thing being avoided. A personal view keeps `owner_user_id` + its
`database_id`. Only a database-less view needs `space_id`. A personal *dashboard*
(#223) is the one new case: `owner_user_id` set and `space_id` set, with no
database — permissible because it composes queries rather than containing data.

## 6. Access: the space is the door, each source is the room

**Decision.** Two gates, in order:

1. **The space.** Can the viewer see the space the view sits in *at all*? No →
   404. This is the door.
2. **Each source database.** Resolve every source against the **viewer** with
   `AccessService.effectiveForDatabase`, and drop the sources that return null.

If **zero sources survive**, render the view with an explicit "you don't have
access to the data behind this view" — **not** a 404, and **not** an empty grid.
The viewer can legitimately see the view in their sidebar; pretending it does not
exist is the confusing answer, and an empty grid is a lie.

**Use `effectiveForDatabase` (returns null), not `DatabasesService.assertAccess`
(throws).** Per-source filtering needs a value it can branch on; a throw collapses
the whole view when one source is unreadable.

### The door is `visibleSpaceIds`, NOT `assertSpace` — corrected 2026-08-21

An earlier revision of this section said `assertSpace`. **That is wrong, and it
404s a space the user is actively looking at.** Found by test while building
#347's endpoint.

`assertSpace` → `effectiveForSpace` matches only **space-scoped** grants. But
`visibleSpaceIds` adds the **parent space of every database-scoped grant** — so a
guest granted one database sees that space in their sidebar, clicks it, and
`assertSpace` denies a space the product just showed them. The two functions
disagree about what "can see this space" means, and the sidebar follows
`visibleSpaceIds`.

So the door is:

1. Space exists in this workspace, else 404.
2. `canSeePersonal` — #291, no admin bypass — else 404.
3. `visibleSpaceIds(membership)`: `null` means full access (admin/member); a Set
   must contain this space, else 404.

Then the per-database filter decides what is actually in it. Note that step 3
alone is *not* sufficient — it is exactly the space-only shortcut this section
warns about — which is why the per-source check is not optional.

### The fact that makes this cheap

**Only guests can have partial access.** `effectiveForDatabase` returns `admin`
for admins and `creator` for members *without consulting grants at all*
(ADR-0009: members are workspace-wide creators). For everyone but guests there is
no problem to solve.

**So any test for this needs a GUEST fixture, or it proves nothing.** A test
written with a member fixture passes whether the rule is implemented or not.

### The trap that makes it necessary

Gating on the **space alone** is the tempting shortcut, and it leaks in exactly
one real case: a guest granted a single **database** still sees the parent space
in their sidebar, because `visibleSpaceIds` adds the parent space of every
database-scoped grant. A space-only check hands that guest every other table the
view touches.

### This is not new

`dashboard-view-plan.md` §3 already specified per-widget `database_id` gated with
the requesting user's membership, and already flagged omit-vs-placeholder as a
follow-up UX call. That follow-up is #304. This section generalises the same rule
from widgets to any view source; it does not invent a new access primitive, and
nothing here needs row-level ACLs or a view-specific grant type.

## 7. No user-mode / setup-mode toggle

**Decision.** Databases stay visible in the sidebar, with their views nested
beneath them.

**Why record a non-decision.** The reference tool solves the maker/user tension
with a mode switch that hides databases and shows only views, documents and
folders. It is a genuinely good answer and we are not building it — founder,
2026-08-21: *"which we don't have and won't have for now."* Without a toggle, one
tree serves both audiences, which is why views nest under their database rather
than replacing it.

Recorded so the toggle is not re-proposed as the obvious fix the first time a
sidebar looks busy. If it is ever revisited, it is a product decision, not a
tidying exercise.

## 8. Build order

**#349 (this) → #347 → #304 → #306.**

- **#347** does the schema and the tree. The only migration.
- **#304** makes a dashboard tile name its own source.
- **#306** moves the container, and is small by the time it starts.

**Why #306 is last, restated because it is counter-intuitive.** Relocating the
dashboard container before its tiles are self-describing moves an empty shell:
every tile still points at a database the dashboard no longer has, so the
migration has to be done twice. This was #306's own recorded reasoning and it
survived the respec.

**#347 ships no URL changes.** A view nested under its database keeps
`/w/[ws]/d/[db]?view=…`. The view-first route arrives with #306, which is the
first thing that needs it — so no dead routes ship in between.

## 9. Deliberately not decided here

- **Multi-source views with nesting** (#348) — the reference tool's "Items"
  panel. Its own ADR: `multi-source-views.md`. Must be reconciled with #233
  (parent/child row expansion) so only one row-tree implementation gets built.
- **Workspace-root dashboards** — deferred until space-level dashboards are in
  use. A dashboard spanning every space needs its own answer for what a viewer
  with partial access sees; #304 scopes its tile picker to the space for the same
  reason.
- **Whether databases eventually leave the tree** — not now. See §7.

## Checklist for a PR touching view placement

- [ ] The CHECK still holds: no code path can write both `database_id` and
      `space_id`, or neither.
- [ ] A view appears in exactly one place in the tree.
- [ ] Per-source access resolved against the **viewer**, with a **guest** fixture
      in the test.
- [ ] Zero readable sources renders a reason, not a 404 and not an empty grid.
- [ ] `notOthersPersonalView` applied wherever views are listed.
- [ ] `describe_database` still lists a database's views after one is moved into
      a folder.
- [ ] `FolderSection` is GENERALISED over leaf types — not given a second prop
      per type. It takes `databases` only today; views make it multi-type for the
      first time (see §2), and one more prop is how seven of them accumulate.
- [ ] Placement reuses the DATABASE drag pattern (`moveToFolder` →
      `updateDatabase({folder_id})` + `onDatabaseDragEnd`). There is no document
      drag handler to copy.
