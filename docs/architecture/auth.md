# Auth & access control

## Identity: better-auth inside Nest

[better-auth](https://better-auth.com) is mounted inside the NestJS API (Drizzle adapter → `users`, `sessions`, `accounts`, `verifications` tables in our Postgres). Provides email/password (+ verification, password reset) and **env-gated Google OAuth** (instances without Google credentials hide the button; account linking by verified email).

**Sessions are DB-backed** (not stateless JWT): instant revocation, one Postgres, no key-rotation ceremony. Cookie for the web app; bearer session tokens also accepted.

## Personal access tokens (PATs)

Deliberately **our own table**, not a better-auth plugin — a ~60-line guard + table we fully control:

- Format `mn_pat_<random>`; stored as SHA-256 hash; `token_prefix` + last 4 shown in listings; plaintext shown exactly once at creation.
- Workspace-scoped; acts as its creator — same role, same guest space scoping.
- `last_used_at` tracked; revocation is immediate (DB lookup per request).

## The unified guard

One Nest `AuthGuard` resolves identity from either (a) better-auth session cookie / bearer session token, or (b) `Authorization: Bearer mn_pat_...` looked up in `api_tokens`. Downstream code never cares which. A second `WorkspaceAccessGuard` resolves membership + role (+ `space_ids` for guests) once per request and attaches it to the request context.

## Role matrix

| Capability | Admin | Member | Guest |
|---|---|---|---|
| Workspace settings, members, invites, tokens | ✅ | — | — |
| Schema: spaces, databases, fields, relations, options | ✅ | ✅ | — |
| Records & views: create/edit/delete | ✅ | ✅ | — |
| Read (guest: only their `space_ids`) | ✅ | ✅ | ✅ |
| Comment | ✅ | ✅ | ✅ |

- Members edit schema in v1 (small-team trust model). "Lock schema to admins" toggle is parked (v2).
- Last admin cannot demote/remove themselves.
- Removed/deactivated users keep historical authorship in comments/activity.

## Guest scoping rules

- Guests hold `memberships.space_ids` (≥1 required at invite).
- Everything outside those spaces returns **404** — not 403 — to avoid leaking existence. Enforced in the API layer, covered by per-endpoint authz integration tests.
- Cross-space relation chips on visible records render **name-only and non-navigable** (small, accepted leak in exchange for coherent UX; revisit if a customer objects).
- Guests are not mentionable in v1.

## Email (MN-103)

`EmailService` (`apps/api/src/mail`) is the single send point for invitations, @mention notifications, and better-auth's own verification/reset hooks. A small render function per email kind (`mail/templates.ts`) sits behind an `EmailInput → {subject, html, text}` contract, so branded HTML (a later, separate ticket) can replace that layer without touching call sites.

Driver selection, in order: `RESEND_API_KEY` (Resend's HTTP API) → `SMTP_HOST` (nodemailer, e.g. Resend's own SMTP relay) → log-only. All optional — with neither configured, invite links stay copyable in the UI and every other email is logged instead of sent, so self-hosting needs no mail provider to work. Sending is fire-and-forget: a delivery failure is caught and logged, never allowed to fail the request that triggered it.

A recipient's existing "Mentions" notification toggle (personal preferences) also gates the mention email — turning it off silences both the in-app notification and the email.
