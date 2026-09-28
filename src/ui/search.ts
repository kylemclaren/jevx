import { useEffect, useRef, useState } from "react"
import { query, send, type RerankReply } from "@/lib/rpc"
import type { SearchHit, StoredTweet, TweetFilters } from "@/lib/types"

const THRESHOLD = 0.15

export interface SearchState {
  hits: SearchHit[]
  /** Judged but below threshold. */
  demoted: SearchHit[]
  phase: "idle" | "lexical" | "judging" | "done" | "error"
  lexicalMs?: number
  jev?: Omit<RerankReply, "ranked" | "tweets">
  error?: string
}

/**
 * jev-search's two passes against the local index: FTS5 hits on the first
 * keystroke, then Jev's ranking a moment later, with rows moving into place.
 */
export function useTweetSearch(q: string, filters: TweetFilters = {}, { lexicalLimit = 40 } = {}): SearchState {
  const [state, setState] = useState<SearchState>({ hits: [], demoted: [], phase: "idle" })
  const seq = useRef(0)
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    const id = ++seq.current
    const text = q.trim()
    if (!text) {
      setState({ hits: [], demoted: [], phase: "idle" })
      return
    }
    // The rows on screen are the last query's until the keyword pass answers.
    setState((s) => ({ ...s, phase: "lexical", jev: undefined, error: undefined }))
    const lexTimer = setTimeout(async () => {
      const t0 = performance.now()
      let hits: SearchHit[]
      try {
        hits = await query("search", text, filters, lexicalLimit)
      } catch (err) {
        if (id === seq.current) setState({ hits: [], demoted: [], phase: "error", error: (err as Error).message })
        return
      }
      if (id !== seq.current) return
      setState({ hits, demoted: [], phase: "judging", lexicalMs: Math.round(performance.now() - t0) })

      // Let typing settle before spending tokens.
      await new Promise((r) => setTimeout(r, 250))
      if (id !== seq.current) return
      try {
        const reply = await send<RerankReply>({ type: "rerank", query: text, ids: hits.map((h) => h.tweet.id) })
        if (id !== seq.current) return
        const byId = new Map<string, StoredTweet>(reply.tweets.map((t) => [t.id, t]))
        const lexical = new Map(hits.map((h) => [h.tweet.id, h]))
        const expanded = new Set(reply.expanded)
        const judged: SearchHit[] = reply.ranked.map((r) => ({
          tweet: byId.get(r.id)!,
          score: lexical.get(r.id)?.score ?? 0,
          terms: lexical.get(r.id)?.terms ?? [],
          relevance: r.relevance,
          probability: r.probability,
          expanded: expanded.has(r.id),
        }))
        let kept = judged.filter((h) => (h.relevance ?? 0) >= THRESHOLD)
        if (kept.length === 0) kept = judged.slice(0, 3)
        const keptIds = new Set(kept.map((h) => h.tweet.id))
        const judgedIds = new Set(judged.map((h) => h.tweet.id))
        // Keyword hits beyond the judged pool keep their place at the bottom.
        const rest = hits.filter((h) => !judgedIds.has(h.tweet.id))
        const { ranked: _r, tweets: _t, ...jev } = reply
        setState((s) => ({
          ...s,
          hits: kept,
          demoted: [...judged.filter((h) => !keptIds.has(h.tweet.id)), ...rest],
          phase: "done",
          jev,
        }))
      } catch (err) {
        if (id === seq.current) setState((s) => ({ ...s, phase: "error", error: (err as Error).message }))
      }
    }, 120)
    return () => clearTimeout(lexTimer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filterKey, lexicalLimit])

  return state
}
