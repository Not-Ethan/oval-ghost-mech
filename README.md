# oval-ghost: a Mech Royale bot (`mechfight/1`)

This bot pilots one mech in the 16-mech battle royale on the OSU Oval map. It plays for
placement: it stays inside the zone and in cover, and fights only when the fight pays off.

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
  50 m, or are aimed at it, including a laser charge pointed at it. It also fights good
  opportunities: low-HP targets, a lone nearby enemy, or an enemy already losing HP to
  someone else (third-party). It watches other enemies without firing, so it does not give
  away its position.
- **Positioning.** It scores nearby reachable cells by exposure to the known threats (line of
  sight from their eyes), static cover, zone safety, and preferred weapon range. When
  outnumbered or hurt, it evades to cells no threat can see. Below 50% HP it recovers: it
  hides until it has regenerated to 85%.
- **Aim.** For the gun it solves for the projectile intercept and fires only when the actual
  torso aim is within the target's angular size. The laser charges fully and releases on
  alignment. Lightning fires inside its range and cone. The mortar is used only against slow
  targets.
- **Survival details.** It strafes randomly against visible shooters, and moves out of
  incoming bullet lines and predicted mortar impacts. It keeps its torso facing threats,
  since rear hits do 1.5x damage. It jumps and jets free when stuck.
- **Loot and upgrades.** Slot-1 weapon preference is laser, then lightning, then mortar. It
  collects cubes and drone and crate loot when nobody is around. Upgrade priority is armor,
  plating, nanites, then weapon upgrades.

## Performance

Startup loads the cached map data and warms up the JIT on synthetic observations. A forced
GC follows, then it sends `ready`. Typical per-tick compute is under 1 ms. A deadline caps
the expensive searches (tactical spot search, path replanning, distance field) at about
6 ms per tick, and leftover work moves to later ticks.

## License

MIT, see `LICENSE`.
