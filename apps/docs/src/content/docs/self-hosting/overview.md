---
title: Self-hosting overview
description: Run the whole StoryOS product on your own machine — one Postgres, two containers, one command. Free forever.
sidebar:
  order: 1
---

The whole product, on your machine, free forever. One Postgres, two containers, one command.

## Requirements

- Docker with Compose v2
- 1 GB RAM / 1 vCPU is plenty for a small team
- (Optional) a domain + reverse proxy with TLS for real deployments

## Quickstart

```bash
git clone https://github.com/StoryFunnels/storyOS.git storyos && cd storyos
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open **http://localhost** and sign up — the first account creates its own workspace. Migrations
run automatically when the API boots.

## What's in the box

`docker compose up -d` starts:

- **postgres** — PostgreSQL 16, the only datastore.
- **api** — the REST API (NestJS/Fastify); runs migrations on boot.
- **web** — the Next.js web app.
- **caddy** — a reverse proxy that serves everything on **one origin** (port 80): the web app at
  `/` and the API at `/api/*`.
- **mcp** *(optional)* — the [hosted MCP endpoint](/mcp/hosted/); route a subdomain to it.
- **minio** *(optional, `--profile minio`)* — S3-compatible [attachment storage](/self-hosting/attachments/).

## Going to production

For a real deployment, set `API_URL` and `WEB_URL` in `.env` to your public URL (e.g.
`https://os.example.com` for both). Auth validates request origins against `WEB_URL`, so a mismatch
shows "Invalid origin" at login.

**TLS** — two common options:

- Put the domain behind Cloudflare (proxied, SSL mode Flexible), or
- Edit `docker/Caddyfile` to use your domain name and let Caddy issue certificates itself (needs
  ports 80 + 443 reachable).

:::note[Web build note]
The web bundle calls the API with same-origin relative URLs by default — no rebuild needed when
your domain changes. Only split-origin setups (API on a different host) need
`NEXT_PUBLIC_API_URL=https://api.example.com` set at build time.
:::

## Next steps

- [Configuration](/self-hosting/configuration/) — the full environment matrix.
- [Attachments](/self-hosting/attachments/) — local disk vs S3/MinIO.
- [Backup & upgrade](/self-hosting/backup-upgrade/).
