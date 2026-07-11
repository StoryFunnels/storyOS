---
id: MN-094
title: Forms — collect records via a shareable form
status: todo
depends_on: []
size: L
---

## Fibery parity

A **Form** is a view that renders selected fields as inputs; submitting creates a
record in the database. Fibery forms can be shared (internal or public link),
support field ordering, required fields, descriptions, and a thank-you/redirect.
Key for intake: feedback, requests, applications, lead capture.

## Scope

- New `view_type = form` (or a dedicated `forms` entity) with config: ordered
  fields, per-field required/label/help, form title/description, submit text.
- **Public submission path**: an unauthenticated `POST /public/forms/{token}`
  that validates against the database schema and creates the record (rate-limited,
  captcha optional). A public GET returns the form definition to render.
- Builder UI (drag fields in, toggle required) + a shareable link + a basic
  hosted render page. Respect field types (select → dropdown, relation → picker
  limited/omitted in v1, etc.).

## Open questions

- Public vs authed-only for v1? (Recommend: authed link first, public token next.)
- Relations/attachments in forms v1? (Recommend: scalars + select first.)

## Acceptance criteria

- [ ] Create a form for a database; choose + order fields, mark required.
- [ ] Shareable link renders the form; submit creates a valid record (schema-checked).
- [ ] Spam/rate-limit guard on the public endpoint.

Refs: [Fibery Views](https://the.fibery.io/@public/User_Guide/Guide/Views-8).
