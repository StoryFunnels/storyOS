# Public form embed: theming spec (ticket #711)

Design decisions for letting an embedded public form match its host site.
Written for Iris to build against. Everything here is grounded in values read
from `globals.css` and `app/f/[token]/page.tsx` on main; where I am proposing
rather than reporting, it says so.

---

## 0. The finding that reframes the ticket

**The embedded form follows the VISITOR's operating-system dark-mode setting.**

`app/f/[token]` has no layout of its own, so it inherits the root layout's
no-flash script (`lib/theme.tsx`):

```js
var t = localStorage.getItem('storyos-theme') || 'system';
var m = window.matchMedia('(prefers-color-scheme: dark)').matches;
var r = (t === 'dark' || (t === 'system' && m)) ? 'dark' : 'light';
```

In an iframe on a customer's site, that `localStorage` belongs to
`app.storyos.dev` and is empty — the visitor has never used StoryOS. So `t`
falls back to `'system'` and the form renders **dark whenever the visitor's
laptop is in dark mode**, on a cream page, for a host who never asked for it.

That is the screenshot on this ticket. `--bg-card` is `#171c26` in dark and
`--primary` is `#35427a` — literally "a dark navy card with a blue button".

**Two consequences for the build:**

1. This is not fixable with colour pickers. If a host sets three colours and
   the visitor is in dark mode, every token they did *not* set still flips —
   a half-dark form, which is worse than today.
2. It is browser-dependent, so it will not reproduce reliably. Safari blocks
   storage in third-party iframes, `getItem` throws, the `catch` swallows it,
   `data-theme` is never set and the form renders **light**. Chrome partitions
   storage instead, so it reads empty and follows the OS. Same page, same
   config, different result per browser.

**Decision: an embedded form never follows the visitor's OS.** It renders
`light` unless the embed config says otherwise. `theme` is one of the
controls below, with values `light | dark`. There is no `system` for embeds —
the host page's background does not change when a visitor toggles their OS.

This should ship even if nothing else here does; it is most of the reported
defect.

---

## 1. The control set: five controls, eighteen tokens

The form uses 18 distinct tokens across 60 references. Exposing 18 controls to
a non-technical embedder is not a design, it is a stylesheet. AC4 says they
must never hand-write config, and eighteen colour pickers breaks that in
spirit if not in letter.

**Five controls. Everything else derives.**

| Control | Type | Default | Derives |
|---|---|---|---|
| `theme` | light / dark | `light` | which base palette the rest starts from |
| `accent` | colour | today's `--primary` | `--primary`, `--accent`, `--border-accent`, `--text-on-dark` |
| `surface` | colour | today's `--bg-card` | `--bg-card`, `--bg-app`, `--bg-hover`, `--border-default`, `--border-strong` |
| `text` | colour | today's `--text-primary` | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint` |
| `radius` | 0–16px | `6` | `--radius-chip`, `--radius-control`, `--radius-card`, `--radius-modal` |
| `font` | curated list | `system` | the form's font stack (see §4) |

That is 5 controls (6 including `theme`) covering 17 of the 18 tokens. The
eighteenth is `--error`, which is deliberately **not** exposed — see §3.

### Radius derives multiplicatively

Today: chip 4, control 6, card 8, modal 12. As ratios of control: `2/3, 1,
4/3, 2`. At `radius = 6` that reproduces today's values exactly, and at
`radius = 0` every corner is square, which is what a host with a hard-edged
brand expects. An additive scale (`r−2, r, r+2, r+6`) reproduces today equally
well but leaves a 6px modal radius at `r = 0`, so: multiplicative.

### Colour derives by mixing toward the other pole

```
--bg-card          = surface
--bg-hover         = color-mix(in srgb, surface 94%, text)
--border-default   = color-mix(in srgb, surface 88%, text)
--border-strong    = color-mix(in srgb, surface 78%, text)

--text-primary     = text
--text-secondary   = color-mix(in srgb, text 85%, surface)
--text-muted       = color-mix(in srgb, text 62%, surface)
--text-faint       = color-mix(in srgb, text 45%, surface)

--primary          = accent
--accent           = accent
--border-accent    = accent
--text-on-dark     = DERIVED, never exposed — see §3

(Shipped in phase 1: colour controls accept HEX ONLY, not rgb()/hsl(). The
contrast floors need relative luminance, which needs parsing; a colour picker
emits hex and §6's builder is the only thing that writes this config. Alpha is
excluded because a translucent surface composites against whatever the host put
behind the iframe, so a floor measured against it would be measured against a
colour the visitor never sees.)
```

The percentages preserve the three-step text hierarchy (ink → muted → faint)
that `#326` built deliberately and that `#637`/`#669` spent six PRs defending.
Deriving them means an embedder **cannot flatten it** by picking three greys
that happen to be close together.

> **CORRECTED IN PHASE 1 (PR #791). These percentages are a STARTING POINT,
> not the rule — the contrast floor is the rule.**
>
> This section originally presented the percentages as the derivation. Checked
> against a real host brand, as the ticket asked: text `#2c2419` on surface
> `#fbf7ef` put `--text-muted` at **4.32:1** — below the 4.5:1 it needs, and
> below the **5.44:1 the unthemed form already achieves**. The spec's own
> numbers would have made a themed form *less* readable than an unthemed one.
>
> A fixed percentage cannot hold a contrast floor across arbitrary host
> colours, because the ratio depends on how far apart the two colours are to
> begin with — so no better constant exists. What ships instead: start at the
> percentage above, then step back toward the ink until the ratio clears
> **4.5:1** for `--text-secondary` and `--text-muted` (real content text) and
> **3:1** for `--text-faint` (the attribution — parity with what the unthemed
> form already does, rather than fixing `#706` in passing). Re-measured in the
> browser after the change: 4.58:1.
>
> This only works when BOTH `text` and `surface` are set. With `text` alone the
> surface is whatever `--bg-card` resolves to at render time and cannot be
> measured, so those three steps fall back to `color-mix` at the percentages
> above and the floors do not apply.

---

## 2. Absent config changes nothing

AC3 requires that no overrides means today's appearance, unchanged.

The way to guarantee that is not to reproduce the current palette by formula —
the derived neutrals are cooler than today's warm ones, and chasing an exact
match would be fragile. Instead: **when a control is unset, emit nothing for
it.** The existing token keeps its existing value. Derivation only runs for
tokens downstream of a control the embedder actually set.

So the diff for an unconfigured embed is zero declarations, and AC3 holds by
construction rather than by testing.

---

## 3. What must NOT be exposed, and why

**`--text-on-dark` is derived from `accent`, never set by the embedder.** It is
the label on the submit button. If a host picks a pale yellow accent and we
keep white text, the primary action of the form becomes unreadable. Derive it:
pick whichever of white or near-black scores higher contrast against `accent`,
and require ≥ 4.5:1. If neither reaches it, darken or lighten `accent` until
one does, and tell the embedder in the builder that their accent was adjusted.

**`--error` is not exposed and not derived from accent.** Error red is
semantic, not brand. If a host's accent is red, deriving error from it makes
validation failures indistinguishable from the submit button. It stays fixed,
with one guard: if the fixed error colour scores below 4.5:1 against the
chosen `surface`, shift its lightness until it clears. Legibility outranks
exactness for a message that tells someone their application did not send.

**`--shadow-popover`** stays fixed for v1. It appears twice and is low-stakes;
deriving shadow from surface luminance is a refinement, not a blocker.

---

## 4. Font: a curated, self-hosted set — not a free-text family

The ticket asks for a stated, working mechanism. A `font-family` field alone
does not work: the iframe is a separate document, so naming a family the host
loaded gets a silent system fallback and a half-broken form, which Otto is
right to call worse than not offering it.

Two mechanisms actually work. **I recommend the second.**

**(a) Google Fonts URL parameter.** The iframe loads
`fonts.googleapis.com/css2?family=…` itself. It works, and it is the obvious
answer — but for this surface specifically I think it is the wrong one. This
is a form that collects personal data, frequently on an EU company's site;
the reproduction case on this very ticket is a *careers* page collecting job
applications. Loading Google Fonts sends every visitor's IP to Google, and a
German court has already awarded damages over exactly that (LG München,
2022). Shipping a theming feature whose default mechanism creates a GDPR
exposure for our customer is not a good trade for a font.

**(b) A curated set, self-hosted by StoryOS.** Same origin, no third-party
request, guaranteed to load, no fallback surprise, no privacy question. The
cost is that an embedder cannot use a font we do not carry.

Proposed set — chosen to span the shapes a brand actually needs, not to be
comprehensive:

| Option | Covers |
|---|---|
| System (default) | matches nothing, offends nothing |
| Inter | neutral grotesk — the default "modern SaaS" voice |
| Figtree | StoryOS's own, for hosts who like it |
| Source Sans 3 | humanist sans, warmer |
| DM Sans | geometric sans |
| Source Serif 4 | serif body |
| Playfair Display | display serif, editorial brands |
| JetBrains Mono | technical brands |

Eight is enough to match most brands approximately and few exactly. **That is
the honest trade and the builder UI should say so** — "closest match" rather
than implying arbitrary fonts work. If a customer needs their exact licensed
font, that is a later ticket about uploading a font file, not a free-text box
that quietly fails.

---

## 5. The theme lives on the form, not in the embed URL

AC1 offers "iframe src, or an embed-config the iframe reads". **Recommend the
config object, stored server-side on the form**, with the embed URL unchanged.

The reason is not technical tidiness, it is what happens on day two. If the
theme is in the URL, changing a colour means the customer must go back into
their CMS, find the page, and re-paste the iframe. If it is on the form, they
change it in the builder and every existing embed updates. A form owner will
restyle more than once; they will paste the iframe once.

URL parameters can still be supported as an override for power users, and
they are useful for the live preview in the builder. They should not be the
primary mechanism.

---

## 6. The builder panel

A "Match your site" section in the existing share/embed panel.

```
  Match your site                                   [ Reset to default ]

  Theme      ( ) Light   ( ) Dark
  Accent     [swatch] #0F1729      ← button, links, focus ring
  Surface    [swatch] #FFFFFF      ← the form's background
  Text       [swatch] #0F1729      ← headings and labels
  Corners    [——•————] 6px
  Font       [ System            ▾ ]

  ┌─ Preview ─────────────────────────┐
  │  (the real form, live, at the     │
  │   embed's own width)              │
  └───────────────────────────────────┘

  ⚠ Text and Surface are too close to read comfortably. [ Fix for me ]

  [ Copy embed code ]
```

The load-bearing parts, in priority order:

1. **The live preview is not optional.** An embedder cannot hold five tokens in
   their head and predict the result. Without it they are hand-tuning blind,
   which is AC4's problem wearing different clothes. It should render the real
   form, at the embed's real width, updating as controls change.
2. **The contrast warning is a product feature, not a lint.** Compute
   `text` vs `surface` on every change; below 7:1 warn, and offer one-click
   correction. Our form looking broken on a customer's site is our problem
   regardless of who picked the colours.
3. **Each control says what it affects** ("← button, links, focus ring"). Five
   abstract colour slots are five guesses otherwise.
4. **Reset to default** must return to today's appearance exactly — which §2
   makes trivial, since default means "emit nothing".

Deliberately **not** in v1: eyedropper-from-host-page, per-field styling, CSS
injection, dark/light auto-pairing. Each is a bigger feature and none is
needed to stop the clash.

---

## 7. What I did not decide

- **Exact mix percentages** in §1 are my proposal from the current palette's
  own relationships; they should be checked against two or three real host
  brands before they harden. The *structure* (derive, don't expose) is the
  decision; the numbers are a starting point.
- **Whether `theme` should be inferred** from the host's background colour
  rather than chosen. Tempting, and probably right eventually, but it needs the
  host to tell us their background — which is `surface`, so it may collapse
  into one control. Left for after v1 ships and we see real configs.
- **Whether `bg-app` should track `surface` at all in embed mode.** In an
  iframe the card effectively *is* the page, so `bg-app` is barely visible.
  Harmless either way; Iris should pick whichever reads better in the preview.
