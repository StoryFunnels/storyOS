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
# Prompts live beside this script, so the poller never depends on which branch
# some other checkout happens to be sitting on. setup-agents.sh snapshots both
# here from origin/main; re-run it to refresh.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Resolve a database by its QUALIFIED slug (space/database). apiSlug alone is NOT
# unique across a workspace — there are two `website_tasks` and two `docs` here, so
# matching on it would silently point an agent at the wrong space's database.
# The listing endpoint returns a BARE LIST, not {"data": [...]}.
resolve_db() {
  curl -fsS "${AUTH[@]}" "$API/workspaces/$WS/databases" | python3 -c "
import sys,json
rows=json.load(sys.stdin)
rows=rows.get('data',rows) if isinstance(rows,dict) else rows
print(next((r['id'] for r in rows if r.get('qualifiedSlug')==sys.argv[1]),''))" "$1"
}

# Select / workflow filters take OPTION IDS, not labels — a label 422s with
# 'unknown option id'. Ids are stable but must never be hardcoded, so resolve them.
option_id() {  # option_id <db> <field api_name> <label>
  curl -fsS "${AUTH[@]}" "$API/workspaces/$WS/databases/$1" | python3 -c "
import sys,json
d=json.load(sys.stdin)
fields=d.get('fields') or d.get('data',{}).get('fields') or []
for f in fields:
    if (f.get('api_name') or f.get('apiName')) == sys.argv[1]:
        for o in (f.get('options') or []):
            if o['label']==sys.argv[2]: print(o['id']); break
        break" "$2" "$3"
}

case "$NAME" in
  # queue = issues handed to me via the `agents` relation (relation filters take record ids)
  vera)  DB=$DB_ISSUES; AID=3b2a4d86-3e5e-443f-9d5c-c007a01359e9 ;;
  mira)  DB=$DB_ISSUES; AID=9a87aca3-b386-4a65-9261-b3b378bc936b ;;
  otto)  DB=$DB_ISSUES; AID=03a29f7f-8418-4a7c-86fa-67c27c49eba8 ;;
  iris)  DB=$DB_ISSUES; AID=730795c7-c443-4523-bd63-bbd85e138fec ;;
  marek) DB=$DB_ISSUES; AID=2c4c1654-d9c0-432f-ac04-93a768525b9a ;;
  ada)   DB=$DB_ISSUES; AID=78de44d1-4de3-4c72-b75a-ebd57b0e0445 ;;
  nadia|kai) DB=$DB_SCENARIOS ;;
  lena)  DB=$(resolve_db "storyos/docs_tasks") ;;
  nils)  DB=$(resolve_db "storyos/website_tasks") ;;
  *) log "unknown agent"; exit 1 ;;
esac
[[ -z "${DB:-}" ]] && { log "could not resolve database — not launching"; exit 1; }

case "$NAME" in
  vera|mira|otto|iris|marek|ada)
    Q="{\"filter\":{\"field\":\"agents\",\"op\":\"has\",\"value\":[\"$AID\"]},\"limit\":1}" ;;
  nadia|kai)
    P=$([[ "$NAME" == "nadia" ]] && echo Nadia || echo Kai)
    OPT=$(option_id "$DB" persona "$P")
    [[ -z "$OPT" ]] && { log "could not resolve persona option — not launching"; exit 1; }
    Q="{\"filter\":{\"and\":[{\"field\":\"persona\",\"op\":\"has\",\"value\":[\"$OPT\"]},{\"or\":[{\"field\":\"last_run\",\"op\":\"is_empty\"},{\"field\":\"last_run\",\"op\":\"before\",\"value\":\"$TODAY\"}]}]},\"limit\":1}" ;;
  lena|nils)
    OPT=$(option_id "$DB" state ToDo)
    [[ -z "$OPT" ]] && { log "could not resolve state option — not launching"; exit 1; }
    Q="{\"filter\":{\"field\":\"state\",\"op\":\"has\",\"value\":[\"$OPT\"]},\"limit\":1}" ;;
esac

n=$(curl -fsS -X POST "$API/workspaces/$WS/databases/$DB/records/query" \
      "${AUTH[@]}" -H 'content-type: application/json' -d "$Q" \
    | python3 -c "import sys,json;print(len(json.load(sys.stdin).get('data',[])))") || {
  log "queue check FAILED — not launching"; exit 1; }

[[ "$n" -eq 0 ]] && exit 0

log "queue non-empty — draining"
echo $$ > "$lock"
trap 'rm -f "$lock"' EXIT
# Mira and Otto share the read-only `readers` checkout; everyone else has their own.
if [[ "$NAME" == "mira" || "$NAME" == "otto" ]]; then FOLDER=readers; else FOLDER="$NAME"; fi
cd "$ENVS/$FOLDER" || { log "no folder $ENVS/$FOLDER — run setup-agents.sh first"; exit 1; }
# Unattended: nobody can answer a permission prompt, so a prompt is a hang.
claude --model opus --permission-mode bypassPermissions -p "$(cat "$SELF/$NAME.txt")" >> "$LOGS/$NAME.log" 2>> "$LOGS/$NAME.err"
log "drain finished"
