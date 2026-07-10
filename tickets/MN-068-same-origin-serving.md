---
id: MN-068
title: Same-origin serving — Caddy in front, one hostname for web + API
status: done
depends_on: []
size: S
---

Cloud deploys need ONE hostname (os.jamescookmedia.com now, app.storyos.dev later). Today web (:3000) and API (:3001) are separate origins: two DNS records, CORS in play, and `NEXT_PUBLIC_API_URL` baked into the web bundle at build time means any API URL change forces a rebuild. Same-origin serving kills all three problems and is a prerequisite for hostname-based tenant routing later.

## Design
- `caddy` service in docker-compose.yml, sole published ports (80/443). Caddyfile: `/api/*` → api:3001, everything else → web:3000.
- Web image builds with `NEXT_PUBLIC_API_URL=""` by default → all `${API_URL}/api/...` call sites become relative, same-origin. Dev (`pnpm dev`) keeps the absolute localhost default.
- Fastify `trustProxy: true` so the API honors X-Forwarded-Proto/-For behind Caddy/Cloudflare (secure cookies, correct request logs).
- api/web containers stop publishing host ports (internal only). TLS terminates at Cloudflare (proxied DNS, SSL mode Flexible) or later at Caddy directly.

## Acceptance criteria
- [x] `docker compose up -d` serves the full app on port 80 — web pages and `/api/v1/*` on one origin
- [x] Web bundle contains no absolute API origin; avatar/attachment/import fetches work relative
- [x] docs/self-hosting.md updated (app at http://localhost, proxy notes, Cloudflare SSL mode)
