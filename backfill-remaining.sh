#!/usr/bin/env bash
# tx-1e5a5: backfill sess- tags + sync + re-embed for all screen containers.
set -uo pipefail
BIN=/tmp/trixi-tx1e5a5
cd "$HOME/Projects/memorybench"
: > /tmp/backfill.summary
n=0
while read -r qid; do
  [ -z "$qid" ] && continue
  CT="${qid}-trixi111-e4c-a300"; D="data/providers/trixi/$CT"
  if [ ! -d "$D/kg/reference" ]; then echo "SKIP-MISSING $CT"; continue; fi
  find "$D/kg/reference" -name '*.md' | perl backfill-sess-tags.pl 2>>/tmp/backfill.summary
  "$BIN" --db "$D/trixi.db" --kg-root "$D/kg" --config "$D/config" sync  >/dev/null 2>&1
  "$BIN" --db "$D/trixi.db" --kg-root "$D/kg" --config "$D/config" embed >/dev/null 2>&1
  emb=$(sqlite3 "$D/trixi.db" "SELECT sum(case when embedding is not null then 1 else 0 end)||'/'||count(*) FROM nugs;")
  unt=$(sqlite3 "$D/trixi.db" "SELECT count(*) FROM nugs WHERE tags NOT LIKE '%sess-%';")
  n=$((n+1))
  echo "$n $CT embedded=$emb untagged=$unt"
done < /tmp/remaining_qids.txt
echo "BACKFILL-DONE ($n containers)"
