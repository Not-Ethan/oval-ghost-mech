// Shooting gallery for gun-lead models: node sim/aimbench.ts [seconds per case]
// A target strafes across the line of fire like the enemy in the real recorded stream (8-16 m/s, reversing every
// 0.4-1.4 s, 58.5 m/s^2 acceleration, closing at ~2 m/s), or runs straight. A gun (252 m/s, 0.6 deg spread, one shot
// per 0.24 s, decisions every 0.1 s) fires at it from a fixed range. Prints hit rates per lead model and range.
// Models: full linear lead, leadAdapt (the brain's formula), leadMC (the brain's method), no lead.
import { Brain } from "../src/brain.ts"

const SEC = Number(process.argv[2] ?? 120)
const TAU = Math.PI * 2
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }
const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }

type Mode = "strafe" | "straight" | "jitter" | string // "juke:<min>:<var>" = our dodge: walk speed, reversal every min..min+var s
function run(model: string, range: number, mode: Mode): number {
  const b = new Brain({ params: { leadAdapt: true, leadMC: true, leadMCMean: model === "mcmean" } }) as any
  b.cfg = { mech: { ground_accel: 58.5 } }
  b.rs = 777
  const dt = 0.05 // sim tick
  // target state (shooter at origin, muzzle z = 7; target centre z = 4.5 on flat ground)
  let tx = range, ty = 0, vx = 0, vy = 10, want = 1, nextRev = 0.4 + rnd(), speed = 8 + rnd() * 8
  const tr: any = { id: 1, x: tx, y: ty, z: 0, vx, vy, vz: 0, firstSeen: 0, rev: { t: 0, vx, vy, flips: [] } }
  const bullets: { x: number; y: number; z: number; vx: number; vy: number; vz: number; ttl: number }[] = []
  let shots = 0, hits = 0, cool = 0, aim: number[] | null = null
  for (let tick = 0; tick * dt < SEC; tick++) {
    const t = tick * dt
    // target motion
    if (mode === "strafe" && t >= nextRev) { want = -want; nextRev = t + 0.4 + rnd(); speed = 8 + rnd() * 8 }
    if (mode.startsWith("juke:") && t >= nextRev) { const [, mn, vr] = mode.split(":").map(Number); want = rnd() < 0.5 ? -1 : 1; nextRev = t + mn + rnd() * vr; speed = 11.7 }
    if (mode === "jitter" && t >= nextRev) { want = rnd() < 0.5 ? -1 : 1; nextRev = t + 0.2 + rnd() * 2.5; speed = 6 + rnd() * 10 }
    const dirx = -tx / Math.hypot(tx, ty), diry = -ty / Math.hypot(tx, ty) // toward shooter
    const latx = -diry, laty = dirx
    const wvx = mode === "straight" ? latx * 11.7 + dirx * 2 : latx * speed * want + dirx * 2
    const wvy = mode === "straight" ? laty * 11.7 + diry * 2 : laty * speed * want + diry * 2
    const ax = wvx - vx, ay = wvy - vy, al = Math.hypot(ax, ay), amax = 58.5 * dt
    if (al > amax) { vx += (ax * amax) / al; vy += (ay * amax) / al } else { vx = wvx; vy = wvy }
    tx += vx * dt; ty += vy * dt
    // keep the range roughly fixed (reset the radial drift)
    const r = Math.hypot(tx, ty); tx *= range / r; ty *= range / r
    if (mode === "straight" && t % 6 < dt) { vx = -vx; vy = -vy } // runs straight, turns around rarely
    // decision every 2 ticks: observe, update the reversal tracker like Brain.updateTracks, choose the aim point
    if (tick % 2 === 0) {
      b.t = t
      tr.x = tx; tr.y = ty; tr.vx = vx; tr.vy = vy
      const rv = tr.rev
      if (t - rv.t >= 0.3) {
        const sp0 = Math.hypot(rv.vx, rv.vy), sp1 = Math.hypot(vx, vy)
        if (sp0 > 3 && sp1 > 3 && (rv.vx * vx + rv.vy * vy) / (sp0 * sp1) < -0.3) {
          const prev = rv.flips.length ? rv.flips[rv.flips.length - 1] : -99
          rv.flips.push(t)
          const iv = t - prev
          if (iv > 0.25 && iv < 4) { b.flipIntervals.push(iv); if (b.flipIntervals.length > 80) b.flipIntervals.shift() }
        }
        rv.t = t; rv.vx = vx; rv.vy = vy
        while (rv.flips.length && t - rv.flips[0] > 8) rv.flips.shift()
      }
      const p = [tx, ty, 4.5], v = [vx, vy, 0]
      if (model === "none") aim = p
      else if (model === "full") aim = b.intercept(0, 0, 7, p, v, 252, 230)
      else if (model.startsWith("adapt")) {
        const span = Math.max(2, Math.min(8, t - tr.firstSeen))
        const hm = model === "adapt" ? 1 : model === "adapt0.6" ? 0.6 : model === "adapt1.5" ? 1.5 : 2.2
        const h = ((rv.flips.length + 0.5) / (span + 2)) * hm
        const tf = Math.hypot(tx, ty, 2.5) / 252
        const f = h * tf > 1e-3 ? (1 - Math.exp(-2 * h * tf)) / (2 * h * tf) : 1
        aim = b.intercept(0, 0, 7, p, [vx * f, vy * f, 0], 252, 230)
      } else aim = b.leadMC(0, 0, 7, p, v, tr, 252, 2.5).pt
    }
    // fire on cooldown along the aim (torso assumed on target: 4 rad/s slew is fast at these ranges)
    cool -= dt
    if (aim && cool <= 0 && t > 3) {
      const yaw = Math.atan2(aim[1], aim[0]) + gauss() * (0.6 * Math.PI / 180)
      const pitch = Math.atan2(aim[2] - 7, Math.hypot(aim[0], aim[1])) + gauss() * (0.6 * Math.PI / 180)
      bullets.push({ x: 0, y: 0, z: 7, vx: Math.cos(pitch) * Math.cos(yaw) * 252, vy: Math.cos(pitch) * Math.sin(yaw) * 252, vz: Math.sin(pitch) * 252, ttl: 230 / 252 })
      shots++; cool += 0.24
    }
    // bullets: hit if the segment passes within the target cylinder (r 2.5, z 0..9)
    for (let i = bullets.length - 1; i >= 0; i--) {
      const q = bullets[i]
      const nx = q.x + q.vx * dt, ny = q.y + q.vy * dt, nz = q.z + q.vz * dt
      // closest approach of segment to target axis (2D)
      const sx = nx - q.x, sy = ny - q.y, L2 = sx * sx + sy * sy
      const u = Math.max(0, Math.min(1, ((tx - q.x) * sx + (ty - q.y) * sy) / L2))
      const cx = q.x + sx * u, cy = q.y + sy * u, cz = q.z + (nz - q.z) * u
      if (Math.hypot(cx - tx, cy - ty) < 2.5 + 0.3 && cz > 0 && cz < 9) { hits++; bullets.splice(i, 1); continue }
      q.x = nx; q.y = ny; q.z = nz; q.ttl -= dt
      if (q.ttl <= 0) bullets.splice(i, 1)
    }
  }
  return hits / Math.max(1, shots)
}

const MODES = process.env.BENCH_MODES ? process.env.BENCH_MODES.split(",") : ["strafe", "jitter", "straight"]
for (const mode of MODES as Mode[]) {
  console.log(`== target: ${mode}`)
  for (const range of [50, 75, 100, 125, 150, 175]) {
    const row = (process.env.BENCH_MODELS ?? "full,adapt").split(",").map((m) => { seed = 12345 + range; return `${m} ${(100 * run(m, range, mode)).toFixed(1)}%` })
    console.log(`  ${String(range).padStart(3)} m: ${row.join("  ")}`)
  }
}
