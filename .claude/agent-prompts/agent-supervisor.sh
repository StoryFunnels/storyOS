#!/usr/bin/env bash
# Hourly scheduler for all ten agents — started BY HAND from a Terminal.
#
# Why not launchd: macOS TCC does not give launchd agents access to ~/Documents,
# where the repo and the website checkout live. A launchd job fails with
# "Operation not permitted" on files you can read perfectly well yourself.
# TCC is inherited from the responsible process, so a scheduler started from
# your Terminal keeps Terminal's grant and everything works.
#
#   ./agent-supervisor.sh start     # begins polling, detaches, survives closing the window
#   ./agent-supervisor.sh status    # is it alive, and what did each agent last do
#   ./agent-supervisor.sh stop
#   ./agent-supervisor.sh once      # one pass right now, in the foreground
#
# Must be started from a Terminal, NOT from launchd — that is the entire point.
set -uo pipefail

ENVS="${ENVS:-$HOME/storyos-envs}"
BIN="$ENVS/bin"
LOGS="$ENVS/logs"
PIDFILE="$ENVS/.supervisor.pid"
INTERVAL="${INTERVAL:-3600}"
AGENTS=(nadia kai vera mira otto iris marek ada lena nils)
mkdir -p "$LOGS"

pass() {
  echo "$(date '+%F %T') --- pass start ---" >> "$LOGS/supervisor.log"
  for a in "${AGENTS[@]}"; do
    # Each poller exits in milliseconds unless its queue has work, and holds its
    # own lock, so launching them together is safe and keeps a slow drain from
    # blocking everyone behind it.
    "$BIN/agent-poll.sh" "$a" >> "$LOGS/supervisor.log" 2>&1 &
  done
  wait
  echo "$(date '+%F %T') --- pass done ---" >> "$LOGS/supervisor.log"
}

running() { [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

case "${1:-}" in
  start)
    running && { echo "already running (pid $(cat "$PIDFILE"))"; exit 0; }
    [[ -x "$BIN/agent-poll.sh" ]] || { echo "no poller at $BIN — run setup-agents.sh first"; exit 1; }
    nohup "$0" __loop >> "$LOGS/supervisor.out" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 1
    running && echo "started (pid $(cat "$PIDFILE")) — polling every ${INTERVAL}s" \
             || { echo "failed to start; see $LOGS/supervisor.out"; exit 1; }
    ;;
  __loop)
    trap 'rm -f "$PIDFILE"; exit 0' TERM INT
    while true; do pass; sleep "$INTERVAL"; done
    ;;
  stop)
    running || { echo "not running"; exit 0; }
    kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" && echo "stopped"
    ;;
  status)
    running && echo "supervisor: RUNNING (pid $(cat "$PIDFILE"))" || echo "supervisor: not running"
    echo
    printf "  %-7s %s\n" AGENT "LAST POLL"
    for a in "${AGENTS[@]}"; do
      printf "  %-7s %s\n" "$a" "$(tail -1 "$LOGS/$a.poll.log" 2>/dev/null | cut -c1-96 || echo 'never polled')"
    done
    ;;
  once) pass; echo "one pass complete — see $LOGS/supervisor.log"; ;;
  *) sed -n '3,18p' "$0"; exit 1 ;;
esac
