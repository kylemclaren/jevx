/**
 * The tweet index: plain SQLite with an FTS5 table beside it.
 *
 * This class only needs an oo1 Database, so the same code runs in the
 * extension (OPFS, inside a worker) and in `bun test` (in memory).
 */
import type { Database, SqlValue } from "@sqlite.org/sqlite-wasm"
import { FOR_YOU, interestScore, MAX_DWELL_PER_FLUSH, mergeClicks, type ClickCounts, type EngagementEvent } from "./engagement"
import { contentHash, MIN_DEDUP_LENGTH, normalizeForDedup } from "./extract"
import { ftsQuery, queryTerms } from "./search-core"
import type { AuthorRow, CapturedTweet, LinkCard, QuotedTweet, Enrichment, IngestResult, SearchHit, Stats, StoredTweet, TweetFilters } from "./types"

/** Seeing a tweet again within this window (re-render, second endpoint) is not a new sighting. */
const RESIGHT_MS = 60_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tweets (
  id TEXT PRIMARY KEY,
  author_id TEXT,
  handle TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  lang TEXT,
  created_at INTEGER,
  conversation_id TEXT,
  in_reply_to TEXT,
  quoted_id TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  retweets INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  quotes INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  views INTEGER,
  media TEXT NOT NULL DEFAULT '[]',
  urls TEXT NOT NULL DEFAULT '[]',
  promoted INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  dup_of TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  enriched_at INTEGER,
  enrich_errors INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  category_conf REAL,
  signal REAL,
  tone REAL,
  flags TEXT,
  topics TEXT,
  card TEXT,
  reply_to TEXT,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  click_kinds TEXT,
  interest REAL,
  last_engaged INTEGER,
  vision TEXT,
  vision_text TEXT,
  vision_at INTEGER,
  vision_errors INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tweets_handle ON tweets(handle);
CREATE INDEX IF NOT EXISTS tweets_hash ON tweets(content_hash);
CREATE INDEX IF NOT EXISTS tweets_dup ON tweets(dup_of);
CREATE INDEX IF NOT EXISTS tweets_first_seen ON tweets(first_seen);
CREATE INDEX IF NOT EXISTS tweets_created ON tweets(created_at);
CREATE INDEX IF NOT EXISTS tweets_category ON tweets(category, signal);
CREATE INDEX IF NOT EXISTS tweets_pending ON tweets(enriched_at, first_seen);
CREATE INDEX IF NOT EXISTS tweets_interest ON tweets(interest);
CREATE INDEX IF NOT EXISTS tweets_last_seen ON tweets(last_seen);

CREATE TABLE IF NOT EXISTS sightings (
  tweet_id TEXT NOT NULL,
  source TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (tweet_id, source, via)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS tweets_fts USING fts5(
  text, handle, name, vision_text,
  content='tweets', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS tweets_ai AFTER INSERT ON tweets BEGIN
  INSERT INTO tweets_fts(rowid, text, handle, name, vision_text) VALUES (new.rowid, new.text, new.handle, new.name, new.vision_text);
END;
CREATE TRIGGER IF NOT EXISTS tweets_ad AFTER DELETE ON tweets BEGIN
  INSERT INTO tweets_fts(tweets_fts, rowid, text, handle, name, vision_text) VALUES ('delete', old.rowid, old.text, old.handle, old.name, old.vision_text);
END;
CREATE TRIGGER IF NOT EXISTS tweets_au AFTER UPDATE OF text, handle, name, vision_text ON tweets BEGIN
  INSERT INTO tweets_fts(tweets_fts, rowid, text, handle, name, vision_text) VALUES ('delete', old.rowid, old.text, old.handle, old.name, old.vision_text);
  INSERT INTO tweets_fts(rowid, text, handle, name, vision_text) VALUES (new.rowid, new.text, new.handle, new.name, new.vision_text);
END;
`

/** Columns added after the first release; ALTERed onto older databases. */
const LATER_COLUMNS: Record<string, string> = {
  card: "TEXT",
  reply_to: "TEXT",
  dwell_ms: "INTEGER NOT NULL DEFAULT 0",
  clicks: "INTEGER NOT NULL DEFAULT 0",
  click_kinds: "TEXT",
  interest: "REAL",
  last_engaged: "INTEGER",
  vision: "TEXT",
  vision_text: "TEXT",
  vision_at: "INTEGER",
  vision_errors: "INTEGER NOT NULL DEFAULT 0",
}

/**
 * How much you engage with an author and a category, averaged over the
 * tweets you actually looked at and shrunk toward your overall average so
 * one long read does not make someone a favourite.
 */
const AFFINITY = `
WITH g AS (SELECT coalesce(avg(interest), 0.2) AS m FROM tweets WHERE interest IS NOT NULL),
aa AS (SELECT handle, (sum(interest) + 3 * (SELECT m FROM g)) / (count(*) + 3) AS a
       FROM tweets WHERE interest IS NOT NULL GROUP BY handle),
ca AS (SELECT category, (sum(interest) + 6 * (SELECT m FROM g)) / (count(*) + 6) AS a
       FROM tweets WHERE interest IS NOT NULL AND category IS NOT NULL GROUP BY category)
`
const AFFINITY_JOIN = "LEFT JOIN aa ON aa.handle = t.handle LEFT JOIN ca ON ca.category = t.category"
const FOR_YOU_SQL = `(${FOR_YOU.signal} * coalesce(t.signal, 0.35)
  + ${FOR_YOU.interest} * coalesce(t.interest, (SELECT m FROM g))
  + ${FOR_YOU.author} * coalesce(aa.a, (SELECT m FROM g))
  + ${FOR_YOU.category} * coalesce(ca.a, (SELECT m FROM g)))`

/** Columns every read returns: the row, dedup counts, the quoted tweet and the personal blend. */
const SELECT = `
  t.*,
  aa.a AS author_affinity,
  ${FOR_YOU_SQL} AS for_you,
  (SELECT json_object('id', q.id, 'handle', q.handle, 'name', q.name, 'avatar', q.avatar, 'verified', q.verified,
                      'text', q.text, 'createdAt', q.created_at, 'media', json(q.media))
     FROM tweets q WHERE q.id = t.quoted_id) AS quoted_json,
  (SELECT count(*) FROM tweets c WHERE c.dup_of = t.id) AS copies,
  (SELECT group_concat(DISTINCT s.via) FROM sightings s WHERE s.tweet_id = t.id AND s.via != '') AS via_handles
`

type Row = Record<string, SqlValue>

const SAFE_KEY = /^[a-z0-9_-]{1,40}$/i

/** What Jev needs to judge one tweet. */
export interface PendingTweet {
  id: string
  handle: string
  name: string
  text: string
  quotedText?: string
  quotedHandle?: string
  hasMedia: boolean
  links: string[]
  isReply: boolean
  linkTitle?: string
  vision?: VisionResult
}

/** One tweet's images, as the vision model saw them. */
export interface VisionResult {
  description: string
  /** Text visible in the images, verbatim. */
  text: string
  kind: string
  /** Whether the images say something the tweet text doesn't. */
  addsInformation: boolean
  model?: string
}

export interface StorageReport {
  /** Database file size. */
  bytes: number
  /** Bytes in free pages; VACUUM returns them. */
  free: number
  pageSize: number
  buckets: { id: string; label: string; bytes: number }[]
  tweets: number
  sightings: number
  withMedia: number
  withVision: number
  oldestAt?: number
  bytesPerTweet: number
  tweetsPerWeek: number
  /** Filled in by the worker from navigator.storage.estimate(). */
  quota?: { usage: number; quota: number }
}

/** A tweet whose images need a look. */
export interface PendingVision {
  id: string
  text: string
  handle: string
  media: { type: string; url: string; alt?: string }[]
}

export interface BadgeInfo {
  category?: string
  signal?: number
  tone?: number
  flags?: Record<string, number>
  topics?: Record<string, number>
  copies: number
  seenCount: number
  dupOf?: string
}

export class Store {
  constructor(private db: Database) {
    // Older databases: add new columns before the schema's indexes reference them.
    const existing = new Set(db.selectValues("SELECT name FROM pragma_table_info('tweets')").map(String))
    if (existing.size > 0) {
      for (const [col, type] of Object.entries(LATER_COLUMNS)) if (!existing.has(col)) db.exec(`ALTER TABLE tweets ADD COLUMN ${col} ${type}`)
    }
    // The search index gained a column for image descriptions: rebuild it once.
    const ftsSql = String(db.selectValue("SELECT sql FROM sqlite_master WHERE name = 'tweets_fts'") ?? "")
    const rebuildFts = ftsSql !== "" && !ftsSql.includes("vision_text")
    if (rebuildFts) db.exec("DROP TRIGGER IF EXISTS tweets_ai; DROP TRIGGER IF EXISTS tweets_ad; DROP TRIGGER IF EXISTS tweets_au; DROP TABLE tweets_fts;")
    db.exec(SCHEMA)
    if (rebuildFts) db.exec("INSERT INTO tweets_fts(tweets_fts) VALUES ('rebuild')")
  }

  // ── writes ────────────────────────────────────────────────────────────

  ingest(tweets: CapturedTweet[], source: string, now = Date.now()): IngestResult {
    const result: IngestResult = { inserted: 0, updated: 0, copies: 0, retweets: 0 }
    this.db.transaction(() => {
      for (const t of tweets) {
        const existing = this.db.selectObject("SELECT last_seen, text FROM tweets WHERE id = ?", [t.id]) as Row | undefined
        if (existing) {
          const resighted = now - Number(existing.last_seen) > RESIGHT_MS ? 1 : 0
          this.db.exec({
            sql: `UPDATE tweets SET
                    likes = ?, retweets = ?, replies = ?, quotes = ?, bookmarks = ?,
                    views = coalesce(?, views), avatar = coalesce(?, avatar), name = ?,
                    content_hash = CASE WHEN length(?) > length(text) THEN ? ELSE content_hash END,
                    text = CASE WHEN length(?) > length(text) THEN ? ELSE text END,
                    promoted = max(promoted, ?),
                    media = CASE WHEN json_array_length(?) >= json_array_length(media) THEN ? ELSE media END,
                    card = coalesce(?, card), reply_to = coalesce(?, reply_to),
                    last_seen = ?, seen_count = seen_count + ?
                  WHERE id = ?`,
            bind: [
              t.likes, t.retweets, t.replies, t.quotes, t.bookmarks, t.views ?? null, t.avatar ?? null, t.name, t.text, contentHash(t.text), t.text, t.text,
              t.promoted ? 1 : 0, JSON.stringify(t.media), JSON.stringify(t.media), t.card ? JSON.stringify(t.card) : null,
              t.replyTo ?? null, now, resighted, t.id,
            ],
          })
          result.updated++
        } else {
          const hash = contentHash(t.text)
          const { dupOf, matched } = this.canonicalFor(hash, t)
          this.db.exec({
            sql: `INSERT INTO tweets (id, author_id, handle, name, avatar, verified, text, lang, created_at,
                    conversation_id, in_reply_to, quoted_id, likes, retweets, replies, quotes, bookmarks, views,
                    media, urls, promoted, content_hash, dup_of, first_seen, last_seen, seen_count, card, reply_to)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
            bind: [
              t.id, t.authorId, t.handle, t.name, t.avatar ?? null, t.verified ? 1 : 0, t.text, t.lang ?? null, t.createdAt,
              t.conversationId ?? null, t.inReplyTo ?? null, t.quotedId ?? null, t.likes, t.retweets, t.replies, t.quotes,
              t.bookmarks, t.views ?? null, JSON.stringify(t.media), JSON.stringify(t.urls), t.promoted ? 1 : 0, hash,
              dupOf ?? null, now, now, t.card ? JSON.stringify(t.card) : null, t.replyTo ?? null,
            ],
          })
          result.inserted++
          if (matched) result.copies++
          if (dupOf) this.inheritEnrichment(t.id, dupOf)
        }
        if (t.via) result.retweets++
        this.db.exec({
          sql: `INSERT INTO sightings (tweet_id, source, via, count, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT (tweet_id, source, via) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
          bind: [t.id, source, t.via ?? "", now, now],
        })
      }
    })
    return result
  }

  /**
   * Find the tweet this one copies, if any. The earliest-posted tweet with the
   * same normalized text is the original; if the newcomer is older than the
   * current original, it takes over and the rest point at it.
   */
  private canonicalFor(hash: string, t: CapturedTweet): { dupOf?: string; matched: boolean } {
    if (normalizeForDedup(t.text).length < MIN_DEDUP_LENGTH) return { matched: false }
    const current = this.db.selectObject(
      "SELECT id, created_at FROM tweets WHERE content_hash = ? AND dup_of IS NULL ORDER BY created_at LIMIT 1",
      [hash],
    ) as Row | undefined
    if (!current) return { matched: false }
    if (t.createdAt < Number(current.created_at)) {
      this.db.exec({ sql: "UPDATE tweets SET dup_of = ? WHERE content_hash = ? AND (dup_of IS NULL OR dup_of != ?)", bind: [t.id, hash, t.id] })
      return { matched: true }
    }
    return { dupOf: String(current.id), matched: true }
  }

  /** Copies share their original's judgment, so they never cost tokens. */
  private inheritEnrichment(id: string, from: string) {
    this.db.exec({
      sql: `UPDATE tweets SET (enriched_at, category, category_conf, signal, tone, flags, topics) =
              (SELECT enriched_at, category, category_conf, signal, tone, flags, topics FROM tweets WHERE id = ?)
            WHERE id = ?`,
      bind: [from, id],
    })
  }

  /**
   * Tweets that were on screen on x.com: they move to the top of "Last seen".
   * A sighting only counts toward "seen N×" after a minute away, as with ingest.
   */
  touchSeen(ids: string[], now = Date.now()): number {
    if (ids.length === 0) return 0
    this.db.exec({
      sql: `UPDATE tweets SET seen_count = seen_count + CASE WHEN ? - last_seen > ? THEN 1 ELSE 0 END, last_seen = ?
            WHERE id IN (SELECT value FROM json_each(?))`,
      bind: [now, RESIGHT_MS, now, JSON.stringify(ids)],
    })
    return this.db.changes()
  }

  /** Tweets with images that haven't been looked at yet, newest first. */
  pendingVision(limit: number): PendingVision[] {
    const rows = this.db.selectObjects(
      `SELECT id, text, handle, media FROM tweets
       WHERE media != '[]' AND vision_at IS NULL AND vision_errors < 2 AND dup_of IS NULL AND promoted = 0
       ORDER BY first_seen DESC LIMIT ?`,
      [limit],
    ) as Row[]
    return rows.map((r) => ({ id: String(r.id), text: String(r.text), handle: String(r.handle), media: JSON.parse(String(r.media)) }))
  }

  pendingVisionCount(): number {
    return Number(this.db.selectValue("SELECT count(*) FROM tweets WHERE media != '[]' AND vision_at IS NULL AND vision_errors < 2 AND dup_of IS NULL AND promoted = 0"))
  }

  /**
   * Store an image analysis on the tweet and its copies; it becomes searchable.
   * If Jev already judged the tweet without it and the images add something,
   * the judgment is cleared so Jev looks again with the picture in hand.
   */
  saveVision(id: string, v: VisionResult, now = Date.now()) {
    const searchable = [v.description, v.text].filter(Boolean).join("\n")
    this.db.transaction(() => {
      this.db.exec({
        sql: "UPDATE tweets SET vision = ?, vision_text = ?, vision_at = ? WHERE id = ? OR dup_of = ?",
        bind: [JSON.stringify(v), searchable, now, id, id],
      })
      if (v.addsInformation) {
        this.db.exec({ sql: "UPDATE tweets SET enriched_at = NULL, enrich_errors = 0 WHERE id = ? AND enriched_at IS NOT NULL", bind: [id] })
      }
    })
  }

  /** Count a failed attempt, or with `giveUp` never try this tweet's images again. */
  markVisionFailed(id: string, giveUp = false) {
    this.db.exec({ sql: "UPDATE tweets SET vision_errors = CASE WHEN ? THEN 99 ELSE vision_errors + 1 END WHERE id = ?", bind: [giveUp ? 1 : 0, id] })
  }

  /** Add reading time and clicks from x.com, and recompute each tweet's interest. */
  engage(events: EngagementEvent[], now = Date.now()): number {
    let updated = 0
    this.db.transaction(() => {
      for (const e of events) {
        const row = this.db.selectObject("SELECT text, media, dwell_ms, click_kinds FROM tweets WHERE id = ?", [e.id]) as Row | undefined
        if (!row) continue
        const dwell = Number(row.dwell_ms) + Math.min(Math.max(0, e.dwellMs), MAX_DWELL_PER_FLUSH)
        const kinds = mergeClicks(row.click_kinds ? JSON.parse(String(row.click_kinds)) : {}, e.clicks ?? {})
        const total = Object.values(kinds).reduce((a, b) => a + (b ?? 0), 0)
        const interest = interestScore(dwell, kinds, String(row.text), JSON.parse(String(row.media ?? "[]")).length)
        this.db.exec({
          sql: "UPDATE tweets SET dwell_ms = ?, clicks = ?, click_kinds = ?, interest = ?, last_engaged = ? WHERE id = ?",
          bind: [dwell, total, JSON.stringify(kinds), interest, now, e.id],
        })
        updated++
      }
    })
    return updated
  }

  saveEnrichment(items: { id: string; enrichment: Enrichment }[], now = Date.now()) {
    this.db.transaction(() => {
      for (const { id, enrichment: e } of items) {
        this.db.exec({
          sql: `UPDATE tweets SET enriched_at = ?, category = ?, category_conf = ?, signal = ?, tone = ?, flags = ?, topics = ?
                WHERE id = ? OR dup_of = ?`,
          bind: [now, e.category, e.categoryConfidence, e.signal, e.tone, JSON.stringify(e.flags), JSON.stringify(e.topics), id, id],
        })
      }
    })
  }

  markEnrichFailed(ids: string[]) {
    this.db.exec({ sql: "UPDATE tweets SET enrich_errors = enrich_errors + 1 WHERE id IN (SELECT value FROM json_each(?))", bind: [JSON.stringify(ids)] })
  }

  addUsage(inputTokens: number, requests = 1) {
    this.db.transaction(() => {
      for (const [key, n] of [["input_tokens", inputTokens], ["requests", requests]] as const) {
        this.db.exec({
          sql: "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = value + excluded.value",
          bind: [key, n],
        })
      }
    })
  }

  resetEnrichment() {
    this.db.exec("UPDATE tweets SET enriched_at = NULL, enrich_errors = 0, category = NULL, category_conf = NULL, signal = NULL, tone = NULL, flags = NULL, topics = NULL")
  }

  wipe() {
    this.db.exec("DELETE FROM tweets; DELETE FROM sightings; DELETE FROM meta; INSERT INTO tweets_fts(tweets_fts) VALUES ('rebuild');")
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /**
   * Tweets for Jev to judge. With `waitForVisionMs`, tweets with images hold
   * back until their image analysis lands (or that long passes), so Jev sees
   * what the picture says.
   */
  pending(limit: number, waitForVisionMs = 0, now = Date.now()): PendingTweet[] {
    const rows = this.db.selectObjects(
      `SELECT t.id, t.handle, t.name, t.text, t.media, t.urls, t.in_reply_to, t.card, t.vision,
              q.text AS quoted_text, q.handle AS quoted_handle
       FROM tweets t LEFT JOIN tweets q ON q.id = t.quoted_id
       WHERE t.enriched_at IS NULL AND t.dup_of IS NULL AND t.enrich_errors < 3
         AND NOT (? > 0 AND t.media != '[]' AND t.vision_at IS NULL AND t.vision_errors < 2 AND t.first_seen > ?)
       ORDER BY t.first_seen DESC, t.created_at DESC
       LIMIT ?`,
      [waitForVisionMs, now - waitForVisionMs, limit],
    ) as Row[]
    return rows.map((r) => ({
      id: String(r.id),
      handle: String(r.handle),
      name: String(r.name ?? ""),
      text: String(r.text),
      quotedText: r.quoted_text ? String(r.quoted_text) : undefined,
      quotedHandle: r.quoted_handle ? String(r.quoted_handle) : undefined,
      hasMedia: JSON.parse(String(r.media ?? "[]")).length > 0,
      links: (JSON.parse(String(r.urls ?? "[]")) as { display: string }[]).map((u) => u.display),
      isReply: Boolean(r.in_reply_to),
      linkTitle: r.card ? (JSON.parse(String(r.card)) as LinkCard).title : undefined,
      vision: r.vision ? (JSON.parse(String(r.vision)) as VisionResult) : undefined,
    }))
  }

  pendingCount(): number {
    return Number(this.db.selectValue("SELECT count(*) FROM tweets WHERE enriched_at IS NULL AND dup_of IS NULL AND enrich_errors < 3"))
  }

  lookup(ids: string[]): Record<string, BadgeInfo> {
    const rows = this.db.selectObjects(
      `SELECT t.id, t.category, t.signal, t.tone, t.flags, t.topics, t.seen_count, t.dup_of,
              (SELECT count(*) FROM tweets c WHERE c.dup_of = t.id) AS copies
       FROM tweets t WHERE t.id IN (SELECT value FROM json_each(?))`,
      [JSON.stringify(ids)],
    ) as Row[]
    const out: Record<string, BadgeInfo> = {}
    for (const r of rows) {
      out[String(r.id)] = {
        category: r.category ? String(r.category) : undefined,
        signal: r.signal == null ? undefined : Number(r.signal),
        tone: r.tone == null ? undefined : Number(r.tone),
        flags: r.flags ? JSON.parse(String(r.flags)) : undefined,
        topics: r.topics ? JSON.parse(String(r.topics)) : undefined,
        copies: Number(r.copies),
        seenCount: Number(r.seen_count),
        dupOf: r.dup_of ? String(r.dup_of) : undefined,
      }
    }
    return out
  }

  byIds(ids: string[]): StoredTweet[] {
    const rows = this.db.selectObjects(`${AFFINITY} SELECT ${SELECT} FROM tweets t ${AFFINITY_JOIN} WHERE t.id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]) as Row[]
    const byId = new Map(rows.map((r) => [String(r.id), toTweet(r)]))
    return ids.map((id) => byId.get(id)).filter((t): t is StoredTweet => Boolean(t))
  }

  list(filters: TweetFilters = {}): { tweets: StoredTweet[]; total: number } {
    const { where, bind } = whereClause(filters)
    const order = {
      recent: "t.created_at DESC",
      signal: "coalesce(t.signal, -1) DESC, t.created_at DESC",
      likes: "t.likes DESC",
      seen: "t.seen_count DESC, t.last_seen DESC",
      foryou: "for_you DESC, t.created_at DESC",
      lastSeen: "t.last_seen DESC, t.created_at DESC",
      attention: "t.interest IS NULL, t.interest DESC, t.dwell_ms DESC",
    }[filters.sort ?? "recent"]
    const total = Number(this.db.selectValue(`SELECT count(*) FROM tweets t ${where}`, bind.length ? bind : undefined))
    const rows = this.db.selectObjects(
      `${AFFINITY} SELECT ${SELECT} FROM tweets t ${AFFINITY_JOIN} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...bind, filters.limit ?? 50, filters.offset ?? 0],
    ) as Row[]
    return { tweets: rows.map(toTweet), total }
  }

  /** The keyword pass: FTS5 over text, handle and display name, ranked by bm25. */
  search(query: string, filters: TweetFilters = {}, limit = 40): SearchHit[] {
    const match = ftsQuery(query)
    if (!match) return []
    const { where, bind } = whereClause({ hideCopies: true, ...filters }, "AND")
    const rows = this.db.selectObjects(
      `${AFFINITY} SELECT ${SELECT}, bm25(tweets_fts, 1.0, 2.0, 1.0, 0.6) AS rank
       FROM tweets_fts JOIN tweets t ON t.rowid = tweets_fts.rowid ${AFFINITY_JOIN}
       WHERE tweets_fts MATCH ? ${where}
       ORDER BY rank, coalesce(t.signal, 0) DESC
       LIMIT ?`,
      [match, ...bind, limit],
    ) as Row[]
    const terms = queryTerms(query)
    return rows.map((r) => ({ tweet: toTweet(r), score: -Number(r.rank), terms }))
  }

  /** Best recent tweets in some categories: extra candidates when keywords recall too little. */
  topInCategories(categories: string[], exclude: string[], limit: number): StoredTweet[] {
    const rows = this.db.selectObjects(
      `${AFFINITY} SELECT ${SELECT} FROM tweets t ${AFFINITY_JOIN}
       WHERE t.category IN (SELECT value FROM json_each(?)) AND t.dup_of IS NULL
         AND t.id NOT IN (SELECT value FROM json_each(?))
       ORDER BY coalesce(t.signal, 0) DESC, t.last_seen DESC LIMIT ?`,
      [JSON.stringify(categories), JSON.stringify(exclude), limit],
    ) as Row[]
    return rows.map(toTweet)
  }

  stats(days = 30): Stats {
    const n = (sql: string, bind?: SqlValue[]) => Number(this.db.selectValue(sql, bind) ?? 0)
    const since = Date.now() - days * 86_400_000
    const perDay = (this.db.selectObjects(
      `SELECT date(first_seen / 1000, 'unixepoch', 'localtime') AS day, count(*) AS tweets,
              sum(enriched_at IS NOT NULL) AS enriched, avg(signal) AS avg_signal, sum(dup_of IS NOT NULL) AS copies
       FROM tweets WHERE first_seen >= ? GROUP BY day ORDER BY day`,
      [since],
    ) as Row[]).map((r) => ({ day: String(r.day), tweets: Number(r.tweets), enriched: Number(r.enriched), avgSignal: Number(r.avg_signal ?? 0), copies: Number(r.copies ?? 0) }))
    const categories = (this.db.selectObjects(
      `SELECT category, count(*) AS count, avg(signal) AS avg_signal FROM tweets
       WHERE category IS NOT NULL AND dup_of IS NULL GROUP BY category ORDER BY count DESC`,
    ) as Row[]).map((r) => ({ category: String(r.category), count: Number(r.count), avgSignal: Number(r.avg_signal ?? 0) }))
    const flags = (this.db.selectObjects(
      `SELECT j.key AS flag, count(*) AS count FROM tweets t, json_each(t.flags) j
       WHERE t.dup_of IS NULL AND j.value >= 0.5 GROUP BY j.key ORDER BY count DESC`,
    ) as Row[]).map((r) => ({ flag: String(r.flag), count: Number(r.count) }))
    const attentionByCategory = (this.db.selectObjects(
      `SELECT category, sum(dwell_ms) AS dwell, sum(clicks) AS clicks, avg(interest) AS interest, avg(signal) AS avg_signal
       FROM tweets WHERE category IS NOT NULL AND (dwell_ms > 0 OR clicks > 0)
       GROUP BY category ORDER BY dwell DESC`,
    ) as Row[]).map((r) => ({
      category: String(r.category),
      dwellMs: Number(r.dwell),
      clicks: Number(r.clicks),
      interest: Number(r.interest ?? 0),
      avgSignal: Number(r.avg_signal ?? 0),
    }))
    return {
      attention: {
        dwellMs: n("SELECT coalesce(sum(dwell_ms), 0) FROM tweets"),
        engaged: n("SELECT count(*) FROM tweets WHERE interest IS NOT NULL"),
        clicks: n("SELECT coalesce(sum(clicks), 0) FROM tweets"),
        todayMs: n("SELECT coalesce(sum(dwell_ms), 0) FROM tweets WHERE last_engaged >= ?", [new Date().setHours(0, 0, 0, 0)]),
        byCategory: attentionByCategory,
      },
      tweets: n("SELECT count(*) FROM tweets"),
      unique: n("SELECT count(*) FROM tweets WHERE dup_of IS NULL"),
      copies: n("SELECT count(*) FROM tweets WHERE dup_of IS NOT NULL"),
      sightings: n("SELECT coalesce(sum(seen_count), 0) FROM tweets"),
      retweets: n("SELECT count(DISTINCT tweet_id || via) FROM sightings WHERE via != ''"),
      promoted: n("SELECT count(*) FROM tweets WHERE promoted = 1"),
      enriched: n("SELECT count(*) FROM tweets WHERE enriched_at IS NOT NULL"),
      pending: this.pendingCount(),
      authors: n("SELECT count(DISTINCT handle) FROM tweets"),
      avgSignal: n("SELECT coalesce(avg(signal), 0) FROM tweets WHERE dup_of IS NULL"),
      inputTokens: n("SELECT coalesce(value, 0) FROM meta WHERE key = 'input_tokens'"),
      requests: n("SELECT coalesce(value, 0) FROM meta WHERE key = 'requests'"),
      perDay,
      categories,
      flags,
    }
  }

  authors(limit = 100, sort: "tweets" | "signal" | "attention" = "tweets"): AuthorRow[] {
    const order = {
      tweets: "tweets DESC, avg_signal DESC",
      signal: "avg_signal IS NULL, avg_signal DESC, tweets DESC",
      attention: "affinity IS NULL, affinity DESC, dwell DESC",
    }[sort]
    const rows = this.db.selectObjects(
      `${AFFINITY} SELECT handle, max(name) AS name, max(avatar) AS avatar, max(verified) AS verified,
              count(*) AS tweets, avg(signal) AS avg_signal, max(last_seen) AS last_seen,
              sum(dwell_ms) AS dwell, sum(clicks) AS clicks,
              (SELECT a FROM aa WHERE aa.handle = t.handle) AS affinity,
              (SELECT category FROM tweets c WHERE c.handle = t.handle AND category IS NOT NULL
                 GROUP BY category ORDER BY count(*) DESC LIMIT 1) AS top_category
       FROM tweets t WHERE dup_of IS NULL AND promoted = 0
       GROUP BY handle ORDER BY ${order} LIMIT ?`,
      [limit],
    ) as Row[]
    return rows.map((r) => ({
      handle: String(r.handle),
      name: String(r.name ?? ""),
      avatar: r.avatar ? String(r.avatar) : undefined,
      verified: Boolean(r.verified),
      tweets: Number(r.tweets),
      avgSignal: r.avg_signal == null ? null : Number(r.avg_signal),
      topCategory: r.top_category ? String(r.top_category) : null,
      lastSeen: Number(r.last_seen),
      dwellMs: Number(r.dwell ?? 0),
      clicks: Number(r.clicks ?? 0),
      affinity: r.affinity == null ? null : Number(r.affinity),
    }))
  }

  topicCounts(thresholds: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, threshold] of Object.entries(thresholds)) {
      if (!SAFE_KEY.test(id)) continue
      out[id] = Number(this.db.selectValue(`SELECT count(*) FROM tweets WHERE dup_of IS NULL AND json_extract(topics, '$."${id}"') >= ?`, [threshold]))
    }
    return out
  }

  // ── storage ───────────────────────────────────────────────────────────

  /** How big the database is and what the bytes go to. */
  storage(): StorageReport {
    const page = this.db.selectObject("SELECT * FROM pragma_page_count, pragma_page_size, pragma_freelist_count") as Row
    const pageSize = Number(page.page_size)
    const bytes = Number(page.page_count) * pageSize
    const free = Number(page.freelist_count) * pageSize
    const byName = new Map<string, number>()
    for (const r of this.db.selectObjects("SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name") as Row[]) byName.set(String(r.name), Number(r.bytes))
    const sum = (test: (name: string) => boolean) => [...byName].filter(([n]) => test(n)).reduce((a, [, b]) => a + b, 0)
    const buckets = [
      { id: "tweets", label: "Tweets", bytes: sum((n) => n === "tweets") },
      { id: "search", label: "Search index", bytes: sum((n) => n.startsWith("tweets_fts")) },
      { id: "indexes", label: "Lookup indexes", bytes: sum((n) => n.startsWith("tweets_") && !n.startsWith("tweets_fts")) },
      { id: "sightings", label: "Sightings", bytes: sum((n) => n === "sightings") },
      { id: "other", label: "Other", bytes: sum((n) => !n.startsWith("tweets") && n !== "sightings") },
    ]
    const n = (sql: string) => Number(this.db.selectValue(sql) ?? 0)
    const oldest = n("SELECT min(first_seen) FROM tweets")
    const tweets = n("SELECT count(*) FROM tweets")
    const last7 = n(`SELECT count(*) FROM tweets WHERE first_seen >= ${Date.now() - 7 * 86_400_000}`)
    return {
      bytes,
      free,
      pageSize,
      buckets,
      tweets,
      sightings: n("SELECT count(*) FROM sightings"),
      withMedia: n("SELECT count(*) FROM tweets WHERE media != '[]'"),
      withVision: n("SELECT count(*) FROM tweets WHERE vision IS NOT NULL"),
      oldestAt: oldest || undefined,
      bytesPerTweet: tweets ? Math.round((bytes - free) / tweets) : 0,
      /** Tweets a week, from the last week, for the growth estimate. */
      tweetsPerWeek: last7,
    }
  }

  /** What a prune would remove, copies included. */
  pruneCount(olderThanDays: number, keepEngaged: boolean): number {
    const { where, bind } = pruneWhere(olderThanDays, keepEngaged)
    return Number(this.db.selectValue(`SELECT count(*) FROM tweets WHERE id IN (SELECT id FROM tweets ${where}) OR dup_of IN (SELECT id FROM tweets ${where})`, [...bind, ...bind]))
  }

  /**
   * Delete old tweets. With keepEngaged, tweets you read, clicked or that
   * matched a watch topic stay. Copies of a removed original are removed too.
   */
  prune(olderThanDays: number, keepEngaged: boolean): number {
    const { where, bind } = pruneWhere(olderThanDays, keepEngaged)
    let removed = 0
    this.db.transaction(() => {
      this.db.exec({ sql: `CREATE TEMP TABLE doomed AS SELECT id FROM tweets ${where}`, bind })
      this.db.exec("INSERT INTO doomed SELECT id FROM tweets WHERE dup_of IN (SELECT id FROM doomed) AND id NOT IN (SELECT id FROM doomed)")
      removed = Number(this.db.selectValue("SELECT count(*) FROM doomed"))
      this.db.exec("DELETE FROM sightings WHERE tweet_id IN (SELECT id FROM doomed); DELETE FROM tweets WHERE id IN (SELECT id FROM doomed); DROP TABLE doomed;")
    })
    return removed
  }

  /** Give freed pages back to the file system. */
  vacuum(): number {
    this.db.exec("VACUUM")
    return this.storage().bytes
  }

  exportAll(): StoredTweet[] {
    return (this.db.selectObjects(`${AFFINITY} SELECT ${SELECT} FROM tweets t ${AFFINITY_JOIN} ORDER BY t.created_at DESC`) as Row[]).map(toTweet)
  }
}

/**
 * Originals to prune. An original goes only if it and all its copies are old
 * (and, with keepEngaged, unengaged): the copy is often the row you actually
 * saw and liked, and it would be deleted along with its original.
 */
function pruneWhere(olderThanDays: number, keepEngaged: boolean): { where: string; bind: SqlValue[] } {
  const cutoff = Date.now() - Math.max(1, olderThanDays) * 86_400_000
  // Engaged: you spent real time on it, clicked it, or a watch topic matched it.
  const keep = (t: string) =>
    [`${t}.first_seen >= ?`, ...(keepEngaged ? [`coalesce(${t}.interest, 0) >= 0.3`, `${t}.clicks > 0`, `EXISTS (SELECT 1 FROM json_each(${t}.topics) j WHERE j.value >= 0.7)`] : [])].join(" OR ")
  const where = `WHERE dup_of IS NULL AND NOT (${keep("tweets")}) AND NOT EXISTS (SELECT 1 FROM tweets c WHERE c.dup_of = tweets.id AND (${keep("c")}))`
  return { where, bind: [cutoff, cutoff] }
}

function whereClause(f: TweetFilters, joiner: "WHERE" | "AND" = "WHERE"): { where: string; bind: SqlValue[] } {
  const parts: string[] = []
  const bind: SqlValue[] = []
  if (f.hideCopies) parts.push("t.dup_of IS NULL")
  if (f.hidePromoted) parts.push("t.promoted = 0")
  if (f.hideReplies) parts.push("t.in_reply_to IS NULL AND t.reply_to IS NULL")
  if (f.enrichedOnly) parts.push("t.enriched_at IS NOT NULL")
  if (f.category) {
    parts.push("t.category = ?")
    bind.push(f.category)
  }
  if (f.handle) {
    parts.push("t.handle = ? COLLATE NOCASE")
    bind.push(f.handle)
  }
  if (f.since) {
    parts.push("t.first_seen >= ?")
    bind.push(f.since)
  }
  if (f.seenSince) {
    parts.push("t.last_seen >= ?")
    bind.push(f.seenSince)
  }
  if (f.minSignal != null && f.minSignal > 0) {
    parts.push("t.signal >= ?")
    bind.push(f.minSignal)
  }
  if (f.flag && SAFE_KEY.test(f.flag)) parts.push(`json_extract(t.flags, '$."${f.flag}"') >= 0.5`)
  if (f.topic && SAFE_KEY.test(f.topic)) {
    parts.push(`json_extract(t.topics, '$."${f.topic}"') >= ?`)
    bind.push(f.topicThreshold ?? 0.5)
  }
  if (parts.length === 0) return { where: "", bind }
  return { where: `${joiner} ${parts.join(" AND ")}`, bind }
}

function toQuoted(q: Record<string, unknown>): QuotedTweet {
  return {
    id: String(q.id),
    handle: String(q.handle),
    name: String(q.name ?? ""),
    avatar: q.avatar ? String(q.avatar) : undefined,
    verified: Boolean(q.verified),
    text: String(q.text),
    createdAt: Number(q.createdAt),
    media: Array.isArray(q.media) ? (q.media as QuotedTweet["media"]) : [],
  }
}

function toTweet(r: Row): StoredTweet {
  const enriched = r.enriched_at != null
  return {
    id: String(r.id),
    authorId: String(r.author_id ?? ""),
    handle: String(r.handle),
    name: String(r.name ?? ""),
    avatar: r.avatar ? String(r.avatar) : undefined,
    verified: Boolean(r.verified),
    text: String(r.text),
    lang: r.lang ? String(r.lang) : undefined,
    createdAt: Number(r.created_at),
    conversationId: r.conversation_id ? String(r.conversation_id) : undefined,
    inReplyTo: r.in_reply_to ? String(r.in_reply_to) : undefined,
    quotedId: r.quoted_id ? String(r.quoted_id) : undefined,
    likes: Number(r.likes),
    retweets: Number(r.retweets),
    replies: Number(r.replies),
    quotes: Number(r.quotes),
    bookmarks: Number(r.bookmarks),
    views: r.views == null ? undefined : Number(r.views),
    media: JSON.parse(String(r.media ?? "[]")),
    urls: JSON.parse(String(r.urls ?? "[]")),
    promoted: Boolean(r.promoted),
    contentHash: String(r.content_hash ?? ""),
    dupOf: r.dup_of ? String(r.dup_of) : undefined,
    copies: Number(r.copies ?? 0),
    firstSeen: Number(r.first_seen),
    lastSeen: Number(r.last_seen),
    seenCount: Number(r.seen_count),
    viaHandles: r.via_handles ? String(r.via_handles).split(",") : [],
    card: r.card ? JSON.parse(String(r.card)) : undefined,
    vision: r.vision ? JSON.parse(String(r.vision)) : undefined,
    replyTo: r.reply_to ? String(r.reply_to) : undefined,
    quoted: r.quoted_json ? toQuoted(JSON.parse(String(r.quoted_json))) : undefined,
    dwellMs: Number(r.dwell_ms ?? 0),
    clicks: r.click_kinds ? (JSON.parse(String(r.click_kinds)) as ClickCounts) : {},
    interest: r.interest == null ? undefined : Number(r.interest),
    authorAffinity: r.author_affinity == null ? undefined : Number(r.author_affinity),
    forYou: r.for_you == null ? undefined : Number(r.for_you),
    enrichedAt: enriched ? Number(r.enriched_at) : undefined,
    enrichment: enriched
      ? {
          category: String(r.category ?? "other"),
          categoryConfidence: Number(r.category_conf ?? 0),
          signal: Number(r.signal ?? 0),
          tone: Number(r.tone ?? 0.5),
          flags: r.flags ? JSON.parse(String(r.flags)) : {},
          topics: r.topics ? JSON.parse(String(r.topics)) : {},
        }
      : undefined,
  }
}
