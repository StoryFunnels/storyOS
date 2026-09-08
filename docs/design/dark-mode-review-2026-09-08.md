# Dark mode and contrast — a review

**Reported by Ievgen, 2026-09-08:** *"Colors inside rich text… basically need to
review not just rich text but everything else, it's not readable."*

Measured in a real browser at 1280×800 on a record page, in **both** themes,
against `origin/main` at `39ac4f3`. Reproduce with:

```js
// paste docs/design/contrast-probe.js into the console, once per theme
```

This closes a gap I declared in the baseline audit and did not close myself:
*"dark mode was never walked in a browser."* It needed a person to look, and the
person was the founder.

---

## The count is the same in both themes: 17 of 52 text nodes fail WCAG AA

Dark mode is **not** uniquely broken — that was my first assumption and it is
wrong. The same 17 nodes fail in light mode; some are worse in one theme, some in
the other. What is dark-only is the rich-text problem in §1, and it is not a
contrast failure at all.

| defect | theme | severity |
|---|---|---|
| 1. Rich text is a foreign surface | both, visible in dark | the reported one |
| 2. `--text-faint` fails AA everywhere | both | 11 of 17 failures |
| 3. Option chips are theme-blind and off-palette | both, worse in dark | worst ratio on the page |
| 4. Rich text is set in the wrong typeface | both | previously unnamed |

---

## 1. The rich-text editor was a foreign surface — FIXED in this PR

BlockNote ships a complete theme of its own. StoryOS was overriding two corners
of it — #338's code blocks and the "/" menu's row height — and nothing else. So
every description field and every document body rendered in BlockNote's palette
inside a StoryOS card:

| | BlockNote painted | StoryOS token |
|---|---|---|
| dark surface | `#1f1f1f` neutral grey | `--bg-card` `#171c26` warm navy |
| dark text | `#cfcfcf` neutral grey | `--text-primary` `#f3efe7` warm cream |
| light text | `#3f3f3f` neutral grey | `--text-primary` `#0f1729` navy |
| font | Inter (§4) | `--font-sans` Figtree |

**The text was never a contrast failure.** `#cfcfcf` on `#1f1f1f` measures
**10.58:1** — comfortably AA. It reads as "not readable" because it is dimmer and
cooler than the app's own body text and sits on a visibly different slab. A
contrast-only audit passes this and misses it entirely, which is the most useful
thing in this document: **the reported problem was a palette problem wearing a
contrast problem's clothes.**

Against the card it actually sits on, the numbers move:

```
before   #cfcfcf on #171c26   →   9.90:1
after    #f3efe7 on #171c26   →  14.88:1
```

Fixed by mapping BlockNote's 42 CSS custom properties to StoryOS tokens in
`globals.css` — one block, no component changes, and because our tokens are
already theme-aware, **both themes are fixed without a dark override.**

Remapped pairs, measured after (all AA in both themes):

| surface | dark | light |
|---|---|---|
| menu | 14.88 | 17.87 |
| tooltip | 10.45 | 11.37 |
| hovered row | 13.56 | 16.13 |
| selected row | 11.59 | 13.58 |
| disabled | 3.55 | 3.10 |

`disabled` is deliberately below 4.5 — WCAG 1.4.3 exempts inactive controls, and
it maps to `--text-faint`, which is §2's subject.

### The selector is the whole trick, and I got it wrong first

BlockNote sets these on `.bn-root` (0,1,0) and
`.bn-root[data-color-scheme='dark']` (0,2,0), and its stylesheet is served
**after** ours. My first attempt used `.bn-container` — which ties with
`.bn-root` and loses on source order, and never stood a chance against the dark
rule. It changed nothing and I only knew because I measured. The shipped
selectors are one step above each counterpart, so the outcome does not depend on
chunk order. `globals.css` already carried this exact warning for
`.bn-default-styles`; I did not read my own file carefully enough.

---

## 2. `--text-faint` fails AA on every surface, in both themes

| surface | light | dark |
|---|---|---|
| on `--bg-card` | 3.44 | 3.89 |
| on `--bg-app` | 3.22 | 4.24 |
| on `--bg-sidebar` | 3.00 | 4.40 |

Every value is below 4.5. This accounts for **11 of the 17 failures**.

**The token is not the whole problem — its usage is.** `globals.css`'s own #326
comment sets the rule: faint is *"reserved for genuinely decorative text (record
numbers, 'Saved', empty-computed em dashes); anything that carries an affordance
uses `--text-muted`, which clears AA."* That rule is being violated:

| rendered in `--text-faint` | decorative? |
|---|---|
| sidebar section headers — Spaces, General, Personal, Agentic OS, Client Work | **no** — navigation structure |
| "Nothing linked yet." | **no** — the empty state of a relation |
| "Drop files here or use Upload." | **no** — an instruction |
| ⌘K / ⌘J shortcut hints | **no** — an affordance |
| record number `#1`, "Saved", relation counts `0` | yes |

So the fix is mostly **re-pointing call sites at `--text-muted`**, not lowering
the token — which would have been the lazy read, and would have flattened the
three-step hierarchy #326 deliberately built. Filed as its own ticket because it
touches call sites across several surfaces and each needs a before/after.

---

## 3. Option chips are theme-blind by construction, and off the documented palette

Two separate problems in one component.

**a) The rendering is theme-blind.** `OptionChip` in `table-view/cells.tsx`:

```jsx
style={{ backgroundColor: `${color}22`, color }}
```

The colour at 13% alpha as background, the same colour at full strength as text.
Composite that over a light page and you get a pale tint; over `#171c26` you get
a dark tint — but **the text stays identical in both**. Nobody chose the
resulting ratios:

```
blue chip "OK"      #2563eb   light 4.29:1   dark 2.93:1   ← worst on the page
avatar initials     #64748b   light 3.80:1   dark 2.95:1
```

This also contradicts `design-system.md`, which specifies the #281 "solid
mini-tag": *solid fill in the option's own color, white text, uppercase,
semibold.* What ships is a soft tint with coloured text, sentence case, medium.

**b) The palette is not the documented one.** `option-colors.ts`'s header says
*"Warm-tuned chip colours (docs/design/design-system.md)"*. It is the stock
Tailwind ramp:

| | doc says | code has | |
|---|---|---|---|
| gray | `#B5B0A5` | `#64748B` | slate-500 |
| red | `#C0392B` | `#DC2626` | red-600 |
| blue | `#3D5296` | `#2563EB` | blue-600 |
| green | `#2D7A4F` | `#15803D` | green-700 |
| purple | `#7E5BA6` | `#7C3AED` | violet-600 |
| teal | `#057160` | `#0D9488` | teal-600 |

**Not one of the ten documented values survives**, and the file asserts the
opposite. These are the most-seen colours in the product — every select field,
every board column, every status badge — so this is the largest single palette
drift in the codebase, and it is the "colors" half of the original report.

Filed separately from §1 because fixing it changes how every chip in the product
looks: that is a step-4 value change needing its own before/after, not something
to smuggle into a dark-mode fix.

---

## 4. Rich text was set in the wrong typeface — FIXED in this PR

`--bn-font-family` asks for `Inter, "SF Pro Display", -apple-system, …`. **Inter
is not loaded in this app** — only Figtree is (9 faces). So rich text fell
through to the OS font (San Francisco on macOS) while the chrome around it stayed
Figtree. Every document body and description field in the product was set in a
different typeface from its own container.

Remapping the variable was not enough: `.bn-default-styles` hard-codes
`font-family: Inter, …` as a **literal**, not as `var(--bn-font-family)`. Fixed
on the rule in `globals.css` that already overrides that same element's
font-size.

---

## What I did NOT check

- **Only the record page was swept.** Board, calendar, timeline, gallery, form,
  dashboard, settings and the document editor were not measured. The rich-text
  fix is global (it is a token mapping), but the 17 failures are one page's
  worth — the real total across the app is unknown and almost certainly higher.
- **BlockNote's menus were verified by their resolved variables, not by
  photographing each one.** I could not summon the formatting toolbar with
  synthetic events. The contrast table in §1 is computed from the values those
  menus consume, which is sound but is not the same as having seen every menu.
- **Screenshots of the rich-text change are weak evidence and I am not
  pretending otherwise.** The delta is a colour and typeface shift inside one
  panel; at screenshot scale it is subtle, and the browser pane was also
  down-compositing. The measured values are the evidence; the before/after image
  on the PR is a labelled swatch comparison, which is honest about being one.
- **No keyboard, focus-order or screen-reader testing.** Contrast is one of
  several accessibility properties and the only one measured here.
- **`::selection` in dark mode looked lighter than `--accent-soft` `#332e1c`
  should render.** Noticed, not investigated, not filed — I do not know yet
  whether that is the browser forcing a selection colour or a real defect.
