---
id: MN-007
title: Google OAuth (env-gated)
status: todo
depends_on: [MN-006]
size: S
---

Google provider via better-auth. Account linking by verified email. Env-gated: self-hosted instances without Google credentials expose no trace of the provider (API reports enabled providers so the web login page renders accordingly).

## Acceptance criteria

- [ ] Google login creates a new user or links to an existing user with the same verified email
- [ ] `GET /auth/providers` (or equivalent) lists enabled providers; missing env vars cleanly disable Google
- [ ] Documented in docs (self-hosting env matrix entry: `GOOGLE_CLIENT_ID/SECRET` optional)
- [ ] Integration test for the enabled/disabled switch (OAuth dance itself mocked)
