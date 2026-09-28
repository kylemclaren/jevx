/** Draws the toolbar icons (a white ring with a dot, on near-black) as PNGs. No image deps. */
import { deflateSync } from "node:zlib"

function crc32(buf: Uint8Array) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(size: number) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  const ss = 4
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
        const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1
        const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1
        // rounded square background
        const q = Math.max(Math.abs(u), Math.abs(v))
        const rr = 0.36
        const dx = Math.max(Math.abs(u) - (1 - rr), 0), dy = Math.max(Math.abs(v) - (1 - rr), 0)
        const inside = q <= 1 && Math.hypot(dx, dy) <= rr
        if (!inside) continue
        bg++
        const d = Math.hypot(u, v)
        if ((d > 0.42 && d < 0.62) || d < 0.17) fg++
      }
      const n = ss * ss
      const a = bg / n, f = fg / Math.max(bg, 1)
      const shade = Math.round(16 + (250 - 16) * f)
      const i = y * (size * 4 + 1) + 1 + x * 4
      raw[i] = shade; raw[i + 1] = shade; raw[i + 2] = shade; raw[i + 3] = Math.round(a * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())])
}
for (const s of [16, 32, 48, 128]) await Bun.write(`public/icons/icon-${s}.png`, png(s))
