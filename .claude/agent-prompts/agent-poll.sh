#!/usr/bin/env bash
# Hourly queue check. Costs ONE http call when there is nothing to do; starts a
# Claude session only when this agent's backlog is non-empty. That session then
# drains the queue — it does not stop after one item.
#
#   agent-poll.sh <agent>
#
# The only guard is the lock: one run per agent at a time. Combined with the
# hourly cadence that bounds everything without capping useful work.
set -euo pipefail

NAME="${1:?usage: agent-poll.sh <agent>}"
REPO="${REPO:-$HOME/Documents/storyOS}"
ENVS="${ENVS:-$HOME/storyos-envs}"
API="https://app.storyos.dev/api/v1"
WS="3448c14b-70f3-41bc-9188-839029be9f7e"
DB_ISSUES="3f743dcd-d5ca-47c0-a676-72f40934119b"
DB_SCENARIOS="d11d687e-4b82-451e-943d-5fdbc8fabb8d"
LOCKS="$ENVS/.locks"; LOGS="$ENVS/logs"
mkdir -p "$LOCKS" "$LOGS"
log() { echo "$(date '+%F %T') [$NAME] $*" >> "$LOGS/$NAME.poll.log"; }

# never overlap a run with itself — a drain can outlast the hour
lock="$LOCKS/$NAME.lock"
if [[ -f "$lock" ]] && kill -0 "$(cat "$lock" 2>/dev/null)" 2>/dev/null; then
  log "still draining (pid $(cat "$lock")), skipping"; exit 0
fi
rm -f "$lock"

set -a; . "$ENVS/$NAME.env"; set +a
: "${STORYOS_TOKEN:?no STORYOS_TOKEN in $ENVS/$NAME.env}"
AUTH=(-H "Authorization: Bearer $STORYOS_TOKEN")
TODAY=$(date +%F)

case "$NAME" in
  # queue = issues handed to me via the `agents` relation
  vera)  DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["3b2a4d86-3e5e-443f-9d5c-c007a01359e9"]},"limit":1}' ;;
  mira)  DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["9a87aca3-b386-4a65-9261-b3b378bc936b"]},"limit":1}' ;;
  otto)  DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["03a29f7f-8418-4a7c-86fa-67c27c49eba8"]},"limit":1}' ;;
  iris)  DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["730795c7-c443-4523-bd63-bbd85e138fec"]},"limit":1}' ;;
  marek) DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["2c4c1654-d9c0-432f-ac04-93a768525b9a"]},"limit":1}' ;;
  ada)   DB=$DB_ISSUES; Q='{"filter":{"field":"agents","op":"has","value":["78de44d1-4de3-4c72-b75a-ebd57b0e0445"]},"limit":1}' ;;
  # queue = scenarios not yet run today
  nadia|kai)
    P=$([[ "$NAME" == "nadia" ]] && echo Nadia || echo Kai)
    DB=$DB_SCENARIOS
    Q="{\"filter\":{\"and\":[{\"field\":\"persona\",\"op\":\"has\",\"value\":[\"$P\"]},{\"or\":[{\"field\":\"last_run\",\"op\":\"is_empty\"},{\"field\":\"last_run\",\"op\":\"before\",\"value\":\"$TODAY\"}]}]},\"limit\":1}" ;;
  # queue = everything ToDo in the database they own outright
  lena|nils)
    slug=$([[ "$NAME" == "lena" ]] && echo docs_tasks || echo website_tasks)
    DB=$(curl -fsS "${AUTH[@]}" "$API/workspaces/$WS/databases" \
         | python3 -c "import sys,json;print(next(d['id'] for d in json.load(sys.stdin)['data'] if d['apiSlug']=='$slug'))")
    Q='{"filter":{"field":"state","op":"has","value":["ToDo"]},"limit":1}' ;;
  *) log "unknown agent"; exit 1 ;;
esac

n=$(curl -fsS -X POST "$API/workspaces/$WS/databases/$DB/records/query" \
      "${AUTH[@]}" -H 'content-type: application/json' -d "$Q" \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('data',[])))") || {
  log "queue check FAILED — not launching"; exit 1; }

[[ "$n" -eq 0 ]] && exit 0

log "queue non-empty — draining"
echo $$ > "$lock"
trap 'rm -f "$lock"' EXIT
cd "$ENVS/$(case "$NAME" in mira|otto) echo readers;; *) echo "$NAME";; esac)"
claude --model opus -p "$(cat "$REPO/.claude/agent-prompts/$NAME.txt")" >> "$LOGS/$NAME.log" 2>> "$LOGS/$NAME.err"
log "drain finished"
