#!/usr/bin/env bash
# Ticket #1269 — shared guards for the standing local Pinewood stack.
#
# SOURCED by pinewood-up.sh, pinewood-template.sh and pinewood-rig.sh; never run
# directly. Written for macOS bash 3.2 (no associative arrays, no ${var,,}).
#
# WHY EVERY ONE OF THESE IS A REFUSAL AND NOT A WARNING. The failure this stack
# can produce is not a crash, it is a quiet write to the wrong database or the
# wrong checkout:
#   * a fresh worktree has no apps/api/.env, so db:migrate used to fall back to
#     the shared founder database (#629);
#   * `umh_analytics` lives on the same Postgres and belongs to another project;
#   * an agent's worktree is somebody's live session, and `git pull` in it moves
#     the branch out from under them.
# So each guard names its refusal, exits 2, and is covered by a test that was
# mutation-checked (scripts/pinewood.test.mjs). Guards are plain functions so the
# test can also call them directly.
#
# The local Postgres is reached over the same connection every other StoryOS dev
# database uses: host localhost, the current OS user, no password.

pw_say() { echo "pinewood: $*"; }

pw_refuse() {
  echo "pinewood: REFUSED: $*" >&2
  exit 2
}

# Databases this tooling must never touch, whatever else matches. `storyos` is the
# shared founder dev database (the silent fallback in apps/api/.env.example).
PW_PROTECTED_DBS=" postgres template0 template1 umh_analytics storyos "

pw_is_protected_db() {
  case "$PW_PROTECTED_DBS" in *" $1 "*) return 0 ;; esac
  return 1
}

# The standing stack's own databases: storyos_pinewood, optionally with a suffix
# (the tests use storyos_pinewood_<something>). Nothing else is ever migrated or
# seeded by pinewood-up.sh.
pw_assert_stack_db() {
  pw_is_protected_db "$1" && pw_refuse "database '$1' is protected; this tool only touches storyos_pinewood*"
  case "$1" in
    storyos_pinewood | storyos_pinewood_[a-z0-9_]*) ;;
    *) pw_refuse "database '$1' is not a pinewood-named database (expected storyos_pinewood or storyos_pinewood_*)" ;;
  esac
  pw_assert_ident "$1"
}

# The template database rigs are cloned from. The only database any pinewood
# script is ever allowed to DROP.
pw_assert_template_db() {
  pw_is_protected_db "$1" && pw_refuse "database '$1' is protected; this tool only touches storyos_agency_tpl*"
  case "$1" in
    storyos_agency_tpl | storyos_agency_tpl_[a-z0-9_]*) ;;
    *) pw_refuse "database '$1' is not a template database (expected storyos_agency_tpl or storyos_agency_tpl_*)" ;;
  esac
  pw_assert_ident "$1"
}

# A rig database: storyos_<rig>. It may be anything an agent names, except the
# standing stack, the template, or a protected database.
pw_assert_rig_db() {
  pw_is_protected_db "$1" && pw_refuse "database '$1' is protected"
  case "$1" in
    storyos_pinewood | storyos_pinewood_* | storyos_agency_tpl | storyos_agency_tpl_*)
      pw_refuse "'$1' is the standing stack or the template, not a rig" ;;
    storyos_[a-z0-9]*) ;;
    *) pw_refuse "rig database '$1' must be named storyos_<rig>" ;;
  esac
  pw_assert_ident "$1"
}

# Lower-case letters, digits, underscore; short. Keeps a database name safe to put
# into a URL and a shell argument without quoting games.
pw_assert_ident() {
  case "$1" in
    *[!a-z0-9_]* | "") pw_refuse "'$1' is not a plain lower-case identifier" ;;
  esac
  [ "${#1}" -le 50 ] || pw_refuse "'$1' is longer than 50 characters"
}

# Postgres must be on this machine.
pw_assert_local_host() {
  case "$1" in
    localhost | 127.0.0.1 | ::1) ;;
    *) pw_refuse "Postgres host '$1' is not local (localhost, 127.0.0.1 or ::1 only)" ;;
  esac
}

# Ports: numeric, unprivileged, not the ordinary dev ports (3000/3001 are what
# every worktree rig and `pnpm dev` use), and the two must differ.
pw_assert_port() {
  local what="$1" port="$2"
  case "$port" in
    "" | *[!0-9]*) pw_refuse "$what port '$port' is not a number" ;;
  esac
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || pw_refuse "$what port $port is outside 1024-65535"
  case "$port" in
    3000 | 3001) pw_refuse "$what port $port is the ordinary dev port; the standing stack must not collide with worktree rigs" ;;
  esac
}

# Build the connection string ourselves, always. An inherited DATABASE_URL is never
# trusted: it is whatever the calling shell last exported, which is exactly how a
# migrate lands on the wrong database.
pw_db_url() {
  local db="$1"
  echo "postgres://${PW_PGUSER}@${PW_PGHOST}:${PW_PGPORT}/${db}"
}

# THE choke point: every child process that touches a database runs through here,
# so the name and host are re-checked immediately before DATABASE_URL is handed
# over, whatever the caller thought it had validated earlier.
#   pw_run_with_db <stack|template|rig> <dbname> [VAR=value ...] <command...>
pw_check_db() {
  local kind="$1" db="$2"
  case "$kind" in
    stack) pw_assert_stack_db "$db" ;;
    template) pw_assert_template_db "$db" ;;
    rig) pw_assert_rig_db "$db" ;;
    *) pw_refuse "internal: unknown database kind '$kind'" ;;
  esac
  pw_assert_local_host "$PW_PGHOST"
}

pw_run_with_db() {
  local kind="$1" db="$2"
  shift 2
  pw_check_db "$kind" "$db"
  # `env -i`: the child sees PATH, HOME, the DATABASE_URL built here and whatever
  # VAR=value words the caller put in front of the command. Nothing else — so a
  # RESEND_API_KEY, STRIPE_SECRET_KEY or DATABASE_URL exported in the calling shell
  # cannot reach a Pinewood process.
  env -i PATH="$PATH" HOME="$HOME" TERM="${TERM:-dumb}" DATABASE_URL="$(pw_db_url "$db")" "$@"
}

# Where Postgres is. Always the local one, always the current OS user.
pw_load_pg_config() {
  PW_PGHOST="${PINEWOOD_PGHOST:-localhost}"
  PW_PGPORT="${PINEWOOD_PGPORT:-5432}"
  PW_PGUSER="${PINEWOOD_PGUSER:-$(whoami)}"
  pw_assert_local_host "$PW_PGHOST"
  case "$PW_PGPORT" in "" | *[!0-9]*) pw_refuse "Postgres port '$PW_PGPORT' is not a number" ;; esac
  pw_assert_ident "$PW_PGUSER"
}

pw_psql() { psql -h "$PW_PGHOST" -p "$PW_PGPORT" -U "$PW_PGUSER" -X -q -v ON_ERROR_STOP=1 "$@"; }

pw_db_exists() {
  [ "$(pw_psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]
}

# The clone the stack runs from must be its OWN clone: named pinewood*, never inside
# a worktrees directory, and (when it exists) a real clone — `.git` a directory.
# In a git worktree `.git` is a one-line FILE pointing at the main checkout, which is
# precisely how to tell "somebody's session" from "our clone".
pw_assert_clone_dir() {
  local dir="$1"
  case "$dir" in
    /*) ;;
    *) pw_refuse "clone path '$dir' is not absolute" ;;
  esac
  case "$dir" in
    */.claude/worktrees/* | */.claude/worktrees) pw_refuse "'$dir' is inside a worktrees directory; the stack needs its own clone" ;;
  esac
  case "$(basename "$dir")" in
    pinewood*) ;;
    *) pw_refuse "clone directory '$(basename "$dir")' is not pinewood-named" ;;
  esac
  if [ -e "$dir" ]; then
    [ -d "$dir/.git" ] || pw_refuse "'$dir' is not its own clone (.git is not a directory; is it a worktree?)"
    local top
    top="$(cd "$dir" && git rev-parse --show-toplevel 2>/dev/null)" || pw_refuse "'$dir' is not a git repository"
    [ "$(cd "$top" && pwd -P)" = "$(cd "$dir" && pwd -P)" ] || pw_refuse "'$dir' is inside another repository ($top)"
  fi
}

# --- processes and ports -----------------------------------------------------

pw_port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pw_pid_cwd() {
  if [ -r "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd"
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}

# A pid this stack started: it is in our pid file, it is alive, and its working
# directory is inside the clone. (Next renames its process title, so the command
# line cannot be used to recognise it.)
pw_owned_pid() {
  local pidfile="$1" home="$2" pid cwd
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null)"
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  cwd="$(pw_pid_cwd "$pid")"
  case "$cwd" in "$home" | "$home"/*) echo "$pid"; return 0 ;; esac
  return 1
}

# Free, or held by our own process. Anything else is somebody else's service and is
# never killed.
pw_assert_port_free_or_ours() {
  local what="$1" port="$2" pidfile="$3" home="$4"
  pw_port_busy "$port" || return 0
  pw_owned_pid "$pidfile" "$home" >/dev/null && return 0
  pw_refuse "$what port $port is held by a process this stack did not start; not touching it"
}
