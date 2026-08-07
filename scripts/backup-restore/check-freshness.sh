#!/usr/bin/env bash
# StoryOS backup freshness check (#294, slice A of #59).
#
# Answers ONE question with an exit code: is there a recent off-box recovery
# point? Silent success / non-zero + a message on failure, so it can be driven
# from cron (which mails stderr), a systemd OnFailure, or any uptime checker.
#
#   ./scripts/backup-restore/check-freshness.sh          # default: 26h window
#   MAX_AGE_HOURS=50 ./scripts/backup-restore/check-freshness.sh
#
# 26 hours by default, not 24: a nightly job plus clock drift or a slow upload
# should not page anyone, but a genuinely SKIPPED night should.
#
# Required: BACKUP_RCLONE_REMOTE (and rclone configured for it).
set -euo pipefail

MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"

die() { printf 'BACKUP CHECK FAILED: %s\n' "$*" >&2; exit 1; }

command -v rclone >/dev/null || die "rclone is not installed — cannot verify off-box backups exist"
[ -n "${BACKUP_RCLONE_REMOTE:-}" ] || die "BACKUP_RCLONE_REMOTE is unset — no off-box destination is configured"

# `lsjson` gives modification times without parsing human-formatted output.
JSON="$(rclone lsjson "$BACKUP_RCLONE_REMOTE" 2>/dev/null || true)"
[ -n "$JSON" ] || die "could not list $BACKUP_RCLONE_REMOTE (bad credentials, wrong path, or no backups have EVER been shipped)"

# Newest .tar.age entry's ModTime, without assuming jq is present.
NEWEST="$(printf '%s' "$JSON" \
  | tr '}' '}\n' \
  | grep '\.tar\.age' \
  | sed -n 's/.*"ModTime":"\([^"]*\)".*/\1/p' \
  | sort \
  | tail -1)"
[ -n "$NEWEST" ] || die "no *.tar.age recovery points found at $BACKUP_RCLONE_REMOTE — backups are NOT reaching the remote"

# GNU date (Linux hosts) and BSD date (a macOS operator checking by hand).
to_epoch() {
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%S' "${1%%.*}" +%s 2>/dev/null
}
NEWEST_EPOCH="$(to_epoch "$NEWEST")" || true
[ -n "${NEWEST_EPOCH:-}" ] || die "could not parse the newest backup's timestamp ($NEWEST)"

AGE_HOURS=$(( ( $(date -u +%s) - NEWEST_EPOCH ) / 3600 ))
if (( AGE_HOURS > MAX_AGE_HOURS )); then
  die "newest off-box backup is ${AGE_HOURS}h old (limit ${MAX_AGE_HOURS}h) — the nightly job is not running or not uploading"
fi

printf 'ok: newest off-box backup is %sh old (limit %sh)\n' "$AGE_HOURS" "$MAX_AGE_HOURS"
