// Render one traced match window to SVG: node sim/viz.ts trace.json <seed> <t0> <t1> out.svg
// (trace from: node sim/run.ts --bot=mine --matches=N --seed=S --trace=trace.json)
// Blue: our mech (dots every 1 s, coloured by mode). Red: hunters. Grey: idle squad members. Buildings in grey.
import { readFileSync, writeFileSync } from "node:fs"

const [file, seedS, t0S, t1S, out] = process.argv.slice(2)
const T = JSON.parse(readFileSync(file, "utf8"))
const M = T.find((m: any) => String(m.seed) === seedS)
if (!M) throw new Error("seed not in trace")
const t0 = Number(t0S), t1 = Number(t1S)
const frames = M.frames.filter((f: any) => f.t >= t0 && f.t <= t1)
const me = M.ours[0]
const pts: number[][] = []
for (const f of frames) for (const m of f.m) if (m[0] === me) pts.push([m[1], m[2]])
const R = Number(process.env.VIZ_R ?? 110) // half-size of the view around our track
let minX = Math.min(...pts.map((p) => p[0])) - R, maxX = Math.max(...pts.map((p) => p[0])) + R
let minY = Math.min(...pts.map((p) => p[1])) - R, maxY = Math.max(...pts.map((p) => p[1])) + R
const W = 900, S = W / Math.max(maxX - minX, maxY - minY)
const H = Math.round((maxY - minY) * S)
const X = (x: number) => ((x - minX) * S).toFixed(1), Y = (y: number) => ((maxY - y) * S).toFixed(1)
const world = JSON.parse(readFileSync("arena/v2/world.json", "utf8"))
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="11"><rect width="${W}" height="${H}" fill="#fafaf7"/>`
for (const p of world.prisms) {
  const r = p.ring
  let inside = false
  for (let i = 0; i < r.length; i += 2) if (r[i] > minX && r[i] < maxX && r[i + 1] > minY && r[i + 1] < maxY) { inside = true; break }
  if (!inside) continue
  const d = []
  for (let i = 0; i < r.length; i += 2) d.push(`${X(r[i])},${Y(r[i + 1])}`)
  svg += `<polygon points="${d.join(" ")}" fill="${p.kind === "bridge" ? "#ddd" : "#bbb"}" stroke="#999" stroke-width="0.5"/>`
}
const ids = new Set<number>()
for (const f of frames) for (const m of f.m) ids.add(m[0])
const MODEC: Record<string, string> = { fight: "#1f5fd6", evade: "#9b30d9", harvest: "#18a058", loot: "#18a058", relocate: "#e08a00", alert: "#e0c000", zone: "#555", hold: "#88a" }
for (const id of ids) {
  const path: any[] = []
  for (const f of frames) { const m = f.m.find((q: any) => q[0] === id); if (m) path.push([f.t, ...m]) }
  if (!path.length) continue
  const isMe = id === me
  const hunter = path.some((p) => p[6])
  if (!isMe && !hunter) {
    const near = path.some((p) => pts.some((q) => Math.hypot(q[0] - p[2], q[1] - p[3]) < 120))
    if (!near) continue
  }
  const col = isMe ? "#1f5fd6" : hunter ? "#d62f2f" : "#aaa"
  svg += `<polyline fill="none" stroke="${col}" stroke-width="${isMe ? 2 : 1.2}" stroke-opacity="0.8" points="${path.map((p) => `${X(p[2])},${Y(p[3])}`).join(" ")}"/>`
  for (const p of path) {
    if (Math.abs(p[0] * 2 - Math.round(p[0] * 2)) > 0.01 || Math.round(p[0] * 10) % 10 !== 0) continue
    const c = isMe ? (MODEC[frames.find((f: any) => f.t === p[0])?.mode] ?? "#1f5fd6") : col
    svg += `<circle cx="${X(p[2])}" cy="${Y(p[3])}" r="${isMe ? 3 : 2}" fill="${c}"/>`
    if (Math.round(p[0]) % 5 === 0) svg += `<text x="${Number(X(p[2])) + 4}" y="${Number(Y(p[3])) - 3}" fill="${col}">${Math.round(p[0])}${isMe ? " " + p[4] : ""}</text>`
  }
  const last = path[path.length - 1]
  const tag = isMe ? "US" : `${id}${({ easy: "E", medium: "M", hard: "H", expert: "X" } as any)[String(last[5]).replace("house-", "")] ?? "?"}${last[0] < t1 - 0.6 ? "†" : ""}`
  svg += `<text x="${Number(X(last[2])) + 5}" y="${Number(Y(last[3])) + 12}" font-weight="bold" fill="${col}">${tag} ${last[4]}hp</text>`
}
let ly = 14
for (const [k, v] of Object.entries(MODEC)) { svg += `<circle cx="10" cy="${ly - 4}" r="4" fill="${v}"/><text x="18" y="${ly}">${k}</text>`; ly += 14 }
svg += `<text x="${W - 260}" y="14">seed ${seedS}  t ${t0}-${t1}s  10 m = ${(10 * S).toFixed(0)} px</text></svg>`
writeFileSync(out, svg)
console.log("wrote", out, W, H)
