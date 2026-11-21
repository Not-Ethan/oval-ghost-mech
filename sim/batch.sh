#!/bin/bash
# Parallel practice batch with per-match JSONL timelines.
# usage: sim/batch.sh <name> <bot> <matches> <seed0> <workers> [extra run.ts args...]
#   env OUT (default: $TMPDIR/mr) receives <name>.txt (match lines) and <name>.jsonl (timelines)
#   house-model env vars (HUNT_*, H_AIM_*, HOUSE_OMNI, IDLE_*) pass through to every worker
NAME=$1; BOT=$2; N=$3; S=$4; W=${5:-4}; shift 5
cd "$(dirname "$0")/.."
OUT=${OUT:-${TMPDIR:-/tmp}/mr}
mkdir -p "$OUT"
rm -f "$OUT/$NAME.txt" "$OUT/$NAME.jsonl" "$OUT/$NAME".w*.txt "$OUT/$NAME".w*.jsonl
PER=$(( (N + W - 1) / W ))
for i in $(seq 0 $((W-1))); do
  s=$((S + i*PER)); n=$PER
  if [ $((i*PER + n)) -gt "$N" ]; then n=$((N - i*PER)); fi
  [ "$n" -le 0 ] && continue
  node sim/run.ts --bot="$BOT" --matches=$n --seed=$s --out="$OUT/$NAME.w$i.jsonl" "$@" > "$OUT/$NAME.w$i.txt" 2>&1 &
done
wait
cat "$OUT/$NAME".w*.txt | grep "^match" > "$OUT/$NAME.txt"
cat "$OUT/$NAME".w*.jsonl > "$OUT/$NAME.jsonl" 2>/dev/null
grep -h -iE "error|exception" "$OUT/$NAME".w*.txt | head -3
rm -f "$OUT/$NAME".w*.txt "$OUT/$NAME".w*.jsonl
python3 sim/analyze.py "$OUT/$NAME.jsonl" --brief
