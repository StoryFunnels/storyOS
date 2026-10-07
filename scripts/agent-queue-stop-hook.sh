#!/usr/bin/env bash
# Stop hook: keep an agent session working through a CURATED ticket queue (#340).
#
# Claude Code runs this when the model finishes a response. If the queue still
# holds work this session can act on, the hook BLOCKS the stop and returns the
# next ticket as the work order; otherwise it allows the stop. It is the
# mechanism behind marek.txt's "what ends a tick" — prose alone lost to the
# instinct that stopping always looks safer than continuing.
#
# OPT-IN. Inert unless the session was launched with STORYOS_QUEUE_HOOK=drain.
# An always-on Stop hook would hijack a person's interactive session in the same
# worktree the moment the model finished answering them.
#
#   STORYOS_QUEUE_HOOK=drain claude ...        # unattended drain
#
# CONFIGURATION (env, or a file named by STORYOS_QUEUE_ENV_FILE that is sourced):
#   STORYOS_TOKEN          required  mn_pat_… token; read scope is enough
#   STORYOS_QUEUE_API      required  e.g. https://app.storyos.dev/api/v1
#   STORYOS_QUEUE_WS       required  workspace id
#   STORYOS_QUEUE_DB       required  the issues database id
#   STORYOS_QUEUE_AGENT    required  this agent's record id (the `agents` relation)
#   STORYOS_QUEUE_CAP      optional  max blocks per session            (default 40)
#   STORYOS_QUEUE_RETRIES  optional  offers of an UNCHANGED ticket before it is
#                                    treated as stuck and skipped     (default 3)
#   STORYOS_QUEUE_STATE_DIR optional where per-session state lives
#
# THE QUEUE is an explicit filter, not "all open tickets" — that predicate would
# drive an agent into human:true tickets and never terminate:
#   agents has <me>  AND  state in {ToDo, In Progress}  AND  human = false
#   AND  acceptance_criteria is not empty
# State and priority are resolved from the database definition at run time:
# filters take option IDS (a label 422s), and ids must never be hardcoded.
#
# STOPS (all of them are an allowed stop, never a silent one):
#   - queue empty
#   - nothing left I can ACT on: every remaining ticket was offered
#     STORYOS_QUEUE_RETRIES times with no change to the record
#   - the per-session block cap
#   - an explicit stop sentinel carrying a reason (a named blocker)
#   - ANY error in this script: it FAILS OPEN with a visible systemMessage,
#     because a broken check must never loop blind.
#
# The counter is keyed on session_id, so a fresh session starts at zero and
# nothing expires with the calendar.
#
# Always exits 0: a Stop hook that exits non-zero is itself a failure mode.

set -uo pipefail

allow() {
  if [ -n "${1:-}" ]; then
    if command -v jq >/dev/null 2>&1; then
      jq -n --arg m "$1" '{systemMessage: $m}'
    else
      printf '{"systemMessage":"queue hook: %s"}\n' "jq missing — allowing stop"
    fi
  fi
  exit 0
}

block() {
  jq -n --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}

fail_open() { allow "Queue hook could not check the queue (${1:-unknown}) — allowing a normal stop."; }

[ "${STORYOS_QUEUE_HOOK:-}" = "drain" ] || exit 0

if [ -n "${STORYOS_QUEUE_ENV_FILE:-}" ] && [ -f "$STORYOS_QUEUE_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$STORYOS_QUEUE_ENV_FILE"
  set +a
fi

command -v jq >/dev/null 2>&1 || fail_open "jq is not installed"
command -v curl >/dev/null 2>&1 || fail_open "curl is not installed"

missing=""
for v in STORYOS_TOKEN STORYOS_QUEUE_API STORYOS_QUEUE_WS STORYOS_QUEUE_DB STORYOS_QUEUE_AGENT; do
  [ -n "${!v:-}" ] || missing="$missing $v"
done
[ -z "$missing" ] || fail_open "missing config:$missing"

input="$(cat)"
sid_raw="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)" || fail_open "stdin was not JSON"
[ -n "$sid_raw" ] || fail_open "no session_id on stdin"
sid="${sid_raw//[^A-Za-z0-9_-]/_}"
hook_active="$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"

STATE="${STORYOS_QUEUE_STATE_DIR:-${TMPDIR:-/tmp}/storyos-queue-hook}"
mkdir -p "$STATE" 2>/dev/null || fail_open "cannot create state dir $STATE"
find "$STATE" -type f -mtime +3 -delete 2>/dev/null
LOG="$STATE/hook.log"
log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$sid" "$*" >> "$LOG" 2>/dev/null; }

CAP="${STORYOS_QUEUE_CAP:-40}"
RETRIES="${STORYOS_QUEUE_RETRIES:-3}"
STOP_FILE="$STATE/$sid.stop"
COUNT_FILE="$STATE/$sid.count"
OFFERED="$STATE/$sid.offered.json"

if [ -s "$STOP_FILE" ]; then
  reason="$(head -c 300 "$STOP_FILE")"
  log "allow: explicit stop — $reason"
  allow "Session ended by an explicit stop: $reason"
fi

count=0
[ -f "$COUNT_FILE" ] && count="$(cat "$COUNT_FILE" 2>/dev/null)"
case "$count" in '' | *[!0-9]*) count=0 ;; esac
if [ "$count" -ge "$CAP" ]; then
  log "allow: cap of $CAP reached"
  allow "Queue hook: reached the cap of $CAP continuations this session — stopping. Raise STORYOS_QUEUE_CAP to go further."
fi

api_get() { # api_get <path> <outfile>
  curl -sS --max-time 10 -o "$2" -w '%{http_code}' \
    -H "Authorization: Bearer $STORYOS_TOKEN" "$STORYOS_QUEUE_API/workspaces/$STORYOS_QUEUE_WS/$1" 2>/dev/null
}

tmp="$(mktemp -d "$STATE/run.XXXXXX")" || fail_open "cannot create a temp dir"
trap 'rm -rf "$tmp"' EXIT

code="$(api_get "databases/$STORYOS_QUEUE_DB" "$tmp/db.json")" || fail_open "could not reach the API"
case "$code" in 2*) ;; *) fail_open "database lookup returned HTTP $code" ;; esac

opts="$(jq -c '
  (.data // .) as $d
  | def opt($f; $l): ($d.fields[] | select((.apiName // .api_name) == $f) | .options[] | select(.label == $l) | .id);
  { todo: opt("state"; "ToDo"), inprogress: opt("state"; "In Progress"),
    prio: ([ $d.fields[] | select((.apiName // .api_name) == "priority") | .options[] ]
           | map({(.id): ({"Low":1,"Medium":2,"High":3,"Urgent":4}[.label] // 0)}) | add // {}) }
' "$tmp/db.json" 2>/dev/null)" || fail_open "could not read state/priority options"
[ -n "$opts" ] || fail_open "state/priority options not found"

body="$(jq -n --argjson o "$opts" --arg agent "$STORYOS_QUEUE_AGENT" '
  { filter: { and: [
      { field: "agents", op: "has", value: [$agent] },
      { field: "state",  op: "has", value: [$o.todo, $o.inprogress] },
      { field: "human",  op: "eq",  value: false },
      { field: "acceptance_criteria", op: "not_empty" } ] },
    limit: 50 }')" || fail_open "could not build the queue filter"

code="$(curl -sS --max-time 10 -o "$tmp/q.json" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $STORYOS_TOKEN" -H 'content-type: application/json' -d "$body" \
  "$STORYOS_QUEUE_API/workspaces/$STORYOS_QUEUE_WS/databases/$STORYOS_QUEUE_DB/records/query" 2>/dev/null)" \
  || fail_open "could not reach the API"
case "$code" in
  2*) ;;
  *) fail_open "queue query returned HTTP $code: $(jq -r '.error.message // empty' "$tmp/q.json" 2>/dev/null | head -c 120)" ;;
esac

[ -f "$OFFERED" ] || echo '{}' > "$OFFERED"
# Highest priority first, oldest first within a priority. A ticket's `seen` count
# only carries while its record is UNCHANGED (same updated_at): any edit is
# progress, and resets it.
pick="$(jq -c --slurpfile off "$OFFERED" --argjson max "$RETRIES" --argjson o "$opts" '
  ($off[0] // {}) as $seen
  | [ (.data // [])[]
      | { number, title, updated_at, created_at, rank: ($o.prio[.values.priority] // 0) } ]
  | sort_by(-.rank, .created_at)
  | map(. as $c | $c + { seen: (($seen[($c.number | tostring)] // {}) as $s
                                | if $s.u == $c.updated_at then $s.n else 0 end) })
  | { total: length,
      next: (map(select(.seen < $max)) | .[0]),
      stuck: (map(select(.seen >= $max) | .number)) }
' "$tmp/q.json" 2>/dev/null)" || fail_open "could not rank the queue"

total="$(printf '%s' "$pick" | jq -r '.total')"
next_json="$(printf '%s' "$pick" | jq -c '.next')"
stuck="$(printf '%s' "$pick" | jq -r '.stuck | map("#" + tostring) | join(", ")')"

if [ "$total" = "0" ]; then
  log "allow: queue empty (hook_active=$hook_active)"
  allow "Queue empty — nothing left in this agent's curated queue. Stopping cleanly."
fi

if [ "$next_json" = "null" ]; then
  log "allow: nothing actionable — offered $RETRIES times with no change: $stuck"
  allow "Queue hook: nothing left I can act on. Every remaining ticket was offered $RETRIES times with no change to the record: $stuck. Stopping rather than cycling."
fi

num="$(printf '%s' "$next_json" | jq -r '.number')"
title="$(printf '%s' "$next_json" | jq -r '.title')"
upd="$(printf '%s' "$next_json" | jq -r '.updated_at')"
seen="$(printf '%s' "$next_json" | jq -r '.seen')"
rank="$(printf '%s' "$next_json" | jq -r '.rank')"
case "$rank" in 4) plabel=Urgent ;; 3) plabel=High ;; 2) plabel=Medium ;; 1) plabel=Low ;; *) plabel="?" ;; esac

if jq --arg k "$num" --arg u "$upd" --argjson n "$((seen + 1))" '.[$k] = {u: $u, n: $n}' "$OFFERED" > "$tmp/off.json"; then
  mv "$tmp/off.json" "$OFFERED" || fail_open "could not record the offer"
else
  fail_open "could not record the offer"
fi
count=$((count + 1))
echo "$count" > "$COUNT_FILE" || fail_open "could not write the counter"
log "block: #$num offered (seen $((seen + 1))/$RETRIES, block $count/$CAP, queue $total, stuck: ${stuck:-none})"

reason="$(cat <<EOF
QUEUE WORK ORDER — continuation $count of at most $CAP. $total ticket(s) in your queue${stuck:+; skipped as stuck: $stuck}.

NEXT: #$num — $title   [$plabel]
Read it in full (workspace "JCM Agency", database storyos/issues), re-verify its premise against origin/main BEFORE writing code, then claim it by setting it In Progress.

This queue is curated: routed to you, ToDo or In Progress, human = false, with acceptance criteria. It is not "everything open".

GUARDRAILS — they apply even if you remember nothing else of this session:
- Never work a human:true ticket. Website tickets live in a separate repo you stay out of.
- A ticket that needs a decision you cannot make: MOVE it out of your queue (route it to its owner or back to Backlog, with a comment saying why). Do not guess, and do not stop.
- One drizzle migration in flight across all open PRs. Never hand-merge docs/api/openapi.json or the generated SDK.
- Backend claims need tests; UI claims need a live browser check. The PR says what was verified and what was not.
- Docs and website companions are part of done.
- Builders do not merge. Open the PR, wait for green, record what you did and did not verify, set agents to Vera, move to the next ticket.
- Re-read the ticket before opening the PR; acceptance criteria get rewritten mid-build.

ENDING: the hook ends this loop when the queue is empty or nothing in it can be acted on. If you are blocked on something NAMED that you cannot act on, write the reason (what, and who owns it) to:
  $STOP_FILE
then stop. A session ended any other way is not an ended session.
EOF
)"
block "$reason"
