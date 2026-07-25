---
title: Backup & upgrade
description: Back up, restore, and upgrade a self-hosted StoryOS instance — a tested Postgres + attachments recovery procedure.
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

## Backup & restore

StoryOS persists two things — the **Postgres database** and the **attachments**
(the `storyos_attachments` volume, or your S3 bucket). They must be backed up and
restored **as a matched pair**: an attachment row in the database points at its
file by key, so a database from Monday with files from Tuesday is a corrupt
instance. The bundled scripts bind both halves to one timestamped **recovery
point**.

### Back up

```bash
./scripts/backup-restore/backup.sh                 # label = UTC timestamp
./scripts/backup-restore/backup.sh nightly-2026-07-25   # or an explicit label
```

This writes `backups/<label>/` containing `db.dump` (`pg_dump -Fc`),
`attachments.tgz`, a `counts.tsv` row-count baseline, and a `manifest.env` with
checksums. No secrets are written — the database password stays inside the
postgres container.

:::note
With the [S3/MinIO driver](/self-hosting/attachments/) your object store holds the
attachments — snapshot the bucket under the **same label** with your provider's
tooling; the database dump pairs to that label.
:::

### Restore (rehearse into an isolated clone)

Restore never touches the live stack — it spins up a separate Compose project
with its own volumes, rebuilds the database there, and runs the integrity checks:

```bash
./scripts/backup-restore/restore.sh backups/<label>            # tears the clone down after
./scripts/backup-restore/restore.sh backups/<label> --keep     # leave it up to inspect
```

Rehearsing restores on a schedule is the point: an untested backup is a guess.

### Restore into production (after a real loss)

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U storyos -d storyos --clean --if-exists --no-owner < backups/<label>/db.dump
docker run --rm -v storyos_storyos_attachments:/data -v "$PWD/backups/<label>":/in:ro \
  alpine sh -c 'cd /data && tar xzf /in/attachments.tgz'
docker compose up -d      # api reconciles the schema on boot (migrations are idempotent)
./scripts/backup-restore/verify-restore.sh storyos backups/<label>
```

### Integrity checks

Every restore asserts: **auth loads** (users/sessions present), **row counts
match** the source, **relations resolve** (no dangling links), and **attachments
are present and openable**. These run automatically inside `restore.sh` and can
be run any time with `verify-restore.sh <project> backups/<label>`. The exact
dump → restore → check path is exercised in CI, so the documented commands can't
silently rot.

### Guidance & larger deployments

Encrypt each `backups/<label>/` before it leaves the host, keep off-host copies
(3-2-1), and alert both when a backup is overdue and when a scheduled restore
rehearsal fails. Deployments needing point-in-time recovery should run Postgres
with continuous WAL archiving (PITR) alongside these dumps.
