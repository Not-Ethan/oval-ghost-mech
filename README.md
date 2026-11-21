# oval-ghost: a Mech Royale bot (`mechfight/1`)

This bot pilots one mech in the 16-mech battle royale on the OSU Oval map. It plays for
placement: it never dies to the zone, it fights from positions that few enemies can see, and it
disengages to regenerate when it is outnumbered or hurt.

## Quick start

```sh
# conformance check, run directly (Node 22.18+ runs the TypeScript as-is)
python3 check/check.py -- node src/main.ts

# build the image and check it the way the scorer does
docker build -t my-bot .
python3 check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" my-bot
```

The image is `node:24.11.1-bookworm-slim` plus the `src/` and `data/` folders. It has no other
dependencies and writes nothing to disk.

## Layout

| Path | What it is |
| --- | --- |
| `src/main.ts` | stdin/stdout loop. It answers only the newest observation, catches every exception, and always sends a valid action that echoes the tick. |
| `src/brain.ts` | Decision logic: zone, threat tracking, positioning, engagement policy, aiming, dodging, loot, and upgrades. |
| `src/world.ts` | Map geometry: terrain, prisms and trees. Provides raycasts, line of sight (trunks block, canopy fades by transmittance), and surface heights. |
| `src/nav.ts` | A 2 m navigation grid built from walkability, a distance transform for clearance, A* search, and Dijkstra distance fields. |
| `src/cover.ts` | Static cover metrics for each cell: walls within 20 m, and how far you can be seen from. |
| `src/mapcache.ts` | Loads `data/map.bin`, the precomputed nav and cover data. It checks a SHA-1 of the live `/arena` files and recomputes everything if they differ. |
| `data/map.bin` | Precomputed map data (about 1 MB). Regenerate it with `node tools/precompute.ts arena data/map.bin`. |
| `sim/` | A local approximation of the server, plus house bots, for offline testing. It is not part of the image. |
| `tools/` | Precompute and replay/timing tools. |
| `arena/`, `check/` | The kit's map and conformance check, copied in so the commands above work. |

## How it plays

- **Zone.** It computes the circle at any future time from `zone`. It heads into the next
  circle early, before the shrink starts, and boosts when the margin gets small. Its holding
  spot sits inside the next circle, on its own side, at a cell with good static cover.
- **Threats.** It tracks every mech it has seen: position, velocity, HP, weapons, aim, and
  laser charging. It also keeps damage bearings and sounds.
- **Engagement.** It fights enemies that are engaging it: they shot it recently, are within
  50 m, or are aimed at it, including a laser charge pointed at it. It also fights
  opportunities:
  - any shootable enemy within 110 m, while HP is above 45% and at most two enemies are
    visible (60 m once it has seen other mechs fighting each other, i.e. a free-for-all)
  - low-HP enemies, to finish kills
  - an enemy that is already losing HP to someone else (third-party)

  It watches every other enemy without firing. Target choice favors whoever is shooting it,
  low HP, short range, and laser chargers. `engageAll` makes it fight every visible enemy.
- **Positioning.** It scores nearby reachable cells by exposure to the known threats (line of
  sight from their eyes), static cover, zone safety, and preferred weapon range. When
  outnumbered or hurt, it evades to cells no threat can see. While the gun reloads and
  nothing else can fire, it also ducks out of sight. Below 50% HP it recovers: it hides until
  it has regenerated to 85%. Once contact breaks, it relocates 50-115 m away from where the
  threats last saw it. Unseen attackers become phantom threats at the damage bearing.
- **Aim.** For the gun it solves for the projectile intercept and fires only when the actual
  torso aim is within the target's angular size. The laser charges fully and releases on
  alignment. Lightning fires inside its range and cone. The mortar is used only against slow
  targets.
- **Survival details.** It strafes randomly against visible shooters, and moves out of
  incoming bullet lines and predicted mortar impacts. It turns to find an attacker it cannot
  see. It kills NPC drones that attack it, or backs away from them. It jumps and jets free
  when stuck. Paths avoid cells outside the circle as it will be by arrival time. Targets
  are snapped to the map's main connected area, and when the goal is not walkable-connected
  (an enclosed area, or a stranded spot) it heads straight there and jets over obstacles.
  When cubes make the mech bigger, it rebuilds the walk mask for the new radius.
- **Loot and upgrades.** Pickups and swaps maximise a loadout value. The order is
  laser + lightning (it will drop the gun for this), then gun + laser, gun + lightning, and
  so on. It grabs weapons dropped by kills when no enemy is close, and contests uncontested
  supply drops. In the first minute, with no threats around, it shoots crates and drones
  for cubes. Upgrade priority is armor, plating, nanites, then weapon upgrades. After
  300 s, plating comes first: the final zone damages everyone and armor does not reduce it.

## Performance

Startup on an M1 takes about 0.1 s to load the cached map data (`data/map.bin`: quantized nav
rasters, component labels, and cover metrics, all checked against the map's SHA-1). Then
about 0.7 s of JIT warmup on synthetic observations, a short raycast benchmark, and a forced
GC before `ready`. Median per-tick CPU is under 0.1 ms, and p99 is 2-13 ms (measured with
`tools/replay.ts`, including JIT/GC threads). Peak RSS over a 4,000-tick match is 115-130 MB (container limit: 512 MB).

A wall-clock deadline (6 ms, or 3-4 ms on slow machines) caps the expensive searches:
tactical spot search, path replanning, distance fields. Work that misses the deadline moves
to later ticks. The benchmark takes the minimum of six short runs, so a busy host does not
trigger it by accident. If it shows a slow machine (factor > 2, e.g. under QEMU emulation),
it lowers A* expansion limits, distance-field radii and candidate counts.

If `hello` fails (e.g. the map cannot be loaded) or `act` throws, `main.ts` falls back to a
minimal policy: walk to the zone, shoot the nearest mech. Run `tools/verify.sh` to re-run the
conformance and timing checks.

## Tuning knobs

All strategy parameters are in `DEFAULT_PARAMS` at the top of `src/brain.ts`. To build a variant
without touching code, add a `data/params.json` file (it is copied into the image). Example:
`{"engageAll": true, "recoverLo": 0.35}`. Unknown keys and values of the wrong type are
ignored, and the active overrides are logged to stderr at startup.

| Param | Default | Effect |
| --- | --- | --- |
| `engageAll` | false | Fight every visible enemy in range, not only threats and opportunities. In the sim it was not significantly different from the default (-0.20 +- 0.31 over 45 paired practice matches, +0.5 in a small FFA self-play test). This is the first knob to A/B on the real ladder. |
| `engageAllUntilFfa` | false | Like `engageAll`, but only until it sees other mechs fighting each other. |
| `engageRange` | 110 | Range for engaging any shootable enemy while healthy and at most 2 are visible. |
| `ffaEngageRange` | 60 | Smaller engage range used once it sees other mechs fighting each other (free-for-all). |
| `lonelyDuelRange` | 60 | Duels a lone enemy inside this range. |
| `recoverLo` / `recoverHi` | 0.5 / 0.85 | HP fractions for entering and leaving the hide-and-regen state. |
| `maxGunRange` | 160 | Never fires the gun at mechs farther away than this. |
| `fireSlack` | 0.25 | Extra gun aim error allowed, as a fraction of one tick of torso slew. |
| `rearAware` | false | Keeps active shooters inside the front arc when choosing targets and spots. It scored worse in the sim, so it is off. |
| `lootNoise` / `lootNoiseUntil` | true / 60 s | Shoots crates and drones for cubes early in the match, when nobody is around. |
| `drops` | true | Contests supply drops when they are uncontested and close. |
| `relocate` | true | After contact, moves away from where threats last saw it. |

Params added on branch `mech-opt`. All are off by default in code. Candidates turn them on through
`data/params.json`, and `CANDIDATES.md` lists each candidate with its sim evidence.

| Param | Default | Effect |
| --- | --- | --- |
| `lootMem` | false | Remembers weapon pickups seen earlier (they are listed only while in view). |
| `laserHunt` / `laserR` / `laserNear` | false / 250 / 70 | Without a laser, walks to the nearest remembered ground laser within `laserR` m. It does not go when an enemy is visible within `laserNear` m or HP is below 45%. Needs `lootMem`. |
| `harvest` (`harvestMaxVis`, `harvestHp`, `harvestS`) | false (1, 0.3, 30) | After a kill, goes to the victim's spot for its cubes and weapons, while at most 1 enemy is visible within 120 m. |
| `mortarUse` | false | Fires the mortar whenever it is ready, leading the target, and swings the torso off the gun aim for that shot. |
| `loadout` | "old" | `"gun"` ranks gun+laser above laser+lightning. House hunters fight from beyond lightning range. |
| `upg` | "old" | Upgrade order: `"old"` (armor first), `"plating"`, `"dmg"`, `"mag"`, or `"auto"` (marginal gain in effective HP × sustained DPS for the weapons held). |
| `dryHold` | false | When nothing can fire, still breaks line of sight to reload, unless incoming damage is light (one shooter, under 8% HP in 3 s). |
| `leadAdapt` | false | Scales gun lead by the expected travel of a target that keeps reversing direction (flip rate estimated per track). |
| `laserDodge` | false | Breaks line of sight while a visible enemy charges a laser aimed at it. |
| `scanEvery` | 0 | While quiet, sweeps the torso through a full circle every N seconds to spot loot. |
| `lootBoost` | false | Boosts while walking to a laser or harvesting. |
| `farm` (`farmMaxCubes`, `farmR`, `farmQuiet`) | false | Walks to remembered crates and drones and shoots them for cubes when no enemy has been seen for `farmQuiet` s. |
| `peek` | 0 | Bonus for fighting spots that have a fully hidden spot within 9 m. |
| `laserHp` | 0.45 | `laserHunt` only runs above this HP fraction. |
| `rangeW` | 0.02 | Weight of the preferred-range term when choosing a fighting spot (gun 75 m, laser 110 m, lightning 35 m). |
| `loadout: "nomortar"` | | Like `"gun"`, but never carries a mortar, because an enemy laser does +60% to a mech holding one. |
| `laserEngageR`, `laserHold`, `laserSafe`, `laserCrates`, `laserRoof`, `harvestW`, `dropsAgg`, `regenHold`, `finishHp`, `kite`, `scoutT`, `leadMC`, `leadMCMean`, `fireMinP` | off | Experimental; see the `Params` comments in `src/brain.ts`. Neutral or worse in the sim so far (`CANDIDATES.md`). |
| `attackersOnly`, `focus`, `cubeGrab`, `jukeMin`/`jukeVar`/`jukeW` | off / defaults | Experimental. Neutral or worse in the sim. |

## Local simulator (`sim/`)

The kit has no game runner, only `check/check.py`, which replays a recorded stream that does not
react to the bot. `sim/engine.ts` is my own approximation of the server, written from
`protocol.md` and the hello config:

- movement: acceleration, jump, jets, energy, wall sliding, step-up
- weapons: gun projectiles with spread, mortar ballistics with splash and knockback, laser
  charge and hitscan, lightning cone and chains
- damage rules: rear armor, cube scaling, regen, zone phases
- vision: field of view, near range, line of sight, canopy, memory
- also sound, NPC drones, crates, loot, upgrades, supply drops, and placement

`sim/house.ts` is a guess at the house squad. It hunts with escalating numbers, weakest tier
first (1 + 2 per dead member), while the other members stay passive. It is calibrated to four
real practice scores (defaults, engageAll, never-fire, and the kit's example bot), and each fits
within about 0.1. See `sim/CALIBRATION.md` for the model, the fit, and what it does not pin down.
In practice mode a match stops when our mech dies, because the score is fixed from then on.

```sh
node sim/run.ts --bot=mine --matches=5 --seed=1                     # practice vs house squad (also --bot=example)
OUT=/tmp/mr sim/batch.sh NAME mine 200 1001 4 --params='{...}'      # 4 workers; timelines in /tmp/mr/NAME.jsonl
OUT=/tmp/mr sim/ab.sh NAME '{"harvest":true}'                       # paired A/B vs defaults under 3 house models
python3 sim/analyze.py /tmp/mr/NAME.jsonl                           # killers, fights, accuracy, cubes, loadouts
python3 sim/analyze.py A.jsonl B.jsonl                              # paired difference by seed, 95% interval
node sim/run.ts --matches=2 --seed=1001 --trace=t.json && node sim/viz.ts t.json 1001 50 90 out.svg   # map plot
node sim/run.ts --giveWeapon=laser --giveCubes=3 ...                # oracle: what a resource is worth
node sim/run.ts --brain=src/brain_v0.ts ...                         # run another brain version (untracked copy)
node sim/run.ts --mode=ffa --bot=mine --opp=mine --oppParams='{"engageAll":true}'   # self-play FFA A/B
node tools/replay.ts stream.jsonl.gz                                # per-tick CPU time on a recorded stream
```

The sim passes explicit params to the brain, so it never reads `data/params.json`.

## License

MIT, see `LICENSE`.
