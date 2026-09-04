---
title: Configuration
description: The full StoryOS environment matrix — auth, URLs, email, Google OAuth, storage, and rate limits.
sidebar:
  order: 2
---

StoryOS is configured with environment variables in a `.env` file next to `docker-compose.yml`
(Compose reads it automatically). Only `BETTER_AUTH_SECRET` is required.

:::caution
Never commit your real `.env` — it holds secrets. The repo ships an `.env.example` to copy from.
:::

## Environment matrix

| Variable                                                           | Default                           | Notes                                                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                               | — (required)                      | Generate with `openssl rand -hex 32`.                                                                                                                                                                |
| `POSTGRES_PASSWORD`                                                | `storyos`                         | Change for anything internet-facing.                                                                                                                                                                 |
| `API_URL` / `WEB_URL`                                              | `http://localhost:3001` / `:3000` | Set **both** to your public URL (same origin), e.g. `https://os.example.com`. `WEB_URL` is also passed to the `mcp` service — it's the origin used to build the `url` field on MCP record responses. |
| `NEXT_PUBLIC_API_URL`                                              | empty (same-origin)               | Only for split-origin setups (API on a different host). Set at build time.                                                                                                                           |
| `HTTP_PORT` / `HTTPS_PORT`                                         | `80` / `443`                      | Host ports of the Caddy proxy.                                                                                                                                                                       |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`, `MAIL_FROM` | unset                             | Invites, mentions, verification, and resets. Without SMTP, invite links are copyable in the UI and other emails are logged. Any SMTP provider works.                                                 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`                        | unset                             | Enables "Continue with Google". Redirect URI: `{API_URL}/api/v1/auth/callback/google`.                                                                                                               |
| `STORAGE_DRIVER`                                                   | `local`                           | `s3` for MinIO/S3/R2 — see [attachments](/self-hosting/attachments/).                                                                                                                                |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY`    | MinIO defaults                    | Used when `STORAGE_DRIVER=s3`.                                                                                                                                                                       |
| `ATTACHMENT_MAX_BYTES`                                             | `20971520` (20 MB)                | Per-file upload cap.                                                                                                                                                                                 |
| `RATE_LIMIT_PER_MINUTE`                                            | `300`                             | Per token/session.                                                                                                                                                                                   |

## Integrations: what's available self-hosted

One codebase, no crippled edition — but a handful of integrations genuinely can't work the same
way on your own instance as on StoryOS Cloud, and the Connections/Integrations gallery says so
plainly rather than showing a Connect button that fails. Every provider falls into one of three
tiers:

| Tier | Examples | Self-hosted |
|---|---|---|
| **API key / token** | Apify, Resend, SMTP, a generic HTTP connection, bring-your-own-AI over MCP | Works identically everywhere — nothing StoryOS-specific to configure. |
| **OAuth, needs a verified app** | Google (YouTube, Calendar) | Cloud uses StoryOS's own verified OAuth app. Self-hosted: bring your **own** OAuth app via `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (or the matching env pair for other providers) — an operator, one-time setup, never a per-user prompt. Unconfigured, the gallery shows **"you can turn this on"**, not a broken button. |
| **Cloud-hosted only** | Managed StoryOS AI, the hosted MCP OAuth connector | Genuinely cloud-only — nothing to configure, because the thing being offered (StoryOS's own infrastructure) doesn't exist on your instance by definition. |

The reason for the middle tier: an OAuth app's redirect URI and platform verification are tied to
one domain. StoryOS's own verified Google app is scoped to `app.storyos.dev` — it can't also work
for your instance, so a self-hosted deployment needing that provider registers its own app instead
of asking every end user to.

## Auth

StoryOS uses [better-auth](https://better-auth.com) mounted inside the API for email/password
(with verification and reset) plus **env-gated Google OAuth** — instances without Google
credentials simply hide the button. Sessions are database-backed for instant revocation. Personal
access tokens (`mn_pat_…`) are a separate, workspace-scoped credential; see
[authentication](/api/authentication/).

### Email (SMTP)

Email is optional. When `SMTP_HOST` is unset, invite links are copyable in the UI and other
emails are logged rather than sent. Any SMTP provider works — for example Resend:

```bash
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_your_resend_api_key_here
MAIL_FROM=StoryOS <noreply@your-domain.com>
```

### Google sign-in

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and register the redirect URI
`{API_URL}/api/v1/auth/callback/google` in the Google console. Accounts link by verified email.

## MCP OAuth (optional)

To let cloud clients connect the [hosted MCP endpoint](/mcp/hosted/) with a one-click
[OAuth connector](/mcp/oauth/) instead of pasting a token, enable the OAuth authorization server:

| Variable          | Where         | Notes                                                                                   |
| ----------------- | ------------- | --------------------------------------------------------------------------------------- |
| `MCP_OAUTH`       | `api` + `mcp` | Set `true` to turn on OAuth discovery (needs the OIDC tables migrated). Off by default. |
| `MCP_PUBLIC_URL`  | `mcp`         | Public URL of the MCP endpoint, e.g. `https://mcp.your-domain.com`.                     |
| `MCP_AUTH_SERVER` | `mcp`         | Better Auth's mounted base URL, e.g. `https://app.your-domain.com/api/v1/auth`.         |

## The API on your instance

Your instance serves its own interactive docs at `{API_URL}/api/docs` and the raw spec at
`{API_URL}/api/v1/openapi.json`. Create personal access tokens in the app under **API tokens** —
see [authentication](/api/authentication/).
