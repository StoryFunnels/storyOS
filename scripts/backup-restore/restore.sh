#!/usr/bin/env bash
# StoryOS restore rehearsal (#322).
#
# Restores a recovery point into an ISOLATED Compose clone — a separate project
# name with its own namespaced volumes — so you can prove a backup is good
# WITHOUT touching the live stack. This is the drill every operator should run
# on a schedule; an untested backup is a guess.
#
#   ./scripts/backup-restore/restore.sh backups/<label>
#   ./scripts/backup-restore/restore.sh backups/<label> --project storyos_restore
#
# It brings up postgres under the restore project, rebuilds the database from
# db.dump, unpacks attachments.tgz into the clone's volume, then runs
# verify-restore.sh. Add --keep to leave the clone running for manual poking;
# by default the clone (and its volumes) are torn down on exit.
set -euo pipefail

BACKUP_DIR="${1:?usage: restore.sh <backup-dir> [--project <name>] [--keep] [--force]}"
shift || true
RESTORE_PROJECT="storyos_restore"
LIVE_PROJECT="${COMPOSE_PROJECT_NAME:-storyos}"
KEEP=0
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) RESTORE_PROJECT="${2:?}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    --force)   FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-storyos}"
PG_DB="${PG_DB:-storyos}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ATTACHMENTS_VOLUME="${RESTORE_PROJECT}_storyos_attachments"

log() { printf '\033[1;34m[restore]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[restore] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$BACKUP_DIR/db.dump" ] || die "no db.dump in $BACKUP_DIR"
[ -f "$BACKUP_DIR/manifest.env" ] || die "no manifest.env in $BACKUP_DIR — not a StoryOS recovery point"

# Safety: never let a rehearsal clobber the live stack (#322 requirement).
if [ "$RESTORE_PROJECT" = "$LIVE_PROJECT" ] && [ "$FORCE" -ne 1 ]; then
  die "refusing to restore into the LIVE project '$LIVE_PROJECT'. Use a different --project (default storyos_restore), or --force to override."
fi

dc() { docker compose -p "$RESTORE_PROJECT" "$@"; }

cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    log "clone left running as project '$RESTORE_PROJECT' (--keep). Tear down with: docker compose -p $RESTORE_PROJECT down -v"
  else
    log "tearing down clone '$RESTORE_PROJECT' (and its volumes)"
    dc down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

log "verifying checksums against manifest"
# shellcheck disable=SC1091
. "$BACKUP_DIR/manifest.env"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
[ "$(sha256 "$BACKUP_DIR/db.dump")" = "${DB_DUMP_SHA256:-}" ] || die "db.dump checksum mismatch — backup is corrupt"

log "bringing up isolated postgres (project '$RESTORE_PROJECT')"
dc up -d "$PG_SERVICE"

log "waiting for postgres to be ready"
for _ in $(seq 1 30); do
  if dc exec -T "$PG_SERVICE" pg_isready -U "$PG_USER" >/dev/null 2>&1; then break; fi
  sleep 1
done
dc exec -T "$PG_SERVICE" pg_isready -U "$PG_USER" >/dev/null 2>&1 || die "postgres did not become ready"

log "rebuilding database '$PG_DB' from db.dump"
# --clean --if-exists so a re-run is idempotent; -Fc dump restored with pg_restore.
dc exec -T "$PG_SERVICE" pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner < "$BACKUP_DIR/db.dump" \
  || log "pg_restore reported warnings (often benign for --clean on a fresh DB) — integrity checks are the real gate"

if [ -s "$BACKUP_DIR/attachments.tgz" ] && [ "${STORAGE_DRIVER:-local}" != "s3" ]; then
  log "restoring attachments into volume '$ATTACHMENTS_VOLUME'"
  docker run --rm -v "$ATTACHMENTS_VOLUME":/data -v "$(cd "$BACKUP_DIR" && pwd)":/in:ro alpine \
    sh -c 'cd /data && tar xzf /in/attachments.tgz' || die "attachments unpack failed"
fi

log "running integrity checks"
ATTACHMENTS_VOLUME="$ATTACHMENTS_VOLUME" "$SCRIPT_DIR/verify-restore.sh" "$RESTORE_PROJECT" "$BACKUP_DIR"

log "restore rehearsal SUCCEEDED for recovery point '${LABEL:-?}'"
