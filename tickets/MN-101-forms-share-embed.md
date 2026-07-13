---
id: MN-101
title: Forms v2 — builder sidebar, public sharing, embedding, field config
status: todo
depends_on: [MN-094]
size: L
---

## Goal (founder)

"Use forms to give control to create new entities through it" — including by people
**outside** the workspace. Make forms genuinely shareable and embeddable, with a real
builder and per-field input config.

## Best-practice reference

Tally / Typeform / Google Forms / the reference tool & Notion forms converge on: a form is an
ordered list of fields → inputs; each field has a label, help text, placeholder,
required flag; submit creates a record; a shareable **public link** and an
**`<iframe>` embed**; a thank-you state / redirect; spam protection (honeypot +
rate-limit, optional captcha); access control (open to anyone vs. sign-in required).

## Scope

**Builder (in-app)**
- Move the field picker out of the toolbar "Cards" popover into a **right sidebar**
  builder (default-open on a form view): reorder fields (dnd), toggle required,
  per-field **label / placeholder / help**, plus form title / description / submit
  text and a success message.
- Input widgets by type: text/number/date/checkbox/url/email/**select→dropdown**,
  **user→people picker**, **relation→record picker (+ create-new)**, multi-select.

**Sharing & embedding**
- `config.form.public_token` + access mode (`members` | `link` | `public`).
- Public render route `/f/{token}` (unauthenticated when mode=public) that renders
  the form standalone (no app chrome) — this is also what the embed iframe loads.
- **Embed**: a copy-paste `<iframe src="…/f/{token}?embed=1">` snippet; responsive.
- Backend: `GET /public/forms/{token}` (definition) + `POST /public/forms/{token}`
  (validate against the db schema → create record). Honeypot + throttle; captcha hook.

## Acceptance criteria
- [ ] Right-sidebar builder: order fields, set required/label/placeholder, form meta.
- [ ] All field types render correct inputs (incl. relation record-picker + create).
- [ ] Shareable public link + working iframe embed; access modes enforced.
- [ ] Public submit creates a valid record; spam/rate-limit guard on the endpoint.
- [ ] Success state / optional redirect after submit.
