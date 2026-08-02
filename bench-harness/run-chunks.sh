#!/usr/bin/env bash
# Chunked driver for the self-hosted supermemory sm-clean500 run.
# Each chunk fully completes (ingest→indexing-drain→search→answer→evaluate) before
# the next starts, so peak in-flight docs stay bounded (~CHUNK questions worth) and
# the server never sees the whole-corpus burst that exhausts file descriptors.
# Usage: ./run-chunks.sh [CHUNK] [N] [PREFIX] [MERGED]
set -uo pipefail
cd "$HOME/Projects/memorybench"

CHUNK="${1:-25}"
N="${2:-20}"
PREFIX="${3:-sm-clean500-c}"
MERGED="${4:-sm-clean500}"
LOG=data/runs/sm-clean500-chunks.log
: > "$LOG"

echo "=== $(date '+%F %T') START chunked run: CHUNK=$CHUNK N=$N PREFIX=$PREFIX ===" | tee -a "$LOG"
fails=()
for i in $(seq 0 $((N-1))); do
  start=$((i*CHUNK))
  rid="${PREFIX}${i}"
  echo "=== $(date '+%T') chunk $i/$((N-1)) (qids ${start}..$((start+CHUNK))) seed ===" | tee -a "$LOG"
  bun run chunk-seed.ts "$rid" "$start" "$CHUNK" >>"$LOG" 2>&1 || { echo "SEED FAIL $rid" | tee -a "$LOG"; fails+=("$rid:seed"); continue; }
  echo "=== $(date '+%T') chunk $i run ===" | tee -a "$LOG"
  # Retry the chunk up to 3x. `run -r` (no --force) RESUMES from the on-disk
  # checkpoint, so a network hiccup that aborts a phase just re-enters where it
  # left off. 30s pause between attempts lets a transient blip clear.
  ok=0
  for attempt in 1 2 3; do
    if bun run src/index.ts run -r "$rid" >>"$LOG" 2>&1; then ok=1; break; fi
    echo "=== $(date '+%T') chunk $i attempt $attempt failed — resuming in 30s ===" | tee -a "$LOG"
    sleep 30
  done
  if [ $ok -eq 1 ]; then
    echo "=== $(date '+%T') chunk $i DONE ===" | tee -a "$LOG"
  else
    echo "RUN FAIL $rid (3 attempts)" | tee -a "$LOG"; fails+=("$rid:run")
  fi
  # Server is idle at the chunk boundary (run returned after indexing drained).
  # Clear per-doc retry leftovers + completed rivetkit actor state so neither
  # Lexar nor the near-full root disk creeps across 20 chunks.
  find /Volumes/Lexar/supermemory-data/retry-params -type f -mmin +1 -delete 2>/dev/null
  find "$HOME/Library/Application Support/rivetkit" -type f -mmin +2 -delete 2>/dev/null
  root_avail=$(df -g /System/Volumes/Data | tail -1 | awk '{print $4}')
  echo "--- root avail: ${root_avail}Gi | chunks done: $((i+1))/$N | fails: ${#fails[@]} ---" | tee -a "$LOG"
done

echo "=== $(date '+%T') all chunks attempted. fails=[${fails[*]:-none}] ===" | tee -a "$LOG"
echo "=== merging into $MERGED ===" | tee -a "$LOG"
bun run chunk-merge.ts "$MERGED" "$PREFIX" "$N" >>"$LOG" 2>&1
echo "=== running report phase on $MERGED ===" | tee -a "$LOG"
bun run src/index.ts run -r "$MERGED" -f report >>"$LOG" 2>&1
echo "=== $(date '+%F %T') CHUNKED RUN COMPLETE ===" | tee -a "$LOG"
