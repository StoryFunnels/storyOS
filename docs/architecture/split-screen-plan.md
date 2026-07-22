# Split-screen entity panels: scoping doc

Status: **plan only — no split-screen behavior ships from this doc** (#282).
This is the scoping pass the ticket asked for: an interaction model, an
integration plan against the existing record-page architecture and MN-230b's
mobile work, and a routing-model decision. Implementation is deliberately out
of scope; the end of this doc lists the follow-up tickets it unblocks.

Source: StoryOS ticket #282, whose `details` field contains the founder's
direct answers (marked `->`) to the four open questions the original ticket
raised. Six screenshots are attached to #282; the MCP connection available in
this session exposes attachment **metadata** (filename/size/mime) but not
attachment **content** for the StoryOS issues database, so the images could
not be rendered here. Everything below is derived from the founder's written
answers, which are complete enough to scope the feature — flagged inline
wherever a screenshot might carry pixel-level detail (exact strip width,
control icon, spacing) that this text-only pass can't confirm.

## 1. Current state (why this is needed)

Today, clicking a reference to another record — a relation chip in a table
cell, an entity in a record's own relation/collection list, a search or
command-palette result, a card in a gallery/board/calendar view — replaces
the current page with the target record's page (`/w/[ws]/d/[db]/r/[rec]`).
The context you clicked from is gone; back-button is the only way back.

One surface already grew a stopgap: `RelationChip` in
`apps/web/src/components/table-view/relation-cell.tsx` (landed in #293,
2026-07-22) renders chips as real links that open the target record **in a
new browser tab**, with the code comment `full split-screen is #282's job` —
i.e. that repo already knows this doc is coming and left the actual
navigation-replacement decision to it. This scoping doc supersedes that
stopgap's target behavior; the follow-up "wire the surfaces" ticket below
should retire the new-tab behavior in favor of split panels.

## 2. Interaction model

### 2.1 Scope — replaces navigation everywhere (founder-decided)

Split-screen is the **only** way related entities open, on every surface that
today links to a record: table relation-cell chips, a record's own
relation/collection lists (`components/entity/collection-section.tsx`),
search and the command palette (`components/command-palette.tsx`), and
record cards in list/board/calendar/gallery views. There is no
per-surface opt-out. Concretely this means every one of those click
handlers changes from "navigate" (`router.push` / `<Link href>`) to "open in
split panel" — see §6 for the full surface list.

The base/current view itself is unaffected by this rule: you still land on a
record via direct navigation, a bookmarked URL, or the sidebar/My Work. Only
*secondary* references — the click that today jumps you away from what
you were looking at — become split-panel opens.

### 2.2 Stacking model (founder-decided, elaborated)

The founder's answer: panels **can** stack, and opening a new one collapses
the previous into a "~1cm-wide vertical strip with nav elements to
re-expand", and this can happen on either side.

Elaborated model, framed as an ordered stack (oldest → newest, left → right
in the common case):

- **Depth 0 (baseline):** just the current page/view. No panel is open.
- **Depth 1:** clicking a reference opens one split panel. Base view and
  panel share the screen **~50/50**. Both are fully interactive — this is
  the "both opened" case in the founder's answer, and it's the case that
  gets its own expand/collapse controls in each panel's own top-right
  corner (§2.3).
- **Depth ≥2:** clicking a reference *inside* an already-open panel opens
  another panel. Only the **most-recently-opened panel is ever expanded**;
  every other item in the stack — the base view and all earlier panels —
  collapses to a **~1cm-wide vertical strip** (icon + truncated title,
  rotated or clipped as needed; exact rendering is a visual-design detail
  the screenshots likely specify and implementation should confirm against
  them). Strips sit in stack order on either side of the active panel;
  which side a given strip lands on follows where it was opened from (a
  panel opened "to explore right" collapses to a right-hand strip, one
  reached by drilling back toward the base collapses left) rather than
  everything always collapsing to one edge. Clicking a collapsed strip
  re-expands it and — symmetrically — collapses whatever was previously
  active into a strip in its place. This is a **single-active-panel**
  model: at any depth ≥2, exactly one item in the stack is expanded.
- **Closing:** an explicit close control on a panel removes it and
  everything opened *from* it (closing panel N drops N, N+1, N+2, …),
  re-expanding whatever is now the top of the remaining stack. This
  "close cascades forward" rule keeps the stack a strict linear history
  rather than a tree — matches the founder's framing of a single
  left-to-right/right-to-left stack, and avoids the (unscoped, much
  harder) question of branching navigation.

This doc treats "strip rendering, exact widths, which icon indicates
re-expand" as **implementation-detail follow-ups to confirm against the
attached screenshots** once someone can view them (or once the founder
walks through them live) — the stacking *behavior* above is what's decided
and reviewable now.

### 2.3 Expand/collapse controls (founder-decided)

Placement follows directly from the founder's answer:

- At **depth 1** (the ~50/50 case), each of the two visible panels gets its
  own expand/collapse control in **its own top-right corner** — either side
  can be expanded to take over, or collapsed to a strip, independently.
- At **depth ≥2** (some panels collapsed to strips), the expand/collapse
  control shows **only on the active panel** — collapsed strips don't carry
  a redundant control; the strip itself (its nav element) is the affordance
  to re-expand.

## 3. Integration with the existing record page and MN-230b

### 3.1 Record page architecture

`apps/web/src/app/w/[ws]/d/[db]/r/[rec]/page.tsx` is currently a Next.js
route component: it owns `useParams`, all of its data-fetching
(`useQuery(['record', ws, db, rec])`, `useDatabase`, `useMembers`), and
renders the full record body + sidebar directly. A split panel needs to
render the **same record content** without being a route — there's no page
navigation backing a panel, so `useParams()` isn't available and a second
`<EntityPage>` can't just be mounted twice at two different routes.

**Recommendation:** extract the page's body (everything from the title
input through the comments/activity tabs, i.e. roughly lines 165–334 of
today's `page.tsx`) into a route-agnostic `<RecordView ws db rec />`
component that takes `ws`/`db`/`rec` as **props** instead of reading them
from `useParams()`. `page.tsx` becomes a thin wrapper: resolve the route
params, then render `<RecordView ws={ws} db={db} rec={rec} />`. A split
panel renders the identical `<RecordView>` with the props of whichever
record it's showing. This is the same "extract the body, keep a thin route
shell" move already done for the hotspot-file decomposition described in
`docs/architecture/parallel-work.md` (record page → `components/entity/*`),
so it's consistent with how this codebase has already been factoring this
file — it isn't a new pattern.

Because `RecordView` still uses `useQuery(['record', ws, db, rec])`,
react-query's cache is keyed by `(ws, db, rec)` regardless of whether the
consumer is the route page or a split panel — opening a record in a panel
that's already loaded as the base page (or in another panel) is a cache hit,
not a duplicate fetch. No extra caching work needed beyond the extraction
itself.

### 3.2 MN-230b mobile drawer — how it relates and doesn't

MN-230b's drawer (`apps/web/src/app/w/[ws]/layout.tsx`) is the **sidebar's**
off-canvas mobile pattern — a `translate-x` slide-in triggered by a hamburger,
scoped to app-shell navigation. Split-screen panels are a different, new UI
surface (record content, not nav) and don't reuse the sidebar drawer
component directly. What they share is the **breakpoint discipline**
established there: `md` is the line between "wide enough to show
secondary UI alongside primary content" and "not." Split-screen should key
off the same breakpoint token the drawer and the record page's own
`lg:flex-row` stacking already use, for consistency — see the mobile
fallback rule below for the specific cutoff recommendation.

### 3.3 Mobile fallback (explicit rule)

Split-screen is inherently a wide-viewport pattern — a 1cm collapsed strip
and a 50/50 split both assume real width to divide. Per the ticket's own
framing and consistent with `docs/architecture/mobile-responsive-plan.md`'s
existing breakpoint choices (record page already stacks at `lg`, app shell
drawer switches at `md`):

> **Below the `md` breakpoint, there is no split-screen.** Every "open in
> split" trigger (relation chip, collection-list item, search result, card
> click) falls back to normal full-page navigation to the target record's
> own route — i.e., exactly today's pre-#282 behavior, not a panel of any
> kind. No collapsed strips, no 50/50, no stacking concept exists under
> `md`.

This means the click-handling for every wired-up surface needs to be
viewport-aware: at `≥ md` it pushes onto (or opens) the split-panel stack;
at `< md` it does a plain `router.push`/`<Link>` navigation, same as before
this feature existed. This is a small, mechanical branch per surface, not a
separate mobile UI to design — which is why "mobile fallback" is one line
in the founder's answer and one bullet in the follow-up list (§6), not its
own sub-project.

## 4. URL / routing model — decision

The founder's answer settles **where the UI controls live** (top-right per
panel at depth 1; only on the active panel at depth ≥2) but doesn't by
itself settle whether the split *state* — which record(s) are open, at what
depth, which is collapsed — is a shareable URL or ephemeral client-only
state. That's this doc's job to resolve.

**Recommendation: hybrid — shallow split state is shareable; deep-stack
detail is ephemeral.**

- The **depth-1 case (base view + one split panel, ~50/50)** is encoded in
  the URL, e.g. `?panel=<db>/<recordSlugOrId>` appended to the base view's
  own URL (query param, not a path segment, so it composes with every
  existing route — table view, record page, My Work — without a routing
  rewrite). Loading a URL with `?panel=` hydrates exactly that one split
  panel alongside the base view. This makes the single most common and most
  "worth sharing" case — *"look at A next to B"* — a real, bookmarkable,
  Slack-able link, which fits StoryOS's API-first / everything-is-linkable
  posture (`docs/architecture/overview.md`'s "no private endpoints, no
  internal shortcuts" ethos extends naturally to "no unlinkable UI states"
  for the common case).
- **Depth ≥2 (a second or third panel opened from within the first, and
  the resulting collapsed-strip arrangement)** is **not** encoded in the
  URL — it's ephemeral, in-memory client state (component state or a small
  context/store scoped to the base view), reset on full page load/refresh
  back to whatever `?panel=` says (i.e., refreshing a 3-deep stack collapses
  it back to depth 1, not depth 0 — the shareable layer is still honored,
  only the deeper exploration is lost).

Reasoning for the split, since the founder's answer doesn't fully settle it:

1. **Combinatorics.** Depth 1 has one piece of state (which record). Depth
   ≥2 has an ordered list of records *plus* which one is active *plus*
   which side each collapsed strip sits on — encoding all of that in a URL
   makes the URL brittle (any change to the stacking algorithm in §2.2
   becomes a URL-schema migration) for a payoff (deep-linking to a specific
   3-deep exploration state) that's marginal next to deep-linking to "A
   next to B."
2. **Back/forward semantics stay sane.** With only depth-1 in the URL,
   browser back/forward do the obvious thing (leave/return to the split);
   deeper stack navigation is handled by the panels' own close controls
   (§2.2), not overloaded onto history — avoids the common "back button
   closes the wrong panel" bug class that fully-URL-driven nested panel
   stacks are prone to.
3. **Matches how the feature is actually used.** The founder's own framing
   centers the ~50/50 pair as the primary, controls-bearing case; deeper
   stacking is explicitly the "collapse the previous one" escape valve for
   when you drill further, not a state anyone is likely to want to
   reconstruct from a link later.

This recommendation needs the same review pass as the rest of this doc
before an implementation ticket is filed — flagging it clearly as a
**recommendation**, not a re-statement of something the founder already
decided, since the ticket asked this doc to resolve it explicitly.

## 5. Explicit non-goals (unchanged from the ticket)

- No split-screen or expand/collapse behavior ships as part of this doc.
- No visual/pixel spec — exact strip width, control iconography, and
  animation are implementation details to confirm against the six
  attached screenshots (not renderable in this session; see §0/intro).
- No decision here about branching (tree-shaped) panel navigation — the
  stacking model in §2.2 is deliberately linear/cascading.

## 6. Follow-up implementation tickets (file separately; not built here)

In rough dependency order:

1. **Extract `<RecordView>` from the record-page route** (§3.1) —
   route-agnostic component taking `ws`/`db`/`rec` as props, reused by the
   thin route page and by split panels. Prerequisite for everything below.
2. **Build the split-panel stack shell** — a container component owning
   the ordered stack (§2.2): depth-1 50/50 layout, depth-≥2
   single-active-plus-strips layout, collapse/expand transitions, and the
   "closing a panel cascades forward" rule.
3. **Collapsed-strip UI** — the ~1cm vertical strip itself (icon/title
   rendering, click-to-expand), confirmed against the ticket's screenshots.
4. **Per-panel expand/collapse controls** — top-right corner control on
   each depth-1 panel; single control on the active panel only at depth ≥2
   (§2.3).
5. **Wire the four required surfaces into "open in split" instead of
   navigate:** table relation-cell chips (`relation-cell.tsx`, retiring the
   #293 new-tab stopgap), record body relation/collection lists
   (`collection-section.tsx`), search/command palette
   (`command-palette.tsx`), and record cards in list/board/calendar/gallery
   views (`list-view.tsx`, `board-view.tsx`, `calendar-view.tsx`, and the
   gallery view card).
6. **Mobile fallback branch** (§3.3) — viewport-aware click handling on
   every surface from #5: `< md` falls back to plain navigation, no panel.
7. **Depth-1 shareable URL** (§4) — `?panel=` query param: write-on-open,
   read-and-hydrate-on-load, clear-on-close; depth ≥2 stays unencoded.
8. **Keyboard & accessibility pass** — Escape to collapse/close the active
   panel, focus management on open/close/re-expand, ARIA roles/labels for
   the panel stack and collapsed strips. Called out explicitly so it isn't
   dropped from scope when the interaction work is split into tickets.
9. **Data-loading/perf check** — confirm the react-query cache-key reuse
   described in §3.1 actually avoids duplicate fetches once panels are
   real (should fall out of the extraction for free; worth a explicit
   verification ticket rather than an assumption).

Tickets 1–4 and 6–7 have a natural dependency chain; 5 can be decomposed
per-surface into smaller tickets once 1–4 land, so that each surface (table
cells, collections, search, cards) is an independently reviewable PR rather
than one large "wire everything" change — consistent with this repo's
hotspot-file rules (`docs/architecture/parallel-work.md`), since several of
these surfaces (`table-view.tsx` in particular) are hotspot files that
should each get their own small, focused PR rather than one sprawling
change touching all of them at once.
