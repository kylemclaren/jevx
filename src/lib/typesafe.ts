/**
 * TypeSafe / Jev: the three judgments jevx needs.
 *
 *  - enrich:  a batch of tweets → category (Choice), signal and tone (Score),
 *             flags and watch topics (Noul). One request per batch; every
 *             question sees the same state and they run in parallel.
 *  - rerank:  jev-search's ranking step. A Noul per keyword candidate, a
 *             Choice for the single best one, and an "answerable" Noul.
 *  - route:   which categories a search is about, so candidates can come
 *             from somewhere other than keyword overlap.
 */
import type { PendingTweet } from "./store"
import { FLAGS, type FlagId, type Settings } from "./settings"
import type { Enrichment, StoredTweet } from "./types"

export const API_URL = "https://api.typesafe.ai/v1/systemone"
/** $ per input token for jev-1.x; output tokens are free. */
export const PRICE_PER_TOKEN = 0.042 / 1_000_000

interface Answer {
  type: "noul" | "choice" | "score"
  noul?: number
  choice?: string
  score?: number
  probabilities?: Record<string, number>
  confidence?: number
}

export interface JevResponse {
  model: string
  answers: Record<string, Answer>
  usage?: { input_tokens: number; output_tokens: number }
}

export class TypeSafeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export async function ask(
  settings: Pick<Settings, "apiKey" | "model">,
  state: unknown,
  questions: Record<string, unknown>,
  { timeoutMs = 20_000, retries = 3 } = {},
): Promise<JevResponse> {
  if (!settings.apiKey) throw new TypeSafeError("Add your TypeSafe API key in Settings", 401)
  const body = JSON.stringify({ model: settings.model || "jev-latest", state, questions })
  let lastError: TypeSafeError | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const base = lastError?.status === 429 || lastError?.status === 529 ? 1000 : 250
      await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1) + Math.random() * 200))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
      if (res.ok) return (await res.json()) as JevResponse
      const text = await res.text().catch(() => "")
      lastError = new TypeSafeError(`TypeSafe ${res.status}: ${text.slice(0, 300)}`, res.status)
      // Only rate limits, overload and server errors improve with a retry.
      if (res.status < 500 && res.status !== 429 && res.status !== 408) break
    } catch (err) {
      lastError = new TypeSafeError(controller.signal.aborted ? "TypeSafe timed out" : (err as Error).message)
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError ?? new TypeSafeError("TypeSafe call failed")
}

// ── enrichment ────────────────────────────────────────────────────────────

export const SIGNAL_LEVELS = [
  "Noise: engagement bait, filler, a bare reaction, or nothing a reader could take away",
  "Light: casual chatter, a small personal update, or a passing opinion",
  "Useful: makes a real point, shares news, or passes on information worth a glance",
  "High signal: original insight, real expertise, important news, or something worth saving",
]

export const TONE_LEVELS = [
  "Hostile: angry, insulting or contemptuous",
  "Negative: critical, complaining, worried or sad",
  "Neutral: factual or matter-of-fact",
  "Positive: warm, appreciative or upbeat",
  "Enthusiastic: excited, celebratory or delighted",
]

function tweetState(t: PendingTweet) {
  return {
    author: `@${t.handle}${t.name ? ` (${t.name})` : ""}`,
    text: t.text.slice(0, 1500),
    ...(t.quotedText ? { quoting: { author: `@${t.quotedHandle}`, text: t.quotedText.slice(0, 600) } } : {}),
    ...(t.links.length ? { links: t.links.slice(0, 4) } : {}),
    ...(t.linkTitle ? { link_preview_title: t.linkTitle } : {}),
    ...(t.vision ? { images: { show: t.vision.description, ...(t.vision.text ? { text_in_image: t.vision.text.slice(0, 600) } : {}), kind: t.vision.kind } } : {}),
    ...(t.hasMedia ? { has_image_or_video: true } : {}),
    ...(t.isReply ? { is_reply: true } : {}),
  }
}

export function enrichmentQuestions(batch: PendingTweet[], settings: Pick<Settings, "categories" | "topics">) {
  const categoryCriteria: Record<string, string> = {}
  for (const c of settings.categories) categoryCriteria[c.id] = `${c.label}: ${c.description}`

  const questions: Record<string, unknown> = {}
  batch.forEach((_, i) => {
    const which = `Judge only the tweet at \`tweets[${i}]\`.`
    questions[`t${i}_category`] = {
      type: "choice",
      instructions: `${which} Which category best describes what this tweet is about?`,
      criteria: categoryCriteria,
    }
    questions[`t${i}_signal`] = {
      type: "score",
      instructions: `${which} How much would a thoughtful reader get out of this tweet?`,
      criteria: SIGNAL_LEVELS,
    }
    questions[`t${i}_tone`] = {
      type: "score",
      instructions: `${which} What is the emotional tone of this tweet?`,
      criteria: TONE_LEVELS,
    }
    for (const [id, flag] of Object.entries(FLAGS)) {
      questions[`t${i}_f_${id}`] = { type: "noul", instructions: `${which} ${flag.instructions}`, criteria: flag.criteria }
    }
    settings.topics.forEach((topic, j) => {
      questions[`t${i}_w${j}`] = {
        type: "noul",
        instructions: `${which} Does this tweet match the following: ${topic.description}?`,
        criteria: { true: `The tweet is about this: ${topic.description}`, false: "The tweet is about something else or only mentions it in passing" },
      }
    })
  })
  return {
    state: {
      about: "Tweets collected from the user's X (Twitter) timeline. Each question is about exactly one of them.",
      tweets: batch.map(tweetState),
    },
    questions,
  }
}

function level(a: Answer | undefined, levels: number, fallback: number): number {
  if (a?.score == null) return fallback
  return Math.max(0, Math.min(1, a.score / (levels - 1)))
}

export function parseEnrichment(batch: PendingTweet[], res: JevResponse, settings: Pick<Settings, "categories" | "topics">) {
  return batch.map((t, i) => {
    const cat = res.answers[`t${i}_category`]
    const flags: Record<string, number> = {}
    for (const id of Object.keys(FLAGS) as FlagId[]) flags[id] = res.answers[`t${i}_f_${id}`]?.noul ?? 0
    const topics: Record<string, number> = {}
    settings.topics.forEach((topic, j) => {
      topics[topic.id] = res.answers[`t${i}_w${j}`]?.noul ?? 0
    })
    const enrichment: Enrichment = {
      category: cat?.choice ?? "other",
      categoryConfidence: cat?.confidence ?? 0,
      signal: level(res.answers[`t${i}_signal`], SIGNAL_LEVELS.length, 0),
      tone: level(res.answers[`t${i}_tone`], TONE_LEVELS.length, 0.5),
      flags,
      topics,
    }
    return { id: t.id, enrichment }
  })
}

export async function enrich(batch: PendingTweet[], settings: Settings) {
  const { state, questions } = enrichmentQuestions(batch, settings)
  const res = await ask(settings, state, questions)
  return { results: parseEnrichment(batch, res, settings), inputTokens: res.usage?.input_tokens ?? 0, model: res.model }
}

// ── search ────────────────────────────────────────────────────────────────

export interface Ranked {
  id: string
  relevance: number
  probability: number
}

export interface RerankResult {
  ranked: Ranked[]
  answerable: number
  inputTokens: number
  model: string
  tookMs: number
  cached: boolean
}

const RELEVANCE_WEIGHT = 0.75
const rerankCache = new Map<string, Omit<RerankResult, "cached">>()

/** jev-search's judging step, pointed at tweets instead of doc pages. */
export async function rerank(query: string, candidates: StoredTweet[], settings: Settings): Promise<RerankResult> {
  // Anything sent to Jev is in the key, so new judgments, image descriptions or renamed categories miss the cache.
  const key = [
    settings.model,
    query.trim().toLowerCase(),
    candidates.map((c) => `${c.id}:${c.enrichedAt ?? ""}:${c.vision ? 1 : 0}`).join(","),
    settings.categories.map((c) => `${c.id}=${c.label}`).join("|"),
  ].join("\u0000")
  const hit = rerankCache.get(key)
  if (hit) return { ...hit, cached: true }
  const started = performance.now()

  const state = {
    query,
    about: "The user is searching tweets they saw on their X (Twitter) timeline.",
    candidates: candidates.map((t, i) => ({
      id: `c${i + 1}`,
      author: `@${t.handle}`,
      text: t.text.slice(0, 400),
      ...(t.vision ? { images: t.vision.description, ...(t.vision.text ? { text_in_image: t.vision.text.slice(0, 300) } : {}) } : {}),
      ...(t.enrichment ? { category: settings.categories.find((c) => c.id === t.enrichment!.category)?.label } : {}),
    })),
  }
  const questions: Record<string, unknown> = {}
  const best: Record<string, string> = {}
  candidates.forEach((t, i) => {
    const id = `c${i + 1}`
    best[id] = `@${t.handle}: ${(t.text || t.vision?.description || "").slice(0, 120)}${!t.text && t.vision ? " (image)" : ""}`
    questions[id] = {
      type: "noul",
      instructions: `The user typed the search query above to find a tweet they saw. Is candidate ${id} (by @${t.handle}) a tweet they would be glad to find for that query?`,
      criteria: {
        true: "The tweet is about, answers, or is clearly what the query is looking for",
        false: "The tweet is off-topic, or only shares a word or two with the query",
      },
    }
  })
  questions.best = { type: "choice", instructions: "Which candidate tweet best matches the user's search query?", criteria: best }
  questions.answerable = { type: "noul", instructions: "Does at least one candidate tweet match what the user's search query is looking for?" }

  const res = await ask(settings, state, questions, { timeoutMs: 8000, retries: 2 })
  const probs = res.answers.best?.probabilities ?? {}
  const ranked = candidates
    .map((t, i) => ({ id: t.id, relevance: res.answers[`c${i + 1}`]?.noul ?? 0, probability: probs[`c${i + 1}`] ?? 0 }))
    .sort((a, b) => blend(b) - blend(a))
  const result = {
    ranked,
    answerable: res.answers.answerable?.noul ?? 0,
    inputTokens: res.usage?.input_tokens ?? 0,
    model: res.model,
    tookMs: Math.round(performance.now() - started),
  }
  rerankCache.set(key, result)
  if (rerankCache.size > 300) rerankCache.delete(rerankCache.keys().next().value!)
  return { ...result, cached: false }
}

export const blend = (r: { relevance?: number; probability?: number }) =>
  RELEVANCE_WEIGHT * (r.relevance ?? 0) + (1 - RELEVANCE_WEIGHT) * (r.probability ?? 0)

/**
 * Keyword recall fails on questions like "people complaining about their bank"
 * when nobody used those words. Ask Jev which categories the search is about
 * so the best tweets from them can join the candidate pool.
 */
export async function route(query: string, settings: Settings): Promise<{ categories: string[]; inputTokens: number }> {
  const criteria: Record<string, string> = { any: "Could be in any category, or the query is too vague to tell" }
  for (const c of settings.categories) criteria[c.id] = `${c.label}: ${c.description}`
  const res = await ask(
    settings,
    { query },
    { category: { type: "choice", instructions: "The user is searching tweets from their timeline with the query above. Which category are the tweets they want most likely in?", criteria } },
    { timeoutMs: 5000, retries: 1 },
  )
  const probs = res.answers.category?.probabilities ?? {}
  const categories = Object.entries(probs)
    .filter(([id, p]) => id !== "any" && p >= 0.2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([id]) => id)
  return { categories, inputTokens: res.usage?.input_tokens ?? 0 }
}
