# Creating a workspace

The first screen after signing up asks for two things: a name, and a starting point.

## What you choose from

**Business Pack** is the word StoryOS uses for a ready-made set of databases, views and
automations for one kind of work. There are eight, shown as a scrolling grid of cards — every one
of them, not a shortlist. You can change anything afterwards, or add more later, so this is not a
decision to agonise over.

Two other ways out sit below the grid, and they are deliberately **outside** the scrolling area so
you can see them without scrolling:

- **Start empty** — no databases. Build your own from scratch.
- **Browse the marketplace** — create the workspace first, then explore packs from other builders.

## Nothing is pre-selected

The create button stays disabled until you choose, and until then it reads **"Choose a starting
point above"** rather than "Create". That is the screen telling you it is waiting for you, not
that it is broken.

Once you pick, the button names your choice back to you — *"Create workspace for running an
agency"*, or *"Create workspace with Support Inbox"* — so you confirm what is about to happen
rather than pressing a generic Create and finding out afterwards.

## If the packs do not load

The grid shows an error with a **Try again** button. Creating a workspace with a pack is blocked
while packs are unavailable, but **Start empty** still works — you are not stuck on this screen.

## What happens next

The workspace is created and, if you picked one, the pack's databases, views and automations are
installed into it. Installing a pack is idempotent and additive, so choosing one here does not
close any doors.

---

<!--
SCREENSHOTS NOT CAPTURED.

docs task #23 asked for the create-workspace screenshots to be recaptured after
#351 rebuilt this screen. They have NOT been recaptured: capturing them needs
the app running against a database, which this pass did not do, and a
hand-described screenshot is worse than none.

Two things worth knowing before someone picks this up:

1. There is no existing onboarding walkthrough to refresh. Nothing in docs/
   references an image at all (no markdown image syntax anywhere in the tree),
   and the seven PNGs in docs/assets/ are orphaned — none of them is this
   screen. So this is a first capture, not a refresh.

2. The related worry in #23 — that docs quoting a pack description verbatim went
   stale when seven "gates in" sentences were removed from
   apps/api/src/packs/starter-packs.ts — does not apply. All 14 pack summaries
   were checked against every .md in docs/ and none is quoted anywhere.
-->
