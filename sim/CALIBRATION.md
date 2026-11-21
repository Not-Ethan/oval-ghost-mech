# House-squad calibration (sim/house.ts)

The real house bots are unknown. The scorer returns only a mean score per submission. This model is fitted
to four real practice scores. Treat it as a guess that is consistent with those scores, not as a
measurement.

## Facts used

- Track page: 4 easy, 4 medium, 4 hard and 3 expert bots form one squad. They share vision, never fight
  each other, and "hunt you weakest first (one early, more as you thin them out, all of them late)".
- Real practice scores (48 matches each, mean of 16 − place):

| Variant | Real |
| --- | --- |
| defaults (commit 1570b66) | 3.04 |
| `{"engageAll": true}` | 3.02 |
| `{"pacifist": true, "lootNoise": false}` (never fires) | 0.08 |
| kit example bot (`python/example_bot.py`, ported as `ExampleBot`) | 1.15 |

## Model M1 (the sim default)

- **Hunters:** the squad sorts its living members weakest tier first (then by slot). The first
  `H = HUNT_BASE + HUNT_PER_KILL × deadMembers = 1 + 2 × dead` of them are hunters. After
  `HUNT_ALL_T = 300` s, every member hunts.
- **Hunter behaviour:** a hunter paths to the enemy and fights it. With `HOUSE_OMNI=1` (M1) it always
  knows where the enemy is. With `HOUSE_OMNI=0` (M1b) it knows only what a squad member sees, and
  otherwise investigates gunfire sounds.
- **Idle members** (`IDLE_R=0`, `IDLE_RETALIATE=0`) roam inside the next circle and loot. They do not
  shoot the enemy even when it shoots them. They do shoot drones that attack them.
- **Tiers** (`BASE` in house.ts): Gaussian aim error resampled every 0.3 s (easy 3.0°, medium 2.0°,
  hard 1.3°, expert 0.8°), lead fraction (0, 0.5, 0.85, 1.0), reaction time, range and strafing.
  Calibrated: easy aim error × 2.2 (`H_AIM_EASY`, so 6.6°).
- **Sanity fixes:** house bots no longer die on their own. They shoot drones that attack them, hold
  fire while a squadmate is in the line of fire, and steer directly (jumping and jetting) when A* fails.
  Before these fixes, about 0.2–0.3 of every sim score came from house bots killed by drones, the zone
  or friendly fire. Real data (pacifist 0.08) says this rarely happens in real matches.

## Fit (seeds 1–100, sim mean ± 95% interval)

| Variant | Real | M1 (omniscient) | M1b (vision only) |
| --- | --- | --- | --- |
| defaults | 3.04 | 3.07 ± 0.22 | 3.06 ± 0.21 |
| engageAll | 3.02 | 3.13 ± 0.24 | not run |
| pacifist | 0.08 | 0.03 ± 0.03 | 0.07 ± 0.05 |
| example bot | 1.15 | 1.09 ± 0.14 | 1.07 ± 0.17 |

Two more variants fit with the same knobs and no retuning:

- **M1s** (`H_MOVE=1`): engaged hunters strafe across the line of fire at walk speed (hard and
  expert boost sometimes), reverse every 0.4–1.4 s and close in slowly. This mimics the enemy in the
  real recorded stream (`check/stream.jsonl.gz`, mech 10): median tangential speed 7.8 m/s, reversals
  every ~0.5–1.5 s, +2 m/s closing, about 1° median aim error, 4 of 4 lasers hit at 56–150 m.
  It gives defaults 2.98 ± 0.22 and example 1.06 ± 0.14.
- **M1r** (M1s plus `H_RANGE=1 H_LASER_TIERS=hard,expert`): hunters fight from 90 m with a gun or
  140 m with a laser, and hard/expert bots start with a laser. It gives defaults 2.94 ± 0.18 and
  example 1.16 ± 0.11.

Each residual is under 0.11, inside the sim's own noise. A real 48-match score probably carries about
±0.3–0.4 (95%) of noise as well.

## How it was fitted, and what was rejected

1. The old model had every member hunting within range. It gave defaults 2.36, example 0.55 and
   pacifist 0.31, the last from drone and friendly-fire deaths.
2. Structure B: idle members fight back for 6 s when shot. After calibration it gave example
   0.59–0.60 while defaults was 2.4–2.7. The example bot shoots every mech it sees, so retaliating idle
   members kill it. B cannot reach 1.15 without making every tier much weaker. Rejected, weakly.
3. Structure C (idle members passive) fits engageAll ≈ defaults and pacifist ≈ 0 with no tuning. Two
   knobs then fit the two informative points: easy aim error (moves the example bot most) and
   escalation per kill (moves our bot most). `HUNT_ALL_T=150` and `HUNT_PER_MIN=1` barely moved either
   score, because our bot dies at about 85–110 s.

## What this does not pin down (be careful)

- Two informative data points were fitted with two knobs. Pacifist and engageAll are consistency
  checks, not independent fits.
- Omniscient and vision-only hunting both fit, so every candidate is A/B-tested under both
  (`sim/ab.sh`).
- Time-based and kill-based escalation cannot be told apart from our data, and neither can the real
  tiers' movement and aim. In the sim, our gun hits about 89% of shots. The real hit rate is unknown,
  and against real strafing bots it is probably lower.
- Each new real score is a new calibration point. See `SUBMISSIONS.md` on main.

## Tools

```sh
OUT=/some/dir sim/batch.sh NAME mine 200 1001 4 --params='{...}'   # batch + summary (timelines in $OUT/NAME.jsonl)
sim/ab.sh NAME '{"farm":true}'                                      # paired A/B vs defaults under M1 and M1b
python3 sim/analyze.py $OUT/NAME.jsonl                              # deaths, killers, fights, accuracy, cubes
python3 sim/analyze.py $OUT/NAME.jsonl --timeline 1007              # one match's event timeline
# house knobs (env): H_AIM_EASY H_AIM_MED H_AIM_HARD H_AIM_EXP H_AIM H_REACT HUNT_BASE HUNT_PER_KILL
#                    HUNT_PER_MIN HUNT_ALL_T HOUSE_OMNI IDLE_R IDLE_RETALIATE H_EASY_LOOT
```
