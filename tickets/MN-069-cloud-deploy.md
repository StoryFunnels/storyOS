---
id: MN-069
title: Cloud deploy — first shared instance at os.jamescookmedia.com
status: superseded
depends_on: [MN-068]
size: M
---

> **Superseded by [MN-105](MN-105-storyos-dev-prod.md).** This shipped the first live
> instance on the founder's personal Kamatera box (app is up, same-origin via Caddy).
> The remaining hardening (offsite backups, restore drill, runbook) moves to MN-105,
> which relocates production onto real infra under `storyos.dev` and retires the
> personal box. Keep this for history; do new deploy work in MN-105.

First managed-cloud instance (shared, multi-workspace — per-customer instances are the future Enterprise tier). Kamatera VPS (2 vCPU / 4 GB, EU), Cloudflare DNS proxied, Postgres on the same box.

## Design
- Box: Docker via get.docker.com, ufw (SSH/80/443 only), `git clone` + `.env` (BETTER_AUTH_SECRET, API_URL/WEB_URL=https://os.jamescookmedia.com, SMTP via Resend) + `docker compose up -d`.
- DNS: `os.jamescookmedia.com` A → server IP, proxied (TLS at Cloudflare edge, SSL mode Flexible until an origin cert lands).
- Backups: nightly cron — `pg_dump` to Cloudflare R2 (or B2) via rclone; restore script tested once, documented.
- Attachments: switch STORAGE_DRIVER=s3 → R2 when convenient; local volume acceptable at first.
- Upgrade path: `git pull && docker compose up -d --build`.

## Acceptance criteria
- [ ] App live at https://os.jamescookmedia.com — signup, template install, entity pages all work
- [ ] Nightly offsite DB backup with a restore drill performed and documented
- [ ] Deploy/upgrade/backup runbook committed (docs/cloud-runbook.md)
