#!/usr/bin/env bash
# tx-1e5a5 mechanism smoke: distinct sessions in top-10.
# Three arms: w1.0 baseline | w0.8 prefix "sess:" (shipped default) | w0.8 prefix "sess-" (matches storage).
set -euo pipefail
BIN=/tmp/trixi-tx1e5a5
BASE="$HOME/Projects/memorybench/data/providers/trixi"
RUN=trixi116smoke

read -r -d '' QROWS <<'EOF' || true
6d550036	How many projects have I led or am currently leading?
b5ef892d	How many days did I spend on camping trips in the United States this year?
3a704032	How many plants did I acquire in the last month?
2e6d26dc	How many babies were born to friends and family members in the last few months?
gpt4_2f8be40d	How many weddings have I attended in this year?
EOF

distinct_sessions() { # db kg cfg tag query
  "$BIN" --db "$1" --kg-root "$2" --config "$3" search "$5" --tag "$4" --json --limit 10 2>/dev/null \
  | jq -r '[.[].name
      | if test("\\([^()]+#[0-9]+\\)[[:space:]]*$")
        then (capture("\\((?<s>[^()]+)#[0-9]+\\)[[:space:]]*$").s)
        else . end]
      | "\(unique|length)\t\(length)"'
}

set_yaml() { # yaml weight prefix
  sed -i '' "s/^session_diversity_weight:.*/session_diversity_weight: $2/" "$1"
  sed -i '' "s/^session_tag_prefix:.*/session_tag_prefix: \"$3\"/" "$1"
}

printf "qid\tw1.0_off\tw0.8_sess:colon\tw0.8_sess-hyphen\n"
while IFS=$'\t' read -r qid q; do
  [ -z "$qid" ] && continue
  CT="${qid}-${RUN}"; D="$BASE/$CT"; CFG="$D/config"; YAML="$CFG/search.yaml"
  set_yaml "$YAML" "1.0" "sess:"; a=$(distinct_sessions "$D/trixi.db" "$D/kg" "$CFG" "$CT" "$q")
  set_yaml "$YAML" "0.8" "sess:"; b=$(distinct_sessions "$D/trixi.db" "$D/kg" "$CFG" "$CT" "$q")
  set_yaml "$YAML" "0.8" "sess-"; c=$(distinct_sessions "$D/trixi.db" "$D/kg" "$CFG" "$CT" "$q")
  set_yaml "$YAML" "1.0" "sess:"  # restore
  printf "%s\t%s\t%s\t%s\n" "$qid" "$a" "$b" "$c"
done <<< "$QROWS"
