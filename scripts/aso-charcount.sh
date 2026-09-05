#!/usr/bin/env bash
# Check Paylode Schools store-listing copy against Google Play's field limits.
#
#   scripts/aso-charcount.sh                 # check the candidates in docs/aso/
#   scripts/aso-charcount.sh "some text" 80  # check one string against a limit
#
# Play limits: title 30, short description 80, full description 4000.
set -euo pipefail

# Count characters the way Play does: Unicode code points, no trailing newline.
# LC_ALL must be a UTF-8 locale or `wc -m` degrades to counting bytes, and every
# en dash or curly quote reads 3 chars too long.
count() { printf '%s' "$1" | LC_ALL=C.UTF-8 wc -m | tr -d ' '; }

check() {
  local label="$1" text="$2" limit="$3" n
  n=$(count "$text")
  if [ "$n" -le "$limit" ]; then
    printf '  ok   %3d/%-4d  %s\n' "$n" "$limit" "$label"
  else
    printf '  OVER %3d/%-4d  %s\n' "$n" "$limit" "$label"
    return 1
  fi
}

if [ $# -ge 1 ]; then
  check "input" "$1" "${2:-80}"
  exit $?
fi

rc=0

echo "Titles (limit 30)"
check "A" 'Paylode Schools: Pay Fees'     30 || rc=1
check "B" 'Paylode Schools – School Fees' 30 || rc=1
check "C" 'Paylode Schools: Fee Payments' 30 || rc=1

echo "Short descriptions (limit 80)"
check "A" 'Pay school fees in full or in flexible instalments. Fast, secure, licensed.' 80 || rc=1
check "B" 'Pay school fees online, get instant receipts, and spread the cost per term.' 80 || rc=1
check "C" 'School fees payments and financing for Nigerian parents, schools and wards.' 80 || rc=1

echo "Full description (limit 4000)"
doc="$(dirname "$0")/../docs/aso/paylode-schools-play-listing.md"
full=$(awk '/^```text$/{f=1;next} f&&/^```$/{exit} f' "$doc")
check "docs/aso/paylode-schools-play-listing.md" "$full" 4000 || rc=1

exit $rc
