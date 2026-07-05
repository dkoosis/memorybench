#!/usr/bin/env bash
W="$1"; P="$2"; cd "$HOME/Projects/memorybench"; n=0
while read -r qid; do
  Y="data/providers/trixi/${qid}-trixi111-e4c-a300/config/search.yaml"; [ -f "$Y" ] || continue
  if grep -q '^session_diversity_weight:' "$Y"; then
    sed -i '' "s/^session_diversity_weight:.*/session_diversity_weight: $W/;s/^session_tag_prefix:.*/session_tag_prefix: \"$P\"/" "$Y"
  else
    printf '\nsession_diversity_weight: %s\nsession_diversity_allowance: 3\nsession_tag_prefix: "%s"\n' "$W" "$P" >> "$Y"
  fi
  n=$((n+1))
done < /tmp/screen_qids.txt
echo "set weight=$W prefix=\"$P\" on $n configs"
