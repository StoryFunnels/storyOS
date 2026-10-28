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
#
# It never restores into the live project. Recovering production is a different
# job with its own steps: "Real recovery" in docs/backup-restore.md.
set -euo pipefail

BACKUP_DIR="${1:?usage: restore.sh <backup-dir> [--project <name>] [--keep]}"
shift || true
RESTORE_PROJECT="storyos_restore"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) RESTORE_PROJECT="${2:?}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    # #1023 — --force used to let a rehearsal target the live project, whose
    # teardown (`down -v`, on success AND on failure) then deleted the live
    # database volume. There is no safe meaning for it, so it is gone.
    --force)   echo "--force was removed (#1023): restore.sh only rehearses into an isolated clone. To recover production, follow 'Real recovery' in docs/backup-restore.md." >&2; exit 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-storyos}"
PG_DB="${PG_DB:-storyos}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=manifest.sh
. "$SCRIPT_DIR/manifest.sh"
ATTACHMENTS_VOLUME="${RESTORE_PROJECT}_storyos_attachments"

# Every name the live stack can be running under, as Compose resolves it: the
# COMPOSE_PROJECT_NAME env var, the one in .env, and docker-compose.yml's own
# `name: storyos`. Compose lowercases project names, so compare lowercased.
LIVE_PROJECTS=("${COMPOSE_PROJECT_NAME:-}" storyos)
if [ -f "$REPO_ROOT/.env" ]; then
  env_name="$(sed -n 's/^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=[[:space:]]*//p' "$REPO_ROOT/.env" | tail -n 1 | tr -d "\"'\r")"
  LIVE_PROJECTS+=("$env_name")
fi
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
is_live() {
  local name
  for name in "${LIVE_PROJECTS[@]}"; do
    [ -n "$name" ] && [ "$(lower "$1")" = "$(lower "$name")" ] && return 0
  done
  return 1
}

log() { printf '\033[1;34m[restore]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[restore] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$BACKUP_DIR/db.dump" ] || die "no db.dump in $BACKUP_DIR"
[ -f "$BACKUP_DIR/manifest.env" ] || die "no manifest.env in $BACKUP_DIR — not a StoryOS recovery point"

# Safety: never let a rehearsal clobber the live stack (#322 requirement, no override since #1023).
if is_live "$RESTORE_PROJECT"; then
  die "refusing to restore into the LIVE project '$RESTORE_PROJECT'. Use a different --project (default storyos_restore). To recover production, follow 'Real recovery' in docs/backup-restore.md."
fi

dc() { docker compose -p "$RESTORE_PROJECT" "$@"; }

cleanup() {
  # #1023 — `down -v` deletes the project's volumes, its database included. The
  # check above already refuses the live project; this keeps the teardown safe
  # even if a later change opens another way in.
  if is_live "$RESTORE_PROJECT"; then
    log "not tearing down '$RESTORE_PROJECT': it is the live project"
  elif [ "$KEEP" -eq 1 ]; then
    log "clone left running as project '$RESTORE_PROJECT' (--keep). Tear down with: docker compose -p $RESTORE_PROJECT down -v"
  else
    log "tearing down clone '$RESTORE_PROJECT' (and its volumes)"
    dc down -v >/dev/null 2>&1 || true
    # The attachments volume is made by `docker run` below, not by compose, so
    # `down -v` leaves it behind — with real customer files in it.
    docker volume rm "$ATTACHMENTS_VOLUME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

cd "$REPO_ROOT"

log "verifying checksums against manifest"
# #891 — read as data, never `source`d: manifests written before the fix carry
# an unquoted `ATTACHMENTS=local volume <name>` line that bash runs as a command.
MANIFEST="$BACKUP_DIR/manifest.env"
LABEL="$(manifest_get "$MANIFEST" LABEL)"
STORAGE_DRIVER="$(manifest_get "$MANIFEST" STORAGE_DRIVER)"
DB_DUMP_SHA256="$(manifest_get "$MANIFEST" DB_DUMP_SHA256)"
ATTACHMENTS_SHA256="$(manifest_get "$MANIFEST" ATTACHMENTS_SHA256)"
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
[ -n "$DB_DUMP_SHA256" ] || die "manifest.env has no DB_DUMP_SHA256 — cannot prove db.dump is intact"
[ "$(sha256 "$BACKUP_DIR/db.dump")" = "$DB_DUMP_SHA256" ] || die "db.dump checksum mismatch — backup is corrupt"
if [ -f "$BACKUP_DIR/attachments.tgz" ] && [ -n "$ATTACHMENTS_SHA256" ]; then
  [ "$(sha256 "$BACKUP_DIR/attachments.tgz")" = "$ATTACHMENTS_SHA256" ] \
    || die "attachments.tgz checksum mismatch — backup is corrupt"
fi

log "bringing up isolated postgres (project '$RESTORE_PROJECT')"
dc up -d "$PG_SERVICE"

# #1061 — a FRESH container runs initdb, then the image's entrypoint starts a throwaway server that listens on the
# unix socket only, then restarts as the real server. Two things went wrong with a flat 30 x 1s poll of `pg_isready`:
# a cold start next to the CI shards and image builds can take longer than 30s, and the socket-only server answers
# pg_isready and then goes away under pg_restore. So: poll over TCP (the throwaway server does not listen on it),
# require two answers in a row, and give it a bounded, configurable deadline.
PG_READY_TIMEOUT="${PG_READY_TIMEOUT:-120}"
log "waiting for postgres to be ready (up to ${PG_READY_TIMEOUT}s)"
ready=0
deadline=$(( $(date +%s) + PG_READY_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if dc exec -T "$PG_SERVICE" pg_isready -h 127.0.0.1 -U "$PG_USER" >/dev/null 2>&1; then
    ready=$((ready + 1))
    [ "$ready" -ge 2 ] && break
  else
    ready=0
  fi
  sleep 1
done
if [ "$ready" -lt 2 ]; then
  dc logs --tail 20 "$PG_SERVICE" >&2 || true
  die "postgres did not become ready within ${PG_READY_TIMEOUT}s (last output above): the restore did not start, the backup was not tested"
fi

log "rebuilding database '$PG_DB' from db.dump"
# --clean --if-exists so a re-run is idempotent; -Fc dump restored with pg_restore.
dc exec -T "$PG_SERVICE" pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists --no-owner < "$BACKUP_DIR/db.dump" \
  || log "pg_restore reported warnings (often benign for --clean on a fresh DB) — integrity checks are the real gate"

if [ -s "$BACKUP_DIR/attachments.tgz" ] && [ "${STORAGE_DRIVER:-local}" != "s3" ]; then
  log "restoring attachments into volume '$ATTACHMENTS_VOLUME'"
  # Start from an EMPTY clone volume: files left by an earlier rehearsal would let
  # verify-restore.sh's "every attachment has a file" pass for a backup that lacks them.
  # (Never the live project's volume: that project is refused above.)
  docker volume rm "$ATTACHMENTS_VOLUME" >/dev/null 2>&1 || true
  docker run --rm -v "$ATTACHMENTS_VOLUME":/data -v "$(cd "$BACKUP_DIR" && pwd)":/in:ro alpine \
    sh -c 'cd /data && tar xzf /in/attachments.tgz' || die "attachments unpack failed"
fi

log "running integrity checks"
ATTACHMENTS_VOLUME="$ATTACHMENTS_VOLUME" "$SCRIPT_DIR/verify-restore.sh" "$RESTORE_PROJECT" "$BACKUP_DIR"

log "restore rehearsal SUCCEEDED for recovery point '${LABEL:-?}'"
