// mechfight/1 stdin/stdout loop. Answers only the newest observation, never lets an exception
// escape, and always emits a valid action echoing the tick.
import { Brain } from "./brain.ts"

const log = (...a: unknown[]) => { try { process.stderr.write(a.map(String).join(" ") + "\n") } catch {} }
const send = (o: unknown) => { process.stdout.write(JSON.stringify(o) + "\n") }

let brain: Brain | null = null
let buf = ""
let queued = false
let errors = 0
let lastMove: [number, number] = [0, 0]
let lastAim: [number, number] | null = null

function fallback(tick: number) {
  const a: any = { tick, move: lastMove }
  if (lastAim) a.aim = lastAim
  return a
}

function sanitize(a: any, tick: number): any {
  const out: any = { tick }
  const num = (v: any) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  if (Array.isArray(a.move)) {
    let x = num(a.move[0]), y = num(a.move[1])
    const l = Math.hypot(x, y)
    if (l > 1) { x /= l; y /= l }
    out.move = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]
  }
  if (Array.isArray(a.aim)) out.aim = [Math.round(num(a.aim[0]) * 10000) / 10000, Math.round(num(a.aim[1]) * 10000) / 10000]
  if (a.boost) out.boost = true
  if (a.jump) out.jump = true
  if (Array.isArray(a.fire)) out.fire = [!!a.fire[0], !!a.fire[1]]
  if (a.reload) out.reload = true
  if (Number.isInteger(a.pick) && a.pick >= 0 && a.pick <= 2) out.pick = a.pick
  if (Number.isInteger(a.take)) out.take = a.take
  if (Number.isInteger(a.drop) && (a.drop === 0 || a.drop === 1)) out.drop = a.drop
  if (a.debug && typeof a.debug === "object") out.debug = a.debug
  return out
}

function handle(lines: string[]) {
  let latest: any = null
  for (const line of lines) {
    let msg: any
    try { msg = JSON.parse(line) } catch { continue }
    if (!msg || typeof msg !== "object") continue
    if (msg.type === "hello") {
      const t0 = Date.now()
      try {
        brain = new Brain({})
        brain.hello(msg)
        brain.warmup(msg, 700)
        const g = (globalThis as any).gc
        if (typeof g === "function") g()
      } catch (e) {
        log("hello failed:", (e as any)?.stack ?? e)
        brain = null
      }
      log(`ready after ${Date.now() - t0} ms`)
      send({ type: "ready", name: "oval-ghost" })
    } else if (msg.type === "obs") latest = msg
    else if (msg.type === "end") {
      log(`end: place ${msg.place} kills ${msg.kills}`)
      process.exit(0)
    }
  }
  if (!latest) return
  const tick = latest.tick
  let action: any
  try {
    action = brain ? sanitize(brain.act(latest), tick) : fallback(tick)
    if (action.move) lastMove = action.move
    if (action.aim) lastAim = action.aim
  } catch (e) {
    errors++
    if (errors <= 5 || errors % 100 === 0) log(`act failed at tick ${tick} (${errors}):`, (e as any)?.stack ?? e)
    action = fallback(tick)
  }
  send(action)
}

function flush() {
  queued = false
  const lines = buf.split("\n")
  buf = lines.pop() ?? ""
  const ls = lines.filter((l) => l.trim())
  if (ls.length) handle(ls)
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buf += chunk
  if (queued) return
  queued = true
  setImmediate(flush)
})
process.stdin.on("end", () => { buf += "\n"; flush(); process.exit(0) })
process.on("uncaughtException", (e) => { log("uncaught:", (e as any)?.stack ?? e) })
