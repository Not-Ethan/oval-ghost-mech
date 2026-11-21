#!/bin/bash
# Paired A/B of bot params under the calibrated house models (M1: omniscient hunters, M1b: shared vision only,
# M1s: M1 with strafing movement like the real recorded enemy; M1r: M1s with longer fighting ranges and
# lasers for hard/expert). Default MODELS="M1 M1b M1s"; e.g. MODELS="M1 M1r" to choose.
# usage: sim/ab.sh <name> '<params json>' [matches=200] [seed0=1001] [baseline params json='{}']
# Baselines are cached per (model, seeds, baseline params) in $OUT.
NAME=$1; P=$2; N=${3:-200}; S=${4:-1001}; BASEP=${5:-'{}'}
cd "$(dirname "$0")/.."
export OUT=${OUT:-${TMPDIR:-/tmp}/mr}
mkdir -p "$OUT"
BKEY=$(echo "$BASEP" | cksum | cut -d' ' -f1)
for M in ${MODELS:-M1 M1b M1s}; do
  OMNI=1; MOVE=0; RANGE=0; LT=""
  [ $M = M1b ] && OMNI=0
  [ $M = M1s ] && MOVE=1
  [ $M = M1r ] && { MOVE=1; RANGE=1; LT=hard,expert; }
  B="base_${M}_${S}_${N}_${BKEY}"
  if [ ! -s "$OUT/$B.jsonl" ]; then HOUSE_OMNI=$OMNI H_MOVE=$MOVE H_RANGE=$RANGE H_LASER_TIERS=$LT sim/batch.sh "$B" mine "$N" "$S" 4 --params="$BASEP" > /dev/null; fi
  HOUSE_OMNI=$OMNI H_MOVE=$MOVE H_RANGE=$RANGE H_LASER_TIERS=$LT sim/batch.sh "${NAME}_$M" mine "$N" "$S" 4 --params="$P" > /dev/null
  echo -n "$M $NAME: "; python3 sim/analyze.py "$OUT/${NAME}_$M.jsonl" "$OUT/$B.jsonl"
done
