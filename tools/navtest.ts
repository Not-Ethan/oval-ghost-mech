import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
let t0 = performance.now()
const w = World.load("arena")
let t1 = performance.now()
const nav = new Nav(w)
let t2 = performance.now()
let nw = 0; for (let i = 0; i < nav.walk.length; i++) nw += nav.walk[i]
console.log(`world ${(t1-t0).toFixed(0)} ms, nav ${(t2-t1).toFixed(0)} ms, walkable ${nw}/${nav.walk.length}`)
// path timing
let tp = performance.now(); let len = 0
for (let k = 0; k < 20; k++) { const p = nav.findPath(-300 + k*10, -200, 400, 300 - k*10); len += p ? p.length : -1 }
console.log(`20 long paths ${(performance.now()-tp).toFixed(1)} ms total, avg cells ${len/20}`)
// ray timing
let tr = performance.now(); let blocked = 0
for (let k = 0; k < 10000; k++) { const ax = -400 + Math.random()*900, ay = -300 + Math.random()*650; const bx = ax + (Math.random()-0.5)*300, by = ay + (Math.random()-0.5)*300
  const az = w.groundHeight(ax, ay) + 8, bz = w.groundHeight(bx, by) + 4.5
  if (!w.sees(ax, ay, az, bx, by, bz, true)) blocked++ }
console.log(`10000 LOS ${(performance.now()-tr).toFixed(1)} ms, blocked ${blocked}`)
