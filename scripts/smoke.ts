/** Live check against TypeSafe: bun run scripts/smoke.ts (needs TYPESAFE_API_KEY). */
import { DEFAULT_SETTINGS } from "../src/lib/settings"
import type { PendingTweet } from "../src/lib/store"
import type { StoredTweet } from "../src/lib/types"
import { enrich, PRICE_PER_TOKEN, rerank, route } from "../src/lib/typesafe"

const settings = { ...DEFAULT_SETTINGS, apiKey: process.env.TYPESAFE_API_KEY ?? "" }
const tweets: PendingTweet[] = [
  { id: "1", handle: "auroralabs", name: "Aurora Labs", text: "Today we're releasing Aurora 3 Small under Apache 2.0, weights available now. 3x faster than v2 with better reasoning.", hasMedia: false, links: ["aurora.example/models"], isReply: false },
  { id: "2", handle: "growthguru", name: "Growth Guru", text: "99% of founders will ignore this. Reply 'SCALE' and I'll DM you my secret playbook 👇", hasMedia: false, links: [], isReply: false },
  { id: "3", handle: "jane", name: "Jane", text: "Can anyone recommend a good pediatric dentist in Oakland? Ours just retired 😭", hasMedia: false, links: [], isReply: false },
  { id: "4", handle: "dbguy", name: "Postgres Fan", text: "Thread: 7 things I learned tuning Postgres autovacuum on a 4TB table. 1/ Your default scale factor is lying to you…", hasMedia: false, links: [], isReply: false },
  { id: "5", handle: "memes", name: "Memes", text: "me explaining to my cat why the 3am zoomies are not a sustainable lifestyle", hasMedia: true, links: [], isReply: false },
  { id: "6", handle: "acme", name: "Acme", text: "We're hiring senior Rust engineers in Berlin or remote. Come build the fastest database on earth.", hasMedia: false, links: ["acme.dev/jobs"], isReply: false },
]

const t0 = performance.now()
const { results, inputTokens, model } = await enrich(tweets, settings)
console.log(`enrich: ${model}, ${Math.round(performance.now() - t0)} ms, ${inputTokens} tokens ($${(inputTokens * PRICE_PER_TOKEN).toFixed(5)})`)
for (const r of results) {
  const t = tweets.find((x) => x.id === r.id)!
  const e = r.enrichment
  const flags = Object.entries(e.flags).filter(([, p]) => p >= 0.5).map(([f, p]) => `${f}:${p.toFixed(2)}`)
  const topics = Object.entries(e.topics).filter(([, p]) => p >= 0.5).map(([f, p]) => `${f}:${p.toFixed(2)}`)
  console.log(`  @${t.handle.padEnd(11)} ${e.category.padEnd(9)} (${e.categoryConfidence.toFixed(2)}) signal ${e.signal.toFixed(2)} tone ${e.tone.toFixed(2)} ${flags.join(" ")} ${topics.join(" ")}`)
}

const stored = tweets.map((t) => ({ ...t, text: t.text, createdAt: 0 }) as unknown as StoredTweet)
const q = "where can I find a kids dentist"
const r = await rerank(q, stored, settings)
console.log(`rerank "${q}": ${r.tookMs} ms, ${r.inputTokens} tokens, answerable ${r.answerable.toFixed(2)}`)
for (const x of r.ranked.slice(0, 3)) console.log(`  ${x.id} relevance ${x.relevance.toFixed(2)} best ${x.probability.toFixed(2)}`)
console.log("route 'new open source LLMs':", await route("new open source LLMs", settings))
