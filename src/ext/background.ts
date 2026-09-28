/**
 * Service worker: routes messages, owns the enrichment queue and the
 * TypeSafe key, and keeps the offscreen SQLite document alive.
 */
import { READ_OPS, type Broadcast, type DbArgs, type DbOp, type DbResult, type EnrichStatus, type Reply, type Request, type RerankReply } from "../lib/rpc"
import { getSettings, type Settings } from "../lib/settings"
import type { PendingTweet } from "../lib/store"
import type { CapturedTweet } from "../lib/types"
import { enrich, rerank, route, TypeSafeError } from "../lib/typesafe"
import { ChatGPTError, codexInstructions, createLogin, exchangeCode, listModels, parseCallback, refreshAuth, respond, type ChatGPTAuth, type CodexModel, type PendingLogin } from "../lib/chatgpt"
import { saveSettings } from "../lib/settings"
import type { VisionModelsReply } from "../lib/rpc"
import { fetchAsDataUrl, parseVision, smallImageUrl, visionInput, VISION_SCHEMA } from "../lib/vision"
import type { PendingVision } from "../lib/store"

// ── offscreen SQLite ──────────────────────────────────────────────────────

let creating: Promise<void> | null = null

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
  if (contexts.length > 0) return
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs the local SQLite index of captured tweets in a worker with OPFS storage",
    })
    .catch((err: Error) => {
      if (!String(err.message).includes("single offscreen")) throw err
    })
    .finally(() => {
      creating = null
    })
  await creating
}

async function db<Op extends DbOp>(op: Op, ...args: DbArgs<Op>): Promise<DbResult<Op>> {
  await ensureOffscreen()
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = (await chrome.runtime.sendMessage({ target: "offscreen", op, args })) as Reply<DbResult<Op>> | undefined
      if (!reply) throw new Error("Receiving end does not exist")
      if (!reply.ok) throw new Error(reply.error)
      return reply.data
    } catch (err) {
      // The document can be a beat behind its own creation promise.
      if (attempt < 10 && String((err as Error).message).includes("Receiving end does not exist")) {
        await new Promise((r) => setTimeout(r, 100))
        continue
      }
      throw err
    }
  }
}

// ── broadcasts ────────────────────────────────────────────────────────────

let changedTimer: ReturnType<typeof setTimeout> | undefined
function notifyChanged(what: "ingest" | "enrich" | "wipe") {
  clearTimeout(changedTimer)
  changedTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: "changed", what } satisfies Broadcast).catch(() => {})
  }, 400)
}

async function pushBadges(ids: string[]) {
  if (ids.length === 0) return
  const data = await db("lookup", ids)
  const tabs = await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] })
  for (const tab of tabs) if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: "badges", data } satisfies Broadcast).catch(() => {})
}

let alertChain: Promise<unknown> = Promise.resolve()

/** Serialized, so two batches finishing together don't lose each other's count. */
function bumpAlerts(n: number) {
  if (n <= 0) return alertChain
  alertChain = alertChain.then(async () => {
    const { unseenAlerts = 0 } = await chrome.storage.local.get("unseenAlerts")
    await setAlerts(Number(unseenAlerts) + n)
  })
  return alertChain.catch(() => {})
}

async function setAlerts(n: number) {
  await chrome.storage.local.set({ unseenAlerts: n })
  await chrome.action.setBadgeBackgroundColor({ color: "#fafafa" })
  await chrome.action.setBadgeTextColor?.({ color: "#0f0f10" })
  await chrome.action.setBadgeText({ text: n > 0 ? String(Math.min(n, 999)) : "" })
}

// ── capture counters (diagnostics) ────────────────────────────────────────

/** What arrived from x.com since this service worker started. */
const captured = { messages: 0, tweets: 0, lastAt: 0, lastSource: "", responses: 0, empty: 0, lastEmptySource: "", waiting: 0, fellBack: false }
/** Per-tab counts from the content script; summed into `captured`. */
const tapByTab = new Map<number, { responses: number; empty: number; lastEmptySource: string; waiting: number; fellBack: boolean }>()

// ── enrichment queue ──────────────────────────────────────────────────────

const inFlight = new Set<string>()
let active = 0
let lastError: string | undefined
let lastRunAt: number | undefined
let pumpTimer: ReturnType<typeof setTimeout> | undefined

function schedulePump(delay = 1500) {
  clearTimeout(pumpTimer)
  pumpTimer = setTimeout(() => void pump(false), delay)
}

let pumping = false
/** Earliest time the enrichment queue may call TypeSafe again after a transient failure. */
let enrichBackoffUntil = 0

/** Single-flight: overlapping triggers (alarm, ingest, finished batch) can't exceed `concurrency`. */
async function pump(force: boolean) {
  if (pumping) return
  pumping = true
  try {
    const settings = await getSettings()
    if (!settings.apiKey || (!settings.autoEnrich && !force)) return
    if (!force && Date.now() < enrichBackoffUntil) return
    while (active < settings.concurrency) {
      const auth = await getChatGPTAuth()
      const wait = auth && settings.vision ? VISION_WAIT_MS : 0
      const rows = (await db("pending", settings.batchSize + inFlight.size, wait)).filter((r) => !inFlight.has(r.id)).slice(0, settings.batchSize)
      if (rows.length === 0) return
      for (const r of rows) inFlight.add(r.id)
      active++
      void runBatch(rows, settings).then((keepGoing) => {
        for (const r of rows) inFlight.delete(r.id)
        active--
        if (keepGoing) void pump(force)
      })
    }
  } finally {
    pumping = false
  }
}

async function runBatch(rows: PendingTweet[], settings: Settings): Promise<boolean> {
  try {
    const { results, inputTokens } = await enrich(rows, settings)
    await db("saveEnrichment", results)
    await db("addUsage", inputTokens, 1)
    lastError = undefined
    lastRunAt = Date.now()
    const alerts = results.filter((r) => settings.topics.some((t) => (r.enrichment.topics[t.id] ?? 0) >= t.threshold)).length
    await bumpAlerts(alerts)
    await pushBadges(rows.map((r) => r.id))
    notifyChanged("enrich")
    return true
  } catch (err) {
    lastError = (err as Error).message
    const status = err instanceof TypeSafeError ? err.status : undefined
    // Not the tweets' fault: bad key, rate limit, outage, offline, timeout, or a
    // request our settings made invalid (422). Stop, keep the rows, retry later.
    if (status == null || status === 401 || status === 403 || status === 422 || status === 429 || status >= 500) {
      enrichBackoffUntil = Date.now() + (status === 401 || status === 403 || status === 422 ? 10 * 60_000 : 60_000)
      return false
    }
    await db("markEnrichFailed", rows.map((r) => r.id)).catch(() => {})
    return true
  }
}

// ── search ────────────────────────────────────────────────────────────────

async function handleRerank(query: string, ids: string[]): Promise<RerankReply> {
  const settings = await getSettings()
  let tweets = await db("byIds", ids.slice(0, settings.searchCandidates))
  let expanded: string[] = []
  let routeTokens = 0
  // Few keyword hits: let Jev pick the categories and pull their best tweets in.
  if (tweets.length < 8) {
    try {
      const routed = await route(query, settings)
      routeTokens = routed.inputTokens
      if (routed.categories.length > 0) {
        const extra = await db("topInCategories", routed.categories, ids, settings.searchCandidates - tweets.length)
        expanded = extra.map((t) => t.id)
        tweets = [...tweets, ...extra]
      }
    } catch {
      // Routing is a bonus; keyword candidates still get judged.
    }
  }
  if (tweets.length === 0) {
    if (routeTokens) await db("addUsage", routeTokens, 1)
    return { ranked: [], tweets: [], expanded, answerable: 0, inputTokens: routeTokens, model: settings.model, tookMs: 0, cached: false }
  }
  const r = await rerank(query, tweets, settings)
  const spent = routeTokens + (r.cached ? 0 : r.inputTokens)
  if (spent) await db("addUsage", spent, (routeTokens ? 1 : 0) + (r.cached ? 0 : 1))
  return { ...r, tweets, expanded, inputTokens: spent }
}

// ── ingest validation ─────────────────────────────────────────────────────

const TWIMG = /^https:\/\/(pbs|video)\.twimg\.com\//

/**
 * Page scripts on x.com can post fake tweets to the content script, so only
 * keep what we can safely store and later fetch: numeric ids, sane text, and
 * media on X's own CDN (the vision queue downloads these).
 */
function sane(t: CapturedTweet): boolean {
  if (typeof t?.id !== "string" || !/^\d{1,25}$/.test(t.id) || typeof t.handle !== "string" || typeof t.text !== "string" || t.text.length >= 30_000) return false
  t.media = (Array.isArray(t.media) ? t.media : []).filter((m) => typeof m?.url === "string" && TWIMG.test(m.url) && (m.video == null || TWIMG.test(m.video)))
  return true
}

// ── router ────────────────────────────────────────────────────────────────

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "ingest": {
      const tweets = (req.tweets ?? []).slice(0, 500).filter(sane)
      captured.messages++
      captured.tweets += tweets.length
      captured.lastAt = Date.now()
      captured.lastSource = String(req.source).slice(0, 64)
      if (tweets.length === 0) return { inserted: 0, updated: 0, copies: 0, retweets: 0 }
      const result = await db("ingest", tweets, String(req.source).slice(0, 64))
      if (result.inserted > 0) {
        notifyChanged("ingest")
        schedulePump()
        scheduleVision()
      }
      return result
    }
    case "lookup":
      return db("lookup", req.ids.slice(0, 200))
    case "tapStats":
      return true
    case "engage": {
      const events = (req.events ?? [])
        .filter((e) => typeof e?.id === "string" && /^\d{1,25}$/.test(e.id) && Number.isFinite(e.dwellMs))
        .slice(0, 500)
      const seen = (Array.isArray(req.seen) ? req.seen : []).filter((id) => typeof id === "string" && /^\d{1,25}$/.test(id)).slice(0, 500)
      if (seen.length) await db("touchSeen", seen)
      // Deliberately no "changed" broadcast: reading on x.com should not reshuffle an open dashboard every few seconds.
      return events.length ? db("engage", events) : 0
    }
    case "db":
      if (!READ_OPS.includes(req.op)) throw new Error(`${req.op} is not readable from pages`)
      return db(req.op, ...(req.args as DbArgs<typeof req.op>))
    case "rerank":
      return handleRerank(req.query.slice(0, 300), req.ids)
    case "enrichNow":
      void pump(true)
      return true
    case "status": {
      const settings = await getSettings()
      const { unseenAlerts = 0 } = await chrome.storage.local.get("unseenAlerts")
      const auth = await getChatGPTAuth()
      return {
        captured: { ...captured },
        pending: await db("pendingCount"),
        inFlight: inFlight.size,
        apiKeySet: Boolean(settings.apiKey),
        autoEnrich: settings.autoEnrich,
        lastError,
        lastRunAt,
        unseenAlerts: Number(unseenAlerts),
        chatgpt: {
          signedIn: Boolean(auth),
          email: auth?.email,
          plan: auth?.plan,
          pendingImages: auth ? await db("pendingVisionCount") : 0,
          inFlight: visionInFlight.size,
          usedThisHour: visionWindow.filter((t) => t > Date.now() - 3_600_000).length,
          lastError: visionError,
        },
      } satisfies EnrichStatus
    }
    case "chatgptLogin":
      return startLogin()
    case "chatgptLogout":
      await chrome.storage.local.remove(["chatgptAuth", "chatgptLogin"])
      return true
    case "visionNow":
      void pumpVision(true)
      return true
    case "visionCheck":
      return checkVisionModel(String(req.model).slice(0, 64))
    case "visionModels":
      return visionModels(Boolean(req.refresh))
    case "prune": {
      const removed = await db("prune", Math.max(1, Number(req.olderThanDays) || 30), Boolean(req.keepEngaged))
      if (removed > 0) notifyChanged("wipe")
      return removed
    }
    case "vacuum":
      return db("vacuum")
    case "resetEnrichment":
      await db("resetEnrichment")
      notifyChanged("enrich")
      schedulePump(200)
      return true
    case "wipe":
      await db("wipe")
      await setAlerts(0)
      notifyChanged("wipe")
      return true
    case "clearAlerts":
      await setAlerts(0)
      return true
  }
}

chrome.runtime.onMessage.addListener((msg: Request & { target?: string }, sender, sendResponse) => {
  // Offscreen-bound traffic and our own broadcasts are not for us.
  if (msg?.target === "offscreen" || !msg?.type || msg.type === ("changed" as string) || msg.type === ("badges" as string)) return false
  if (sender.id !== chrome.runtime.id) return false
  // Content scripts on x.com may only feed tweets and engagement in, and read badges back.
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL("")) ?? false
  if (!fromExtensionPage && msg.type !== "ingest" && msg.type !== "lookup" && msg.type !== "engage" && msg.type !== "tapStats") return false
  if (msg.type === "tapStats" && sender.tab?.id != null) {
    tapByTab.set(sender.tab.id, {
      responses: Number(msg.responses) || 0,
      empty: Number(msg.empty) || 0,
      lastEmptySource: String(msg.lastEmptySource ?? "").slice(0, 64),
      waiting: Number(msg.waiting) || 0,
      fellBack: Boolean(msg.fellBack),
    })
    captured.responses = [...tapByTab.values()].reduce((n, t) => n + t.responses, 0)
    captured.empty = [...tapByTab.values()].reduce((n, t) => n + t.empty, 0)
    captured.waiting = [...tapByTab.values()].reduce((n, t) => n + t.waiting, 0)
    captured.fellBack = [...tapByTab.values()].some((t) => t.fellBack)
    captured.lastEmptySource = [...tapByTab.values()].find((t) => t.lastEmptySource)?.lastEmptySource ?? ""
  }
  handle(msg)
    .then((data) => sendResponse({ ok: true, data } satisfies Reply<unknown>))
    .catch((err: Error) => sendResponse({ ok: false, error: err.message } satisfies Reply<unknown>))
  return true
})

// ── Sign in with ChatGPT ──────────────────────────────────────────────────

async function getChatGPTAuth(): Promise<ChatGPTAuth | undefined> {
  const { chatgptAuth } = await chrome.storage.local.get("chatgptAuth")
  return chatgptAuth as ChatGPTAuth | undefined
}

/** A valid access token, refreshed if it's about to expire. */
let refreshing: Promise<ChatGPTAuth> | null = null

/**
 * A valid access token, refreshed if it's about to expire (or `force`d after
 * a 401). One refresh at a time: OpenAI rotates refresh tokens, so two
 * parallel refreshes with the same token would sign the user out.
 */
async function freshAuth(force = false): Promise<ChatGPTAuth> {
  const auth = await getChatGPTAuth()
  if (!auth) throw new ChatGPTError("Sign in with ChatGPT in Settings", 401)
  if (!force && auth.expires - Date.now() > 60_000) return auth
  refreshing ??= (async () => {
    try {
      const next = await refreshAuth(auth)
      await chrome.storage.local.set({ chatgptAuth: next })
      return next
    } catch (err) {
      // Someone else may have refreshed with this token already.
      const stored = await getChatGPTAuth()
      if (stored && stored.refresh !== auth.refresh) return stored
      const status = err instanceof ChatGPTError ? err.status : undefined
      // Only a rejected refresh token ends the session; offline or a 5xx doesn't.
      if (status === 400 || status === 401) {
        await chrome.storage.local.remove("chatgptAuth")
        throw new ChatGPTError(`ChatGPT session expired, sign in again (${(err as Error).message})`, 401)
      }
      throw new ChatGPTError(`Couldn't refresh the ChatGPT session: ${(err as Error).message}`)
    }
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** Opens OpenAI's login in a tab. The callback is read off the tab when it lands. */
async function startLogin(): Promise<boolean> {
  const { url, pending } = await createLogin()
  const tab = await chrome.tabs.create({ url })
  await chrome.storage.local.set({ chatgptLogin: { ...pending, tabId: tab.id, startedAt: Date.now() } })
  return true
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url?.startsWith("http://localhost:1455/")) return
  void finishLogin(tabId, change.url)
})

const exchanging = new Set<string>()

async function finishLogin(tabId: number, url: string) {
  const { chatgptLogin } = await chrome.storage.local.get("chatgptLogin")
  const pending = chatgptLogin as (PendingLogin & { tabId?: number; startedAt: number }) | undefined
  if (!pending || Date.now() - pending.startedAt > 15 * 60_000) return
  // Only the tab we opened, and only once per login even if Chrome reports the URL twice.
  if (pending.tabId != null && pending.tabId !== tabId) return
  if (exchanging.has(pending.state)) return
  const result = parseCallback(url, pending)
  if (!result) return
  exchanging.add(pending.state)
  await chrome.storage.local.remove("chatgptLogin")
  const done = (page: string) => chrome.tabs.update(tabId, { url: chrome.runtime.getURL(page) }).catch(() => {})
  if ("error" in result) {
    visionError = `Sign-in failed: ${result.error}`
    await done("dashboard.html#/settings?login=failed")
    return
  }
  try {
    const auth = await exchangeCode(result.code, pending)
    await chrome.storage.local.set({ chatgptAuth: auth })
    visionError = undefined
    await done("dashboard.html#/settings?login=ok")
    scheduleVision(200)
  } catch (err) {
    visionError = `Sign-in failed: ${(err as Error).message}`
    await done("dashboard.html#/settings?login=failed")
  }
}

// ── image analysis queue ──────────────────────────────────────────────────

/** How long Jev waits for a tweet's images to be described before judging it anyway. */
const VISION_WAIT_MS = 2 * 60_000
const VISION_CONCURRENCY = 2

const visionInFlight = new Set<string>()
/** Completion times in the last hour, for the per-hour cap. */
let visionWindow: number[] = []
let visionError: string | undefined
let visionTimer: ReturnType<typeof setTimeout> | undefined

const promptCache = {
  get: async (k: string) => (await chrome.storage.local.get(k))[k] as string | undefined,
  set: (k: string, v: string) => chrome.storage.local.set({ [k]: v }),
}

function scheduleVision(delay = 1000) {
  clearTimeout(visionTimer)
  visionTimer = setTimeout(() => void pumpVision(false), delay)
}

let visionPumping = false
let visionLoaded = false

/** The hourly window and any backoff survive service-worker restarts. */
async function loadVisionState() {
  if (visionLoaded) return
  const { visionState } = await chrome.storage.session.get("visionState")
  const s = visionState as { window?: number[]; backoffUntil?: number } | undefined
  visionWindow = (s?.window ?? []).filter((t) => t > Date.now() - 3_600_000)
  visionBackoffUntil = s?.backoffUntil ?? 0
  visionLoaded = true
}

function saveVisionState() {
  void chrome.storage.session.set({ visionState: { window: visionWindow, backoffUntil: visionBackoffUntil } }).catch(() => {})
}

let visionBackoffUntil = 0

function visionBackoff(ms: number) {
  visionBackoffUntil = Date.now() + ms
  saveVisionState()
  scheduleVision(ms)
}

async function pumpVision(force: boolean) {
  if (visionPumping) return
  visionPumping = true
  try {
    await loadVisionState()
    const settings = await getSettings()
    if (!settings.vision && !force) return
    if (!force && Date.now() < visionBackoffUntil) return
    if (!(await getChatGPTAuth())) return
    if (settings.visionPerHour <= 0) return
    visionWindow = visionWindow.filter((t) => t > Date.now() - 3_600_000)
    while (visionInFlight.size < VISION_CONCURRENCY) {
      if (visionWindow.length + visionInFlight.size >= settings.visionPerHour) {
        // Over the hourly cap: come back when the oldest attempt ages out.
        const oldest = visionWindow[0] ?? Date.now()
        scheduleVision(Math.max(5_000, oldest + 3_600_000 - Date.now()))
        return
      }
      const rows = (await db("pendingVision", VISION_CONCURRENCY + visionInFlight.size)).filter((r) => !visionInFlight.has(r.id))
      const row = rows[0]
      if (!row) return
      visionInFlight.add(row.id)
      // Every attempt uses quota, successful or not, so every attempt counts.
      visionWindow.push(Date.now())
      saveVisionState()
      void describeImages(row, settings.visionModel).then((again) => {
        visionInFlight.delete(row.id)
        if (again) void pumpVision(force)
      })
    }
  } finally {
    visionPumping = false
  }
}

/** A one-word, image-free call so the user can find a model the backend accepts. */
async function checkVisionModel(model: string): Promise<{ ok: true; model: string; ms: number } | { ok: false; error: string }> {
  const started = Date.now()
  try {
    const auth = await freshAuth()
    const instructions = await codexInstructions(model, promptCache)
    const { model: used } = await respond(auth, {
      model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word: ok" }] }],
      reasoningEffort: "low",
    }, { timeoutMs: 30_000 })
    visionError = undefined
    scheduleVision(200)
    return { ok: true, model: used || model, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

let modelCache: { models: CodexModel[]; fetchedAt: number } | undefined

/** The models the backend offers this account, cached for an hour. */
async function visionModels(refresh: boolean): Promise<VisionModelsReply> {
  if (!refresh && modelCache && Date.now() - modelCache.fetchedAt < 3_600_000) return { ok: true, ...modelCache }
  try {
    const models = await listModels(await freshAuth())
    modelCache = { models, fetchedAt: Date.now() }
    return { ok: true, ...modelCache }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Models the backend refused this session; never switched back to. */
const rejectedModels = new Set<string>()

/**
 * The configured model isn't offered: switch to the backend's first choice
 * that hasn't also been refused, and say so in Settings. When none are left,
 * stop the queue rather than cycle.
 */
async function switchToOfferedModel(rejected: string): Promise<boolean> {
  rejectedModels.add(rejected)
  const reply = await visionModels(true)
  const pick = reply.ok ? reply.models.find((m) => !rejectedModels.has(m.slug)) : undefined
  if (!pick) {
    visionError = `ChatGPT refused every model it listed (${[...rejectedModels].join(", ")}). Image descriptions are paused; check Settings → ChatGPT.`
    visionBackoff(30 * 60_000)
    return false
  }
  await saveSettings({ visionModel: pick.slug })
  visionError = `${rejected} isn't offered on your ChatGPT account; switched to ${pick.slug}`
  return true
}

/** The backend refusing the model itself, as opposed to one tweet's images. */
function isModelRejected(err: unknown): boolean {
  return err instanceof ChatGPTError && err.status === 400 && /\bmodel\b.*\bnot supported\b|unsupported model|model_not_found/i.test(err.message)
}

async function describeImages(row: PendingVision, model: string): Promise<boolean> {
  try {
    const media = row.media.filter((m) => TWIMG.test(m.url)).slice(0, 4)
    if (media.length === 0) {
      await db("markVisionFailed", row.id, true)
      return true
    }
    const images = await Promise.all(media.map((m) => fetchAsDataUrl(smallImageUrl(m.url))))
    const instructions = await codexInstructions(model, promptCache)
    const request = { model, instructions, input: [{ role: "user" as const, content: visionInput(row, images) }], schema: VISION_SCHEMA, reasoningEffort: "low" as const }
    let answer
    try {
      answer = await respond(await freshAuth(), request)
    } catch (err) {
      // A 401 before expiry: the token was revoked or rotated. Refresh once and retry.
      if (!(err instanceof ChatGPTError && err.status === 401)) throw err
      answer = await respond(await freshAuth(true), request)
    }
    const { text, model: used } = answer
    await db("saveVision", row.id, parseVision(text, used || model))
    visionError = undefined
    // Jev may have been holding this tweet for its images.
    schedulePump(200)
    notifyChanged("enrich")
    return true
  } catch (err) {
    visionError = (err as Error).message
    // ChatGPT errors and image fetch errors both carry an HTTP status.
    const status = (err as { status?: number }).status
    if (status === 401) return false
    if (isModelRejected(err)) {
      // Keep the tweet, fix the setting, go again with the next model.
      return switchToOfferedModel(model)
    }
    if (status === 429) {
      visionBackoff(5 * 60_000)
      return false
    }
    // Outage, offline, timeout, GitHub down: not this tweet's fault.
    if (status == null || status >= 500) {
      visionBackoff(2 * 60_000)
      return false
    }
    await db("markVisionFailed", row.id).catch(() => {})
    return true
  }
}

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") })
})

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) schedulePump(300)
})

// Creating it again on every service-worker start would keep pushing it back.
void chrome.alarms.get("pump").then((a) => {
  if (!a) void chrome.alarms.create("pump", { periodInMinutes: 1 })
})
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pump") {
    void pump(false)
    void pumpVision(false)
  }
})

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureOffscreen()
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#/settings") })
})
chrome.runtime.onStartup.addListener(() => void ensureOffscreen())
