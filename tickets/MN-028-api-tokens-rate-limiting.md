---
id: MN-028
title: API tokens (PATs) + rate limiting
status: todo
depends_on: [MN-008]
size: M
---

`api_tokens` table (`mn_pat_` prefix, SHA-256 hash, workspace-scoped, acts as creator — role and guest scoping inherited). Create (plaintext shown once) / list (prefix + last 4) / revoke endpoints + settings UI page. Extend the unified `AuthGuard` to resolve PAT bearers. `last_used_at` tracking. `@nestjs/throttler` keyed per token/session (default 300 req/min, env-configurable) → 429 + Retry-After. Ship `docs/api/guides/authentication.md` and `docs/api/guides/build-an-mcp-server.md` with curl examples.

## Acceptance criteria

- [ ] A PAT can drive every endpoint its creator's role allows; a guest's PAT is space-scoped identically
- [ ] Revocation is immediate (next request 401s); plaintext never retrievable after creation
- [ ] `last_used_at` updates (throttled to ~1/min writes)
- [ ] Burst over the limit → 429 with Retry-After; limits env-configurable
- [ ] Both guides published with working curl examples against a local instance
