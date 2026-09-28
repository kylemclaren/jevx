// Stand-in for the extension APIs so dashboard.html renders as a plain web page.
;(async () => {
  const data = await (await fetch("data.json")).json()
  const store = { settings: undefined }
  const listen = () => ({ addListener() {}, removeListener() {} })
  const list = (f = {}) => {
    let rows = data.all.filter((t) =>
      (!f.hideCopies || !t.dupOf) && (!f.hidePromoted || !t.promoted) && (!f.hideReplies || (!t.inReplyTo && !t.replyTo)) &&
      (!f.category || t.enrichment?.category === f.category) && (!f.flag || (t.enrichment?.flags?.[f.flag] ?? 0) >= 0.5) &&
      (!f.minSignal || (t.enrichment?.signal ?? -1) >= f.minSignal) && (!f.seenSince || t.lastSeen >= f.seenSince) && (!f.handle || t.handle === f.handle))
    const by = { recent: (t) => t.createdAt, lastSeen: (t) => t.lastSeen, signal: (t) => t.enrichment?.signal ?? -1, likes: (t) => t.likes, seen: (t) => t.seenCount, attention: (t) => t.interest ?? -1, foryou: (t) => t.forYou ?? 0 }[f.sort ?? "recent"]
    rows = [...rows].sort((a, b) => by(b) - by(a))
    return { tweets: rows.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50)), total: rows.length }
  }
  const reply = (req) => {
    if (req.type === "status") return { pending: 0, inFlight: 0, apiKeySet: true, autoEnrich: true, unseenAlerts: 2, captured: { messages: 3, tweets: data.all.length, lastAt: Date.now() - 40_000, lastSource: "relay", responses: 12, empty: 0, lastEmptySource: "", waiting: 6, fellBack: false }, chatgpt: { signedIn: true, email: "you@example.com", plan: "plus", pendingImages: 0, inFlight: 0, usedThisHour: 7 } }
    if (req.type === "db") {
      const [a, b] = req.args ?? []
      switch (req.op) {
        case "list": return list(a)
        case "stats": return data.stats
        case "authors": return data.authors
        case "storage": return data.storage
        case "topicCounts": return { "open-model": 1, hiring: 1 }
        case "search": return data.all.filter((t) => a.toLowerCase().split(/\s+/).some((w) => w.length > 2 && (t.text + " " + (t.vision?.description ?? "")).toLowerCase().includes(w))).slice(0, 30).map((t) => ({ tweet: t, score: 1, terms: a.toLowerCase().split(/\s+/) }))
        case "pruneCount": return 0
        case "byIds": return data.all.filter((t) => a.includes(t.id))
        default: return null
      }
    }
    if (req.type === "rerank") {
      const hits = data.all.filter((t) => req.ids.includes(t.id))
      return { ranked: hits.map((t, i) => ({ id: t.id, relevance: Math.max(0.2, 0.95 - i * 0.1), probability: i === 0 ? 0.8 : 0.05 })), tweets: hits, expanded: [], answerable: 0.9, inputTokens: 900, model: "jev", tookMs: 320, cached: false }
    }
    return true
  }
  window.chrome = {
    runtime: { id: "preview", getURL: (p) => p, sendMessage: async (req) => ({ ok: true, data: reply(req) }), onMessage: listen() },
    storage: {
      local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o), remove: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
      onChanged: listen(),
    },
  }
  window.dispatchEvent(new Event("chrome-mock-ready"))
})()
