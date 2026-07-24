# Self-hosting StoryOS

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

Open http://localhost and sign up — the first account creates its own workspace. Migrations run automatically when the API boots.

The bundled Caddy proxy serves everything on **one origin** (port 80): the web app at `/` and the API at `/api/*`. For a real deployment, set `API_URL` and `WEB_URL` in `.env` to your public URL (e.g. `https://os.example.com` for both) — auth validates request origins against `WEB_URL`, so a mismatch shows "Invalid origin" at login. TLS: put the domain behind Cloudflare (proxied, SSL mode Flexible) or edit `docker/Caddyfile` to use your domain name and let Caddy issue certificates itself (needs ports 80+443 reachable).

## Environment matrix

Set in `.env` next to `docker-compose.yml`. Only `BETTER_AUTH_SECRET` is required.

| Variable | Default | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | — (required) | `openssl rand -hex 32`. The API **refuses to boot in production** if this is unset or left at a default — sessions are signed with it, so a public value means anyone can forge a login. |
| `POSTGRES_PASSWORD` | `storyos` | change for anything internet-facing |
| `API_URL` / `WEB_URL` | `http://localhost:3001` / `:3000` | set BOTH to your public URL (same origin), e.g. `https://os.example.com` |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | host ports of the caddy proxy |
| `RESEND_API_KEY`, `MAIL_FROM` | unset | invites/mentions/notifications/auth verify+reset email via Resend's HTTP API (MN-103) — the preferred path. Without it (and without `SMTP_HOST` below), invite links are copyable in the UI and other emails are logged instead of sent. |
| `SMTP_HOST/PORT/USER/PASS` | unset | fallback transport, used only when `RESEND_API_KEY` is unset. Any SMTP provider works (e.g. Resend's own relay: `smtp.resend.com`, user `resend`, pass `re_…`) |
| `GOOGLE_CLIENT_ID/SECRET` | unset | enables "Continue with Google" **and** the Google connection under **Connections** (MN-252) — the same OAuth app covers both. Redirect URIs: `{API_URL}/api/v1/auth/callback/google` (login) and `{API_URL}/api/v1/connections/oauth/callback` (Connections) |
| `CONNECTIONS_MASTER_KEY` | derived from `BETTER_AUTH_SECRET` | `openssl rand -hex 32`. Encrypts every credential in **Connections** (Apify/Resend keys, OAuth tokens) at rest. The API **refuses to boot in production** if this is unset or not a 64-char hex string. Self-host can leave it unset — the derived dev/test key still works, but pin it explicitly once you rely on Connections in production so a `BETTER_AUTH_SECRET` rotation can't also invalidate every saved connection. |
| `STORAGE_DRIVER` | `local` | `s3` for MinIO/S3/R2 |
| `S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY` | MinIO defaults | with `--profile minio` the bundled MinIO works out of the box (create the bucket once via the console at :9001) |
| `ATTACHMENT_MAX_BYTES` | 20971520 (20 MB) | per-file upload cap |
| `RATE_LIMIT_PER_MINUTE` | 300 | per token/session |
| `STRIPE_SECRET_KEY` | unset | enables paid billing (MN-165). **Unset = billing off**: every workspace is Free and self-host needs none of it. Use a `sk_live_…` key only in production. |
| `STRIPE_WEBHOOK_SECRET` | unset | `whsec_…` from your Stripe webhook endpoint (`{API_URL}/api/v1/billing/webhook`). Required for plan changes to sync back. |
| `STRIPE_PRICE_PRO/BUSINESS/SEAT` | unset | price ids from `pnpm --filter @storyos/api billing:seed` (run once per Stripe account/mode) |
| `STRIPE_TAX_ENABLED` | `false` | `true` to calculate/collect VAT/sales tax via Stripe Tax (paid add-on; must be activated in the dashboard) |

## Connections (MN-252)

**Connections** (per-workspace, under **Settings → Connections**) is a registry of external-provider
credentials shared by every automation action and source — Apify and Resend connect with an API key
today; Google connects via OAuth2 reusing `GOOGLE_CLIENT_ID/SECRET` above. Each OAuth2 provider is a
**bring-your-own-app**: register an OAuth app with that provider, then set its client id/secret as env
vars named on the provider's own descriptor (`providers/index.ts` in `apps/api/src/connections`) — no
provider is enabled until its env vars are set, and none of this is required for API-key providers.
Follow-up integrations (LinkedIn, Meta, YouTube) register their own descriptor and document their own
client id/secret vars here when they ship; YouTube is expected to reuse `GOOGLE_CLIENT_ID/SECRET` rather
than add new ones.

## Data protection & GDPR

StoryOS includes admin tooling to export or erase a user's data for GDPR
data-subject requests — see [Data-subject requests](security/data-subject-requests.md).

**Web build note:** the web bundle calls the API with same-origin relative URLs by default — no rebuild needed when your domain changes. Only split-origin setups (API on a different host) need `NEXT_PUBLIC_API_URL=https://api.example.com` set at build time.

## Attachments with MinIO (optional)

```bash
docker compose --profile minio up -d
# once: open http://localhost:9001 (storyos / storyos-minio) → create bucket "storyos-attachments"
# then set STORAGE_DRIVER=s3 in .env and restart the api
```

Default (`local`) storage keeps files in the `storyos_attachments` volume — simpler, fine for most teams.

## Upgrade

```bash
git pull
docker compose build && docker compose up -d   # migrations run on api boot, idempotently
```

## Backup

Everything lives in two places:

```bash
docker compose exec postgres pg_dump -U storyos storyos > backup.sql   # all data
docker run --rm -v storyos_storyos_attachments:/data -v $PWD:/out alpine tar czf /out/attachments.tgz /data
```

Treat those two files as one recovery point: label them with the same UTC
timestamp, encrypt them, copy them off the Docker host, and monitor the scheduled
job. A backup that has never been restored is not yet proven.

For a small Compose installation, test a restore into an isolated clone:

```bash
# In a disposable clone with an empty Postgres volume:
docker compose up -d postgres
cat backup.sql | docker compose exec -T postgres psql -U storyos storyos

# Restore attachments into the clone's attachment volume:
docker run --rm \
  -v storyos_storyos_attachments:/data \
  -v "$PWD":/backup \
  alpine sh -c 'cd / && tar xzf /backup/attachments.tgz'

docker compose up -d api web mcp
docker compose logs --tail=100 api
```

Verify login, workspace/record counts, relations, and at least one attachment
download before trusting the procedure. Run a restore drill after meaningful
version upgrades and on a regular schedule.

For larger or lower-RPO installations, use PostgreSQL continuous WAL archiving
and point-in-time recovery in addition to logical dumps. Keep backup storage in
a separate failure domain and restrict its credentials like production
credentials. See
[ADR-0015](decisions/ADR-0015-data-durability-and-recovery.md) for the recovery
model and restore order.

## The API

Your instance serves its own docs at `{API_URL}/api/docs` and the raw spec at `{API_URL}/api/v1/openapi.json`. Create personal access tokens in the app under **API tokens** — see [api/guides/authentication.md](api/guides/authentication.md).
