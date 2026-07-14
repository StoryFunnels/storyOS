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
bundled MinIO service works out of the box behind a Compose profile:

```bash
docker compose --profile minio up -d
# once: open http://localhost:9001 (storyos / storyos-minio)
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
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | MinIO defaults | Credentials for the bucket. |
| `ATTACHMENT_MAX_BYTES` | `20971520` (20 MB) | Per-file upload cap. |

Any S3-compatible provider works — AWS S3, Cloudflare R2, Backblaze B2, or your own MinIO. Point
`S3_ENDPOINT` at the provider and supply matching credentials.
