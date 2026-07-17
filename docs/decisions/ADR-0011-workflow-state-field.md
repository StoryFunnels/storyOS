# ADR-0011: State stays a select — with an optional shared "workflow" category layer

- **Status:** accepted
- **Date:** 2026-07-17
- **Source:** research request on #83 (MN — "should State be a built-in field with shared options across databases?").

## Context

StoryOS models workflow state as an ordinary per-database `select` field. Every
database invents its own options — "Done" in one, "Complete" in another — which
is exactly why the Linear import needed name-based state mapping (#68). Tools
like Linear and the reference tool instead treat **State** as a built-in concept
with a vocabulary that is **consistent across the workspace**.

The question: should StoryOS make State a first-class, workspace-shared field?
Three options were evaluated.

| Option | What it is | Cost |
|---|---|---|
| **A — free-form select (today)** | State is just a per-database select; nothing shared. | Cross-database grouping (My Work / Inbox / rollups) can't rely on a common vocabulary; agents must guess which select means status; import needs fuzzy mapping. |
| **B — built-in shared State** | A dedicated system field with one workspace-wide option set. | Boxes in genuinely different workflows; needs workspace-level field definitions (a new concept "above" the database); heavy migration of every existing State select; cuts against the user-defined-databases thesis. |
| **C — hybrid** | State stays a normal select, but a select field can be **flagged as a workflow** and each option mapped to a **shared category** (`backlog / unstarted / started / completed / canceled`). | One new optional flag + a category enum; a light, opt-in migration. |

The forces that matter here: (1) the product thesis is **user-shaped databases** — everything else is user-defined, so a rigid built-in State is off-brand; (2) the *value* people actually want from "shared State" is **predictable semantics** — cross-database grouping, agent legibility, board/list grouping, import fidelity — and that value comes from a shared **category** vocabulary, not from forcing identical option *labels*; (3) the agentic engine (ADR-0010) needs a predictable "is this record done / blocked / in progress" signal, and MN-215's human-gate checkpoints want to reason about workflow position.

## Decision

**Keep State as a `select` (Option A's flexibility), and add an opt-in shared
category layer (Option C).** Concretely:

- A select/`single-select` field gains an optional **`workflow: true`** flag in
  its config. A database may have at most one workflow field.
- When a field is a workflow, **each of its options carries a `category`** from a
  fixed, workspace-shared enum: **`backlog`, `unstarted`, `started`, `completed`,
  `canceled`** (the Linear/GitHub-proven set). Labels stay per-database and fully
  user-editable — "Shipped", "Live", "Done" can all map to `completed`.
- Cross-cutting features read the **category**, not the label: My Work / Inbox
  grouping, "open vs done" filters, board column ordering, rollups like "% done",
  and agent triggers/gates (ADR-0010). Import maps incoming states to categories
  instead of guessing labels (#68).

This gives the shared-vocabulary benefits **without** a workspace-level field
registry, without a forced-identical option set, and without betraying the
user-defined thesis. It is additive and opt-in — nothing changes for a database
that never flags a workflow field.

## Consequences

- **Migration is light and non-breaking.** No data moves. Existing State selects
  keep working as plain selects. A follow-up can *offer* (never force) to flag an
  obvious status field and pre-map its options to categories by name
  (done/complete → `completed`, etc.); unmapped options default to `unstarted`
  and are user-adjustable. The Linear import (#68) sets categories directly from
  Linear's own state types, retiring the fuzzy name mapping.
- **The category enum is the stable contract** agents and cross-database
  features code against; labels remain a presentation concern. This is the same
  label-vs-id discipline the mentions work already follows.
- **Escape hatch:** a database with a genuinely non-linear workflow simply
  doesn't flag a workflow field and keeps a plain select — Option A is still
  there underneath.
- **Rejected — Option B (built-in shared State):** a workspace-level shared
  option set is a new primitive that contradicts "everything is user-shaped" and
  forces a heavy migration for a benefit (predictable semantics) that categories
  deliver more cheaply. **Rejected — staying pure Option A:** leaves cross-database
  grouping, agent legibility, and import fidelity unsolved, all of which the
  agentic-OS direction now needs.

Implementation is a follow-up feature ticket (schema: `workflow` flag on select
config + `category` on select options; readers updated to prefer category). This
ADR is the decision it builds against.
