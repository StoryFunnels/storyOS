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
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | unset | invites/mentions/resets email; without SMTP, invite links are copyable in the UI and other emails are logged. Any SMTP provider works (e.g. Resend: `smtp.resend.com`, user `resend`, pass `re_…`) |
| `GOOGLE_CLIENT_ID/SECRET` | unset | enables "Continue with Google". Redirect URI: `{API_URL}/api/v1/auth/callback/google` |
| `STORAGE_DRIVER` | `local` | `s3` for MinIO/S3/R2 |
| `S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY` | MinIO defaults | with `--profile minio` the bundled MinIO works out of the box (create the bucket once via the console at :9001) |
| `ATTACHMENT_MAX_BYTES` | 20971520 (20 MB) | per-file upload cap |
| `RATE_LIMIT_PER_MINUTE` | 300 | per token/session |
| `STRIPE_SECRET_KEY` | unset | enables paid billing (MN-165). **Unset = billing off**: every workspace is Free and self-host needs none of it. Use a `sk_live_…` key only in production. |
| `STRIPE_WEBHOOK_SECRET` | unset | `whsec_…` from your Stripe webhook endpoint (`{API_URL}/api/v1/billing/webhook`). Required for plan changes to sync back. |
| `STRIPE_PRICE_PRO/BUSINESS/SEAT` | unset | price ids from `pnpm --filter @storyos/api billing:seed` (run once per Stripe account/mode) |
| `STRIPE_TAX_ENABLED` | `false` | `true` to calculate/collect VAT/sales tax via Stripe Tax (paid add-on; must be activated in the dashboard) |

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

## The API

Your instance serves its own docs at `{API_URL}/api/docs` and the raw spec at `{API_URL}/api/v1/openapi.json`. Create personal access tokens in the app under **API tokens** — see [api/guides/authentication.md](api/guides/authentication.md).
