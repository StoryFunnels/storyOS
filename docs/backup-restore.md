# Backup & restore (self-host)

A backup you have never restored is a guess. This page documents a **tested**
procedure for the official Compose stack: timestamped backups of both halves of
your state, a restore you rehearse into an isolated clone, and integrity checks
that prove the result is trustworthy. The commands here are exercised in CI
(see [Drift detection](#drift-detection)), so they cannot silently rot.

Everything StoryOS persists lives in exactly two places:

| What | Where (default `local` driver) | Where (`s3` driver) |
|---|---|---|
| Database — records, users, sessions, relations, automations, everything | Postgres, `storyos_pg` volume | same |
| Attachments — uploaded files & image thumbnails | `storyos_attachments` volume | your S3/MinIO bucket |

The two must be captured and restored **as a matched pair**: an attachment row
in the database points at a file by `storage_key`, so a database from Monday with
files from Tuesday is a corrupt instance. The scripts below bind both halves to a
single **recovery-point label**.

## Prerequisites

- The stack is running (`docker compose ps` shows `postgres` healthy).
- Run every command from the repo root of your StoryOS checkout.
- The scripts assume the default Compose project name `storyos`. If you set
  `COMPOSE_PROJECT_NAME`, export it — the scripts read it.

## Backup

```bash
./scripts/backup-restore/backup.sh                 # label = UTC timestamp
./scripts/backup-restore/backup.sh nightly-2026-07-25   # or an explicit label
```

This writes a self-describing recovery point to `backups/<label>/`:

| File | What |
|---|---|
| `db.dump` | `pg_dump -Fc` of the database (compressed, restore-ready) |
| `attachments.tgz` | tar of the `storyos_attachments` volume (empty note if `STORAGE_DRIVER=s3`) |
| `counts.tsv` | per-table row counts captured at dump time — the parity baseline |
| `manifest.env` | label, timestamp, git commit, storage driver, SHA-256 of both archives |

No secrets are written — the database password never leaves the postgres
container, and only data rows are dumped (rule: secrets live in `.env` only).

**S3 / MinIO attachments.** With `STORAGE_DRIVER=s3` your object store holds the
files, so `backup.sh` records an empty archive and reminds you to snapshot the
bucket under the **same label** (`mc mirror`, versioning, or your provider's
backup). The database dump still pairs to that label.

## Restore (rehearsal into an isolated clone)

Restore **never** touches your live stack. `restore.sh` brings up a second
Compose project with its own namespaced volumes, rebuilds the database there, and
runs the integrity checks — so you can prove a backup is good on a live box
without risk:

```bash
./scripts/backup-restore/restore.sh backups/<label>
# leave the clone up to poke around in it:
./scripts/backup-restore/restore.sh backups/<label> --keep --project storyos_restore
```

It refuses to restore into the live project name unless you pass `--force`, so a
rehearsal can't clobber production. By default the clone and its volumes are torn
down when the script exits; `--keep` leaves them running.

### Real recovery (restoring into production)

A rehearsal proves the backup; real recovery is the same dump applied to your
live stack after a loss. On a clean host:

```bash
docker compose up -d postgres
# rebuild the database from the dump:
docker compose exec -T postgres pg_restore -U storyos -d storyos --clean --if-exists --no-owner < backups/<label>/db.dump
# restore attachments (local driver):
docker run --rm -v storyos_storyos_attachments:/data -v "$PWD/backups/<label>":/in:ro \
  alpine sh -c 'cd /data && tar xzf /in/attachments.tgz'
docker compose up -d      # api reconciles the schema on boot (migrations are idempotent)
```

Then run the integrity check against the live project to confirm:

```bash
./scripts/backup-restore/verify-restore.sh storyos backups/<label>
```

## Integrity checks

After any restore the procedure asserts four things, and fails loudly if any
does not hold:

1. **Auth loads** — at least one user exists and the `session` table is readable
   (a restore that dropped auth would lock everyone out).
2. **Row counts match** the source — every key table (`user`, `session`,
   `workspaces`, `databases`, `records`, `relations`, `record_links`,
   `attachments`, `workspace_files`) equals the `counts.tsv` baseline.
3. **Relations resolve** — no `record_links` row references a missing relation or
   record; every record belongs to a real database.
4. **Attachments are present & openable** — every attachment `storage_key` has a
   real file in the restored volume (local driver).

Checks 1, 3, and part of 4 live in `scripts/backup-restore/integrity-checks.sql`
— one file, run by both `verify-restore.sh` and the CI drift test. Run them any
time against a running project:

```bash
./scripts/backup-restore/verify-restore.sh <project> backups/<label>
```

## Operational guidance

- **Encryption at rest.** `backups/<label>/` is your data in the clear. Encrypt
  it before it leaves the host — e.g. `age -r <recipient> -o backup.age` on the
  tarball, or write to an encrypted volume. Keep the recipient key off the box.
- **Off-host copies (3-2-1).** A backup on the same disk as the database dies
  with it. Copy each recovery point to at least one other location (object
  storage, a second host); keep several generations.
- **Monitoring.** Alert if the newest recovery point is older than your RPO
  (e.g. "no backup in 26h"), on any non-zero `backup.sh` exit, and — most
  importantly — schedule `restore.sh` on a cadence and alert if the rehearsal
  fails. A backup job that succeeds while restores fail is the trap this
  procedure exists to close.
- **Scheduling.** Drive `backup.sh` from cron/systemd on the host. Rotate old
  `backups/*` directories to fit your retention window.

## Larger deployments: Postgres PITR

The dump-and-restore flow here has an RPO of "your last backup". Deployments that
need point-in-time recovery (restore to any second, minimal data loss) should run
Postgres with **continuous archiving / WAL-based PITR** (`pg_basebackup` +
archived WAL, or a managed Postgres with PITR) instead of, or alongside, these
dumps. The attachment-pairing and integrity-check discipline on this page still
applies — pair your base backup + WAL position with the attachment snapshot, and
verify the restore.

## Drift detection

The exact `pg_dump -Fc` → `pg_restore` → `integrity-checks.sql` path is exercised
on every CI run by `apps/api/test/backup-restore.test.ts`: it stands up a real
`postgres:16-alpine`, migrates it, seeds a workspace (users, sessions, records, a
relation with a link, an attachment), performs the real dump and restore into a
separate database with the container's own client binaries, and runs the shipped
integrity SQL — asserting row-count parity, that the checks pass, and that they
**fail** when auth data is missing. If the schema moves under the checks, CI goes
red before an operator ever hits it.

What CI does **not** spin up is the full multi-container Compose stack (api / web
/ caddy) or the attachment-volume tar; those steps are documented and the shell
scripts are their executable specification.

## See also

- [self-hosting.md](self-hosting.md) — full self-host guide and environment matrix.
- [self-hosting-integrations.md](self-hosting-integrations.md) — which integrations work self-managed.
