// Feed a recorded stream to Brain in-process; report per-tick compute times and slow ticks.
import { Brain } from "../src/brain.ts"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
const file = process.argv[2] ?? "check/stream.jsonl.gz"
const lines = gunzipSync(readFileSync(file)).toString().split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "arena"
;(globalThis as any).__MF_SLOWLOG = (s: string) => console.log('  ' + s)
const b = new Brain({})
let t0 = performance.now()
b.hello(hello)
if (!process.env.NOWARM) b.warmup(hello, 700)
console.log(`hello ${(performance.now() - t0).toFixed(0)} ms`)
const times: number[] = []
const slow: string[] = []
for (const o of lines) {
  if (o.type !== "obs") continue
  const c0 = process.cpuUsage()
  b.act(o)
  const cu = process.cpuUsage(c0)
  const d = (cu.user + cu.system) / 1000
  times.push(d)
  if (d > 6) slow.push(`t=${o.t} ${d.toFixed(1)}ms mode=${b.mode} vis=${o.mechs.length} ${Object.entries(b.sec).map(([k, v]) => k + '=' + (v as number).toFixed(1)).join(' ')}`)
}
times.sort((x, y) => x - y)
const p = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(2)
console.log(`CPU ms n=${times.length} p50 ${p(0.5)} p90 ${p(0.9)} p99 ${p(0.99)} max ${p(1)}`)
console.log(slow.slice(0, 30).join("\n"))
