#!/usr/bin/env bash
# StoryOS self-host backup (#322).
#
# Produces a TIMESTAMPED, self-describing recovery point containing BOTH halves
# of the state that matters — the Postgres database and the attachments — under
# ONE label, so they can only ever be restored as a matched pair. Run it from
# the repo root of a running Compose stack:
#
#   ./scripts/backup-restore/backup.sh                 # label = UTC timestamp
#   ./scripts/backup-restore/backup.sh nightly-2026-07-25   # explicit label
#
# Output: backups/<label>/  ->  db.dump  attachments.tgz  manifest.env  counts.tsv
#
# Secrets never touch these files (rule 4): the DB password stays inside the
# postgres container; only data rows are dumped.
set -euo pipefail

# --- config (overridable from the environment) -----------------------------
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-storyos}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-storyos}"
PG_DB="${PG_DB:-storyos}"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"
ATTACHMENTS_VOLUME="${ATTACHMENTS_VOLUME:-${COMPOSE_PROJECT_NAME}_storyos_attachments}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUPS_DIR="${BACKUPS_DIR:-$REPO_ROOT/backups}"

LABEL="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
DEST="$BACKUPS_DIR/$LABEL"

log() { printf '\033[1;34m[backup]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[backup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found on PATH"
[ -f "$REPO_ROOT/docker-compose.yml" ] || die "run from a StoryOS checkout (no docker-compose.yml at $REPO_ROOT)"
[ -e "$DEST" ] && die "backup label already exists: $DEST"

dc() { docker compose -p "$COMPOSE_PROJECT_NAME" "$@"; }

# sha256, portable across macOS (shasum) and Linux (sha256sum).
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. database -----------------------------------------------------------
# Custom format (-Fc): compressed, and pg_restore can rebuild into an empty DB
# transactionally with --clean. -T is required so docker does not allocate a TTY
# that would corrupt the binary stream.
log "dumping database '$PG_DB' from service '$PG_SERVICE' (project '$COMPOSE_PROJECT_NAME')"
dc exec -T "$PG_SERVICE" pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$TMP/db.dump" \
  || die "pg_dump failed — is the stack up? (docker compose -p $COMPOSE_PROJECT_NAME ps)"
[ -s "$TMP/db.dump" ] || die "pg_dump produced an empty file"

# --- 2. row counts (the parity baseline restore.sh asserts against) --------
log "capturing row counts"
COUNT_SQL="COPY (
  SELECT 'user', count(*) FROM \"user\"
  UNION ALL SELECT 'session', count(*) FROM \"session\"
  UNION ALL SELECT 'workspaces', count(*) FROM workspaces
  UNION ALL SELECT 'databases', count(*) FROM databases
  UNION ALL SELECT 'records', count(*) FROM records
  UNION ALL SELECT 'relations', count(*) FROM relations
  UNION ALL SELECT 'record_links', count(*) FROM record_links
  UNION ALL SELECT 'attachments', count(*) FROM attachments
  UNION ALL SELECT 'workspace_files', count(*) FROM workspace_files
) TO STDOUT WITH (FORMAT text)"
dc exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -qAtc "$COUNT_SQL" > "$TMP/counts.tsv" \
  || die "failed to capture row counts"

# --- 3. attachments --------------------------------------------------------
if [ "$STORAGE_DRIVER" = "s3" ]; then
  log "STORAGE_DRIVER=s3 — attachments live in your object store, NOT the local volume"
  log "  back the bucket up with your provider's tooling and record its label as: $LABEL"
  : > "$TMP/attachments.tgz"   # placeholder so the manifest is complete
  ATT_NOTE="s3: back up bucket separately under label $LABEL"
else
  if docker volume inspect "$ATTACHMENTS_VOLUME" >/dev/null 2>&1; then
    log "archiving attachments volume '$ATTACHMENTS_VOLUME'"
    docker run --rm -v "$ATTACHMENTS_VOLUME":/data:ro -v "$TMP":/out alpine \
      tar czf /out/attachments.tgz -C /data . || die "attachments archive failed"
    ATT_NOTE="local volume $ATTACHMENTS_VOLUME"
  else
    log "attachments volume '$ATTACHMENTS_VOLUME' not found — recording an empty archive"
    tar czf "$TMP/attachments.tgz" -C "$TMP" --files-from /dev/null 2>/dev/null || : > "$TMP/attachments.tgz"
    ATT_NOTE="none (volume absent)"
  fi
fi

# --- 4. manifest -----------------------------------------------------------
GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$TMP/manifest.env" <<EOF
# StoryOS recovery point — restore db.dump and attachments.tgz TOGETHER.
LABEL=$LABEL
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
COMPOSE_PROJECT=$COMPOSE_PROJECT_NAME
GIT_COMMIT=$GIT_COMMIT
STORAGE_DRIVER=$STORAGE_DRIVER
ATTACHMENTS=$ATT_NOTE
DB_DUMP_SHA256=$(sha256 "$TMP/db.dump")
ATTACHMENTS_SHA256=$(sha256 "$TMP/attachments.tgz")
EOF

# --- 5. publish atomically -------------------------------------------------
mkdir -p "$BACKUPS_DIR"
mv "$TMP" "$DEST"
trap - EXIT
chmod -R go-rwx "$DEST" 2>/dev/null || true   # backups contain your data — keep them owner-only

log "recovery point ready: $DEST"
log "  db.dump          $(sha256 "$DEST/db.dump" | cut -c1-12)…"
log "  attachments.tgz  $(sha256 "$DEST/attachments.tgz" | cut -c1-12)…"
log "next: copy this directory OFF-HOST (encrypted), and rehearse recovery with"
log "  ./scripts/backup-restore/restore.sh $DEST"
