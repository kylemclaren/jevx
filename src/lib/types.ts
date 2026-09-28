import type { ClickCounts } from "./engagement"

export interface Media {
  type: "photo" | "video" | "animated_gif" | string
  /** Photo, or the poster frame for video and GIFs. */
  url: string
  width?: number
  height?: number
  alt?: string
  /** Best MP4 variant for video and GIFs. */
  video?: string
  durationMs?: number
}

/** X's link preview card. */
export interface LinkCard {
  url: string
  title: string
  description?: string
  domain?: string
  image?: string
  imageWidth?: number
  imageHeight?: number
  /** summary_large_image: show the image full width. */
  large: boolean
}

/** A tweet as captured from X's GraphQL responses, before it is stored. */
export interface CapturedTweet {
  id: string
  authorId: string
  handle: string
  name: string
  avatar?: string
  verified: boolean
  text: string
  lang?: string
  createdAt: number
  conversationId?: string
  inReplyTo?: string
  quotedId?: string
  likes: number
  retweets: number
  replies: number
  quotes: number
  bookmarks: number
  views?: number
  media: Media[]
  card?: LinkCard
  /** Handle of the account this replies to. */
  replyTo?: string
  urls: { url: string; display: string }[]
  promoted: boolean
  /** Handle of the account that retweeted this into the timeline, if any. */
  via?: string
}

/** The tweet a stored tweet quotes, when that one is in the index too. */
export interface QuotedTweet {
  id: string
  handle: string
  name: string
  avatar?: string
  verified: boolean
  text: string
  createdAt: number
  media: Media[]
}

export interface Enrichment {
  category: string
  categoryConfidence: number
  /** 0–1, from the signal Score. */
  signal: number
  /** 0–1, 0 hostile … 1 enthusiastic, 0.5 neutral. */
  tone: number
  /** Flag name → Noul probability. */
  flags: Record<string, number>
  /** Watch-topic id → Noul probability. */
  topics: Record<string, number>
}

/** A tweet as stored, with dedup bookkeeping and Jev's enrichment. */
export interface StoredTweet extends Omit<CapturedTweet, "via" | "promoted"> {
  promoted: boolean
  contentHash: string
  /** Id of the first tweet with the same normalized text, if this is a copy. */
  dupOf?: string
  /** Other tweets whose text is a copy of this one. */
  copies: number
  firstSeen: number
  lastSeen: number
  seenCount: number
  /** Accounts that retweeted it into view. */
  viaHandles: string[]
  quoted?: QuotedTweet
  /** What the vision model saw in the images. */
  vision?: { description: string; text: string; kind: string; addsInformation: boolean; model?: string }
  /** Time this tweet sat at your reading position on x.com. */
  dwellMs: number
  clicks: ClickCounts
  /** 0–1 from your reading time and clicks; undefined if never on screen. */
  interest?: number
  /** Your engagement with this author, shrunk toward your average. */
  authorAffinity?: number
  /** Jev's signal blended with your interest and author/category affinity. */
  forYou?: number
  enrichedAt?: number
  enrichment?: Enrichment
}

export interface IngestResult {
  inserted: number
  updated: number
  copies: number
  retweets: number
}

export interface TweetFilters {
  category?: string
  flag?: string
  topic?: string
  topicThreshold?: number
  handle?: string
  /** Only tweets first seen after this (ms). */
  since?: number
  /** Only tweets seen (loaded on x.com) again after this (ms). */
  seenSince?: number
  minSignal?: number
  hideCopies?: boolean
  hidePromoted?: boolean
  /** Leave out replies to other tweets. */
  hideReplies?: boolean
  enrichedOnly?: boolean
  sort?: "recent" | "signal" | "likes" | "seen" | "foryou" | "attention" | "lastSeen"
  limit?: number
  offset?: number
}

export interface SearchHit {
  tweet: StoredTweet
  /** bm25, lower is better; converted to a positive score. */
  score: number
  terms: string[]
  relevance?: number
  probability?: number
  /** Came from category expansion, not the keyword pass. */
  expanded?: boolean
}

export interface Stats {
  attention: {
    dwellMs: number
    engaged: number
    clicks: number
    todayMs: number
    byCategory: { category: string; dwellMs: number; clicks: number; interest: number; avgSignal: number }[]
  }
  tweets: number
  unique: number
  copies: number
  sightings: number
  retweets: number
  promoted: number
  enriched: number
  pending: number
  authors: number
  avgSignal: number
  inputTokens: number
  requests: number
  perDay: { day: string; tweets: number; enriched: number; avgSignal: number; copies: number }[]
  categories: { category: string; count: number; avgSignal: number }[]
  flags: { flag: string; count: number }[]
}

export interface AuthorRow {
  handle: string
  name: string
  avatar?: string
  verified: boolean
  tweets: number
  avgSignal: number | null
  topCategory: string | null
  lastSeen: number
  dwellMs: number
  clicks: number
  /** Your engagement with this author, shrunk toward your average; null if you never read them. */
  affinity: number | null
}
