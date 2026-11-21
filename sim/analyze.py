#!/usr/bin/env python3
"""Analyse sim timelines (JSONL from sim/run.ts --out=...).

  python3 sim/analyze.py a.jsonl [--brief]      summary: score, kills, death times, killers, fights, accuracy
  python3 sim/analyze.py a.jsonl b.jsonl        paired comparison by seed (A - B) with a 95% interval
  python3 sim/analyze.py a.jsonl --timeline N   one match's timeline (N = seed)
"""
import json
import statistics as st
import sys
from collections import Counter, defaultdict


def load(path):
    out = {}
    for line in open(path):
        line = line.strip()
        if line:
            r = json.loads(line)
            out[r["seed"]] = r
    return out


def mean_se(xs):
    if not xs:
        return 0.0, 0.0
    m = st.mean(xs)
    se = st.stdev(xs) / len(xs) ** 0.5 if len(xs) > 1 else 0.0
    return m, se


def fights(rec, gap=5.0):
    """Split combat with mechs into fights: runs of dealt/taken events (mech vs mech) with gaps < gap s."""
    out = []
    cur = None
    hp = None
    last_s = None
    for e in rec:
        if e["e"] == "s":
            last_s = e
            hp = e["hp"]
            continue
        mech_evt = (e["e"] == "taken" and isinstance(e.get("by"), int) and 0 <= e["by"] < 16) or (e["e"] == "dealt" and e.get("to", 999) < 16)
        if e["e"] == "taken":
            hp = e["hp"]
        if not mech_evt and e["e"] not in ("kill", "death"):
            continue
        t = e["t"]
        if cur is None or (t - cur["end"] > gap and e["e"] in ("taken", "dealt")):
            if cur:
                out.append(cur)
            start_hp = (hp + e["amt"]) if e["e"] == "taken" else hp
            cur = {"start": t, "end": t, "hp0": start_hp, "max0": last_s["max"] if last_s else 1400, "dealt": 0, "taken": 0, "foes": Counter(),
                   "kills": [], "died": False, "rearTaken": 0, "byW": Counter(), "cubes0": last_s["cubes"] if last_s else 0, "w0": last_s["w"] if last_s else "?"}
        cur["end"] = max(cur["end"], t)
        if e["e"] == "taken":
            cur["taken"] += e["amt"]
            cur["foes"][e["byName"]] += 1
            cur["byW"][e["w"]] += e["amt"]
            if e.get("rear"):
                cur["rearTaken"] += e["amt"]
            cur["hp1"] = e["hp"]
        elif e["e"] == "dealt":
            cur["dealt"] += e["amt"]
        elif e["e"] == "kill":
            cur["kills"].append(e["victimName"])
            cur["hp1"] = e.get("myHp", hp)
        elif e["e"] == "death":
            cur["died"] = True
            cur["hp1"] = 0
            cur["killer"] = e["byName"]
    if cur:
        out.append(cur)
    return out


def summary(R, brief=False):
    recs = list(R.values())
    n = len(recs)
    sc = [16 - r["place"] for r in recs]
    m, se = mean_se(sc)
    kills = [r["kills"] for r in recs]
    deaths = sorted(r["deathT"] if r["deathT"] >= 0 else r["endT"] for r in recs)
    km, kse = mean_se(kills)
    print(f"n={n}  score {m:.2f} ± {1.96 * se:.2f} (95%)  kills {km:.2f}  median death {deaths[n // 2]:.0f}s  "
          f"p25/p75 {deaths[n // 4]:.0f}/{deaths[3 * n // 4]:.0f}s")
    killers = Counter(next((e["byName"] for e in r["rec"] if e["e"] == "death"), "alive") for r in recs)
    print("  killed by:", ", ".join(f"{k} {v}" for k, v in killers.most_common()))
    vk = Counter()
    for r in recs:
        for e in r["rec"]:
            if e["e"] == "kill":
                vk[e["victimName"]] += 1
    hd = Counter()
    for r in recs:
        for d in r.get("deaths", []):
            if d["id"] != r["slot"] and d["by"] != r["slot"] and (r["deathT"] < 0 or d["t"] <= r["deathT"]):
                hd[d["byName"] + ">" + d["name"]] += 1
    if hd:
        print("  house deaths not caused by us (before our death):", ", ".join(f"{k} {v}" for k, v in hd.most_common(6)))
    print("  our kills by tier:", ", ".join(f"{k} {v / n:.2f}" for k, v in vk.most_common()), "(per match)")
    W = defaultdict(lambda: [0, 0, 0])
    for r in recs:
        for k, v in r["wst"].items():
            W[k][0] += v["shots"]; W[k][1] += v["hits"]; W[k][2] += v["dmg"]
    print("  accuracy (hits on mechs / shots, all shots incl. crates/NPCs):",
          ", ".join(f"{k} {v[1]}/{v[0]} ({100 * v[1] / max(1, v[0]):.0f}%) dmg/match {v[2] / n:.0f}" for k, v in W.items() if v[0]))
    HW = defaultdict(lambda: [0, 0, 0])
    for r in recs:
        for tier, ws in r.get("houseWst", {}).items():
            for k, v in ws.items():
                if v["shots"]:
                    q = HW[tier.replace("house-", "") + ":" + k]; q[0] += v["shots"]; q[1] += v["hits"]; q[2] += v["dmg"]
    if HW:
        print("  house accuracy:", ", ".join(f"{k} {100 * v[1] / max(1, v[0]):.0f}% ({v[0] // n}/m)" for k, v in sorted(HW.items())))
    if brief:
        return
    # kill times
    kt = defaultdict(list)
    for r in recs:
        ks = [e["t"] for e in r["rec"] if e["e"] == "kill"]
        for i, t in enumerate(ks):
            kt[i].append(t)
    print("  k-th kill median time:", ", ".join(f"#{i + 1} {st.median(v):.0f}s (n={len(v)})" for i, v in sorted(kt.items())))
    # fights
    F = [f for r in recs for f in fights(r["rec"])]
    won = [f for f in F if f["kills"] and not f["died"]]
    lost = [f for f in F if f["died"]]
    other = [f for f in F if not f["kills"] and not f["died"]]
    print(f"  fights: {len(F) / n:.1f}/match  won(kill) {len(won)}  lost(died) {len(lost)}  no result {len(other)}")
    for name, G in (("won", won), ("lost", lost), ("none", other)):
        if not G:
            continue
        print(f"   {name:5s}: dur {st.median(f['end'] - f['start'] for f in G):.1f}s  hp0 {st.median(f['hp0'] for f in G):.0f}  "
              f"dealt {st.mean(f['dealt'] for f in G):.0f} taken {st.mean(f['taken'] for f in G):.0f}  rear-taken share "
              f"{sum(f['rearTaken'] for f in G) / max(1, sum(f['taken'] for f in G)):.2f}  foes/fight {st.mean(len(f['foes']) for f in G):.2f}")
    # deaths: how many distinct attackers in the fatal fight, and damage by weapon
    if lost:
        nf = Counter(len(f["foes"]) for f in lost)
        print("   fatal fights by # attacker tiers:", dict(sorted(nf.items())))
        bw = Counter()
        for f in lost:
            bw.update(f["byW"])
        tot = sum(bw.values()) or 1
        print("   damage taken in fatal fights by weapon:", ", ".join(f"{k} {v / tot:.2f}" for k, v in bw.most_common()))
    # regen time share while alive
    rs = [st.mean(e["regen"] for e in r["rec"] if e["e"] == "s") for r in recs if any(e["e"] == "s" for e in r["rec"])]
    print(f"  time regenerating-eligible share {st.mean(rs):.2f}")
    # loadout at death
    print("  loadout at end:", Counter("+".join(sorted(w or "-" for w in r["weapons"])) for r in recs).most_common(5))
    print("  cubes at end:", st.mean(r["cubes"] for r in recs), " upgrades:", Counter(u for r in recs for u in r["upgrades"]).most_common(8))


def paired(A, B):
    common = sorted(set(A) & set(B))
    d = [(16 - A[s]["place"]) - (16 - B[s]["place"]) for s in common]
    m, se = mean_se(d)
    ma = st.mean(16 - A[s]["place"] for s in common)
    mb = st.mean(16 - B[s]["place"] for s in common)
    ka = st.mean(A[s]["kills"] for s in common)
    kb = st.mean(B[s]["kills"] for s in common)
    print(f"paired n={len(common)}  A {ma:.2f}  B {mb:.2f}  diff {m:+.2f} ± {1.96 * se:.2f} (95%)  kills A {ka:.2f} B {kb:.2f}")


def timeline(R, seed):
    r = R[seed]
    print(f"seed {seed} slot {r['slot']} place {r['place']} kills {r['kills']} death {r['deathT']}")
    for e in r["rec"]:
        if e["e"] == "s":
            if int(e["t"]) % 5 == 0:
                print(f"  {e['t']:6.1f} S hp {e['hp']}/{e['max']} cubes {e['cubes']} w {e['w']} regen {e['regen']} seenBy {e['seenBy']} alive {e['alive']} pos {e['pos']}")
        else:
            print(f"  {e['t']:6.1f} " + " ".join(f"{k}={v}" for k, v in e.items() if k != "t"))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--timeline" in sys.argv:
        timeline(load(args[0]), int(args[1]))
    elif len(args) == 2:
        paired(load(args[0]), load(args[1]))
    else:
        summary(load(args[0]), "--brief" in sys.argv)
