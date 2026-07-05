#!/usr/bin/env bash
# usage: knob-full.sh <weight|strip>  — strips all 3 session-diversity override
# lines from every 300 container config, then (unless "strip") appends ONLY
# session_diversity_weight. No prefix/allowance override → binary defaults
# (prefix "sess-", allowance 3) are exercised end-to-end.
MODE="$1"; cd "$HOME/Projects/memorybench"; n=0
while read -r qid; do
  Y="data/providers/trixi/${qid}-trixi111-e4c-a300/config/search.yaml"; [ -f "$Y" ] || continue
  sed -i '' '/^session_diversity_weight:/d;/^session_diversity_allowance:/d;/^session_tag_prefix:/d' "$Y"
  [ "$MODE" != "strip" ] && printf 'session_diversity_weight: %s\n' "$MODE" >> "$Y"
  n=$((n+1))
done < /tmp/all300_qids.txt
echo "knob-full mode=$MODE applied to $n configs"
