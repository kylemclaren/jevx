import { expect, test } from "bun:test"
import { DEFAULT_SETTINGS, FLAGS } from "../src/lib/settings"
import type { PendingTweet } from "../src/lib/store"
import { enrichmentQuestions, parseEnrichment, type JevResponse } from "../src/lib/typesafe"

const batch: PendingTweet[] = [
  { id: "1", handle: "a", name: "A", text: "We just released v2 of our open-weights model", hasMedia: false, links: [], isReply: false },
  { id: "2", handle: "b", name: "B", text: "lol", quotedText: "something", quotedHandle: "c", hasMedia: true, links: ["x.com"], isReply: true },
]

test("one question set per tweet, all pointing at its own state path", () => {
  const { state, questions } = enrichmentQuestions(batch, DEFAULT_SETTINGS)
  const perTweet = 3 + Object.keys(FLAGS).length + DEFAULT_SETTINGS.topics.length
  expect(Object.keys(questions)).toHaveLength(perTweet * 2)
  expect(JSON.stringify(questions.t1_signal)).toContain("`tweets[1]`")
  expect((state.tweets[1] as Record<string, unknown>).quoting).toEqual({ author: "@c", text: "something" })
  const cat = questions.t0_category as { criteria: Record<string, string> }
  expect(Object.keys(cat.criteria)).toEqual(DEFAULT_SETTINGS.categories.map((c) => c.id))
})

test("maps answers onto enrichment, normalizing scores", () => {
  const res: JevResponse = {
    model: "jev-1.13.0",
    usage: { input_tokens: 900, output_tokens: 10 },
    answers: {
      t0_category: { type: "choice", choice: "ai", confidence: 0.8, probabilities: { ai: 0.9 } },
      t0_signal: { type: "score", score: 3 },
      t0_tone: { type: "score", score: 4 },
      t0_f_launch: { type: "noul", noul: 0.97 },
      t0_w0: { type: "noul", noul: 0.91 },
    },
  }
  const [a, b] = parseEnrichment(batch, res, DEFAULT_SETTINGS)
  expect(a.enrichment).toMatchObject({ category: "ai", categoryConfidence: 0.8, signal: 1, tone: 1 })
  expect(a.enrichment.flags.launch).toBe(0.97)
  expect(a.enrichment.topics["open-model"]).toBe(0.91)
  expect(b.enrichment).toMatchObject({ category: "other", signal: 0, tone: 0.5 })
})
