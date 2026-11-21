// Precompute map data into data/map.bin: node tools/precompute.ts [arenaDir] [outFile]
import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { computeCell } from "../src/cover.ts"
import { saveCache, loadCache, mapHashOf } from "../src/mapcache.ts"

const dir = process.argv[2] ?? "arena"
const out = process.argv[3] ?? "data/map.bin"
const t0 = Date.now()
const w = World.load(dir)
const nav = new Nav(w)
const n = nav.walk.length
const near = new Uint8Array(n), open = new Uint8Array(n)
let cnt = 0
for (let c = 0; c < n; c++) {
  if (!nav.walk[c]) continue
  const [a, b] = computeCell(w, nav, c)
  near[c] = Math.round(a * 255)
  open[c] = Math.round(b * 255)
  if (++cnt % 20000 === 0) console.error(`${cnt} cells, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
}
const hash = mapHashOf(dir)
saveCache(out, hash, { blockMax: w.blockMax, fz: nav.fz, clear: nav.clear, near, open })
const back = loadCache(out, hash)
if (!back) throw new Error("reload failed")
// verify the cached nav reproduces walkability closely
const nav2 = new Nav(w, 2.5, 9, 1.2, 50, { fz: back.fz, clear: back.clear })
let diff = 0
for (let c = 0; c < n; c++) if (nav.walk[c] !== nav2.walk[c]) diff++
console.error(`wrote ${out}: ${cnt} walkable of ${n} cells, walk diffs after quantization ${diff}, ${((Date.now() - t0) / 1000).toFixed(1)} s`)
