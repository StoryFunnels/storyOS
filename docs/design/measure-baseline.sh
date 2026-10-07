#!/usr/bin/env bash
# Design-system baseline metrics for apps/web (ticket #623).
#
# The numbers in docs/design/audit-2026-09-08.md came from this script. It exists
# so the baseline is RE-RUNNABLE rather than a claim: the success criteria in
# Dara's charter are "arbitrary [Npx] count goes down, shared-primitive adoption
# goes up", and neither is checkable unless anyone can reproduce the count.
#
# Run from the repo root:  bash docs/design/measure-baseline.sh
set -uo pipefail
SRC=apps/web/src
TSX=(--include='*.tsx')
BOTH=(--include='*.tsx' --include='*.ts')

hdr() { printf '\n== %s ==\n' "$1"; }

hdr "TYPE: arbitrary font sizes (the primary debt)"
grep -rhoE 'text-\[[0-9.]+px\]' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn
printf 'TOTAL arbitrary text-[Npx]: %s\n' \
  "$(grep -rhoE 'text-\[[0-9.]+px\]' $SRC "${TSX[@]}" | wc -l | tr -d ' ')"

hdr "TYPE: Tailwind named font sizes (the competing system)"
grep -rhoE '\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn

hdr "TYPE: files that use BOTH text-sm and text-[13px] (the 1px split, per file)"
n=0; for f in $(grep -rl 'text-sm' $SRC "${TSX[@]}"); do
  grep -q 'text-\[13px\]' "$f" && n=$((n+1))
done; echo "$n files"

hdr "LINE HEIGHT: explicit leading-* declarations"
grep -rhoE '\bleading-[a-z0-9.\[\]]+' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn

hdr "SPACING: arbitrary padding/margin/gap (expected to be near zero)"
grep -rhoE '\b(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-\[[^]]+\]' \
  $SRC "${TSX[@]}" | sort | uniq -c | sort -rn

hdr "BRACKETS: tokenised (good) vs arbitrary literal (debt)"
ALL=$(grep -rhoE '\b[a-z-]+-\[[^]]+\]' $SRC "${BOTH[@]}" | grep -v 'data-\[' | wc -l | tr -d ' ')
TOK=$(grep -rhoE '\b[a-z-]+-\[[^]]+\]' $SRC "${BOTH[@]}" | grep -v 'data-\[' | grep -c 'var(')
echo "bracket utilities total : $ALL"
echo "  reference a token     : $TOK"
echo "  arbitrary literal     : $((ALL-TOK))"
echo "  distinct literal values: $(grep -rhoE '\b[a-z-]+-\[[^]]+\]' $SRC "${BOTH[@]}" \
  | grep -v 'data-\[' | grep -v 'var(' | sort -u | wc -l | tr -d ' ')"

hdr "ELEVATION: hand-rolled shadows (no --shadow-* token exists)"
grep -rhoE 'shadow-\[[^]]+\]' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn
printf 'distinct: %s  total: %s\n' \
  "$(grep -rhoE 'shadow-\[[^]]+\]' $SRC "${TSX[@]}" | sort -u | wc -l | tr -d ' ')" \
  "$(grep -rhoE 'shadow-\[[^]]+\]' $SRC "${TSX[@]}" | wc -l | tr -d ' ')"

hdr "SHAPE: radius utilities — token vs bare Tailwind"
grep -rhoE 'rounded(-[a-z0-9]+)?(-\[[^]]*\])?' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn

hdr "STACKING: raw z-index (the scale exists; --z-sticky has no adopters)"
grep -rhoE '\bz-[0-9]+\b' $SRC "${TSX[@]}" | sort | uniq -c | sort -rn

hdr "PRIMITIVES: adoption — files importing each ui/ primitive"
for p in $(ls $SRC/components/ui/*.tsx | grep -v '\.test\.' | xargs -n1 basename | sed 's/\.tsx//'); do
  c=$(grep -rl "ui/$p'" $SRC "${TSX[@]}" 2>/dev/null | grep -v "/ui/$p.tsx" | wc -l | tr -d ' ')
  printf '  %-22s %3s\n' "$p" "$c"
done

hdr "PRIMITIVES: raw element vs primitive"
# #692 — the primitive is DERIVED from the element name and checked on disk,
# never hardcoded. A sentinel list claimed "NO primitive exists" for <select> for
# two days after ui/select.tsx shipped in PR #662, which hid the real finding:
# the primitive existed and nothing had adopted it. Now the line follows reality.
for raw in button input select textarea; do
  prim=$(printf '%s' "$raw" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  rc=$(grep -rhoE "<$raw\\b" $SRC "${TSX[@]}" | wc -l | tr -d ' ')
  if [ -f "$SRC/components/ui/$raw.tsx" ]; then
    pc=$(grep -rhoE "<$prim\\b" $SRC "${TSX[@]}" | wc -l | tr -d ' ')
    tot=$(( rc + pc ))
    pct=0; [ "$tot" -gt 0 ] && pct=$(( 100 * pc / tot ))
    printf '  <%s>: %s raw   <%s>: %s   (%s%% adopted)\n' "$raw" "$rc" "$prim" "$pc" "$pct"
  else
    printf '  <%s>: %s raw   (no ui/%s.tsx on disk)\n' "$raw" "$rc" "$raw"
  fi
done

hdr "TOKENS: liveness"
# Delegated to a python helper: a name-only grep reports 32 dead tokens when the
# real number is 3, because the colour tokens are consumed through generated
# Tailwind utilities rather than by name. See the docstring there.
python3 docs/design/token-liveness.py

hdr "COMPONENTS"
echo "ui/ primitives              : $(ls $SRC/components/ui/*.tsx | grep -vc '\.test\.')"
echo "components/ excl ui/        : $(find $SRC/components -name '*.tsx' ! -name '*.test.*' ! -path '*/ui/*' | wc -l | tr -d ' ')"
echo "app/ route components      : $(find $SRC/app -name '*.tsx' | wc -l | tr -d ' ')"
