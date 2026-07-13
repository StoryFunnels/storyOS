---
id: MN-103
title: Transactional email via Resend — invitations, notifications, auth mail
status: todo
depends_on: [MN-008, MN-026, MN-049]
size: M
---

## Problem

Email is currently best-effort / SMTP-optional. Invitations, mentions, and auth mail
don't reliably reach people. We're standardizing on **Resend** for transactional email.

## Scope

- **Email service** behind an interface (`EmailService`) with a Resend driver + a
  no-op/log driver for dev; configured by env (`RESEND_API_KEY`, `EMAIL_FROM`,
  `APP_URL`). Graceful degrade (log + admin banner) when unset, as today.
- **Templates** (React Email or simple HTML): workspace **invitation** (accept link →
  MN-008 flow), **@mention** in a comment, **notification digest** (daily/instant, ties
  to MN-049 inbox), **email verification** + **password reset** (wire better-auth's mail
  hooks to Resend).
- **Deliverability**: send/verify domain (`storyos.dev`) in Resend — SPF, DKIM, DMARC
  DNS records (coordinate with the domain migration, MN-105). Per-user unsubscribe for
  digests; respect notification prefs.
- **Sending discipline**: async (don't block requests), ret/backoff, dedupe, rate-aware.

## Acceptance criteria
- [ ] Inviting someone emails a working accept link; new user lands in the workspace.
- [ ] Mentions + notification digests deliver via Resend, honoring prefs + unsubscribe.
- [ ] Auth verification / reset emails go through Resend.
- [ ] Domain authenticated (SPF/DKIM/DMARC); dev has a no-op driver, no crashes when unset.
