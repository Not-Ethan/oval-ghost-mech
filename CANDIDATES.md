# Practice candidates (branch `mech-opt`)

Each line is one commit to submit. The sim evidence is a paired comparison against the defaults on the
same seeds (200 matches, seeds 1001–1200, 95% interval) under three house models: M1 (omniscient hunters),
M1b (vision-only hunters) and M1s (strafing hunters). All three are calibrated to the real scores; see
`sim/CALIBRATION.md`. Real scores go in `SUBMISSIONS.md` on main.

| # | Commit | What changed | Sim vs defaults (M1 / M1b / M1s) | Real-score hypothesis it tests |
| --- | --- | --- | --- | --- |
| 1 | dee173e | `data/params.json` = `{"lootMem": true, "laserHunt": true}`: remember weapon pickups seen earlier, and without a laser walk to the nearest remembered ground laser within 250 m unless an enemy is visible within 70 m or HP < 45%. Code otherwise = scored defaults. | +0.36 ± 0.16 / +0.35 ± 0.18 / +0.41 ± 0.16 (laser by 60 s in 50% of matches instead of 25%) | **Lasers decide fights.** Sim oracle: spawning with a laser is worth +1.11 ± 0.22. If real rises to about 3.3–3.5, the laser value transfers, and finding lasers sooner (crates, exploring) is the next lever. If real stays about 3.0, real house bots dodge or outrange lasers, or the sim overrates hitscan. |
| 2 | 7de5fbb | Candidate 1 plus `harvest` (go collect the victim's cubes and weapons after a kill), `mortarUse` (fire a ready mortar with a leading solution), `loadout: "gun"` (gun+laser ranks above laser+lightning), `upg: "dmg"` (damage upgrades before armour) and `dryHold` (stay in the fight while reloading under light pressure). | vs candidate 1: +0.28 ± 0.18 / +0.38 ± 0.18 / +0.38 ± 0.16. vs defaults: 3.77 vs 3.13 / 3.80 vs 3.06 / 3.85 vs 3.06 | **Power growth adds up.** Each piece is worth about +0.05–0.1 in the sim. Real C2 − C1 ≈ +0.3 says small duel and power gains transfer, so keep stacking them. About 0 says the sim's duel model is too optimistic about these details; then focus on bigger structural levers. Submit after candidate 1. |
