---
id: MN-006
title: Auth — better-auth email/password + sessions
status: done
depends_on: [MN-005]
size: M
---

Mount better-auth inside the Nest API (Drizzle adapter → `users`/`sessions`/`accounts`/`verifications` tables). Email/password signup with verification, login/logout, password reset, DB-backed cookie sessions + bearer session tokens. `AuthGuard` (session side; PAT side joins in MN-028) and `GET /me`. See [docs/architecture/auth.md](../docs/architecture/auth.md). Email verification/reset degrade to logged links when SMTP is absent.

## Acceptance criteria

- [ ] Signup → verify → login → `GET /me` works via curl (bearer session token) and browser (cookie)
- [ ] Unauthenticated request to a protected route → 401 envelope
- [ ] Logout revokes the session in Postgres immediately (subsequent request 401s)
- [ ] Password reset flow works end-to-end; without SMTP the link is logged, not silently dropped
- [ ] Integration tests cover the full happy path + wrong-password + revoked-session cases
