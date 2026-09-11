#!/usr/bin/env bash
# A ~30-chip / 8-group space for the ontology diagram (tickets #636 AC4, #687).
#
# Why this exists: #636's AC4 asked whether the diagram stays legible at "roughly
# 30 related entities across 8 space groups". It sat unverified for two days for
# one reason — no fixture that large existed, and nobody wanted to hand-build 31
# relations. #687 (the diagram overflowing its card) was then found the moment
# one did exist. So the fixture IS the test, and it needs to be re-runnable.
#
# It talks to the real API, so it exercises the same paths the product does —
# no direct SQL, nothing that can drift from the server's own validation.
#
# Usage, from the repo root, with the api dev server running:
#
#   WS=<workspace-uuid> bash docs/design/ontology-scale-fixture.sh
#
# Optional:
#   API=http://localhost:3071      the api origin (default)
#   EMAIL / PASSWORD              the seeded dev login
#   NAME="AC4 Scale Check"        the space to create (rename to keep several)
#
# It CREATES; it does not clean up. Delete the space in the UI when done, or
# re-run with a different NAME.
set -uo pipefail

API="${API:-http://localhost:3071}/api/v1"
EMAIL="${EMAIL:-nadia-1@agents.storyos.invalid}"
PASSWORD="${PASSWORD:-agent-uat-seed-password-1}"
NAME="${NAME:-AC4 Scale Check}"
: "${WS:?set WS to a workspace uuid}"

JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
J='content-type: application/json'
id() { python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])'; }

curl -s -c "$JAR" -X POST "$API/auth/sign-in/email" -H "$J" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
grep -q session_token "$JAR" || { echo "sign-in failed"; exit 1; }

# The centre. #636 centres the diagram on the most connected database, so giving
# this one every relation is what makes it the centre.
centre_space=$(curl -s -b "$JAR" -X POST "$API/workspaces/$WS/spaces" -H "$J" \
  -d "{\"name\":\"$NAME\",\"description\":\"Ontology scale fixture: ~30 chips across 8 space groups.\"}" | id)
centre=$(curl -s -b "$JAR" -X POST "$API/workspaces/$WS/databases" -H "$J" \
  -d "{\"space_id\":\"$centre_space\",\"name\":\"Campaign Hub\"}" | id)
echo "space $centre_space / centre $centre"

# Eight groups, UNEVEN on purpose: an even split would not exercise #636's
# deterministic balance (sort by count desc, then name, then id), and 5/4/4/4/4/4/3/3
# is what a real workspace looks like. Totals 31.
total=0
for spec in "Content Marketing:5" "Paid Media:4" "Brand Studio:4" "Web Platform:4" \
            "Customer Research:4" "Revenue Ops:4" "Astro Collections:3" "Partnerships:3"; do
  name="${spec%%:*}"; n="${spec##*:}"
  sid=$(curl -s -b "$JAR" -X POST "$API/workspaces/$WS/spaces" -H "$J" -d "{\"name\":\"$name\"}" | id)
  for i in $(seq 1 "$n"); do
    db=$(curl -s -b "$JAR" -X POST "$API/workspaces/$WS/databases" -H "$J" \
      -d "{\"space_id\":\"$sid\",\"name\":\"$name $i\"}" | id)
    r=$(curl -s -b "$JAR" -X POST "$API/workspaces/$WS/relations" -H "$J" \
      -d "{\"database_a_id\":\"$centre\",\"database_b_id\":\"$db\",\"cardinality\":\"many_to_many\"}")
    echo "$r" | grep -q '"id"' || { echo "  relation FAILED for $name $i: $(echo "$r" | head -c 160)"; exit 1; }
    total=$((total+1))
  done
  echo "  $name: $n"
done
echo "created $total related databases across 8 groups"
echo "open: /w/$WS/s/$centre_space"
