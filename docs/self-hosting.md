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

Open http://localhost:3000 and sign up — the first account creates its own workspace. Migrations run automatically when the API boots.

## Environment matrix

Set in `.env` next to `docker-compose.yml`. Only `BETTER_AUTH_SECRET` is required.

| Variable | Default | Notes |
|---|---|---|
| `BETTER_AUTH_SECRET` | — (required) | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | `storyos` | change for anything internet-facing |
| `API_URL` / `WEB_URL` | `http://localhost:3001` / `:3000` | set to your public URLs behind a proxy |
| `API_PORT` / `WEB_PORT` | `3001` / `3000` | host ports |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | unset | invites/mentions/resets email; without SMTP, invite links are copyable in the UI and other emails are logged. Any SMTP provider works (e.g. Resend: `smtp.resend.com`, user `resend`, pass `re_…`) |
| `GOOGLE_CLIENT_ID/SECRET` | unset | enables "Continue with Google". Redirect URI: `{API_URL}/api/v1/auth/callback/google` |
| `STORAGE_DRIVER` | `local` | `s3` for MinIO/S3/R2 |
| `S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY` | MinIO defaults | with `--profile minio` the bundled MinIO works out of the box (create the bucket once via the console at :9001) |
| `ATTACHMENT_MAX_BYTES` | 20971520 (20 MB) | per-file upload cap |
| `RATE_LIMIT_PER_MINUTE` | 300 | per token/session |

**Web build caveat:** `NEXT_PUBLIC_API_URL` is baked into the web bundle at build time (a Next.js constraint). If your API isn't at `http://localhost:3001`, set `API_URL` in `.env` **before** `docker compose build`.

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
