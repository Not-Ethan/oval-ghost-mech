// Ground-level navigation grid: walkability from prisms + terrain slope, clearance via a Euclidean
// distance transform, A* with an optional per-cell extra cost (danger) field.
import { World } from "./world.ts"

export const NAV_STEP = 2

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

export class Nav {
  w: World
  // fine raster (1 m), sample (i,j) at (fx0 + i, fy0 + j)
  fnx: number
  fny: number
  fx0: number
  fy0: number
  clear: Float32Array // distance (m) to nearest obstacle sample
  fz: Float32Array // walker surface height
  // nav grid (2 m), cell (I,J) at fine sample (2I, 2J)
  nx: number
  ny: number
  x0: number
  y0: number
  walk: Uint8Array
  z: Float32Array
  cellClear: Float32Array
  // A* scratch
  g: Float32Array
  parent: Int32Array
  stamp: Uint32Array
  closedStamp: Uint32Array
  curStamp = 0
  heap: Int32Array
  heapF: Float32Array
  heapN = 0
  radius: number
  comp!: Int32Array
  mainComp = -1
  lastExpanded = 0
  stepUp: number
  height: number

  constructor(w: World, radius = 2.5, height = 9, stepUp = 1.2, maxSlopeDeg = 50, cached: { fz: Float32Array; clear: Float32Array } | null = null) {
    this.w = w
    this.radius = radius
    this.stepUp = stepUp
    this.height = height
    this.fx0 = w.tminX + 0.5
    this.fy0 = w.tminY + 0.5
    this.fnx = w.tnx - 1
    this.fny = w.tny - 1
    const N = this.fnx * this.fny
    if (cached && cached.fz.length === N && cached.clear.length === N) {
      this.fz = cached.fz
      this.clear = cached.clear
    } else {
      const r = Nav.raster(w, this.fnx, this.fny, this.fx0, this.fy0, height, stepUp, maxSlopeDeg)
      this.fz = r.fz
      this.clear = r.clear
    }
    this.nx = Math.floor((this.fnx + 1) / 2)
    this.ny = Math.floor((this.fny + 1) / 2)
    this.x0 = this.fx0
    this.y0 = this.fy0
    const M = this.nx * this.ny
    this.walk = new Uint8Array(M)
    this.z = new Float32Array(M)
    this.cellClear = new Float32Array(M)
    const need = radius + 0.35
    for (let J = 0; J < this.ny; J++)
      for (let I = 0; I < this.nx; I++) {
        const k = 2 * J * this.fnx + 2 * I
        const c = J * this.nx + I
        this.z[c] = this.fz[k]
        this.cellClear[c] = this.clear[k]
        this.walk[c] = this.clear[k] >= need ? 1 : 0
      }
    this.g = new Float32Array(M)
    this.parent = new Int32Array(M)
    this.stamp = new Uint32Array(M)
    this.closedStamp = new Uint32Array(M)
    this.heap = new Int32Array(M * 4 + 8)
    this.heapF = new Float32Array(M * 4 + 8)
    this.labelComponents()
  }

  // connected components of walkable cells (8-neighbour, |dz| within step limits); largest is "main"
  labelComponents() {
    const M = this.walk.length, nx = this.nx, ny = this.ny
    this.comp = new Int32Array(M).fill(-1)
    const q = new Int32Array(M)
    let label = 0, bestSize = 0
    const lim = this.stepUp + 1.0
    for (let s0 = 0; s0 < M; s0++) {
      if (!this.walk[s0] || this.comp[s0] >= 0) continue
      let qh = 0, qt = 0
      q[qt++] = s0
      this.comp[s0] = label
      while (qh < qt) {
        const c = q[qh++]
        const I = c % nx, J = (c / nx) | 0
        const zc = this.z[c]
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue
            const I2 = I + di, J2 = J + dj
            if (I2 < 0 || J2 < 0 || I2 >= nx || J2 >= ny) continue
            const n = J2 * nx + I2
            if (!this.walk[n] || this.comp[n] >= 0) continue
            if (di && dj && (!this.walk[J * nx + I2] || !this.walk[J2 * nx + I])) continue
            if (Math.abs(this.z[n] - zc) > lim) continue
            this.comp[n] = label
            q[qt++] = n
          }
      }
      if (qt > bestSize) { bestSize = qt; this.mainComp = label }
      label++
    }
  }

  inMain(c: number): boolean { return c >= 0 && this.walk[c] === 1 && this.comp[c] === this.mainComp }

  // nearest walkable cell of the main component
  nearestMain(x: number, y: number, maxR = 60): number {
    const c0 = this.cellAt(x, y)
    if (this.inMain(c0)) return c0
    const I0 = Math.round((x - this.x0) / NAV_STEP), J0 = Math.round((y - this.y0) / NAV_STEP)
    const R = Math.ceil(maxR / NAV_STEP)
    let best = -1, bd = Infinity
    for (let r = 1; r <= R; r++) {
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue
          const I = I0 + di, J = J0 + dj
          if (I < 0 || J < 0 || I >= this.nx || J >= this.ny) continue
          const c = J * this.nx + I
          if (!this.inMain(c)) continue
          const dd = di * di + dj * dj
          if (dd < bd) { bd = dd; best = c }
        }
      if (best >= 0 && r * r >= bd) return best
    }
    return best
  }

  static raster(w: World, fnx: number, fny: number, fx0: number, fy0: number, height: number, stepUp: number, maxSlopeDeg: number): { fz: Float32Array; clear: Float32Array } {
    const N = fnx * fny
    const obst = new Uint8Array(N)
    const fzA = new Float32Array(N)
    const maxSlope = Math.tan((maxSlopeDeg * Math.PI) / 180)
    const grad = [0, 0]
    for (let j = 0; j < fny; j++) {
      const y = fy0 + j
      for (let i = 0; i < fnx; i++) {
        const x = fx0 + i
        const k = j * fnx + i
        if (x < w.minX + 0.5 || x > w.maxX - 0.5 || y < w.minY + 0.5 || y > w.maxY - 0.5) { obst[k] = 1; continue }
        const g = w.groundHeight(x, y)
        const s = w.surfaceHeight(x, y, g + stepUp)
        fzA[k] = s
        if (s <= g + 0.01) {
          w.groundGradient(x, y, grad)
          if (Math.hypot(grad[0], grad[1]) > maxSlope) { obst[k] = 1; continue }
        }
        const c = w.cellOf(x, y)
        if (c < 0) continue
        const list = w.gridPrisms[c]
        for (let q = 0; q < list.length; q++) {
          const p = w.prisms[list[q]]
          if (p.top <= s + stepUp || p.base >= s + height) continue
          if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
          // pointInEdges inline
          const e = p.edges
          let r = false
          for (let t = 0; t < e.length; t += 4) {
            const ay = e[t + 1], by = e[t + 3]
            if (ay > y !== by > y && x < ((e[t + 2] - e[t]) * (y - ay)) / (by - ay) + e[t]) r = !r
          }
          if (r) { obst[k] = 1; break }
        }
      }
    }
    // squared EDT
    const INF = 1e12
    const f = new Float64Array(Math.max(fnx, fny))
    const d = new Float64Array(Math.max(fnx, fny))
    const v = new Int32Array(Math.max(fnx, fny))
    const zz = new Float64Array(Math.max(fnx, fny) + 1)
    const tmp = new Float64Array(N)
    for (let i = 0; i < fnx; i++) {
      for (let j = 0; j < fny; j++) f[j] = obst[j * fnx + i] ? 0 : INF
      edt1d(f, fny, d, v, zz)
      for (let j = 0; j < fny; j++) tmp[j * fnx + i] = d[j]
    }
    const clearA = new Float32Array(N)
    for (let j = 0; j < fny; j++) {
      for (let i = 0; i < fnx; i++) f[i] = tmp[j * fnx + i]
      edt1d(f, fnx, d, v, zz)
      for (let i = 0; i < fnx; i++) clearA[j * fnx + i] = Math.sqrt(d[i])
    }
    return { fz: fzA, clear: clearA }
  }

  cellAt(x: number, y: number): number {
    const I = Math.round((x - this.x0) / NAV_STEP), J = Math.round((y - this.y0) / NAV_STEP)
    if (I < 0 || J < 0 || I >= this.nx || J >= this.ny) return -1
    return J * this.nx + I
  }
  cx(c: number): number { return this.x0 + (c % this.nx) * NAV_STEP }
  cy(c: number): number { return this.y0 + Math.floor(c / this.nx) * NAV_STEP }

  clearanceAt(x: number, y: number): number {
    const i = Math.round(x - this.fx0), j = Math.round(y - this.fy0)
    if (i < 0 || j < 0 || i >= this.fnx || j >= this.fny) return 0
    return this.clear[j * this.fnx + i]
  }
  surfAt(x: number, y: number): number {
    const i = Math.round(x - this.fx0), j = Math.round(y - this.fy0)
    if (i < 0 || j < 0 || i >= this.fnx || j >= this.fny) return 0
    return this.fz[j * this.fnx + i]
  }

  walkable(c: number): boolean { return c >= 0 && this.walk[c] === 1 }

  // nearest walkable cell to (x,y) within maxR meters (spiral search)
  nearestWalkable(x: number, y: number, maxR = 40): number {
    const c0 = this.cellAt(x, y)
    if (c0 >= 0 && this.walk[c0]) return c0
    const I0 = Math.round((x - this.x0) / NAV_STEP), J0 = Math.round((y - this.y0) / NAV_STEP)
    const R = Math.ceil(maxR / NAV_STEP)
    let best = -1, bd = Infinity
    for (let r = 1; r <= R; r++) {
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue
          const I = I0 + di, J = J0 + dj
          if (I < 0 || J < 0 || I >= this.nx || J >= this.ny) continue
          const c = J * this.nx + I
          if (!this.walk[c]) continue
          const dd = di * di + dj * dj
          if (dd < bd) { bd = dd; best = c }
        }
      if (best >= 0 && r * r >= bd) return best
    }
    return best
  }

  // straight walk segment check on the fine clearance raster
  segmentClear(ax: number, ay: number, bx: number, by: number, need = this.radius + 0.2): boolean {
    const d = Math.hypot(bx - ax, by - ay)
    const n = Math.max(1, Math.ceil(d / 0.7))
    let zPrev = this.surfAt(ax, ay)
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t
      if (this.clearanceAt(x, y) < need) return false
      const z = this.surfAt(x, y)
      if (z - zPrev > this.stepUp + 0.6) return false
      zPrev = z
    }
    return true
  }

  private push(c: number, f: number) {
    let i = this.heapN++
    const h = this.heap, hf = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hf[p] <= f) break
      h[i] = h[p]; hf[i] = hf[p]; i = p
    }
    h[i] = c; hf[i] = f
  }
  private pop(): number {
    const h = this.heap, hf = this.heapF
    const top = h[0]
    const n = --this.heapN
    if (n > 0) {
      const c = h[n], f = hf[n]
      let i = 0
      for (;;) {
        let l = 2 * i + 1
        if (l >= n) break
        if (l + 1 < n && hf[l + 1] < hf[l]) l++
        if (hf[l] >= f) break
        h[i] = h[l]; hf[i] = hf[l]; i = l
      }
      h[i] = c; hf[i] = f
    }
    return top
  }

  // A* from (sx,sy) to goal cell set by predicate or single goal. Returns list of cells (start..goal) or null.
  // extra: optional per-cell additional cost (meters equivalent) for entering a cell.
  // maxExpand bounds the work.
  // zone: optional circle [cx, cy, r]; cells outside it cost extra (grows with depth outside)
  findPath(sx: number, sy: number, gx: number, gy: number, extra: Float32Array | null = null, maxExpand = 30000, hw = 1.3, zone: number[] | null = null): number[] | null {
    const s = this.nearestWalkable(sx, sy, 30)
    let t = this.nearestWalkable(gx, gy, 60)
    if (s < 0 || t < 0) return null
    if (this.comp[t] !== this.comp[s]) {
      // goal not reachable from here: aim for the closest cell of our component near the goal
      if (this.comp[s] === this.mainComp) t = this.nearestMain(gx, gy, 80)
      else return null
      if (t < 0) return null
    }
    if (s === t) return [s]
    this.curStamp++
    if (this.curStamp === 0xffffffff) { this.stamp.fill(0); this.closedStamp.fill(0); this.curStamp = 1 }
    const st = this.curStamp
    const nx = this.nx
    const tI = t % nx, tJ = (t / nx) | 0
    const hfun = (c: number) => {
      const di = Math.abs((c % nx) - tI), dj = Math.abs(((c / nx) | 0) - tJ)
      return hw * NAV_STEP * (Math.max(di, dj) + 0.41421356 * Math.min(di, dj))
    }
    this.heapN = 0
    this.g[s] = 0
    this.stamp[s] = st
    this.parent[s] = -1
    this.push(s, hfun(s))
    let expanded = 0
    let bestC = s, bestH = hfun(s)
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (this.heapN > 0) {
      const c = this.pop()
      if (this.closedStamp[c] === st) continue
      this.closedStamp[c] = st
      if (c === t) break
      const hc = hfun(c)
      if (hc < bestH) { bestH = hc; bestC = c }
      if (++expanded > maxExpand) break
      const I = c % nx, J = (c / nx) | 0
      const gc = this.g[c]
      const zc = this.z[c]
      for (let k = 0; k < 8; k++) {
        const I2 = I + DI[k], J2 = J + DJ[k]
        if (I2 < 0 || J2 < 0 || I2 >= nx || J2 >= this.ny) continue
        const n = J2 * nx + I2
        if (!this.walk[n] || this.closedStamp[n] === st) continue
        if (k >= 4 && (!this.walk[J * nx + I2] || !this.walk[J2 * nx + I])) continue
        const dz = this.z[n] - zc
        if (dz > this.stepUp + 1.0) continue
        let cost = k >= 4 ? NAV_STEP * 1.41421356 : NAV_STEP
        const cl = this.cellClear[n]
        if (cl < 4.5) cost += (4.5 - cl) * 0.6
        if (extra) cost += extra[n]
        if (zone) {
          const ex = this.x0 + I2 * NAV_STEP - zone[0], ey = this.y0 + J2 * NAV_STEP - zone[1]
          const out = Math.sqrt(ex * ex + ey * ey) - zone[2]
          if (out > 0) cost += 6 + out * 0.8
        }
        const ng = gc + cost
        if (this.stamp[n] !== st || ng < this.g[n]) {
          this.stamp[n] = st
          this.g[n] = ng
          this.parent[n] = c
          this.push(n, ng + hfun(n))
        }
      }
    }
    this.lastExpanded = expanded
    let end = this.closedStamp[t] === st ? t : bestC
    const path: number[] = []
    for (let c = end; c >= 0; c = this.parent[c]) {
      path.push(c)
      if (path.length > 100000) break
    }
    path.reverse()
    return path
  }

  // Dijkstra distance field from a start position (meters), limited by maxDist. Writes into out (Infinity if unreached).
  distanceField(sx: number, sy: number, out: Float32Array, maxDist = 400, extra: Float32Array | null = null) {
    out.fill(Infinity)
    const s = this.nearestWalkable(sx, sy, 30)
    if (s < 0) return
    this.heapN = 0
    out[s] = 0
    this.push(s, 0)
    const nx = this.nx
    const DI = [1, -1, 0, 0, 1, 1, -1, -1]
    const DJ = [0, 0, 1, -1, 1, -1, 1, -1]
    while (this.heapN > 0) {
      const f = this.heapF[0]
      const c = this.pop()
      if (f > out[c]) continue
      if (f > maxDist) break
      const I = c % nx, J = (c / nx) | 0
      const zc = this.z[c]
      for (let k = 0; k < 8; k++) {
        const I2 = I + DI[k], J2 = J + DJ[k]
        if (I2 < 0 || J2 < 0 || I2 >= nx || J2 >= this.ny) continue
        const n = J2 * nx + I2
        if (!this.walk[n]) continue
        if (k >= 4 && (!this.walk[J * nx + I2] || !this.walk[J2 * nx + I])) continue
        if (this.z[n] - zc > this.stepUp + 1.0) continue
        let cost = k >= 4 ? NAV_STEP * 1.41421356 : NAV_STEP
        if (extra) cost += extra[n]
        const nd = f + cost
        if (nd < out[n]) { out[n] = nd; this.push(n, nd) }
      }
    }
  }
}
