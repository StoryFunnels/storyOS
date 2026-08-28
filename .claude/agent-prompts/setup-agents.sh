#!/usr/bin/env bash
# Stand up the nine agent environments. READ THIS BEFORE RUNNING IT.
#
# What it does:            creates 9 git worktrees, 6 postgres databases, 10 launchd jobs
# What it does NOT do:     mint tokens (yours), touch production, delete anything
# Idempotent:              re-running skips what already exists
# Undo:                    setup-agents.sh --uninstall   (removes launchd jobs only)
set -euo pipefail

REPO="${REPO:-$HOME/Documents/storyOS}"
WEBSITE="${WEBSITE:-$HOME/Documents/storyos-website}"
ENVS="${ENVS:-$HOME/storyos-envs}"
PGUSER_LOCAL="$(whoami)"
LOGS="$ENVS/logs"

# agent | folder | branch | api port | web port | postgres db | cron (min hour)
AGENTS=(
  "nadia|nadia|main|3011|3010|storyos_nadia"
  "kai|kai|main|3021|3020|storyos_kai"
  "vera|vera|main|3031|3030|storyos_vera"
  "mira|readers|main|-|-|-"
  "otto|readers|main|-|-|-"
  "iris|iris|web/agent-lane|3041|3040|storyos_iris"
  "marek|marek|api/agent-lane|3051|3050|storyos_marek"
  "ada|ada|mcp/agent-lane|3061|3060|storyos_ada"
  "lena|lena|docs/agent-lane|-|-|-"
  "nils|nils|-|-|-|-"
)

usage() { echo "usage: $0 [--uninstall]"; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  for row in "${AGENTS[@]}"; do
    IFS='|' read -r name _ _ _ _ _ <<< "$row"
    launchctl bootout "gui/$(id -u)/dev.storyos.agent.$name" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/dev.storyos.agent.$name.plist"
  done
  echo "launchd jobs removed. Worktrees and databases left untouched — remove those by hand."
  exit 0
fi
[[ $# -gt 0 ]] && usage

command -v psql   >/dev/null || { echo "postgres not on PATH"; exit 1; }
command -v claude >/dev/null || { echo "claude not on PATH"; exit 1; }
[[ -d "$REPO/.git" ]] || { echo "no repo at $REPO"; exit 1; }

mkdir -p "$ENVS" "$LOGS"

echo "==> worktrees"
git -C "$REPO" fetch -q origin
for row in "${AGENTS[@]}"; do
  IFS='|' read -r name folder branch _ _ _ <<< "$row"
  [[ "$name" == "nils" ]] && continue
  dir="$ENVS/$folder"
  [[ -d "$dir" ]] && { echo "    $folder exists, skipping"; continue; }
  if [[ "$branch" == "main" ]]; then
    git -C "$REPO" worktree add "$dir" origin/main --detach
  else
    git -C "$REPO" worktree add -b "$branch" "$dir" origin/main
  fi
  echo "    $folder -> $branch"
done

# Nils works in the website repo, not a worktree of the monorepo.
if [[ -d "$WEBSITE/.git" ]]; then
  ln -sfn "$WEBSITE" "$ENVS/nils"
  echo "    nils -> symlink to $WEBSITE"
else
  echo "    WARNING: $WEBSITE not found — Nils will have no checkout"
fi

echo "==> databases"
for row in "${AGENTS[@]}"; do
  IFS='|' read -r name _ _ _ _ db <<< "$row"
  [[ "$db" == "-" ]] && continue
  if psql -lqt | cut -d'|' -f1 | grep -qw "$db"; then
    echo "    $db exists, skipping"
  else
    createdb "$db" && echo "    created $db"
  fi
done

echo "==> per-env config"
for row in "${AGENTS[@]}"; do
  IFS='|' read -r name folder _ api web db <<< "$row"
  dir="$ENVS/$folder"
  [[ -d "$dir" ]] || continue
  # Token file — YOU fill these in. Never committed.
  tok="$ENVS/$name.env"
  if [[ ! -f "$tok" ]]; then
    { echo "# Paste this agent's StoryOS API token (scope=write, NOT admin)."
      echo "STORYOS_TOKEN="
      [[ "$db"  != "-" ]] && echo "DATABASE_URL=postgres://$PGUSER_LOCAL@localhost:5432/$db"
      [[ "$web" != "-" ]] && echo "WEB_URL=http://localhost:$web"   # CORS needs this exact origin
      [[ "$api" != "-" ]] && echo "API_URL=http://localhost:$api"
      [[ "$web" != "-" ]] && echo "PORT=$api"
    } > "$tok"
    chmod 600 "$tok"
    echo "    wrote $tok (TOKEN IS EMPTY — fill it in)"
  fi
done

echo "==> runtime snapshot"
# The poller and prompts are copied out of origin/main into a location that no
# branch checkout can invalidate. Nils's folder is the website repo and has no
# .claude/ at all, so a per-worktree path would not work for him either.
mkdir -p "$ENVS/bin"
for f in agent-poll.sh _shared.md nadia.txt kai.txt vera.txt mira.txt otto.txt \
         iris.txt marek.txt ada.txt lena.txt nils.txt; do
  git -C "$REPO" show "origin/main:.claude/agent-prompts/$f" > "$ENVS/bin/$f"
done
chmod +x "$ENVS/bin/agent-poll.sh"
echo "    snapshotted poller + 10 prompts from origin/main to $ENVS/bin"

echo "==> launchd jobs"
for row in "${AGENTS[@]}"; do
  IFS='|' read -r name folder _ _ _ _ <<< "$row"
  plist="$HOME/Library/LaunchAgents/dev.storyos.agent.$name.plist"
  # StartInterval fires hourly while the machine is awake, and once on wake if a
  # firing was missed. agent-poll.sh exits in milliseconds unless there is work,
  # so the hourly cost is one HTTP call — not a Claude session.
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.storyos.agent.$name</string>
  <key>WorkingDirectory</key><string>$ENVS/$folder</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>REPO</key><string>$REPO</string>
    <key>ENVS</key><string>$ENVS</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>exec "$ENVS/bin/agent-poll.sh" $name</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGS/$name.launchd.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$name.launchd.err</string>
</dict></plist>
PLIST
  echo "    $name — hourly while the machine is on"
done

cat <<'DONE'

==> written, NOT started.

Before loading anything:
  1. Fill STORYOS_TOKEN in each ~/storyos-envs/<agent>.env  (scope=write, never admin)
  2. Run migrations in each env that has a DATABASE_URL:  pnpm db:migrate
  3. Seed nadia and kai:  pnpm seed:agent-uat --persona nadia   (separate ticket — not yet built)

Start ONE agent and watch it before loading the rest:
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.storyos.agent.vera.plist
  launchctl kickstart -k gui/$(id -u)/dev.storyos.agent.vera     # run it now
  tail -f ~/storyos-envs/logs/vera.log

Remove all jobs:  ./setup-agents.sh --uninstall
DONE
