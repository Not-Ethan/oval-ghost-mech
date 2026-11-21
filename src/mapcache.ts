// Precomputed map data (terrain block maxima, nav rasters, cover metrics) in data/map.bin.
// Validated against a SHA-1 of the live map files; on mismatch everything is recomputed.
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { createHash } from "node:crypto"

export type MapCache = {
  blockMax: Float32Array
  fz: Float32Array
  clear: Float32Array
  near: Uint8Array
  open: Uint8Array
}

export function mapHashOf(dir: string): string {
  const h = createHash("sha1")
  h.update(readFileSync(dir + "/v2/world.json"))
  h.update(readFileSync(dir + "/v2/terrain.i16"))
  return h.digest("hex")
}

const MAGIC = "MRMAP2"

export function saveCache(file: string, hash: string, c: MapCache) {
  const fzCm = new Int16Array(c.fz.length)
  for (let i = 0; i < c.fz.length; i++) fzCm[i] = Math.round(c.fz[i] * 100)
  const clDm = new Uint8Array(c.clear.length)
  for (let i = 0; i < c.clear.length; i++) clDm[i] = Math.min(255, Math.floor(c.clear[i] * 10))
  const parts: Buffer[] = []
  const head = Buffer.from(JSON.stringify({ magic: MAGIC, hash, n: { bm: c.blockMax.length, fz: c.fz.length, cell: c.near.length } }))
  const hl = Buffer.alloc(4)
  hl.writeUInt32LE(head.length)
  parts.push(hl, head)
  parts.push(Buffer.from(c.blockMax.buffer, c.blockMax.byteOffset, c.blockMax.byteLength))
  parts.push(Buffer.from(fzCm.buffer))
  parts.push(Buffer.from(clDm.buffer))
  parts.push(Buffer.from(c.near.buffer, c.near.byteOffset, c.near.byteLength))
  parts.push(Buffer.from(c.open.buffer, c.open.byteOffset, c.open.byteLength))
  writeFileSync(file, gzipSync(Buffer.concat(parts), { level: 9 }))
}

export function loadCache(file: string, hash: string): MapCache | null {
  try {
    if (!existsSync(file)) return null
    const raw = gunzipSync(readFileSync(file))
    const hl = raw.readUInt32LE(0)
    const head = JSON.parse(raw.subarray(4, 4 + hl).toString("utf8"))
    if (head.magic !== MAGIC || head.hash !== hash) return null
    let off = 4 + hl
    const take = (bytes: number) => {
      const out = new Uint8Array(bytes)
      out.set(raw.subarray(off, off + bytes))
      off += bytes
      return out.buffer
    }
    const blockMax = new Float32Array(take(head.n.bm * 4))
    const fzCm = new Int16Array(take(head.n.fz * 2))
    const clDm = new Uint8Array(take(head.n.fz))
    const near = new Uint8Array(take(head.n.cell))
    const open = new Uint8Array(take(head.n.cell))
    const fz = new Float32Array(head.n.fz)
    const clear = new Float32Array(head.n.fz)
    for (let i = 0; i < fz.length; i++) { fz[i] = fzCm[i] * 0.01; clear[i] = clDm[i] * 0.1 }
    return { blockMax, fz, clear, near, open }
  } catch {
    return null
  }
}
