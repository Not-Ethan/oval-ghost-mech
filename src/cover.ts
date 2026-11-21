// Static per-cell cover metrics. Precomputed offline into data/cover.bin (with a hash of the map
// files), recomputed lazily per cell if the map does not match.
import { World } from "./world.ts"
import { Nav } from "./nav.ts"

const TAU = Math.PI * 2
export const COVER_DIRS = 16


// near: fraction of directions with a solid within 20 m at chest height (something to hide behind)
// open: mean sight distance (eye height, canopy counted) over directions, /200 -> 0..1 (how exposed)
export function computeCell(w: World, nav: Nav, c: number): [number, number] {
  const x = nav.cx(c), y = nav.cy(c), z = nav.z[c]
  let near = 0, open = 0
  for (let k = 0; k < COVER_DIRS; k++) {
    const a = (k * TAU) / COVER_DIRS
    const dx = Math.cos(a), dy = Math.sin(a)
    const t = w.raycast(x, y, z + 5, x + dx * 20, y + dy * 20, z + 5, false)
    if (t < 1) near++
    // how far can a standing mech here be seen along this direction (target top from viewer eye ~8 m)
    const L = 200
    const t2 = w.raycast(x, y, z + 8.5, x + dx * L, y + dy * L, z + 8.5, true)
    let dist = t2 * L
    // canopy: walk outward until transmittance falls below the block threshold
    if (dist > 45) {
      let lo = 45, hi = dist
      if (w.canopyTransmittance(x, y, z + 8.5, x + dx * hi, y + dy * hi, z + 8.5) < w.canopyBlockT) {
        for (let i = 0; i < 6; i++) {
          const m = (lo + hi) / 2
          if (w.canopyTransmittance(x, y, z + 8.5, x + dx * m, y + dy * m, z + 8.5) < w.canopyBlockT) hi = m
          else lo = m
        }
        dist = hi
      }
    }
    open += dist / L
  }
  return [near / COVER_DIRS, open / COVER_DIRS]
}

export class Cover {
  near: Uint8Array
  open: Uint8Array
  done: Uint8Array
  w: World
  nav: Nav
  loaded = false
  constructor(w: World, nav: Nav) {
    this.w = w
    this.nav = nav
    const n = nav.walk.length
    this.near = new Uint8Array(n)
    this.open = new Uint8Array(n)
    this.done = new Uint8Array(n)
  }
  setData(near: Uint8Array, open: Uint8Array): boolean {
    if (near.length !== this.near.length || open.length !== this.open.length) return false
    this.near.set(near)
    this.open.set(open)
    this.done.fill(1)
    this.loaded = true
    return true
  }
  ensure(c: number) {
    if (this.done[c]) return
    const [a, b] = computeCell(this.w, this.nav, c)
    this.near[c] = Math.round(a * 255)
    this.open[c] = Math.round(b * 255)
    this.done[c] = 1
  }
  nearOf(c: number): number { this.ensure(c); return this.near[c] / 255 }
  openOf(c: number): number { this.ensure(c); return this.open[c] / 255 }
}
