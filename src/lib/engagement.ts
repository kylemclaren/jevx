/**
 * Your own attention as a signal: how long a tweet sat at your reading
 * position, and what you clicked on it. Jev says whether a tweet is worth
 * reading in general; this says whether it was worth it to you.
 */

export type ClickKind = "open" | "expand" | "media" | "link" | "profile" | "like" | "retweet" | "reply" | "bookmark"

export type ClickCounts = Partial<Record<ClickKind, number>>

export interface EngagementEvent {
  id: string
  dwellMs: number
  clicks: ClickCounts
}

/** How strongly each kind of click says "I wanted this". */
export const CLICK_WEIGHT: Record<ClickKind, number> = {
  expand: 0.3,
  profile: 0.3,
  media: 0.45,
  open: 0.55,
  link: 0.6,
  like: 0.8,
  retweet: 0.85,
  reply: 0.85,
  bookmark: 0.95,
}

export const CLICK_LABEL: Record<ClickKind, string> = {
  expand: "expanded",
  profile: "visited profile",
  media: "viewed media",
  open: "opened",
  link: "followed link",
  like: "liked",
  retweet: "reposted",
  reply: "replied",
  bookmark: "bookmarked",
}

/** Roughly how long reading the tweet takes: a beat to register it, ~250 wpm, a look at each image. */
export function expectedReadMs(text: string, mediaCount: number): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  return 1200 + words * 240 + mediaCount * 1500
}

/**
 * 0–1. Attention saturates: spending the expected reading time gives ~0.44,
 * lingering well past it approaches 0.7. Clicks combine as independent
 * evidence, so a like on top of a long read scores higher than either alone.
 */
export function interestScore(dwellMs: number, clicks: ClickCounts, text: string, mediaCount: number): number {
  const attention = 1 - Math.exp(-Math.max(0, dwellMs) / expectedReadMs(text, mediaCount))
  let miss = 1 - 0.7 * attention
  for (const [kind, n] of Object.entries(clicks) as [ClickKind, number][]) {
    if (n > 0 && kind in CLICK_WEIGHT) miss *= 1 - CLICK_WEIGHT[kind]
  }
  return Math.round((1 - miss) * 1000) / 1000
}

export function mergeClicks(a: ClickCounts, b: ClickCounts): ClickCounts {
  const out: ClickCounts = { ...a }
  for (const [k, n] of Object.entries(b) as [ClickKind, number][]) out[k] = (out[k] ?? 0) + n
  return out
}

/** One flush may not claim more than this per tweet: a tab left open overnight is not interest. */
export const MAX_DWELL_PER_FLUSH = 5 * 60_000

/** Weights for the "For you" blend. Missing inputs fall back to neutral values. */
export const FOR_YOU = { signal: 0.45, interest: 0.25, author: 0.2, category: 0.1 } as const
