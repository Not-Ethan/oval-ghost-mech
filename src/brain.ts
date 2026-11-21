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
}

type Cand = { x: number; y: number; z: number; c: number; score: number; dist: number; exp: number }

const UPGRADE_PRIO = ["armor", "plating", "nanites", "gun_damage", "laser_damage", "gun_rate", "laser_charge", "lightning_efficiency", "servos", "gyros", "gun_velocity", "capacitor", "reactor", "jets", "lightning_range", "gun_mag", "sensors", "lightning_chain", "mortar_reload", "mortar_velocity", "mortar_splash", "laser_pierce"]
const WEAPON_PRIO: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }
// value of a two-slot loadout (order irrelevant)
function loadoutValue(a: string | null, b: string | null): number {
  const k = [a ?? "", b ?? ""].sort().join("+")
  const V: Record<string, number> = {
    "+": 0, "+gun": 1, "+laser": 2.5, "+lightning": 2, "+mortar": 1,
    "gun+laser": 7, "gun+lightning": 6.5, "gun+mortar": 3.5,
    "laser+lightning": 9, "laser+mortar": 4.5, "lightning+mortar": 4,
  }
  return V[k] ?? 0
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
    this.relocTarget = null; this.relocUntil = 0; this.relocT = -99; this.ffaEvidence = 0; this.ffaDetectedAt = -1; this.ourHits.clear()
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
    const dry = !gunReady && !laserReady && !ltgReady
    if (!dest && (engaged || hostile.length || recentDmg > 0 || (this.recovering && recentThreat))) {
      const evade = this.recovering || dry || this.shouldEvade(o, visible, threats, hpFrac)
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
    if (engaged && why !== "zone") {
      if (this.t > this.jukeT) { this.jukeDir = this.rand() < 0.5 ? -1 : 1; this.jukeT = this.t + 0.35 + this.rand() * 0.6 }
      const ref = target ?? visible[0]
      const ang = Math.atan2(ref.y - y, ref.x - x) + (this.jukeDir * Math.PI) / 2
      const jx = Math.cos(ang), jy = Math.sin(ang)
      const ok = this.nav.clearanceAt(x + jx * 4, y + jy * 4) > 2.9
      if (ok) {
        const wgt = hyp(mv[0], mv[1]) > 0.1 ? 0.55 : 1
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
        s -= Math.max(0, exp - canHit) * 4
        s += canHit * 3
        if (target) {
          const d = hyp(cd.x - target.x, cd.y - target.y)
          const pref = this.preferredRange(o)
          s -= Math.abs(d - pref) * 0.02
        }
      }
      s += this.coverScore(cd.c) * 1.5 - (this.P.rearAware ? arcPen : 0)
      if (s > bs) { bs = s; best = cd }
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
    if (ws.includes("lightning")) return 35
    if (ws.includes("laser")) return 110
    return 75
  }

  // is this enemy engaging us (or about to)?
  isThreatening(o: any, tr: Track): boolean {
    const [x, y] = o.self.pos
    const d = hyp(tr.x - x, tr.y - y)
    if (this.t - tr.lastShotAtUs < 6) return true
    if (d < 50) return true
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
    for (const tr of visible) {
      const d = hyp(tr.x - x, tr.y - y)
      if (d > 260) continue
      let s = -d / 40 - (tr.hp / Math.max(1, tr.maxHp)) * 4
      if (this.t - tr.lastShotAtUs < 2) s += 2.5
      if (tr.charging) s += 1
      const yaw = Math.atan2(tr.y - y, tr.x - x)
      let rear = 0
      for (const b of shooters) if (Math.abs(wrap(b - yaw)) > Math.PI / 2 - 0.1) rear++
      if (this.P.rearAware) s -= rear * 3
      // shootable?
      if (!this.w.shotClear(x, y, z + 7, tr.x, tr.y, tr.z + 4.5)) s -= 6
      if (s > bs) { bs = s; best = tr }
    }
    return best
  }

  lootTarget(o: any, threats: Track[]): number[] | null {
    const me = o.self
    const [x, y, z] = me.pos
    const zfut = this.zoneAt(o, this.t + 15)
    if (threats.some((tr) => this.t - tr.lastSeen < 6 && hyp(tr.x - x, tr.y - y) < 150)) {
      // only nearby cubes (e.g. after a kill) when nobody visible is close
      if (threats.some((tr) => tr.visible && hyp(tr.x - x, tr.y - y) < 90)) return null
      // a valuable weapon close by (e.g. dropped by a kill)
      for (const p of o.pickups ?? []) {
        const [gain] = this.takeGain(me, p.kind)
        if (gain >= 1.5 && hyp(p.pos[0] - x, p.pos[1] - y) < 32 && Math.abs(p.pos[2] - z) < 3) return [p.pos[0], p.pos[1]]
      }
      let bc: number[] | null = null, bd = 28
      for (const c of o.cubes ?? []) {
        const d = hyp(c.pos[0] - x, c.pos[1] - y)
        if (d < bd && Math.abs(c.pos[2] - z) < 3) { bd = d; bc = [c.pos[0], c.pos[1]] }
      }
      return bc
    }
    let best: number[] | null = null, bs = -Infinity
    for (const p of o.pickups ?? []) {
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
    const cur = loadoutValue(w0, w1)
    let best = 0, slot = -2
    if (!me.weapons[0]) { const g = loadoutValue(kind, w1) - cur; if (g > best) { best = g; slot = -1 } }
    if (!me.weapons[1]) { const g = loadoutValue(w0, kind) - cur; if (g > best) { best = g; slot = -1 } }
    for (const sl of [0, 1]) {
      const w = me.weapons[sl]
      if (!w) continue
      if (w.kind === "laser" && (w.charge ?? 0) > 0) continue
      const g = loadoutValue(sl === 0 ? kind : w0, sl === 1 ? kind : w1) - cur
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

  pickUpgrade(choices: any[], me: any): number {
    let best = 0, bi = 999
    // late game: the final zone bleeds everyone (armor does not help there), max HP decides
    const prio = this.t > 300 ? ["plating", ...UPGRADE_PRIO.filter((u) => u !== "plating")] : UPGRADE_PRIO
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
    } else if (this.P.lootNoise && o.t < this.P.lootNoiseUntil && !this.recovering && why !== "alert" && !threats.some((tr) => this.t - tr.lastSeen < 20)) {
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
    const lead = this.intercept(ox, oy, oz, tgtPt, tgtVel, gs, (me.weapons[slotGun]?.stats?.range ?? 230))
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
      a.fire[slotLaser] = laserW && (laserW.charge ?? 0) < (laserW.stats?.charge ?? 0.75) // keep charging a bit if target lost briefly
      if (!target) a.fire[slotLaser] = false
    }

    if (laserPriority && laserAim) { aimYaw = laserAim[0]; aimPitch = laserAim[1] }
    // mortar: only for slow/stationary targets at mid range when no laser in progress
    if (!laserPriority && slotMortar >= 0 && isMech && dist > 25 && dist < 220) {
      const mw = me.weapons[slotMortar]
      const sp = hyp(tgtVel[0], tgtVel[1])
      if (mw.cooldown <= 0 && sp < 6) {
        const sol = this.mortarSolve(x, y, z + (st.height ?? 9) + 0.5, tgtPt[0], tgtPt[1], tgtPt[2] - 3.5, mw.stats?.speed ?? 72, mw.stats?.gravity ?? 22)
        if (sol && slotGun < 0) { aimYaw = sol[0]; aimPitch = sol[1] }
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
      if (err < tol + slewTick * this.P.fireSlack && dist < maxGunRange && g.reload <= 0) a.fire[slotGun] = true
      if (g.ammo === 0 && g.reload <= 0) a.reload = true
    }
    if (slotLight >= 0 && shotOk) {
      const lw = me.weapons[slotLight]
      const rng = lw.stats?.range ?? 45
      const yawErr = Math.abs(wrap(curYaw - Math.atan2(tgtPt[1] - oy, tgtPt[0] - ox)))
      if (dist < rng - 2 && yawErr < 0.2 && me.energy > 8) a.fire[slotLight] = true
    }
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
