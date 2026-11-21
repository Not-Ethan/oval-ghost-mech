#!/bin/bash
# usage: sim/par.sh <bot> <matches_per_worker> <seed0> [workers] [extra args]
BOT=$1; N=$2; S=$3; W=${4:-3}; shift 4
cd "$(dirname "$0")/.."
for i in $(seq 0 $((W-1))); do
  node sim/run.ts --bot=$BOT --matches=$N --seed=$((S + i*1000)) "$@" > /tmp/mr_par_$$_$i.log 2>&1 &
done
wait
cat /tmp/mr_par_$$_*.log | grep "^match" 
cat /tmp/mr_par_$$_*.log | grep "^match" | python3 -c "
import sys,re
pl=[];k=[];d=[]
for l in sys.stdin:
  m=re.search(r'place (\d+) kills (\d+) death (-?\d+)',l); pl.append(int(m.group(1))); k.append(int(m.group(2))); d.append(int(m.group(3)))
n=len(pl); print(f'N={n} MEAN score {sum(16-p for p in pl)/n:.2f}  kills {sum(k)/n:.2f}  median death {sorted(d)[n//2]}  worst-act see logs')
"
grep -h "max" /tmp/mr_par_$$_*.log | sed -E 's/.*max ([0-9.]+)ms.*/\1/' | sort -n | tail -1 | xargs echo "max act ms:"
rm -f /tmp/mr_par_$$_*.log
