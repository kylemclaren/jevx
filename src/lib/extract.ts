/**
 * Pull tweets out of any X GraphQL response, or out of X's Relay store.
 *
 * X ships a dozen timeline shapes (HomeTimeline, HomeLatestTimeline,
 * TweetDetail, SearchTimeline, UserTweets, Bookmarks, Likes, ListLatest…) and
 * reshuffles them often. Rather than follow known paths, walk the whole body
 * and pick up every object that looks like a Tweet. That survives most
 * reshuffles and covers endpoints we have never seen.
 */
import type { CapturedTweet, LinkCard, Media } from "./types"

type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any

interface Ctx {
  promoted: boolean
  via?: string
}

export function extractTweets(body: Json): CapturedTweet[] {
  const out = new Map<string, CapturedTweet>()
  walk(body, { promoted: false }, out, 0)
  return [...out.values()]
}

/** A Relay record source, as X's web app (2026) keeps it: `getStore().getSource()`. */
export interface RelaySource {
  getRecordIDs(): string[]
  get(id: string): Json
}

/** Branches of a record that are big, irrelevant, and would drag whole timelines into a tweet. */
const SKIP_KEYS = new Set([
  "__id", "id", "profile_user_originals_timeline", "grok_translated_post_with_availability", "grok_translated_bio_with_availability",
  "edit_control", "reaction_context", "banner", "business_account", "highlights_info", "legacy_extended_profile", "profile_bio",
  "affiliates_highlighted_label", "identity_profile_labels_highlighted_label", "super_follows_conversation_user_results",
  "trusted_friends_info_result", "exclusive_tweet_info", "birdwatch_pivot", "social_context",
])

/** Follow Relay's __ref / __refs links to rebuild a plain object, like the GraphQL response it came from. */
export function derefRecord(source: RelaySource, id: string, depth = 0, stack: Set<string> = new Set()): Json {
  const record = source.get(id)
  if (record == null || depth > 10 || stack.has(id)) return undefined
  stack.add(id)
  const resolve = (v: Json, d: number): Json => {
    if (v == null || typeof v !== "object") return v
    if (Array.isArray(v)) return v.map((x) => resolve(x, d))
    if (typeof v.__ref === "string") return derefRecord(source, v.__ref, d + 1, stack)
    if (Array.isArray(v.__refs)) return v.__refs.map((r: string) => derefRecord(source, r, d + 1, stack))
    const o: Record<string, Json> = {}
    for (const [k, x] of Object.entries(v)) if (!SKIP_KEYS.has(k)) o[k] = resolve(x, d)
    return o
  }
  const out = resolve(record, depth)
  stack.delete(id)
  return out
}

/**
 * Tweets in X's Relay store. Timeline items are read first so ads keep their
 * promoted marker; then every Tweet record, which also covers quoted tweets,
 * threads and anything the page fetched outside a timeline.
 */
export function extractFromRelay(source: RelaySource, only?: (recordId: string) => boolean): CapturedTweet[] {
  const ids = source.getRecordIDs()
  const roots: Json[] = []
  for (const id of ids) {
    if (only && !only(id)) continue
    const t = source.get(id)?.__typename
    if (t === "TimelineTweet") roots.push(derefRecord(source, id))
  }
  for (const id of ids) {
    if (only && !only(id)) continue
    if (source.get(id)?.__typename === "Tweet") roots.push(derefRecord(source, id))
  }
  return extractTweets(roots)
}

function walk(node: Json, ctx: Ctx, out: Map<string, CapturedTweet>, depth: number): void {
  if (!node || typeof node !== "object" || depth > 60) return
  if (Array.isArray(node)) {
    for (const n of node) walk(n, ctx, out, depth + 1)
    return
  }
  // Promoted entries carry promoted metadata beside tweet_results (camelCase in the old API).
  const here: Ctx = node.promotedMetadata || node.promoted_metadata ? { ...ctx, promoted: true } : ctx

  if (node.__typename === "TweetWithVisibilityResults" && node.tweet) {
    walk(node.tweet, here, out, depth + 1)
    return
  }
  // Key on shape, not __typename: the tweet inside a visibility wrapper often has none.
  if (isTweet(node)) {
    const retweeted = node.legacy?.retweeted_status_result?.result ?? node.legacy?.retweeted_status_results?.result
    if (retweeted) {
      // A retweet is a pointer: keep the original and remember who shared it.
      walk(retweeted, { promoted: here.promoted, via: userOf(node).handle }, out, depth + 1)
      return
    }
    const tweet = parseTweet(node, here)
    if (tweet) {
      const prev = out.get(tweet.id)
      if (!prev) out.set(tweet.id, tweet)
      else {
        // The same tweet reached twice (timeline item and bare record): keep what either knew.
        if (tweet.via && !prev.via) prev.via = tweet.via
        if (tweet.promoted) prev.promoted = true
      }
    }
    const quoted = node.quoted_status_result?.result ?? node.quoted_tweet_results?.result
    if (quoted) walk(quoted, { promoted: false }, out, depth + 1)
    return
  }
  for (const key in node) walk(node[key], here, out, depth + 1)
}

/** Old API: text in legacy.full_text. X web 2026: text in details.full_text, counts in counts. */
function isTweet(node: Json): boolean {
  if (!(node.__typename === "Tweet" || node.__typename === undefined)) return false
  if (typeof node.rest_id !== "string" || node.core?.user_results == null) return false
  const legacy = node.legacy
  return (
    typeof node.details?.full_text === "string" ||
    typeof legacy?.full_text === "string" ||
    legacy?.retweeted_status_result != null ||
    legacy?.retweeted_status_results != null
  )
}

function userOf(node: Json): { id: string; handle: string; name: string; avatar?: string; verified: boolean } {
  const u = node.core?.user_results?.result ?? {}
  return {
    id: u.rest_id ?? node.legacy?.user_id_str ?? "",
    handle: u.core?.screen_name ?? u.legacy?.screen_name ?? "",
    name: u.core?.name ?? u.legacy?.name ?? "",
    avatar: u.avatar?.image_url ?? u.legacy?.profile_image_url_https,
    verified: Boolean(u.is_blue_verified || u.verification?.is_blue_verified || u.verification?.verified || u.legacy?.verified),
  }
}

/** Slice by code points, as X's display_text_range counts them. */
function sliceCodePoints(s: string, from: number, to: number): string {
  return [...s].slice(from, to).join("")
}

function parseTweet(node: Json, ctx: Ctx): CapturedTweet | undefined {
  const legacy = node.legacy ?? {}
  const details = node.details ?? {}
  const counts = node.counts ?? legacy
  const user = userOf(node)
  if (!user.handle) return undefined

  const note = node.note_tweet?.note_tweet_results?.result
  let text: string
  if (note?.text) text = note.text
  else {
    const full: string = details.full_text ?? legacy.full_text ?? ""
    // The display range drops leading reply @mentions and the trailing media link.
    const range: [number, number] | undefined = details.display_text_range ?? legacy.display_text_range
    text = range && range[1] > range[0] ? sliceCodePoints(full, range[0], range[1]) : full
  }
  const urlEntities: Json[] = [...(note?.entity_set?.urls ?? []), ...(node.url_entities ?? []), ...(legacy.entities?.urls ?? [])]
  const urls: { url: string; display: string }[] = []
  const seen = new Set<string>()
  for (const u of urlEntities) {
    if (!u?.url || !u.expanded_url) continue
    text = text.split(u.url).join(u.expanded_url)
    if (!seen.has(u.expanded_url)) {
      seen.add(u.expanded_url)
      urls.push({ url: u.expanded_url, display: u.display_url ?? u.expanded_url })
    }
  }
  const mediaEntities: Json[] = node.media_entities2 ?? legacy.extended_entities?.media ?? legacy.entities?.media ?? []
  for (const m of mediaEntities) if (m?.url) text = text.split(m.url).join("")
  text = decodeEntities(text).trim()

  const views = Number(node.views?.count)
  const created = typeof details.created_at_ms === "number" ? details.created_at_ms : Date.parse(legacy.created_at)
  const replyUser = node.reply_to_user_results?.result
  return {
    id: node.rest_id,
    authorId: user.id,
    handle: user.handle,
    name: user.name,
    avatar: user.avatar,
    verified: user.verified,
    text,
    lang: legacy.lang,
    createdAt: Number.isFinite(created) ? created : Date.now(),
    conversationId: details.conversation_id_str ?? legacy.conversation_id_str,
    inReplyTo: node.reply_to_results?.result?.rest_id ?? node.reply_to_results?.rest_id ?? legacy.in_reply_to_status_id_str ?? (replyUser ? "unknown" : undefined),
    quotedId: node.quoted_tweet_results?.result?.rest_id ?? legacy.quoted_status_id_str ?? undefined,
    likes: counts.favorite_count ?? 0,
    retweets: counts.retweet_count ?? 0,
    replies: counts.reply_count ?? 0,
    quotes: counts.quote_count ?? 0,
    bookmarks: counts.bookmark_count ?? 0,
    views: Number.isFinite(views) ? views : undefined,
    media: mediaEntities.map(parseMedia).filter((m) => m.url),
    card: parseCard(node, urls),
    replyTo: replyUser?.core?.screen_name ?? replyUser?.legacy?.screen_name ?? legacy.in_reply_to_screen_name ?? undefined,
    urls,
    promoted: ctx.promoted,
    via: ctx.via,
  }
}

function parseMedia(m: Json): Media {
  const variants: Json[] = m.video_info?.variants ?? []
  const best = variants
    .filter((v) => v?.content_type === "video/mp4" && v.url)
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  // The top bitrate is often 1080p; the second is plenty for a dashboard.
  const pick = best.length > 1 ? best[1] : best[0]
  return {
    type: String(m.type ?? "photo"),
    url: String(m.media_url_https ?? ""),
    width: m.original_info?.width ?? m.sizes?.large?.w,
    height: m.original_info?.height ?? m.sizes?.large?.h,
    alt: m.ext_alt_text ?? undefined,
    video: pick?.url,
    durationMs: m.video_info?.duration_millis,
  }
}

const CARD_IMAGES = ["summary_photo_image_large", "photo_image_full_size_large", "thumbnail_image_large", "summary_photo_image", "thumbnail_image"]

function parseCard(node: Json, urls: { url: string; display: string }[]): LinkCard | undefined {
  const legacy = node.card?.legacy
  if (!legacy?.binding_values) return undefined
  const values: Record<string, Json> = {}
  for (const b of legacy.binding_values) if (b?.key) values[b.key] = b.value
  const str = (k: string): string | undefined => values[k]?.string_value
  const title = str("title")
  if (!title) return undefined // polls, audio spaces and other non-link cards
  const image = CARD_IMAGES.map((k) => values[k]?.image_value).find((v) => v?.url)
  const tco = str("card_url") ?? legacy.url
  // card_url is a t.co link; the tweet's url entities know where it goes.
  const expanded = node.legacy?.entities?.urls?.find((u: Json) => u.url === tco)?.expanded_url
  return {
    url: expanded ?? urls[urls.length - 1]?.url ?? tco,
    title,
    description: str("description"),
    domain: str("vanity_url") ?? str("domain"),
    image: image?.url,
    imageWidth: image?.width,
    imageHeight: image?.height,
    large: String(legacy.name ?? "").includes("large_image"),
  }
}

function decodeEntities(s: string): string {
  // &amp; last, so "&amp;lt;" stays the literal text "&lt;".
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
}

/**
 * Normalized text used to spot copies: reposted jokes, spam rings, the same
 * announcement from five accounts. Links, mentions, emoji and punctuation go.
 */
export function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)[@#][\w]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** FNV-1a 64-bit as hex. Stable, fast, no crypto needed. */
export function contentHash(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const ch of normalizeForDedup(text)) {
    h ^= BigInt(ch.codePointAt(0)!)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, "0")
}

/** Short texts ("gm", "this", "lol") collide innocently, so copies need some length. */
export const MIN_DEDUP_LENGTH = 24

/** GraphQL operation name from a request URL, e.g. "HomeTimeline". */
export function operationName(url: string): string {
  const m = url.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)/)
  return m?.[1] ?? "unknown"
}
