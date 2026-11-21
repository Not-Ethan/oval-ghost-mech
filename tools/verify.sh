#!/bin/bash
# Conformance + timing verification. Usage: tools/verify.sh [extra recorded streams...]
# 1) check.py with the bot run directly by node, on the kit stream and any extra streams
# 2) per-tick CPU time of the decision code on each stream (in-process replay)
# 3) if docker is available: build the image and run check.py with the scorer's sandbox flags
set -u
cd "$(dirname "$0")/.."
NODE="node --expose-gc --max-semi-space-size=32 --disable-warning=ExperimentalWarning"
status=0
for s in check/stream.jsonl.gz "$@"; do
  echo "== check.py (node) on $s"
  python3 check/check.py --stream "$s" -- $NODE src/main.ts 2>/dev/null | tail -4 || status=1
  echo "== CPU time per tick on $s"
  $NODE tools/replay.ts "$s" 2>/dev/null | grep "CPU ms"
done
if command -v docker >/dev/null 2>&1 && [ "${SKIP_DOCKER:-0}" != "1" ]; then
  PLAT=${PLATFORM:-linux/amd64}
  echo "== docker build ($PLAT)"
  docker build --platform "$PLAT" -t mech-royale-bot:verify . >/dev/null 2>&1 || { echo "docker build failed"; exit 1; }
  echo "== check.py (docker $PLAT, scorer sandbox flags)"
  python3 check/check.py --map-dir /arena -- docker run --rm -i --platform "$PLAT" --network none --cpus 1 --memory 512m \
    --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" mech-royale-bot:verify 2>/dev/null | tail -5
fi
exit $status
