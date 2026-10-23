# StoryOS recovery-point manifest helpers (#891). Sourced, not run.
#
# manifest.env is DATA, not a script. It used to be `source`d, and backup.sh
# wrote `ATTACHMENTS=local volume <name>` unquoted — bash read that as "run the
# command `volume`", and `set -e` killed restore.sh on every local-driver
# backup. So it is written quoted (manifest_line) and read as text
# (manifest_get), which also reads the unquoted manifests already on disk.

# manifest_line KEY VALUE — one KEY='value' line; a ' inside the value is escaped
# the way bash would, so the file stays safe to source by hand.
manifest_line() {
  local q="'\\''"
  printf "%s='%s'\n" "$1" "${2//\'/$q}"
}

# manifest_get FILE KEY — the value of the LAST KEY= line, or nothing. Accepts
# 'single', "double" and bare (legacy, possibly containing spaces) values.
manifest_get() {
  local line q="'\\''"
  line="$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  line="${line#*=}"
  case "$line" in
    \'*\') line="${line#\'}"; line="${line%\'}"; line="${line//"$q"/\'}" ;;
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
  esac
  printf '%s\n' "$line"
}
