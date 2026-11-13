#!/usr/bin/env bash
# Ticket #1269 — bring the standing local Pinewood stack up to date with main.
#
#   pinewood-up.sh [--dry-run] [--init]
#
# LOCAL ONLY. One standing stack on one Mac: API :3500, web :3600 (non-watch,
# `node dist`), persistent database storyos_pinewood, run from its OWN clone
# (default ~/storyos-envs/pinewood). Vera runs this after each merge batch; agents
# never restart it themselves (one owner, no fights over ports).
#
# What it does, in order, after printing the plan and refusing anything unsafe:
#   1. git pull --ff-only main in the clone (never reset, never discard)
#   2. pnpm install --frozen-lockfile, only when the lockfile changed
#   3. build api + web at the new sha (skipped when that sha is already built)
#   4. create storyos_pinewood if missing, then migrate it (NEVER dropped)
#   5. seed:agency refresh, if that command exists yet (refresh only, never wipe)
#   6. stop the processes THIS script started, start the new ones
#   7. health check: database up, web answering, and the running API reports the
#      sha the clone is at. Prints that sha. Non-zero exit if any of that is false.
#
# Idempotent: run it twice in a row and it ends healthy at the same sha with the
# same data.
#
# Everything unsafe is a REFUSAL with exit code 2 (see lib.sh): a non-pinewood
# database, a non-local Postgres host, a clone that is a worktree or not pinewood-
# named, a stray .env in the clone, a dev port, a port held by someone else.
#
# Configuration (all optional; every value is validated):
#   PINEWOOD_HOME      clone path            ~/storyos-envs/pinewood
#   PINEWOOD_STATE     pids, stamps, logs    ~/storyos-envs/pinewood-state
#   PINEWOOD_ENV_FILE  throwaway secrets     ~/storyos-envs/pinewood.env (generated, mode 600)
#   PINEWOOD_DB        database              storyos_pinewood
#   PINEWOOD_API_PORT  3500        PINEWOOD_WEB_PORT  3600
#   PINEWOOD_REPO_URL  where --init clones from (default: this checkout's origin)
#   PINEWOOD_PGHOST / PINEWOOD_PGPORT / PINEWOOD_PGUSER   localhost / 5432 / $(whoami)

set -u

PW_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$PW_SCRIPT_DIR/lib.sh"

pinewood_up() {
  local dry_run=0 init=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) dry_run=1 ;;
      --init) init=1 ;;
      -h | --help) sed -n '2,38p' "${BASH_SOURCE[0]}"; return 0 ;;
      *) pw_refuse "unknown argument '$arg'" ;;
    esac
  done

  # An inherited DATABASE_URL is never used. Say so, once, so nobody wonders.
  if [ -n "${DATABASE_URL:-}" ]; then
    pw_say "ignoring the DATABASE_URL in this shell; the stack builds its own connection string"
  fi

  local home state env_file db api_port web_port
  home="${PINEWOOD_HOME:-$HOME/storyos-envs/pinewood}"
  state="${PINEWOOD_STATE:-$HOME/storyos-envs/pinewood-state}"
  env_file="${PINEWOOD_ENV_FILE:-$HOME/storyos-envs/pinewood.env}"
  db="${PINEWOOD_DB:-storyos_pinewood}"
  api_port="${PINEWOOD_API_PORT:-3500}"
  web_port="${PINEWOOD_WEB_PORT:-3600}"

  # ---- refusals: all of them, before anything is created or changed ----------
  pw_load_pg_config
  pw_assert_stack_db "$db"
  pw_assert_port "API" "$api_port"
  pw_assert_port "web" "$web_port"
  [ "$api_port" != "$web_port" ] || pw_refuse "API and web cannot share port $api_port"
  pw_assert_clone_dir "$home"
  pw_assert_port_free_or_ours "API" "$api_port" "$state/api.pid" "$home"
  pw_assert_port_free_or_ours "web" "$web_port" "$state/web.pid" "$home"

  local clone_present=0
  if [ -d "$home" ]; then
    clone_present=1
    pw_assert_clone_state "$home"
  elif [ "$init" -ne 1 ]; then
    pw_refuse "no clone at $home; pass --init to clone it (it must be its own clone, never an agent's worktree)"
  fi

  # ---- the plan, printed before anything happens ----------------------------
  local repo_url
  repo_url="${PINEWOOD_REPO_URL:-$(git -C "$PW_SCRIPT_DIR" remote get-url origin 2>/dev/null || true)}"
  pw_say "plan (dry_run=$dry_run):"
  if [ "$clone_present" -eq 1 ]; then
    pw_say "  1. git pull --ff-only origin main in $home"
  else
    pw_say "  1. git clone --branch main ${repo_url:-<PINEWOOD_REPO_URL unset>} $home"
  fi
  pw_say "  2. pnpm install --frozen-lockfile when pnpm-lock.yaml changed"
  pw_say "  3. build api + web (web baked with NEXT_PUBLIC_API_URL=http://localhost:$api_port) unless this sha is already built"
  pw_say "  4. create database $db on $PW_PGHOST:$PW_PGPORT if missing, then migrate it (never dropped, never wiped)"
  pw_say "  5. seed:agency refresh when the command exists"
  pw_say "  6. restart: stop only the processes recorded in $state, start API :$api_port and web :$web_port (node dist, no watch)"
  pw_say "  7. health check, then print the running sha"
  pw_say "  secrets: $env_file (generated if absent, mode 600, never in git); logs: $state/*.log"

  if [ "$dry_run" -eq 1 ]; then
    pw_say "dry run: nothing was changed."
    return 0
  fi

  # ---- do it ------------------------------------------------------------------
  mkdir -p "$state" || pw_refuse "cannot create $state"
  pw_ensure_env_file "$env_file"

  if [ "$clone_present" -ne 1 ]; then
    [ -n "$repo_url" ] || pw_refuse "--init needs PINEWOOD_REPO_URL (this checkout has no origin remote)"
    mkdir -p "$(dirname "$home")"
    git clone --branch main "$repo_url" "$home" || pw_refuse "git clone failed"
    pw_assert_clone_dir "$home"
    pw_assert_clone_state "$home"
  fi

  pw_say "step 1/7: pull main"
  git -C "$home" pull --ff-only origin main || pw_refuse "git pull --ff-only failed (diverged or offline); nothing was reset"
  local sha short
  sha="$(git -C "$home" rev-parse HEAD)"
  short="$(git -C "$home" rev-parse --short=9 HEAD)"

  pw_say "step 2/7: dependencies"
  local lock_now lock_then=""
  lock_now="$(shasum "$home/pnpm-lock.yaml" | cut -d' ' -f1)"
  [ -f "$state/lock.sha" ] && lock_then="$(cat "$state/lock.sha")"
  if [ "$lock_now" != "$lock_then" ] || [ ! -d "$home/node_modules" ]; then
    (cd "$home" && env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" pnpm install --frozen-lockfile) || pw_refuse "pnpm install failed"
    echo "$lock_now" >"$state/lock.sha"
  else
    pw_say "  lockfile unchanged"
  fi

  pw_say "step 3/7: build $short"
  local stamp_now stamp_then=""
  stamp_now="$sha api=$api_port"
  [ -f "$state/build.stamp" ] && stamp_then="$(cat "$state/build.stamp")"
  if [ "$stamp_now" != "$stamp_then" ] || [ ! -f "$home/apps/api/dist/main.js" ] || [ ! -f "$home/apps/web/.next/BUILD_ID" ]; then
    rm -f "$state/build.stamp"
    (cd "$home" && env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" pnpm --filter "@storyos/api..." build) || pw_refuse "api build failed"
    (cd "$home" && env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" NEXT_PUBLIC_API_URL="http://localhost:$api_port" pnpm --filter "@storyos/web..." build) || pw_refuse "web build failed"
    echo "$stamp_now" >"$state/build.stamp"
  else
    pw_say "  $short already built"
  fi

  pw_say "step 4/7: database $db"
  if pw_db_exists "$db"; then
    pw_say "  exists; leaving its data alone"
  else
    createdb -h "$PW_PGHOST" -p "$PW_PGPORT" -U "$PW_PGUSER" "$db" || pw_refuse "createdb $db failed"
    pw_say "  created"
  fi
  (cd "$home" && pw_run_with_db stack "$db" pnpm --filter @storyos/api db:migrate) || pw_refuse "migrate failed on $db"

  pw_say "step 5/7: seed:agency"
  if grep -q '"seed:agency"' "$home/apps/api/package.json"; then
    (cd "$home" && pw_run_with_db stack "$db" LOG_LEVEL=warn pnpm --filter @storyos/api seed:agency) || pw_refuse "seed:agency failed on $db"
  else
    pw_say "  no seed:agency command at $short yet (ticket #1269 follow-up): the database holds migrations only"
  fi

  pw_say "step 6/7: restart"
  pw_stop_service "API" "$state/api.pid" "$home"
  pw_stop_service "web" "$state/web.pid" "$home"
  pw_assert_port_free_or_ours "API" "$api_port" "$state/api.pid" "$home"
  pw_port_busy "$api_port" && pw_refuse "API port $api_port is still busy after stopping our process"
  pw_port_busy "$web_port" && pw_refuse "web port $web_port is still busy after stopping our process"

  # shellcheck disable=SC1090
  set -a; . "$env_file"; set +a
  local build_time
  build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$state/attachments"
  pw_check_db stack "$db"
  (
    cd "$home/apps/api" || exit 1
    # `env` is exec'd directly (not a shell function), so $! is the node process itself.
    env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" DATABASE_URL="$(pw_db_url "$db")" \
      NODE_ENV=development PORT="$api_port" \
      API_URL="http://localhost:$api_port" WEB_URL="http://localhost:$web_port" \
      BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" CONNECTIONS_MASTER_KEY="$CONNECTIONS_MASTER_KEY" \
      ATTACHMENTS_DIR="$state/attachments" LOG_LEVEL=warn GIT_SHA="$sha" BUILD_TIME="$build_time" \
      node "$home/apps/api/dist/main.js" >>"$state/api.log" 2>&1 &
    echo $! >"$state/api.pid"
  )
  (
    cd "$home/apps/web" || exit 1
    env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" NODE_ENV=production PORT="$web_port" \
      NEXT_PUBLIC_API_URL="http://localhost:$api_port" \
      node "$home/apps/web/node_modules/next/dist/bin/next" start -p "$web_port" >>"$state/web.log" 2>&1 &
    echo $! >"$state/web.pid"
  )

  pw_say "step 7/7: health check"
  pw_health_check "$api_port" "$web_port" "$sha" "$db"
}

# The clone is on main, has no local changes, and no .env that could override what
# this script passes explicitly (apps/api/.env is read by the API in development;
# a real SMTP or Resend key there would make a Pinewood stack send real mail).
pw_assert_clone_state() {
  local home="$1" branch
  branch="$(git -C "$home" rev-parse --abbrev-ref HEAD 2>/dev/null)" || pw_refuse "'$home' has no readable git HEAD"
  [ "$branch" = "main" ] || pw_refuse "clone is on '$branch', not main; it only ever follows main"
  [ -z "$(git -C "$home" status --porcelain --untracked-files=no)" ] || pw_refuse "clone has local changes; this script never resets or discards them"
  [ ! -e "$home/apps/api/.env" ] || pw_refuse "$home/apps/api/.env exists; the stack's configuration is passed explicitly and a stray .env could override it. Remove it."
  [ ! -e "$home/apps/web/.env.local" ] || pw_refuse "$home/apps/web/.env.local exists; remove it, the API URL is baked in at build time"
}

# Generated once, mode 600, outside the clone and outside git. Throwaway: these
# protect a local database of fake data, nothing else.
pw_ensure_env_file() {
  local f="$1"
  [ -f "$f" ] && return 0
  command -v openssl >/dev/null 2>&1 || pw_refuse "openssl is needed once, to generate $f"
  mkdir -p "$(dirname "$f")"
  (
    umask 077
    {
      echo "# Throwaway local secrets for the standing Pinewood stack (ticket #1269). Generated; never commit."
      echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
      echo "CONNECTIONS_MASTER_KEY=$(openssl rand -hex 32)"
    } >"$f"
  )
  chmod 600 "$f"
  pw_say "generated $f"
}

# Stop a process THIS script started. A pid file that is stale, or whose pid is now
# something else, is ignored; a foreign process is never signalled.
pw_stop_service() {
  local what="$1" pidfile="$2" home="$3" pid i
  if pid="$(pw_owned_pid "$pidfile" "$home")"; then
    pw_say "  stopping $what (pid $pid)"
    kill "$pid" 2>/dev/null
    for i in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$pidfile"
}

pw_health_check() {
  local api_port="$1" web_port="$2" want_sha="$3" db="$4" i body got code
  for i in $(seq 1 90); do
    body="$(curl -fsS "http://127.0.0.1:$api_port/api/v1/build-info" 2>/dev/null)" && break
    sleep 1
  done
  [ -n "${body:-}" ] || { echo "pinewood: UNHEALTHY: API did not answer on :$api_port (see the api log in the state dir)" >&2; return 1; }
  got="$(printf '%s' "$body" | sed -n 's/.*"commit_sha":"\([^"]*\)".*/\1/p')"
  [ "$got" = "$want_sha" ] || { echo "pinewood: UNHEALTHY: API reports sha '${got:-none}', clone is at $want_sha" >&2; return 1; }
  curl -fsS "http://127.0.0.1:$api_port/healthz" 2>/dev/null | grep -q '"db":"up"' ||
    { echo "pinewood: UNHEALTHY: API is up but /healthz does not report the database up" >&2; return 1; }
  for i in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web_port/" 2>/dev/null)"
    case "$code" in 200 | 301 | 302 | 307 | 308) break ;; esac
    sleep 1
  done
  case "${code:-}" in 200 | 301 | 302 | 307 | 308) ;; *) echo "pinewood: UNHEALTHY: web did not answer on :$web_port (last status ${code:-none})" >&2; return 1 ;; esac
  pw_say "healthy: sha=$(printf '%s' "$want_sha" | cut -c1-9) api=http://localhost:$api_port web=http://localhost:$web_port db=$db"
}

# Called on one line so bash has parsed the whole of this file before the pull in
# step 1 can replace it underneath a running copy.
pinewood_up "$@"; exit $?
