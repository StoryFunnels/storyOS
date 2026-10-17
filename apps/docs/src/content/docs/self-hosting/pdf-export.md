---
title: PDF export (optional)
description: Turn on server-side PDF export for documents. It needs one extra container, is off until you enable it, and has no internet access by design.
sidebar:
  order: 4
---

Exporting a document as a PDF is rendered by a separate container — a headless Chromium
([Gotenberg](https://gotenberg.dev)) — that StoryOS talks to over the internal Docker network. It is
**off by default**. Until you turn it on, nothing extra is downloaded or started, and PDF export
simply reports that it is unavailable. That is the normal state, not a fault.

## Turn it on

```bash
# 1. Tell the API where the renderer will be — in .env next to docker-compose.yml:
PDF_RENDERER_URL=http://gotenberg:3000

# 2. Start the renderer (this pulls the image on first use) and recreate the API:
docker compose --profile pdf up -d
```

To turn it off again, remove `PDF_RENDERER_URL` from `.env` and run `docker compose up -d` (with no
profile). You can check what the API currently sees at any time: a signed-in client reads
`GET /api/v1/capabilities`, whose `pdf_export.available` is `true` only when the renderer is
configured **and** answered its health check recently.

## What it costs

| | |
|---|---|
| **Disk** | The image is pulled, never built on your server. The registry reports about **705 MB to download** (compressed, amd64); it is larger once unpacked. |
| **Memory** | Capped at **1 GB** (`mem_limit`). Renders run **one at a time**, so a burst queues rather than multiplying memory. Gotenberg's documentation says it starts Chromium on the first export rather than at boot; we have not measured idle or peak memory yet, so treat the 1 GB cap as the only number you can rely on. |
| **When it's off** | Nothing. No image, no container, no memory. |

On a small host (the reference deployment is 4 GB), leave it off unless you need PDF export, and
expect an export of a long document to take noticeably longer than a short one.

## It deliberately cannot reach the internet

The renderer sits on its own Docker network marked `internal: true`, which has no route out, and it
publishes no ports. StoryOS sends it one self-contained HTML file with every image already embedded,
so the browser has nothing to fetch. This is on purpose: your documents are rendered inside your own
infrastructure and never leave it, and a renderer that could also reach the internet would quietly
give that up.

Two consequences worth knowing:

- **An image that StoryOS can't embed** (for example a link to an external site, or a file from
  another workspace) is not fetched. It shows as a visible `[Image not included]` placeholder in the
  PDF, and the response carries an `x-storyos-export-skipped-images` header with the count.
- **Don't "fix" a missing image by giving the container network access.** Fix the document instead.

## Relevant variables

| Variable | Default | Notes |
|---|---|---|
| `PDF_RENDERER_URL` | unset | Base URL of the renderer. Unset or empty means PDF export is unavailable. |
| `GOTENBERG_API_TIMEOUT` | `25s` | The renderer's own deadline. Keep it **below** the API's render timeout (`PDF_RENDER_TIMEOUT_MS`, 30 s by default): if the API gave up first, the abandoned render would keep the renderer's single slot busy. |
| `PDF_RENDER_TIMEOUT_MS` | `30000` | The API's own deadline for one render. **The stock compose file does not pass this through**, so you can only change it with an override file (below). Likewise `PDF_RENDER_MAX_PENDING` (renders accepted at once, default `4`). |

The two API settings are not passed through on purpose: an empty value would be read as `0` and the API
would refuse to start. To raise them — for example for very long documents — add a compose override and
raise `GOTENBERG_API_TIMEOUT` with it, keeping the renderer's timeout below the API's:

```yaml
# docker-compose.override.yml  (Compose reads this automatically unless COMPOSE_FILE is set;
# if you set COMPOSE_FILE, add this file to it)
services:
  api:
    environment:
      PDF_RENDER_TIMEOUT_MS: '90000'
      PDF_RENDER_MAX_PENDING: '4'
```

```bash
# in .env — still below the API's 90 s
GOTENBERG_API_TIMEOUT=80s
```

A document too large to render is refused with `413` and a body that names the limit and the
document's measured size.

## Local development

In development the API runs on your machine, which can't reach a container on an internal-only
network, so the dev compose file publishes the renderer on `127.0.0.1:3010` instead:

```bash
docker compose -f docker-compose.dev.yml --profile pdf up -d
PDF_RENDERER_URL=http://127.0.0.1:3010 pnpm --filter @storyos/api dev
```

That arrangement is for a laptop only — never copy it into a deployed file.
