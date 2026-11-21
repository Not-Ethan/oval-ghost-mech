// Static world geometry: terrain, prisms (buildings, stadium, bridges) and trees.
// Semantics follow protocol.md section 11 and the map's own rules (canopy density / block threshold).
import { readFileSync } from "node:fs"

const CELL = 16
const EPS = 1e-9

export type Prism = {
  kind: string
  base: number
  top: number
  edges: Float64Array // x0,y0,x1,y1 per edge (ring and holes)
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type Tree = {
  x: number
  y: number
  z: number
  trunkR: number
  trunkTop: number
  cx: number
  cy: number
  cz: number
  crownR: number
  rz: number
}

export function pointInEdges(e: Float64Array, x: number, y: number): boolean {
  let r = false
  for (let i = 0; i < e.length; i += 4) {
    const ax = e[i], ay = e[i + 1], bx = e[i + 2], by = e[i + 3]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) r = !r
  }
  return r
}

// closest point on the polygon boundary: returns distance, writes the point into out
export function closestOnEdges(e: Float64Array, x: number, y: number, out: number[]): number {
  let best = Infinity, bx = 0, by = 0
  for (let i = 0; i < e.length; i += 4) {
    const sx = e[i], sy = e[i + 1], dx = e[i + 2] - sx, dy = e[i + 3] - sy
    const dd = dx * dx + dy * dy
    let t = dd > EPS ? ((x - sx) * dx + (y - sy) * dy) / dd : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const px = sx + dx * t, py = sy + dy * t
    const d2 = (px - x) * (px - x) + (py - y) * (py - y)
    if (d2 < best) { best = d2; bx = px; by = py }
  }
  out[0] = bx
  out[1] = by
  return Math.sqrt(best)
}

export class World {
  json: any
  minX: number
  minY: number
  maxX: number
  maxY: number
  tminX: number
  tminY: number
  tstep: number
  tnx: number
  tny: number
  ht: Int16Array
  hscale: number
  bnx: number
  bny: number
  blockMax: Float32Array
  prisms: Prism[]
  trees: Tree[]
  gx0: number
  gy0: number
  gnx: number
  gny: number
  gridPrisms: Int32Array[]
  gridTrees: Int32Array[]
  stampP: Uint32Array
  stampT: Uint32Array
  stamp = 1
  canopyDensity: number
  canopyBlockT: number
  // scratch
  hitKind = 0 // 0 none, 1 prism, 2 trunk, 3 terrain
  hitId = -1

  constructor(json: any, terrain: Int16Array, blockMax: Float32Array | null = null) {
    this.json = json
    const b = json.bounds
    this.minX = b.minX; this.minY = b.minY; this.maxX = b.maxX; this.maxY = b.maxY
    const tg = json.terrain
    this.tminX = tg.minX; this.tminY = tg.minY; this.tstep = tg.step; this.tnx = tg.nx; this.tny = tg.ny
    const scale = tg.scale ?? 0.01
    this.ht = terrain
    this.hscale = scale
    this.canopyDensity = json.rules?.canopyDensity ?? 0.35
    this.canopyBlockT = json.rules?.canopyBlockT ?? 0.25
    // 8x8 block maxima, dilated by one block so a ray segment inside a block is bounded
    this.bnx = Math.ceil(this.tnx / 8)
    this.bny = Math.ceil(this.tny / 8)
    if (blockMax && blockMax.length === this.bnx * this.bny) this.blockMax = blockMax
    else this.blockMax = this.computeBlockMax()
    this.prisms = this.buildPrisms(json)
    this.buildRest(json)
  }

  computeBlockMax(): Float32Array {
    const bm = new Float32Array(this.bnx * this.bny).fill(-Infinity)
    const ht = this.ht, sc = this.hscale
    for (let j = 0; j < this.tny; j++)
      for (let i = 0; i < this.tnx; i++) {
        const k = (j >> 3) * this.bnx + (i >> 3)
        const v = ht[j * this.tnx + i] * sc
        if (v > bm[k]) bm[k] = v
      }
    const out = bm.slice()
    for (let j = 0; j < this.bny; j++)
      for (let i = 0; i < this.bnx; i++) {
        let v = bm[j * this.bnx + i]
        if (i + 1 < this.bnx) v = Math.max(v, bm[j * this.bnx + i + 1])
        if (j + 1 < this.bny) v = Math.max(v, bm[(j + 1) * this.bnx + i])
        if (i + 1 < this.bnx && j + 1 < this.bny) v = Math.max(v, bm[(j + 1) * this.bnx + i + 1])
        out[j * this.bnx + i] = v
      }
    return out
  }

  buildPrisms(json: any): Prism[] {
    return json.prisms.map((p: any) => {
      const rings = [p.ring, ...(p.holes ?? [])]
      let n = 0
      for (const r of rings) n += r.length / 2
      const e = new Float64Array(n * 4)
      let k = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const r of rings) {
        const m = r.length / 2
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m
          e[k++] = r[2 * i]; e[k++] = r[2 * i + 1]; e[k++] = r[2 * j]; e[k++] = r[2 * j + 1]
          x0 = Math.min(x0, r[2 * i]); x1 = Math.max(x1, r[2 * i])
          y0 = Math.min(y0, r[2 * i + 1]); y1 = Math.max(y1, r[2 * i + 1])
        }
      }
      return { kind: p.kind, base: p.base, top: p.top, edges: e, minX: x0, minY: y0, maxX: x1, maxY: y1 }
    })
  }

  buildRest(json: any) {
    const f = json.trees.fields as string[]
    const nf = f.length
    const ix = f.indexOf("x"), iy = f.indexOf("y"), iz = f.indexOf("z"), ih = f.indexOf("height")
    const icr = f.indexOf("crownR"), icb = f.indexOf("crownBase"), itr = f.indexOf("trunkR")
    const icx = f.indexOf("crownX"), icy = f.indexOf("crownY")
    const d = json.trees.data as number[]
    this.trees = []
    for (let i = 0; i + nf <= d.length; i += nf) {
      const z = d[i + iz], height = d[i + ih], cb = d[i + icb]
      const lo = z + cb, hi = z + height
      this.trees.push({
        x: d[i + ix], y: d[i + iy], z, trunkR: d[i + itr],
        trunkTop: z + Math.max(cb + 0.5 * (height - cb), 3),
        cx: icx >= 0 ? d[i + icx] : d[i + ix], cy: icy >= 0 ? d[i + icy] : d[i + iy],
        cz: (lo + hi) / 2, crownR: d[i + icr], rz: Math.max((hi - lo) / 2, 0.5),
      })
    }
    this.gx0 = this.minX - CELL
    this.gy0 = this.minY - CELL
    this.gnx = Math.ceil((this.maxX - this.minX) / CELL) + 3
    this.gny = Math.ceil((this.maxY - this.minY) / CELL) + 3
    const gp: number[][] = Array.from({ length: this.gnx * this.gny }, () => [])
    const gt: number[][] = Array.from({ length: this.gnx * this.gny }, () => [])
    this.prisms.forEach((p, i) => this.forCells(p.minX, p.minY, p.maxX, p.maxY, (c) => gp[c].push(i)))
    this.trees.forEach((t, i) => {
      const r = t.crownR
      this.forCells(Math.min(t.cx - r, t.x - t.trunkR), Math.min(t.cy - r, t.y - t.trunkR), Math.max(t.cx + r, t.x + t.trunkR), Math.max(t.cy + r, t.y + t.trunkR), (c) => gt[c].push(i))
    })
    this.gridPrisms = gp.map((a) => Int32Array.from(a))
    this.gridTrees = gt.map((a) => Int32Array.from(a))
    this.stampP = new Uint32Array(this.prisms.length)
    this.stampT = new Uint32Array(this.trees.length)
  }

  static load(dir: string, blockMax: Float32Array | null = null): World {
    const json = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const buf = readFileSync(dir + "/v2/" + (json.terrain.file ?? "terrain.i16"))
    // little-endian hosts only (x86-64 and arm64 both are)
    const copy = new Uint8Array(buf.byteLength)
    copy.set(buf)
    const arr = new Int16Array(copy.buffer, 0, buf.byteLength >> 1)
    return new World(json, arr, blockMax)
  }

  nextStamp(): number {
    this.stamp = (this.stamp + 1) >>> 0
    if (this.stamp === 0) { this.stampP.fill(0); this.stampT.fill(0); this.stamp = 1 }
    return this.stamp
  }

  cellOf(x: number, y: number): number {
    const i = Math.floor((x - this.gx0) / CELL), j = Math.floor((y - this.gy0) / CELL)
    return i < 0 || j < 0 || i >= this.gnx || j >= this.gny ? -1 : j * this.gnx + i
  }

  forCells(x0: number, y0: number, x1: number, y1: number, fn: (c: number) => void) {
    const i0 = Math.max(0, Math.floor((x0 - this.gx0) / CELL)), i1 = Math.min(this.gnx - 1, Math.floor((x1 - this.gx0) / CELL))
    const j0 = Math.max(0, Math.floor((y0 - this.gy0) / CELL)), j1 = Math.min(this.gny - 1, Math.floor((y1 - this.gy0) / CELL))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.gnx + i)
  }

  groundHeight(x: number, y: number): number {
    let fx = (x - this.tminX) / this.tstep, fy = (y - this.tminY) / this.tstep
    fx = fx < 0 ? 0 : fx > this.tnx - 1.000001 ? this.tnx - 1.000001 : fx
    fy = fy < 0 ? 0 : fy > this.tny - 1.000001 ? this.tny - 1.000001 : fy
    const i = fx | 0, j = fy | 0, sx = fx - i, sy = fy - j, k = j * this.tnx + i, h = this.ht
    return ((h[k] * (1 - sx) + h[k + 1] * sx) * (1 - sy) + (h[k + this.tnx] * (1 - sx) + h[k + this.tnx + 1] * sx) * sy) * this.hscale
  }

  groundGradient(x: number, y: number, out: number[]) {
    const s = this.tstep
    out[0] = (this.groundHeight(x + s, y) - this.groundHeight(x - s, y)) / (2 * s)
    out[1] = (this.groundHeight(x, y + s) - this.groundHeight(x, y - s)) / (2 * s)
  }

  // Highest walkable surface at (x,y) whose height is <= maxZ (ground or a prism top). Writes prism id into hitId (-1 for terrain).
  surfaceHeight(x: number, y: number, maxZ = Infinity): number {
    let z = this.groundHeight(x, y)
    this.hitId = -1
    const c = this.cellOf(x, y)
    if (c < 0) return z
    const list = this.gridPrisms[c]
    for (let k = 0; k < list.length; k++) {
      const p = this.prisms[list[k]]
      if (p.top > maxZ || p.top <= z || x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
      if (pointInEdges(p.edges, x, y)) { z = p.top; this.hitId = list[k] }
    }
    return z
  }

  // Lowest prism base above z at (x,y) within radius r (ceiling for jets)
  ceilingAbove(x: number, y: number, z: number, r: number): number {
    let best = Infinity
    this.forCells(x - r, y - r, x + r, y + r, (c) => {
      const list = this.gridPrisms[c]
      for (let k = 0; k < list.length; k++) {
        const p = this.prisms[list[k]]
        if (p.base < z - 0.01 || p.base >= best || x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
        if (pointInEdges(p.edges, x, y)) best = p.base
      }
    })
    return best
  }

  // Is the point inside any prism solid?
  insideSolid(x: number, y: number, z: number): boolean {
    const c = this.cellOf(x, y)
    if (c < 0) return false
    const list = this.gridPrisms[c]
    for (let k = 0; k < list.length; k++) {
      const p = this.prisms[list[k]]
      if (z < p.base || z > p.top || x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
      if (pointInEdges(p.edges, x, y)) return true
    }
    return false
  }

  // ---------------------------------------------------------------- rays
  private rayPrism(id: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
    const p = this.prisms[id]
    let t0 = 0, t1 = tmax
    // slab tests
    if (Math.abs(dx) < EPS) { if (ox < p.minX || ox > p.maxX) return -1 } else {
      let a = (p.minX - ox) / dx, b = (p.maxX - ox) / dx
      if (a > b) { const s = a; a = b; b = s }
      if (a > t0) t0 = a
      if (b < t1) t1 = b
      if (t0 > t1) return -1
    }
    if (Math.abs(dy) < EPS) { if (oy < p.minY || oy > p.maxY) return -1 } else {
      let a = (p.minY - oy) / dy, b = (p.maxY - oy) / dy
      if (a > b) { const s = a; a = b; b = s }
      if (a > t0) t0 = a
      if (b < t1) t1 = b
      if (t0 > t1) return -1
    }
    if (Math.abs(dz) < EPS) { if (oz < p.base || oz > p.top) return -1 } else {
      let a = (p.base - oz) / dz, b = (p.top - oz) / dz
      if (a > b) { const s = a; a = b; b = s }
      if (a > t0) t0 = a
      if (b < t1) t1 = b
      if (t0 > t1) return -1
    }
    if (oz >= p.base && oz <= p.top && pointInEdges(p.edges, ox, oy)) return 0
    let best = tmax, hit = -1
    const e = p.edges
    for (let i = 0; i < e.length; i += 4) {
      const ex = e[i + 2] - e[i], ey = e[i + 3] - e[i + 1]
      const den = dx * ey - dy * ex
      if (Math.abs(den) < EPS) continue
      const qx = e[i] - ox, qy = e[i + 1] - oy
      const t = (qx * ey - qy * ex) / den
      const u = (qx * dy - qy * dx) / den
      if (t < 0 || t >= best || u < 0 || u > 1) continue
      const z = oz + dz * t
      if (z < p.base || z > p.top) continue
      best = t; hit = t
    }
    if (Math.abs(dz) > EPS) {
      // top cap (ray going down) and base cap (ray going up)
      const capZ = dz < 0 ? p.top : p.base
      const t = (capZ - oz) / dz
      if (t >= 0 && t < best) {
        const x = ox + dx * t, y = oy + dy * t
        if (pointInEdges(e, x, y)) { best = t; hit = t }
      }
    }
    return hit
  }

  private rayTerrain(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
    const step8 = 8 * this.tstep
    const hd = Math.hypot(dx, dy)
    const f = (t: number) => oz + dz * t - this.groundHeight(ox + dx * t, oy + dy * t)
    if (f(0) < 0) return 0
    const dt = hd > EPS ? (0.9 * this.tstep) / hd : 1
    let t = 0
    for (let it = 0; t < tmax; it++) {
      if (it > 100000) return -1
      const x = ox + dx * t, y = oy + dy * t
      const bi = Math.floor((x - this.tminX) / step8), bj = Math.floor((y - this.tminY) / step8)
      const inGrid = bi >= 0 && bj >= 0 && bi < this.bnx && bj < this.bny
      let tExit = tmax
      if (hd > EPS) {
        const bx0 = this.tminX + bi * step8, by0 = this.tminY + bj * step8
        const tx = dx > EPS ? (bx0 + step8 - x) / dx : dx < -EPS ? (bx0 - x) / dx : Infinity
        const ty = dy > EPS ? (by0 + step8 - y) / dy : dy < -EPS ? (by0 - y) / dy : Infinity
        tExit = Math.min(t + Math.max(0, Math.min(tx, ty)) + 1e-6, tmax)
      }
      const zmin = Math.min(oz + dz * t, oz + dz * tExit)
      if (inGrid && zmin > this.blockMax[bj * this.bnx + bi]) { t = tExit; continue }
      const tn = Math.min(t + dt, tmax)
      if (f(tn) < 0) {
        let lo = t, hi = tn
        for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (f(m) < 0) hi = m; else lo = m }
        return hi
      }
      if (tn >= tmax) break
      t = tn
    }
    return -1
  }

  // Walk the 16 m cells crossed by the 2D segment; fn returns false to stop early.
  private walkCells(ax: number, ay: number, bx: number, by: number, fn: (c: number) => boolean) {
    const dx = bx - ax, dy = by - ay
    let i = Math.floor((ax - this.gx0) / CELL), j = Math.floor((ay - this.gy0) / CELL)
    const ie = Math.floor((bx - this.gx0) / CELL), je = Math.floor((by - this.gy0) / CELL)
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1
    const tdx = Math.abs(dx) > EPS ? CELL / Math.abs(dx) : Infinity
    const tdy = Math.abs(dy) > EPS ? CELL / Math.abs(dy) : Infinity
    let tmx = Math.abs(dx) > EPS ? (dx > 0 ? (i + 1) * CELL + this.gx0 - ax : ax - (i * CELL + this.gx0)) / Math.abs(dx) : Infinity
    let tmy = Math.abs(dy) > EPS ? (dy > 0 ? (j + 1) * CELL + this.gy0 - ay : ay - (j * CELL + this.gy0)) / Math.abs(dy) : Infinity
    for (let k = 0; k < 4096; k++) {
      if (i >= 0 && j >= 0 && i < this.gnx && j < this.gny) { if (!fn(j * this.gnx + i)) return }
      if (i === ie && j === je) return
      if (tmx < tmy) { if (tmx > 1) return; tmx += tdx; i += si } else { if (tmy > 1) return; tmy += tdy; j += sj }
    }
  }

  // First hit along segment a->b in [0,1]; returns 1 if clear. Sets hitKind.
  // trunks: tree trunks block (vision); terrain: terrain blocks.
  raycast(ax: number, ay: number, az: number, bx: number, by: number, bz: number, trunks: boolean, terrain = true): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    let best = 1
    this.hitKind = 0
    this.hitId = -1
    const st = this.nextStamp()
    this.walkCells(ax, ay, bx, by, (c) => {
      const list = this.gridPrisms[c]
      for (let k = 0; k < list.length; k++) {
        const id = list[k]
        if (this.stampP[id] === st) continue
        this.stampP[id] = st
        const t = this.rayPrism(id, ax, ay, az, dx, dy, dz, best)
        if (t >= 0 && t < best) { best = t; this.hitKind = 1; this.hitId = id }
      }
      if (trunks) {
        const tl = this.gridTrees[c]
        for (let k = 0; k < tl.length; k++) {
          const id = tl[k]
          if (this.stampT[id] === st) continue
          this.stampT[id] = st
          const tr = this.trees[id]
          const t = this.rayCylinder(tr.x, tr.y, tr.trunkR, tr.z - 1, tr.trunkTop, ax, ay, az, dx, dy, dz, best)
          if (t >= 0 && t < best) { best = t; this.hitKind = 2; this.hitId = id }
        }
      }
      return true
    })
    if (terrain) {
      const t = this.rayTerrain(ax, ay, az, dx, dy, dz, best)
      if (t >= 0 && t < best) { best = t; this.hitKind = 3; this.hitId = -1 }
    }
    return best
  }

  private rayCylinder(cx: number, cy: number, r: number, z0: number, z1: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number): number {
    const fx = ox - cx, fy = oy - cy
    const a = dx * dx + dy * dy
    if (a < EPS) return -1
    const b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r
    const disc = b * b - 4 * a * c
    if (disc < 0) return -1
    const t = (-b - Math.sqrt(disc)) / (2 * a)
    if (t < 0 || t >= tmax) return -1
    const z = oz + dz * t
    if (z < z0 || z > z1) return -1
    return t
  }

  // Fraction of light passing tree crowns along a->b
  canopyTransmittance(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    let acc = 0
    const st = this.nextStamp()
    this.walkCells(ax, ay, bx, by, (c) => {
      const tl = this.gridTrees[c]
      for (let k = 0; k < tl.length; k++) {
        const id = tl[k]
        if (this.stampT[id] === st) continue
        this.stampT[id] = st
        const tr = this.trees[id]
        const sx = (ax - tr.cx) / tr.crownR, sy = (ay - tr.cy) / tr.crownR, sz = (az - tr.cz) / tr.rz
        const ux = dx / tr.crownR, uy = dy / tr.crownR, uz = dz / tr.rz
        const A = ux * ux + uy * uy + uz * uz
        if (A < EPS) continue
        const B = 2 * (sx * ux + sy * uy + sz * uz), C = sx * sx + sy * sy + sz * sz - 1
        const D = B * B - 4 * A * C
        if (D <= 0) continue
        const q = Math.sqrt(D)
        const t0 = (-B - q) / (2 * A), t1 = (-B + q) / (2 * A)
        if (t1 < 0 || t0 > 1) continue
        acc += (Math.min(t1, 1) - Math.max(t0, 0)) * len
      }
      return true
    })
    return Math.exp(-this.canopyDensity * acc)
  }

  // Vision line: solids and trunks block; canopy fades unless near (proximity sensors ignore canopy).
  sees(ax: number, ay: number, az: number, bx: number, by: number, bz: number, useCanopy: boolean): boolean {
    if (this.raycast(ax, ay, az, bx, by, bz, true) < 1) return false
    if (!useCanopy) return true
    return this.canopyTransmittance(ax, ay, az, bx, by, bz) >= this.canopyBlockT
  }

  // Shot line: buildings and terrain stop shots, trees do not.
  shotClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.raycast(ax, ay, az, bx, by, bz, false) >= 1
  }
}
