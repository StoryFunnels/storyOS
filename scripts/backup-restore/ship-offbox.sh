#!/usr/bin/env bash
# StoryOS off-box backup shipping (#294, slice A of #59).
#
# WRAPS backup.sh — it does not replace it. backup.sh already produces a
# matched db+attachments recovery point with a manifest and row counts; the
# problem it leaves open is that the recovery point sits on the SAME host it is
# protecting. A backup that dies with the box is not a backup: a Docker volume
# wipe on 2026-07-26 is exactly why this exists.
#
# This script: take a recovery point -> encrypt it to a PUBLIC key -> upload it
# to storage in a different failure domain -> prune old points here and there.
#
#   ./scripts/backup-restore/ship-offbox.sh                  # new backup, then ship
#   ./scripts/backup-restore/ship-offbox.sh backups/<label>  # ship an existing one
#   DRY_RUN=1 ./scripts/backup-restore/ship-offbox.sh        # print, touch nothing
#
# Required environment (keep in .env / the systemd unit, NEVER in git — rule 4):
#   BACKUP_AGE_RECIPIENT   age PUBLIC key (age1…). The private key MUST live off
#                          this host, or an attacker who owns the box owns the
#                          backups too — which defeats the point.
#   BACKUP_RCLONE_REMOTE   rclone destination, e.g. b2:storyos-backups/prod
# Optional:
#   KEEP_DAILY (7)  KEEP_MONTHLY (4)  RCLONE_CONFIG  BACKUPS_DIR (backups)
set -euo pipefail

BACKUPS_DIR="${BACKUPS_DIR:-backups}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_MONTHLY="${KEEP_MONTHLY:-4}"
DRY_RUN="${DRY_RUN:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[36m[ship]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ship]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ship] %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ -n "$DRY_RUN" ]; then printf '\033[90m  would run:\033[0m %s\n' "$*"; else eval "$@"; fi; }

# --- preflight: fail LOUDLY and early -------------------------------------
# A silent no-op here is the worst possible outcome: the operator believes they
# have off-box backups and finds out otherwise during a restore.
command -v age >/dev/null    || die "age is not installed (apt install age) — refusing to ship unencrypted"
command -v rclone >/dev/null || die "rclone is not installed (see rclone.org/install) — nowhere to ship to"
[ -n "${BACKUP_AGE_RECIPIENT:-}" ] || die "BACKUP_AGE_RECIPIENT is unset — refusing to ship unencrypted"
[ -n "${BACKUP_RCLONE_REMOTE:-}" ] || die "BACKUP_RCLONE_REMOTE is unset — no destination configured"
case "$BACKUP_AGE_RECIPIENT" in
  age1*) : ;;
  *) die "BACKUP_AGE_RECIPIENT does not look like an age public key (age1…)" ;;
esac
# An age PRIVATE key here would mean the box can decrypt its own backups.
case "$BACKUP_AGE_RECIPIENT" in
  AGE-SECRET-KEY-*) die "BACKUP_AGE_RECIPIENT is a PRIVATE key — use the public key (age1…) and keep the private key off this host" ;;
esac

# --- 1. get a recovery point ----------------------------------------------
POINT="${1:-}"
if [ -z "$POINT" ]; then
  log "creating a fresh recovery point via backup.sh"
  if [ -n "$DRY_RUN" ]; then
    printf '\033[90m  would run:\033[0m %s\n' "$HERE/backup.sh"
    POINT="$BACKUPS_DIR/<new-label>"
  else
    "$HERE/backup.sh"
    # backup.sh names points by UTC timestamp, so the newest directory is ours.
    POINT="$(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
    [ -n "$POINT" ] || die "backup.sh reported success but produced no directory in $BACKUPS_DIR"
  fi
fi
LABEL="$(basename "$POINT")"
if [ -z "$DRY_RUN" ]; then
  [ -d "$POINT" ] || die "no such recovery point: $POINT"
  # Never ship a half-written point: backup.sh guarantees these three files.
  for f in db.dump manifest.env; do
    [ -s "$POINT/$f" ] || die "$POINT/$f is missing or empty — refusing to ship an incomplete recovery point"
  done
fi

# --- 2. encrypt to the public key ----------------------------------------
# One tar per point so db + attachments + manifest can only be restored as the
# matched set backup.sh made them; .age so the box holds no decryption secret.
ARCHIVE="$BACKUPS_DIR/$LABEL.tar.age"
log "encrypting $POINT -> $ARCHIVE"
run "tar -C '$BACKUPS_DIR' -cf - '$LABEL' | age -r '$BACKUP_AGE_RECIPIENT' -o '$ARCHIVE'"
if [ -z "$DRY_RUN" ]; then
  [ -s "$ARCHIVE" ] || die "encryption produced an empty archive"
  chmod go-rwx "$ARCHIVE" 2>/dev/null || true
fi

# --- 3. upload -----------------------------------------------------------
log "uploading to $BACKUP_RCLONE_REMOTE"
run "rclone copyto '$ARCHIVE' '$BACKUP_RCLONE_REMOTE/$LABEL.tar.age' --no-traverse"
# Verify the far side actually has it — an exit code alone has fooled operators
# before (a misconfigured remote can 'succeed' into nothing).
if [ -z "$DRY_RUN" ]; then
  rclone lsf "$BACKUP_RCLONE_REMOTE/$LABEL.tar.age" >/dev/null 2>&1 \
    || die "upload reported success but $LABEL.tar.age is not listable on the remote"
  log "verified present on remote: $LABEL.tar.age"
fi

# --- 4. prune ------------------------------------------------------------
# Keep the last KEEP_DAILY points, plus the newest point of each of the last
# KEEP_MONTHLY calendar months. Named MONTHLY because that is what the bucket
# below actually is (YYYY-MM) — a "weekly" knob that silently retained monthly
# would be a knob that lies about your recovery horizon.
# Deliberately conservative: pruning is the one step that can destroy history,
# so it only ever removes points it can see are superseded.
prune_list() {
  # stdin: newline-separated labels, newest last. stdout: labels to delete.
  local all=() recent kept_months keep line
  # Read with a while-loop, NOT mapfile: mapfile is bash 4+, and an operator
  # checking this by hand on macOS has bash 3.2. Portability here is free.
  while IFS= read -r line; do [ -n "$line" ] && all+=("$line"); done < <(sort)
  (( ${#all[@]} == 0 )) && return 0
  # Guard the negative offset: with fewer points than KEEP_DAILY, "${a[@]: -7}"
  # is an error on some shells — and over-pruning here would delete history.
  if (( ${#all[@]} <= KEEP_DAILY )); then
    recent=("${all[@]}")
  else
    recent=("${all[@]:${#all[@]}-KEEP_DAILY}")
  fi
  keep=" ${recent[*]} "
  kept_months=0
  # Walk newest→oldest keeping the newest point of each distinct month.
  local seen_months=" " lbl month
  for (( i=${#all[@]}-1; i>=0; i-- )); do
    lbl="${all[i]}"
    month="${lbl:0:4}-${lbl:4:2}"   # YYYY-MM from backup.sh's timestamp label
    if [[ "$seen_months" != *" $month "* ]] && (( kept_months < KEEP_MONTHLY )); then
      seen_months+="$month "
      keep+="$lbl "
      kept_months=$((kept_months+1))
    fi
  done
  for lbl in "${all[@]}"; do
    [[ "$keep" == *" $lbl "* ]] || printf '%s\n' "$lbl"
  done
}

if [ -z "$DRY_RUN" ]; then
  log "pruning locally (keep ${KEEP_DAILY} daily + ${KEEP_MONTHLY} monthly)"
  while read -r old; do
    [ -n "$old" ] || continue
    log "  local prune $old"
    rm -rf -- "$BACKUPS_DIR/${old:?}" "$BACKUPS_DIR/${old:?}.tar.age"
  done < <(find "$BACKUPS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | prune_list)

  log "pruning the remote"
  while read -r old; do
    [ -n "$old" ] || continue
    log "  remote prune $old"
    rclone deletefile "$BACKUP_RCLONE_REMOTE/$old.tar.age" || warn "could not delete $old on the remote"
  done < <(rclone lsf "$BACKUP_RCLONE_REMOTE" 2>/dev/null | sed -n 's/\.tar\.age$//p' | prune_list)
else
  log "would prune to ${KEEP_DAILY} daily + ${KEEP_MONTHLY} monthly, locally and on the remote"
fi

log "done — $LABEL is off-box and encrypted"
log "rehearse recovery with: ./scripts/backup-restore/check-freshness.sh && see docs/backup-restore.md"
