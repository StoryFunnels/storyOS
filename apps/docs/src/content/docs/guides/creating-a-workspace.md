---
title: Creating a workspace
description: Creating a workspace after signup — describe your work and let StoryOS build it, or start from a Business Pack or empty, then invite your team.
sidebar:
  order: 2
---

The first screen after signing up asks for a **workspace name** and **what you do**.

## Describe your work, and it's built for you

Type a sentence — *"We run a small design studio: client projects, invoices, and a content
calendar."* One sentence is enough. StoryOS (through [Tyron](/concepts/tyron/)) sets up databases
that fit, connects them, and adds the views worth having. You can reshape anything afterwards.

- **It needs an AI model.** On a self-hosted instance without one configured (an `OPENAI_API_KEY`),
  the build can't run. You'll see **"The build stopped."** with the server's own message and a **Try
  again** that keeps what you typed — and **Start from a template instead** (below) always works.
- **When you land in the new workspace**, a **Share this with your team** card appears once, above the
  getting-started checklist: add several email addresses to invite people, copy a link for each
  invite, then **Done** (or skip). Inviting someone ticks the checklist's "Invite a teammate" step by
  itself.

## Starting from a template instead

Prefer to begin from a known shape? **Start from a template instead**, under the description box,
shows the starting points below; **← Back** returns to the describe step.

![Create workspace screen with a name typed in and no starting point chosen yet](/images/create-workspace-empty.png)

## What you choose from

**Business Pack** is the word StoryOS uses for a ready-made set of databases, views and
automations for one kind of work. There are eight, shown as a scrolling grid of cards — every one
of them, not a shortlist. You can change anything afterwards, or **add more later** — from inside
an existing workspace, its home page's **Start something new** link opens the full gallery of 23
templates (this screen's eight plus the rest), each card showing a real **install count** so you
can see which ones other workspaces actually use before adding one. A brand-new template with no
installs yet simply shows no count, rather than a conspicuous "0."

Each card's picture shows the pack's **workflow** as a row of status chips (long ones collapse the
middle to *+N*), with marks for a pack that includes an agent or sends notifications. The pack's counts are
one small line underneath.

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

![Create workspace screen with the "Running an agency" pack selected, and the button reading Create workspace for running an agency](/images/create-workspace-pack-selected.png)

## If the packs do not load

The grid shows an error with a **Try again** button. Creating a workspace with a pack is blocked
while packs are unavailable, but **Start empty** still works — you are not stuck on this screen.

## What happens next

The workspace is created and, if you picked one, the pack's databases, views and automations are
installed into it. Installing a pack is idempotent and additive, so choosing one here does not
close any doors.

**A pack looks for its databases by name only in the space it installs into.** A database with the same
name in another space is left alone and the pack makes its own. A same-named database in that space that
the pack did not create is a collision you have to decide, not something the install merges for you; see
[Databases with the same name in other spaces](/mcp/tools/#databases-with-the-same-name-in-other-spaces).

A pack never reuses or changes a built-in StoryOS database such as Members, Agents, Agent Triggers or
Agent Runs: a pack database with one of those names is created as its own separate database. See
[Built-in databases are never reused or changed](/mcp/tools/#built-in-databases-are-never-reused-or-changed).

When a database is reused, if the incoming pack's sample data assumes an option the reused database's field
doesn't actually have (its own pack never created that option, only the one you already installed
did), that one field's value is skipped and reported — the install still completes, rather than
failing outright over a single sample value it can't carry over.

## The install review, and where you land

When you add a pack to an existing workspace from its gallery, an **install review** opens first and
nothing is created until you confirm. It leads with what the pack is for:

1. **Why**: the pack's one sentence, for example *Your team needs one place to see who is doing what this
   week.*
2. **Once it's in, you can**: up to three short lines of what you will be able to do.
3. **How it fits together**: the database map, one row per link, drawn from the pack's own relations, such
   as *Tasks → Projects*. A two-way link reads *↔*, and a database linked to itself is shown with *↺* and the
   field it uses. A pack with no links says *One database, no links* or *N databases, no links*.
4. What it would create, where it would reuse something you already have, and the automations it installs
   switched off.

A pack that declares no `why` or `can` (a community pack, say) simply shows none of this: there is no
heading and no placeholder. The pack cards on a space's page carry the same sentence, falling back to the
pack's summary, with the first four rows of the map, *+N more links* when there are more, and the pack's
counts underneath. The pack's author writes these; see [Writing a pack
manifest](/guides/pack-manifest/#why-and-can-what-a-pack-says-about-itself).

Two choices in the review are yours to make, and both default to the cautious answer:

- **Reusing a database you already have in another space.** The default is to create a new one. See
  [Reuse in the web install review](/mcp/tools/#reuse-in-the-web-install-review), including what to do
  when you have several with the same name.
- **Automations that install off.** One that sends things outside the workspace or runs an agent reads
  **Off until you turn it on**, with why and a switch. See [Automations that send things out install
  switched off](/guides/pack-manifest/#automations-that-send-things-out-install-switched-off).

**After the install,** if the pack names a view its database opens on, you land on that view with the
pack's space expanded in the sidebar, rather than on a list of what was installed. For Team Board that is
the Board. A pack that names no such view, an update of a pack you already have, and an install that
did not finish, keep the result screen instead.

## If a pack install fails partway

Installing a pack is a series of steps: databases, fields and relations, agents, views, automations,
sample records and skills. If one of them fails, StoryOS removes what that install had created so far
and then reports the failure. The error names the step, in the form *Installing "Pack name" failed at
the step "adding the views": …*, and ends with **Nothing was installed.**

- **What is removed:** only the databases, fields, relations, agents, views, automations, sample
  records and skills **that this install created**. They are deleted outright rather than moved to the
  trash, so no leftover names are left to collide with a second attempt. If the install also set up the
  Agentic OS space and its databases, those go too.
- **What is left alone:** anything the install only **reused**, such as a database you already had.
  When the failed install was an update of a pack you already have, only what that run added is removed; what was already installed
  stays as it was.
- **Installing again:** once the cause of the failure is gone, install the pack again. The earlier
  attempt left no databases or rules behind, so the second try does not fail with a 409 on names from
  the first.
- **If the cleanup itself fails:** the error says so instead of "Nothing was installed.", lists what it
  could not remove, and asks you to delete those by hand before installing again.
