# StoryOS design system

**Direction (founder-set):** Attio's app aesthetic — clean, dense, tool-like: near-white surfaces, subtle 1px borders, small radii, restrained color, sentence case — but **warmer**, borrowing the palette DNA from theborderlandsfoundation.org (warm whites, stone grays, navy + gold). Implemented as the Tailwind theme in MN-014.

**This doc states intent and points at the code for values, rather than re-copying them.** Re-copying values into prose is exactly how this doc drifted the first time — nine load-bearing claims went stale (ticket #623's audit) because nothing checks prose against `globals.css` at build time. [`apps/web/src/app/globals.css`](../../apps/web/src/app/globals.css) is the single source of truth for every hex value, and its own header comment points back here. Where a token's value carries a non-obvious reason, the reason lives as a comment on the token itself — this doc cites the ticket rather than restating the rationale.

## Palette

Warm neutrals instead of Attio's cool grays. Background is warm white, never pure white.

Token groups, by name (`globals.css` for values):

- **Surfaces** — `--bg-app`, `--bg-sidebar`, `--bg-card`, `--bg-hover`, `--bg-active`.
- **Text** — `--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint`, `--text-on-dark`.
- **Borders** — `--border-default`, `--border-strong` (1px, everywhere, instead of shadows for most surface separation — shadows are reserved for floating elements, see Elevation below).
- **Code surfaces** — `--bg-code`, `--border-code` (ticket #338): cool slate-blue against the warm page, so code reads as a distinct technical register without becoming a black slab.
- **Brand & actions** — `--primary`, `--primary-hover`, `--accent`, `--accent-hover`, `--accent-soft`.
- **Status** — `--success`, `--error`, `--warning`, `--info`.

31 of these are redeclared under `:root[data-theme='dark']` — see [Dark mode](#dark-mode) below.

**`--text-faint` carries a strict rule, and it is not fully enforced yet.** `globals.css`'s own comment on the token: reserved for genuinely decorative text (record numbers, "Saved", empty-computed em dashes) — anything that carries an affordance (a section label, an empty-state instruction, a keyboard-shortcut hint) uses `--text-muted` instead, which clears WCAG AA where `--text-faint` does not (measured 3.00–3.44:1 on light surfaces, still below 4.5 in dark). Ticket #637 is re-pointing violating call sites to `--text-muted`, **one surface per PR, by design** — as of this writing that covers five sites in the shared primitives (`input.tsx`, `date-picker.tsx`, `dropdown-menu.tsx`, `icon-picker.tsx`); other surfaces (sidebar section labels among them) still use `--text-faint` for affordance-carrying text and are pending their own pass. Don't read "some call sites still violate the rule" as a doc error — it's mid-migration, tracked incrementally on purpose.

**Select-option colors** (user-pickable, for tags/kanban columns). Fifteen, and
the source of truth is
[`table-view/option-colors.ts`](../../apps/web/src/components/table-view/option-colors.ts),
not this list — the table is a leaf module every field surface imports, so the
code cannot drift from itself the way this doc did (ticket #639: every one of ten previously-documented values was wrong, and the shipped palette is Tailwind's stock 600/500 ramp with five more colours than were ever listed here). If you change the palette, change `option-colors.ts`; don't hand-copy hex values into this doc again.

**Value chips (#281 shape, #207 fill, #638 rendering):** select-field badges (State, Priority,
Type, Project, …) and relation-entity chips (Blocked By, Blocker for, …) share
one 4px-radius shape (`--radius-chip`) but opposite treatments, so a category value and a link to
another record are never visually confused:
- *Select-value badge* — a **soft tint** of the option's own colour with the ink derived from
  that same colour per theme, sentence case, medium weight. #281 originally specified a solid fill
  with white uppercase text; **#207 deliberately replaced it** because in a dense table that read
  as a wall of loud colour — the soft tint is the decision, not drift.
- *Relation-entity chip* — outline only, `--border-strong`, no fill, normal-case text at body
  size/weight. The deliberate visual inverse of the badge above.

The ink is `.option-tint` in `globals.css`, driven by a `color-mix()` toward black on light and
toward white on dark — never a literal `color:` on the chip, which is exactly the bug ticket #638
fixed (a hardcoded blend meant the same chip measured 4.29:1 in light mode and 2.93:1 in dark,
the worst ratio on the page, because nobody had chosen the dark-mode number at all). Measured
after, worst case across all 15 colours × both themes is 5.27:1.

### One chip, two declared variants (#533 primitive 1)

Both treatments above come from **one** primitive:
[`ui/chip.tsx`](../../apps/web/src/components/ui/chip.tsx)'s `chipVariants`, with
`variant: 'value' | 'reference'`.

**Named for what they are, not how they are painted.** A `value` is drawn from
this field's own option set and is coloured by itself; a `reference` points at a
record living elsewhere, is coloured by its home database, and usually navigates.
They shipped as `filled`/`outline` for a day — names describing paint, which
invite a future reader to argue that two fills would look tidier and win on
visual grounds while quietly conflating two different kinds of thing. Before it, the shared shape (4px radius,
`px-1.5 py-0.5`, `gap-1`, truncate) was retyped in two separately-maintained
components, so it held by coincidence.

**The variants are the point, not the consolidation.** #533's first criterion was
originally "one chip component adopted everywhere", which taken literally would
have erased the deliberate filled-vs-outline distinction in the name of
consolidating an accidental one. What must survive is the *distinction*: it is now
a declared variant rather than two components that happen to differ and could
converge with any edit.

The primitive does **not** own max-width, shrink, the element type (`span` vs `a`)
or the children. A chip in a table cell wants `max-w-full`; a chip in a row of
references wants `max-w-40 shrink-0`. Per
[field-surfaces.md](../architecture/field-surfaces.md), different chrome *wraps*
the shared control rather than re-rendering it.

Type steps come from the role scale, not literals: `filled` is `text-meta`
(11px), `outline` is `text-body` (13px) — the same font sizes the two
`text-[Npx]` literals rendered.

The **leading changed**, though, and it is worth knowing: `text-[Npx]` sets no
line-height, so those chips inherited `normal`; the role steps apply 1.5.
Measured, the filled chip's box grows 17.50px → 20.50px. Table rows do **not**
move (fixed at 32px, cell 31px), so nothing reflows — the delta is a slightly
taller tint behind the label. Kept deliberately: `line-height: normal` on an 11px
pill was itself off-scale.

### Colour is bound to entity identity (#533 primitive 2)

This guarantee **already held**; #533 asked for it to be written down rather than
rebuilt, so here it is:

- A database has one colour on `databases.color`, resolved read-time through the
  API's `resolveDatabaseColor(id, color)` — so a database with no stored colour
  still gets a *stable* one derived from its id, and every read path resolves
  through the same function.
- A select option's colour is stored **per option, keyed by option id**, so it
  survives renames and reordering.
- An avatar's colour is derived by hashing the **user id**, never the display name
  (MN-045), for the same reason.

The rule that follows: **no surface reassigns colour.** If two places show the
same entity in different colours, one of them derived its own instead of reading
the stored value — and that is the bug.

## Typography

- **UI font: Figtree** (Google Fonts; weights 400/500/600/700) — warm, friendly, highly legible; the Borderlands family, works great at app density. Fallback `-apple-system, Segoe UI, sans-serif`.
- **Mono: JetBrains Mono** — api_names, tokens, code.
- **The UI type scale is role names, not t-shirt sizes** (ticket #634, frozen against #624's decision): `--text-micro` (10px) · `--text-meta` (11px) · `--text-label` (12px) · `--text-body` (13px) · `--text-prose` (14px) · `--text-title` (16px), each with its own `--*--line-height` at a 1.5 ratio. **13px (`--text-body`) is the app's actual de-facto UI chrome size** — not 14px — confirmed by ticket #623's audit against 548 real call sites; the scale's values were chosen to match what the app already renders, so adopting a token is a rename, not a restyle.
- **Tailwind's own `text-sm`/`text-base`/etc. are deliberately untouched and stay a second, separate scale for headings** (`text-lg`/`text-xl`/`text-2xl`). Redefining `text-sm` to 13px to match the app's real body size was considered and rejected (ticket #623's audit, D1 decision on #624) — 125 existing call sites depend on `text-sm` meaning 14px (every `<Button>`, every `<Input>`), and silently shrinking all of them is exactly the "restyle disguised as a refactor" the initiative's own charter forbids. So the app now has two scales on purpose: a role-named UI scale for chrome, and Tailwind's named scale for headings. Migrating an arbitrary `text-[13px]` etc. to `text-body` etc. is ongoing, file by file — the tokens exist and are proven zero-visual-change on the surfaces already migrated, not yet everywhere.
- Entity-page prose gets its own treatment — see [Density & spacing](#density--spacing).
- **Sentence case is the rule** — buttons, headers, labels. `uppercase` still appears at 76 call sites across 38 files as of the #623 audit (tiny sidebar/section labels being the intended exception) — this hasn't had its own audit pass yet, so treat "sentence case always" as the rule being enforced, not a claim that every current call site already complies.

## Shape & depth

- **Radii**: `--radius-control` (6px, controls/inputs/cells), `--radius-card` (8px), `--radius-modal` (12px), `--radius-chip` (4px, value chips only — the one deliberate exception, see Palette above), avatars full. **6px is real and generated correctly** (verified: Tailwind v4's `@theme inline` only emits classes it finds by scanning source files, so a class built at runtime never appears — that is a scanning quirk, not evidence the utility is broken) but underused in practice: on the primary table screen, 22 distinct control shapes appear and exactly one renders at 6px: everything else defaults to Tailwind's bare `rounded` (4px), which appears 275 times against 385 uses of the actual token. If a control you're building looks 4px, check whether it should be reaching for `--radius-control` instead of copying a 4px neighbour.
- **Elevation is a real token set now** (ticket #630) — `--shadow-popover`, `--shadow-panel`, `--shadow-lifted`, `--shadow-overlay`, `--shadow-modal`, `--shadow-palette`, plus two directional edge shadows, all built from a single shared `--shadow-ink` rgb triple so every elevation level stays visually related. Before this, the app had 14 distinct hand-rolled shadow values across 30 call sites — the same handful of elevation levels re-derived from memory each time, landing on four different opacities for what was meant to be the same popover shadow. Depth still mostly comes from **1px borders + subtle bg shifts**; these tokens are for the floating elements (popovers, panels, modals, drawers) that need real elevation. **A row being dragged in place carries no shadow at all** (ticket #631) — it's already dimmed to indicate its state, and a dimmed row plus a shadow would say the same thing twice; only a cursor-following drag overlay (the board card ghost) gets `--shadow-lifted`, since that one genuinely is detached from the page.
- **Focus**: `--focus-ring-width` / `--focus-ring-color` / `--focus-ring` (ticket #633) — derived from `--accent` via `color-mix()` rather than a hardcoded value, so it follows the theme (previously hardcoded to `--accent`'s *light-mode* value, making the focus ring the one element in the app that ignored dark mode). Drawn as an `outline` at offset **0**, not `box-shadow` — an offset ring on a dense grid clipped against the neighbouring cell, and `box-shadow` competed with whatever elevation shadow the element already had, since both wanted the same CSS property.

## Density & spacing

**There is no 8px grid, and there never needs to be one.** Spacing (padding, margin, gap) already resolves to Tailwind's default **4px step** almost everywhere in the app: as of the #623 audit, only 20 call sites in the whole of `apps/web/src` use an arbitrary spacing value, against roughly 2,400 uses of the 4px scale (3,014 counting margins) — a long, ordinary, well-behaved distribution. **Half-steps are in heavy real use and are part of the system, not an exception to it**: `py-0.5` (2px) appears 112 times, `gap-1.5` (6px) 248 times, `px-2.5` (10px) 33 times, alongside the whole-step values `gap-2` (279), `px-2` (265), `gap-1` (186), `py-1` (99). A prior version of this doc said "8px grid," which was simply wrong — not a rounding choice, a different number — and it was never caught because nothing checks this doc against the code. Recording the real grid here is the point, not a formality: **a grid that is followed everywhere and documented nowhere is one refactor away from being lost.**

**Rich text gets more room, and the gutter is load-bearing, not excess padding.** BlockNote's editor sets 52px of left padding (globals.css) — reduced from 54px, but not to less, because hovering a block reveals a 48px-wide affordance gutter (the insert `+` and drag handle) that the padding exists to clear; removing it puts a drag handle on top of the first word. On the standalone `/doc` page the prose column is capped narrower with roomier line-height (1.6), matching this doc's original direction for entity-page prose — a record's own description panel stays at the denser 14px/1.5 chrome rhythm, since its column is already narrow.

## Voice in UI

Plain, quiet, confident. No exclamation marks, no "awesome". Empty states teach ("Create a database to model anything — clients, articles, posts"), never celebrate.

## Dark mode

**Shipped** (ticket #30) — not "not in v1." 31 semantic tokens are redeclared under `:root[data-theme='dark']`; light stays the default when no theme is chosen. Every token this doc names is dark-mode aware unless stated otherwise.

Contrast in dark mode is not automatically fine just because a token has a dark value — a themed pass (ticket #644/dark-mode-review) found the same 17-of-52-text-node WCAG AA failure count in both themes on a real record page (some nodes worse in each direction), plus one dark-only defect that was never a contrast failure at all: the rich-text editor (BlockNote) shipped its own default palette and typeface underneath StoryOS's chrome, so a description field rendered in a visibly different, cooler grey and a different font from the card around it. Fixed by mapping BlockNote's own CSS custom properties onto StoryOS's tokens rather than leaving it unthemed — both themes were fixed by the same change, since the tokens themselves are already theme-aware.

## Components

shadcn/ui components restyled with these tokens. Key look decisions: primary button = navy-900 fill / warm-white text; secondary = white fill + 1px border; destructive = `--error` outline until confirm; kanban cards = white on `--bg-app` with 1px border, `--radius-card`; sidebar = `--bg-sidebar` with sectioned spaces. **The active sidebar item no longer gets a gold left-edge indicator** — it was removed, and `--bg-active` was deepened specifically to remain the sole "you are here" signal once the indicator was gone (see the `--bg-active` comment in `globals.css` for the measurement).

**Primitives**: `button`, `input`, `label`, `dialog`, `popover`, `dropdown-menu`, `confirm-dialog`, `avatar`, `icon-picker`, `date-picker`, `switch`, `error-boundary`, `drag-presentation`, `toaster` — and, as of ticket #627, **`select`**: the native `<select>` as a real primitive, closing the single largest primitive gap the #623 audit found (114 raw `<select>` elements across 34 files, drifted across four heights, four text sizes and two radii with nothing forcing them to agree). Its variants deliberately reproduce the class strings already in use, so migrating a call site is a rename, not a restyle — `select-variants.unit.test.ts` asserts that parity directly.

Reaching for a raw HTML control instead of an existing primitive is how the `<select>` gap happened in the first place — check this list before hand-rolling a control that already has one.

## Provenance

The system in this doc is periodically measured against the real codebase rather than trusted from memory — ticket #623's audit (`docs/design/audit-2026-09-08.md`, reproducible via `bash docs/design/measure-baseline.sh`) is the most recent full pass, and the dark-mode/contrast findings above come from a themed follow-up (`docs/design/dark-mode-review-2026-09-08.md`) and a density review (`docs/design/density-review-2026-09-08.md`). Treat those files as the detailed evidence; this doc is the standing summary, meant to be corrected the moment it and the code disagree again.
