import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
const w = World.load("arena")
const nav = new Nav(w)
for (let rep = 0; rep < 3; rep++) {
  let tp = performance.now(); let len = 0; let worst = 0
  for (let k = 0; k < 40; k++) { const a = performance.now(); const p = nav.findPath(-300 + k*10, -200, 400, 300 - k*10); len += p ? p.length : -1; worst = Math.max(worst, performance.now()-a) }
  console.log(`40 long paths ${(performance.now()-tp).toFixed(1)} ms total, worst ${worst.toFixed(1)}, avg cells ${len/40}`)
}
const df = new Float32Array(nav.walk.length)
let a = performance.now(); nav.distanceField(0, 0, df, 400); console.log('dfield 400m', (performance.now()-a).toFixed(1))
a = performance.now(); nav.distanceField(0, 0, df, 150); console.log('dfield 150m', (performance.now()-a).toFixed(1))
