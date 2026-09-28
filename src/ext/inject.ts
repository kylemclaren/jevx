/**
 * Runs in x.com's own JS world at document_start and posts tweets to the
 * content script. It never changes a request or a response.
 *
 * Two sources, because X changes how data arrives:
 *  1. X's Relay store (the web app since 2026, TanStack Router + Relay). This
 *     holds everything on screen, including the first page, which is
 *     preloaded server-side and never crosses the network.
 *  2. A fetch/XHR tap on X's API hosts, for the older GraphQL web app and as
 *     a backup.
 * Every JSON API response is also counted for Settings → Capture.
 */
import { extractFromRelay, extractTweets, operationName, type RelaySource } from "../lib/extract"
import type { CapturedTweet } from "../lib/types"

function post(tweets: CapturedTweet[], source: string) {
  if (tweets.length > 0) window.postMessage({ __jevx: "tweets", tweets, source }, location.origin)
}

function report(source: string, count: number, matched: boolean, path: string) {
  window.postMessage({ __jevx: "seen", source, count, matched, path }, location.origin)
}

// ── 1. Relay store ────────────────────────────────────────────────────────

interface RelayEnv {
  getStore(): { getSource(): RelaySource; notify?: (...a: unknown[]) => unknown }
}

function findRelay(): RelayEnv | undefined {
  const router = (window as unknown as { __TSR_ROUTER__?: { state?: { matches?: { context?: { relayEnvironment?: RelayEnv } }[] } } }).__TSR_ROUTER__
  return router?.state?.matches?.find((m) => m.context?.relayEnvironment)?.context?.relayEnvironment
}

/** Record ids already turned into tweets (or given up on). */
const doneRecords = new Set<string>()
/** Tweet records that were still partial; retried a few times as the page fills them in. */
const attempts = new Map<string, number>()
let hookedStore: unknown
let scanTimer: ReturnType<typeof setTimeout> | undefined
let relayReported = false

function scanRelay() {
  const env = findRelay()
  if (!env) return
  const store = env.getStore()
  const source = store.getSource()
  if (!relayReported) {
    relayReported = true
    report("relay-store", 0, true, location.hostname)
  }
  // Scan soon after X writes to the store, not only on the timer.
  if (hookedStore !== store && typeof store.notify === "function") {
    hookedStore = store
    const notify = store.notify.bind(store)
    store.notify = (...args: unknown[]) => {
      const r = notify(...args)
      clearTimeout(scanTimer)
      scanTimer = setTimeout(scanRelay, 250)
      return r
    }
  }

  const fresh = new Set<string>()
  for (const id of source.getRecordIDs()) {
    if (doneRecords.has(id)) continue
    const t = source.get(id)?.__typename
    if (t === "Tweet" || t === "TimelineTweet") fresh.add(id)
    else doneRecords.add(id)
  }
  if (fresh.size === 0) return
  let tweets: CapturedTweet[] = []
  try {
    tweets = extractFromRelay(source, (id) => fresh.has(id))
  } catch (err) {
    console.debug("[jevx] could not read the Relay store", err)
    return
  }
  const got = new Set(tweets.map((t) => t.id))
  for (const id of fresh) {
    const record = source.get(id)
    const restId = record?.rest_id
    // Timeline items are done once seen; tweet records once they yielded a tweet, or after a few tries.
    if (record?.__typename === "TimelineTweet" || (restId && got.has(restId)) || (attempts.get(id) ?? 0) >= 4) {
      doneRecords.add(id)
      attempts.delete(id)
    } else attempts.set(id, (attempts.get(id) ?? 0) + 1)
  }
  post(tweets, "relay")
  report("relay", tweets.length, true, "relay-store")
}

setInterval(scanRelay, 2000)

// ── 2. Network tap ────────────────────────────────────────────────────────

const X_HOST = /(^|\.)(x|twitter)\.com$/
/** GraphQL on any X host and path: /i/api/graphql/<id>/<Op>, api.x.com/graphql/<id>/<Op>, … */
const GRAPHQL = /\/graphql\/[A-Za-z0-9_-]+\/[A-Za-z0-9_]+/
const API = /\/i\/api\/|\/1\.1\/|\/2\//

interface Target {
  url: string
  isGraphql: boolean
  watched: boolean
  path: string
}

function classify(raw: string): Target | undefined {
  let u: URL
  try {
    u = new URL(raw, location.href)
  } catch {
    return undefined
  }
  if (!X_HOST.test(u.hostname)) return undefined
  const isGraphql = GRAPHQL.test(u.pathname)
  // Numbers and long tokens out, so one endpoint groups together in diagnostics.
  const path = `${u.hostname}${u.pathname.replace(/\/\d+/g, "/:n").replace(/\/[A-Za-z0-9_-]{16,}/g, "/:id")}`
  return { url: u.href, isGraphql, watched: isGraphql || API.test(u.pathname), path }
}

function deliver(target: Target, body: unknown) {
  const source = target.isGraphql ? operationName(target.url) : target.path
  let count = 0
  try {
    const tweets = extractTweets(body)
    count = tweets.length
    post(tweets, source)
  } catch (err) {
    console.debug("[jevx] could not read", target.url, err)
  }
  report(source, count, target.watched, target.path)
}

function deliverText(target: Target, text: string) {
  const t = text.trimStart()
  if (!t || (t[0] !== "{" && t[0] !== "[")) return
  try {
    deliver(target, JSON.parse(t))
  } catch {
    // Not JSON after all.
  }
}

const decoder = new TextDecoder()

const originalFetch = window.fetch
window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
  const res = await originalFetch.apply(this, args)
  try {
    const input = args[0]
    const target = classify(typeof input === "string" ? input : input instanceof Request ? input.url : String(input))
    const json = /json/i.test(res.headers.get("content-type") ?? "")
    if (target && res.ok && (target.watched || json)) void res.clone().text().then((t) => deliverText(target, t), () => {})
  } catch {
    // Never break the page.
  }
  return res
} as typeof fetch

const urls = new WeakMap<XMLHttpRequest, string>()
const originalOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
  urls.set(this, String(args[1]))
  return (originalOpen as (...a: unknown[]) => void).apply(this, args)
} as typeof XMLHttpRequest.prototype.open

const originalSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>) {
  const target = classify(urls.get(this) ?? "")
  if (target) {
    this.addEventListener("load", () => {
      try {
        if (this.status < 200 || this.status >= 300) return
        const json = /json/i.test(this.getResponseHeader("content-type") ?? "")
        if (!target.watched && !json) return
        const r = this.response
        if (this.responseType === "" || this.responseType === "text") deliverText(target, this.responseText)
        else if (this.responseType === "json") r != null && deliver(target, r)
        else if (this.responseType === "arraybuffer" && r) deliverText(target, decoder.decode(r as ArrayBuffer))
        else if (this.responseType === "blob" && r) void (r as Blob).text().then((t) => deliverText(target, t), () => {})
      } catch {
        // Never break the page.
      }
    })
  }
  return originalSend.apply(this, args)
}

// Proof of life for the Capture panel: the tap is installed on this page.
report("tap-installed", 0, true, location.hostname)
