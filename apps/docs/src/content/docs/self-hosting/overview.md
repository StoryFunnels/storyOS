---
title: Self-hosting overview
description: Run the whole StoryOS product on your own machine — one Postgres, two containers, one command. Free forever.
sidebar:
  order: 1
---

The whole product, on your machine, free forever. One Postgres, two containers, one command.

## Requirements

- Docker with Compose v2
- **Memory:** we have not measured a minimum for running StoryOS, so there is no "1 GB is enough" promise. The reference deployment has 4 GB. **Building** the images on the host needs more memory than running them: on a small host, build one at a time (`docker compose build api && docker compose build web && docker compose build mcp`) before `docker compose up -d`.
- (Optional) a domain + reverse proxy with TLS for real deployments

## Quickstart

```bash
git clone https://github.com/StoryFunnels/storyOS.git storyos && cd storyos
cp .env.example .env
# one-time: generate the two secrets the stack requires (keep this file; back it up)
printf 'BETTER_AUTH_SECRET=%s\nCONNECTIONS_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
docker compose up -d
```

:::note[The first run builds from source]
`docker compose up -d` builds three images (api, web, mcp) from the repository on first run. Expect
15 to 20 minutes on a laptop-class machine; later starts take seconds, and an upgrade rebuilds only
what changed. The build is the slow step, not a hang: follow it with `docker compose logs -f`. The
product needs only `api` and `web`: `docker compose up -d caddy` builds and starts just postgres,
api, web and the proxy, and skips the MCP image.
:::

Open **http://localhost** and sign up. Sign-up signs you straight in and leads to a **Create your
workspace** step: name it, then either install the Business Pack or choose **Start empty**. That
step is where the workspace is made; sign-up only creates your account. Migrations run
automatically when the API boots.

No mail provider is needed to get started. With no `RESEND_API_KEY` and no `SMTP_HOST`, the API logs
each email instead of sending it, and an unverified address blocks nothing. To read a verification
link, run `docker compose logs api | grep "Email delivery not configured"`.

`.env.example` already points `API_URL` and `WEB_URL` at `http://localhost`, the origin the bundled
proxy serves on port 80, so no URL edits are needed for a local try-out. The generate step sets two
secrets, appended after the blank placeholders (the last value wins). If `docker compose up` stops
with `CONNECTIONS_MASTER_KEY` (or `BETTER_AUTH_SECRET`) "is missing a value", you skipped it. Keep
`CONNECTIONS_MASTER_KEY`: it encrypts every saved Connections credential, so losing or changing it
makes them unreadable.

## What's in the box

`docker compose up -d` starts:

- **postgres** — PostgreSQL 16, the only datastore.
- **api** — the REST API (NestJS/Fastify); runs migrations on boot.
- **web** — the Next.js web app.
- **caddy** — a reverse proxy that serves everything on **one origin** (port 80): the web app at
  `/` and the API at `/api/*`.
- **mcp** — the [hosted MCP endpoint](/mcp/hosted/). `docker compose up -d` builds and starts it, but
  nothing needs it until you route a subdomain to it for cloud AI clients; to leave it out, run
  `docker compose up -d caddy` instead.
- **minio** *(optional, `--profile minio`)* — S3-compatible [attachment storage](/self-hosting/attachments/).

## Going to production

For a real deployment, set `API_URL` and `WEB_URL` in `.env` to your public URL (e.g.
`https://os.example.com` for both). Auth validates request origins against `WEB_URL`, so a mismatch
shows "Invalid origin" at login. The same happens locally if you change `HTTP_PORT`: set both
to `http://localhost:<port>`.

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
