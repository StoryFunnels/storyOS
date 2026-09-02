---
title: Tyron, the in-app assistant
description: An AI assistant that acts as you, inside your workspace — what it does on its own, what it asks first, and what it refuses outright.
sidebar:
  order: 14
---

Tyron works inside your workspace: it can read your databases and change them, acting as you.

Open it from the sidebar, from the command palette, or with **⌘J** (Ctrl+J on Windows and Linux).

## What it can do, and whose permissions it uses

**Tyron acts as you.** It has your permissions and no others. If you cannot drop a database, you
cannot ask Tyron to — the refusal comes from the same permission system that would stop you doing
it by hand, not from a separate list of assistant rules.

Everything below sits **on top of** that. It is for things you genuinely can do but probably did
not mean to do at this scale.

## Starting from nothing

On a new workspace Tyron opens with four things worth clicking rather than an empty box:

- **Build me a workspace** — describe what you do, and it sets up databases that fit and connects
  them.
- **What needs me today?** — reads across everything and tells you what is waiting. It changes
  nothing, which makes it the safest possible first interaction.
- **Turn a list into a database** — paste names, emails, a chunk of a spreadsheet, anything messy.
- **Connect two things** — links two databases and shows you what that makes possible. If you do
  not have two yet, it creates a pair, so the card works from nothing.

Two of them act on one click; the other two open their own input first, because "build me a
workspace" means nothing without knowing what you do.

## Building a workspace from a sentence

Tell Tyron what you do — *"I run a design studio"* — and it builds databases with **relations and
views**, not a set of disconnected tables. Tables alone are a spreadsheet; the relations are the
point.

**It will not interrogate you first.** It guesses from your sentence and builds, and you reshape it
by carrying on the conversation. Reshaping is cheap; a wall of clarifying questions on your first
minute is not.

A build gets a **higher ceiling than an ordinary request** — four databases with a few fields each,
two relations and a couple of views runs to 25–35 tool calls, and stopping half-built is the one
outcome this is designed to avoid. It is still bounded, so a runaway still stops, just later.

## Threads

Conversations are **threads**: as many as you like, kept between sessions, and listed by how
recently you used them.

**A thread is named from your first message**, not called "Untitled" — a list reading "New chat,
New chat, New chat" is one nobody opens twice. It takes the first line only, so pasting a long
brief gives you a title rather than a wall of text. You can rename one.

**Threads are private.** Yours only — there is no admin view of them, deliberately, because a
thread is a record of somebody thinking out loud. Asking for a thread that is not yours returns
"not found" rather than "not allowed", since the second answer leaks the fact the first one
protects.

## Finding things

Tyron searches records by title, and filters them the way any view does.

When it counts something for you, **the count is exact** — it counts in the database rather than
sampling, and it says so as part of the answer rather than as a turn of phrase. *"Here are 4 that
look relevant"* and *"there are exactly 4"* are different claims, and you should not have to guess
which one you got.

> **Not yet:** searching by meaning rather than by title — *"the thing about the pricing
> objection"* — is not available. Today, finding something needs a word that is actually in its
> title, or a filter.

## When it asks before writing

The rule is **write easily, delete only after a commitment**. A confirmation on every write would
make Tyron slower than doing the work yourself, which defeats the point of having it. So most
writes just happen: setting values, adding fields, creating records, linking things.

Four outcomes are possible for any action Tyron is about to take.

### It just does it

Ordinary writes. Also **deleting a view** — a view is a lens, so deleting one destroys no data:
the records it showed are untouched and every other view of them still works.

### It asks — normal

- **Deleting records.** The message says how many, and from which database.
- **A bulk edit affecting more than 50 records.** A silent bulk edit is as destructive as a
  delete, just quieter: *"set every client to Paused"* is unrecoverable in practice even though
  nothing was technically deleted.

### It asks — harder

- **Deleting a field, a database or a relation.** These get stronger wording for a specific
  reason: dropping a column destroys data *invisibly*. The rows stay, and what was in that column
  is simply gone, with nothing on screen to show it existed. The confirmation says so — the
  information is **not hidden, it is deleted**, and Tyron cannot bring it back.
- **Anything that looks like a delete but Tyron does not recognise.** If a tool named
  `delete_…`, `remove_…`, `drop_…`, `purge_…`, `clear_…`, `destroy_…` or `truncate_…` turns up
  that has not been classified, Tyron confirms anyway and names it. The cost of being wrong here
  is one unnecessary question; the cost of the opposite is silent data loss.

### It refuses

Some things are not Tyron's to do at all, because the blast radius is **other people** rather
than your data:

- inviting or removing people
- changing what someone can do, or permissions
- anything to do with billing

Tyron says why rather than just declining, and points you at Settings. "I can't" with no reason
reads as a malfunction.

### It needs approval

Anything that **leaves the workspace and reaches a person** — sending an email or a message,
posting, running a button or a skill that could do either — goes through the same approval gate
[automations](/concepts/automations/) already have. It is the same gate, not a second one.

Order matters here: outward-facing is checked **before** the delete rules, so *"delete these and
tell the client"* cannot be reduced to a plain delete confirmation and slip past the gate.

## When it stops on its own

Tyron has ceilings. These are **guards against loops and runaway edits, not spending limits** —
an assistant looping on itself never finishes, which is broken at any price.

| Ceiling | Limit |
|---|---|
| Tool calls in one turn | 40 |
| Assistant turns in one run | 12 |
| Records changed before it checks in | 50 |

Every one of these produces a **clear stop that says what happened and what is left** — never a
silent halt, never an endless spinner. A bulk check-in is resumable: say "keep going".

The turn limit bounds one continuous run, not the conversation. A thread you come back to
tomorrow starts fresh.

## It counts rather than guessing

If Tyron makes a claim about what is in your workspace, it queried for it.

This is enforced in code, not asked for in a prompt. The load-bearing fact is cheap and certain:
**a turn that made no tool calls did not consult the workspace**, so anything it then asserts
about your data is unverifiable by construction — not merely probably wrong.

This matters because the failure it prevents is invisible by design. A made-up count arrives
well-formed and confident, and a reader who does not already know the answer has no signal that
anything is off.

The guard deliberately lets ordinary conversation through. *"I can help with 2 things"* is not a
claim about your data and passes untouched.

## Telling Tyron apart from a person

Tyron is shown with a **squircle** avatar and a glyph — never a circle, never initials. Every
member avatar in the app is round, so the silhouette differs before you read any colour or letter.
This is not cosmetic: Tyron Dizon is a real member of this workspace and the assistant is also
called Tyron, so "Tyron" beside a message would otherwise be genuinely ambiguous.

The treatment is generic to **every** named agent, not special-cased for this one — packs ship
their own agents, and each inventing its own look is how a product ends up with three of everything.

## Who a Tyron change is attributed to

**You.** A change Tyron makes is attributed to the member who asked for it, because you authorised
it and your permissions bounded it. Tyron never appears as the actor and never accumulates
permissions of its own.

What Tyron's writes *do* carry is a separate source label of `agent`, so record history can
distinguish a change you typed from one that was generated for you. Those are two different
questions and history keeps two different answers. See [record history](/concepts/record-history/)
for how that works.
