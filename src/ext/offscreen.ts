/** Offscreen document: hosts the SQLite worker and relays background requests to it. */
import type { DbOp } from "../lib/rpc"

type Reply = { ok: boolean; data?: unknown; error?: string }

let worker: Worker
const waiting = new Map<number, (reply: Reply) => void>()
let nextId = 1

/**
 * If the worker dies (WASM failed to load, OPFS lock lost, out of memory),
 * every pending call would otherwise wait forever and the queues would stall.
 * Fail them and start a fresh worker.
 */
function failAll(message: string) {
  for (const done of waiting.values()) done({ ok: false, error: message })
  waiting.clear()
}

function start() {
  worker = new Worker(new URL("../db/worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const done = waiting.get(e.data.id)
    if (!done) return
    waiting.delete(e.data.id)
    done(e.data.error ? { ok: false, error: e.data.error } : { ok: true, data: e.data.result })
  }
  worker.onerror = (e) => {
    console.error("[jevx] SQLite worker crashed", e.message)
    failAll(`Database worker crashed: ${e.message || "unknown error"}`)
    worker.terminate()
    setTimeout(start, 500)
  }
  worker.onmessageerror = () => failAll("Database worker sent an unreadable reply")
}
start()

chrome.runtime.onMessage.addListener((msg: { target?: string; op: DbOp; args: unknown[] }, sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false
  // Only the service worker may talk to the database directly. Content scripts
  // and dashboard tabs always carry sender.tab; the worker never does.
  if (sender.tab || sender.id !== chrome.runtime.id) return false
  const id = nextId++
  waiting.set(id, sendResponse)
  worker.postMessage({ id, op: msg.op, args: msg.args })
  return true
})
