#!/usr/bin/env bash
# Ticket #1269 — a PR rig database cloned from the Pinewood template.
#
#   pinewood-rig.sh <rig> [--repo DIR] [--recreate] [--dry-run]
#
# Creates database storyos_<rig> with `createdb -T storyos_agency_tpl` (a file
# copy: seconds, not a re-seed), then runs DIR's migrations on top — so a migration
# a PR adds is applied to Pinewood data exactly as it will be on main. Prints the
# DATABASE_URL to use, and how many migrations came from the template and how many
# this checkout added.
#
# --repo DIR    checkout whose migrations to apply. Default: the current
#               directory's git toplevel (your worktree).
# --recreate    drop storyos_<rig> first and clone again. Without it an existing
#               rig database is left alone and only migrated (so re-running is safe).
#
# Refuses: a rig name that would land on the standing stack (storyos_pinewood*), the
# template (storyos_agency_tpl*), or any protected database; a non-local Postgres.
# Never touches anything but storyos_<rig>.
#
# Rig databases live on the same Postgres as everything else: pick a session-unique
# name (storyos_marek_1269, not storyos_test_local), because two sessions sharing a
# name looks exactly like a regression.

set -u

PW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$PW_SCRIPT_DIR/lib.sh"

pinewood_rig() {
  local rig="" repo="" recreate=0 dry_run=0 arg
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --recreate) recreate=1 ;;
      --repo) shift; repo="${1:-}"; [ -n "$repo" ] || pw_refuse "--repo needs a directory" ;;
      -h | --help) sed -n '2,23p' "${BASH_SOURCE[0]}"; return 0 ;;
      -*) pw_refuse "unknown argument '$arg'" ;;
      *) [ -z "$rig" ] || pw_refuse "one rig name only (got '$rig' and '$arg')"; rig="$arg" ;;
    esac
    shift
  done
  [ -n "$rig" ] || pw_refuse "usage: pinewood-rig.sh <rig> [--repo DIR] [--recreate] [--dry-run]"

  local tpl db
  tpl="${PINEWOOD_TEMPLATE_DB:-storyos_agency_tpl}"
  db="storyos_$rig"
  [ -n "$repo" ] || repo="$(git rev-parse --show-toplevel 2>/dev/null || true)"

  pw_load_pg_config
  pw_assert_template_db "$tpl"
  pw_assert_rig_db "$db"
  [ -f "$repo/apps/api/package.json" ] || pw_refuse "'${repo:-.}' is not a StoryOS checkout; run from your worktree or pass --repo"
  [ -d "$repo/node_modules" ] || pw_refuse "'$repo' has no node_modules; install dependencies there first"

  pw_say "plan (dry_run=$dry_run): rig $db on $PW_PGHOST:$PW_PGPORT, cloned from $tpl, migrated from $repo"
  [ "$recreate" -eq 1 ] && pw_say "  --recreate: $db is dropped first"
  if [ "$dry_run" -eq 1 ]; then
    pw_say "dry run: nothing was changed."
    return 0
  fi

  pw_db_exists "$tpl" || pw_refuse "template $tpl does not exist; run pinewood-template.sh first"

  local t0
  t0="$(date +%s)"
  pw_check_db rig "$db"
  if pw_db_exists "$db"; then
    if [ "$recreate" -eq 1 ]; then
      pw_psql -d postgres -c "DROP DATABASE \"$db\"" || pw_refuse "could not drop $db (something is connected to it)"
    else
      pw_say "$db already exists; leaving its data alone and applying migrations only"
    fi
  fi
  if ! pw_db_exists "$db"; then
    createdb -h "$PW_PGHOST" -p "$PW_PGPORT" -U "$PW_PGUSER" -T "$tpl" "$db" ||
      pw_refuse "createdb -T $tpl failed (is something connected to the template?)"
  fi

  local before after
  before="$(pw_psql -d "$db" -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo 0)"
  (cd "$repo" && pw_run_with_db rig "$db" pnpm --filter @storyos/api db:migrate) || pw_refuse "migrate failed on $db"
  echo
  after="$(pw_psql -d "$db" -tAc 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo 0)"

  pw_say "rig ready in $(($(date +%s) - t0))s: $db (template had $before migrations, this checkout added $((after - before)), now $after)"
  pw_say "template provenance: $(pw_psql -d postgres -tAc "SELECT coalesce(shobj_description(oid, 'pg_database'), '(no provenance)') FROM pg_database WHERE datname = '$tpl'")"
  echo "DATABASE_URL=$(pw_db_url "$db")"
}

pinewood_rig "$@"; exit $?
