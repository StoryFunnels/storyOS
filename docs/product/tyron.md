# Tyron, the in-app assistant

Tyron works inside your workspace: it can read your databases and change them, acting as you.

Open it from the sidebar, from the command palette, or with **⌘J** (Ctrl+J on Windows and Linux).

## What it can do, and whose permissions it uses

**Tyron acts as you.** It has your permissions and no others. If you cannot drop a database, you
cannot ask Tyron to — the refusal comes from the same permission system that would stop you doing
it by hand, not from a separate list of assistant rules.

Everything below sits **on top of** that. It is for things you genuinely can do but probably did
not mean to do at this scale.

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
posting, running a button or a skill that could do either — goes through the approval gate the
product already has for automations. It is the same gate, not a second one.

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
questions and history keeps two different answers. See
[Record history](record-history.md) for how that works.
