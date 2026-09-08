# Density and spacing — a design review of the record page

**Brief from Ievgen:** *"pay your design attention to the RICH text blocks
globally… eg — padding on the left is big. Then the LEFT sidebar of the platform
and RIGHT sidebar of the record. And yes, the middle… Like you're a designer.
Think about how to make it all better without unnecessary spaces, usable,
readable."*

Everything below is measured in a real browser at 1440×900 on a record page.
No impressions.

---

## The headline: the left padding is not the problem, the ALIGNMENT is

This is the one thing I'd push back on, and it changes the fix.

BlockNote sets `padding: 54px` on `.bn-editor`. Hovering a block reveals the side
menu at **exactly 48px** — two 24px controls, the insert `+` and the drag handle,
sitting at x=279…327 while text starts at x=327. **So 48 of those 54px are an
affordance gutter.** Delete the padding and you don't get tighter text, you get
a drag handle sitting on top of the first word. That is why the number is now
written into `globals.css` as a floor.

What actually reads as "big padding" is this:

```
title            x = 272   ← column edge
CONTACTS box     x = 272   ← column edge
PROJECTS box     x = 272   ← column edge
description text x = 327   ← 55px in, alone
```

**Every element on the record aligns to the column edge except the prose.** A
55px indent on one block, with nothing else sharing that edge, is an alignment
break — and the eye reads a broken alignment as "too much padding" even when the
padding is doing a job.

The right fix is what Notion does: keep the gutter, but hang it in the panel's
own margin so the *text* aligns with everything else and the handle sits outside
the content column. That needs the panel to have ≥52px of left margin; it has
about 32px. So it is a panel change, specced below.

### What I did land now (in `globals.css`, global to every rich-text surface)

| | before | after | why |
|---|---|---|---|
| `padding-left` | 54px | **52px** | 48px floor + 4px so the handle isn't flush against the first glyph |
| `padding-right` | 54px | **24px** | nothing lives there |

Measured after: gutter 52px with 4px headroom over the 48px side menu, text
column **690px → 722px (+32px)**, prose 97 → 102 characters per line.

**Why I did not cap the measure**, since that is the reflex: the padding was
accidentally doing line-length control. 102 characters is at the high end, but it
is roughly what Notion and Linear ship for a record body, and capping it would
leave a ~200px void down the right of an 800px panel — trading one kind of
wasted space for another. The measure *does* need a cap on the standalone `/doc`
page, where the column is much wider. Specced below.

---

## Left sidebar — 240px wide, and about 110px of reclaimable height

The top nav is already good: **26px rows on a 28px pitch.** Don't touch it. The
problems are all below it.

| what | measured | proposed | reclaimed |
|---|---|---|---|
| gap between "Ask Tyron" and the tree | **72px** | 16px | **56px** |
| section header pitch (×4) | ~30px | 22px (8 above / 2 below) | **32px** |
| space-child row height | 20px | 24px | −16px (spent) |
| space-child pitch | ~25px | 28px | −36px (spent) |
| **net** | | | **~36px reclaimed, and the rhythm is fixed** |

The 72px void is the obvious win and it is pure air — nothing is in it.

The two spent numbers are deliberate, and this is the part I'd defend hardest:
**the nested items are currently tighter than their parents.** Top-level nav is a
28px pitch; the space children under it are 25px. That is inverted — a child
should never be denser than its parent, because density is one of the cues that
says "this is subordinate". Worse, **20px rows are below a comfortable 24px hit
target** and these are the most-clicked things in the product.

So this is not a pure spacing reclaim. It is: **take 88px of genuine air, spend
52px of it making the tree easier to hit and rhythmically correct.** A sidebar
that is 36px shorter *and* has 24px hit targets is better on both counts than one
that is 88px shorter and fiddly.

---

## Right sidebar of the record — the single biggest waste in the product

| measured | |
|---|---|
| content width | 202px |
| vertical pitch per property | **65px** |
| label + gap + value | 18 + 10 + 16 = **44px** |
| **dead space per property** | **21px** |
| 8 properties | **456px** |

Every property stacks its label above its value and then leaves 21px underneath.
A record with 15 fields needs 975px of column — taller than the viewport, so you
scroll for something that could fit.

**Proposal: label and value on one row, 28px high.**

```
Owner            Set Owner
Industry         Set Industry
Monthly Value    Add Monthly Value
```

At 202px of content width: label column **88px**, value column **106px**, 8px
gutter. I checked the longest label — "Monthly Value" at 12px measures ~85px, so
88px fits without truncation. That is tight, and it is the one number here I'd
want to see on screen before committing.

**8 properties: 456px → 224px. Saves 232px, just over half.**

If 88px proves too tight in practice, the fallback keeps the stacked layout and
just removes the 21px of dead space: 65px → 44px pitch, 456px → 352px, still
**104px saved** with zero truncation risk. I'd try the two-column first and keep
this in reserve rather than pick the safe one on principle.

---

## The middle — 154px of dead space with nothing in it

Two separate problems, both vertical.

**1. The description block reserves 160px regardless of content.** `min-h-40` on
the wrapper. The sample content is 87px including padding, so **73px is empty**.
An empty description reserves the full 160px to hold one line of placeholder.
Proposal: `min-h-0` with a 48px empty-state target — enough to be an obvious
click target, not a hole. **Reclaims ~73px when short, ~112px when empty.**

**2. Empty relations cost three rows of chrome to say nothing.** CONTACTS with
zero records renders a Filter/Sort/Fields toolbar, a 42px bordered box reading
"Nothing linked yet.", and an Add/New row — about 100px to communicate absence,
twice over on this record.

Proposal: collapse an empty relation to a single 28px row — `＋ Add contact` —
and mount the toolbar only once there is something to filter. Filter and Sort on
an empty list are controls that cannot do anything. **Reclaims ~70px per empty
relation.**

---

## `/doc` page — the measure genuinely does need capping there

Not in the brief, but it is the same rich text and the fix differs, so it should
be decided together. The standalone document editor is far wider than an 800px
record panel, so prose there runs well past a readable measure — and
`design-system.md` already prescribes the answer:

> *"Entity-page prose area gets generous spacing (Attio record-page feel: narrow
> centered column, roomy line-height 1.6)."* — and 16px prose, not 14px.

**None of that is implemented.** Current: 14px, 1.5 leading, full-width column.
So the proposal here is not mine — it is the founder-set direction from the doc,
which was written and never built. That makes it a cheap decision: implement what
is already specified, on the `/doc` surface only, and leave the record panel's
14px chrome alone.

---

## Priority, if only some of this happens

1. **Right sidebar 65px → 28px pitch** — 232px, the largest single win, one file.
2. **Left sidebar 72px void** — 56px of pure air, trivial change.
3. **Rich-text alignment to the column edge** — the reported complaint, and the
   fix that makes the prose stop looking wrong.
4. **Description `min-h-40`** — 73px, one class.
5. **Empty relations** — 70px each, but the most behavioural change of the five,
   so it wants the most care.

---

## Whose these are

The gutter change landed here because `.bn-editor` is overridable from
`globals.css`, which is mine, and it is global to every rich-text surface — which
is what "rich text blocks globally" asked for.

**Everything else in this document is a feature screen** — `sidebar.tsx`,
`record-detail.tsx`, `doc/[doc]/page.tsx`. Those are Iris's, and my charter is
explicit that I file specs rather than edit them, because two agents in the same
component is how worktrees corrupt each other. So each region above is a ticket
with the measured numbers and the target values, which is the part that is
actually mine: making the right thing the obvious thing to build.

If you'd rather I took the feature-screen work directly, that is a boundary
change and it is yours to make — say so and I will.

## What I did NOT check

- **Only this one record page, at one viewport (1440×900), in light mode.** The
  sidebar figures will hold anywhere; the record-panel figures depend on the
  800px middle column and will differ in split-screen and at other widths.
- **The 88px label column is calculated, not seen.** I measured "Monthly Value"
  at ~85px in Figtree 12px, but a longer field name in a real workspace could
  truncate. That is why the fallback is specced.
- **No board, calendar, timeline, gallery, form, dashboard or settings density
  review.** The brief named four regions and those are the four.
- **The empty-relation proposal changes behaviour, not just spacing** — hiding
  Filter/Sort until a list is non-empty is a product decision as much as a
  design one, and it should get Otto's eye rather than just Iris's.
