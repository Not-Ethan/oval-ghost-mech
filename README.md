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

`sim/house.ts` is a guess at the house squad: shared vision, hunting the non-squad mech, and
four skill tiers. The real house bots are unknown. Calibration point: the kit's example bot
scores 1.15 on the real ladder but only 0.2-0.4 in this sim, so the sim is harsher than
reality.

```sh
node sim/run.ts --bot=mine --matches=5 --seed=1                     # practice vs house squad
HOUSE_STRENGTH=0.5 HOUSE_HUNT_R=300 sim/par.sh mine 5 700 3         # 3 workers x 5 matches
node sim/run.ts --mode=ffa --bot=mine --opp=mine --oppParams='{"engageAll":true}'   # self-play FFA A/B
node sim/run.ts --mode=solo --follow --nonpc --params='{"pacifist":true}'           # zone-only test
python3 sim/compare.py a.txt b.txt                                  # paired comparison by seed
node tools/replay.ts stream.jsonl.gz                                # per-tick CPU time on a recorded stream
```

## License

MIT, see `LICENSE`.
