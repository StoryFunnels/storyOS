---
id: MN-105
title: Production on storyos.dev — real host, domains, docs site, MCP endpoint
status: todo
depends_on: [MN-069]
size: L
---

## Why

The current instance runs on the founder's **personal Kamatera box** at
`os.jamescookmedia.com` — fine for a demo, wrong for a product. Move to a proper,
disposable production environment on the **storyos.dev** domain, off personal infra.

## Scope

**Host** — replace the personal VPS with production infra we can hand off / scale.
Candidates (decide in ticket): a dedicated VPS (Hetzner/Kamatera business acct) with
the Docker Compose stack + Caddy, **or** a managed platform (Fly.io / Render / Railway)
for less ops. Recommend: start with a clean VPS we control (keeps the self-host story
honest), managed Postgres if we want backups handled.

**Domains** (Cloudflare DNS):
- `storyos.dev` → the app (web + API same-origin via Caddy, MN-068).
- `docs.storyos.dev` → the docs site (MN-108 or a static docs generator from `docs/`).
- `mcp.storyos.dev` → the hosted MCP Streamable-HTTP endpoint (MN-106).
- Email domain records for Resend (MN-103): SPF, DKIM, DMARC on `storyos.dev`.
- Origin TLS: real Let's Encrypt (Caddy) or Cloudflare origin cert — move off "Flexible".

**Migration**: pg_dump from the Kamatera box → restore on the new host (or fresh start
if we'd rather reset); repoint DNS; verify signup/import/entity pages/MCP; decommission
the old box. Update `BETTER_AUTH_URL`, `APP_URL`, `EMAIL_FROM`, integration callback URLs.

**Ops** (fold in MN-069's open criteria): nightly offsite `pg_dump` (R2/B2 via rclone)
with a tested restore, restart policies, and a committed `docs/cloud-runbook.md`.

## Acceptance criteria
- [ ] App live at https://storyos.dev; docs at https://docs.storyos.dev; real TLS.
- [ ] Off the personal Kamatera box; data migrated (or cleanly reset) + old box retired.
- [ ] Nightly offsite backup with a documented, tested restore; runbook committed.
- [ ] Resend domain authenticated; MCP endpoint reachable at mcp.storyos.dev (MN-106).
