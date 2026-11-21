# Practice candidates (branch `mech-opt`)

Each line is one commit to submit. The sim evidence is a paired comparison against the defaults on the
same seeds (200 matches, seeds 1001–1200, 95% interval) under three house models: M1 (omniscient hunters),
M1b (vision-only hunters) and M1s (strafing hunters). All three are calibrated to the real scores; see
`sim/CALIBRATION.md`. Real scores go in `SUBMISSIONS.md` on main.

Real results so far: C1 = **3.83** (+0.79 vs defaults 3.04; sim said +0.36), C2 = **4.29** (+0.46 vs C1;
sim said +0.28 to +0.38), C4 = **4.54** (+0.25 vs C2; sim said +0.05 to +0.10 against strafers and
−0.07 against non-strafers), C3 = **4.15** (C2 was 4.29), C5 = **4.31** (C4 was 4.54), C6 = **4.02**
(C4 was 4.54). Three single changes in a row came in 0.14–0.52 below their parent. Until the
unchanged-C4 resubmission measures run-to-run spread, treat real differences under about 0.3 as
unresolved. If C6's −0.52 holds up, closing to 75 m with the gun is genuinely harmful in reality. The sim
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
| 7 | b115bdc | **C4 + `kite: 2`** (single change vs the real 4.54). When choosing a fighting spot, reward spots that move us away from the centroid of the other recent threats (not the current target) while we keep line of sight to the target. A converging pack then strings out and arrives one at a time. | On C4: +0.14 ± 0.15 (M1s, strafing hunters), +0.02 ± 0.15 (M1r). | **Fight mechanics: fewer simultaneous attackers.** The sim's fatal phase is a ~30 s brawl against 2–3 hunters at once. Real > 4.54 says positioning against packs transfers like aim did. Real ≈ 4.54 means real packs don't converge the way the sim's do. |
| N | 1ce2ce5 | **C4 again, unchanged (noise check).** Done: **4.48** vs 4.54, spread 0.06. | Identical code and params to C4. | Answered: single real runs are precise to about ±0.1, so C3 (−0.14), C5 (−0.23) and C6 (−0.52) are real effects. The ladder punishes closing in and extra exposure. |
| 8 | a1f8f17 | **C4 + fight from longer range** (single change vs C4; mirror of C6): `rangeW: 0.15` with `prefGun: 130, prefLaser: 170, prefLtg: 130` (C6 used the same weight with 75/110/35). | Not A/B-tested in the sim (no time; the sim misjudged C6). Gallery: against a non-leading shooter our juke is hit ~20% at 150 m vs ~53% at 75 m, while our leadAdapt gun keeps ~43% at 150 m and the hitscan laser doesn't care about range. | **Distance is our friend.** C6 (pull in) lost 0.52. If the effect is monotonic, pulling out should gain. Real > 4.54 points to longer-range tactics (laser sniping, gun hold-off). Real < 4.54 means the default weak pull was already near-optimal, and C6's loss came from its strong pull rather than from the direction. |
| 9 | 9b3df61 | **C4 + `expW: 8`** (single change vs C4; default 4). Fighting spots exposed to threats other than the current target cost twice as much, so the bot prefers spots where only its target can see it. | Not A/B-tested in the sim yet. | **Exposure kills.** C5 and C6 (more exposure) were punished. Real > 4.54 means more cover discipline pays; then try evading earlier or peeking. |
| 10 | f6b9dc5 | **C4 + `targetHit`** (single change vs C4). Shoot the visible enemy with the shortest estimated time to kill: HP / (gun DPS × hit chance by range and strafing, from the gallery, + laser DPS). Keeps the bonuses for enemies shooting us or charging a laser. | On C4: +0.10 ± 0.14 (M1s), −0.01 ± 0.12 (M1r). | **Aim-aware target choice.** Aim transferred (C4); this spends our shots where they hit. Real > 4.54 means more aim-aware decisions should follow. |

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

Later tests on top of C4 (paired, 200 seeds):

| Idea | Effect |
| --- | --- |
| faster juke (0.25 + 0.4 s) | −0.04 (M1r), −0.19 (M1s) |
| maxGunRange 120 | −0.04 (M1r) |
| laser dodge | −0.04 (M1r, hard/expert carry lasers) |
| no-mortar loadout | −0.12 (M1r), +0.12 (M1s) |
| combo (kite + finishHp 0.3 + laserRoof 35 + harvestMaxVis 0) | +0.11 (M1s), +0.14 (M1), −0.01 (M1r) |
| leadMC (sampled strafe futures) | +0.02 (M1s); also no better than leadAdapt in the gallery |
| scouting for lasers | −0.17 / −0.21; it lowers laser possession |
| laserCrates | −0.07 / 0.00 |
| roof lasers | +0.07 / +0.06; possession unchanged, 56% → 57% |

## Built on C10 (real 4.71, the best so far): kill conversion

Real results for C7–C10: C7 kite 4.29, C8 longer range 4.27, C9 exposure weight 4.38, **C10
targetHit 4.71**. Positioning changes in either direction lost; shot-to-kill conversion won (C4 aim,
C10 target choice). Positioning stays as in C4.

| # | Commit | What changed (vs C10) | Sim vs C10 (200 paired seeds) | Real-score hypothesis |
| --- | --- | --- | --- | --- |
| 11 | c3b91df | **`smartReload`**: reload when the target is behind cover or beyond gun range with half a magazine or less, or when there's no target and the magazine is half empty, and top up whenever nobody is visible. Before: only below 60% with nobody visible. | +0.09 ± 0.15 (M1s), −0.07 ± 0.13 (M1): neutral in the sim, so this is a real-ladder question | **Fewer reloads start mid-duel.** The gun's 2.4 s reload is about 45% of its duty cycle. Moving reloads into gaps converts more of each duel into damage. |
| 12 | 93f299b | **`upg: "mag"`**: gun_mag first (+8 rounds, −20% reload, about +31% sustained gun DPS), then plating, then gun_damage. C10 uses `"dmg"`, which puts gun_damage (+15%) first. | +0.07 ± 0.09 (M1s), +0.02 ± 0.09 (M1) | **Sustained DPS converts duels.** Shortens the 15–18 s gun duel. Untested in reality: C3's −0.14 bundled `upg: auto` with the wider laser hunt. |
| 13 | e1bcd5a | **`chaseHp: 0.35`**: if an enemy below 35% HP is still tracked (true position for 5 s after it leaves view), within 130 m, and we have no clear shot, walk toward it so it can't regenerate behind cover (only while our HP > 40%). | +0.07 ± 0.12 (M1s), −0.06 ± 0.09 (M1) | **Finish the wounded.** About 30% of our damage went to bots that escaped. Caution: this is a movement change, and every movement change so far (C5–C9) lost in reality. Submit after C11/C12. |

Tried and not submitted (on C10, paired, M1s / M1):

| Idea | Effect |
| --- | --- |
| `focus: 2` (sticky target) | +0.01 ± 0.04 / −0.01 ± 0.05; targetHit rarely switches anyway |
| `gunLaserSync` (hold the gun while swinging to the laser's release point) | −0.02 ± 0.11 / −0.09 ± 0.08 |
| `targetRear` (rear-hit multiplier in time-to-kill) | −0.01 ± 0.12 / −0.05 ± 0.07 |

Suggested order: **C12** (positive in both sim models), then **C11**, then **C13** (a movement
change, so riskiest). Then stack whichever beat 4.71. The branch tip's `data/params.json` is C10.

## Recommended order (superseded: C7–C10 are done)

1. **C8** (longer range): the mirror of the clearest real signal (C6, −0.52).
2. **C9** (less exposure).
3. **C10** (aim-aware target choice).

Each is a single change on C4, so with ±0.06 run-to-run noise each result is readable. Then combine
the winners. The branch tip's `data/params.json` is C4 (the best real configuration).
