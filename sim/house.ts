// Approximate house bots (a guess, calibrated against real practice scores; see sim/CALIBRATION.md).
// Track page facts: 4 easy, 4 medium, 4 hard, 3 expert; one squad; shared vision; never fight each other;
// "hunt you weakest first (one early, more as you thin them out, all of them late)".
// Model: the squad orders its living members weakest tier first and assigns the first H of them as hunters,
// H = min(alive, HUNT_BASE + HUNT_PER_KILL * deadMembers), and every member hunts after HUNT_ALL_T seconds.
// Hunters path to the enemy (shared vision; with HOUSE_OMNI=1 they always know where it is) and fight it.
// Idle members hold inside the zone, loot, and fight only an enemy that comes within IDLE_R or shot them.
import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { rng, type Controller } from "./engine.ts"

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const env = (k: string, d: number) => { const v = process.env[k]; return v === undefined || v === "" ? d : Number(v) }

export type Skill = { name: string; rank: number; aimDeg: number; lead: number; react: number; range: number; strafe: number; loot: boolean; laserTol: number; fireTol: number }
// aimDeg: Gaussian aim error (resampled every 0.3 s); lead: fraction of target velocity led; react: seconds
// from first sight to first shot; strafe: lateral strafe weight (0 = walk straight at you); laserTol: release
// tolerance (rad) for a charged laser; fireTol: gun fires when the torso is within this of the wanted aim (rad)
const BASE: Record<string, Skill> = {
  easy: { name: "easy", rank: 0, aimDeg: 3.0, lead: 0.0, react: 0.9, range: 120, strafe: 0, loot: false, laserTol: 0.04, fireTol: 0.06 },
  medium: { name: "medium", rank: 1, aimDeg: 2.0, lead: 0.5, react: 0.6, range: 150, strafe: 0.6, loot: true, laserTol: 0.03, fireTol: 0.05 },
  hard: { name: "hard", rank: 2, aimDeg: 1.3, lead: 0.85, react: 0.4, range: 180, strafe: 0.9, loot: true, laserTol: 0.02, fireTol: 0.04 },
  expert: { name: "expert", rank: 3, aimDeg: 0.8, lead: 1.0, react: 0.25, range: 200, strafe: 1.0, loot: true, laserTol: 0.015, fireTol: 0.03 },
}
// calibration knobs (env): per-tier aim multipliers and global ones
export const HP = {
  // defaults = calibrated model M1 (sim/CALIBRATION.md)
  aimEasy: env("H_AIM_EASY", 2.2), aimMed: env("H_AIM_MED", 1), aimHard: env("H_AIM_HARD", 1), aimExp: env("H_AIM_EXP", 1),
  aimAll: env("H_AIM", 1), react: env("H_REACT", 1),
  base: env("HUNT_BASE", 1), perKill: env("HUNT_PER_KILL", 2), perMin: env("HUNT_PER_MIN", 0), allT: env("HUNT_ALL_T", 300),
  omni: env("HOUSE_OMNI", 1), idleR: env("IDLE_R", 0), retaliate: env("IDLE_RETALIATE", 0),
  easyLoot: env("H_EASY_LOOT", 0),
  // H_MOVE=1: movement like the enemy in the recorded real stream (check/stream.jsonl.gz): strafes at
  // walk/boost speed across the line of fire, reverses every 0.4-1.4 s, closes in slowly (about +2 m/s)
  move: env("H_MOVE", 0), moveEasy: env("H_MOVE_EASY", 0.7), moveBoost: env("H_MOVE_BOOST", 0.35),
}
export const SKILLS: Record<string, Skill> = {}
for (const k of Object.keys(BASE)) {
  const m = k === "easy" ? HP.aimEasy : k === "medium" ? HP.aimMed : k === "hard" ? HP.aimHard : HP.aimExp
  SKILLS[k] = { ...BASE[k], aimDeg: BASE[k].aimDeg * m * HP.aimAll, react: BASE[k].react * HP.react, loot: k === "easy" ? !!HP.easyLoot : BASE[k].loot }
}

export class Squad {
  members = new Map<number, { rank: number; lastAct: number; name: string }>()
  known = new Map<number, any>() // enemy id -> {pos, vel, t, hp, ...}
  hitBy = new Map<number, number>() // member id -> last time an enemy damaged it
  noises: any[] = []
  oracle: (() => { id: number; pos: number[]; vel: number[] }[]) | null = null
  t = -1
  hunters = new Set<number>()
  dead = 0
  register(id: number, sk: Skill) { this.members.set(id, { rank: sk.rank, lastAct: 0, name: sk.name }) }
  isMember(id: number) { return this.members.has(id) }
  update(t: number) {
    if (t === this.t) return
    this.t = t
    const alive = [...this.members.entries()].filter(([, m]) => m.lastAct >= t - 0.16).map(([id, m]) => ({ id, rank: m.rank }))
    this.dead = this.members.size - alive.length
    alive.sort((a, b) => a.rank - b.rank || a.id - b.id)
    let H = Math.floor(HP.base + HP.perKill * this.dead + HP.perMin * (t / 60))
    if (t >= HP.allT) H = alive.length
    this.hunters = new Set(alive.slice(0, Math.max(0, H)).map((a) => a.id))
  }
  ingest(selfId: number, obs: any) {
    const m = this.members.get(selfId)
    if (m) m.lastAct = obs.t
    this.update(obs.t)
    for (const e of obs.mechs) {
      if (e.kind !== "mech" || this.members.has(e.id)) continue
      this.known.set(e.id, { ...e, t: obs.t, seenBy: selfId })
    }
    for (const ev of obs.events) if (ev.type === "damaged" && typeof ev.by === "number" && ev.by < 16 && !this.members.has(ev.by)) this.hitBy.set(selfId, obs.t)
    for (const s of obs.sounds) if (["gun", "laser", "mortar", "lightning"].includes(s.kind) && s.dist !== "far") this.noises.push({ ...s, from: obs.self.pos.slice(), t: obs.t })
    if (this.noises.length > 30) this.noises.splice(0, this.noises.length - 30)
  }
  // best knowledge of where enemy id is (shared vision, else the oracle when omniscient)
  where(id: number, t: number): any | null {
    const k = this.known.get(id)
    if (k && t - k.t < 1.0) return k
    if (HP.omni && this.oracle) { const o = this.oracle().find((q) => q.id === id); if (o) return { id, pos: o.pos, vel: o.vel, t } }
    if (k && t - k.t < 8) return k
    return null
  }
}

export class HouseBot implements Controller {
  name: string
  squad = true
  sk: Skill
  sq: Squad
  w: World
  nav: Nav
  cfg: any
  id = -1
  R: () => number
  path: number[] | null = null
  pathT = -99
  goal: number[] | null = null
  roam: number[] | null = null
  strafeDir = 1
  strafeT = 0
  seenSince = new Map<number, number>()
  aimErrY = 0
  aimErrP = 0
  aimErrT = -1
  npcAggroT = -99
  direct = false
  stuck = 0
  lastXY = [0, 0]
  jetUntil = -1
  strafeBoost = false
  constructor(w: World, nav: Nav, sq: Squad, skill: Skill, seed: number) {
    this.w = w; this.nav = nav; this.sq = sq; this.sk = skill; this.name = "house-" + skill.name; this.R = rng(seed)
  }
  hello(h: any) { this.id = h.slot; this.cfg = h.config; this.sq.register(h.slot, this.sk) }

  act(o: any): any {
    const me = o.self
    const sq = this.sq
    sq.ingest(me.id, o)
    const [x, y, z] = me.pos
    const a: any = { tick: o.tick }
    if (o.offer) a.pick = Math.floor(this.R() * o.offer.choices.length)
    if (this.sk.loot && !me.weapons[1]) {
      const near = o.pickups.find((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < 3.8 && Math.abs(p.pos[2] - z) < 4)
      if (near) a.take = near.id
    }
    const hunter = sq.hunters.has(me.id)
    // the enemy: nearest known non-squad mech
    let tgt: any = null
    const ids = new Set<number>([...sq.known.keys()])
    if (sq.oracle) for (const q of sq.oracle()) ids.add(q.id)
    for (const id of ids) {
      const e = sq.where(id, o.t)
      if (!e) continue
      if (!tgt || Math.hypot(e.pos[0] - x, e.pos[1] - y) < Math.hypot(tgt.pos[0] - x, tgt.pos[1] - y)) tgt = e
    }
    const visible = tgt ? o.mechs.find((m: any) => m.id === tgt.id) : null
    const dT = tgt ? Math.hypot(tgt.pos[0] - x, tgt.pos[1] - y) : Infinity
    const retaliating = o.t - (sq.hitBy.get(me.id) ?? -99) < HP.retaliate
    const engage = !!visible && (hunter || dT < HP.idleR || retaliating)
    const pursue = !!tgt && (hunter || (retaliating && dT < 150))

    const zn = o.zone
    const dz = Math.hypot(x - zn.next_center[0], y - zn.next_center[1])
    const inNext = dz < zn.next_radius - 10
    const curD = Math.hypot(x - zn.center[0], y - zn.center[1])
    let goal: number[] | null = null
    const hasLaser = me.weapons.some((w: any) => w && w.kind === "laser")
    const hasLightning = me.weapons.some((w: any) => w && w.kind === "lightning")
    const wantRange = hasLightning ? 30 : hasLaser ? 100 : 65
    const mustZone = curD > zn.radius - 15 || (o.t > zn.shrink_start - 15 && !inNext)
    if (pursue && !mustZone) {
      const ez = Math.hypot(tgt.pos[0] - zn.center[0], tgt.pos[1] - zn.center[1])
      if (ez < zn.radius + 20 && (!visible || dT > wantRange)) goal = [tgt.pos[0], tgt.pos[1]]
    }
    if (!goal && !engage) {
      if (mustZone || !this.roam || Math.hypot(this.roam[0] - x, this.roam[1] - y) < 12 || Math.hypot(this.roam[0] - zn.next_center[0], this.roam[1] - zn.next_center[1]) > zn.next_radius) {
        const ang = this.R() * TAU, rr = Math.sqrt(this.R()) * zn.next_radius * 0.8
        this.roam = [zn.next_center[0] + Math.cos(ang) * rr, zn.next_center[1] + Math.sin(ang) * rr]
        if (this.sk.loot && !me.weapons[1] && !mustZone) {
          const p = o.pickups.find((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < 60 && Math.abs(p.pos[2] - z) < 3)
          if (p) this.roam = [p.pos[0], p.pos[1]]
        }
        if (hunter && !mustZone && sq.noises.length) {
          const n = sq.noises[sq.noises.length - 1]
          if (o.t - n.t < 8) { const dd = n.dist === "near" ? 40 : 110; this.roam = [n.from[0] + Math.cos(n.bearing) * dd, n.from[1] + Math.sin(n.bearing) * dd] }
        }
      }
      goal = this.roam
    }
    if (mustZone && !inNext) goal = [zn.next_center[0], zn.next_center[1]]
    let mv = [0, 0]
    if (goal) {
      if (!this.path || o.t - this.pathT > 3 || !this.goal || Math.hypot(goal[0] - this.goal[0], goal[1] - this.goal[1]) > 15) {
        this.path = this.nav.findPath(x, y, goal[0], goal[1], null, mustZone ? 30000 : 8000)
        this.pathT = o.t
        this.goal = goal
      }
      mv = this.follow(x, y)
      // no path (unreachable or search budget exhausted): head straight there, hopping over obstacles
      if (Math.hypot(mv[0], mv[1]) < 0.1 && Math.hypot(goal[0] - x, goal[1] - y) > 6) {
        const d = Math.hypot(goal[0] - x, goal[1] - y)
        mv = [(goal[0] - x) / d, (goal[1] - y) / d]
        this.direct = true
      } else this.direct = false
    }
    // stuck (or going direct into a wall): jump and jet
    const moved = Math.hypot(x - this.lastXY[0], y - this.lastXY[1])
    this.stuck = Math.hypot(mv[0], mv[1]) > 0.5 && moved < 0.3 ? this.stuck + 0.1 : Math.max(0, this.stuck - 0.05)
    this.lastXY = [x, y]
    if (this.stuck > 0.6 || (this.direct && this.w.surfaceHeight(x + mv[0] * 4, y + mv[1] * 4) > z + 1.1)) {
      if (me.grounded) a.jump = true
      else if (me.energy > 5) this.jetUntil = o.t + 0.3
      if (this.stuck > 2.5) { this.path = null; this.stuck = 0 }
    }
    if (engage && HP.move) {
      if (o.t > this.strafeT) {
        this.strafeDir = this.R() < 0.5 ? -1 : 1; this.strafeT = o.t + 0.4 + this.R() * 1.0
        this.strafeBoost = this.sk.rank >= 2 && this.R() < HP.moveBoost
      }
      const w = this.sk.rank === 0 ? HP.moveEasy : this.sk.rank === 1 ? 0.85 : 1
      const ang = Math.atan2(visible.pos[1] - y, visible.pos[0] - x) + (this.strafeDir * Math.PI) / 2
      const radial = dT > wantRange ? 0.25 : dT < wantRange * 0.5 ? -0.4 : 0
      const sx = Math.cos(ang) + radial * Math.cos(ang - (this.strafeDir * Math.PI) / 2)
      const sy = Math.sin(ang) + radial * Math.sin(ang - (this.strafeDir * Math.PI) / 2)
      const l = Math.hypot(sx, sy) || 1
      const cand = [(sx / l) * w, (sy / l) * w]
      if (this.nav.clearanceAt(x + cand[0] * 4, y + cand[1] * 4) > 3) mv = goal && dT > wantRange * 1.6 ? [mv[0] * 0.5 + cand[0] * 0.5, mv[1] * 0.5 + cand[1] * 0.5] : cand
      else { this.strafeDir *= -1; this.strafeT = o.t + 0.4 }
    } else if (engage && this.sk.strafe > 0) {
      if (o.t > this.strafeT) { this.strafeDir = this.R() < 0.5 ? -1 : 1; this.strafeT = o.t + 0.5 + this.R() * 1.2 }
      const ang = Math.atan2(visible.pos[1] - y, visible.pos[0] - x) + (this.strafeDir * Math.PI) / 2
      const radial = dT > wantRange ? 0.6 : dT < wantRange * 0.5 ? -0.5 : 0
      const sx = Math.cos(ang) + radial * Math.cos(ang - (this.strafeDir * Math.PI) / 2)
      const sy = Math.sin(ang) + radial * Math.sin(ang - (this.strafeDir * Math.PI) / 2)
      const l = Math.hypot(sx, sy) || 1
      const cand = [(sx / l) * this.sk.strafe, (sy / l) * this.sk.strafe]
      if (this.nav.clearanceAt(x + cand[0] * 4, y + cand[1] * 4) > 3) mv = goal ? [mv[0] * 0.5 + cand[0] * 0.5, mv[1] * 0.5 + cand[1] * 0.5] : cand
      else this.strafeDir *= -1
    } else if (engage && dT <= wantRange && !mustZone) mv = [0, 0]
    a.move = mv
    a.boost = mustZone && !me.in_zone ? true : !!(goal && pursue && !visible && me.energy > 60)
    if (!me.grounded && o.t < this.jetUntil) a.boost = true
    if (engage && HP.move && this.strafeBoost && me.energy > 30) a.boost = true
    a.fire = [false, false]
    // drones that shoot us (or are close with line of sight) get shot back when we are not fighting the enemy
    if (o.events.some((e: any) => e.type === "damaged" && e.weapon === "npc")) this.npcAggroT = o.t
    let npc: any = null
    if (!engage && o.t - this.npcAggroT < 4) {
      for (const m of o.mechs) if (m.kind === "npc" && (!npc || Math.hypot(m.pos[0] - x, m.pos[1] - y) < Math.hypot(npc.pos[0] - x, npc.pos[1] - y))) npc = m
      if (npc && Math.hypot(npc.pos[0] - x, npc.pos[1] - y) > 90) npc = null
    }
    if (engage) this.shoot(o, a, visible)
    else if (npc) this.shoot(o, a, { ...npc, pos: [npc.pos[0], npc.pos[1], npc.pos[2] - 2.5], cubes: 0 })
    else {
      this.seenSince.clear()
      if (tgt && (pursue || dT < 200)) a.aim = [Math.atan2(tgt.pos[1] - y, tgt.pos[0] - x), 0]
      else if (Math.hypot(mv[0], mv[1]) > 0.1) a.aim = [Math.atan2(mv[1], mv[0]), 0]
      me.weapons.forEach((w: any, i: number) => { if (w && w.kind === "laser") a.fire[i] = false })
    }
    for (const e of o.events) if (e.type === "damaged" && e.bearing !== null && !visible) a.aim = [e.bearing, 0]
    return a
  }

  shoot(o: any, a: any, visible: any) {
    const me = o.self
    const [x, y, z] = me.pos
    if (!this.seenSince.has(visible.id)) this.seenSince.set(visible.id, o.t)
    const since = o.t - (this.seenSince.get(visible.id) ?? o.t)
    const ex = x, ey = y, ez = z + me.stats.muzzle_height
    const sz = 1 + 0.05 * (visible.cubes ?? 0)
    const tx = visible.pos[0], ty = visible.pos[1], tz = visible.pos[2] + 4.5 * sz
    const d = Math.hypot(tx - ex, ty - ey, tz - ez)
    if (o.t > this.aimErrT) {
      const s = (this.sk.aimDeg * Math.PI) / 180
      this.aimErrY = gauss(this.R) * s; this.aimErrP = gauss(this.R) * s * 0.6; this.aimErrT = o.t + 0.3
    }
    let slotGun = -1, slotLaser = -1, slotLight = -1, slotMortar = -1
    me.weapons.forEach((w: any, i: number) => { if (!w) return; if (w.kind === "gun") slotGun = i; if (w.kind === "laser") slotLaser = i; if (w.kind === "lightning") slotLight = i; if (w.kind === "mortar") slotMortar = i })
    const gs = me.weapons[slotGun]?.stats?.speed ?? 252
    const tf = d / gs
    const lx = tx + visible.vel[0] * tf * this.sk.lead, ly = ty + visible.vel[1] * tf * this.sk.lead
    const yaw = Math.atan2(ly - ey, lx - ex) + this.aimErrY
    const pitch = Math.atan2(tz - ez, Math.hypot(lx - ex, ly - ey)) + this.aimErrP
    a.aim = [yaw, pitch]
    const aimOff = Math.abs(wrap(me.aim[0] - yaw))
    // hold fire while a squadmate stands in the line of fire
    let mateInLine = false
    for (const m of o.mechs) {
      if (m.kind !== "mech" || m.id === visible.id || !this.sq.isMember(m.id)) continue
      const vx = tx - ex, vy = ty - ey, L2 = vx * vx + vy * vy
      const u = ((m.pos[0] - ex) * vx + (m.pos[1] - ey) * vy) / Math.max(1e-6, L2)
      if (u <= 0 || u >= 1) continue
      if (Math.hypot(ex + vx * u - m.pos[0], ey + vy * u - m.pos[1]) < 4) { mateInLine = true; break }
    }
    const canShoot = !mateInLine && since >= this.sk.react && this.w.shotClear(ex, ey, ez, tx, ty, tz)
    if (canShoot && aimOff < this.sk.fireTol && d < this.sk.range) {
      if (slotGun >= 0) a.fire[slotGun] = true
      if (slotLight >= 0 && d < 42) a.fire[slotLight] = true
    }
    if (slotLaser >= 0 && canShoot && d < 260) {
      const lw = me.weapons[slotLaser]
      if (lw.cooldown <= 0) {
        const full = (lw.charge ?? 0) >= lw.stats.charge - 0.01
        const yawNow = Math.atan2(ty + visible.vel[1] * 0.1 - ey, tx + visible.vel[0] * 0.1 - ex) + this.aimErrY * 0.5
        if (full) a.aim = [yawNow, Math.atan2(tz - ez, Math.hypot(tx - ex, ty - ey)) + this.aimErrP * 0.5]
        const off2 = Math.abs(wrap(me.aim[0] - yawNow))
        a.fire[slotLaser] = !(full && off2 < this.sk.laserTol)
      }
    }
    if (slotMortar >= 0 && canShoot && d > 20 && d < 200) {
      const mw = me.weapons[slotMortar]
      const v = mw.stats.speed, g = mw.stats.gravity
      const hd = Math.hypot(tx - ex, ty - ey), hz = visible.pos[2] - (z + me.stats.height + 0.5)
      const disc = v ** 4 - g * (g * hd * hd + 2 * hz * v * v)
      if (disc > 0 && mw.cooldown <= 0) {
        const th = Math.atan((v * v - Math.sqrt(disc)) / (g * hd))
        a.aim = [Math.atan2(ty - ey, tx - ex) + this.aimErrY, th]
        if (Math.abs(wrap(me.aim[0] - a.aim[0])) < 0.04 && Math.abs(me.aim[1] - th) < 0.04) a.fire[slotMortar] = true
      }
    }
  }

  follow(x: number, y: number): number[] {
    const p = this.path
    if (!p || p.length === 0) return [0, 0]
    let best = 0, bd = Infinity
    for (let i = 0; i < Math.min(p.length, 40); i++) {
      const d = Math.hypot(this.nav.cx(p[i]) - x, this.nav.cy(p[i]) - y)
      if (d < bd) { bd = d; best = i }
    }
    if (best > 0) p.splice(0, best)
    let tgtI = Math.min(p.length - 1, 1)
    for (let i = Math.min(p.length - 1, 14); i >= 1; i--) {
      if (this.nav.segmentClear(x, y, this.nav.cx(p[i]), this.nav.cy(p[i]))) { tgtI = i; break }
    }
    const tx = this.nav.cx(p[tgtI]), ty = this.nav.cy(p[tgtI])
    const d = Math.hypot(tx - x, ty - y)
    if (d < 0.5) return [0, 0]
    return [(tx - x) / d, (ty - y) / d]
  }
}

function gauss(R: () => number) {
  let u = 0, v = 0
  while (u === 0) u = R()
  while (v === 0) v = R()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
}

// Port of the kit's example bot (python/example_bot.py; 1.15 on the real practice ladder)
export class ExampleBot implements Controller {
  name = "example"
  squad = false
  reach = 4
  hello(h: any) { this.reach = h.config.loot.pickup_radius }
  act(obs: any): any {
    const me = obs.self
    const [x, y, z] = me.pos
    const goal = obs.zone.next_center
    const act: any = { tick: obs.tick }
    if (obs.offer) act.pick = 0
    const near = obs.pickups.filter((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < this.reach)
    if (me.weapons[1] === null && near.length && near[0].kind !== "gun") act.take = near[0].id
    const enemies = obs.mechs.filter((m: any) => m.kind === "mech").sort((a: any, b: any) => Math.hypot(a.pos[0] - x, a.pos[1] - y, a.pos[2] - z) - Math.hypot(b.pos[0] - x, b.pos[1] - y, b.pos[2] - z))
    const yaw = Math.atan2(goal[1] - y, goal[0] - x)
    Object.assign(act, { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0.0], boost: !me.in_zone, jump: obs.tick % 40 === 0 })
    if (enemies.length) {
      const t = enemies[0].pos
      act.aim = [Math.atan2(t[1] - y, t[0] - x), Math.atan2(t[2] - z - 2.5, Math.hypot(t[0] - x, t[1] - y))]
      act.fire = [true, true]
    }
    return act
  }
}
