# Mobile & responsive: audit + PWA-first plan

Status: **plan now, deliver later** (MN-230). "The operating system for your
business" cannot be desktop-only — owners approve work, check status, and capture
records from their phones. This doc is the 375px audit and the phased plan; the
build lands as the sub-tickets filed under it.

## Strategy decision: responsive web + PWA first, native deferred

We ship a **responsive web app**, then make it an **installable PWA** (home-screen
icon, standalone display, push notifications for Inbox/approvals). We do **not**
build native iOS/Android apps now — a PWA covers the mobile-critical flows below
at a fraction of the cost, on the same codebase, with no app-store gatekeeping.
Native is explicitly deferred until the PWA's limits (deep OS integration,
background sync) actually bind.

Rationale: the killer mobile moment is **approving an agent action** (MN-216) from
a push notification — a PWA delivers exactly that. Everything else mobile users
need (My Work, view a record, quick-capture, a client viewing a portal) is
readable/editable web content that responsive layout solves.

## Current posture (the honest baseline)

- **Viewport:** relies on the Next.js default (`width=device-width`); `layout.tsx`
  sets only `theme-color`, no explicit width hardening.
- **PWA:** none. No manifest, no service worker. `public/icon-192.png` exists but
  is orphaned.
- **Responsive breakpoints:** effectively absent app-wide — only the record page
  and two settings grids use `sm:/md:/lg:`. Every other surface is hardcoded
  desktop width.

## Breakage catalogue @ 375px

Derived from a code sweep of `apps/web/src`. Severity: **B**reak (unusable),
**D**egraded (works, poor), **OK**.

| Surface | Severity | What breaks | File |
|---|---|---|---|
| Sidebar | **B** | `w-60` (240px) `shrink-0`, always shown, no drawer — eats 64% of a 375px screen | `components/sidebar.tsx:119`, `app/w/[ws]/layout.tsx:30` |
| View-tab bar | **B** | `flex ... gap-1` with no wrap/scroll → tabs clip under `overflow-hidden` parent | `app/w/[ws]/d/[db]/page.tsx:58` |
| Settings | **B** | two-pane, `w-52` (208px) side-nav `shrink-0`, no stacking | `app/w/[ws]/settings/layout.tsx:43` |
| Inbox page | **B** | master/detail; list `w-full ... shrink-0` collapses the detail to ~0 | `app/w/[ws]/inbox/page.tsx:132` |
| Inbox slide-over | **B** | `w-96` (384px) > 375px viewport → overflows right, clips left | `components/inbox-panel.tsx:121` |
| Calendar view | **B** | `grid-cols-7` always → ~49px cells, unreadable | `components/views/calendar-view.tsx:155` |
| Board view | **D** | columns `w-72` (288px) fixed → near full-bleed, scroll per column | `components/views/board-view.tsx:364` |
| Table / Timeline | **D** | pixel-fixed widths inside a scroll container — usable via horizontal scroll, no condensed mode | `table-view.tsx:358`, `timeline-view.tsx:136` |
| Hand-rolled popovers | **D** | fixed-width `absolute` popovers (`w-72`/`w-64`/`w-56`) with `left-0`/`left-1/2`, no viewport collision handling → clip near edges | `relation-cell.tsx:148`, `cells.tsx:50,513`, `table-view.tsx:871,939`, `icon-picker.tsx`, `date-picker.tsx:126` |
| Settings webhooks grid | **D** | `grid-cols-2` no breakpoint in a squeezed column | `settings/webhooks/page.tsx:375` |
| Home | **D** | `grid-cols-2` no breakpoint; `p-10` heavy | `app/w/[ws]/page.tsx:179` |
| Record page | **OK** | already stacks `lg:flex-row`, aside `w-full lg:w-72` — the template to copy | `app/w/[ws]/d/[db]/r/[rec]/page.tsx:282,381` |
| Gallery / List / Feed / Form | **OK** | `auto-fill minmax` grids and `max-w-* mx-auto` caps | `gallery-view.tsx:53`, etc. |
| Command palette / base Dialog | **OK** | `w-full max-w-*` — fill-and-cap | `dialog.tsx:25`, `command-palette.tsx:178` |

**The good patterns to copy:** `lg:flex-row` stacking (record page),
`repeat(auto-fill, minmax(Npx, 1fr))` grids (gallery), `max-w-* mx-auto` caps
(feed/form), `w-full max-w-*` dialogs.

## Mobile-critical flows (what must work on a phone first)

1. **Inbox + approvals** (MN-216) — the killer flow; the reason for push. Single
   pane, one-tap Approve/Reject.
2. **My Work** — already mostly OK; verify at 375px.
3. **Record view/edit** — already stacks; verify inline editors and popovers.
4. **Capture / quick-add** — a fast "new record" from anywhere (FAB).
5. **Portal viewing** — the client-facing side of Forms/portals (#61) is viewed on
   phones by definition.

## Phased build plan (→ filed sub-tickets)

- **Phase 0 — PWA foundation:** `manifest.webmanifest` (name, icons incl. the
  orphaned `icon-192.png` + a 512, theme/background, `display: standalone`),
  explicit `viewport` width, a service worker (offline shell + push registration
  scaffold). Ship even before layouts are perfect — it's the install/notify base.
- **Phase 1 — App shell:** sidebar → off-canvas drawer under `md` with a header
  hamburger; view-tab bar `overflow-x-auto`. Unblocks every content surface.
- **Phase 2 — Mobile-critical flows:** Inbox page + slide-over single-pane under
  `md`; approvals one-tap; quick-add FAB; verify My Work + record page at 375px.
- **Phase 3 — Views:** calendar → agenda/list under `md`; board columns
  `w-[85vw] md:w-72`; migrate hand-rolled popovers to collision-aware positioning
  (Radix Popover / Floating UI).
- **Phase 4 — Settings & polish:** settings side-nav → stacked/scrollable tab bar
  under `md`; responsive the remaining `grid-cols-2`; padding/typography pass.

Each phase is an independent, shippable sub-ticket (see the tickets filed under
MN-230). Phases 0 and 1 are the prerequisites; 2 delivers the value; 3–4 finish
coverage.
