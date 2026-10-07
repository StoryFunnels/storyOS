# Space ontology diagram — visual spec

**Ticket #636.** Replaces the radial layout with a centre chip, axes, and
chip lists grouped by space. Supersedes #528 and #607, which were three attempts
at the same rendering symptom without asking whether the layout form was wrong.

**AC7 is resolved.** Ievgen decided directly: above/below placement encodes
**nothing** — it is balance only. The semantic option was available (see below)
and was declined, so this is a decision, not an oversight.

---

## What the data can and cannot say

Checked before proposing anything, because two of the ticket's own candidate
answers turned out not to exist:

- `cardinality` is only ever `one_to_many` or `many_to_many`. **There is no
  `many_to_one`.** The ticket's "one-to-many vs many-to-one" is the same relation
  seen from either end, not two kinds of relation.
- For `one_to_many`, **side A is the "many" side** — `relations.ts` says so, and
  the default field names are "Parent" on A and "Sub-items" on B. So hierarchy
  direction *was* derivable relative to a centre entity.

That option — parents up, children down, many-to-many left/right — was offered
and declined in favour of balance-only. Recorded so it is not re-litigated.

---

## The consequence of balance-only, and the decision it forced

**If the axes carry no meaning, four `+` buttons are four copies of one action.**

The ticket specifies "four axes… each a plain line ending in a `+` that adds a
relation in that direction." That reads naturally when direction means something.
With balance-only placement, "add a relation upward" and "add a relation
rightward" do the same thing and produce a chip that may land on a different axis
than the one clicked — which is worse than one button, because it implies a
choice the system will then ignore.

**DECIDED: one `+`, not four** (2026-09-09, Dara). It sits on the centre chip's
trailing edge, where "add a relation from this database" reads unambiguously.
The four axis lines stay pure structure — they carry chips, not actions.

This was raised as a recommendation and routed for a product call; Otto returned
the ticket without ruling on it, and Ievgen has delegated design decisions of
this kind, so I have taken it. Recording that the four-button reading was
available and was rejected on a stated reason, not overlooked: with balance-only
placement, four buttons would imply a choice the system then ignores.

**It opens the EXISTING dialog, not a new one.** `AddFieldDialog` with
`initialType="relation"` — the same call the `/relations` page makes. That is
Otto's ruling on #531, and it applies verbatim here: cardinality changes are
destructive, and "two code paths that both claim to create/edit a relation is
exactly how they drift apart". This surface adds a third entry point, never a
third mechanism.

---

## Layout

### Balance must be deterministic, or it becomes jitter

This is the one real risk in the balance-only answer. If placement is decided by
"whichever axis has room", the same space must still render **identically on
every load** — otherwise the diagram rearranges itself between visits and after
any unrelated edit, and a user cannot build a mental map of their own schema.

So balance is a pure function of the data. No measurement, no iteration order, no
randomness:

```
groups = relations grouped by the FAR side's space_id
sort groups by:  chip count DESC, then space name ASC, then space_id ASC
                 (a total order — space_id guarantees no ties)

for each group in that order:
    assign to the axis with the fewest chips so far
    ties broken by the fixed sequence: down, up, right, left
```

`down` leads the tie-break because vertical lists grow without bound while
horizontal ones hit the panel edge — so the first and largest group belongs on a
vertical axis.

### Why chip lists scale where geometry did not

Every collision chased through #528 (satellite vs satellite), #607 (fan step vs
label width) and this morning's unfiled remainder (edge midpoint vs satellite
name, measured at exactly 0.00px) existed because **relationship labels were
drawn at rest and positioned by geometry**. Move them to hover and there is
nothing left to collide. Chip lists then grow downward; geometry does not.

`DIAGRAM_NODE_LIMIT = 10` and its fallback list can go once this lands. The
limit existed because the circle overlapped past ~10 nodes; a chip list has no
such threshold, which is the point.

---

## Components

### Centre chip
The space's focal database. Same chip anatomy as a related chip but at 28px
instead of 24px, no chevron (you are already here), and carrying the single `+`.

### Related chip
```
┌────────────────────────────┐
│ ▌ ◇  Articles           ›  │   24px tall, radius var(--radius-chip)
└────────────────────────────┘
  │  │  │                 └── chevron, navigates into the database (#497)
  │  │  └────────────────────── name, 13px, var(--text-primary)
  │  └───────────────────────── the database's own icon
  └──────────────────────────── 2px edge in the database's colour
```

**Outline, not solid fill — and this is a deliberate reconciliation.** The ticket
says "coloured chip". #281's established language says a *select-value badge* is
a solid fill with white text, while a *relation-entity chip* — a link to another
entity — is outline-only. An ontology chip is a link to another entity, so it
takes the outline treatment, with the database's colour carried as a 2px leading
edge and on the icon rather than as a fill.

That is also why it does **not** use the soft-tint pattern: I have just filed
that pattern as defective (#638 — a 13% alpha fill behind full-strength text is
theme-blind, measuring 2.93:1 in dark mode) and #639 (the palette is stock
Tailwind, not the documented one). Adding a fourth consumer of a pattern I have
called broken would be indefensible. Border and text come from tokens; the
database colour is an accent only, so nothing here depends on #638/#639 landing.

### Space group label
```
CONTENT MARKETING
```
11px, uppercase, `letter-spacing: 0.04em`, **`--text-muted`**. Not
`--text-faint` — #637 establishes that faint fails AA on every surface in both
themes and that section labels are exactly the misuse it forbids. 8px above the
first chip, 2px below the label.

Groups render in the sorted order above. A group containing only the current
space is still labelled: consistency beats saving one line, and the label is how
a reader knows which cluster is local.

### Relationship type — hover **and focus**
Shown only on interaction, per the ticket's most important line. Anchored to the
chip, using `ui/popover.tsx` rather than a new one-off.

**It must reveal on keyboard focus as well as pointer hover.** A hover-only
disclosure means a keyboard user can never learn the relationship type at all —
the information would exist but be unreachable. This is not in the ticket and I
am adding it, because "hover only" was a statement about what is drawn at rest,
not a decision to exclude keyboard users. Do not use `title`: no styling, a
browser-controlled delay, and inconsistent screen-reader behaviour.

Content: the cardinality in plain words and both field names — e.g.
*"Articles → Sections · one-to-many · via 'Sections'"*.

---

## States

| state | render |
|---|---|
| no relations | centre chip + the four axis lines as faint stubs + the `+`. The axes are the affordance's context; drawing nothing would leave a lone chip with no hint that relations are addable. |
| one relation | one group on the `down` axis, per the tie-break. Deliberately not centred or specially cased — a one-relation space should look like the same diagram with less in it. |
| ~30 chips / 8 groups | groups distribute across four axes by the rule above; vertical axes absorb the largest. Verified against Ievgen's second reference image, which is this shape at this scale. |
| self-relation | rendered as its own group labelled with the current space, chip named for the database itself. No loop geometry — loops were #528's fan-out problem and there is no geometry left to fan. |

---

## What I have not decided, and will not guess

- **Whether the centre chip is always the space's "primary" database, or whether
  the diagram re-centres when you click a chip.** The ticket says a chevron
  *navigates into* the database, which suggests the page changes rather than the
  diagram re-centring. I am reading it as navigation, and if re-centring was
  meant, that is a different interaction and a different ticket.
- **Exact canvas dimensions and whether it scrolls or scales at 30 chips.** That
  needs a real render to judge; I would rather measure it than specify a number I
  have not seen.

## What this spec does NOT cover

- No implementation. The build is a rewrite of a 29KB component with 17 existing
  unit tests on the radial `computeLayout`, all of which describe a path this
  replaces. Sequencing that — new layout function and tests alongside, radial
  path and its tests removed in the same commit that switches the render — is
  the next step and is not designed here.
- No dark-mode render check. Every colour above is a token or a database colour,
  so it should follow the theme by construction, but "should" is not "measured".
- No measurement of the 30-chip case. The spec says it scales because chip lists
  grow downward, which is an argument, not evidence.
