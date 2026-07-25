#!/usr/bin/env bash
# StoryOS post-restore integrity check (#322) — runnable on its own.
#
#   ./scripts/backup-restore/verify-restore.sh <restore-project> <backup-dir>
#
# Asserts, against the ISOLATED restore project's postgres:
#   1. structural integrity  — integrity-checks.sql (auth loads, relations +
#      attachments resolve). Same file the CI drift test runs.
#   2. row-count parity      — every table matches the source's counts.tsv.
#   3. attachments present   — every attachment storage_key has a real file in
#      the restored volume (local driver), so they are openable.
set -euo pipefail

PROJECT="${1:?usage: verify-restore.sh <restore-project> <backup-dir>}"
BACKUP_DIR="${2:?usage: verify-restore.sh <restore-project> <backup-dir>}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${PG_USER:-storyos}"
PG_DB="${PG_DB:-storyos}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKS_SQL="$SCRIPT_DIR/integrity-checks.sql"
ATTACHMENTS_VOLUME="${ATTACHMENTS_VOLUME:-${PROJECT}_storyos_attachments}"

log()  { printf '\033[1;34m[verify]\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m[verify] PASS:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[verify] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

dc() { docker compose -p "$PROJECT" "$@"; }
psql_q() { dc exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -qAtc "$1"; }

[ -f "$CHECKS_SQL" ] || die "missing $CHECKS_SQL"

# 1. structural integrity — the shared SQL, ON_ERROR_STOP so any RAISE fails us.
log "running structural integrity checks (integrity-checks.sql)"
dc exec -T "$PG_SERVICE" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -f - < "$CHECKS_SQL" \
  || die "structural integrity checks raised"
pass "structural integrity (auth loads, relations + attachments resolve)"

# 2. row-count parity against the recovery point's baseline.
if [ -f "$BACKUP_DIR/counts.tsv" ]; then
  log "asserting row-count parity vs $BACKUP_DIR/counts.tsv"
  while IFS='|' read -r table expected; do
    [ -n "${table:-}" ] || continue
    actual="$(psql_q "SELECT count(*) FROM \"$table\"")"
    [ "$actual" = "$expected" ] || die "row count drift on '$table': source=$expected restored=$actual"
  done < "$BACKUP_DIR/counts.tsv"
  pass "row counts match source for every table"
else
  log "no counts.tsv in $BACKUP_DIR — skipping parity check"
fi

# 3. attachments present & openable (local driver only).
STORAGE_DRIVER="$(grep -E '^STORAGE_DRIVER=' "$BACKUP_DIR/manifest.env" 2>/dev/null | cut -d= -f2 || echo local)"
if [ "$STORAGE_DRIVER" = "s3" ]; then
  log "STORAGE_DRIVER=s3 — attachment files live in the object store; skipping file check"
else
  n_att="$(psql_q "SELECT count(*) FROM attachments")"
  if [ "$n_att" = "0" ]; then
    pass "no attachments to verify"
  else
    keys="$(psql_q "SELECT storage_key FROM attachments UNION SELECT thumb_key FROM attachments WHERE thumb_key IS NOT NULL")"
    missing_list="$(printf '%s\n' "$keys" | docker run --rm -i -v "$ATTACHMENTS_VOLUME":/data:ro alpine \
      sh -c 'while IFS= read -r k; do [ -n "$k" ] && { [ -f "/data/$k" ] || echo "$k"; }; done')"
    missing="$(printf '%s' "$missing_list" | grep -c . || true)"
    [ "$missing" = "0" ] || die "$missing attachment file(s) missing from the restored volume"
    pass "$n_att attachment row(s) all have a file on disk"
  fi
fi

pass "restore verified — this recovery point is trustworthy"
