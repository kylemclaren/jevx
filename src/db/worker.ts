/**
 * The SQLite owner. Runs in a dedicated worker inside the offscreen document,
 * the one place in an MV3 extension that can hold an OPFS sync access handle.
 * The opfs-sahpool VFS needs no COOP/COEP headers.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { DB_OPS, type DbOp } from "../lib/rpc"
import { Store } from "../lib/store"

const allowed = new Set<string>(DB_OPS)

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule()
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "jevx" })
    const db = new pool.OpfsSAHPoolDb("/jevx.sqlite3")
    db.exec("PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL;")
    console.info(`[jevx] SQLite ${sqlite3.version.libVersion} on OPFS (${db.filename})`)
    return new Store(db)
  } catch (err) {
    // Never lose the session: fall back to memory and say so loudly.
    console.error("[jevx] OPFS unavailable, using an in-memory database", err)
    return new Store(new sqlite3.oo1.DB(":memory:", "c"))
  }
})()

self.onmessage = async (e: MessageEvent<{ id: number; op: DbOp; args: unknown[] }>) => {
  const { id, op, args } = e.data
  try {
    if (!allowed.has(op)) throw new Error(`Unknown op ${op}`)
    const store = await ready
    const fn = store[op] as (...a: unknown[]) => unknown
    let result = fn.apply(store, args ?? [])
    // The size report also carries what the browser says about our origin's quota.
    if (op === "storage" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate().catch(() => undefined)
      if (est) (result as { quota?: unknown }).quota = { usage: est.usage ?? 0, quota: est.quota ?? 0 }
    }
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
