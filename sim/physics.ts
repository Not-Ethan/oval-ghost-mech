// Mech movement physics for the local simulator. Modeled on the client's shared world code
// (moveAndSlide / penetration), with protocol.md rules: trees do not block movement.
import { World, pointInEdges, closestOnEdges } from "../src/world.ts"

export type Body = { x: number; y: number; z: number; radius: number; height: number }
export type Pen = { depth: number; nx: number; ny: number }

const tmpPt = [0, 0]
const grad = [0, 0]

export function penetration(w: World, b: Body, x: number, y: number, stepUp: number, maxSlopeTan: number): Pen {
  const r: Pen = { depth: 0, nx: 0, ny: 0 }
  const rad = b.radius
  const lo = b.z + stepUp, hi = b.z + b.height
  const take = (d: number, nx: number, ny: number) => { if (d > r.depth) { r.depth = d; r.nx = nx; r.ny = ny } }
  w.forCells(x - rad, y - rad, x + rad, y + rad, (c) => {
    const list = w.gridPrisms[c]
    for (let k = 0; k < list.length; k++) {
      const p = w.prisms[list[k]]
      if (p.top <= lo || p.base >= hi || x + rad < p.minX || x - rad > p.maxX || y + rad < p.minY || y - rad > p.maxY) continue
      const d = closestOnEdges(p.edges, x, y, tmpPt)
      if (pointInEdges(p.edges, x, y)) {
        const ax = tmpPt[0] - x, ay = tmpPt[1] - y
        const l = Math.hypot(ax, ay) || 1e-9
        take(l + rad, ax / l, ay / l)
      } else if (d < rad) {
        const dd = d || 1e-9
        take(rad - d, (x - tmpPt[0]) / dd, (y - tmpPt[1]) / dd)
      }
    }
  })
  if (w.groundHeight(x, y) > lo) {
    w.groundGradient(x, y, grad)
    const g = Math.hypot(grad[0], grad[1])
    if (g > 0.001) {
      const ux = -grad[0] / g, uy = -grad[1] / g
      let u = 0
      while (u < 2 * rad && w.groundHeight(x + ux * u, y + uy * u) > lo) u += 0.25
      take(Math.max(u, 0.05), ux, uy)
    }
  }
  take(w.minX + rad - x, 1, 0)
  take(x + rad - w.maxX, -1, 0)
  take(w.minY + rad - y, 0, 1)
  take(y + rad - w.maxY, 0, -1)
  return r
}

export type MoveResult = { x: number; y: number; z: number; grounded: boolean; stoppedZ: boolean; hitWall: boolean }

export function moveAndSlide(w: World, b: Body, dx: number, dy: number, dz: number, stepUp: number, maxSlopeTan: number): MoveResult {
  let x = b.x, y = b.y, z = b.z
  const rad = b.radius
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (rad * 0.4)))
  const sx = dx / n, sy = dy / n
  let hitWall = false
  const body = { x, y, z, radius: rad, height: b.height }
  for (let i = 0; i < n; i++) {
    x += sx; y += sy
    for (let k = 0; k < 4; k++) {
      body.x = x; body.y = y; body.z = z
      const p = penetration(w, body, x, y, stepUp, maxSlopeTan)
      if (p.depth <= 1e-4) break
      x += p.nx * (p.depth + 0.001); y += p.ny * (p.depth + 0.001)
      hitWall = true
    }
    const s = w.surfaceHeight(x, y, z + stepUp)
    if (s > z && dz <= 0) z = s
  }
  let grounded = false, stoppedZ = false
  const surf = w.surfaceHeight(x, y, z + stepUp)
  let nz = z + dz
  if (dz > 0) {
    const ceil = w.ceilingAbove(x, y, z + b.height, rad)
    if (nz + b.height > ceil) { nz = ceil - b.height; stoppedZ = true }
  }
  if (nz <= surf + 1e-4) {
    nz = surf; grounded = true
    if (dz < 0) stoppedZ = true
  } else if (dz <= 0 && nz - surf <= 0.75 && b.z - w.surfaceHeight(b.x, b.y, b.z + 0.01) < 0.05) {
    nz = surf; grounded = true
  }
  return { x, y, z: nz, grounded, stoppedZ, hitWall }
}
