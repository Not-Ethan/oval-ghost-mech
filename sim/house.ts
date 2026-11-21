// Approximate house bots: one squad, shared vision, hunt non-squad mechs weakest-first.
// Skill tiers differ in aim noise, lead, reaction and engagement range. These are guesses.
import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { rng, type Controller } from "./engine.ts"

const TAU = Math.PI * 2
const wrap = (a: number) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }

export type Skill = { name: string; aimDeg: number; lead: number; react: number; range: number; strafe: boolean; loot: boolean }
export const SKILLS: Record<string, Skill> = {
  easy: { name: "easy", aimDeg: 4.0, lead: 0.0, react: 1.0, range: 120, strafe: false, loot: false, noiseP: 0.2 } as any,
  medium: { name: "medium", aimDeg: 2.5, lead: 0.5, react: 0.7, range: 150, strafe: true, loot: true, noiseP: 0.3 } as any,
  hard: { name: "hard", aimDeg: 1.6, lead: 0.8, react: 0.45, range: 180, strafe: true, loot: true, noiseP: 0.4 } as any,
  expert: { name: "expert", aimDeg: 1.0, lead: 1.0, react: 0.3, range: 200, strafe: true, loot: true, noiseP: 0.5 } as any,
}

const STRENGTH = Number(process.env.HOUSE_STRENGTH ?? 1)
const HUNT_R = Number(process.env.HOUSE_HUNT_R ?? 1e9)
const REACT = Number(process.env.HOUSE_REACT ?? 1)
for (const k of Object.keys(SKILLS)) { (SKILLS as any)[k].aimDeg /= STRENGTH; (SKILLS as any)[k].react *= REACT }

export class Squad {
  members = new Set<number>()
  known = new Map<number, any>() // enemy id -> {pos, vel, t, hp, max_hp, weapons}
  lastT = -1
  noises: any[] = []
  ingest(selfId: number, obs: any) {
    this.members.add(selfId)
    for (const m of obs.mechs) {
      if (m.kind !== "mech" || this.members.has(m.id)) continue
      this.known.set(m.id, { ...m, t: obs.t, seenBy: selfId })
    }
    for (const s of obs.sounds) if (["gun", "laser", "mortar", "lightning"].includes(s.kind) && s.dist !== "far") this.noises.push({ ...s, from: obs.self.pos.slice(), t: obs.t })
    if (this.noises.length > 30) this.noises.splice(0, this.noises.length - 30)
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
  laserHold = 0
  aimErrY = 0
  aimErrP = 0
  aimErrT = -1
  constructor(w: World, nav: Nav, sq: Squad, skill: Skill, seed: number) {
    this.w = w; this.nav = nav; this.sq = sq; this.sk = skill; this.name = "house-" + skill.name; this.R = rng(seed)
  }
  hello(h: any) { this.id = h.slot; this.cfg = h.config; this.sq.members.add(h.slot) }

  act(o: any): any {
    const me = o.self
    this.sq.ingest(me.id, o)
    const [x, y, z] = me.pos
    const a: any = { tick: o.tick }
    if (o.offer) a.pick = Math.floor(this.R() * o.offer.choices.length)
    // pickups
    if (this.sk.loot && !me.weapons[1]) {
      const near = o.pickups.find((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < 3.8 && Math.abs(p.pos[2] - z) < 4)
      if (near) a.take = near.id
    }
    // target: known enemies, weakest first, recent
    let tgt: any = null
    for (const e of this.sq.known.values()) {
      if (o.t - e.t > 6) continue
      if (Math.hypot(e.pos[0] - x, e.pos[1] - y) > HUNT_R && !o.mechs.some((m: any) => m.id === e.id)) continue
      if (!tgt || e.hp < tgt.hp - 1 || (Math.abs(e.hp - tgt.hp) < 1 && Math.hypot(e.pos[0] - x, e.pos[1] - y) < Math.hypot(tgt.pos[0] - x, tgt.pos[1] - y))) tgt = e
    }
    const visible = tgt ? o.mechs.find((m: any) => m.id === tgt.id) : null
    const zn = o.zone
    const dz = Math.hypot(x - zn.next_center[0], y - zn.next_center[1])
    const inNext = dz < zn.next_radius - 10
    const curD = Math.hypot(x - zn.center[0], y - zn.center[1])
    let goal: number[] | null = null
    let wantRange = 70
    const hasLaser = me.weapons.some((w: any) => w && w.kind === "laser")
    const hasLightning = me.weapons.some((w: any) => w && w.kind === "lightning")
    if (hasLightning) wantRange = 30
    else if (hasLaser) wantRange = 110
    let mustZone = curD > zn.radius - 15 || (o.t > zn.shrink_start - 15 && !inNext)
    if (tgt && !mustZone) {
      const d = Math.hypot(tgt.pos[0] - x, tgt.pos[1] - y)
      const ez = Math.hypot(tgt.pos[0] - zn.center[0], tgt.pos[1] - zn.center[1])
      if (ez < zn.radius + 20) {
        if (!visible || d > wantRange) goal = [tgt.pos[0], tgt.pos[1]]
      }
    }
    if (!goal && (mustZone || !tgt)) {
      if (mustZone || !this.roam || Math.hypot(this.roam[0] - x, this.roam[1] - y) < 12 || Math.hypot(this.roam[0] - zn.next_center[0], this.roam[1] - zn.next_center[1]) > zn.next_radius) {
        const ang = this.R() * TAU, rr = Math.sqrt(this.R()) * zn.next_radius * 0.9
        this.roam = [zn.next_center[0] + Math.cos(ang) * rr, zn.next_center[1] + Math.sin(ang) * rr]
        // loot-seeking: go to a visible pickup
        if (this.sk.loot && !me.weapons[1] && !mustZone) {
          const p = o.pickups.find((p: any) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < 60 && Math.abs(p.pos[2] - z) < 3)
          if (p) this.roam = [p.pos[0], p.pos[1]]
        }
        // noise investigation
        if (!mustZone && this.sq.noises.length && this.R() < (this.sk as any).noiseP) {
          const n = this.sq.noises[this.sq.noises.length - 1]
          if (o.t - n.t < 8) {
            const dd = n.dist === "near" ? 40 : 110
            this.roam = [n.from[0] + Math.cos(n.bearing) * dd, n.from[1] + Math.sin(n.bearing) * dd]
          }
        }
      }
      goal = this.roam
    }
    let mv = [0, 0]
    if (goal) {
      if (!this.path || o.t - this.pathT > 3 || !this.goal || Math.hypot(goal[0] - this.goal[0], goal[1] - this.goal[1]) > 15) {
        this.path = this.nav.findPath(x, y, goal[0], goal[1], null, 6000)
        this.pathT = o.t
        this.goal = goal
      }
      mv = this.follow(x, y)
    }
    // strafe when engaging
    if (visible && this.sk.strafe) {
      if (o.t > this.strafeT) { this.strafeDir = this.R() < 0.5 ? -1 : 1; this.strafeT = o.t + 0.5 + this.R() * 1.2 }
      const ang = Math.atan2(visible.pos[1] - y, visible.pos[0] - x) + (this.strafeDir * Math.PI) / 2
      const d = Math.hypot(visible.pos[0] - x, visible.pos[1] - y)
      const radial = d > wantRange ? 0.6 : d < wantRange * 0.5 ? -0.5 : 0
      const sx = Math.cos(ang) + radial * Math.cos(ang - (this.strafeDir * Math.PI) / 2)
      const sy = Math.sin(ang) + radial * Math.sin(ang - (this.strafeDir * Math.PI) / 2)
      const l = Math.hypot(sx, sy) || 1
      const cand = [sx / l, sy / l]
      if (this.nav.clearanceAt(x + cand[0] * 4, y + cand[1] * 4) > 3) mv = goal ? [mv[0] * 0.5 + cand[0] * 0.5, mv[1] * 0.5 + cand[1] * 0.5] : cand
      else this.strafeDir *= -1
    }
    a.move = mv
    a.boost = mustZone && !me.in_zone ? true : !!(goal && tgt && !visible && me.energy > 60)
    // aim & fire
    a.fire = [false, false]
    if (visible) {
      if (!this.seenSince.has(visible.id)) this.seenSince.set(visible.id, o.t)
      const since = o.t - (this.seenSince.get(visible.id) ?? o.t)
      const ex = x, ey = y, ez = z + me.stats.muzzle_height
      const tx = visible.pos[0], ty = visible.pos[1], tz = visible.pos[2] + 4.5
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
      const canShoot = since >= this.sk.react && this.w.shotClear(ex, ey, ez, tx, ty, tz)
      if (canShoot && aimOff < 0.05 && d < this.sk.range) {
        if (slotGun >= 0) a.fire[slotGun] = true
        if (slotLight >= 0 && d < 42) a.fire[slotLight] = true
      }
      if (slotLaser >= 0 && canShoot && d < 260) {
        const lw = me.weapons[slotLaser]
        // charge, release when full and aimed
        if (lw.cooldown <= 0) {
          const full = (lw.charge ?? 0) >= lw.stats.charge - 0.01
          const yawNow = Math.atan2(ty + visible.vel[1] * 0.1 - ey, tx + visible.vel[0] * 0.1 - ex) + this.aimErrY * 0.5
          if (full) a.aim = [yawNow, Math.atan2(tz - ez, Math.hypot(tx - ex, ty - ey))]
          const off2 = Math.abs(wrap(me.aim[0] - yawNow))
          a.fire[slotLaser] = !(full && off2 < 0.02)
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
    } else {
      this.seenSince.clear()
      if (tgt) a.aim = [Math.atan2(tgt.pos[1] - y, tgt.pos[0] - x), 0]
      else if (Math.hypot(mv[0], mv[1]) > 0.1) a.aim = [Math.atan2(mv[1], mv[0]), 0]
      // release a held laser charge safely
      me.weapons.forEach((w: any, i: number) => { if (w && w.kind === "laser") a.fire[i] = false })
    }
    // got hit: look toward attacker
    for (const e of o.events) if (e.type === "damaged" && e.bearing !== null && !visible) a.aim = [e.bearing, 0]
    return a
  }

  follow(x: number, y: number): number[] {
    const p = this.path
    if (!p || p.length === 0) return [0, 0]
    // drop passed points
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

// Port of the kit's example bot (baseline ~1.15 on the real practice ladder)
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
