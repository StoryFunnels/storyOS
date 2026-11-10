---
title: Attachments (S3/MinIO)
description: Store StoryOS attachments on local disk or any S3-compatible object store.
sidebar:
  order: 3
---

StoryOS stores file attachments with one of two drivers, chosen by `STORAGE_DRIVER`.

## Local disk (default)

The default (`local`) keeps files in the `storyos_attachments` Docker volume. It's simpler and
fine for most teams — nothing to configure. Back it up alongside your database (see
[backup & upgrade](/self-hosting/backup-upgrade/)).

## S3-compatible (MinIO, S3, R2)

For object storage, set `STORAGE_DRIVER=s3` and point the `S3_*` variables at your bucket. The
bundled MinIO service runs behind a Compose profile. Set your own `S3_ACCESS_KEY` and
`S3_SECRET_KEY` in `.env` first: there are no defaults, and both the MinIO container and the API
refuse to start with empty values or the old built-in `storyos` / `storyos-minio` pair.

```bash
docker compose --profile minio up -d
# once: open http://localhost:9001 and sign in with your S3_ACCESS_KEY / S3_SECRET_KEY.
# Only the console is published, on the server's loopback; the S3 API (9000) is not published
# at all. From your laptop: ssh -L 9001:127.0.0.1:9001 you@server
#       → create the bucket "storyos-attachments"
# then set STORAGE_DRIVER=s3 in .env and restart the api
docker compose up -d api
```

Relevant variables (see the full [configuration matrix](/self-hosting/configuration/)):

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `local` | Set to `s3` to use object storage. |
| `S3_ENDPOINT` | `http://minio:9000` | Endpoint of your S3-compatible store. |
| `S3_BUCKET` | `storyos-attachments` | Create it once before switching the driver. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | none (required) | Credentials for the bucket. Required with `STORAGE_DRIVER=s3`; the API refuses to boot without them or with the old `storyos` / `storyos-minio`. |

| `ATTACHMENT_MAX_BYTES` | `20971520` (20 MB) | Per-file upload cap. |

**Upgrading from the old defaults:** set new credentials in `.env`. We have not verified what MinIO
does when its root credentials change on an existing data volume (`storyos_minio`): check the MinIO
documentation for your version and test on a copy before rotating. Treat anything stored while the
old defaults were in use as potentially exposed.

Any S3-compatible provider works — AWS S3, Cloudflare R2, Backblaze B2, or your own MinIO. Point
`S3_ENDPOINT` at the provider and supply matching credentials.
