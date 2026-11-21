// Local approximation of the mechfight/1 server, built from protocol.md and the recorded hello config.
// It is NOT the real server: house bots, exact physics and many details are guesses.
import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { moveAndSlide } from "./physics.ts"

export type Controller = {
  name: string
  squad: boolean // house squad member (shares vision, never fights squad)
  hello(h: any): void
  act(obs: any): any | null // null = no answer (timeout)
  end?(msg: any): void
}

export function rng(seed: number) {
  let a = seed >>> 0
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return f
}

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }

type Weapon = { kind: string; cooldown: number; ammo: number; reload: number; charge: number; charging: boolean; wasFiring: boolean; full: number }

type Mech = {
  id: number; alive: boolean; ctrl: Controller
  x: number; y: number; z: number; vx: number; vy: number; vz: number
  yaw: number; pitch: number; cmdYaw: number; cmdPitch: number
  move: [number, number]; boost: boolean; fire: [boolean, boolean]
  lastAnswerT: number
  hp: number; energy: number; lastSpend: number; lastCombat: number; grounded: boolean
  cubes: number; upgrades: string[]; weapons: (Weapon | null)[]
  shortUntil: number; equipUntil: [number, number]
  offers: any[]; offerSeq: number; nextThreshold: number
  seen: Map<number, number> // id -> last time directly seen
  events: any[]; sounds: any[]; beams: any[]
  stepAcc: number
  deathT: number; place: number; kills: number
  dmgDealt: number; dmgTaken: number
  shots: number; hits: number; lasers: number; laserHits: number
  wst: Record<string, { shots: number; hits: number; dmg: number }> // per weapon: shots fired, shots that hit a mech, damage to mechs
}

type Proj = { id: number; kind: string; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; ttl: number; dmgScale: number }

export type MatchResult = { places: number[]; kills: number[]; deathT: number[]; dmgDealt: number[]; dmgTaken: number[]; t: number; lateTicks: number; acc: string[] }

export class Sim {
  w: World; nav: Nav; cfg: any; R: () => number
  t = 0; tick = 0
  mechs: Mech[] = []
  npcs: any[] = []
  crates: any[] = []
  cubes: any[] = []
  pickups: any[] = []
  projs: Proj[] = []
  drops: any[] = []
  soundsLog: any[] = []
  nextId = { proj: 1, crate: 1000, cube: 5000, pick: 8000, drop: 20000, npc: 100 }
  zone: any
  phase = 0
  aliveCount = 16
  log: (s: string) => void = () => {}
  squadVision = true
  verbose = false
  trace: any[] | null = null
  // instrumentation: ids whose timeline is recorded (non-squad mechs), and early stop once they are all dead
  track = new Set<number>()
  rec = new Map<number, any[]>()
  stopWhenTrackedDead = false
  onTick: ((sim: Sim) => void) | null = null
  deathLog: any[] = []
  record(id: number, e: any) { const r = this.rec.get(id); if (r) r.push({ t: Math.round(this.t * 100) / 100, ...e }) }

  constructor(w: World, nav: Nav, cfg: any, seed: number, ctrls: Controller[]) {
    this.w = w; this.nav = nav; this.cfg = cfg; this.R = rng(seed)
    const zc = cfg.zone
    this.zone = { cx: zc.start_center[0], cy: zc.start_center[1], r: zc.start_radius, nx: 0, ny: 0, nr: 0, s0: 0, s1: 0, dps: 0 }
    this.startPhase(0, 0)
    // spawns
    const pts: number[][] = []
    for (let i = 0; i < ctrls.length; i++) {
      let p: number[] | null = null
      for (let tries = 0; tries < 4000 && !p; tries++) {
        const a = this.R() * TAU, rr = Math.sqrt(this.R()) * zc.start_radius * cfg.match.spawn_zone_fraction
        const x = zc.start_center[0] + Math.cos(a) * rr, y = zc.start_center[1] + Math.sin(a) * rr
        if (x < w.minX + cfg.match.arena_margin || x > w.maxX - cfg.match.arena_margin || y < w.minY + cfg.match.arena_margin || y > w.maxY - cfg.match.arena_margin) continue
        const c = nav.cellAt(x, y)
        if (c < 0 || !nav.walk[c] || nav.cellClear[c] < 4) continue
        const sep = tries < 3000 ? cfg.match.spawn_min_separation : 60
        if (pts.some((q) => Math.hypot(q[0] - x, q[1] - y) < sep)) continue
        p = [x, y]
      }
      if (!p) p = [0, 0]
      pts.push(p)
    }
    const m0 = cfg.mech
    ctrls.forEach((c, i) => {
      const [x, y] = pts[i]
      const yaw = Math.atan2(zc.start_center[1] - y, zc.start_center[0] - x)
      this.mechs.push({
        id: i, alive: true, ctrl: c, x, y, z: w.surfaceHeight(x, y, w.groundHeight(x, y) + 1.2), vx: 0, vy: 0, vz: 0,
        yaw, pitch: 0, cmdYaw: yaw, cmdPitch: 0, move: [0, 0], boost: false, fire: [false, false], lastAnswerT: 0,
        hp: m0.hp, energy: m0.energy, lastSpend: -99, lastCombat: -99, grounded: true, cubes: 0, upgrades: [],
        weapons: [this.newWeapon("gun"), null], shortUntil: -1, equipUntil: [0, 0], offers: [], offerSeq: 1, nextThreshold: 0,
        seen: new Map(), events: [], sounds: [], beams: [], stepAcc: 0, deathT: -1, place: 0, kills: 0, dmgDealt: 0, dmgTaken: 0, shots: 0, hits: 0, lasers: 0, laserHits: 0,
        wst: { gun: { shots: 0, hits: 0, dmg: 0 }, laser: { shots: 0, hits: 0, dmg: 0 }, lightning: { shots: 0, hits: 0, dmg: 0 }, mortar: { shots: 0, hits: 0, dmg: 0 } },
      })
    })
    // NPCs
    for (let i = 0; i < cfg.npc.count; i++) {
      const p = this.randomOpen(400, 3)
      this.npcs.push({ id: this.nextId.npc++, x: p[0], y: p[1], z: w.groundHeight(p[0], p[1]), hx: p[0], hy: p[1], hp: cfg.npc.hp, alive: true, target: -1, cd: 0, wx: p[0], wy: p[1], vx: 0, vy: 0, yaw: 0 })
    }
    // crates
    for (let i = 0; i < cfg.crates.count; i++) {
      const roof = this.R() < cfg.crates.roof_fraction
      const p = roof ? this.randomRoof() : this.randomOpen(480, 2)
      this.crates.push({ id: this.nextId.crate++, x: p[0], y: p[1], z: p[2] ?? w.surfaceHeight(p[0], p[1], w.groundHeight(p[0], p[1]) + 1.2), hp: cfg.crates.hp })
    }
    // floor loot
    for (let i = 0; i < cfg.loot.floor_count; i++) {
      const roof = this.R() < cfg.loot.floor_roof_fraction
      const p = roof ? this.randomRoof() : this.randomOpen(480, 2)
      this.addPickup(this.randomWeaponKind(), p[0], p[1], p[2] ?? w.surfaceHeight(p[0], p[1], w.groundHeight(p[0], p[1]) + 1.2))
    }
    const hello0 = { type: "hello", protocol: "mechfight/1", map: { dir: "arena", files: ["v2/world.json", "v2/terrain.i16"] }, config: cfg }
    for (const m of this.mechs) m.ctrl.hello({ ...hello0, slot: m.id, seed: 1000 + m.id })
  }

  newWeapon(kind: string): Weapon {
    const st = this.cfg.weapons[kind]
    return { kind, cooldown: 0, ammo: kind === "gun" ? st.mag : 0, reload: 0, charge: 0, charging: false, wasFiring: false, full: 0 }
  }
  randomWeaponKind(): string {
    const w = this.cfg.loot.weights
    const kinds = Object.keys(w).filter((k) => w[k] > 0)
    let tot = 0
    for (const k of kinds) tot += w[k]
    let r = this.R() * tot
    for (const k of kinds) { r -= w[k]; if (r <= 0) return k }
    return kinds[0]
  }
  addPickup(kind: string, x: number, y: number, z: number) {
    const p = { id: this.nextId.pick++, kind, x, y, z }
    this.pickups.push(p)
    return p
  }
  randomOpen(radius: number, clear: number, cx = this.cfg.zone.start_center[0], cy = this.cfg.zone.start_center[1]): number[] {
    for (let tries = 0; tries < 5000; tries++) {
      const a = this.R() * TAU, rr = Math.sqrt(this.R()) * radius
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr
      const c = this.nav.cellAt(x, y)
      if (c < 0 || !this.nav.walk[c] || this.nav.cellClear[c] < clear + 2.5) continue
      return [x, y]
    }
    return [cx, cy]
  }
  randomRoof(): number[] {
    for (let tries = 0; tries < 2000; tries++) {
      const p = this.w.prisms[Math.floor(this.R() * this.w.prisms.length)]
      if (p.kind !== "building" || p.top - this.w.groundHeight((p.minX + p.maxX) / 2, (p.minY + p.maxY) / 2) > 45) continue
      const x = p.minX + this.R() * (p.maxX - p.minX), y = p.minY + this.R() * (p.maxY - p.minY)
      const z = this.w.surfaceHeight(x, y)
      if (Math.abs(z - p.top) > 0.01) continue
      return [x, y, z]
    }
    return this.randomOpen(400, 2)
  }

  // ------------------------------------------------------------------ zone
  startPhase(k: number, t0: number) {
    const ph = this.cfg.zone.phases
    this.phase = k
    const z = this.zone
    if (k >= ph.length) { z.nx = z.cx; z.ny = z.cy; z.nr = z.r; z.s0 = 1e9; z.s1 = 1e9; z.dps = ph[ph.length - 1].dps; return }
    const p = ph[k]
    const slack = Math.max(0, z.r - p.radius)
    let nx = z.cx, ny = z.cy
    for (let tries = 0; tries < 500; tries++) {
      const a = this.R() * TAU, rr = Math.sqrt(this.R()) * slack
      const x = z.cx + Math.cos(a) * rr, y = z.cy + Math.sin(a) * rr
      const m = Math.min(60, p.radius * 0.5)
      if (x < this.w.minX + m || x > this.w.maxX - m || y < this.w.minY + m || y > this.w.maxY - m) continue
      if (p.radius < 30) { const c = this.nav.cellAt(x, y); if (c < 0 || !this.nav.walk[c]) continue }
      nx = x; ny = y; break
    }
    z.nx = nx; z.ny = ny; z.nr = p.radius; z.s0 = t0 + p.hold_s; z.s1 = t0 + p.hold_s + p.shrink_s; z.dps = p.dps
  }
  zoneNow(): { cx: number; cy: number; r: number } {
    const z = this.zone
    if (this.t <= z.s0) return { cx: z.cx, cy: z.cy, r: z.r }
    const f = Math.min(1, (this.t - z.s0) / Math.max(1e-6, z.s1 - z.s0))
    return { cx: z.cx + (z.nx - z.cx) * f, cy: z.cy + (z.ny - z.cy) * f, r: z.r + (z.nr - z.r) * f }
  }
  updateZone() {
    const z = this.zone
    if (this.t >= z.s1 && this.phase < this.cfg.zone.phases.length) {
      z.cx = z.nx; z.cy = z.ny; z.r = z.nr
      this.startPhase(this.phase + 1, this.t)
    }
  }

  // ------------------------------------------------------------------ stats
  statCache = new Map<number, any>()
  statTick = -1
  stats(m: Mech) {
    if (this.statTick !== this.tick) { this.statCache.clear(); this.statTick = this.tick }
    const key = m.id * 1000 + m.cubes * 10 + m.upgrades.length
    const hit = this.statCache.get(m.id)
    if (hit && hit.key === key) return hit.v
    const v = this.stats0(m)
    this.statCache.set(m.id, { key, v })
    return v
  }
  stats0(m: Mech) {
    const s: any = { ...this.cfg.mech }
    const ws: any = {}
    for (const k of Object.keys(this.cfg.weapons)) ws[k] = { ...this.cfg.weapons[k] }
    for (const uid of m.upgrades) {
      const u = this.cfg.upgrades.find((x: any) => x.id === uid)
      if (!u) continue
      for (const e of u.effects) {
        const parts = e.path.split(".")
        const obj = parts[0] === "mech" ? s : ws[parts[1]]
        const key = parts[parts.length - 1]
        if (e.mul !== undefined) obj[key] *= e.mul
        if (e.add !== undefined) obj[key] += e.add
      }
    }
    const cc = this.cfg.cubes
    const size = 1 + cc.size_per_cube * m.cubes
    s.hp = s.hp * (1 + cc.hp_per_cube * Math.min(m.cubes, cc.stat_cap))
    s.radius *= size; s.height *= size; s.eye_height *= size; s.muzzle_height *= size
    s.dmgScale = 1 + cc.damage_per_cube * Math.min(m.cubes, cc.stat_cap)
    return { s, ws }
  }

  // ------------------------------------------------------------------ sound / events
  sound(kind: string, x: number, y: number, src: number) {
    const range = this.cfg.sound.range[kind] ?? 100
    for (const m of this.mechs) {
      if (!m.alive || m.id === src) continue
      const d = Math.hypot(m.x - x, m.y - y)
      if (d > range) continue
      m.sounds.push({ kind, x, y, t: this.t, d })
    }
  }

  damage(target: Mech, amount: number, weapon: string, by: number, srcX: number, srcY: number, effect?: string) {
    if (!target.alive) return
    const { s } = this.stats(target)
    let rear = false
    if (by >= 0 || weapon === "npc") {
      const toSrc = Math.atan2(srcY - target.y, srcX - target.x)
      rear = Math.abs(wrap(toSrc - target.yaw)) > ((s.front_arc_deg / 2) * Math.PI) / 180
      if (rear) amount *= s.rear_mult
      amount *= 1 - Math.min(0.9, s.armor)
    }
    amount = Math.round(amount * 100) / 100
    target.hp -= amount
    target.dmgTaken += amount
    ;(target as any).lastHitW = weapon
    if (this.track.has(target.id)) this.record(target.id, { e: "taken", amt: Math.round(amount), w: weapon, by, byName: by >= 0 && by < 16 ? this.mechs[by].ctrl.name : by >= 100 ? "npc" : "zone", rear, hp: Math.round(target.hp) })
    if (by >= 0 && by < 16 && this.track.has(by)) this.record(by, { e: "dealt", amt: Math.round(amount), w: weapon, to: target.id, toName: target.ctrl.name, rear, tgtHp: Math.round(target.hp) })
    if (by >= 0 && by < 16 && weapon !== "zone" && this.mechs[by].wst[weapon]) this.mechs[by].wst[weapon].dmg += amount
    if (weapon === "zone") (target as any).zoneDmg = ((target as any).zoneDmg ?? 0) + amount
    target.lastCombat = this.t
    const bearing = weapon === "zone" ? null : Math.atan2(srcY - target.y, srcX - target.x)
    target.events.push({ type: "damaged", amount, weapon, bearing, by: by >= 0 ? by : null, ...(rear ? { rear: true } : {}) })
    if (by >= 0 && by < 16) {
      const a = this.mechs[by]
      a.lastCombat = this.t
      a.dmgDealt += amount
      a.events.push({ type: "hit", target: target.id, amount, weapon, ...(effect ? { effect } : {}), ...(rear ? { rear: true } : {}) })
    }
    if (target.hp <= 0) this.kill(target, by)
  }

  kill(m: Mech, by: number) {
    m.alive = false
    m.hp = 0
    m.deathT = this.t
    ;(m as any).pendingPlace = true
    if (by >= 0 && by < 16 && by !== m.id) { this.mechs[by].kills++; this.mechs[by].events.push({ type: "kill", target: m.id }) }
    this.deathLog.push({ t: Math.round(this.t * 10) / 10, id: m.id, name: m.ctrl.name, by, byName: by >= 0 && by < 16 ? this.mechs[by].ctrl.name : by >= 100 ? "npc" : (m as any).lastHitW === "zone" ? "zone" : "self-" + (m as any).lastHitW })
    if (this.track.has(m.id)) this.record(m.id, { e: "death", by, byName: by >= 0 && by < 16 ? this.mechs[by].ctrl.name : by >= 100 ? "npc" : "zone", alive: this.aliveCount })
    if (by >= 0 && by < 16 && this.track.has(by)) this.record(by, { e: "kill", victim: m.id, victimName: m.ctrl.name, myHp: Math.round(this.mechs[by].hp), victimCubes: m.cubes, victimWeapons: m.weapons.filter((w) => w).map((w) => w!.kind) })
    const n = m.cubes + this.cfg.cubes.death_drop_extra
    for (let i = 0; i < n; i++) this.cubes.push({ id: this.nextId.cube++, x: m.x + (this.R() - 0.5) * 6, y: m.y + (this.R() - 0.5) * 6, z: m.z, src: "mech" })
    for (const w of m.weapons) if (w && w.kind !== "gun") this.addPickup(w.kind, m.x + (this.R() - 0.5) * 4, m.y + (this.R() - 0.5) * 4, m.z)
    this.sound("death", m.x, m.y, m.id)
  }

  // ------------------------------------------------------------------ vision
  canSee(m: Mech, eye: number, tx: number, ty: number, tz: number, th: number, nearR: number, farR: number): boolean {
    const dx = tx - m.x, dy = ty - m.y
    const d = Math.hypot(dx, dy)
    if (d > farR) return false
    const ez = m.z + eye
    if (d <= nearR) {
      if (this.w.sees(m.x, m.y, ez, tx, ty, tz + th * 0.5, false) || this.w.sees(m.x, m.y, ez, tx, ty, tz + th, false)) return true
    }
    const half = ((this.cfg.vision.fov_deg / 2) * Math.PI) / 180
    if (Math.abs(wrap(Math.atan2(dy, dx) - m.yaw)) > half) return false
    const canopy = this.cfg.vision.canopy_blocks
    return this.w.sees(m.x, m.y, ez, tx, ty, tz + th * 0.5, canopy) || this.w.sees(m.x, m.y, ez, tx, ty, tz + th, canopy)
  }

  buildObs(m: Mech): any {
    const { s, ws } = this.stats(m)
    const nearR = this.cfg.vision.near_range + s.near_range_bonus
    const farR = this.cfg.vision.range + s.vision_bonus
    const mechs: any[] = []
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      const os = this.stats(o).s
      const vis = this.canSee(m, s.eye_height, o.x, o.y, o.z, os.height, nearR, farR)
      if (vis) m.seen.set(o.id, this.t)
      const last = m.seen.get(o.id)
      if (vis || (last !== undefined && this.t - last <= this.cfg.vision.memory_s)) {
        mechs.push({ id: o.id, kind: "mech", pos: [o.x, o.y, o.z], vel: [o.vx, o.vy, o.vz], aim: [o.yaw, o.pitch], hp: Math.max(0, o.hp), max_hp: os.hp, cubes: o.cubes, weapons: o.weapons.filter((w) => w).map((w) => w!.kind), charging: o.weapons.some((w) => w && w.kind === "laser" && w.charging) })
      }
    }
    for (const n of this.npcs) {
      if (!n.alive) continue
      const vis = this.canSee(m, s.eye_height, n.x, n.y, n.z, this.cfg.npc.height, nearR, farR)
      if (vis) m.seen.set(n.id, this.t)
      const last = m.seen.get(n.id)
      if (vis || (last !== undefined && this.t - last <= this.cfg.vision.memory_s)) mechs.push({ id: n.id, kind: "npc", pos: [n.x, n.y, n.z], vel: [n.vx, n.vy, 0], aim: [n.yaw, 0], hp: n.hp, max_hp: this.cfg.npc.hp })
    }
    const items = (list: any[], h: number, f: (o: any) => any) => {
      const out: any[] = []
      for (const o of list) {
        if (Math.abs(o.x - m.x) > farR || Math.abs(o.y - m.y) > farR) continue
        if (this.canSee(m, s.eye_height, o.x, o.y, o.z, h, nearR, farR)) out.push(f(o))
      }
      return out
    }
    const projectiles: any[] = []
    for (const p of this.projs) {
      if (p.owner === m.id) continue
      if (Math.abs(p.x - m.x) > farR || Math.abs(p.y - m.y) > farR) continue
      if (this.canSee(m, s.eye_height, p.x, p.y, p.z, 0, nearR, farR)) projectiles.push({ id: p.id, kind: p.kind, pos: [p.x, p.y, p.z], vel: [p.vx, p.vy, p.vz] })
    }
    const R2 = (v: number) => Math.round(v * 100) / 100
    const zn = this.zoneNow()
    const inZone = Math.hypot(m.x - zn.cx, m.y - zn.cy) <= zn.r
    const noise = ((this.cfg.sound.bearing_noise_deg * s.hearing) * Math.PI) / 180
    const sounds = m.sounds.map((q) => ({ kind: q.kind, bearing: wrap(Math.atan2(q.y - m.y, q.x - m.x) + this.gauss() * noise), dist: q.d < this.cfg.sound.near ? "near" : q.d < this.cfg.sound.mid ? "mid" : "far", age: R2(this.t - q.t + 0.05) }))
    m.sounds = []
    const offer = m.offers.length ? m.offers[0] : null
    const obs = {
      type: "obs", tick: this.tick, t: R2(this.t), alive: this.aliveCount,
      self: {
        id: m.id, pos: [R2(m.x), R2(m.y), R2(m.z)], vel: [R2(m.vx), R2(m.vy), R2(m.vz)], aim: [Math.round(m.yaw * 1000) / 1000, Math.round(m.pitch * 1000) / 1000],
        hp: R2(m.hp), max_hp: R2(s.hp), energy: R2(m.energy), max_energy: s.energy, grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades], in_zone: inZone,
        weapons: m.weapons.map((w) => w ? { kind: w.kind, cooldown: R2(Math.max(0, w.cooldown)), ...(w.kind === "gun" ? { ammo: w.ammo, reload: R2(w.reload) } : {}), ...(w.kind === "laser" ? { charge: R2(w.charge) } : {}), stats: ws[w.kind] } : null),
        stats: s,
      },
      mechs,
      projectiles,
      crates: items(this.crates, this.cfg.crates.height, (c) => ({ id: c.id, pos: [c.x, c.y, c.z], hp: c.hp })),
      cubes: items(this.cubes, 0.5, (c) => ({ id: c.id, pos: [c.x, c.y, c.z] })),
      pickups: items(this.pickups, 0.5, (p) => ({ id: p.id, kind: p.kind, pos: [p.x, p.y, p.z] })),
      sounds,
      beams: m.beams,
      events: m.events,
      drops: this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [d.x, d.y, d.z], radius: this.cfg.drops.radius, lands_in: R2(Math.max(0, d.landT - this.t)), capture_s: this.cfg.drops.capture_s, progress: R2(d.progress), holder: d.holder })),
      zone: { center: [R2(zn.cx), R2(zn.cy)], radius: R2(zn.r), next_center: [R2(this.zone.nx), R2(this.zone.ny)], next_radius: this.zone.nr, shrink_start: this.zone.s0, shrink_end: this.zone.s1, dps: this.zone.dps },
      offer,
    }
    m.events = []
    m.beams = []
    return obs
  }

  gauss(): number {
    let u = 0, v = 0
    while (u === 0) u = this.R()
    while (v === 0) v = this.R()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
  }

  // ------------------------------------------------------------------ actions
  applyAction(m: Mech, a: any) {
    const coast = this.cfg.bot.coast_s
    if (!a || typeof a !== "object") {
      m.fire = [false, false]
      if (this.t - m.lastAnswerT > coast) { m.move = [0, 0]; m.boost = false }
      return
    }
    m.lastAnswerT = this.t
    let mv = Array.isArray(a.move) ? [Number(a.move[0]) || 0, Number(a.move[1]) || 0] : [0, 0]
    const l = Math.hypot(mv[0], mv[1])
    if (l > 1) mv = [mv[0] / l, mv[1] / l]
    m.move = [mv[0], mv[1]]
    m.boost = !!a.boost
    if (Array.isArray(a.aim)) {
      const { s } = this.stats(m)
      m.cmdYaw = Number(a.aim[0]) || 0
      m.cmdPitch = Math.max(s.min_pitch, Math.min(s.max_pitch, Number(a.aim[1]) || 0))
    }
    m.fire = Array.isArray(a.fire) ? [!!a.fire[0], !!a.fire[1]] : [false, false]
    if (a.jump && m.grounded) { m.vz = this.stats(m).s.jump_speed; m.grounded = false }
    if (a.reload) { const g = m.weapons.find((w) => w && w.kind === "gun"); if (g && g.reload <= 0 && g.ammo < this.stats(m).ws.gun.mag) { g.reload = this.stats(m).ws.gun.reload; this.sound("reload", m.x, m.y, m.id) } }
    if (typeof a.pick === "number" && m.offers.length) {
      const o = m.offers[0]
      const ch = o.choices[a.pick | 0]
      if (ch) { m.offers.shift(); m.upgrades.push(ch.id); m.events.push({ type: "upgrade", id: ch.id }); this.afterUpgrade(m); if (this.track.has(m.id)) this.record(m.id, { e: "upgrade", id: ch.id, offered: o.choices.map((c: any) => c.id) }) }
    }
    if (typeof a.take === "number") this.tryTake(m, a.take, typeof a.drop === "number" ? a.drop : -1)
    else if (typeof a.drop === "number") {
      const slot = a.drop | 0
      const w = m.weapons[slot]
      if (w && !(w.kind === "laser" && w.charging)) { const p = this.addPickup(w.kind, m.x, m.y, m.z); (p as any).state = w; m.weapons[slot] = null; m.events.push({ type: "dropped", id: p.id, kind: w.kind, slot }) }
    }
  }

  afterUpgrade(m: Mech) {
    const { s } = this.stats(m)
    if (m.hp > s.hp) m.hp = s.hp
  }

  tryTake(m: Mech, id: number, dropSlot: number) {
    const p = this.pickups.find((q) => q.id === id)
    if (!p) { m.events.push({ type: "take_failed", id, reason: "gone" }); return }
    if (Math.hypot(p.x - m.x, p.y - m.y) > this.cfg.loot.pickup_radius || Math.abs(p.z - m.z) > 4) { m.events.push({ type: "take_failed", id, reason: "range" }); return }
    if (m.weapons.some((w) => w && w.kind === p.kind)) { m.events.push({ type: "take_failed", id, reason: "have" }); return }
    let slot = m.weapons.findIndex((w) => !w)
    if (slot < 0) {
      if (dropSlot < 0 || dropSlot > 1) { m.events.push({ type: "take_failed", id, reason: "full" }); return }
      const old = m.weapons[dropSlot]!
      if (old.kind === "laser" && old.charging) { m.events.push({ type: "take_failed", id, reason: "busy" }); return }
      const q = this.addPickup(old.kind, m.x, m.y, m.z); (q as any).state = old
      m.events.push({ type: "dropped", id: q.id, kind: old.kind, slot: dropSlot })
      slot = dropSlot
    }
    this.pickups.splice(this.pickups.indexOf(p), 1)
    const w: Weapon = (p as any).state ?? this.newWeapon(p.kind)
    w.charging = false; w.charge = 0
    const st = this.stats(m).ws[p.kind]
    w.cooldown = Math.max(w.cooldown, this.cfg.loot.equip_s, st.cooldown)
    m.weapons[slot] = w
    m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
    if (this.track.has(m.id)) this.record(m.id, { e: "took", kind: p.kind, slot })
  }

  // ------------------------------------------------------------------ weapons
  muzzle(m: Mech, s: any, h: number): number[] {
    const cy = Math.cos(m.yaw), sy = Math.sin(m.yaw), cp = Math.cos(m.pitch), sp = Math.sin(m.pitch)
    const off = s.radius + 0.5
    const ox = m.x, oy = m.y, oz = m.z + h
    const dx = cp * cy, dy = cp * sy, dz = sp
    let t = this.w.raycast(ox, oy, oz, ox + dx * off, oy + dy * off, oz + dz * off, false)
    t = Math.max(0, t * off - 0.05)
    return [ox + dx * t, oy + dy * t, oz + dz * t, dx, dy, dz]
  }

  fireWeapons(m: Mech, dt: number) {
    const { s, ws } = this.stats(m)
    for (let slot = 0; slot < 2; slot++) {
      const w = m.weapons[slot]
      if (!w) continue
      const st = ws[w.kind]
      w.cooldown -= dt
      if (w.kind === "gun") {
        if (w.reload > 0) { w.reload -= dt; if (w.reload <= 0) { w.reload = 0; w.ammo = st.mag } }
        if (m.fire[slot] && w.cooldown <= 0 && w.reload <= 0 && w.ammo > 0) {
          const [x, y, z, dx, dy, dz] = this.muzzle(m, s, s.muzzle_height)
          const sp = (st.spread_deg * Math.PI) / 180
          const ya = Math.atan2(dy, dx) + this.gauss() * sp, pa = Math.asin(Math.max(-1, Math.min(1, dz))) + this.gauss() * sp
          this.projs.push({ id: this.nextId.proj++, kind: "gun", owner: m.id, x, y, z, vx: Math.cos(pa) * Math.cos(ya) * st.speed, vy: Math.cos(pa) * Math.sin(ya) * st.speed, vz: Math.sin(pa) * st.speed, ttl: st.range / st.speed, dmgScale: s.dmgScale * st.damage })
          w.cooldown += st.cooldown
          if (w.cooldown < 0) w.cooldown = 0
          w.ammo--
          m.shots++
          m.wst.gun.shots++
          if (w.ammo <= 0) w.reload = st.reload
          this.sound("gun", m.x, m.y, m.id)
        }
        if (w.cooldown < 0) w.cooldown = 0
      } else if (w.kind === "mortar") {
        if (m.fire[slot] && w.cooldown <= 0) {
          const [x, y, z, dx, dy, dz] = this.muzzle(m, s, s.height + 0.5)
          this.projs.push({ id: this.nextId.proj++, kind: "mortar", owner: m.id, x, y, z, vx: dx * st.speed, vy: dy * st.speed, vz: dz * st.speed, ttl: st.ttl, dmgScale: s.dmgScale })
          m.wst.mortar.shots++
          w.cooldown = st.cooldown
          this.sound("mortar", m.x, m.y, m.id)
        }
        if (w.cooldown < 0) w.cooldown = 0
      } else if (w.kind === "laser") {
        if (w.cooldown < 0) w.cooldown = 0
        const canCharge = w.cooldown <= 0 && this.t >= m.shortUntil
        if (w.charging) {
          w.charge = Math.min(st.charge, w.charge + dt)
          if (w.charge >= st.charge) w.full += dt
          const release = !m.fire[slot] && w.charge >= st.min_charge
          if (release || w.full >= st.hold_s) this.fireLaser(m, w, s, st)
        } else if (m.fire[slot] && canCharge) {
          w.charging = true; w.charge = 0; w.full = 0
          this.sound("laser_charge", m.x, m.y, m.id)
        }
      } else if (w.kind === "lightning") {
        if (m.fire[slot] && w.cooldown <= 0 && m.energy >= st.energy) {
          m.energy -= st.energy; m.lastSpend = this.t
          w.cooldown = st.cooldown
          m.wst.lightning.shots++
          this.fireLightning(m, s, st)
        }
        if (w.cooldown < 0) w.cooldown = 0
      }
    }
  }

  fireLaser(m: Mech, w: Weapon, s: any, st: any) {
    const frac = st.min_frac + (1 - st.min_frac) * Math.min(1, w.charge / st.charge)
    w.charging = false; w.charge = 0; w.full = 0
    w.cooldown = st.cooldown
    const [x, y, z, dx, dy, dz] = this.muzzle(m, s, s.muzzle_height)
    const L = st.range
    const tw = this.w.raycast(x, y, z, x + dx * L, y + dy * L, z + dz * L, false)
    const hits = this.segmentTargets(m.id, x, y, z, dx * L, dy * L, dz * L, tw)
    let pierce = st.pierce
    let endT = tw
    m.lasers++
    m.wst.laser.shots++
    if (hits.some((h) => h.kind === "mech")) { m.laserHits++; m.wst.laser.hits++ }
    for (const h of hits) {
      let dmg = st.damage * frac * s.dmgScale
      if (h.kind === "mech") {
        const tg = this.mechs[h.id]
        let eff: string | undefined
        if (tg.weapons.some((q) => q && q.kind === "mortar")) { dmg *= 1 + st.cookoff; eff = "cookoff"; tg.events.push({ type: "effect", effect: "cookoff", by: m.id }) }
        this.damage(tg, dmg, "laser", m.id, x, y, eff)
      } else this.damageThing(h, dmg, m)
      endT = h.t
      if (pierce-- <= 0) break
    }
    const path = [[x, y, z], [x + dx * L * endT, y + dy * L * endT, z + dz * L * endT]]
    this.beam(m.id, "laser", path)
    this.sound("laser", m.x, m.y, m.id)
  }

  fireLightning(m: Mech, s: any, st: any) {
    const ex = m.x, ey = m.y, ez = m.z + s.muzzle_height
    const half = (st.cone_deg * Math.PI) / 180 / 2
    const cands = this.allTargets(m.id)
    let best: any = null, bd = Infinity
    for (const c of cands) {
      const d = Math.hypot(c.x - ex, c.y - ey, c.z + c.h * 0.5 - ez)
      if (d > st.range || d >= bd) continue
      if (Math.abs(wrap(Math.atan2(c.y - ey, c.x - ex) - m.yaw)) > half) continue
      if (!this.w.shotClear(ex, ey, ez, c.x, c.y, c.z + c.h * 0.5)) continue
      best = c; bd = d
    }
    const path: number[][] = [[ex, ey, ez]]
    if (!best) {
      const L = st.range
      const dx = Math.cos(m.yaw) * Math.cos(m.pitch), dy = Math.sin(m.yaw) * Math.cos(m.pitch), dz = Math.sin(m.pitch)
      const t = this.w.raycast(ex, ey, ez, ex + dx * L, ey + dy * L, ez + dz * L, false)
      path.push([ex + dx * L * t, ey + dy * L * t, ez + dz * L * t])
    } else {
      const hit = new Set<string>()
      let cur = best, dmg = st.damage * s.dmgScale
      let px = ex, py = ey
      for (let j = 0; j <= st.chain && cur; j++) {
        hit.add(cur.kind + cur.id)
        path.push([cur.x, cur.y, cur.z + cur.h * 0.5])
        if (cur.kind === "mech") {
          const tg = this.mechs[cur.id]
          let eff: string | undefined
          if (tg.weapons.some((q) => q && q.kind === "laser")) {
            const lw = tg.weapons.find((q) => q && q.kind === "laser")!
            lw.charging = false; lw.charge = 0; lw.full = 0
            tg.shortUntil = this.t + st.short_s
            eff = "short"
            tg.events.push({ type: "effect", effect: "short", by: m.id })
          }
          if (j === 0) m.wst.lightning.hits++
          this.damage(tg, dmg, "lightning", m.id, px, py, eff)
        } else this.damageThing(cur, dmg, m)
        px = cur.x; py = cur.y
        dmg *= st.chain_falloff
        let nb: any = null, nd = Infinity
        for (const c of cands) {
          if (hit.has(c.kind + c.id)) continue
          const d = Math.hypot(c.x - cur.x, c.y - cur.y, c.z - cur.z)
          if (d <= st.chain_range && d < nd) { nb = c; nd = d }
        }
        cur = nb
      }
    }
    this.beam(m.id, "lightning", path)
    this.sound("lightning", m.x, m.y, m.id)
  }

  beam(by: number, kind: string, path: number[][]) {
    for (const o of this.mechs) {
      if (!o.alive || o.id === by) continue
      const { s } = this.stats(o)
      const nearR = this.cfg.vision.near_range + s.near_range_bonus, farR = this.cfg.vision.range + s.vision_bonus
      let vis = false
      for (const p of [path[0], path[path.length - 1], [(path[0][0] + path[path.length - 1][0]) / 2, (path[0][1] + path[path.length - 1][1]) / 2, (path[0][2] + path[path.length - 1][2]) / 2]]) {
        if (this.canSee(o, s.eye_height, p[0], p[1], p[2], 0, nearR, farR)) { vis = true; break }
      }
      if (vis) o.beams.push({ by, kind, path: path.map((p) => p.map((v) => Math.round(v * 100) / 100)), age: 0.1 })
    }
  }

  allTargets(exclude: number): any[] {
    const out: any[] = []
    for (const o of this.mechs) if (o.alive && o.id !== exclude) { const s = this.stats(o).s; out.push({ kind: "mech", id: o.id, x: o.x, y: o.y, z: o.z, r: s.radius, h: s.height }) }
    for (const n of this.npcs) if (n.alive) out.push({ kind: "npc", id: n.id, x: n.x, y: n.y, z: n.z, r: this.cfg.npc.radius, h: this.cfg.npc.height, ref: n })
    for (const c of this.crates) out.push({ kind: "crate", id: c.id, x: c.x, y: c.y, z: c.z, r: this.cfg.crates.radius, h: this.cfg.crates.height, ref: c })
    return out
  }

  // targets crossed by segment (origin o, delta d) before tmax, sorted by t
  segmentTargets(exclude: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, pad = 0): any[] {
    const out: any[] = []
    for (const c of this.allTargets(exclude)) {
      const t = segCyl(ox, oy, oz, dx, dy, dz, c.x, c.y, c.z, c.r + pad, c.h)
      if (t >= 0 && t <= tmax) { c.t = t; out.push(c) }
    }
    out.sort((a, b) => a.t - b.t)
    return out
  }

  damageThing(c: any, dmg: number, by: Mech | null) {
    if (c.kind === "npc") {
      const n = c.ref
      if (!n.alive) return
      n.hp -= dmg
      if (by) { n.target = by.id; n.aggroT = this.t; by.events.push({ type: "hit", target: n.id, amount: dmg, weapon: "x" }); by.lastCombat = this.t }
      if (n.hp <= 0) {
        n.alive = false
        for (let i = 0; i < this.cfg.npc.cubes; i++) this.cubes.push({ id: this.nextId.cube++, x: n.x + (this.R() - 0.5) * 3, y: n.y + (this.R() - 0.5) * 3, z: n.z, src: "npc" })
      }
    } else if (c.kind === "crate") {
      const cr = c.ref
      if (cr.hp <= 0) return
      cr.hp -= dmg
      if (by) by.events.push({ type: "hit", target: cr.id, amount: dmg, weapon: "x" })
      if (cr.hp <= 0) {
        this.crates.splice(this.crates.indexOf(cr), 1)
        this.sound("crate", cr.x, cr.y, -1)
        for (let i = 0; i < this.cfg.crates.cubes; i++) this.cubes.push({ id: this.nextId.cube++, x: cr.x, y: cr.y, z: cr.z, src: "crate" })
        if (this.R() < this.cfg.loot.crate_weapon_chance) this.addPickup(this.randomWeaponKind(), cr.x + 1, cr.y, cr.z)
      }
    }
  }

  stepProjectiles(dt: number) {
    const g = this.cfg.weapons.mortar.gravity
    const keep: Proj[] = []
    for (const p of this.projs) {
      if (p.kind === "mortar") p.vz -= g * dt
      const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt
      const tw = this.w.raycast(p.x, p.y, p.z, p.x + dx, p.y + dy, p.z + dz, false)
      const pad = p.kind === "mortar" ? 0.3 : this.cfg.projectile.gun_radius
      const hits = this.segmentTargets(p.owner, p.x, p.y, p.z, dx, dy, dz, tw, pad)
      // NPC bullets hit mechs only; squad friendly fire is allowed in the real game? assume yes
      const h = hits.find((c) => (p.kind === "npc" ? c.kind === "mech" : true))
      if (h) {
        const hx = p.x + dx * h.t, hy = p.y + dy * h.t, hz = p.z + dz * h.t
        if (p.kind === "mortar") this.explode(p, hx, hy, hz, h)
        else if (h.kind === "mech") { if (p.kind === "gun" && p.owner < 16) { this.mechs[p.owner].hits++; this.mechs[p.owner].wst.gun.hits++ } this.damage(this.mechs[h.id], p.dmgScale, p.kind === "npc" ? "npc" : "gun", p.owner, p.x - p.vx * 0.1, p.y - p.vy * 0.1) }
        else this.damageThing(h, p.dmgScale, p.owner >= 0 && p.owner < 16 ? this.mechs[p.owner] : null)
        continue
      }
      if (tw < 1) {
        if (p.kind === "mortar") this.explode(p, p.x + dx * tw, p.y + dy * tw, p.z + dz * tw, null)
        continue
      }
      p.x += dx; p.y += dy; p.z += dz
      p.ttl -= dt
      if (p.ttl > 0) keep.push(p)
    }
    this.projs = keep
  }

  explode(p: Proj, x: number, y: number, z: number, direct: any) {
    const st = this.stats(this.mechs[p.owner]).ws.mortar
    const R = st.splash_radius
    this.sound("explosion", x, y, -1)
    if (direct && direct.kind === "mech") {
      const tg = this.mechs[direct.id]
      this.mechs[p.owner].wst.mortar.hits++
      let eff: string | undefined
      this.damage(tg, st.damage * p.dmgScale, "mortar", p.owner, x, y)
    } else if (direct) this.damageThing(direct, st.damage * p.dmgScale, this.mechs[p.owner])
    for (const c of this.allTargets(-1)) {
      const cx = c.x, cy = c.y, cz = c.z + c.h * 0.5
      const d = Math.max(0, Math.hypot(cx - x, cy - y, Math.max(0, Math.abs(cz - z) - c.h * 0.5)) - c.r)
      if (d > R) continue
      if (!this.w.shotClear(x, y, z + 0.3, cx, cy, cz)) continue
      const f = 1 - (1 - st.splash_edge) * (d / R)
      let dmg = st.splash * f * p.dmgScale
      if (c.kind === "mech") {
        const tg = this.mechs[c.id]
        if (!tg.alive) continue
        if (c.id === p.owner) dmg *= this.cfg.mech.self_damage_mult
        this.damage(tg, dmg, "mortar", c.id === p.owner ? -1 : p.owner, x, y, "concuss")
        const a = Math.atan2(cy - y, cx - x)
        tg.vx += Math.cos(a) * st.knock * f; tg.vy += Math.sin(a) * st.knock * f; tg.vz = Math.max(tg.vz, st.knock_up * f); tg.grounded = false
        tg.energy = Math.max(0, tg.energy - st.drain * f)
        tg.events.push({ type: "effect", effect: "concuss", by: p.owner })
      } else this.damageThing(c, dmg, this.mechs[p.owner])
    }
  }

  // ------------------------------------------------------------------ NPCs
  stepNpcs(dt: number) {
    const nc = this.cfg.npc
    for (const n of this.npcs) {
      if (!n.alive) continue
      n.cd -= dt
      let tgt: Mech | null = null
      if (n.target >= 0) {
        const m = this.mechs[n.target]
        if (!m.alive || Math.hypot(m.x - n.x, m.y - n.y) > nc.deaggro_range || Math.hypot(n.x - n.hx, n.y - n.hy) > nc.chase_leash) n.target = -1
        else tgt = m
      }
      if (!tgt && Math.hypot(n.x - n.hx, n.y - n.hy) <= nc.leash) {
        let bd = nc.aggro_range
        for (const m of this.mechs) {
          if (!m.alive) continue
          const d = Math.hypot(m.x - n.x, m.y - n.y)
          if (d < bd && this.w.sees(n.x, n.y, n.z + nc.height, m.x, m.y, m.z + 4.5, false)) { bd = d; tgt = m }
        }
      }
      let mx = 0, my = 0
      if (tgt) {
        n.yaw = Math.atan2(tgt.y - n.y, tgt.x - n.x)
        if (n.target === tgt.id && Math.hypot(tgt.x - n.x, tgt.y - n.y) > 30) { mx = Math.cos(n.yaw); my = Math.sin(n.yaw) }
        if (n.cd <= 0 && this.w.shotClear(n.x, n.y, n.z + nc.height * 0.7, tgt.x, tgt.y, tgt.z + 4.5)) {
          n.cd = nc.cooldown
          const ox = n.x, oy = n.y, oz = n.z + nc.height * 0.7
          const dx = tgt.x - ox, dy = tgt.y - oy, dz = tgt.z + 4.5 - oz
          const d = Math.hypot(dx, dy, dz)
          const tf = d / nc.projectile_speed
          const px = tgt.x + tgt.vx * tf * 0.5, py = tgt.y + tgt.vy * tf * 0.5
          const sp = (nc.spread_deg * Math.PI) / 180
          const ya = Math.atan2(py - oy, px - ox) + this.gauss() * sp, pa = Math.atan2(dz, Math.hypot(px - ox, py - oy)) + this.gauss() * sp
          this.projs.push({ id: this.nextId.proj++, kind: "npc", owner: n.id, x: ox + Math.cos(ya) * 2, y: oy + Math.sin(ya) * 2, z: oz, vx: Math.cos(pa) * Math.cos(ya) * nc.projectile_speed, vy: Math.cos(pa) * Math.sin(ya) * nc.projectile_speed, vz: Math.sin(pa) * nc.projectile_speed, ttl: 1.5, dmgScale: nc.damage })
          this.sound("npc_gun", n.x, n.y, -1)
        }
      } else {
        if (Math.hypot(n.wx - n.x, n.wy - n.y) < 2 || this.R() < 0.005) { const a = this.R() * TAU, r = this.R() * nc.leash; n.wx = n.hx + Math.cos(a) * r; n.wy = n.hy + Math.sin(a) * r }
        const a = Math.atan2(n.wy - n.y, n.wx - n.x)
        mx = Math.cos(a) * 0.6; my = Math.sin(a) * 0.6
      }
      n.vx = mx * nc.speed; n.vy = my * nc.speed
      const nxp = n.x + n.vx * dt, nyp = n.y + n.vy * dt
      const c = this.nav.cellAt(nxp, nyp)
      if (c >= 0 && this.nav.cellClear[c] > nc.radius + 0.3) { n.x = nxp; n.y = nyp; n.z = this.w.surfaceHeight(n.x, n.y, this.w.groundHeight(n.x, n.y) + 1.2) }
    }
  }

  // ------------------------------------------------------------------ main step
  step(): boolean {
    const dt = 1 / this.cfg.match.tick_hz
    if (this.tick % this.cfg.match.decide_every === 0) {
      const alive = this.mechs.filter((m) => m.alive)
      const obsList = alive.map((m) => [m, this.buildObs(m)] as [Mech, any])
      for (const [m, o] of obsList) {
        let a: any = null
        try { a = m.ctrl.act(o) } catch (e) { if (this.verbose) this.log("ctrl error " + e); a = null }
        if (a && a.tick !== o.tick) a = null
        this.applyAction(m, a)
      }
    }
    // offers timeout
    for (const m of this.mechs) {
      if (!m.alive || !m.offers.length) continue
      if (this.t >= m.offers[0].expires) { const ch = m.offers.shift().choices[0]; m.upgrades.push(ch.id); m.events.push({ type: "upgrade", id: ch.id }); this.afterUpgrade(m); if (this.track.has(m.id)) this.record(m.id, { e: "upgrade", id: ch.id, timeout: true }) }
    }
    for (const m of this.mechs) if (m.alive) this.stepMech(m, dt)
    for (const m of this.mechs) if (m.alive) this.fireWeapons(m, dt)
    this.stepProjectiles(dt)
    this.stepNpcs(dt)
    // zone damage, regen, energy
    const zn = this.zoneNow()
    for (const m of this.mechs) {
      if (!m.alive) continue
      const { s } = this.stats(m)
      const inZone = Math.hypot(m.x - zn.cx, m.y - zn.cy) <= zn.r
      if (!inZone) this.damage(m, this.zone.dps * dt, "zone", -1, m.x, m.y)
      else if (this.t - m.lastCombat >= s.regen_delay && m.hp < s.hp) m.hp = Math.min(s.hp, m.hp + s.regen_per_s * dt)
      if (this.t - m.lastSpend >= s.energy_regen_delay) m.energy = Math.min(s.energy, m.energy + s.energy_regen * dt)
    }
    this.stepPickups()
    this.stepDrops(dt)
    // placements for deaths this tick
    const dying = this.mechs.filter((m) => (m as any).pendingPlace)
    if (dying.length) {
      for (const m of dying) { m.place = this.aliveCount; (m as any).pendingPlace = false; m.ctrl.end?.({ type: "end", place: m.place, kills: m.kills }) }
      this.aliveCount -= dying.length
    }
    if (this.track.size && this.tick % this.cfg.match.tick_hz === 0) {
      for (const id of this.track) {
        const m = this.mechs[id]
        if (!m.alive) continue
        const { s } = this.stats(m)
        // who can see us right now (any living squad mech), and how many could shoot (line of fire within 230 m)
        let seenBy = 0
        for (const o of this.mechs) {
          if (!o.alive || o === m || !o.ctrl.squad) continue
          if (o.seen.get(m.id) === this.t) seenBy++
        }
        const inZ = Math.hypot(m.x - zn.cx, m.y - zn.cy) <= zn.r
        this.record(id, { e: "s", hp: Math.round(m.hp), max: Math.round(s.hp), cubes: m.cubes, ups: m.upgrades.length, w: m.weapons.map((w) => w ? w.kind[0] : "-").join(""), regen: inZ && this.t - m.lastCombat >= s.regen_delay ? 1 : 0, seenBy, alive: this.aliveCount, pos: [Math.round(m.x), Math.round(m.y)] })
      }
    }
    this.onTick?.(this)
    this.tick++
    this.t = this.tick * dt
    this.updateZone()
    if (this.stopWhenTrackedDead && this.track.size && [...this.track].every((id) => !this.mechs[id].alive)) return false
    if (this.aliveCount <= 1 || this.t >= this.cfg.match.duration_s) {
      const surv = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
      surv.forEach((m, i) => { m.place = i + 1; m.ctrl.end?.({ type: "end", place: m.place, kills: m.kills }) })
      return false
    }
    return true
  }

  stepMech(m: Mech, dt: number) {
    const { s } = this.stats(m)
    // aim slew
    const dyaw = wrap(m.cmdYaw - m.yaw)
    const maxY = s.turn_rate * dt
    m.yaw = wrap(m.yaw + Math.max(-maxY, Math.min(maxY, dyaw)))
    const dp = m.cmdPitch - m.pitch
    const maxP = s.pitch_rate * dt
    m.pitch += Math.max(-maxP, Math.min(maxP, dp))
    const charging = m.weapons.some((w) => w && w.kind === "laser" && w.charging)
    const moving = Math.hypot(m.move[0], m.move[1]) > 0.05
    let speed = s.walk_speed
    let spent = false
    if (m.boost && m.grounded && moving && m.energy > 0) { speed = s.boost_speed; m.energy = Math.max(0, m.energy - s.boost_drain * dt); spent = true }
    if (charging) speed *= s.charge_move_mult
    const tvx = m.move[0] * speed, tvy = m.move[1] * speed
    const acc = (m.grounded ? s.ground_accel : s.air_accel) * dt
    let dvx = tvx - m.vx, dvy = tvy - m.vy
    const dl = Math.hypot(dvx, dvy)
    if (dl > acc) { dvx *= acc / dl; dvy *= acc / dl }
    m.vx += dvx; m.vy += dvy
    if (!m.grounded) {
      if (m.boost && m.energy > 0) { m.vz = Math.min(s.max_rise_speed, m.vz + s.jet_accel * dt); m.energy = Math.max(0, m.energy - s.jet_drain * dt); spent = true; if (this.tick % 10 === 0) this.sound("jet", m.x, m.y, m.id) }
      m.vz -= s.gravity * dt
    }
    if (spent) m.lastSpend = this.t
    const r = moveAndSlide(this.w, { x: m.x, y: m.y, z: m.z, radius: s.radius, height: s.height }, m.vx * dt, m.vy * dt, m.vz * dt, s.step_up, Math.tan((s.max_slope_deg * Math.PI) / 180))
    const ax = (r.x - m.x) / dt, ay = (r.y - m.y) / dt
    // wall slide: keep the along-wall part of velocity
    if (r.hitWall) { m.vx = ax; m.vy = ay }
    m.x = r.x; m.y = r.y; m.z = r.z
    if (r.grounded) { if (m.vz < 0) m.vz = 0; m.grounded = m.vz <= 0.001 } else m.grounded = false
    if (r.stoppedZ && m.vz > 0) m.vz = 0
    // mech-mech push apart
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      const d = Math.hypot(o.x - m.x, o.y - m.y)
      const mind = s.radius * 2
      if (d < mind && d > 1e-3 && Math.abs(o.z - m.z) < 9) { const push = (mind - d) / 2; m.x -= ((o.x - m.x) / d) * push; m.y -= ((o.y - m.y) / d) * push }
    }
    // steps
    const hs = Math.hypot(m.vx, m.vy)
    if (m.grounded && hs > this.cfg.sound.step_speed) {
      m.stepAcc += dt
      if (m.stepAcc >= this.cfg.sound.step_every) { m.stepAcc = 0; this.sound(m.boost && spent ? "boost" : "step", m.x, m.y, m.id) }
    }
  }

  stepPickups() {
    const cc = this.cfg.cubes
    const keep: any[] = []
    for (const c of this.cubes) {
      let best: Mech | null = null, bd = Infinity
      for (const m of this.mechs) {
        if (!m.alive) continue
        const d = Math.hypot(m.x - c.x, m.y - c.y)
        if (d <= cc.pickup_radius && Math.abs(m.z - c.z) <= 4 && d < bd) { best = m; bd = d }
      }
      if (!best) { keep.push(c); continue }
      this.giveCubes(best, 1)
      best.events.push({ type: "pickup", cubes: best.cubes })
      if (this.track.has(best.id)) this.record(best.id, { e: "cube", cubes: best.cubes, src: c.src ?? "?" })
    }
    this.cubes = keep
  }

  giveCubes(m: Mech, n: number) {
    for (let i = 0; i < n; i++) {
      const before = this.stats(m).s.hp
      m.cubes++
      const after = this.stats(m).s.hp
      m.hp += after - before
      const th = this.cfg.cubes.upgrade_thresholds
      if (th.includes(m.cubes)) this.makeOffer(m)
    }
  }

  makeOffer(m: Mech) {
    const counts: any = {}
    for (const u of m.upgrades) counts[u] = (counts[u] ?? 0) + 1
    const held = m.weapons.filter((w) => w).map((w) => w!.kind)
    const avail = this.cfg.upgrades.filter((u: any) => (counts[u.id] ?? 0) < u.max && (!u.requires || held.includes(u.requires)))
    const choices: any[] = []
    while (choices.length < 3 && avail.length) {
      const i = Math.floor(this.R() * avail.length)
      const u = avail.splice(i, 1)[0]
      choices.push({ id: u.id, name: u.name, desc: u.desc })
    }
    if (choices.length) m.offers.push({ id: m.offerSeq++, expires: Math.round((this.t + this.cfg.bot.offer_timeout_s) * 100) / 100, choices })
  }

  stepDrops(dt: number) {
    const dc = this.cfg.drops
    if (!dc) return
    for (const tcall of dc.times) {
      if (Math.abs(this.t - tcall) < dt / 2 && !this.drops.some((d) => d.callT === tcall)) {
        const p = this.randomOpen(this.zone.nr * dc.spread, 3, this.zone.nx, this.zone.ny)
        this.drops.push({ id: this.nextId.drop++, x: p[0], y: p[1], z: this.w.groundHeight(p[0], p[1]), callT: tcall, landT: tcall + dc.fall_s, progress: 0, holder: null, taken: false })
      }
    }
    for (const d of this.drops) {
      if (d.taken || this.t < d.landT) continue
      if (!d.landed) { d.landed = true; this.sound("drop", d.x, d.y, -1) }
      const inside = this.mechs.filter((m) => m.alive && Math.hypot(m.x - d.x, m.y - d.y) <= dc.radius)
      if (inside.length === 1) {
        if (d.holder !== inside[0].id) { d.holder = inside[0].id; d.progress = 0 }
        d.progress += dt
        if (d.progress >= dc.capture_s) {
          const m = inside[0]
          d.taken = true
          this.giveCubes(m, dc.cubes)
          const { s } = this.stats(m)
          m.hp = s.hp; m.energy = s.energy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
          if (this.track.has(m.id)) this.record(m.id, { e: "supply", cubes: m.cubes })
        }
      } else if (inside.length === 0) { d.holder = null; d.progress = 0 }
    }
  }

  run(): MatchResult {
    while (this.step()) {}
    return {
      places: this.mechs.map((m) => m.place), kills: this.mechs.map((m) => m.kills), deathT: this.mechs.map((m) => m.deathT),
      dmgDealt: this.mechs.map((m) => Math.round(m.dmgDealt)), dmgTaken: this.mechs.map((m) => Math.round(m.dmgTaken)), t: this.t, lateTicks: 0,
      acc: this.mechs.map((m) => `${m.hits}/${m.shots} L${m.laserHits}/${m.lasers} zoneDmg ${Math.round((m as any).zoneDmg ?? 0)}`),
    }
  }
}

// segment (o + t d, t in [0,1]) vs vertical cylinder at (cx,cy) radius r from z0 to z0+h. returns t or -1
export function segCyl(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, z0: number, r: number, h: number): number {
  const fx = ox - cx, fy = oy - cy
  const a = dx * dx + dy * dy
  let t0 = 0, t1 = 1
  if (a < 1e-12) {
    if (fx * fx + fy * fy > r * r) return -1
  } else {
    const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r
    const disc = b * b - 4 * a * c
    if (disc < 0) return -1
    const q = Math.sqrt(disc)
    t0 = Math.max(t0, (-b - q) / (2 * a)); t1 = Math.min(t1, (-b + q) / (2 * a))
    if (t0 > t1) return -1
  }
  if (Math.abs(dz) < 1e-12) { if (oz < z0 || oz > z0 + h) return -1 } else {
    let za = (z0 - oz) / dz, zb = (z0 + h - oz) / dz
    if (za > zb) { const s = za; za = zb; zb = s }
    t0 = Math.max(t0, za); t1 = Math.min(t1, zb)
    if (t0 > t1) return -1
  }
  return t0
}
