---
title: Backup & upgrade
description: Back up and upgrade a self-hosted StoryOS instance — Postgres dump plus the attachments volume.
sidebar:
  order: 4
---

## Upgrade

```bash
git pull
docker compose build && docker compose up -d   # migrations run on api boot, idempotently
```

Database migrations run automatically when the API container boots, and are idempotent — pulling
and bringing the stack back up is the whole upgrade.

## Backup

Everything lives in two places: the Postgres database and the attachments volume.

```bash
# all data
docker compose exec postgres pg_dump -U storyos storyos > backup.sql

# attachments (local-disk driver)
docker run --rm \
  -v storyos_storyos_attachments:/data \
  -v "$PWD":/out \
  alpine tar czf /out/attachments.tgz /data
```

:::note
If you use the [S3/MinIO driver](/self-hosting/attachments/), your object store holds the
attachments — back that up with your provider's tooling instead of the volume tarball.
:::

## Restore

Restore the database dump into a fresh Postgres, then restore the attachments volume (or your
object store), and bring the stack up. Because migrations are idempotent, an upgraded image will
reconcile the schema on boot.
