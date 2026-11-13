#!/usr/bin/env bash
# Ticket #1269 — (re)build the Pinewood template database, storyos_agency_tpl.
#
#   pinewood-template.sh [--dry-run] [--repo DIR]
#
# A rig is then `pinewood-rig.sh <name>` (createdb -T, seconds) plus whatever
# migrations the rig's own branch adds. The template is the one database any
# pinewood script may DROP: it is rebuilt from scratch from main's migrations and
# seed, so it is disposable by construction. The standing stack's database
# (storyos_pinewood) is never touched here.
#
# --repo DIR   checkout whose migrations/seed build the template. Default: the
#              standing stack's clone ($PINEWOOD_HOME, ~/storyos-envs/pinewood),
#              i.e. main. It must have node_modules installed.
#
# Run it after a merge batch that adds a migration or changes the seed. A stale
# template is harmless (a rig just applies more migrations) but slower.
#
# Configuration: PINEWOOD_TEMPLATE_DB (storyos_agency_tpl), PINEWOOD_HOME,
# PINEWOOD_PGHOST / PINEWOOD_PGPORT / PINEWOOD_PGUSER.

set -u

PW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$PW_SCRIPT_DIR/lib.sh"

pinewood_template() {
  local dry_run=0 repo="" arg
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --repo) shift; repo="${1:-}"; [ -n "$repo" ] || pw_refuse "--repo needs a directory" ;;
      -h | --help) sed -n '2,22p' "${BASH_SOURCE[0]}"; return 0 ;;
      *) pw_refuse "unknown argument '$arg'" ;;
    esac
    shift
  done

  local tpl
  tpl="${PINEWOOD_TEMPLATE_DB:-storyos_agency_tpl}"
  [ -n "$repo" ] || repo="${PINEWOOD_HOME:-$HOME/storyos-envs/pinewood}"

  pw_load_pg_config
  pw_assert_template_db "$tpl"
  [ -f "$repo/apps/api/package.json" ] || pw_refuse "'$repo' is not a StoryOS checkout (no apps/api/package.json)"
  [ -d "$repo/node_modules" ] || pw_refuse "'$repo' has no node_modules; install dependencies there first"

  local sha
  sha="$(git -C "$repo" rev-parse --short=9 HEAD 2>/dev/null || echo unknown)"
  pw_say "plan (dry_run=$dry_run): rebuild $tpl on $PW_PGHOST:$PW_PGPORT from $repo @ $sha"
  pw_say "  1. drop $tpl if it exists (the only database any pinewood script drops), create it empty"
  pw_say "  2. migrate it with $repo's migrations"
  if grep -q '"seed:agency"' "$repo/apps/api/package.json"; then
    pw_say "  3. seed:agency"
  else
    pw_say "  3. (no seed:agency command at $sha yet: the template will hold migrations only)"
  fi
  pw_say "  4. record provenance as the database comment"
  if [ "$dry_run" -eq 1 ]; then
    pw_say "dry run: nothing was changed."
    return 0
  fi

  local t0 seeded="migrations only"
  t0="$(date +%s)"
  pw_check_db template "$tpl"
  if pw_db_exists "$tpl"; then
    pw_psql -d postgres -c "DROP DATABASE \"$tpl\"" ||
      pw_refuse "could not drop $tpl (is a rig or the API connected to it? close those connections and retry)"
  fi
  createdb -h "$PW_PGHOST" -p "$PW_PGPORT" -U "$PW_PGUSER" "$tpl" || pw_refuse "createdb $tpl failed"

  (cd "$repo" && pw_run_with_db template "$tpl" pnpm --filter @storyos/api db:migrate) || pw_refuse "migrate failed on $tpl"
  echo
  if grep -q '"seed:agency"' "$repo/apps/api/package.json"; then
    (cd "$repo" && pw_run_with_db template "$tpl" LOG_LEVEL=warn pnpm --filter @storyos/api seed:agency) || pw_refuse "seed:agency failed on $tpl"
    seeded="migrations + seed:agency"
  fi
  pw_psql -d postgres -c "COMMENT ON DATABASE \"$tpl\" IS 'sha=$sha, $seeded, built=$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
  pw_say "template ready: $tpl @ $sha ($seeded) in $(($(date +%s) - t0))s"
}

pinewood_template "$@"; exit $?
