/**
 * The dashboard as a plain web page with fictional data, for UI work and
 * screenshots without loading the extension.
 *
 *   bun run build && bun run demo   →  http://localhost:4789
 */
import { cp, mkdir, rm } from "node:fs/promises"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { Store } from "../../src/lib/store"
import { demoTweets } from "./tweets"

const out = ".demo"
await rm(out, { recursive: true, force: true })
await mkdir(out)
await cp("dist", out, { recursive: true })
await cp("scripts/demo/mock.js", `${out}/mock.js`)

// Real store, real queries: the numbers on screen are what jevx would compute.
const sqlite3 = await sqlite3InitModule()
const store = new Store(new sqlite3.oo1.DB(":memory:", "c"))
const now = Date.now()
const { tweets, enrichments } = demoTweets(now)
store.ingest(tweets, "relay", now - 3 * 3_600_000)
store.saveEnrichment(enrichments)
store.saveVision(tweets[5].id, { description: "A rocket booster held by the launch tower's arms just after landing, with steam rising around the pad.", text: "", kind: "photo", addsInformation: true })
store.touchSeen([tweets[2].id, tweets[0].id, tweets[14].id], now - 5 * 60_000)
store.touchSeen([tweets[2].id], now - 60_000)
store.engage([
  { id: tweets[2].id, dwellMs: 42_000, clicks: { bookmark: 1 } },
  { id: tweets[0].id, dwellMs: 9_000, clicks: { like: 1 } },
  { id: tweets[14].id, dwellMs: 21_000, clicks: { open: 1 } },
])
const all = store.list({ limit: 500, hideCopies: false, hidePromoted: false }).tweets
await Bun.write(`${out}/data.json`, JSON.stringify({ all, stats: store.stats(30), authors: store.authors(50), storage: store.storage() }))

// Load the mock before the app.
const html = await Bun.file(`${out}/dashboard.html`).text()
const app = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/)
if (!app) throw new Error("dashboard.html: app script not found; run `bun run build` first")
await Bun.write(
  `${out}/dashboard.html`,
  html.replace(app[0], `<script src="mock.js"></script><script>addEventListener("chrome-mock-ready", () => { const s = document.createElement("script"); s.type = "module"; s.src = "${app[1]}"; document.body.append(s) }, { once: true })</script>`),
)

const port = Number(process.env.PORT ?? 4789)
Bun.serve({
  port,
  fetch(req) {
    const path = new URL(req.url).pathname
    return new Response(Bun.file(`${out}${path === "/" ? "/dashboard.html" : path}`))
  },
})
console.log(`jevx demo on http://localhost:${port}  (${all.length} fictional tweets)`)
