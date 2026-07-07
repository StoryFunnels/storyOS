---
id: MN-026
title: Comments + @mentions (+ optional SMTP email)
status: todo
depends_on: [MN-025]
size: M
---

`comments` table + endpoints (list/create/edit-own/soft-delete; admins delete any; **guests can comment** — the client-feedback loop). Rich-lite body (bold/italic/links/code + mention nodes); mentions extracted server-side from the body, never trusted from the client. Mention → email with excerpt + deep link via the SMTP mailer (env-configured; skipped with an admin banner when absent — same mailer as invites). Local dev uses Mailpit (fake SMTP catcher in `docker-compose.dev.yml` — add it here if MN-004 didn't); production for the founder's instances uses **Resend via its SMTP relay** (paid account available) — the app stays provider-agnostic generic SMTP. Comments panel on the entity page with `@` member picker (guests not mentionable). Emits `comment.created` activity events.

## Acceptance criteria

- [ ] Comment CRUD via API with role tests — guest POST succeeds on scoped records, member edit-own/delete-own, admin delete-any
- [ ] Server-side mention extraction (client-supplied mention list ignored — test)
- [ ] Mention email sent when SMTP configured; skipped + admin banner when not; test-send button in settings
- [ ] `@` picker in the composer; mention renders as a chip deep-linking to nothing leaky for guests
- [ ] Comments appear in the activity feed
