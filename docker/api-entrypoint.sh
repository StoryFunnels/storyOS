#!/bin/sh
# StoryOS API entrypoint (#1239). The server itself runs as the unprivileged `node` user.
#
# Installs from before this change have an attachments volume whose files are owned by root, which `node` could not
# write. So when the container starts as root (the default), hand the attachments directory to `node` first, then drop
# privileges for good. If the operator already runs the container as another user (`user:` in compose), there is
# nothing to fix up and nothing to drop.
set -eu

if [ "$(id -u)" = "0" ]; then
  dir="${ATTACHMENTS_DIR:-./data/attachments}"
  case "$dir" in
    /|/bin|/etc|/usr|/proc|/sys|/dev) echo "api-entrypoint: refusing to chown ATTACHMENTS_DIR=$dir" >&2; exit 1 ;;
  esac
  mkdir -p "$dir"
  # Only walk the tree when something in it is not node's yet (a one-time cost on the first boot after upgrading).
  if [ -n "$(find "$dir" ! -user node -print -quit)" ]; then
    echo "api-entrypoint: giving $dir to the node user"
    chown -R node:node "$dir"
  fi
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all -- "$@"
fi

exec "$@"
