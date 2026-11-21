// Decision logic: survive first (zone, cover, line-of-sight), fight when it pays, aim with lead.
import { World } from "./world.ts"
import { Nav } from "./nav.ts"
import { Cover } from "./cover.ts"
import { loadCache, mapHashOf } from "./mapcache.ts"
import { fileURLToPath } from "node:url"
import { existsSync, readFileSync } from "node:fs"

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const hyp = Math.hypot

type Track = {
  id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number
  hp: number; maxHp: number; weapons: string[]; charging: boolean; aimYaw: number; aimPitch: number
  lastSeen: number; firstSeen: number; visible: boolean; cubes: number; seenStreak: number
  lastShotAtUs: number
  rev?: { t: number; vx: number; vy: number; flips: number[] } // velocity reversal history (adaptive lead)
}

type Cand = { x: number; y: number; z: number; c: number; score: number; dist: number; exp: number }

const UPGRADE_PRIOS: Record<string, string[]> = {
  plating: ["plating", "gun_damage", "laser_damage", "gun_rate", "nanites", "armor", "laser_charge", "lightning_efficiency", "servos", "gyros", "gun_velocity", "gun_mag", "capacitor", "reactor", "jets", "lightning_range", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"],
  regen: ["nanites", "plating", "gun_mag", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "armor", "lightning_efficiency", "servos", "gyros", "gun_velocity", "capacitor", "reactor", "jets", "lightning_range", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"],
  mag: ["gun_mag", "plating", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency", "nanites", "armor", "servos", "gyros", "gun_velocity", "capacitor", "reactor", "jets", "lightning_range", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"],
  dmg: ["gun_damage", "laser_damage", "gun_rate", "plating", "laser_charge", "lightning_efficiency", "nanites", "armor", "servos", "gyros", "gun_velocity", "gun_mag", "capacitor", "reactor", "jets", "lightning_range", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"],
}
const UPGRADE_PRIO = ["armor", "plating", "nanites", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency", "servos", "gyros", "gun_velocity", "capacitor", "reactor", "jets", "lightning_range", "gun_mag", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"]
const WEAPON_PRIO: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }
// value of a two-slot loadout (order irrelevant)
const LOADOUTS: Record<string, Record<string, number>> = {
  old: {
    "+": 0, "+gun": 1, "+laser": 2.5, "+lightning": 2, "+mortar": 1,
    "gun+laser": 7, "gun+lightning": 6.5, "gun+mortar": 3.5,
    "laser+lightning": 9, "laser+mortar": 4.5, "lightning+mortar": 4,
  },
  // like "gun", but never carry a mortar: an enemy laser does +60% (cook-off) to a mech holding one
  nomortar: {
    "+": 0, "+gun": 1, "+laser": 2.5, "+lightning": 2, "+mortar": 0.5,
    "gun+laser": 9, "gun+lightning": 6, "gun+mortar": 0.8,
    "laser+lightning": 7, "laser+mortar": 2, "lightning+mortar": 1.5,
  },
  // keep the gun: house hunters fight from ~65-100 m, outside lightning range
  gun: {
    "+": 0, "+gun": 1, "+laser": 2.5, "+lightning": 2, "+mortar": 1,
    "gun+laser": 9, "gun+lightning": 6, "gun+mortar": 4,
    "laser+lightning": 7, "laser+mortar": 5, "lightning+mortar": 3.5,
  },
}
function loadoutValue(a: string | null, b: string | null, table: Record<string, number> = LOADOUTS.old): number {
  const k = [a ?? "", b ?? ""].sort().join("+")
  return table[k] ?? 0
}

export type BrainOpts = { world?: World; nav?: Nav; mapDir?: string; debug?: boolean; params?: Partial<Params> }

export type Params = {
  engageAll: boolean // v1: engage any visible enemy in range
  lootNoise: boolean // shoot crates / drones for cubes when nobody is around
  recoverLo: number // start recovering (hide + regen) below this HP fraction
  recoverHi: number // recovered above this
  maxGunRange: number
  lonelyDuelRange: number // engage a lone enemy within this range
  engageRange: number // engage any shootable visible enemy within this range when healthy and few are visible
  lootNoiseUntil: number // only farm crates/drones before this match time
  relocate: boolean // after contact, move well away from where threats last saw us
  ffaEngageRange: number // engage range once we see other mechs fighting each other (free-for-all)
  engageAllUntilFfa: boolean // engage every visible enemy until we see others fighting each other
  fireSlack: number // extra aim error allowed for the gun, as a fraction of one tick of torso slew
  rearAware: boolean // keep active shooters in the front arc when choosing targets / spots
  drops: boolean // go for supply drops when uncontested
  pacifist?: boolean // testing only: never fire
  farm: boolean // walk to remembered crates / drones and shoot them for cubes while no enemy has been seen recently
  farmMaxCubes: number // stop farming at this many cubes (stats cap at 10)
  farmR: number // farm targets within this distance
  farmQuiet: number // seconds without seeing an enemy before farming
  cubeGrab: boolean // pick up cubes after kills more aggressively (also mid-fight when close)
  upg: string // upgrade priority: "old" (armor first), "plating", "dmg", "mag"
  harvest: boolean // after a kill, go collect the victim's cubes (and weapon) while few enemies are visible
  harvestMaxVis: number // ... with at most this many visible enemies within 120 m
  harvestHp: number // ... and HP fraction above this
  harvestS: number // seconds after the kill the harvest stays a goal
  attackersOnly: boolean // engage only mechs that shot us recently (or are very close / charging at us), plus kills to finish
  focus: number // target stickiness: score bonus for the current target (0 = off)
  dryHold: boolean // reloading with nothing else to fire: stay in the fight (strafe) when incoming damage is light
  rangeW: number // weight of the preferred-range term when choosing a fighting spot
  loadout: string // weapon loadout table: "old" (laser+lightning best) or "gun" (gun+laser best)
  mortarUse: boolean // fire the mortar whenever it is ready (leading the target), swinging the torso off the gun aim
  leadAdapt: boolean // scale gun lead by the expected travel of a target that reverses direction (rate estimated per track)
  jukeMin: number // dodge: minimum seconds between random strafe reversals
  jukeVar: number // dodge: extra random seconds between reversals
  jukeW: number // dodge: weight of the strafe against the path direction while moving
  peek: number // fight spots: bonus for seeing the target with a fully hidden spot within 9 m (0 = off)
  lootMem: boolean // remember weapon pickups seen earlier and walk to them when nothing threatens
  laserHunt: boolean // without a laser: go for a remembered ground laser (needs lootMem) unless an enemy is close
  laserR: number // ... within this distance
  laserNear: number // ... and no visible enemy within this distance
  lootBoost: boolean // boost (energy permitting) while walking to a laser or harvesting
  scanEvery: number // with no enemy seen for 8 s, sweep the torso through a full circle every this many seconds (0 = off)
  laserDodge: boolean // a visible enemy charging a laser aimed at us: break line of sight (evade) until it fires or stops
  laserSafe: boolean // laserHunt also holds off for enemies seen in the last 3 s (not only visible ones) and recent damage
  laserEngageR: number // holding a laser: open fire on any shootable visible enemy within this range (0 = off)
  laserHold: boolean // a full charge whose target just broke line of sight is held (up to the auto-fire limit) instead of released into cover
  dropsAgg: boolean // go for supply drops (full HP + 3 cubes) within dropR m even with enemies around, unless 2+ are visible within 60 m
  dropR: number // ... within this distance
  laserCrates: boolean // no laser held or known: break remembered ground crates within 150 m (1 in 6 holds a laser)
  harvestW: boolean // harvest also goes for a laser dropped at the kill spot when we hold none (needs lootMem)
  laserRoof: number // laserHunt also targets lasers on roofs up to this many metres above our feet (0 = ground only); jets up
  regenHold: number // below this HP fraction start no new opportunistic fights and shoot no crates/drones, so regen can start (0 = off)
  finishHp: number // don't evade while the current shootable target is below this HP fraction: finish the kill (0 = off)
  kite: number // fight spots: reward moving away from the centroid of the other recent threats (strings out a pack; 0 = off)
  laserHp: number // laserHunt only above this HP fraction
  scoutT: number // until this match time, with no laser known and no enemy visible: walk to the most open spot within ~60 m and sweep (0 = off)
  leadMC: boolean // gun lead from sampled strafe futures (pooled reversal intervals, time since the target's last reversal, accel limit); aim at the window with the most samples
  fireMinP: number // with leadMC: fire the gun only when the estimated hit chance of the shot is at least this (0 = off)
  leadMCMean: boolean // leadMC aims at the mean of the sampled futures instead of the densest window
  targetHit: boolean // choose the target with the shortest estimated time to kill (gun hit chance by range and strafing, laser hitscan)
  prefGun: number // preferred fighting range with a gun (no laser/lightning)
  prefLaser: number // preferred fighting range with a laser (no lightning)
  expW: number // fight spots: penalty per unit of exposure to threats other than the target
  prefLtg: number // preferred fighting range with lightning
}

export const DEFAULT_PARAMS: Params = {
  engageAll: false,
  lootNoise: true,
  recoverLo: 0.5,
  recoverHi: 0.85,
  maxGunRange: 160,
  lonelyDuelRange: 60,
  engageRange: 110,
  lootNoiseUntil: 60,
  relocate: true,
  ffaEngageRange: 60,
  engageAllUntilFfa: false,
  fireSlack: 0.25,
  rearAware: false,
  drops: true,
  pacifist: false,
  farm: false,
  farmMaxCubes: 10,
  farmR: 160,
  farmQuiet: 15,
  cubeGrab: false,
  upg: "old",
  harvest: false,
  harvestMaxVis: 1,
  harvestHp: 0.3,
  harvestS: 30,
  attackersOnly: false,
  focus: 0,
  dryHold: false,
  rangeW: 0.02,
  loadout: "old",
  mortarUse: false,
  leadAdapt: false,
  jukeMin: 0.35,
  jukeVar: 0.6,
  jukeW: 0.55,
  peek: 0,
  lootMem: false,
  laserHunt: false,
  laserR: 250,
  laserNear: 70,
  lootBoost: false,
  scanEvery: 0,
  laserDodge: false,
  laserSafe: false,
  laserEngageR: 0,
  laserHold: false,
  dropsAgg: false,
  dropR: 220,
  laserCrates: false,
  harvestW: false,
  laserRoof: 0,
  regenHold: 0,
  finishHp: 0,
  kite: 0,
  laserHp: 0.45,
  scoutT: 0,
  leadMC: false,
  fireMinP: 0,
  leadMCMean: false,
  targetHit: false,
  prefGun: 75,
  prefLaser: 110,
  expW: 4,
  prefLtg: 35,
}

export class Brain {
  w!: World
  nav!: Nav
  cfg: any
  opts: BrainOpts
  slot = 0
  rs = 1
  t = 0
  tick = 0
  tracks = new Map<number, Track>()
  npcs = new Map<number, any>()
  crates = new Map<number, { x: number; y: number; z: number; hp: number; t: number; since: number }>()
  pickMem = new Map<number, { id: number; kind: string; pos: number[]; t: number }>()
  farmId = -1
  farmSince = 0
  farmBan = new Set<number>()
  harvests: { x: number; y: number; z: number; t: number }[] = []
  lastTargetId = -1
  sweepT0 = -99
  laserFullSince = -1
  crateGoal: any = null
  scoutSpot: number[] | null = null
  flipIntervals: number[] = []
  scoutSweepT = -1
  sweepYaw0 = 0
  lastTargetT = -99
  // movement
  path: number[] | null = null
  pathGoal: number[] | null = null
  pathT = -99
  dest: number[] | null = null
  destT = -99
  destWhy = ""
  hold: number[] | null = null
  holdKey = ""
  stuckT = 0
  lastPos: number[] = [0, 0, 0]
  jukeDir = 1
  jukeT = 0
  // combat
  lastDamagedT = -99
  lastDealtT = -99
  dmgWindow: { t: number; a: number }[] = []
  threatBearings: { t: number; b: number; by: number | null }[] = []
  sounds: { t: number; b: number; kind: string; dist: string; x: number; y: number }[] = []
  scanBase = 0
  scanT = 0
  laserReleaseT = -99
  wantSlot1: string | null = null
  mode = "init"
  modeSince = 0
  lastObs: any = null
  timeStats = { n: 0, max: 0, sum: 0 }
  dfield: Float32Array | null = null
  dfieldT = -99
  dfieldPos: number[] = [0, 0]
  cover!: Cover
  deadline = 0
  budgetMs = 6
  crateTarget = -1
  debugOn = false
  dbg: string[] = []
  sec: Record<string, number> = {}
  mark(name: string, t0: number) { this.sec[name] = (this.sec[name] ?? 0) + performance.now() - t0 }

  P: Params
  recovering = false
  npcAggro: { t: number; b: number; id: number } | null = null
  hpHist: Map<number, { t: number; hp: number }[]> = new Map()

  constructor(opts: BrainOpts) {
    this.opts = opts
    // optional overrides: data/params.json (for quick A/B variants without code edits)
    let fileParams: any = {}
    if (!opts.params) {
      try {
        const f = fileURLToPath(new URL("../data/params.json", import.meta.url))
        if (existsSync(f)) {
          const j = JSON.parse(readFileSync(f, "utf8"))
          if (j && typeof j === "object") for (const k of Object.keys(j)) if (k in DEFAULT_PARAMS && typeof j[k] === typeof (DEFAULT_PARAMS as any)[k]) fileParams[k] = j[k]
          process.stderr.write("params override: " + JSON.stringify(fileParams) + "\n")
        }
      } catch (e) {
        process.stderr.write("params.json ignored: " + e + "\n")
      }
    }
    this.P = { ...DEFAULT_PARAMS, ...fileParams, ...(opts.params ?? {}) }
    if (opts.world) this.w = opts.world
    if (opts.nav) this.nav = opts.nav
    this.debugOn = !!opts.debug
  }

  rand(): number {
    this.rs = (this.rs * 1664525 + 1013904223) >>> 0
    return this.rs / 4294967296
  }

  hello(h: any) {
    this.cfg = h.config
    this.slot = h.slot
    this.rs = (h.seed >>> 0) || 1
    const dir = h.map?.dir ?? this.opts.mapDir ?? "/arena"
    const T0 = performance.now()
    const ph: string[] = []
    const lap = (name: string) => ph.push(`${name} ${(performance.now() - T0).toFixed(0)}`)
    let cache = null
    try {
      const file = fileURLToPath(new URL("../data/map.bin", import.meta.url))
      const hash = mapHashOf(dir)
      lap("hash")
      cache = loadCache(file, hash)
      lap("cache")
      if (!cache) process.stderr.write("map cache missing or map changed: computing at startup\n")
    } catch (e) {
      process.stderr.write("map cache load failed: " + e + "\n")
    }
    if (!this.w) this.w = World.load(dir, cache?.blockMax ?? null)
    lap("world")
    if (!this.nav) {
      this.ownsNav = true
      const m = this.cfg?.mech ?? {}
      this.nav = new Nav(this.w, m.radius ?? 2.5, m.height ?? 9, m.step_up ?? 1.2, m.max_slope_deg ?? 50, cache ? { fzQ: cache.fzQ, clearQ: cache.clearQ, comp: cache.comp } : null)
    }
    lap("nav")
    this.dfield = new Float32Array(this.nav.walk.length)
    this.cover = new Cover(this.w, this.nav)
    if (cache && !this.cover.setData(cache.near, cache.open)) process.stderr.write("cover data size mismatch\n")
    lap("cover")
    if (this.ownsNav) process.stderr.write("startup ms: " + ph.join(", ") + "\n")
  }

  overBudget(): boolean { return performance.now() > this.deadline }

  // Exercise the decision code on synthetic observations so the JIT compiles it before the match.
  // >1 on slow machines: scales down search effort so ticks stay well inside the 50 ms budget
  slow = 1
  benchmark() {
    // minimum over short runs, so a preempted run on a busy host does not count as "slow"
    let r = 12345
    const rnd = () => { r = (r * 1103515245 + 12345) >>> 0; return r / 4294967296 }
    let best = Infinity
    for (let run = 0; run < 6; run++) {
      const t0 = performance.now()
      for (let i = 0; i < 80; i++) {
        const ax = -400 + rnd() * 900, ay = -300 + rnd() * 650
        const bx = ax + (rnd() - 0.5) * 240, by = ay + (rnd() - 0.5) * 240
        this.w.sees(ax, ay, this.w.groundHeight(ax, ay) + 8, bx, by, this.w.groundHeight(bx, by) + 6, true)
      }
      best = Math.min(best, performance.now() - t0)
    }
    // about 1 ms per 80 rays on a fast core once compiled
    this.slow = Math.max(1, Math.min(20, best / 1.0))
    if (this.slow > 2) this.budgetMs = 4
    if (this.slow > 4) this.budgetMs = 3
    return best
  }

  warmup(h: any, ms = 600) {
    const t0 = performance.now()
    const cfg = h.config
    const stats = { ...cfg.mech }
    const wst = (k: string) => ({ ...cfg.weapons[k] })
    let c = this.nav.nearestMain(0, 0, 200)
    if (c < 0) return
    const x = this.nav.cx(c), y = this.nav.cy(c), z = this.nav.z[c]
    const mk = (t: number, enemies: number, extra: any = {}) => ({
      type: "obs", tick: Math.round(t * 20), t, alive: 16,
      self: { id: h.slot, pos: [x, y, z], vel: [3, 1, 0], aim: [0.3, 0], hp: 900, max_hp: 1400, energy: 60, max_energy: 100, grounded: true, cubes: 1, upgrades: [], in_zone: true,
        weapons: [{ kind: "gun", cooldown: 0, ammo: 8, reload: 0, stats: wst("gun") }, { kind: "laser", cooldown: 0, charge: (t * 7) % 1, stats: wst("laser") }], stats },
      mechs: Array.from({ length: enemies }, (_, i) => ({ id: 20 + i, kind: "mech", pos: [x + 40 + i * 30, y + 20 - i * 25, z], vel: [2, -3, 0], aim: [Math.PI, 0], hp: 700, max_hp: 1400, cubes: 0, weapons: ["gun", i % 2 ? "laser" : "lightning"], charging: i === 1 })),
      projectiles: enemies ? [{ id: 1, kind: "gun", pos: [x + 20, y + 5, z + 6], vel: [-250, -10, 0] }, { id: 2, kind: "mortar", pos: [x + 30, y, z + 30], vel: [-20, 0, 5] }] : [],
      crates: [{ id: 1000, pos: [x + 15, y, z], hp: 300 }], cubes: [{ id: 5000, pos: [x + 10, y + 3, z] }], pickups: [{ id: 8000, kind: "lightning", pos: [x + 2, y + 1, z] }],
      sounds: [{ kind: "gun", bearing: 1, dist: "mid", age: 0.1 }], beams: [],
      events: enemies ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: 0.5, by: 20 }] : [],
      drops: [], zone: { center: [x + 50, y], radius: 400, next_center: [x + 300, y + 100], next_radius: 240, shrink_start: t + 5, shrink_end: t + 40, dps: 20 },
      offer: { id: 1, expires: t + 5, choices: [{ id: "armor" }, { id: "gun_rate" }, { id: "sensors" }] }, ...extra,
    })
    let t = 1
    try {
      while (performance.now() - t0 < ms) {
        for (const n of [0, 1, 3, 2, 0]) { this.decide(mk(t, n)); t += 0.1 }
        this.decide(mk(t, 0, { zone: { center: [x + 400, y], radius: 380, next_center: [x + 400, y], next_radius: 300, shrink_start: 0, shrink_end: t + 5, dps: 20 } }))
        t += 0.1
      }
    } catch (e) {
      process.stderr.write("warmup error: " + ((e as any)?.stack ?? e) + "\n")
    }
    try { this.benchmark(); process.stderr.write(`speed factor ${this.slow.toFixed(2)}\n`) } catch {}
    // reset match state
    this.tracks.clear(); this.npcs.clear(); this.path = null; this.pathGoal = null; this.pathT = -99
    this.dest = null; this.destT = -99; this.hold = null; this.holdKey = ""; this.stuckT = 0; this.mode = "init"
    this.dmgWindow = []; this.threatBearings = []; this.sounds = []; this.lastDamagedT = -99; this.lastDealtT = -99
    this.dfieldT = -99; this.timeStats = { n: 0, max: 0, sum: 0 }; this.jukeT = 0; this.scanT = 0; this.scanStartYaw = null; this.recovering = false; this.npcAggro = null; this.hpHist.clear(); this.directMode = false
    this.crates.clear(); this.pickMem.clear(); this.harvests = []; this.scoutSpot = null; this.scoutSweepT = -1; this.farmId = -1; this.farmBan.clear(); this.relocTarget = null; this.relocUntil = 0; this.relocT = -99; this.ffaEvidence = 0; this.ffaDetectedAt = -1; this.ourHits.clear()
  }

  // ------------------------------------------------------------------ helpers
  wcfg(kind: string): any { return this.cfg?.weapons?.[kind] ?? {} }

  zoneAt(o: any, T: number): { cx: number; cy: number; r: number } {
    const z = o.zone
    const cx = z.center[0], cy = z.center[1], r = z.radius
    if (T <= this.t) return { cx, cy, r }
    const s0 = z.shrink_start, s1 = z.shrink_end
    if (T <= s0 || s1 <= s0) {
      return { cx, cy, r }
    }
    // linear motion from the circle at max(t, s0) to next at s1
    const from = Math.max(this.t, s0)
    // circle at 'from': if t < s0 it is the current circle; if t >= s0, current is already interpolated
    const f = clamp((T - from) / Math.max(1e-6, s1 - from), 0, 1)
    return { cx: cx + (z.next_center[0] - cx) * f, cy: cy + (z.next_center[1] - cy) * f, r: r + (z.next_radius - r) * f }
  }

  // Can an eye at (ex,ey,ez) see a mech standing at (x,y,z)? near: proximity (canopy ignored)
  losTo(ex: number, ey: number, ez: number, x: number, y: number, z: number, h = 9): boolean {
    const d = hyp(x - ex, y - ey)
    const canopy = d > (this.cfg?.vision?.near_range ?? 45)
    return this.w.sees(ex, ey, ez, x, y, z + h * 0.5, canopy) || this.w.sees(ex, ey, ez, x, y, z + h, canopy)
  }

  myEye(o: any): number { return o.self.pos[2] + (o.self.stats?.eye_height ?? 8) }

  // ------------------------------------------------------------------ main
  act(o: any): any {
    const t0 = performance.now()
    this.deadline = t0 + this.budgetMs
    let a: any
    try {
      a = this.decide(o)
    } finally {
      const dt = performance.now() - t0
      if (dt > 8 && (globalThis as any).__MF_SLOWLOG) (globalThis as any).__MF_SLOWLOG(`slow act ${dt.toFixed(1)}ms t=${o.t} mode=${this.mode} path=${this.path?.length ?? -1} cover=${this.cover.loaded}`)
      this.timeStats.n++
      this.timeStats.sum += dt
      if (dt > this.timeStats.max) this.timeStats.max = dt
    }
    return a
  }

  decide(o: any): any {
    this.t = o.t
    this.tick = o.tick
    const me = o.self
    const [x, y, z] = me.pos
    const a: any = { tick: o.tick, move: [0, 0], fire: [false, false] }
    this.dbg = []
    this.sec = {}

    // mechs grow with cubes: keep the nav grid's clearance in step (only when owning the nav)
    const rad = typeof me.stats?.radius === "number" ? me.stats.radius : (this.cfg?.mech?.radius ?? 2.5) * (1 + (this.cfg?.cubes?.size_per_cube ?? 0.05) * (me.cubes ?? 0))
    if (this.ownsNav && typeof rad === "number" && rad > this.nav.radius + 0.2 && performance.now() < this.deadline - 4) {
      this.nav.setRadius(rad)
      this.path = null
      this.hold = null
    }
    const tP = performance.now()
    this.updateTracks(o)
    this.processEvents(o)
    this.mark("pre", tP)

    // upgrades
    if (o.offer && o.offer.choices?.length) a.pick = this.pickUpgrade(o.offer.choices, me)

    // weapon pickups within reach
    this.handleTake(o, a)

    // threat picture
    const maxHp = me.max_hp || 1400
    const hpFrac = me.hp / maxHp
    const threats = this.activeThreats(o)
    const visible = threats.filter((tr) => tr.visible)
    const recentDmg = this.recentDamage(3)

    this.mark("pre2", tP)
    // zone urgency
    const zn = o.zone
    const dCur = hyp(x - zn.center[0], y - zn.center[1])
    const walk = me.stats?.walk_speed ?? 11.7
    const zoneInfo = this.zoneUrgency(o, x, y, walk)

    // ---- engagement picture
    const hostile = visible.filter((tr) => this.isThreatening(o, tr))
    const opps = visible.filter((tr) => !hostile.includes(tr) && this.isOpportunity(o, tr, visible.length, hpFrac))
    const allMode = this.P.engageAll || (this.P.engageAllUntilFfa && this.ffaEvidence < 3)
    const engageSet = allMode ? visible : [...hostile, ...opps]
    const target = this.chooseTarget(o, engageSet)
    const engaged = engageSet.length > 0
    // recover: hide and regenerate when hurt and nobody is pressing us
    if (hpFrac < this.P.recoverLo) this.recovering = true
    if (hpFrac > this.P.recoverHi) this.recovering = false

    let dest: number[] | null = null
    let why = ""
    let urgent = false
    let tS = performance.now()
    if (zoneInfo.urgent) {
      dest = this.zoneDestination(o, threats)
      why = "zone"
      urgent = true
    }
    const recentThreat = threats.length > 0 && this.t - Math.max(...threats.map((q) => q.lastSeen)) < 4
    // nothing to shoot with for a while (gun reloading, laser not ready): duck out of sight
    const gunW = me.weapons.find((w: any) => w && w.kind === "gun")
    const lasW = me.weapons.find((w: any) => w && w.kind === "laser")
    const ltgW = me.weapons.find((w: any) => w && w.kind === "lightning")
    const laserReady = lasW && lasW.cooldown <= 0.3
    const ltgReady = ltgW && me.energy > 15 && target && hyp(target.x - x, target.y - y) < 40
    const gunReady = !!gunW && gunW.reload <= 0.5 && (gunW.ammo ?? 1) > 0
    let dry = !gunReady && !laserReady && !ltgReady
    // light pressure (one shooter, little damage): breaking line of sight to reload costs more uptime than it saves
    if (dry && this.P.dryHold && visible.length <= 1 && recentDmg < maxHp * 0.08 && hpFrac > 0.5) dry = false
    const nearFoes = this.P.laserSafe ? threats.filter((tr) => this.t - tr.lastSeen < 3) : visible
    if (!dest && this.P.laserHunt && !me.weapons.some((w: any) => w && w.kind === "laser") && hpFrac > this.P.laserHp && !nearFoes.some((tr) => hyp(tr.x - x, tr.y - y) < this.P.laserNear) && !(this.P.laserSafe && this.t - this.lastDamagedT < 2)) {
      const lp = this.laserGoal(o)
      if (lp) { dest = lp; why = "laser" }
    }
    this.crateGoal = null
    if (!dest && this.P.scoutT > 0 && this.t < this.P.scoutT && this.P.lootMem && !me.weapons.some((w: any) => w && w.kind === "laser") && !this.laserGoal(o) && visible.length === 0) {
      const sg = this.scoutGoal(o)
      if (sg) { dest = sg; why = "scout" }
    }
    if (!dest && this.P.laserCrates && this.P.laserHunt && !me.weapons.some((w: any) => w && w.kind === "laser") && hpFrac > 0.45 && !nearFoes.some((tr) => hyp(tr.x - x, tr.y - y) < this.P.laserNear) && !this.laserGoal(o)) {
      const cg = this.laserCrateGoal(o)
      if (cg) { dest = cg; why = "lcrate" }
    }
    if (!dest && this.P.dropsAgg && o.drops?.length) {
      const dg = this.dropGoal(o, visible, hpFrac)
      if (dg) { dest = dg; why = "drop" }
    }
    if (!dest && this.P.harvest && this.harvests.length) {
      const h = this.harvestGoal(o, visible, hpFrac)
      if (h) { dest = h; why = "harvest" }
    }
    if (!dest && (engaged || hostile.length || recentDmg > 0 || (this.recovering && recentThreat))) {
      // an aimed laser charge is a 315-damage hitscan shot about to land: only line of sight stops it
      const laserIn = this.P.laserDodge && visible.some((tr) => tr.charging && hyp(tr.x - x, tr.y - y) > 35 && Math.abs(wrap(tr.aimYaw - Math.atan2(y - tr.y, x - tr.x))) < 0.12)
      let evade = this.recovering || dry || laserIn || this.shouldEvade(o, visible, threats, hpFrac)
      // a nearly dead target is worth more than our HP: score is kills
      if (evade && !dry && this.P.finishHp > 0 && target && target.hp / Math.max(1, target.maxHp) < this.P.finishHp && hyp(target.x - x, target.y - y) < 150 && this.w.shotClear(x, y, z + 7, target.x, target.y, target.z + 4.5)) evade = false
      const mode = evade ? "evade" : "fight"
      const stale = this.t - this.destT > 0.6 || !this.dest || this.destWhy !== mode
      if (stale && (!this.dest || performance.now() < this.deadline - 3)) {
        const tq = performance.now()
        dest = this.tacticalSpot(o, threats, evade, target)
        this.mark("tactical", tq)
        this.destT = this.t
      } else dest = this.dest
      why = mode
    }
    if (!dest && this.P.relocate && this.relocTarget && this.t < this.relocUntil && visible.length === 0) {
      dest = this.relocTarget
      why = "relocate"
      if (hyp(dest[0] - x, dest[1] - y) < 4) this.relocUntil = 0
    }
    if (!dest && recentThreat) {
      // contact broken: relocate away from where they last saw us (if we were in a fight), else stay low
      const fought = this.t - this.lastDamagedT < 12 || this.t - this.lastDealtT < 12
      if (this.P.relocate && fought && visible.length === 0 && this.t - this.relocT > 4 && performance.now() < this.deadline - 3) {
        const r = this.relocateSpot(o, threats)
        this.relocT = this.t
        if (r) { this.relocTarget = r; this.relocUntil = this.t + 14; dest = r; why = "relocate" }
      }
      if (!dest) {
        const stale = this.t - this.destT > 1.0 || !this.dest || this.destWhy !== "alert"
        if (stale && (!this.dest || performance.now() < this.deadline - 3)) {
          dest = this.tacticalSpot(o, threats, true, null)
          this.destT = this.t
        } else dest = this.dest
        why = "alert"
      }
    }
    if (!dest && this.npcAggro && this.t - this.npcAggro.t < 2.5 && !this.aggroNpc(o)) {
      // shot by a drone we cannot see: back off out of its reach
      const b = this.npcAggro.b + Math.PI
      const c = this.nav.nearestMain(x + Math.cos(b) * 45, y + Math.sin(b) * 45, 25)
      if (c >= 0) { dest = [this.nav.cx(c), this.nav.cy(c)]; why = "npcflee" }
    }
    if (!dest && !this.recovering) {
      const loot = this.lootTarget(o, threats)
      if (loot) { dest = loot; why = "loot" }
    }
    if (!dest && !this.recovering && this.P.farm && performance.now() < this.deadline - 1) {
      const f = this.farmTarget(o, threats)
      if (f) { dest = f; why = "farm" }
    }
    if (!dest) {
      const th = performance.now()
      dest = this.holdSpot(o, threats)
      this.mark("hold", th)
      why = "hold"
    }
    // never aim for a spot outside the circle as it will be in a moment (the next circle can touch the
    // current one's edge, e.g. a final point on the rim): project the destination inside, with margin
    if (dest) dest = this.projectIntoZone(o, dest, 2)
    this.mark("dest", tS)
    tS = performance.now()
    this.dest = dest
    this.destWhy = why
    if (why !== this.mode) { this.mode = why; this.modeSince = this.t }

    // ---- movement along path
    let mv = [0, 0]
    if (dest) {
      const dd = hyp(dest[0] - x, dest[1] - y)
      if (dd > 1.5) mv = this.steer(o, dest)
    }
    // juke when visible enemies can shoot us
    if (engaged && why !== "zone" && why !== "drop") {
      if (this.t > this.jukeT) { this.jukeDir = this.rand() < 0.5 ? -1 : 1; this.jukeT = this.t + this.P.jukeMin + this.rand() * this.P.jukeVar }
      const ref = target ?? visible[0]
      const ang = Math.atan2(ref.y - y, ref.x - x) + (this.jukeDir * Math.PI) / 2
      const jx = Math.cos(ang), jy = Math.sin(ang)
      const ok = this.nav.clearanceAt(x + jx * 4, y + jy * 4) > 2.9
      if (ok) {
        const wgt = hyp(mv[0], mv[1]) > 0.1 ? this.P.jukeW : 1
        mv = [mv[0] * (1 - wgt) + jx * wgt, mv[1] * (1 - wgt) + jy * wgt]
      } else this.jukeDir *= -1
    }
    // dodge visible incoming projectiles
    const dodge = this.dodge(o)
    if (dodge) mv = [mv[0] * 0.4 + dodge[0], mv[1] * 0.4 + dodge[1]]
    const ml = hyp(mv[0], mv[1])
    if (ml > 1) mv = [mv[0] / ml, mv[1] / ml]
    a.move = mv

    // boost: zone emergencies and evasion
    const energy = me.energy
    if ((urgent && (!me.in_zone || zoneInfo.slack < 8) && energy > 10) || (why === "evade" && energy > 35 && ml > 0.5)) a.boost = true
    if (this.P.lootBoost && (why === "laser" || why === "harvest") && dest && hyp(dest[0] - x, dest[1] - y) > 25 && energy > 45 && ml > 0.5) a.boost = true

    // stuck handling
    this.handleStuck(o, a, ml)

    this.mark("move", tS)
    tS = performance.now()
    // ---- aim & fire
    this.aimAndFire(o, a, target, visible, threats, why)
    if (this.P.pacifist) a.fire = [false, false]
    this.mark("aim", tS)

    this.lastObs = o
    this.lastPos = [x, y, z]
    if (this.debugOn && this.tick % 20 === 0) this.dbg.push(`t=${o.t} mode=${why} hp=${me.hp.toFixed(0)} vis=${visible.length} thr=${threats.length} pos=${x.toFixed(0)},${y.toFixed(0)} zone c=${zn.center.map((v: number) => v.toFixed(0))} r=${zn.radius.toFixed(0)} next=${zn.next_center.map((v: number) => v.toFixed(0))} nr=${zn.next_radius} s0=${zn.shrink_start} s1=${zn.shrink_end} dest=${dest ? dest.map((v) => v.toFixed(0)) : "-"} in=${me.in_zone}`)
    return a
  }

  // ------------------------------------------------------------------ tracking
  updateTracks(o: any) {
    for (const tr of this.tracks.values()) tr.visible = false
    for (const m of o.mechs ?? []) {
      if (!m || !Array.isArray(m.pos) || m.pos.length < 3) continue
      if (!Array.isArray(m.vel)) m.vel = [0, 0, 0]
      if (!Array.isArray(m.aim)) m.aim = [0, 0]
      if (m.kind === "npc") { this.npcs.set(m.id, { ...m, t: o.t }); continue }
      let tr = this.tracks.get(m.id)
      if (!tr) {
        tr = { id: m.id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, hp: 1400, maxHp: 1400, weapons: [], charging: false, aimYaw: 0, aimPitch: 0, lastSeen: o.t, firstSeen: o.t, visible: false, cubes: 0, seenStreak: 0, lastShotAtUs: -99 }
        this.tracks.set(m.id, tr)
      }
      if (o.t - tr.lastSeen > 1) { tr.firstSeen = o.t; tr.seenStreak = 0 }
      tr.x = m.pos[0]; tr.y = m.pos[1]; tr.z = m.pos[2]
      tr.vx = m.vel[0]; tr.vy = m.vel[1]; tr.vz = m.vel[2]
      if (this.P.leadAdapt || this.P.leadMC) {
        // a reversal: horizontal velocity now points against the velocity ~0.3 s ago (both moving)
        const r = tr.rev ?? (tr.rev = { t: o.t, vx: tr.vx, vy: tr.vy, flips: [] })
        if (o.t - r.t >= 0.3) {
          const sp0 = hyp(r.vx, r.vy), sp1 = hyp(tr.vx, tr.vy)
          if (sp0 > 3 && sp1 > 3 && (r.vx * tr.vx + r.vy * tr.vy) / (sp0 * sp1) < -0.3) {
            const prev = r.flips.length ? r.flips[r.flips.length - 1] : -99
            r.flips.push(o.t)
            const iv = o.t - prev
            if (iv > 0.25 && iv < 4) { this.flipIntervals.push(iv); if (this.flipIntervals.length > 80) this.flipIntervals.shift() }
          }
          r.t = o.t; r.vx = tr.vx; r.vy = tr.vy
          while (r.flips.length && o.t - r.flips[0] > 8) r.flips.shift()
        }
      }
      if (typeof m.hp === "number") tr.hp = m.hp
      if (typeof m.max_hp === "number") tr.maxHp = m.max_hp
      tr.weapons = m.weapons ?? tr.weapons
      tr.charging = !!m.charging
      tr.aimYaw = m.aim?.[0] ?? 0
      tr.aimPitch = m.aim?.[1] ?? 0
      tr.cubes = m.cubes ?? 0
      tr.lastSeen = o.t
      tr.visible = true
      tr.seenStreak++
      let hh = this.hpHist.get(m.id)
      if (!hh) { hh = []; this.hpHist.set(m.id, hh) }
      hh.push({ t: o.t, hp: tr.hp })
      while (hh.length && o.t - hh[0].t > 4) hh.shift()
    }
    for (const [id, n] of this.npcs) if (o.t - n.t > 10) this.npcs.delete(id)
    if (this.P.lootMem) {
      const seenP = new Set<number>()
      for (const p of o.pickups ?? []) { if (p && Array.isArray(p.pos)) { seenP.add(p.id); this.pickMem.set(p.id, { id: p.id, kind: p.kind, pos: p.pos, t: o.t }) } }
      const [px, py, pz] = o.self.pos
      const pez = pz + (o.self.stats?.eye_height ?? 8)
      for (const [id, p] of this.pickMem) {
        if (seenP.has(id)) continue
        if (o.t - p.t > 90) { this.pickMem.delete(id); continue }
        const d = hyp(p.pos[0] - px, p.pos[1] - py)
        if (d < 35 && this.w.sees(px, py, pez, p.pos[0], p.pos[1], p.pos[2] + 0.5, false)) this.pickMem.delete(id)
      }
      for (const e of o.events ?? []) if (e.type === "took" || e.type === "take_failed") this.pickMem.delete(e.id)
    }
    // crate memory: crates are listed only while seen; forget one we should see from close by but do not
    const listed = new Set<number>()
    for (const c of o.crates ?? []) {
      if (!c || !Array.isArray(c.pos)) continue
      listed.add(c.id)
      const old = this.crates.get(c.id)
      this.crates.set(c.id, { x: c.pos[0], y: c.pos[1], z: c.pos[2], hp: c.hp ?? 300, t: o.t, since: old?.since ?? o.t })
    }
    if (this.crates.size) {
      const [x, y, z] = o.self.pos
      const ez = z + (o.self.stats?.eye_height ?? 8)
      for (const [id, c] of this.crates) {
        if (listed.has(id)) continue
        const d = hyp(c.x - x, c.y - y)
        if (d < 35 && this.w.sees(x, y, ez, c.x, c.y, c.z + 1.2, false)) this.crates.delete(id)
      }
    }
  }

  processEvents(o: any) {
    for (const e of o.events ?? []) {
      if (e.type === "damaged") {
        if (this.debugOn) { const tr = typeof e.by === "number" ? this.tracks.get(e.by) : null; this.dbg.push(`  DMG ${e.amount} ${e.weapon} by ${e.by} ${e.rear ? "REAR" : ""} d=${tr ? hyp(tr.x - o.self.pos[0], tr.y - o.self.pos[1]).toFixed(0) : "?"} vis=${tr ? tr.visible : "?"}`) }
        if (e.weapon === "npc" || (typeof e.by === "number" && e.by >= 100)) {
          this.lastDamagedT = o.t
          this.npcAggro = { t: o.t, b: typeof e.bearing === "number" ? e.bearing : 0, id: typeof e.by === "number" ? e.by : -1 }
        } else if (e.weapon !== "zone") {
          this.lastDamagedT = o.t
          this.dmgWindow.push({ t: o.t, a: e.amount })
          if (typeof e.bearing === "number") this.threatBearings.push({ t: o.t, b: e.bearing, by: e.by })
          if (typeof e.by === "number" && e.by < 100) {
            const tr = this.tracks.get(e.by)
            if (tr) tr.lastShotAtUs = o.t
          }
        }
      } else if (e.type === "hit") {
        this.lastDealtT = o.t
        if (typeof e.target === "number") this.ourHits.set(e.target, o.t)
      } else if (e.type === "kill") {
        if (this.debugOn) this.dbg.push(`  KILL ${e.target}`)
        const v = this.tracks.get(e.target)
        if (v) this.harvests.push({ x: v.x, y: v.y, z: v.z, t: o.t })
        this.tracks.delete(e.target)
      }
    }
    for (const s of o.sounds ?? []) {
      if (s.kind === "step" || s.kind === "drop" || s.kind === "crate" || s.kind === "npc_gun") continue
      const dd = s.dist === "near" ? 40 : s.dist === "mid" ? 110 : 220
      this.sounds.push({ t: o.t, b: s.bearing, kind: s.kind, dist: s.dist, x: o.self.pos[0] + Math.cos(s.bearing) * dd, y: o.self.pos[1] + Math.sin(s.bearing) * dd })
    }
    // free-for-all evidence: other mechs hurting each other
    if (this.ffaEvidence < 3) {
      for (const b of o.beams ?? []) {
        if (b.by === o.self.id || !Array.isArray(b.path) || b.path.length < 2) continue
        const end = b.path[b.path.length - 1]
        for (const tr of this.tracks.values()) {
          if (tr.id === b.by || !tr.visible) continue
          if (hyp(tr.x - end[0], tr.y - end[1]) < 4 && Math.abs(tr.z + 4.5 - end[2]) < 7) { this.ffaEvidence++; break }
        }
      }
      for (const [id, hh] of this.hpHist) {
        if (hh.length < 2) continue
        const last = hh[hh.length - 1]
        if (o.t - last.t > 0.2) continue
        let first = hh[0]
        for (const q of hh) if (last.t - q.t <= 3) { first = q; break }
        const ourHit = this.ourHits.get(id)
        if (first.hp - last.hp >= 150 && (ourHit === undefined || o.t - ourHit > 4) && o.zone && o.self.in_zone) {
          this.ffaEvidence++
          hh.length = 0
        }
      }
    }
    if (this.ffaEvidence >= 3 && this.ffaDetectedAt < 0) this.ffaDetectedAt = o.t
    const cut = o.t - 12
    while (this.dmgWindow.length && this.dmgWindow[0].t < cut) this.dmgWindow.shift()
    while (this.threatBearings.length && this.threatBearings[0].t < cut) this.threatBearings.shift()
    while (this.sounds.length && this.sounds[0].t < cut) this.sounds.shift()
    if (this.sounds.length > 40) this.sounds.splice(0, this.sounds.length - 40)
  }

  recentDamage(sec: number): number {
    let s = 0
    for (const d of this.dmgWindow) if (this.t - d.t <= sec) s += d.a
    return s
  }

  activeThreats(o: any): Track[] {
    const out: Track[] = []
    for (const tr of this.tracks.values()) {
      const age = o.t - tr.lastSeen
      if (age > 12) continue
      out.push(tr)
    }
    // phantom threats: recent damage from attackers we cannot see
    const [x, y, z] = o.self.pos
    const seenIds = new Set(out.filter((tr) => tr.visible).map((tr) => tr.id))
    const used = new Set<number>()
    for (let i = this.threatBearings.length - 1; i >= 0; i--) {
      const b = this.threatBearings[i]
      if (o.t - b.t > 4) break
      const key = b.by ?? -1 - i
      if (used.has(key) || (b.by !== null && seenIds.has(b.by))) continue
      used.add(key)
      const d = 90
      out.push({ id: 1000 + (b.by ?? 99), x: x + Math.cos(b.b) * d, y: y + Math.sin(b.b) * d, z, vx: 0, vy: 0, vz: 0, hp: 1400, maxHp: 1400, weapons: [], charging: false, aimYaw: b.b + Math.PI, aimPitch: 0, lastSeen: b.t, firstSeen: b.t, visible: false, cubes: 0, seenStreak: 0, lastShotAtUs: b.t, phantom: true } as any)
    }
    return out
  }

  // predicted position of a track now (extrapolate briefly after losing sight)
  predPos(tr: Track): number[] {
    const age = Math.min(1.0, this.t - tr.lastSeen)
    return [tr.x + tr.vx * age, tr.y + tr.vy * age, tr.z]
  }

  // ------------------------------------------------------------------ zone
  projectIntoZone(o: any, p: number[], tau: number): number[] {
    const c = this.zoneAt(o, this.t + tau)
    const m = Math.min(6, c.r * 0.25)
    const dx = p[0] - c.cx, dy = p[1] - c.cy
    const d = hyp(dx, dy)
    const lim = Math.max(0, c.r - m)
    if (d <= lim) return p
    if (d < 1e-6) return [c.cx, c.cy]
    return [c.cx + (dx * lim) / d, c.cy + (dy * lim) / d]
  }

  zoneUrgency(o: any, x: number, y: number, walk: number): { urgent: boolean; slack: number } {
    const zn = o.zone
    // slack = seconds of margin before the zone edge passes us, assuming we walk out now
    const now = this.zoneAt(o, this.t)
    const dNow = now.r - hyp(x - now.cx, y - now.cy)
    if (dNow < 2) return { urgent: true, slack: dNow / walk }
    // will we be inside the next circle by shrink_end?
    const dNext = zn.next_radius - hyp(x - zn.next_center[0], y - zn.next_center[1])
    if (dNext >= 0) return { urgent: false, slack: 99 }
    // time needed to reach the next circle (path factor 1.4)
    const need = (-dNext * 1.4 + 15) / walk
    // time until the edge reaches us: find earliest T where we are outside
    let tOut = Infinity
    for (let T = this.t; T <= zn.shrink_end + 0.01; T += 1) {
      const c = this.zoneAt(o, T)
      if (hyp(x - c.cx, y - c.cy) > c.r - 3) { tOut = T; break }
    }
    const slack = tOut - this.t - need
    const early = this.t > zn.shrink_start - 25 - need // head in before shrinking starts
    return { urgent: slack < 10 || early, slack }
  }

  zoneDestination(o: any, threats: Track[]): number[] {
    const me = o.self
    const [x, y] = me.pos
    const zn = o.zone
    // target a point inside the next circle on our side, pulled inward by margin
    const ncx = zn.next_center[0], ncy = zn.next_center[1], nr = zn.next_radius
    const margin = Math.min(nr * 0.35, 40)
    const ang = Math.atan2(y - ncy, x - ncx)
    const key = `z${Math.round(ncx)}:${Math.round(ncy)}:${nr}`
    if (this.hold && this.holdKey === key) return this.hold
    let gx = ncx + Math.cos(ang) * Math.max(0, nr - margin)
    let gy = ncy + Math.sin(ang) * Math.max(0, nr - margin)
    let c = this.nav.nearestMain(gx, gy, 60)
    if (c < 0 || hyp(this.nav.cx(c) - ncx, this.nav.cy(c) - ncy) > nr - 2) {
      const cc = this.nav.nearestMain(ncx, ncy, Math.max(4, nr))
      c = cc >= 0 ? cc : this.nav.nearestWalkable(ncx, ncy, Math.max(4, nr))
    }
    if (c >= 0) { gx = this.nav.cx(c); gy = this.nav.cy(c) }
    return [gx, gy]
  }

  // a defensible spot inside the next circle, near its edge on our side, with cover
  holdSpot(o: any, threats: Track[]): number[] {
    const me = o.self
    const [x, y] = me.pos
    const zn = o.zone
    const ncx = zn.next_center[0], ncy = zn.next_center[1], nr = zn.next_radius
    const key = `h${Math.round(ncx)}:${Math.round(ncy)}:${nr}`
    if (this.hold && this.holdKey === key) {
      // keep unless a threat sits near it
      const near = threats.some((tr) => hyp(tr.x - this.hold![0], tr.y - this.hold![1]) < 50 && this.t - tr.lastSeen < 8)
      if (!near) return this.hold
    }
    // candidates on rings inside the next circle, biased toward our side
    const ang0 = Math.atan2(y - ncy, x - ncx)
    let best: number[] | null = null, bs = -Infinity
    const dToCenter = hyp(x - ncx, y - ncy)
    const ringFr = nr > 150 ? [0.55, 0.7, 0.82] : nr > 60 ? [0.35, 0.55, 0.7] : [0.0, 0.25, 0.45]
    for (const fr of ringFr) {
      for (let k = -4; k <= 4; k++) {
        const ang = ang0 + k * (nr > 150 ? 0.18 : 0.35)
        const px = ncx + Math.cos(ang) * nr * fr, py = ncy + Math.sin(ang) * nr * fr
        const c = this.nav.nearestMain(px, py, 12)
        if (c < 0) continue
        const cx = this.nav.cx(c), cy = this.nav.cy(c)
        if (hyp(cx - ncx, cy - ncy) > nr - 3) continue
        const cover = this.coverScore(c)
        const travel = hyp(cx - x, cy - y)
        let s = cover * 3 - travel / 40
        // stay away from known threats
        for (const tr of threats) { const d = hyp(tr.x - cx, tr.y - cy); if (d < 120) s -= (120 - d) / 20 }
        // prefer not moving deeper than needed
        if (dToCenter < nr) s -= Math.max(0, travel - 30) / 30
        if (s > bs) { bs = s; best = [cx, cy] }
      }
    }
    if (!best) {
      // nothing in the main component inside the circle: go for its center (may need jets)
      const c = this.nav.nearestWalkable(ncx, ncy, Math.max(6, nr))
      best = c >= 0 ? [this.nav.cx(c), this.nav.cy(c)] : [ncx, ncy]
    }
    this.hold = best
    this.holdKey = key
    return best
  }

  // static cover: share of directions with a wall within 20 m, minus exposure to long sight lines
  coverScore(c: number): number {
    if (!this.cover.done[c] && this.overBudget()) return 0.3
    return this.cover.nearOf(c) * 0.7 + (1 - this.cover.openOf(c)) * 0.6
  }

  // ------------------------------------------------------------------ tactics
  shouldEvade(o: any, visible: Track[], threats: Track[], hpFrac: number): boolean {
    const me = o.self
    const [x, y] = me.pos
    const close = visible.filter((tr) => hyp(tr.x - x, tr.y - y) < 170)
    const dmg3 = this.recentDamage(3)
    if (hpFrac < 0.35) return true
    if (close.length >= 3) return true
    if (close.length >= 2 && hpFrac < 0.6) return true
    if (dmg3 > me.max_hp * 0.3) return true
    // losing a duel: we are much lower than the target
    if (close.length === 1) {
      const e = close[0]
      if (hpFrac < 0.5 && e.hp / e.maxHp > hpFrac + 0.3) return true
    }
    return false
  }

  tacticalSpot(o: any, threats: Track[], evade: boolean, target: Track | null): number[] {
    const me = o.self
    const [x, y, z] = me.pos
    const eyeH = me.stats?.eye_height ?? 8
    const df = this.dfield!
    const tq0 = performance.now()
    if (this.dfieldT < 0 || ((this.t - this.dfieldT > 0.5 || hyp(x - this.dfieldPos[0], y - this.dfieldPos[1]) > 4) && performance.now() < this.deadline - 3)) {
      const td = performance.now()
      this.nav.distanceField(x, y, df, this.slow > 2 ? 40 : 60)
      this.mark("dfield", td)
      this.dfieldT = this.t
      this.dfieldPos = [x, y]
    }
    // threats ranked by distance; consider at most 5
    const ths = threats
      .map((tr) => ({ tr, p: this.predPos(tr), d: hyp(tr.x - x, tr.y - y) }))
      .filter((q) => q.d < 260)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4)
    const zfut = this.zoneAt(o, this.t + 8)
    // kiting: centroid of the recent threats other than the target
    let kx = 0, ky = 0, kn = 0
    if (this.P.kite > 0 && !evade) {
      for (const q of ths) { if (target && q.tr.id === target.id) continue; if (this.t - q.tr.lastSeen > 6) continue; kx += q.p[0]; ky += q.p[1]; kn++ }
      if (kn) { kx /= kn; ky /= kn }
    }
    const kd0 = kn ? hyp(x - kx, y - ky) : 0
    const cands: Cand[] = []
    const vslow = this.slow > 4
    const rings = vslow ? (evade ? [0, 10, 22, 36] : [0, 8, 16]) : evade ? [0, 8, 16, 26, 38, 52] : [0, 6, 12, 20, 30]
    for (const r of rings) {
      const n = r === 0 ? 1 : vslow ? 8 : r < 10 ? 8 : 10
      for (let k = 0; k < n; k++) {
        const ang = (k * TAU) / n + (r % 2) * 0.2
        const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r
        const c = r === 0 ? this.nav.nearestWalkable(px, py, 6) : this.nav.cellAt(px, py)
        if (c < 0 || !this.nav.walk[c]) continue
        const dist = df[c]
        if (!Number.isFinite(dist) || dist > r * 1.6 + 8) continue
        cands.push({ x: this.nav.cx(c), y: this.nav.cy(c), z: this.nav.z[c], c, score: 0, dist, exp: 0 })
      }
    }
    if (!cands.length) return [x, y]
    this.mark("cands", tq0)
    const bearBuf = new Float64Array(8)
    let best = cands[0], bs = -Infinity
    const tEnd = Math.min(this.deadline, performance.now() + 3.5)
    for (const cd of cands) {
      if (performance.now() > tEnd) break
      let exp = 0, canHit = 0
      let nb = 0
      for (const q of ths) {
        const tr = q.tr
        const dq = hyp(q.p[0] - cd.x, q.p[1] - cd.y)
        const vis = this.w.sees(q.p[0], q.p[1], q.p[2] + 8, cd.x, cd.y, cd.z + 8.5, dq > 45)
        if (vis) {
          const d = hyp(q.p[0] - cd.x, q.p[1] - cd.y)
          const w = (this.t - tr.lastSeen < 3 ? 1 : 0.5) * (d < 60 ? 1.4 : d < 150 ? 1 : 0.6)
          exp += w
          bearBuf[nb++] = Math.atan2(q.p[1] - cd.y, q.p[0] - cd.x)
          if (target && tr.id === target.id) canHit = 1
        }
      }
      cd.exp = exp
      // threats seeing us from opposite sides means rear hits (x1.5): penalize wide arcs
      let arcPen = 0
      if (nb >= 2) {
        const bs2 = Array.from(bearBuf.subarray(0, nb)).sort((a, b) => a - b)
        let gap = bs2[0] + TAU - bs2[nb - 1]
        for (let i = 1; i < nb; i++) gap = Math.max(gap, bs2[i] - bs2[i - 1])
        const arc = TAU - gap
        if (arc > Math.PI * 0.9) arcPen = (arc - Math.PI * 0.9) * 2
      }
      // zone: stay well inside the circle as it will be shortly (dominant term)
      const zd = zfut.r - hyp(cd.x - zfut.cx, cd.y - zfut.cy)
      const zMargin = Math.min(12, zfut.r * 0.3)
      let s = 0
      if (zd < zMargin) s -= (zMargin - zd) * 1.5 + (zd < 0 ? 15 - zd * 2 : 0)
      s -= cd.dist * 0.04
      if (evade) {
        s -= exp * 6
        // prefer distance from nearest threat
        if (ths.length) s += Math.min(80, hyp(cd.x - ths[0].p[0], cd.y - ths[0].p[1])) * 0.03
      } else {
        // fight: want to see the target but be exposed to as few others as possible
        s -= Math.max(0, exp - canHit) * this.P.expW
        s += canHit * 3
        if (target) {
          const d = hyp(cd.x - target.x, cd.y - target.y)
          const pref = this.preferredRange(o)
          s -= Math.abs(d - pref) * this.P.rangeW
        }
        if (kn) s += this.P.kite * Math.max(-15, Math.min(25, hyp(cd.x - kx, cd.y - ky) - kd0)) / 10
      }
      s += this.coverScore(cd.c) * 1.5 - (this.P.rearAware ? arcPen : 0)
      if (this.P.cubeGrab && o.cubes?.length) for (const cu of o.cubes) if (hyp(cu.pos[0] - cd.x, cu.pos[1] - cd.y) < 3.2 && Math.abs(cu.pos[2] - cd.z) < 3) s += 1.5
      cd.score = s
      ;(cd as any).ev = 1
      if (s > bs) { bs = s; best = cd }
    }
    if (this.P.peek && !evade && target) {
      // a firing spot next to full cover: reloads and laser charges can break line of sight with a short step
      bs = -Infinity
      for (const cd of cands) {
        if (!(cd as any).ev) continue
        let s = cd.score
        if (cd.exp > 0) for (const q of cands) if ((q as any).ev && q.exp === 0 && hyp(q.x - cd.x, q.y - cd.y) < 9) { s += this.P.peek; break }
        if (s > bs) { bs = s; best = cd }
      }
    }
    return [best.x, best.y]
  }

  // a covered spot 50-110 m away from the recent threats, inside the zone a bit later
  relocateSpot(o: any, threats: Track[]): number[] | null {
    const [x, y, z] = o.self.pos
    let cx = 0, cy = 0, wsum = 0
    const recent = threats.filter((tr) => this.t - tr.lastSeen < 12)
    for (const tr of recent) { const w = 1 / (1 + this.t - tr.lastSeen); cx += tr.x * w; cy += tr.y * w; wsum += w }
    if (wsum <= 0) return null
    cx /= wsum; cy /= wsum
    const away = Math.atan2(y - cy, x - cx)
    const zf = this.zoneAt(o, this.t + 20)
    const ths = recent.sort((a, b) => hyp(a.x - x, a.y - y) - hyp(b.x - x, b.y - y)).slice(0, 4)
    let best: number[] | null = null, bs = -Infinity
    const tEnd = Math.min(this.deadline, performance.now() + 3)
    for (const dist of [55, 85, 115]) {
      for (const da of [0, -0.5, 0.5, -1.0, 1.0]) {
        if (performance.now() > tEnd) break
        const a = away + da
        const c = this.nav.nearestMain(x + Math.cos(a) * dist, y + Math.sin(a) * dist, 14)
        if (c < 0) continue
        const px = this.nav.cx(c), py = this.nav.cy(c), pz = this.nav.z[c]
        const zd = zf.r - hyp(px - zf.cx, py - zf.cy)
        if (zd < Math.min(15, zf.r * 0.25)) continue
        let s = this.coverScore(c) * 3 - Math.abs(da) * 0.8
        let minD = Infinity
        for (const tr of ths) {
          const d = hyp(tr.x - px, tr.y - py)
          minD = Math.min(minD, d)
          if (d < 200 && this.w.sees(tr.x, tr.y, tr.z + 8, px, py, pz + 8.5, d > 45)) s -= 3
        }
        s += Math.min(150, minD) * 0.02
        if (s > bs) { bs = s; best = [px, py] }
      }
    }
    return best
  }

  preferredRange(o: any): number {
    const ws = o.self.weapons.filter((w: any) => w).map((w: any) => w.kind)
    if (ws.includes("lightning")) return this.P.prefLtg
    if (ws.includes("laser")) return this.P.prefLaser
    return this.P.prefGun
  }

  // is this enemy engaging us (or about to)?
  isThreatening(o: any, tr: Track): boolean {
    const [x, y] = o.self.pos
    const d = hyp(tr.x - x, tr.y - y)
    if (this.t - tr.lastShotAtUs < (this.P.attackersOnly ? 10 : 6)) return true
    if (d < 50) return true
    if (this.P.attackersOnly || (this.P.regenHold > 0 && o.self.hp / (o.self.max_hp || 1400) < this.P.regenHold)) {
      const b = Math.atan2(y - tr.y, x - tr.x)
      return tr.charging && Math.abs(wrap(tr.aimYaw - b)) < 0.2 && d < 290
    }
    const bearingToUs = Math.atan2(y - tr.y, x - tr.x)
    const aimed = Math.abs(wrap(tr.aimYaw - bearingToUs)) < 0.2
    if (tr.charging && aimed && d < 290) return true
    if (aimed && d < 200 && tr.seenStreak >= 3) return true
    return false
  }

  // worth starting a fight with?
  isOpportunity(o: any, tr: Track, nVisible: number, hpFrac: number): boolean {
    const [x, y, z] = o.self.pos
    const d = hyp(tr.x - x, tr.y - y)
    const frac = tr.hp / Math.max(1, tr.maxHp)
    if (this.P.attackersOnly) return frac < 0.35 && d < 150
    if (this.P.regenHold > 0 && hpFrac < this.P.regenHold) return frac < 0.35 && d < 150
    if (this.P.laserEngageR > 0 && d < this.P.laserEngageR && hpFrac > 0.4 && o.self.weapons.some((w: any) => w && w.kind === "laser") && this.w.shotClear(x, y, z + 7, tr.x, tr.y, tr.z + 4.5)) return true
    // being damaged by someone else (third party)?
    const hist = this.hpHist.get(tr.id)
    const dropping = !!hist && hist.length > 1 && hist[0].hp - tr.hp > 100 && this.t - this.lastDealtT > 2
    if (frac < 0.35 && d < 150) return true
    if (dropping && d < 160 && hpFrac > 0.4) return true
    if (nVisible === 1 && d < this.P.lonelyDuelRange && hpFrac > 0.6) return true
    const engR = this.ffaEvidence >= 3 ? Math.min(this.P.engageRange, this.P.ffaEngageRange) : this.P.engageRange
    if (nVisible <= 2 && d < engR && hpFrac > 0.45 && this.w.shotClear(x, y, z + 7, tr.x, tr.y, tr.z + 4.5)) return true
    return false
  }

  chooseTarget(o: any, visible: Track[]): Track | null {
    const [x, y, z] = o.self.pos
    // directions of everyone actively shooting at us (visible or not): keep them in the front arc
    const shooters: number[] = []
    for (const tr of this.tracks.values()) if (this.t - tr.lastShotAtUs < 2.5 && this.t - tr.lastSeen < 6) shooters.push(Math.atan2(tr.y - y, tr.x - x))
    const seenBy = new Set<number>()
    for (let i = this.threatBearings.length - 1; i >= 0; i--) {
      const b = this.threatBearings[i]
      if (this.t - b.t >= 2) break
      if (b.by !== null && this.tracks.has(b.by)) continue
      const key = b.by ?? -1
      if (seenBy.has(key)) continue // one entry per attacker, not per hit
      seenBy.add(key)
      shooters.push(b.b)
    }
    let best: Track | null = null, bs = -Infinity
    const me = o.self
    const gunW = me.weapons.find((w: any) => w && w.kind === "gun")
    const hasLaser = me.weapons.some((w: any) => w && w.kind === "laser")
    const hasLtg = me.weapons.some((w: any) => w && w.kind === "lightning")
    for (const tr of visible) {
      const d = hyp(tr.x - x, tr.y - y)
      if (d > 260) continue
      let s = -d / 40 - (tr.hp / Math.max(1, tr.maxHp)) * 4
      if (this.P.targetHit) {
        // gun hit chance by range (shooting gallery: strafer vs straight runner), blended by this target's reversal rate
        const pS = d <= 50 ? 1 : d <= 75 ? 1 - 0.12 * (d - 50) / 25 : d <= 100 ? 0.88 - 0.22 * (d - 75) / 25 : d <= 125 ? 0.66 - 0.16 * (d - 100) / 25 : d <= 150 ? 0.5 - 0.07 * (d - 125) / 25 : Math.max(0.2, 0.43 - 0.1 * (d - 150) / 25)
        const pT = d <= 75 ? 0.97 : d <= 125 ? 0.97 - 0.11 * (d - 75) / 50 : Math.max(0.5, 0.86 - 0.14 * (d - 125) / 50)
        const flips = tr.rev ? tr.rev.flips.length : 0
        const span = Math.max(2, Math.min(8, this.t - tr.firstSeen))
        const strafe = Math.min(1, (flips / span) / 0.8)
        const pg = d > (this.P.maxGunRange ?? 160) ? 0 : pS * strafe + pT * (1 - strafe)
        const gs = gunW?.stats ?? this.wcfg("gun")
        const gunDps = gunW ? ((gs.damage ?? 45) * (gs.mag ?? 12)) / ((gs.mag ?? 12) * (gs.cooldown ?? 0.24) + (gs.reload ?? 2.4)) : 0
        const dps = gunDps * pg + (hasLaser && d < 275 ? 118 : 0) + (hasLtg && d < 42 ? 200 : 0) + 1
        const ttk = Math.max(0, tr.hp) / dps
        s = -ttk / 2.5
      }
      if (this.t - tr.lastShotAtUs < 2) s += 2.5
      if (tr.charging) s += 1
      const yaw = Math.atan2(tr.y - y, tr.x - x)
      let rear = 0
      for (const b of shooters) if (Math.abs(wrap(b - yaw)) > Math.PI / 2 - 0.1) rear++
      if (this.P.rearAware) s -= rear * 3
      // shootable?
      if (!this.w.shotClear(x, y, z + 7, tr.x, tr.y, tr.z + 4.5)) s -= 6
      if (this.P.focus && tr.id === this.lastTargetId && this.t - this.lastTargetT < 1.5) s += this.P.focus
      if (s > bs) { bs = s; best = tr }
    }
    return best
  }

  // the most open reachable spot near spawn (long sight lines reveal pickups behind nearby buildings);
  // chosen once, then a full sweep on arrival
  scoutGoal(o: any): number[] | null {
    const [x, y] = o.self.pos
    if (!this.scoutSpot) {
      let best: number[] | null = null, bs = -Infinity
      const me0 = this.nav.cellAt(x, y)
      const open0 = me0 >= 0 && this.nav.walk[me0] ? this.cover.openOf(me0) : 0
      for (const r of [20, 35, 50, 65]) for (let k = 0; k < 12; k++) {
        const a = (k * TAU) / 12
        const c = this.nav.nearestMain(x + Math.cos(a) * r, y + Math.sin(a) * r, 6)
        if (c < 0) continue
        const sc = this.cover.openOf(c) - r / 400
        if (sc > bs) { bs = sc; best = [this.nav.cx(c), this.nav.cy(c), this.cover.openOf(c)] }
      }
      // not worth walking unless clearly more open than here
      this.scoutSpot = best && best[2] > open0 + 0.08 ? best : [x, y, open0]
    }
    const sp = this.scoutSpot
    if (hyp(sp[0] - x, sp[1] - y) > 3) return [sp[0], sp[1]]
    if (this.scoutSweepT < 0) this.scoutSweepT = this.t
    return this.t - this.scoutSweepT < 2.2 ? [x, y] : null
  }

  // nearest remembered ground crate; when close with a clear shot, stand and shoot it (aimAndFire uses crateGoal)
  laserCrateGoal(o: any): number[] | null {
    const [x, y, z] = o.self.pos
    const zf = this.zoneAt(o, this.t + 15)
    let best: any = null, bd = 150, bid = -1
    for (const [id, c] of this.crates) {
      if (this.farmBan.has(id)) continue
      if (Math.abs(c.z - this.nav.surfAt(c.x, c.y)) > 2.5) continue
      if (hyp(c.x - zf.cx, c.y - zf.cy) > zf.r - 12) continue
      const d = hyp(c.x - x, c.y - y)
      if (d < bd) { bd = d; best = c; bid = id }
    }
    if (!best) return null
    if (bid !== this.farmId) { this.farmId = bid; this.farmSince = this.t }
    else if (this.t - this.farmSince > 25) { this.farmBan.add(bid); this.farmId = -1; return null }
    const muz = z + (o.self.stats?.muzzle_height ?? 7)
    if (bd < 28 && this.w.shotClear(x, y, muz, best.x, best.y, best.z + 1.2)) { this.crateGoal = best; return [x, y] }
    return [best.x, best.y]
  }

  // a supply drop worth taking now: landed (or landing by the time we arrive), inside the zone, not held by
  // another mech, and not contested by 2+ visible enemies near us; stand at its centre to capture it
  dropGoal(o: any, visible: Track[], hpFrac: number): number[] | null {
    const me = o.self
    const [x, y] = me.pos
    if (hpFrac > 0.97 && (me.cubes ?? 0) >= 10) return null
    if (visible.filter((tr) => hyp(tr.x - x, tr.y - y) < 60).length >= 2) return null
    const zf = this.zoneAt(o, this.t + 10)
    let best: number[] | null = null, bd = this.P.dropR
    for (const d of o.drops ?? []) {
      if (d.holder !== null && d.holder !== undefined && d.holder !== me.id) continue
      const dd = hyp(d.pos[0] - x, d.pos[1] - y)
      if (dd > bd || d.lands_in > dd / 13 + 3) continue
      if (hyp(d.pos[0] - zf.cx, d.pos[1] - zf.cy) > zf.r - 6) continue
      const c = this.nav.nearestMain(d.pos[0], d.pos[1], 6)
      if (c < 0 || hyp(this.nav.cx(c) - d.pos[0], this.nav.cy(c) - d.pos[1]) > (d.radius ?? 8) - 2) continue
      bd = dd
      best = [this.nav.cx(c), this.nav.cy(c)]
    }
    return best
  }

  // nearest remembered laser on the ground (not on a roof) that stays inside the zone
  laserGoal(o: any): number[] | null {
    const [x, y, z] = o.self.pos
    const zf = this.zoneAt(o, this.t + 15)
    let best: number[] | null = null, bd = this.P.laserR
    for (const p of this.pickMem.values()) {
      if (p.kind !== "laser") continue
      const roof = Math.abs(p.pos[2] - this.nav.surfAt(p.pos[0], p.pos[1])) > 2.5
      if (roof && !(this.P.laserRoof > 0 && p.pos[2] - z < this.P.laserRoof && (o.self.energy ?? 0) > 60)) continue
      if (hyp(p.pos[0] - zf.cx, p.pos[1] - zf.cy) > zf.r - 10) continue
      const d = hyp(p.pos[0] - x, p.pos[1] - y)
      if (d < bd) { bd = d; best = [p.pos[0], p.pos[1]] }
    }
    return best
  }

  // the spot where a victim died: its cubes (and weapons) lie within ~3 m of it
  harvestGoal(o: any, visible: Track[], hpFrac: number): number[] | null {
    const [x, y] = o.self.pos
    this.harvests = this.harvests.filter((h) => this.t - h.t < this.P.harvestS)
    if (!this.harvests.length) return null
    const zf = this.zoneAt(o, this.t + 6)
    let best: number[] | null = null, bd = Infinity
    for (let i = this.harvests.length - 1; i >= 0; i--) {
      const h = this.harvests[i]
      const dh = hyp(h.x - x, h.y - y)
      const near = (o.cubes ?? []).filter((c: any) => hyp(c.pos[0] - h.x, c.pos[1] - h.y) < 9 && Math.abs(c.pos[2] - h.z) < 4)
      if (this.P.harvestW && !o.self.weapons.some((w: any) => w && w.kind === "laser"))
        for (const p of this.pickMem.values()) if (p.kind === "laser" && hyp(p.pos[0] - h.x, p.pos[1] - h.y) < 8 && Math.abs(p.pos[2] - h.z) < 4) near.push(p)
      // done: close enough to see the spot and nothing left there (or it is outside the zone soon)
      if ((dh < 14 && near.length === 0 && this.t - h.t > 0.5) || hyp(h.x - zf.cx, h.y - zf.cy) > zf.r - 3) { this.harvests.splice(i, 1); continue }
      let tx = h.x, ty = h.y, td = dh
      for (const c of near) { const d = hyp(c.pos[0] - x, c.pos[1] - y); if (d < td) { td = d; tx = c.pos[0]; ty = c.pos[1] } }
      if (td < bd) { bd = td; best = [tx, ty] }
    }
    if (!best || bd > 150) return null
    const visN = visible.filter((tr) => hyp(tr.x - x, tr.y - y) < 120).length
    if (visN > this.P.harvestMaxVis || hpFrac < this.P.harvestHp) return null
    return best
  }

  // walk to a remembered ground-level crate (1 cube, maybe a weapon) or a drone (2 cubes) and shoot it from close by
  farmTarget(o: any, threats: Track[]): number[] | null {
    const me = o.self
    const [x, y, z] = me.pos
    if ((me.cubes ?? 0) >= this.P.farmMaxCubes) return null
    if (me.hp < (me.max_hp || 1400) * 0.6) return null
    if (threats.some((tr) => this.t - tr.lastSeen < this.P.farmQuiet)) return null
    const zf = this.zoneAt(o, this.t + 20)
    let best: number[] | null = null, bs = Infinity, bid = -1, isNpc = false
    for (const [id, c] of this.crates) {
      if (this.farmBan.has(id)) continue
      if (Math.abs(c.z - this.nav.surfAt(c.x, c.y)) > 2.5) continue // roof crate
      const d = hyp(c.x - x, c.y - y)
      if (d > this.P.farmR) continue
      if (hyp(c.x - zf.cx, c.y - zf.cy) > zf.r - 15) continue
      if (d < bs) { bs = d; best = [c.x, c.y]; bid = id; isNpc = false }
    }
    if (me.hp > (me.max_hp || 1400) * 0.75) {
      for (const [id, n] of this.npcs) {
        if (this.t - n.t > 3 || this.farmBan.has(id)) continue
        const d = hyp(n.pos[0] - x, n.pos[1] - y)
        if (d > 110 || hyp(n.pos[0] - zf.cx, n.pos[1] - zf.cy) > zf.r - 15) continue
        if (d - 30 < bs) { bs = d - 30; best = [n.pos[0], n.pos[1]]; bid = id; isNpc = true }
      }
    }
    if (!best) { this.farmId = -1; return null }
    if (bid !== this.farmId) { this.farmId = bid; this.farmSince = this.t }
    else if (this.t - this.farmSince > 30) { this.farmBan.add(bid); this.farmId = -1; return null } // unreachable or taking too long
    const d = hyp(best[0] - x, best[1] - y)
    const muz = z + (me.stats?.muzzle_height ?? 7)
    const close = isNpc ? 45 : 26
    if (d < close && this.w.shotClear(x, y, muz, best[0], best[1], isNpc ? this.npcs.get(bid).pos[2] + 1.75 : this.crates.get(bid)!.z + 1.2)) return [x, y]
    if (best) { this.lastTargetId = best.id; this.lastTargetT = this.t }
    return best
  }

  lootTarget(o: any, threats: Track[]): number[] | null {
    const me = o.self
    const [x, y, z] = me.pos
    const zfut = this.zoneAt(o, this.t + 15)
    if (threats.some((tr) => this.t - tr.lastSeen < 6 && hyp(tr.x - x, tr.y - y) < 150)) {
      // only nearby cubes (e.g. after a kill) when nobody visible is close
      const visClose = threats.some((tr) => tr.visible && hyp(tr.x - x, tr.y - y) < 90)
      if (visClose && !this.P.cubeGrab) return null
      if (visClose) {
        let bc: number[] | null = null, bd = 16
        for (const c of o.cubes ?? []) {
          const d = hyp(c.pos[0] - x, c.pos[1] - y)
          if (d < bd && Math.abs(c.pos[2] - z) < 3) { bd = d; bc = [c.pos[0], c.pos[1]] }
        }
        return bc
      }
      // a valuable weapon close by (e.g. dropped by a kill)
      for (const p of o.pickups ?? []) {
        const [gain] = this.takeGain(me, p.kind)
        if (gain >= 1.5 && hyp(p.pos[0] - x, p.pos[1] - y) < 32 && Math.abs(p.pos[2] - z) < 3) return [p.pos[0], p.pos[1]]
      }
      let bc: number[] | null = null, bd = this.P.cubeGrab ? 50 : 28
      for (const c of o.cubes ?? []) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y)
        if (d < bd && Math.abs(c.pos[2] - z) < 3) { bd = d; bc = [c.pos[0], c.pos[1]] }
      }
      return bc
    }
    let best: number[] | null = null, bs = -Infinity
    for (const p of this.P.lootMem ? this.pickMem.values() : o.pickups ?? []) {
      const [gain] = this.takeGain(me, p.kind)
      if (gain < 0.4) continue
      if (Math.abs(p.pos[2] - this.nav.surfAt(p.pos[0], p.pos[1])) > 2.5) continue // roof loot: skip
      const d = hyp(p.pos[0] - x, p.pos[1] - y)
      if (d > 40 + gain * 25) continue
      if (hyp(p.pos[0] - zfut.cx, p.pos[1] - zfut.cy) > zfut.r - 10) continue
      const s = gain * 20 - d
      if (s > bs) { bs = s; best = [p.pos[0], p.pos[1]] }
    }
    if (best) return best
    // supply drop: +cubes, full HP/energy, if it is close, on the ground or landing soon, and uncontested
    for (const d of this.P.drops ? o.drops ?? [] : []) {
      if (d.holder !== null && d.holder !== o.self.id) continue
      const dd = hyp(d.pos[0] - x, d.pos[1] - y)
      if (dd > 140 || d.lands_in > dd / 11 + 4) continue
      if (hyp(d.pos[0] - zfut.cx, d.pos[1] - zfut.cy) > zfut.r - 8) continue
      if (threats.some((tr) => this.t - tr.lastSeen < 10 && hyp(tr.x - d.pos[0], tr.y - d.pos[1]) < 120)) continue
      const c = this.nav.nearestMain(d.pos[0], d.pos[1], 6)
      if (c >= 0 && hyp(this.nav.cx(c) - d.pos[0], this.nav.cy(c) - d.pos[1]) < (d.radius ?? 8) - 2) return [this.nav.cx(c), this.nav.cy(c)]
    }
    for (const c of o.cubes ?? []) {
      const d = hyp(c.pos[0] - x, c.pos[1] - y)
      if (d > 70 || Math.abs(c.pos[2] - z) > 3) continue
      if (hyp(c.pos[0] - zfut.cx, c.pos[1] - zfut.cy) > zfut.r - 10) continue
      if (-d > bs) { bs = -d; best = [c.pos[0], c.pos[1]] }
    }
    return best
  }

  // best way to use pickup kind p: returns [gain, dropSlot or -1 for empty slot]
  takeGain(me: any, kind: string): [number, number] {
    const w0 = me.weapons[0]?.kind ?? null, w1 = me.weapons[1]?.kind ?? null
    if (w0 === kind || w1 === kind) return [0, -1]
    const T = LOADOUTS[this.P.loadout] ?? LOADOUTS.old
    const cur = loadoutValue(w0, w1, T)
    let best = 0, slot = -2
    if (!me.weapons[0]) { const g = loadoutValue(kind, w1, T) - cur; if (g > best) { best = g; slot = -1 } }
    if (!me.weapons[1]) { const g = loadoutValue(w0, kind, T) - cur; if (g > best) { best = g; slot = -1 } }
    for (const sl of [0, 1]) {
      const w = me.weapons[sl]
      if (!w) continue
      if (w.kind === "laser" && (w.charge ?? 0) > 0) continue
      const g = loadoutValue(sl === 0 ? kind : w0, sl === 1 ? kind : w1, T) - cur
      if (g > best + 0.01) { best = g; slot = sl }
    }
    return slot === -2 ? [0, -1] : [best, slot]
  }

  handleTake(o: any, a: any) {
    const me = o.self
    const [x, y, z] = me.pos
    const reach = (this.cfg?.loot?.pickup_radius ?? 4) - 0.3
    let bestG = 0.4, bestP: any = null, bestSlot = -1
    for (const p of o.pickups ?? []) {
      if (hyp(p.pos[0] - x, p.pos[1] - y) > reach || Math.abs(p.pos[2] - z) > 3.8) continue
      const [g, sl] = this.takeGain(me, p.kind)
      if (g > bestG) { bestG = g; bestP = p; bestSlot = sl }
    }
    if (bestP) {
      a.take = bestP.id
      if (bestSlot >= 0) a.drop = bestSlot
    }
  }

  // fight power ~ effective HP x sustained DPS: score each choice by its marginal gain
  upgradeGain(id: string, me: any): number {
    const ws = (me.weapons ?? []).filter((w: any) => w)
    const ups: string[] = me.upgrades ?? []
    const cnt = (u: string) => ups.filter((x) => x === u).length
    const st = me.stats ?? {}
    // sustained DPS per held weapon (current stats), with rough hit rates
    const dps: Record<string, number> = {}
    for (const w of ws) {
      const s = w.stats ?? this.wcfg(w.kind)
      if (w.kind === "gun") dps.gun = ((s.damage ?? 45) * (s.mag ?? 12)) / ((s.mag ?? 12) * (s.cooldown ?? 0.24) + (s.reload ?? 2.4)) * 0.8
      else if (w.kind === "laser") dps.laser = (s.damage ?? 315) / ((s.charge ?? 0.75) + (s.cooldown ?? 1.65)) * 0.9
      else if (w.kind === "lightning") dps.lightning = ((s.damage ?? 60) / (s.cooldown ?? 0.25)) * 0.35 // only inside 45 m
      else if (w.kind === "mortar") dps.mortar = ((s.damage ?? 200) * 0.6) / (s.cooldown ?? 2.6) * 0.5
    }
    const tot = Object.values(dps).reduce((a, b) => a + b, 0) || 1
    const share = (k: string) => (dps[k] ?? 0) / tot
    const g = this.wcfg("gun")
    switch (id) {
      case "plating": return 0.15
      case "armor": { const a = (st.armor ?? 0); return 1 / (1 - Math.min(0.9, a + 0.08)) * (1 - a) - 1 }
      case "nanites": return 0.05
      case "gun_damage": return 0.15 * share("gun")
      case "gun_rate": { const s = ws.find((w: any) => w.kind === "gun")?.stats ?? g; const m = s.mag ?? 12, c = s.cooldown ?? 0.24, r = s.reload ?? 2.4; return ((m * c + r) / (m * c * 0.87 + r) - 1) * share("gun") }
      case "gun_mag": { const s = ws.find((w: any) => w.kind === "gun")?.stats ?? g; const m = s.mag ?? 12, c = s.cooldown ?? 0.24, r = s.reload ?? 2.4; return (((m + 8) / ((m + 8) * c + r * 0.8)) / (m / (m * c + r)) - 1) * share("gun") }
      case "laser_damage": return 0.18 * share("laser")
      case "laser_charge": { const s = ws.find((w: any) => w.kind === "laser")?.stats ?? this.wcfg("laser"); const ch = s.charge ?? 0.75, cd = s.cooldown ?? 1.65; return ((ch + cd) / (ch * 0.75 + cd) - 1) * share("laser") }
      case "lightning_efficiency": return 0.1 * share("lightning") + 0.02
      case "lightning_range": return 0.12 * share("lightning")
      case "lightning_chain": return 0.03 * share("lightning")
      case "mortar_reload": return (1 / 0.82 - 1) * share("mortar")
      case "gyros": return 0.03
      case "servos": return 0.03
      case "gun_velocity": return 0.04 * share("gun")
      case "sensors": return 0.02
      case "reactor": case "capacitor": return 0.015
      case "jets": return 0.01
      default: return 0
    }
  }

  pickUpgrade(choices: any[], me: any): number {
    if (this.P.upg === "auto") {
      let bi = 0, bg = -Infinity
      choices.forEach((c: any, i: number) => {
        let gn = this.upgradeGain(c.id, me)
        if (this.t > 300 && c.id === "plating") gn += 0.2 // the final zone bleeds everyone; armor does not reduce it
        if (gn > bg) { bg = gn; bi = i }
      })
      return bi
    }
    let best = 0, bi = 999
    // late game: the final zone bleeds everyone (armor does not help there), max HP decides
    const base = UPGRADE_PRIOS[this.P.upg] ?? UPGRADE_PRIO
    const prio = this.t > 300 ? ["plating", ...base.filter((u) => u !== "plating")] : base
    choices.forEach((c: any, i: number) => {
      const k = prio.indexOf(c.id)
      const r = k < 0 ? 500 : k
      if (r < bi) { bi = r; best = i }
    })
    return best
  }

  // ------------------------------------------------------------------ movement
  directMode = false
  scanStartYaw: number | null = null
  ownsNav = false
  ffaDetectedAt = -1
  ffaEvidence = 0
  ourHits = new Map<number, number>() // target id -> last time we hit it
  relocTarget: number[] | null = null
  relocUntil = 0
  relocT = -99
  steer(o: any, dest: number[]): number[] {
    const [x, y] = o.self.pos
    const myC = this.nav.nearestWalkable(x, y, 6), dC = this.nav.nearestWalkable(dest[0], dest[1], 10)
    if (myC < 0 || dC < 0 || this.nav.comp[myC] !== this.nav.comp[dC]) {
      // not connected on foot: head straight there; handleStuck jumps and jets over obstacles
      this.directMode = true
      // if we are stranded off the main area and the goal is in it, first get to the nearest main cell
      let tx = dest[0], ty = dest[1]
      if (myC >= 0 && !this.nav.inMain(myC) && dC >= 0 && this.nav.inMain(dC)) {
        const m = this.nav.nearestMain(x, y, 120)
        if (m >= 0 && hyp(this.nav.cx(m) - x, this.nav.cy(m) - y) < hyp(tx - x, ty - y)) { tx = this.nav.cx(m); ty = this.nav.cy(m) }
      }
      const d = hyp(tx - x, ty - y) || 1
      return [(tx - x) / d, (ty - y) / d]
    }
    this.directMode = false
    const need = !this.path || !this.pathGoal || hyp(dest[0] - this.pathGoal[0], dest[1] - this.pathGoal[1]) > 4 || this.t - this.pathT > 2.5
    if (need && (!this.path || performance.now() < this.deadline - 2)) {
      const far = hyp(dest[0] - x, dest[1] - y)
      // keep the route inside the zone as it will be a little later (margin 4 m)
      const zf = this.zoneAt(o, this.t + Math.min(20, far / 11 + 3))
      const tp0 = performance.now()
      const maxExp = this.slow > 4 ? 1200 : this.slow > 2 ? 2500 : far > 250 ? 9000 : 5000
      this.path = this.nav.findPath(x, y, dest[0], dest[1], null, maxExp, 1.3, [zf.cx, zf.cy, Math.max(0, zf.r - 4)])
      const tpd = performance.now() - tp0
      if (tpd > 4 && (globalThis as any).__MF_SLOWLOG) (globalThis as any).__MF_SLOWLOG(`path ${tpd.toFixed(1)}ms exp=${this.nav.lastExpanded} from ${x.toFixed(0)},${y.toFixed(0)} to ${dest[0].toFixed(0)},${dest[1].toFixed(0)} len=${this.path?.length}`)
      this.pathGoal = dest.slice()
      this.pathT = this.t
    }
    const p = this.path
    if (!p || p.length === 0) {
      const d = hyp(dest[0] - x, dest[1] - y) || 1
      return [(dest[0] - x) / d, (dest[1] - y) / d]
    }
    let bi = 0, bd = Infinity
    const lim = Math.min(p.length, 30)
    for (let i = 0; i < lim; i++) {
      const d = hyp(this.nav.cx(p[i]) - x, this.nav.cy(p[i]) - y)
      if (d < bd) { bd = d; bi = i }
    }
    if (bi > 0) p.splice(0, bi)
    if (bd > 12) { this.pathT = -99 } // off path: replan next tick
    let ti = Math.min(p.length - 1, 1)
    for (let i = Math.min(p.length - 1, 12); i >= 1; i--) {
      if (this.nav.segmentClear(x, y, this.nav.cx(p[i]), this.nav.cy(p[i]))) { ti = i; break }
    }
    let tx = this.nav.cx(p[ti]), ty = this.nav.cy(p[ti])
    if (ti === p.length - 1) { tx = dest[0]; ty = dest[1] }
    const d = hyp(tx - x, ty - y)
    if (d < 0.6) return [0, 0]
    const sp = d < 3 ? d / 3 : 1
    return [((tx - x) / d) * sp, ((ty - y) / d) * sp]
  }

  handleStuck(o: any, a: any, ml: number) {
    const me = o.self
    const [x, y] = me.pos
    const moved = hyp(x - this.lastPos[0], y - this.lastPos[1])
    if (ml > 0.5 && moved < 0.25 && me.grounded) this.stuckT += this.directMode ? 0.25 : 0.1
    else this.stuckT = Math.max(0, this.stuckT - 0.05)
    if (this.directMode && ml > 0.5 && me.energy > 5) {
      // obstacle ahead taller than a step? jump and jet over it
      const mvx = a.move[0] / ml, mvy = a.move[1] / ml
      const z = me.pos[2]
      let block = -Infinity
      for (const dd of [3, 5, 7]) block = Math.max(block, this.w.surfaceHeight(x + mvx * dd, y + mvy * dd))
      if (block > z + 1.1) {
        if (me.grounded) a.jump = true
        else a.boost = true
      }
    }
    if (this.stuckT > 0.8) {
      a.jump = true
      if (this.stuckT > 1.5) {
        const ang = this.rand() * TAU
        a.move = [Math.cos(ang), Math.sin(ang)]
        this.pathT = -99
      }
      if (this.stuckT > 3) this.stuckT = 0
    }
    // keep jetting if we jumped while stuck to clear a ledge
    if (!me.grounded && this.stuckT > 0.8 && me.energy > 20) a.boost = true
  }

  dodge(o: any): number[] | null {
    const me = o.self
    const [x, y, z] = me.pos
    let dx = 0, dy = 0, n = 0
    for (const p of o.projectiles ?? []) {
      if (p.kind === "mortar") {
        // predict landing near us: move away from the impact point
        const g = this.wcfg("mortar").gravity ?? 22
        // solve z(t) = z ground
        const vz = p.vel[2], pz = p.pos[2] - (z + 2)
        const disc = vz * vz + 2 * g * pz
        if (disc < 0) continue
        const tl = (vz + Math.sqrt(disc)) / g
        if (tl > 3) continue
        const ix = p.pos[0] + p.vel[0] * tl, iy = p.pos[1] + p.vel[1] * tl
        const d = hyp(ix - x, iy - y)
        if (d < 10) { const u = d || 1; dx += (x - ix) / u; dy += (y - iy) / u; n++ }
        continue
      }
      const rx = x - p.pos[0], ry = y - p.pos[1], rz = z + 4.5 - p.pos[2]
      const vx = p.vel[0], vy = p.vel[1], vz = p.vel[2]
      const vv = vx * vx + vy * vy + vz * vz
      if (vv < 1) continue
      const tc = (rx * vx + ry * vy + rz * vz) / vv
      if (tc < 0 || tc > 0.6) continue
      const cx = p.pos[0] + vx * tc - x, cy = p.pos[1] + vy * tc - y
      const miss = hyp(cx, cy)
      if (miss > 4.5) continue
      // move perpendicular to the bullet, away from its line
      const hv = hyp(vx, vy) || 1
      let px = -vy / hv, py = vx / hv
      if (px * -cx + py * -cy < 0) { px = -px; py = -py }
      dx += px; dy += py; n++
    }
    if (!n) return null
    const l = hyp(dx, dy) || 1
    return [dx / l, dy / l]
  }

  // ------------------------------------------------------------------ aiming
  aimAndFire(o: any, a: any, target: Track | null, visible: Track[], threats: Track[], why = "") {
    const me = o.self
    const [x, y, z] = me.pos
    const st = me.stats ?? {}
    const muzH = st.muzzle_height ?? 7
    const turn = st.turn_rate ?? 4
    let slotGun = -1, slotLaser = -1, slotLight = -1, slotMortar = -1
    me.weapons.forEach((w: any, i: number) => { if (!w) return; if (w.kind === "gun") slotGun = i; else if (w.kind === "laser") slotLaser = i; else if (w.kind === "lightning") slotLight = i; else if (w.kind === "mortar") slotMortar = i })
    const laserW = slotLaser >= 0 ? me.weapons[slotLaser] : null
    const laserCharging = laserW && (laserW.charge ?? 0) > 0
    if (laserW && (laserW.charge ?? 0) >= (laserW.stats?.charge ?? 0.75) - 0.051) { if (this.laserFullSince < 0) this.laserFullSince = this.t } else this.laserFullSince = -1

    // NPC / crate shooting when idle
    let tgtPt: number[] | null = null
    let tgtVel = [0, 0, 0]
    let tgtR = 2.5
    let isMech = false
    if (target) {
      const sz = 1 + (this.cfg?.cubes?.size_per_cube ?? 0.05) * (target.cubes ?? 0)
      tgtPt = [target.x, target.y, target.z + 4.5 * sz]
      tgtVel = [target.vx, target.vy, target.vz]
      tgtR = 2.5 * sz
      isMech = true
    } else if (this.npcAggro && this.t - this.npcAggro.t < 3) {
      // a drone is shooting us: kill it (it has little HP) or at least look at it
      const npc = this.aggroNpc(o)
      if (npc) { tgtPt = [npc.pos[0], npc.pos[1], npc.pos[2] + 1.75]; tgtVel = [npc.vel[0], npc.vel[1], 0]; tgtR = 1.8 }
      else { a.aim = [this.npcAggro.b, 0]; return }
    } else if (why === "lcrate" && this.crateGoal) {
      tgtPt = [this.crateGoal.x, this.crateGoal.y, this.crateGoal.z + 1.2]; tgtR = 1.4
    } else if (this.P.lootNoise && !(this.P.regenHold > 0 && me.hp / (me.max_hp || 1400) < this.P.regenHold) && (o.t < this.P.lootNoiseUntil || (this.P.farm && (me.cubes ?? 0) < this.P.farmMaxCubes)) && !this.recovering && why !== "alert" && !threats.some((tr) => this.t - tr.lastSeen < (this.P.farm ? this.P.farmQuiet : 20))) {
      const npc = this.npcTarget(o, threats)
      if (npc) { tgtPt = [npc.pos[0], npc.pos[1], npc.pos[2] + 1.75]; tgtVel = [npc.vel[0], npc.vel[1], 0]; tgtR = 1.8 }
      else {
        const cr = this.crateTarget2(o, threats)
        if (cr) { tgtPt = [cr.pos[0], cr.pos[1], cr.pos[2] + 1.2]; tgtR = 1.4 }
      }
    }

    if (!tgtPt) {
      // no target: watch the nearest visible enemy, else the most likely threat direction
      let watch: Track | null = null
      for (const tr of visible) if (!watch || hyp(tr.x - x, tr.y - y) < hyp(watch.x - x, watch.y - y)) watch = tr
      a.aim = watch ? [Math.atan2(watch.y - y, watch.x - x), Math.atan2(watch.z + 4.5 - (z + muzH), hyp(watch.x - x, watch.y - y))] : [this.lookDirection(o, threats), 0]
      // release laser harmlessly is wasteful; just stop charging (fires at min charge) only if charging
      if (laserCharging) a.fire[slotLaser] = false
      // reload when idle
      const g = slotGun >= 0 ? me.weapons[slotGun] : null
      if (g && g.reload <= 0 && g.ammo < (g.stats?.mag ?? 12) * 0.6 && visible.length === 0) a.reload = true
      return
    }

    const ox = x, oy = y, oz = z + muzH
    const dist = hyp(tgtPt[0] - ox, tgtPt[1] - oy, tgtPt[2] - oz)
    let shotOk = this.w.shotClear(ox, oy, oz, tgtPt[0], tgtPt[1], tgtPt[2])
    if (!shotOk && isMech) {
      // center hidden (low wall, ledge): try the upper body
      const up = tgtPt[2] + 3.2 * (tgtR / 2.5)
      if (this.w.shotClear(ox, oy, oz, tgtPt[0], tgtPt[1], up)) { tgtPt = [tgtPt[0], tgtPt[1], up]; shotOk = true; tgtR *= 0.6 }
    }

    // gun lead
    const gs = slotGun >= 0 ? me.weapons[slotGun].stats?.speed ?? 252 : 252
    let leadVel = tgtVel
    if (this.P.leadAdapt && target && target.rev) {
      // flip rate over the last up-to-8 s of tracking (prior: one flip per 4 s), expected travel over the flight time
      const span = Math.max(2, Math.min(8, this.t - target.firstSeen))
      const h = (target.rev.flips.length + 0.5) / (span + 2)
      const tf = dist / gs
      const f = h * tf > 1e-3 ? (1 - Math.exp(-2 * h * tf)) / (2 * h * tf) : 1
      leadVel = [tgtVel[0] * f, tgtVel[1] * f, tgtVel[2]]
    }
    let lead = this.intercept(ox, oy, oz, tgtPt, leadVel, gs, (me.weapons[slotGun]?.stats?.range ?? 230))
    let hitP = 1
    if (this.P.leadMC && target && target.rev && isMech) {
      const mc = this.leadMC(ox, oy, oz, tgtPt, tgtVel, target, gs, tgtR)
      lead = mc.pt; hitP = mc.p
    }
    let aimYaw = Math.atan2(lead[1] - oy, lead[0] - ox)
    let aimPitch = Math.atan2(lead[2] - oz, hyp(lead[0] - ox, lead[1] - oy))

    // laser: hitscan, aim at current position (+ one tick)
    let laserAim: number[] | null = null
    if (laserW) {
      const lx = tgtPt[0] + tgtVel[0] * 0.08, ly = tgtPt[1] + tgtVel[1] * 0.08, lz = tgtPt[2]
      laserAim = [Math.atan2(ly - oy, lx - ox), Math.atan2(lz - oz, hyp(lx - ox, ly - oy))]
    }
    const tol = Math.atan2(tgtR * 0.75, dist)
    const curYaw = me.aim[0], curPitch = me.aim[1]
    const slewTick = turn * 0.05

    // laser logic: charge while target in range & shootable, release when full and aligned
    let laserPriority = false
    if (laserW && isMech && shotOk && dist < (laserW.stats?.range ?? 280) - 5) {
      const full = (laserW.charge ?? 0) >= (laserW.stats?.charge ?? 0.75) - 0.051
      if (laserW.cooldown <= 0.05) {
        if (full) laserPriority = true
        const errL = Math.abs(wrap(curYaw - laserAim![0])) + Math.abs(curPitch - laserAim![1]) * 0.7
        if (full && errL < tol * 0.9) a.fire[slotLaser] = false // release now
        else a.fire[slotLaser] = true
        // early release if the target is about to break line (low streak) - keep simple
      }
    } else if (laserCharging) {
      const fullC = (laserW.charge ?? 0) >= (laserW.stats?.charge ?? 0.75) - 0.051
      a.fire[slotLaser] = laserW && (laserW.charge ?? 0) < (laserW.stats?.charge ?? 0.75) // keep charging a bit if target lost briefly
      // hold a full charge for a target that just ducked out of sight (auto-fire comes after hold_s at full)
      if (this.P.laserHold && fullC && target && this.t - this.laserFullSince < (laserW.stats?.hold_s ?? 2) - 0.35) a.fire[slotLaser] = true
      if (!target) a.fire[slotLaser] = false
    }

    if (laserPriority && laserAim) { aimYaw = laserAim[0]; aimPitch = laserAim[1] }
    // mortar: only for slow/stationary targets at mid range when no laser in progress
    let mortarAiming = false
    if (!laserPriority && slotMortar >= 0 && isMech && dist > 25 && dist < 220 && (!this.P.mortarUse || shotOk)) {
      const mw = me.weapons[slotMortar]
      const sp = hyp(tgtVel[0], tgtVel[1])
      if (mw.cooldown <= 0 && (sp < 6 || this.P.mortarUse)) {
        const v = mw.stats?.speed ?? 72, g = mw.stats?.gravity ?? 22, mz = z + (st.height ?? 9) + 0.5
        let px = tgtPt[0], py = tgtPt[1]
        let sol = this.mortarSolve(x, y, mz, px, py, tgtPt[2] - 3.5, v, g)
        if (this.P.mortarUse) {
          // lead the impact point by a damped share of the target's velocity (strafers reverse often)
          for (let it = 0; it < 3 && sol; it++) {
            const tf = hyp(px - x, py - y) / Math.max(1, v * Math.cos(sol[1]))
            px = tgtPt[0] + tgtVel[0] * tf * 0.6; py = tgtPt[1] + tgtVel[1] * tf * 0.6
            sol = this.mortarSolve(x, y, mz, px, py, tgtPt[2] - 3.5, v, g)
          }
        }
        if (sol && (slotGun < 0 || this.P.mortarUse)) { aimYaw = sol[0]; aimPitch = sol[1]; mortarAiming = slotGun >= 0 }
        if (sol && Math.abs(wrap(curYaw - sol[0])) < 0.03 && Math.abs(curPitch - sol[1]) < 0.03) a.fire[slotMortar] = true
      }
    }
    a.aim = [aimYaw, clamp(aimPitch, st.min_pitch ?? -0.7, st.max_pitch ?? 1.3)]
    // being shot from an unseen direction while our target is not shootable: turn to acquire the shooter
    const lb = this.threatBearings[this.threatBearings.length - 1]
    if (lb && this.t - lb.t < 1.5 && (lb.by === null || !this.tracks.get(lb.by)?.visible) && !laserPriority) {
      const g = slotGun >= 0 ? me.weapons[slotGun] : null
      if (!shotOk || (g && g.reload > 0.4)) a.aim = [lb.b, 0]
    }

    const err = Math.abs(wrap(curYaw - aimYaw)) + Math.abs(curPitch - aimPitch) * 0.7
    if (slotGun >= 0 && shotOk && dist < (me.weapons[slotGun].stats?.range ?? 230) * 0.95) {
      const g = me.weapons[slotGun]
      const maxGunRange = isMech ? this.P.maxGunRange : 120
      if (err < tol + slewTick * this.P.fireSlack && dist < maxGunRange && g.reload <= 0 && !mortarAiming && !(isMech && this.P.fireMinP > 0 && hitP < this.P.fireMinP)) a.fire[slotGun] = true
      if (g.ammo === 0 && g.reload <= 0) a.reload = true
    }
    if (slotLight >= 0 && shotOk) {
      const lw = me.weapons[slotLight]
      const rng = lw.stats?.range ?? 45
      const yawErr = Math.abs(wrap(curYaw - Math.atan2(tgtPt[1] - oy, tgtPt[0] - ox)))
      if (dist < rng - 2 && yawErr < 0.2 && me.energy > 8) a.fire[slotLight] = true
    }
  }

  // Sampled strafe futures: lateral motion (across our line of fire) reverses after intervals drawn from the pooled
  // observed reversal intervals (prior U[0.4,1.4] s), conditioned on the time since this target's last reversal;
  // velocity changes are limited by ground acceleration. Radial motion is linear. Returns the aim point at the centre of
  // the target-width window holding the most samples, and that window's share (estimated hit chance).
  leadMC(ox: number, oy: number, oz: number, p: number[], v: number[], tr: Track, speed: number, R: number): { pt: number[]; p: number } {
    const dx = p[0] - ox, dy = p[1] - oy
    const dh = hyp(dx, dy) || 1
    const ux = dx / dh, uy = dy / dh, lx = -uy, ly = ux
    const vr = v[0] * ux + v[1] * uy, vl = v[0] * lx + v[1] * ly
    let tf = hyp(dx, dy, p[2] - oz) / speed
    tf = hyp(dh + vr * tf, p[2] - oz) / speed + 0.05
    tf = Math.min(tf, 1.2)
    const pool = this.flipIntervals
    const usePool = pool.length >= 8
    const drawI = () => (usePool ? pool[Math.floor(this.rand() * pool.length)] : 0.4 + this.rand())
    const flips = tr.rev!.flips
    const age = flips.length ? Math.max(0, this.t - flips[flips.length - 1] - 0.15) : -1
    const meanI = usePool ? pool.reduce((a, b) => a + b, 0) / pool.length : 0.9
    const acc = (this.cfg?.mech?.ground_accel ?? 58.5) * 0.05 // per 0.05 s step
    const K = 40, dt = 0.05
    const xs = new Float64Array(K)
    for (let k = 0; k < K; k++) {
      let tnext: number
      if (age < 0) tnext = -Math.log(1 - this.rand() * 0.999) * meanI
      else {
        tnext = Infinity
        for (let tries = 0; tries < 12; tries++) { const I = drawI(); if (I > age) { tnext = I - age; break } }
      }
      let pos = 0, vel = vl, want = vl, t = 0
      while (t < tf - 1e-9) {
        if (t >= tnext) { want = -want; tnext += drawI() }
        const d = want - vel
        vel += d > acc ? acc : d < -acc ? -acc : d
        const step = Math.min(dt, tf - t)
        pos += vel * step
        t += step
      }
      xs[k] = pos
    }
    xs.sort()
    const wdt = R * 1.8
    let bestN = 0, bestC = xs[K >> 1], j = 0
    for (let i = 0; i < K; i++) {
      while (xs[i] - xs[j] > wdt) j++
      const n = i - j + 1
      if (n > bestN) { bestN = n; bestC = (xs[i] + xs[j]) / 2 }
    }
    let lat = bestC
    if (this.P.leadMCMean) { let m = 0; for (let i = 0; i < K; i++) m += xs[i]; lat = m / K }
    const pt = [p[0] + ux * vr * tf + lx * lat, p[1] + uy * vr * tf + ly * lat, p[2] + clamp(v[2], -3, 3) * tf * 0.3]
    return { pt, p: bestN / K }
  }

  intercept(ox: number, oy: number, oz: number, p: number[], v: number[], speed: number, range: number): number[] {
    let tx = p[0], ty = p[1], tz = p[2]
    for (let i = 0; i < 4; i++) {
      const d = hyp(tx - ox, ty - oy, tz - oz)
      const tf = Math.min(d / speed, range / speed) + 0.05
      tx = p[0] + v[0] * tf
      ty = p[1] + v[1] * tf
      tz = p[2] + clamp(v[2], -3, 3) * tf * 0.3
    }
    return [tx, ty, tz]
  }

  mortarSolve(ox: number, oy: number, oz: number, tx: number, ty: number, tz: number, v: number, g: number): number[] | null {
    const hd = hyp(tx - ox, ty - oy), hz = tz - oz
    const disc = v ** 4 - g * (g * hd * hd + 2 * hz * v * v)
    if (disc < 0 || hd < 1) return null
    const th = Math.atan((v * v - Math.sqrt(disc)) / (g * hd))
    return [Math.atan2(ty - oy, tx - ox), th]
  }

  aggroNpc(o: any): any {
    const [x, y, z] = o.self.pos
    let best: any = null, bs = Infinity
    for (const m of o.mechs ?? []) {
      if (m.kind !== "npc") continue
      const d = hyp(m.pos[0] - x, m.pos[1] - y)
      let s = d
      if (this.npcAggro && m.id === this.npcAggro.id) s -= 1000
      if (s < bs && d < 120 && this.w.shotClear(x, y, z + 7, m.pos[0], m.pos[1], m.pos[2] + 1.75)) { bs = s; best = m }
    }
    return best
  }

  npcTarget(o: any, threats: Track[]): any {
    const me = o.self
    const [x, y] = me.pos
    if (me.hp < me.max_hp * 0.7) return null
    if (threats.some((tr) => this.t - tr.lastSeen < 8 && hyp(tr.x - x, tr.y - y) < 160)) return null
    let best: any = null, bd = 75
    for (const m of o.mechs ?? []) {
      if (m.kind !== "npc") continue
      const d = hyp(m.pos[0] - x, m.pos[1] - y)
      if (d < bd && this.w.shotClear(x, y, me.pos[2] + 7, m.pos[0], m.pos[1], m.pos[2] + 1.75)) { bd = d; best = m }
    }
    return best
  }

  crateTarget2(o: any, threats: Track[]): any {
    const me = o.self
    const [x, y] = me.pos
    if (threats.some((tr) => this.t - tr.lastSeen < 8 && hyp(tr.x - x, tr.y - y) < 160)) return null
    const g = me.weapons.find((w: any) => w && w.kind === "gun")
    if (!g || g.reload > 0) return null
    let best: any = null, bd = 45
    for (const c of o.crates ?? []) {
      const d = hyp(c.pos[0] - x, c.pos[1] - y)
      if (d < bd && Math.abs(c.pos[2] - me.pos[2]) < 4 && this.w.shotClear(x, y, me.pos[2] + 7, c.pos[0], c.pos[1], c.pos[2] + 1.2)) { bd = d; best = c }
    }
    return best
  }

  lookDirection(o: any, threats: Track[]): number {
    const me = o.self
    const [x, y] = me.pos
    // first seconds: sweep a full circle to spot nearby enemies and loot
    if (o.t < 2.0 && threats.length === 0) {
      if (this.scanStartYaw === null) this.scanStartYaw = me.aim[0]
      return wrap(this.scanStartYaw + Math.min(TAU, (o.t + 0.15) * (me.stats?.turn_rate ?? 4)))
    }
    if (this.mode === "scout" && this.scoutSweepT >= 0) {
      return wrap(me.aim[0] + 1.2)
    }
    // periodic sweep while quiet: finds loot (and enemies) behind us
    if (this.P.scanEvery > 0 && !threats.some((tr) => this.t - tr.lastSeen < 8) && this.t - this.lastDamagedT > 8) {
      const turn = me.stats?.turn_rate ?? 4
      if (this.t - this.sweepT0 > this.P.scanEvery) { this.sweepT0 = this.t; this.sweepYaw0 = me.aim[0] }
      const el = this.t - this.sweepT0
      if (el < TAU / turn + 0.2) return wrap(this.sweepYaw0 + Math.min(TAU, (el + 0.15) * turn))
    }
    // recent damage bearing first
    const lastB = this.threatBearings[this.threatBearings.length - 1]
    if (lastB && this.t - lastB.t < 3) return lastB.b
    // recently seen threats
    let best: Track | null = null
    for (const tr of threats) if (!best || tr.lastSeen > best.lastSeen) best = tr
    if (best && this.t - best.lastSeen < 8) return Math.atan2(best.y - y, best.x - x)
    // gunfire sounds
    const s = this.sounds[this.sounds.length - 1]
    if (s && this.t - s.t < 4 && s.dist !== "far") return s.b
    // moving: look where we go; holding: scan toward the zone center
    const v = me.vel
    if (hyp(v[0], v[1]) > 4 && this.mode !== "hold") return Math.atan2(v[1], v[0])
    const zn = o.zone
    const base = Math.atan2(zn.next_center[1] - y, zn.next_center[0] - x)
    if (this.t > this.scanT) { this.scanT = this.t + 1.6; this.scanBase = base + (this.rand() - 0.5) * 2.4 }
    return this.scanBase
  }
}
