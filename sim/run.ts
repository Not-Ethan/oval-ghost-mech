// Local match runner: practice (our bot vs a 15-bot house squad) or ffa (all non-squad).
import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { Sim, rng, type Controller } from "./engine.ts"
import { HouseBot, Squad, SKILLS, ExampleBot } from "./house.ts"
import { readFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { writeFileSync } from "node:fs"

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"] }))
const N = Number(args.matches ?? 4)
const seed0 = Number(args.seed ?? 1)
const mode = args.mode ?? "practice"
const botKind = args.bot ?? "example"
const verbose = !!args.v

if (args.slow) (globalThis as any).__MF_SLOWLOG = (s: string) => console.log(s)
const w = World.load("arena")
const nav = new Nav(w)
const stream = gunzipSync(readFileSync("check/stream.jsonl.gz")).toString().split("\n").filter((l) => l.trim())
const cfg = JSON.parse(stream[0]).config
if (args.nonpc) cfg.npc.count = 0

async function makeBot(kind: string): Promise<Controller> {
  if (kind === "example") return new ExampleBot()
  const mod = await import("../src/brain.ts")
  const b = new mod.Brain({ world: w, nav, debug: verbose, params: args.params ? JSON.parse(args.params) : undefined })
  lastBrains.push(b)
  return { name: "mine", squad: false, hello: (h: any) => { if (args.record) recLines.push(JSON.stringify(h)); b.hello(h) }, end: (m: any) => { if (args.record) recLines.push(JSON.stringify(m)) }, act: (o: any) => { if (args.record) recLines.push(JSON.stringify(o)); const r = b.act(o); if (verbose && b.dbg.length) console.log(b.dbg.join("\n")); return r } }
}

const scores: number[] = []
const lastBrains: any[] = []
const recLines: string[] = []
let maxMs = 0
const allRes: any[] = []
for (let k = 0; k < N; k++) {
  const seed = seed0 + k
  const R = rng(seed * 7919)
  const ctrls: Controller[] = []
  let ours: number[] = []
  if (mode === "practice") {
    const sq = new Squad()
    const tiers = [...Array(4).fill("easy"), ...Array(4).fill("medium"), ...Array(4).fill("hard"), ...Array(3).fill("expert")]
    const slot = Math.floor(R() * 16)
    let ti = 0
    for (let i = 0; i < 16; i++) {
      if (i === slot) { ctrls.push(await makeBot(botKind)); ours.push(i) }
      else ctrls.push(new HouseBot(w, nav, sq, SKILLS[tiers[ti++]], seed * 100 + i))
    }
  } else if (mode === "solo") {
    const slot = Math.floor(R() * 16)
    for (let i = 0; i < 16; i++) {
      if (i === slot) { ctrls.push(await makeBot(botKind)); ours.push(i) }
      else if (args.follow) {
        let path: number[] | null = null, pt = -99
        ctrls.push({ name: "follower", squad: true, hello() {}, act: (o: any) => {
          const [x, y] = o.self.pos, g = o.zone.next_center
          if (!path || o.t - pt > 3) { path = nav.findPath(x, y, g[0], g[1], null, 6000); pt = o.t }
          let tx = g[0], ty = g[1]
          if (path && path.length > 3) { tx = nav.cx(path[3]); ty = nav.cy(path[3]); if (Math.hypot(tx - x, ty - y) < 3) path.splice(0, 2) }
          const d = Math.hypot(tx - x, ty - y)
          const inner = Math.hypot(x - g[0], y - g[1]) < o.zone.next_radius * 0.5
          return { tick: o.tick, move: d > 1 && !inner ? [(tx - x) / d, (ty - y) / d] : [0, 0] }
        } })
      }
      else ctrls.push({ name: "dummy", squad: true, hello() {}, act: (o: any) => ({ tick: o.tick, move: [0, 0] }) })
    }
  } else {
    for (let i = 0; i < 16; i++) { ctrls.push(await makeBot(i % 2 === 0 ? botKind : (args.opp ?? "example"))); if (i % 2 === 0) ours.push(i) }
  }
  const t0 = performance.now()
  const sim = new Sim(w, nav, cfg, seed, ctrls)
  sim.verbose = verbose
  const res = sim.run()
  const ms = performance.now() - t0
  for (const i of ours) scores.push(16 - res.places[i])
  for (const b of lastBrains) maxMs = Math.max(maxMs, b.timeStats.max)
  const avgMs = lastBrains.length ? lastBrains.reduce((s, b) => s + b.timeStats.sum / Math.max(1, b.timeStats.n), 0) / lastBrains.length : 0
  lastBrains.length = 0
  const i0 = ours[0]
  const hk = res.places.map((p, i) => i).filter((i) => !ours.includes(i))
  console.log(`match ${k} seed ${seed}: place ${ours.map((i) => res.places[i]).join(",")} kills ${ours.map((i) => res.kills[i]).join(",")} death ${ours.map((i) => res.deathT[i].toFixed(0)).join(",")} dealt ${res.dmgDealt[i0]} taken ${res.dmgTaken[i0]} | end t=${res.t.toFixed(0)} houseDead=${hk.filter((i) => res.deathT[i] >= 0).length} acc ${res.acc[i0]} houseAcc ${hk.map((i) => res.acc[i]).filter((a) => !a.startsWith('0/0')).slice(0, 4).join(' ')} (${(ms / 1000).toFixed(1)}s) act avg ${avgMs.toFixed(2)}ms max ${maxMs.toFixed(1)}ms`)
}
if (args.record) { writeFileSync(args.record, gzipSync(recLines.join("\n") + "\n")); console.log(`recorded ${recLines.length} lines to ${args.record}`) }
const mean = scores.reduce((a, b) => a + b, 0) / scores.length
console.log(`MEAN score ${mean.toFixed(2)} over ${scores.length}`)
