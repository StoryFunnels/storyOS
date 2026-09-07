# Flow builder canvas: no library

The canvas technology decision for the automation flow builder (#161), made
explicitly rather than inherited. Slice A (#283, read-only diagram) and slice C
(#285, edit on canvas) both render the same diagram; this is slice B (#284) —
decide once, before either slice's rendering code exists, so neither one makes
the choice by accident.

> **TL;DR** — no dependency. Plain CSS/flex + SVG connectors. The parent
> ticket's title names React Flow, but that assumed the answer before this
> slice existed to check it. Measured cost of adopting it instead: **+205 KiB**
> of client JS for a diagram this shape does not need pan/zoom, a minimap, or
> free-form node dragging to solve.

## The problem

An automation rule is `trigger → rule-level condition → ordered actions[]`,
with two wrinkles: a per-action condition renders as a branch on that action,
and `create_records` renders as a fan-out (#283's acceptance criteria). That is
the entire shape slice A has to draw, and the entire shape slice C has to let
someone reorder.

That is **not** a general node-graph editing problem:

- Nodes are not freely positioned — they fall out of the rule's linear order,
  with branches and one fan-out. There is no "drop a node anywhere" case.
- Slice C's own scope is "reorder / add / remove actions" (#285) — list
  operations on an ordered array, not the arbitrary-graph editing (drag any
  node anywhere, connect any handle to any handle) that a graph library is
  built for.
- Pan/zoom and a minimap matter once a diagram is long enough to not fit on
  screen. A rule with a handful of actions and occasional branches does not
  reach that — and if a specific rule ever does, that is a scroll container,
  not a missing library.

A canvas library is the right tool when the editing surface is genuinely
free-form (arbitrary node placement, arbitrary edges, pan/zoom over a large
graph). This diagram is a **tree with a fixed traversal order**, which is a
much smaller problem.

## Prior art in this exact codebase

[`space-ontology.tsx`](../../apps/web/src/components/space-ontology.tsx) (#449)
already answered the adjacent question — a node-and-edge diagram (databases as
nodes, relations as edges, satellite nodes for cross-space relations) — and
its own top-of-file comment states the decision this ADR is about to repeat
independently:

> "LAYOUT — no library, and that is a stated decision, not an oversight.
> Nothing in package.json does graph layout (checked before writing this), and
> adding one — react-flow, d3-force, dagre — is a dependency call bigger than
> this ticket, made for a single page."

That diagram hand-rolls SVG positioning, a fan-out spread for satellite nodes,
and full light/dark theming through the app's existing CSS variables — the
same three things this ticket's diagram needs. It is the concrete existing
model to copy rather than a library's.

## Options evaluated

| Option | Cost | Gets you |
|---|---|---|
| **1. Plain CSS/flex + SVG connectors** | Zero new dependency | Full control, trivial theming via existing CSS variables, no pan/zoom (not needed for this shape) |
| **2. React Flow (`@xyflow/react`)** | +205 KiB measured (below) + its own theming story | Pan/zoom, minimap, drag-anywhere — none of which this diagram's shape requires |
| **3. A lighter graph lib** | Smaller than Option 2 but still a new dependency, still solves a more general problem than this one has | Same mismatch as Option 2, just cheaper |

Option 3 was not measured separately: it inherits the same objection as
Option 2 — this problem does not need a graph-layout library at all, so
"how much does a lighter one cost" is the wrong question to spend time
answering.

## Decision: Option 1 — plain CSS/flex + SVG connectors

Render the rule's node/edge model (the derivation slice A's own acceptance
criteria already require to be pure and shared — "the derivation lives in one
place and is exported, so slice C edits the same node/edge model") with:

- Flexbox for the linear trunk (trigger → condition → actions in order).
- A branch (per-action condition) and a fan-out (`create_records`) as nested
  flex groups — both are still tree structure, not arbitrary graph structure.
- Thin SVG connector lines between adjacent boxes, positioned by reading DOM
  layout (the same category of technique `space-ontology.tsx` uses for its
  satellite spread), not by a layout solver.
- Theming through the app's existing CSS custom properties
  (`--color-ink`, `--color-border-default`, `--color-accent`,
  `--color-card`, etc. — [`globals.css`](../../apps/web/src/app/globals.css))
  and the shared `OPTION_COLORS` palette
  (`apps/web/src/components/table-view/option-colors.ts`) already used
  wherever a stable per-item color is needed. No new color system.
- Slice C's "reorder / add / remove actions" is list editing (buttons /
  drag-handle-and-drop reordering a JS array — `@dnd-kit/*` is already a
  dependency the app uses elsewhere for exactly this), not free-form canvas
  node dragging.

## Bundle-size measurement

Criterion: a **measured** delta on this app's own build, not the package's
published size. Method:

1. Baseline: `pnpm --filter @storyos/web build` (Next 16 / Turbopack), then
   summed the byte size of every file under `apps/web/.next/static/chunks`:
   **5,251,712 bytes**.
2. Added `@xyflow/react` as a real dependency (`pnpm --filter @storyos/web add
   @xyflow/react`) and a throwaway page
   (`apps/web/src/app/scratch-canvas-bench/page.tsx`) rendering a minimal
   `<ReactFlow>` with `Background`, `Controls`, and `MiniMap` — the same
   building blocks a real flow builder page would use — so the library's code
   actually gets bundled into a route rather than sitting as an unused
   dependency.
3. Rebuilt. New `apps/web/.next/static/chunks` total: **5,461,407 bytes** — a
   **+209,695 byte (~205 KiB)** delta. Grepping the built chunks for
   `xyflow`/`ReactFlow` identifies the specific chunk carrying the library's
   own runtime at **164,662 bytes**; the remaining ~45 KiB is the scratch
   route's own glue and CSS (`@xyflow/react/dist/style.css`).
4. Reverted both the scratch page and the dependency
   (`pnpm --filter @storyos/web remove @xyflow/react`) — nothing from this
   measurement is kept; this ADR does not adopt the dependency.

**+205 KiB of client JS**, plus a CSS file this app would need to override
rather than compose with its own theme tokens, for pan/zoom/minimap/drag
capability the diagram's actual shape does not use.

## Whether whiteboards or mind maps would share this canvas

No — checked explicitly per the ticket's own question. `#87`'s whiteboard work
and `#574`'s mind-map view are **free-form canvases**: arbitrary node
placement anywhere on an open surface, likely needing real pan/zoom once a
board grows. That is the actual problem a graph/canvas library is built to
solve, and it is a materially different shape from this ticket's fixed-order
tree. If and when either of those lands, it makes its **own** canvas-library
decision on its own merits — this ADR's "no library" conclusion is scoped to
the flow builder's linear/branching/fan-out shape and should not be read as
"StoryOS never adopts a canvas library."

## Consequences

**Buys:** zero new dependency, trivial theming (reuses tokens the rest of the
app already has), no library upgrade cadence or licence to track, and a
rendering approach already proven in this exact codebase by `space-ontology.tsx`.

**Costs:** slice A/C's implementer hand-rolls SVG connector positioning
instead of getting it from a library — the same cost `space-ontology.tsx`
already paid and the reason its own comment calls out the decision explicitly.

**Revisit this if:** a real rule's diagram turns out to need genuine free-form
node placement, multi-node drag-select, or a minimap because flows commonly
run long enough that pan/zoom becomes necessary rather than a nice-to-have —
i.e. if the actual shape stops matching "mostly-linear, occasional branches"
once slice A ships against real rule data. Nothing observed while writing this
ADR suggests that; #283's own verification against `main` confirms the rule
shape today (trigger + condition + ordered actions, per-action conditions,
`create_records` fan-out) is exactly the fixed-order tree this decision assumes.

## References

- Parent: #161 (visual automation flow builder) · this slice: #284 · siblings:
  #283 (read-only diagram), #285 (edit on canvas)
- Prior art: [`space-ontology.tsx`](../../apps/web/src/components/space-ontology.tsx)
  (#449) — same "no library" conclusion, independently reached, for an
  adjacent node/edge diagram
- Theming: [`globals.css`](../../apps/web/src/app/globals.css),
  `apps/web/src/components/table-view/option-colors.ts` (`OPTION_COLORS`)
- Existing reorder primitive already in the app:
  `apps/web/src/components/**` usages of `@dnd-kit/core` / `@dnd-kit/sortable`
