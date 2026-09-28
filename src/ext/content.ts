/**
 * Isolated-world content script on x.com.
 *  1. Relays tweets from the network tap to the background.
 *  2. Draws a small row of Jev chips under each tweet and, if asked, fades
 *     low-signal or bait tweets.
 *  3. Measures your attention: how long each tweet sits at your reading
 *     position, and what you click on it. Stays on this machine.
 */
import type { ClickCounts, ClickKind, EngagementEvent } from "../lib/engagement"
import type { Broadcast } from "../lib/rpc"
import { DEFAULT_SETTINGS, FLAGS, type Settings } from "../lib/settings"
import type { BadgeInfo } from "../lib/store"
import type { CapturedTweet } from "../lib/types"

// ── relay ─────────────────────────────────────────────────────────────────

let queue: CapturedTweet[] = []
let queueSource = "unknown"
let flushTimer: ReturnType<typeof setTimeout> | undefined

/** Responses the tap saw on this page, for the diagnostics in Settings. */
const seen = { responses: 0, empty: 0, lastEmptySource: "" }
let seenDirty = false

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window) return
  if (e.data?.__jevx === "seen") {
    seen.responses++
    // Timelines and threads should always carry tweets; an empty one means X changed shape.
    if (!e.data.count && /Timeline|TweetDetail|Tweets|Bookmarks|Likes|Search/i.test(String(e.data.source))) {
      seen.empty++
      seen.lastEmptySource = String(e.data.source).slice(0, 64)
    }
    seenDirty = true
    return
  }
  if (e.data?.__jevx !== "tweets" || !Array.isArray(e.data.tweets)) return
  const source = String(e.data.source)
  for (const t of e.data.tweets as CapturedTweet[]) {
    if (!settings.indexOnlySeen || fellBack) {
      enqueue(t, source)
      continue
    }
    // Hold it until it's actually on screen; newer data for the same tweet replaces older.
    buffer.delete(t.id)
    buffer.set(t.id, { tweet: t, source, at: Date.now() })
    if (everSeen.has(t.id)) release(t.id)
  }
  trimBuffer()
})

// ── seen before stored ────────────────────────────────────────────────────
// X loads tweets well ahead of the screen (the next page, quoted tweets,
// threads). Captured tweets wait here and are stored only once they have
// been on screen long enough to be read; see SEEN_MS in the attention code.

const buffer = new Map<string, { tweet: CapturedTweet; source: string; at: number }>()
/** Tweets that have been on screen on this page, so data arriving later is stored at once. */
const everSeen = new Set<string>()
const BUFFER_MAX = 3000
const BUFFER_TTL = 30 * 60_000
let released = 0
/** True once we gave up waiting for sightings on this page (see the fail-safe below). */
let fellBack = false
let articlesEverFound = 0

function trimBuffer() {
  const cutoff = Date.now() - BUFFER_TTL
  for (const [id, e] of buffer) {
    if (buffer.size <= BUFFER_MAX && e.at >= cutoff) break
    buffer.delete(id)
  }
}

/** Store a tweet you've now seen, and the tweet it quotes, which was on screen inside it. */
function release(id: string) {
  const entry = buffer.get(id)
  if (!entry) return
  buffer.delete(id)
  released++
  enqueue(entry.tweet, entry.source)
  if (entry.tweet.quotedId) release(entry.tweet.quotedId)
}

function enqueue(tweet: CapturedTweet, source: string) {
  if (queue.length > 0 && source !== queueSource) flush()
  queueSource = source
  queue.push(tweet)
  clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, 250)
}

/**
 * Fail-safe: if tweets keep arriving but no tweet element has ever been found
 * on this page, X has changed its markup and "seen" can't be measured. Store
 * everything rather than silently store nothing, and say so in Settings.
 */
setInterval(() => {
  if (fellBack || !settings.indexOnlySeen || articlesEverFound > 0 || buffer.size < 40) return
  fellBack = true
  console.warn("[jevx] can't find tweets on the page; storing everything loaded instead of only what was seen")
  for (const id of [...buffer.keys()]) release(id)
  seenDirty = true
}, 15_000)

/** The background keeps at most 500 per message, so a long scroll goes in chunks. */
const CHUNK = 400

function flush() {
  if (queue.length === 0) return
  const tweets = queue
  queue = []
  for (let i = 0; i < tweets.length; i += CHUNK) {
    chrome.runtime.sendMessage({ type: "ingest", tweets: tweets.slice(i, i + CHUNK), source: queueSource }).catch(() => {
      // Extension reloaded under us; the page needs a refresh to reconnect.
    })
  }
}

setInterval(() => {
  if (!seenDirty) return
  seenDirty = false
  chrome.runtime.sendMessage({ type: "tapStats", ...seen, waiting: buffer.size, released, fellBack }).catch(() => {})
}, 10_000)

// ── inline badges ─────────────────────────────────────────────────────────

let settings: Settings = DEFAULT_SETTINGS
const known = new Map<string, BadgeInfo | null>()
const wanted = new Set<string>()
let lookupTimer: ReturnType<typeof setTimeout> | undefined

chrome.storage.local.get("settings").then(({ settings: s }) => {
  settings = { ...DEFAULT_SETTINGS, ...(s as Partial<Settings>) }
  scan()
})
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings>) }
    // Switched to "index everything": store what was waiting for a sighting.
    if (!settings.indexOnlySeen) for (const id of [...buffer.keys()]) release(id)
    document.querySelectorAll(".jevx-row").forEach((el) => el.remove())
    document.querySelectorAll("article[data-jevx]").forEach((el) => el.removeAttribute("data-jevx"))
    scan()
  }
})

chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  if (msg?.type !== "badges") return
  for (const [id, info] of Object.entries(msg.data)) known.set(id, info)
  scan()
})

/**
 * The tweet an <article> shows.
 *  - X web 2026: plain <article>s; the reply button links to the tweet.
 *  - Older X: the timestamp links to the tweet.
 * Quote cards nested inside a tweet are skipped, so chips aren't drawn twice.
 */
function tweetId(article: Element): string | undefined {
  if (article.parentElement?.closest("article")) return undefined
  const href =
    article.querySelector("[data-engagement-action='reply'] a[href*='/status/']")?.getAttribute("href") ??
    article.querySelector("a[href*='/status/'] time")?.closest("a")?.getAttribute("href") ??
    [...article.querySelectorAll("a[href*='/status/']")].map((a) => a.getAttribute("href") ?? "").find((h) => /^\/\w{1,15}\/status\/\d+\/?$/.test(h))
  return href?.match(/\/status\/(\d+)/)?.[1]
}

function tweetArticles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("article")].filter((a) => tweetId(a) != null)
}

/** Chips go just above the action bar (new X), or under the tweet text (old X). */
function placeRow(article: HTMLElement, row: HTMLElement): boolean {
  const actions = article.querySelector("[data-engagement-action]")?.parentElement
  if (actions) {
    actions.insertAdjacentElement("beforebegin", row)
    return true
  }
  const text = article.querySelector("[data-testid='tweetText']") ?? article.querySelector("[data-testid='User-Name']")?.parentElement
  if (!text) return false
  text.insertAdjacentElement("afterend", row)
  return true
}

function requestLookup(id: string) {
  wanted.add(id)
  clearTimeout(lookupTimer)
  lookupTimer = setTimeout(async () => {
    const ids = [...wanted].slice(0, 200)
    wanted.clear()
    try {
      const reply = (await chrome.runtime.sendMessage({ type: "lookup", ids })) as { ok: boolean; data?: Record<string, BadgeInfo> }
      if (!reply?.ok || !reply.data) return
      for (const id of ids) known.set(id, reply.data[id] ?? null)
      scan()
    } catch {
      // Background asleep or reloaded; the next scan will ask again.
    }
  }, 300)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text) e.textContent = text
  return e
}

function render(article: HTMLElement, id: string, info: BadgeInfo) {
  article.querySelector(".jevx-row")?.remove()
  const row = el("div", "jevx-row")
  row.dataset.id = id

  if (info.category) {
    const label = settings.categories.find((c) => c.id === info.category)?.label ?? info.category
    row.append(el("span", "jevx-chip jevx-cat", label))
  }
  if (info.signal != null) {
    const chip = el("span", "jevx-chip jevx-signal")
    chip.title = `Signal ${(info.signal * 100).toFixed(0)} / 100 (Jev)`
    const bars = el("span", "jevx-bars")
    for (let i = 0; i < 4; i++) bars.append(el("i", info.signal >= (i + 0.5) / 4 ? "on" : ""))
    chip.append(bars, document.createTextNode(String(Math.round(info.signal * 100))))
    row.append(chip)
  }
  for (const [flag, p] of Object.entries(info.flags ?? {})) {
    if (p >= 0.6 && flag in FLAGS) row.append(el("span", `jevx-chip jevx-flag jevx-${flag}`, FLAGS[flag as keyof typeof FLAGS].label))
  }
  for (const topic of settings.topics) {
    if ((info.topics?.[topic.id] ?? 0) >= topic.threshold) row.append(el("span", "jevx-chip jevx-topic", `◆ ${topic.label}`))
  }
  if (info.copies > 0) row.append(el("span", "jevx-chip jevx-dup", `${info.copies + 1}× copies`))
  if (info.dupOf) row.append(el("span", "jevx-chip jevx-dup", "copy"))
  if (info.seenCount > 1) row.append(el("span", "jevx-chip jevx-seen", `seen ${info.seenCount}×`))
  if (info.category == null) row.append(el("span", "jevx-chip jevx-wait", "jev…"))

  placeRow(article, row)
}

function applyDim(article: HTMLElement, info: BadgeInfo) {
  const dim =
    (settings.dimBelow > 0 && info.signal != null && info.signal < settings.dimBelow) ||
    (settings.dimBait && (info.flags?.bait ?? 0) >= 0.6)
  article.classList.toggle("jevx-dim", Boolean(dim))
}

let scanQueued = false
function scan() {
  if (scanQueued) return
  scanQueued = true
  requestAnimationFrame(() => {
    scanQueued = false
    if (!settings.inlineBadges && settings.dimBelow === 0 && !settings.dimBait) return
    for (const article of tweetArticles()) {
      const id = tweetId(article)
      if (!id) continue
      const info = known.get(id)
      // X recycles article nodes, so key the rendered row by tweet id. A node
      // now showing a different tweet drops the old chips and fading first.
      let current = article.querySelector<HTMLElement>(".jevx-row")
      if (article.dataset.jevxId !== id) {
        current?.remove()
        current = null
        article.classList.remove("jevx-dim")
        delete article.dataset.jevx
        article.dataset.jevxId = id
      }
      const stale = !current || current.dataset.id !== id || article.dataset.jevx !== stateKey(info)
      if (info === undefined) {
        requestLookup(id)
        continue
      }
      if (info === null) continue
      if (stale) {
        article.dataset.jevx = stateKey(info)
        if (settings.inlineBadges) render(article, id, info)
        else current?.remove()
        applyDim(article, info)
      }
    }
  })
}

function stateKey(info: BadgeInfo | null | undefined): string {
  if (!info) return "none"
  return `${info.category ?? "-"}:${info.signal ?? "-"}:${info.copies}:${info.seenCount}`
}

// Tweets captured but not yet judged: ask again now and then.
setInterval(() => {
  for (const [id, info] of known) if (info === null || info.category == null) known.delete(id)
  scan()
}, 6000)

// ── attention ─────────────────────────────────────────────────────────────

/** The reading position: a line 40% down the viewport, where eyes rest while scrolling a feed. */
const READ_LINE = 0.4
const TICK_MS = 250
/** No scroll, key or pointer input for this long means you walked away. */
const IDLE_MS = 45_000

const dwell = new Map<string, number>()
/** Tweets that were actually on screen since the last flush; they update "last seen". */
const sighted = new Set<string>()
/** How long each tweet has been continuously on screen. Resets when it leaves. */
const visibleMs = new Map<string, number>()
/** On screen this long counts as seen: a read, not a flick past. */
const SEEN_MS = 600
const clicked = new Map<string, ClickCounts>()
let lastInput = Date.now()

for (const ev of ["scroll", "wheel", "mousemove", "keydown", "touchstart", "pointerdown"]) {
  window.addEventListener(ev, () => (lastInput = Date.now()), { passive: true, capture: true })
}

setInterval(() => {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return
  if (Date.now() - lastInput > IDLE_MS) return
  const y = window.innerHeight * READ_LINE
  let reading: string | undefined
  const onScreen = new Set<string>()
  const articles = tweetArticles()
  articlesEverFound += articles.length
  for (const article of articles) {
    const r = article.getBoundingClientRect()
    // On screen: at least half of it (or 200px of a tall one) is visible.
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0)
    const id = tweetId(article)
    if (id && visible >= Math.min(200, r.height / 2)) onScreen.add(id)
    if (!reading && r.top <= y && r.bottom >= y) reading = id
  }
  for (const id of [...visibleMs.keys()]) if (!onScreen.has(id)) visibleMs.delete(id)
  for (const id of onScreen) {
    const ms = (visibleMs.get(id) ?? 0) + TICK_MS
    visibleMs.set(id, ms)
    if (ms < SEEN_MS) continue
    // Seen: store it if it was waiting, and count the sighting for "Last seen".
    if (!everSeen.has(id)) {
      everSeen.add(id)
      release(id)
    }
    sighted.add(id)
  }
  if (reading) dwell.set(reading, (dwell.get(reading) ?? 0) + TICK_MS)
}, TICK_MS)

const ACTIONS: Record<string, ClickKind | null> = {
  like: "like",
  unlike: null,
  retweet: "retweet",
  unretweet: null,
  reply: "reply",
  bookmark: "bookmark",
  removeBookmark: null,
  caret: null,
}

/** X web 2026 marks its action bar with data-engagement-action. */
function engagementAction(target: Element): ClickKind | null | undefined {
  const el = target.closest<HTMLElement>("[data-engagement-action]")
  if (!el) return undefined
  const action = el.dataset.engagementAction
  const button = target.closest("button, a")
  const pressed = button?.getAttribute("aria-pressed") === "true"
  switch (action) {
    case "reply": return "reply"
    case "retweet": return "retweet"
    case "like": return pressed ? null : "like"
    case "bookmark": return pressed ? null : "bookmark"
    default: return null
  }
}

function classifyClick(target: Element, article: Element): ClickKind | null {
  const action = engagementAction(target)
  if (action !== undefined) return action
  if (target.closest("video") || target.closest("[style*='aspect-ratio']")) return "media"
  const testid = target.closest("[data-testid]")?.getAttribute("data-testid") ?? ""
  if (testid in ACTIONS) return ACTIONS[testid]
  if (testid === "tweet-text-show-more-link") return "expand"
  if (target.closest("[data-testid='tweetPhoto'], [data-testid='videoPlayer'], [data-testid='videoComponent'], [data-testid='card.layoutLarge.media']")) return "media"
  const link = target.closest<HTMLAnchorElement>("a[href]")
  if (link && article.contains(link)) {
    const url = new URL(link.href, location.href)
    if (url.hostname !== location.hostname || url.hostname === "t.co") return "link"
    if (/\/status\/\d+\/(photo|video)\//.test(url.pathname)) return "media"
    if (/\/status\/\d+/.test(url.pathname)) return "open"
    if (/^\/\w{1,15}\/?$/.test(url.pathname)) return "profile"
    return null
  }
  if (target.closest("[data-testid='card.wrapper']")) return "link"
  // Buttons we don't know (share, analytics, grok): not a signal either way.
  if (target.closest("button, [role='button']")) return null
  // Clicking the body of a tweet opens it on X.
  return "open"
}

document.addEventListener(
  "click",
  (e) => {
    const target = e.target as Element | null
    // The outermost article: a click in a quote card counts for the tweet you were reading.
    let article = target?.closest("article")
    while (article?.parentElement?.closest("article")) article = article.parentElement.closest("article")
    if (!target || !article) return
    const id = tweetId(article)
    const kind = id ? classifyClick(target, article) : null
    if (!id || !kind) return
    const counts = clicked.get(id) ?? {}
    counts[kind] = (counts[kind] ?? 0) + 1
    clicked.set(id, counts)
    // Opening a tweet navigates away; don't wait for the timer.
    if (kind === "open" || kind === "link") flushAttention()
  },
  true,
)

function flushAttention() {
  const ids = new Set([...dwell.keys(), ...clicked.keys()])
  const seen = [...sighted]
  if (ids.size === 0 && seen.length === 0) return
  const events: EngagementEvent[] = [...ids].map((id) => ({ id, dwellMs: dwell.get(id) ?? 0, clicks: clicked.get(id) ?? {} }))
  dwell.clear()
  clicked.clear()
  sighted.clear()
  chrome.runtime.sendMessage({ type: "engage", events, seen }).catch(() => {})
}

setInterval(flushAttention, 5000)
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushAttention())
window.addEventListener("pagehide", flushAttention)

const style = document.createElement("style")
style.textContent = `
.jevx-row { display:flex; flex-wrap:wrap; gap:4px; margin:6px 0 2px; font:500 11px/1 -apple-system, "Segoe UI", Inter, sans-serif; }
.jevx-chip { display:inline-flex; align-items:center; gap:5px; height:18px; padding:0 7px; border-radius:999px;
  border:1px solid rgba(113,118,123,.35); color:rgb(113,118,123); white-space:nowrap; letter-spacing:.01em; }
.jevx-cat { color:rgb(231,233,234); border-color:rgba(231,233,234,.28); }
@media (prefers-color-scheme: light) { .jevx-cat { color:rgb(15,20,25); border-color:rgba(15,20,25,.25); } }
.jevx-bars { display:inline-flex; gap:1.5px; align-items:flex-end; height:9px; }
.jevx-bars i { width:2.5px; background:rgba(113,118,123,.35); border-radius:1px; }
.jevx-bars i:nth-child(1){height:3px}.jevx-bars i:nth-child(2){height:5px}.jevx-bars i:nth-child(3){height:7px}.jevx-bars i:nth-child(4){height:9px}
.jevx-bars i.on { background:currentColor; }
.jevx-signal { font-variant-numeric: tabular-nums; }
.jevx-bait { color:#f4212e; border-color:rgba(244,33,46,.4); }
.jevx-promo { color:#ffad1f; border-color:rgba(255,173,31,.4); }
.jevx-launch { color:#00ba7c; border-color:rgba(0,186,124,.4); }
.jevx-thread { color:#1d9bf0; border-color:rgba(29,155,240,.4); }
.jevx-topic { color:#c084fc; border-color:rgba(192,132,252,.45); }
.jevx-wait { border-style:dashed; }
article.jevx-dim { opacity:.28; transition:opacity .15s; }
article.jevx-dim:hover { opacity:1; }
`

/** At document_start there may be no <html> yet; add the styles as soon as there is. */
function addStyle() {
  const root = document.head ?? document.documentElement
  if (root) root.append(style)
  else document.addEventListener("readystatechange", addStyle, { once: true })
}
addStyle()

function start() {
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
  scan()
}
if (document.body) start()
else document.addEventListener("DOMContentLoaded", start, { once: true })
