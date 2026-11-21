# Practice candidates (branch `mech-opt`)

Each line is one commit to submit. The sim evidence is a paired comparison against the defaults on the
same seeds (200 matches, seeds 1001–1200, 95% interval) under three house models: M1 (omniscient hunters),
M1b (vision-only hunters) and M1s (strafing hunters). All three are calibrated to the real scores; see
`sim/CALIBRATION.md`. Real scores go in `SUBMISSIONS.md` on main.

Real results so far: C1 = **3.83** (+0.79 vs defaults 3.04; sim said +0.36), C2 = **4.29** (+0.46 vs C1;
sim said +0.28 to +0.38), C4 = **4.54** (+0.25 vs C2; sim said +0.05 to +0.10 against strafers and
−0.07 against non-strafers), C3 = **4.15** (C2 was 4.29), C5 = **4.31** (C4 was 4.54). The sim
got C1, C2 and C4 right in direction but was conservative (1.3–2× for lasers and power, about 3×
for aim against strafers). It got C3 and C5 (small laser-hunt and upgrade tweaks) wrong in sign,
or they are within real noise. Real run-to-run noise is unknown: our slot and spawn vary between
runs of the same 48 seeds, so **resubmit C4 unchanged (row "N" at the end of the table) to measure
it** before reading differences under about 0.3.

| # | Commit | What changed | Sim vs defaults (M1 / M1b / M1s) | Real-score hypothesis it tests |
| --- | --- | --- | --- | --- |
| 1 | dee173e | `data/params.json` = `{"lootMem": true, "laserHunt": true}`: remember weapon pickups seen earlier, and without a laser walk to the nearest remembered ground laser within 250 m unless an enemy is visible within 70 m or HP < 45%. Code otherwise = scored defaults. | +0.36 ± 0.16 / +0.35 ± 0.18 / +0.41 ± 0.16 (laser by 60 s in 50% of matches instead of 25%) | **Lasers decide fights.** Sim oracle: spawning with a laser is worth +1.11 ± 0.22. If real rises to about 3.3–3.5, the laser value transfers, and finding lasers sooner (crates, exploring) is the next lever. If real stays about 3.0, real house bots dodge or outrange lasers, or the sim overrates hitscan. |
| 2 | 7de5fbb | Candidate 1 plus `harvest` (go collect the victim's cubes and weapons after a kill), `mortarUse` (fire a ready mortar with a leading solution), `loadout: "gun"` (gun+laser ranks above laser+lightning), `upg: "dmg"` (damage upgrades before armour) and `dryHold` (stay in the fight while reloading under light pressure). | vs candidate 1: +0.28 ± 0.18 / +0.38 ± 0.18 / +0.38 ± 0.16. vs defaults: 3.77 vs 3.13 / 3.80 vs 3.06 / 3.85 vs 3.06 | **Power growth adds up.** Each piece is worth about +0.05–0.1 in the sim. Real C2 − C1 ≈ +0.3 says small duel and power gains transfer, so keep stacking them. About 0 says the sim's duel model is too optimistic about these details; then focus on bigger structural levers. Submit after candidate 1. |
| 3 | 7b188fe | Candidate 2 plus `upg: "auto"` (pick the upgrade with the largest marginal gain in effective HP × sustained DPS for the weapons held: gun_mag first with a gun, then plating; laser_damage with a laser) and `laserR: 400, laserNear: 45` (look for lasers up to 400 m away, and keep going while the nearest visible enemy is beyond 45 m instead of 70 m). | On top of C1: upg auto +0.03 / +0.05 / +0.03; wider laser hunt +0.01 / +0.07 / +0.03. **Direct C3 vs C2 (added after the commit): +0.00 ± 0.15 (M1), −0.10 ± 0.15 (M1s), so no gain.** Low priority; submit only if a slot would otherwise go unused. | **More laser time plus better upgrades.** A small expected step: about +0.1 in the sim, maybe +0.15–0.25 real if the 1.3–2× real/sim ratio holds. Real ≤ C2 would mean the upgrade or laser-hunt tweak hurts in reality. |
| 4 | 1ce2ce5 | **C2 + `leadAdapt`** (single change vs the real 4.29). The gun leads a target by velocity × (1 − e^(−2h·tf)) / (2h·tf), the expected travel over the bullet flight time tf of a target that reverses at rate h (estimated per track; prior 1 per 4 s). Full lead against a target running straight; less against a strafer. | M1s (strafing hunters): +0.10 ± 0.10 on defaults, +0.05 ± 0.10 on C1, +0.10 ± 0.15 on C3. M1 (easy hunters don't strafe): −0.07 ± 0.07 on C1, −0.04 ± 0.14 on C3. | **Real hunters strafe, so the gun misses with full lead.** The recorded real enemy strafed at 8–16 m/s and reversed every 0.5–1.5 s. Real > 4.29 means our real gun accuracy against strafers was a bottleneck; more aim work then pays (e.g. aim at the centre of the strafe band). Real < 4.29 means real hunters move more predictably than the stream suggests. |
| 5 | e5ba0ec | **C4 + `laserNear: 0, laserHp: 0.25`** (single change vs the real 4.54). Walk to a remembered ground laser whatever enemies are visible (still fighting while moving), down to 25% HP. Before, the hunt aborted when an enemy was within 70 m or HP was below 45%. | Measured on C3: +0.11 ± 0.15 (M1), +0.10 ± 0.13 (M1s). Laser possession 56% → 60% (M1), 58% → 61% (M1s). In 200 sim matches, 34 of the 84 without a laser had one known but kept aborting while crawling toward it under fire. | **Laser possession is still the bottleneck.** C1's real jump (+0.79 for about +26 points of possession) implies a laser match is worth about +3 kills in reality, so +4 points ≈ +0.1–0.15 real. Real ≥ 4.65 confirms it; then pursue the remaining gap (lasers never seen: scouting). Real ≤ 4.54 means rushing lasers under fire costs more than it gains in reality. |
| 6 | 4e87107 | **C4 + `rangeW: 0.15`** (single change vs the real 4.54; was 0.02). Fighting spots are pulled toward the weapon's preferred range (gun 75 m, gun+laser 110 m, lightning 35 m) instead of wherever cover and exposure put them. | On C4: +0.01 ± 0.17 (M1r, long-range hunters), +0.06 ± 0.15 (M1s). Neutral in the sim, which underrated the aim fix about 3×. Shooting gallery (`sim/aimbench.ts`): our gun hits a stream-like strafer 88% at 75 m vs 66/50/43% at 100/125/150 m. | **Real fights happen too far away for the gun.** The recorded real enemy fought from about 150 m. Real > 4.54 means range was costing gun hits, so a gun-only "close to 75 m" rule should go further. Real < 4.54 means closing in costs more exposure than it gains, so stay at range and lean on the laser. Independent of C5, so the two can be combined later. |
| N | 1ce2ce5 | **C4 again, unchanged (noise check).** Submit this commit as is. | Identical code and params to C4 (real 4.54). | **How noisy is one real score?** The difference from 4.54 estimates run-to-run noise. If it's ≥ 0.2, then C3/C5's drops and even C4's +0.25 are uncertain, and only repeated or large differences should steer us. |

## Sim findings behind these candidates (M1 unless noted; 200 paired seeds, 95% intervals)

**Why the default bot dies (instrumented sim):** score ≈ kills, and the house never kills its own.
- The first duel, against one easy hunter, is won about 100% of the time, but slowly: 15–18 s
  for 1400 HP. The gun's 12-round magazine and 2.4 s reload cap sustained DPS at about 100.
- Each kill brings 2 more hunters, so after the second kill the match turns into one continuous
  brawl of about 30 s with a median of 5 mechs involved and 2–3 hunters shooting. It ends in death,
  mostly to mediums.
- After a kill, the next mech damage arrives within 3 s (median), so regen never starts.
- About 30% of our damage goes to bots that escape and regenerate.
- Kill cubes were barely collected: 0.66 of about 6 per match.
- Only 25% of matches ever got a laser, and almost always in the first 6 s.

**Oracles (what a resource is worth if handed over):**

| Oracle | Effect |
| --- | --- |
| laser at spawn | +1.11 ± 0.22 |
| lightning at spawn | +0.21 |
| 3 / 6 / 10 cubes at spawn | +0.38 / +0.56 / +0.96 |
| full heal on each kill (on candidate 2) | +0.79 (M1), +0.61 (M1b) |

**Neutral or negative, not adopted:**

| Idea | Effect |
| --- | --- |
| crate/drone farming | ±0.1 |
| mild cube grab | ~0 |
| focus stickiness | ~0 |
| peek-cover fighting spots | ±0.07 |
| laser dodge | 0; sim hunters rarely carry lasers, so untestable |
| adaptive gun lead | −0.07 (M1), +0.05 to +0.10 (strafing M1s) |
| boost to loot | ~0 |
| periodic 360° scan | ~0 |
| longer laser search radius | +0.03 |
| laserSafe | −0.05 |
| rearAware (on candidate 2) | −0.03 |
| attackersOnly (ignore idle bots) | −0.29 / −0.23 / −0.15 |
