#!/usr/bin/env bash
# tx-1e5a5 verdict replicates: 3× per arm, ctl (knob stripped = off) vs w0.8.
# Arms share per-container search.yaml configs -> strictly sequential,
# knob set immediately before each run.
set -euo pipefail
cd "$HOME/Projects/memorybench"
export TRIXI_BIN="$HOME/Projects/memorybench/bin/trixi-65d2e3ef"
LOG=data/runs/replicates-20260703.log

run_arm() {
  local knob="$1" runid="$2"
  bench-harness/knob-full.sh "$knob" >>"$LOG" 2>&1
  echo "=== $(date '+%H:%M:%S') START $runid (knob=$knob) ===" >>"$LOG"
  bun run src/index.ts run -r "$runid" >>"$LOG" 2>&1
  echo "=== $(date '+%H:%M:%S') DONE $runid ===" >>"$LOG"
}

run_arm strip trixi123-rep1-ctl
run_arm 0.8   trixi124-rep1-w08
run_arm strip trixi125-rep2-ctl
run_arm 0.8   trixi126-rep2-w08
run_arm strip trixi127-rep3-ctl
run_arm 0.8   trixi128-rep3-w08
bench-harness/knob-full.sh strip >>"$LOG" 2>&1   # leave configs clean
echo "ALL REPLICATES COMPLETE" >>"$LOG"
