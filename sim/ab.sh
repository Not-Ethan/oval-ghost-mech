#!/bin/bash
# Paired A/B of bot params under the calibrated house models (M1: omniscient hunters, M1b: shared vision only).
# usage: sim/ab.sh <name> '<params json>' [matches=200] [seed0=1001] [baseline params json='{}']
# Baselines are cached per (model, seeds, baseline params) in $OUT.
NAME=$1; P=$2; N=${3:-200}; S=${4:-1001}; BASEP=${5:-'{}'}
cd "$(dirname "$0")/.."
export OUT=${OUT:-${TMPDIR:-/tmp}/mr}
mkdir -p "$OUT"
BKEY=$(echo "$BASEP" | cksum | cut -d' ' -f1)
for M in M1 M1b; do
  if [ $M = M1 ]; then OMNI=1; else OMNI=0; fi
  B="base_${M}_${S}_${N}_${BKEY}"
  if [ ! -s "$OUT/$B.jsonl" ]; then HOUSE_OMNI=$OMNI sim/batch.sh "$B" mine "$N" "$S" 4 --params="$BASEP" > /dev/null; fi
  HOUSE_OMNI=$OMNI sim/batch.sh "${NAME}_$M" mine "$N" "$S" 4 --params="$P" > /dev/null
  echo -n "$M $NAME: "; python3 sim/analyze.py "$OUT/${NAME}_$M.jsonl" "$OUT/$B.jsonl"
done
