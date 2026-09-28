import { beforeEach, expect, test } from "bun:test"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { expectedReadMs, interestScore } from "../src/lib/engagement"
import { Store } from "../src/lib/store"
import type { CapturedTweet } from "../src/lib/types"

const text = "A thirty word tweet ".repeat(7).trim()

test("scrolling past scores near zero, reading scores middling, clicks score high", () => {
  const read = expectedReadMs(text, 0)
  expect(interestScore(300, {}, text, 0)).toBeLessThan(0.05)
  expect(interestScore(read, {}, text, 0)).toBeCloseTo(0.44, 1)
  expect(interestScore(read * 10, {}, text, 0)).toBeLessThanOrEqual(0.7)
  expect(interestScore(0, { open: 1 }, text, 0)).toBeCloseTo(0.55, 2)
  expect(interestScore(read, { like: 1 }, text, 0)).toBeGreaterThan(interestScore(0, { like: 1 }, text, 0))
  expect(interestScore(0, { bookmark: 1 }, text, 0)).toBeGreaterThan(0.9)
})

test("images add expected reading time", () => {
  expect(expectedReadMs("hi", 2)).toBeGreaterThan(expectedReadMs("hi", 0))
})

const sqlite3 = await sqlite3InitModule()
let store: Store
beforeEach(() => {
  store = new Store(new sqlite3.oo1.DB(":memory:", "c"))
})
const mk = (id: string, handle: string, t = text): CapturedTweet => ({
  id, authorId: handle, handle, name: handle, verified: false, text: t, createdAt: Number(id),
  likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, media: [], urls: [], promoted: false,
})

test("engagement accumulates across flushes and ignores unknown tweets", () => {
  store.ingest([mk("1", "a")], "t")
  expect(store.engage([{ id: "1", dwellMs: 2000, clicks: {} }, { id: "404", dwellMs: 9000, clicks: {} }])).toBe(1)
  store.engage([{ id: "1", dwellMs: 3000, clicks: { like: 1 } }])
  const [t] = store.byIds(["1"])
  expect(t.dwellMs).toBe(5000)
  expect(t.clicks).toEqual({ like: 1 })
  expect(t.interest).toBe(interestScore(5000, { like: 1 }, text, 0))
})

test("one flush cannot claim an overnight tab", () => {
  store.ingest([mk("1", "a")], "t")
  store.engage([{ id: "1", dwellMs: 8 * 3_600_000, clicks: {} }])
  expect(store.byIds(["1"])[0].dwellMs).toBe(5 * 60_000)
})

test("For you lifts authors you engage with, even on tweets you haven't read yet", () => {
  // Same Jev signal everywhere; only your behaviour differs.
  store.ingest([mk("1", "loved"), mk("2", "loved"), mk("3", "ignored"), mk("4", "ignored"), mk("5", "loved"), mk("6", "ignored")], "t")
  const e = { categoryConfidence: 1, signal: 0.5, tone: 0.5, flags: {}, topics: {} }
  store.saveEnrichment(["1", "2", "3", "4", "5", "6"].map((id) => ({ id, enrichment: { ...e, category: "dev" } })))
  store.engage([
    { id: "1", dwellMs: 20_000, clicks: { like: 1 } },
    { id: "2", dwellMs: 15_000, clicks: { open: 1 } },
    { id: "3", dwellMs: 200, clicks: {} },
    { id: "4", dwellMs: 300, clicks: {} },
  ])
  const order = store.list({ sort: "foryou" }).tweets.map((t) => t.id)
  expect(order.slice(0, 3).sort()).toEqual(["1", "2", "5"])
  // Unread tweet 5 still beats unread tweet 6 on author affinity alone.
  expect(order.indexOf("5")).toBeLessThan(order.indexOf("6"))
  const authors = store.authors(10, "attention")
  expect(authors[0].handle).toBe("loved")
  expect(store.stats().attention).toMatchObject({ dwellMs: 35_500, engaged: 4, clicks: 2 })
})
