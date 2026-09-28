import { beforeEach, describe, expect, test } from "bun:test"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { extractTweets } from "../src/lib/extract"
import { Store } from "../src/lib/store"
import type { CapturedTweet } from "../src/lib/types"
import { homeTimeline } from "./fixtures"

const sqlite3 = await sqlite3InitModule()
let store: Store
beforeEach(() => {
  store = new Store(new sqlite3.oo1.DB(":memory:", "c"))
})

const mk = (id: string, text: string, createdAt: number, handle = "u" + id): CapturedTweet => ({
  id, authorId: handle, handle, name: handle, verified: false, text, createdAt,
  likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, media: [], urls: [], promoted: false,
})

describe("ingest", () => {
  test("dedupes by id across refreshes and counts sightings", () => {
    const tweets = extractTweets(homeTimeline())
    const first = store.ingest(tweets, "HomeTimeline", 1_000_000)
    expect(first.inserted).toBe(8)
    expect(first.retweets).toBe(1)
    // Same page again within a minute: no new sighting.
    store.ingest(tweets, "HomeTimeline", 1_030_000)
    // A refresh later: counted.
    const again = store.ingest(tweets, "HomeTimeline", 1_200_000)
    expect(again).toMatchObject({ inserted: 0, updated: 8 })
    const s = store.stats()
    expect(s.tweets).toBe(8)
    expect(s.sightings).toBe(16)
    expect(s.promoted).toBe(1)
    expect(store.byIds(["102"])[0].viaHandles).toEqual(["dave"])
  })

  test("links copies to the earliest original, even when it arrives later", () => {
    const text = "Big news: the new model beats everything on the benchmark"
    store.ingest([mk("2", text + " 🚀", 2000)], "t")
    store.ingest([mk("3", text.toUpperCase() + " https://t.co/x", 3000)], "t")
    expect(store.byIds(["3"])[0].dupOf).toBe("2")
    // An older copy shows up: it becomes the original.
    expect(store.ingest([mk("1", "@someone " + text, 1000)], "t").copies).toBe(1)
    const [a, b, c] = store.byIds(["1", "2", "3"])
    expect(a.dupOf).toBeUndefined()
    expect(a.copies).toBe(2)
    expect(b.dupOf).toBe("1")
    expect(c.dupOf).toBe("1")
    expect(store.pending(10).map((p) => p.id)).toEqual(["1"])
  })

  test("short texts are never treated as copies", () => {
    store.ingest([mk("1", "gm", 1), mk("2", "gm", 2)], "t")
    expect(store.byIds(["2"])[0].dupOf).toBeUndefined()
  })
})

describe("enrichment", () => {
  test("saves to the original and its copies, and new copies inherit", () => {
    const text = "An interesting thread about database indexes and b-trees"
    store.ingest([mk("1", text, 1), mk("2", text, 2)], "t")
    store.saveEnrichment([{ id: "1", enrichment: { category: "dev", categoryConfidence: 0.9, signal: 0.8, tone: 0.5, flags: { thread: 0.9 }, topics: { hiring: 0.1 } } }])
    store.ingest([mk("3", text, 3)], "t")
    const all = store.byIds(["1", "2", "3"])
    expect(all.map((t) => t.enrichment?.category)).toEqual(["dev", "dev", "dev"])
    expect(store.pendingCount()).toBe(0)
    expect(store.list({ flag: "thread", hideCopies: true }).total).toBe(1)
    expect(store.lookup(["1"])["1"]).toMatchObject({ category: "dev", copies: 2 })
    expect(store.stats().flags).toEqual([{ flag: "thread", count: 1 }])
  })

  test("failed tweets stop being retried after three attempts", () => {
    store.ingest([mk("1", "hello there friends", 1)], "t")
    store.markEnrichFailed(["1"])
    store.markEnrichFailed(["1"])
    expect(store.pendingCount()).toBe(1)
    store.markEnrichFailed(["1"])
    expect(store.pendingCount()).toBe(0)
  })
})

describe("display data", () => {
  test("joins the quoted tweet and keeps cards, replies and media", () => {
    store.ingest(extractTweets(homeTimeline()), "HomeTimeline")
    const [quoting, withMedia, carded] = store.byIds(["105", "108", "100"])
    expect(quoting.quoted).toMatchObject({ id: "104", handle: "erin", text: "The quoted tweet about databases", media: [] })
    expect(withMedia.replyTo).toBe("alice")
    expect(withMedia.media).toHaveLength(2)
    expect(carded.card?.title).toBe("SQLite WASM")
    expect(store.pending(20).find((p) => p.id === "100")?.linkTitle).toBe("SQLite WASM")
  })

  test("a later sighting backfills richer media", () => {
    const bare = { ...mk("1", "a picture", 1), media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] }
    store.ingest([bare], "t", 1_000_000)
    store.ingest([{ ...bare, media: [{ ...bare.media[0], width: 100, height: 50 }] }], "t", 2_000_000)
    expect(store.byIds(["1"])[0].media[0].width).toBe(100)
  })

  test("upgrades a database created before cards and replies existed", () => {
    const db = new sqlite3.oo1.DB(":memory:", "c")
    db.exec(`CREATE TABLE tweets (id TEXT PRIMARY KEY, author_id TEXT, handle TEXT NOT NULL, name TEXT, avatar TEXT, verified INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL, lang TEXT, created_at INTEGER, conversation_id TEXT, in_reply_to TEXT, quoted_id TEXT,
      likes INTEGER NOT NULL DEFAULT 0, retweets INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0,
      bookmarks INTEGER NOT NULL DEFAULT 0, views INTEGER, media TEXT NOT NULL DEFAULT '[]', urls TEXT NOT NULL DEFAULT '[]',
      promoted INTEGER NOT NULL DEFAULT 0, content_hash TEXT, dup_of TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1, enriched_at INTEGER, enrich_errors INTEGER NOT NULL DEFAULT 0, category TEXT,
      category_conf REAL, signal REAL, tone REAL, flags TEXT, topics TEXT);
      INSERT INTO tweets (id, handle, text, first_seen, last_seen) VALUES ('9', 'old', 'from before the upgrade', 1, 1);`)
    const upgraded = new Store(db)
    upgraded.ingest(extractTweets(homeTimeline()), "HomeTimeline")
    expect(upgraded.byIds(["9", "100"]).map((t) => [t.handle, t.card?.domain])).toEqual([["old", undefined], ["alice", "sqlite.org"]])
  })
})

describe("vision", () => {
  test("image analysis becomes searchable, reaches Jev's state, and Jev waits for it briefly", () => {
    const withImage = { ...mk("1", "look at this", 1), media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] }
    store.ingest([withImage, mk("2", "plain text tweet about nothing", 2)], "t", 1_000_000)
    expect(store.pendingVision(10).map((p) => p.id)).toEqual(["1"])
    // Waiting for vision: the image tweet holds back, the plain one doesn't.
    expect(store.pending(10, 60_000, 1_010_000).map((p) => p.id)).toEqual(["2"])
    // Waited long enough: it goes anyway.
    expect(store.pending(10, 60_000, 1_100_000).map((p) => p.id).sort()).toEqual(["1", "2"])
    store.saveVision("1", { description: "A chart of GPU prices over time", text: "H100 $25,000", kind: "chart", addsInformation: true })
    expect(store.pendingVisionCount()).toBe(0)
    expect(store.pending(10, 60_000, 1_010_000).map((p) => p.id).sort()).toEqual(["1", "2"])
    expect(store.pending(10).find((p) => p.id === "1")?.vision?.kind).toBe("chart")
    expect(store.search("gpu prices")[0].tweet.id).toBe("1")
    expect(store.byIds(["1"])[0].vision?.text).toBe("H100 $25,000")
  })

  test("a tweet judged before its images were described is judged again, if they add something", () => {
    const e = { category: "other", categoryConfidence: 0.5, signal: 0.1, tone: 0.5, flags: {}, topics: {} }
    const img = (id: string) => ({ ...mk(id, "", Number(id)), media: [{ type: "photo", url: `https://pbs.twimg.com/media/${id}.jpg` }] })
    store.ingest([img("1"), img("2")], "t")
    store.saveEnrichment([{ id: "1", enrichment: e }, { id: "2", enrichment: e }])
    expect(store.pendingCount()).toBe(0)
    store.saveVision("1", { description: "A chart of GPU prices", text: "", kind: "chart", addsInformation: true })
    store.saveVision("2", { description: "A blurry selfie", text: "", kind: "photo", addsInformation: false })
    expect(store.pending(10).map((p) => p.id)).toEqual(["1"])
    // Until Jev answers again, the row shows "judging…" rather than the stale verdict.
    expect(store.byIds(["1"])[0].enrichment).toBeUndefined()
  })

  test("an older search index is rebuilt with the image column", () => {
    const db = new sqlite3.oo1.DB(":memory:", "c")
    new Store(db)
    db.exec("DROP TRIGGER tweets_ai; DROP TRIGGER tweets_ad; DROP TRIGGER tweets_au; DROP TABLE tweets_fts; CREATE VIRTUAL TABLE tweets_fts USING fts5(text, handle, name, content='tweets', content_rowid='rowid');")
    db.exec("INSERT INTO tweets (id, handle, text, media, first_seen, last_seen) VALUES ('9', 'old', 'hello zeppelins', '[]', 1, 1)")
    const upgraded = new Store(db)
    expect(upgraded.search("zeppelin")[0].tweet.id).toBe("9")
    upgraded.saveVision("9", { description: "a blimp", text: "", kind: "photo", addsInformation: true })
    expect(upgraded.search("blimp")[0].tweet.id).toBe("9")
  })
})

describe("search", () => {
  test("non-Latin and accented queries find and highlight their tweets", async () => {
    const { highlightSegments, queryTerms } = await import("../src/lib/search-core")
    store.ingest([
      mk("1", "한국 여행 사진 공유합니다", 1), mk("2", "がっこうに行きました", 2), mk("3", "हिन्दी में ट्वीट", 3), mk("4", "I love café au lait", 4),
    ], "t")
    expect(store.search("한국")[0]?.tweet.id).toBe("1")
    expect(store.search("がっこう")[0]?.tweet.id).toBe("2")
    expect(store.search("हिन्दी")[0]?.tweet.id).toBe("3")
    expect(store.search("cafe")[0]?.tweet.id).toBe("4")
    expect(highlightSegments("I love café au lait", queryTerms("cafe")).find((s) => s.match)?.text).toBe("café")
    expect(highlightSegments("한국 여행", queryTerms("한국")).find((s) => s.match)?.text).toBe("한국")
  })

  test("content hash follows text that grows, so later copies are still caught", () => {
    const full = "a long announcement that was truncated the first time we saw it"
    store.ingest([mk("1", "a long announcement that was…", 1)], "t", 1_000_000)
    store.ingest([mk("1", full, 1)], "t", 1_100_000)
    const r = store.ingest([mk("2", full, 2)], "t", 1_200_000)
    expect(r.copies).toBe(1)
    expect(store.byIds(["2"])[0].dupOf).toBe("1")
  })

  test("FTS with stemming, OR recall and bm25 order", () => {
    store.ingest(extractTweets(homeTimeline()), "HomeTimeline")
    const hits = store.search("how do databases index")
    expect(hits[0].tweet.id).toBe("104")
    expect(store.search("compiling")[0].tweet.id).toBe("101")
    expect(store.search("@alice").map((h) => h.tweet.id)).toContain("100")
    expect(store.search("zzqqx")).toEqual([])
  })

  test("text updates keep FTS in sync", () => {
    store.ingest([mk("1", "short", 1)], "t")
    store.ingest([mk("1", "short but now much longer about zeppelins", 1)], "t", Date.now() + 100_000)
    expect(store.search("zeppelin")[0].tweet.id).toBe("1")
  })

  test("wipe clears everything", () => {
    store.ingest(extractTweets(homeTimeline()), "HomeTimeline")
    store.wipe()
    expect(store.stats().tweets).toBe(0)
    expect(store.search("rust")).toEqual([])
  })
})

describe("storage", () => {
  test("an original stays while any copy of it is recent or engaged", () => {
    const old = Date.now() - 100 * 86_400_000
    const text = "the same announcement posted by two different accounts today"
    store.ingest([mk("1", text, old)], "t", old)
    store.ingest([mk("2", text, old + 1)], "t", Date.now())
    expect(store.byIds(["2"])[0].dupOf).toBe("1")
    expect(store.pruneCount(30, true)).toBe(0)
    expect(store.pruneCount(30, false)).toBe(0)
    expect(store.prune(30, false)).toBe(0)
  })

  test("reports size by bucket and prunes old, unengaged tweets with their copies", () => {
    const day = 86_400_000
    const old = Date.now() - 100 * day
    const text = "an old tweet that nobody read but it is long enough to dedupe"
    store.ingest([mk("1", text, old), mk("2", text, old + 1), mk("3", "old but loved tweet with enough words in it", old)], "t", old)
    store.ingest([mk("4", "fresh tweet", Date.now())], "t", Date.now())
    store.engage([{ id: "3", dwellMs: 30_000, clicks: { like: 1 } }])
    const before = store.storage()
    expect(before.tweets).toBe(4)
    expect(before.buckets.find((b) => b.id === "tweets")!.bytes).toBeGreaterThan(0)
    expect(before.buckets.find((b) => b.id === "search")!.bytes).toBeGreaterThan(0)
    expect(before.bytes).toBeGreaterThanOrEqual(before.buckets.reduce((a, b) => a + b.bytes, 0))
    // The unread original and its copy; the liked one stays.
    expect(store.pruneCount(30, true)).toBe(2)
    expect(store.pruneCount(30, false)).toBe(3)
    expect(store.prune(30, true)).toBe(2)
    expect(store.byIds(["1", "2", "3", "4"]).map((t) => t.id)).toEqual(["3", "4"])
    expect(store.search("nobody")).toEqual([])
    expect(store.vacuum()).toBeGreaterThan(0)
  })
})

describe("last seen", () => {
  test("sorts by the latest sighting and filters by it", () => {
    store.ingest([mk("1", "first tweet here", 1), mk("2", "second tweet here", 2), mk("3", "third tweet here", 3)], "t", 1_000_000)
    // Tweet 1 comes back into view much later; 3 was only ever seen at the start.
    store.ingest([mk("1", "first tweet here", 1)], "t", 5_000_000)
    store.ingest([mk("2", "second tweet here", 2)], "t", 3_000_000)
    expect(store.list({ sort: "lastSeen" }).tweets.map((t) => t.id)).toEqual(["1", "2", "3"])
    expect(store.list({ sort: "lastSeen", seenSince: 2_000_000 }).tweets.map((t) => t.id)).toEqual(["1", "2"])
    expect(store.list({ seenSince: 4_000_000 }).total).toBe(1)
  })
})
