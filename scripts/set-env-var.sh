#!/usr/bin/env bash
# Set ONE variable in the server's ~/storyOS/.env (#1292). Run on the box by the
# deploy workflow, which pipes this file to `bash -s` over ssh:
#
#   ssh prod "bash -s -- MAIL_FROM <base64 of the value>" < scripts/set-env-var.sh
#
# usage: set-env-var.sh KEY [VALUE_BASE64 [ENV_FILE]]      (ENV_FILE: ~/storyOS/.env)
#
# Why it looks like this, each line is a guard with a test in
# scripts/set-env-var.test.mjs:
#  - The value travels base64-encoded, so nothing in `< > @ " & / \` or a space is
#    ever parsed by the runner's shell, ssh, or the box's login shell.
#  - A blank or missing value writes NOTHING (exit 0): "variable not set in the
#    GitHub environment" must never wipe the sender already on the box.
#  - No sed: the replacement text of `s///` treats `&` and `\` specially. The old
#    line is dropped with grep -v, and the new one appended single-quoted, which
#    both bash and `docker compose` read literally.
#  - The value is refused (file untouched) if it holds a newline, a quote, `$`,
#    a backslash or a backtick, and MAIL_FROM must be an ASCII sender address
#    (so a full-width ＠ or ＜＞ pasted from a chat is caught here, not by a
#    provider rejecting mail in production).
#  - Existing lines are never printed, and neither is the value: this file holds
#    BETTER_AUTH_SECRET and CONNECTIONS_MASTER_KEY.
#  - The file keeps its mode, is replaced via a temp file in the same folder,
#    and is never created: a missing .env means the wrong box or folder.
set -euo pipefail

usage() { echo "usage: set-env-var.sh KEY [VALUE_BASE64 [ENV_FILE]]" >&2; exit 2; }

[ $# -ge 1 ] && [ $# -le 3 ] || usage
key=$1
b64=${2:-}
file=${3:-$HOME/storyOS/.env}

[[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "set-env-var: '$key' is not an UPPER_SNAKE variable name" >&2; exit 2; }

# Unset / blank: leave the box alone.
if [ -z "$b64" ]; then echo "$key: no value given, unchanged"; exit 0; fi
[[ "$b64" =~ ^[A-Za-z0-9+/]*={0,2}$ ]] || { echo "set-env-var: $key value is not base64" >&2; exit 2; }

# The trailing x keeps $(...) from eating trailing newlines, so they are caught below.
value=$(set -o pipefail; printf '%s' "$b64" | base64 -d 2>/dev/null && printf x) || { echo "set-env-var: $key value is not base64" >&2; exit 2; }
value=${value%x}

if [[ "$value" =~ ^[[:space:]]*$ ]]; then echo "$key: value is blank, unchanged"; exit 0; fi

# Anything that could end the quoted string, start an expansion, or start a new line.
if [[ "$value" == *"'"* || "$value" == *'$'* || "$value" == *'\'* || "$value" == *'`'* || "$value" == *$'\n'* ]] \
  || LC_ALL=C grep -q '[[:cntrl:]]' <<<"$value"; then
  echo "set-env-var: $key value holds a quote, \$, backslash, backtick, newline or control character; refusing" >&2
  exit 1
fi

if [ "$key" = MAIL_FROM ]; then
  # `Name <addr@host.tld>` or a bare `addr@host.tld`; ASCII only in the address, so
  # a full-width ＠ never gets this far. Mirrors apps/api/src/mail/mail-from.ts.
  addr='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
  if ! LC_ALL=C grep -Eq "^(([^<>]*[^<>[:space:]])?[[:space:]]*<${addr}>|${addr})$" <<<"$value"; then
    echo "set-env-var: MAIL_FROM must be 'Name <name@host.tld>' or 'name@host.tld' with an ASCII @; refusing" >&2
    exit 1
  fi
fi

[ -f "$file" ] || { echo "set-env-var: $file does not exist; refusing to create it" >&2; exit 1; }

tmp=$(mktemp "$file.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp -p "$file" "$tmp"
{
  # grep exits 1 when nothing is kept (an empty result is fine); the pattern also
  # drops `export KEY=`. It leaves `# KEY=` comments and KEY_SUFFIX= alone.
  grep -vE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" || true
  printf "%s='%s'\n" "$key" "$value"
} > "$tmp"

if cmp -s "$file" "$tmp"; then echo "$key: already up to date"; exit 0; fi
mv "$tmp" "$file"
trap - EXIT
echo "$key: updated"
