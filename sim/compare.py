#!/usr/bin/env python3
"""Paired comparison of two sim result logs (lines from sim/run.ts): python3 sim/compare.py a.txt b.txt"""
import re
import statistics
import sys


def load(path):
    out = {}
    for line in open(path):
        m = re.search(r"seed (\d+): place (\d+) kills (\d+) death (-?\d+)", line)
        if m:
            out[int(m.group(1))] = (16 - int(m.group(2)), int(m.group(3)), int(m.group(4)))
    return out


a, b = load(sys.argv[1]), load(sys.argv[2])
common = sorted(set(a) & set(b))
if not common:
    sys.exit("no common seeds")
d = [a[s][0] - b[s][0] for s in common]
sd = statistics.pstdev(d) if len(d) > 1 else 0.0
print(f"paired n={len(common)}  A mean {statistics.mean(a[s][0] for s in common):.2f}  B mean {statistics.mean(b[s][0] for s in common):.2f}"
      f"  diff {statistics.mean(d):+.2f} (se {sd / len(d) ** 0.5:.2f})")
print(f"kills A {statistics.mean(a[s][1] for s in common):.2f}  B {statistics.mean(b[s][1] for s in common):.2f}"
      f"  | median death A {statistics.median(a[s][2] for s in common)}  B {statistics.median(b[s][2] for s in common)}")
