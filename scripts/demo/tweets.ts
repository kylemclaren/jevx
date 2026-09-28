/**
 * A fictional timeline for the demo dashboard and README screenshots.
 * Every account and tweet here is made up.
 */
import type { CapturedTweet, Enrichment } from "../../src/lib/types"

const pic = (seed: string, w: number, h: number) => ({ type: "photo", url: `https://picsum.photos/seed/${seed}/${w}/${h}`, width: w, height: h })

interface DemoTweet {
  handle: string
  name: string
  text: string
  minutesAgo: number
  category: string
  signal: number
  flags?: Record<string, number>
  topics?: Record<string, number>
  extra?: Partial<CapturedTweet>
}

const rows: DemoTweet[] = [
  { handle: "auroralabs", name: "Aurora Labs", text: "Today we're releasing Aurora 3 Small under Apache 2.0. Weights are up now; 3x faster than v2 with much better tool use.", minutesAgo: 20, category: "ai", signal: 0.86, flags: { launch: 0.99, promo: 0.7 }, topics: { "open-model": 0.99 } },
  { handle: "modelwatch", name: "Model Watch", text: "This is the one to watch. Apache 2.0 and genuinely good at tool use 👇", minutesAgo: 34, category: "ai", signal: 0.64, extra: { via: "evalnotes" } },
  { handle: "pgtuning", name: "Postgres Tuning", text: "Thread: 7 things I learned tuning autovacuum on a 4TB table.\n\n1/ The default scale factor is lying to you. On big tables set autovacuum_vacuum_scale_factor to 0 and use a fixed threshold.\n\n2/ Watch n_dead_tup, not just table size.\n\n3/ Cost-based delay defaults are tuned for spinning disks. On NVMe raise the cost limit to 2000+.\n\n4/ Long-running transactions block cleanup. Find them and kill anything idle in transaction.\n\n5/ Partition the hot table by time.", minutesAgo: 52, category: "dev", signal: 0.9, flags: { thread: 0.92 } },
  { handle: "growthhacks", name: "Growth Hacks", text: "99% of founders will ignore this. Reply 'SCALE' and I'll DM you my secret playbook 👇", minutesAgo: 70, category: "startups", signal: 0.02, flags: { bait: 0.97, promo: 0.9 } },
  { handle: "scalehacks", name: "Scale Hacks", text: "99% of founders will ignore this. Reply 'SCALE' and I'll DM you my secret playbook 👇👇", minutesAgo: 71, category: "startups", signal: 0.02, flags: { bait: 0.97 } },
  { handle: "orbitaldaily", name: "Orbital Daily", text: "Nova 14 booster caught on the first try again. The upper stage splashed down on target.", minutesAgo: 95, category: "science", signal: 0.76, extra: { media: [pic("rocket-launch", 1600, 900)] } },
  { handle: "dana_codes", name: "Dana", text: "Can anyone recommend a good pediatric dentist in Portland? Ours just retired 😭", minutesAgo: 120, category: "personal", signal: 0.35, flags: { question: 0.97 } },
  { handle: "ferrousdb", name: "Ferrous DB", text: "We're hiring senior Rust engineers, remote-friendly. Come build a very fast database → ferrous.example/jobs", minutesAgo: 150, category: "startups", signal: 0.62, flags: { promo: 0.8 }, topics: { hiring: 0.99 } },
  { handle: "catmemes_daily", name: "Cat Memes Daily", text: "me explaining to my cat why the 3am zoomies are not a sustainable lifestyle", minutesAgo: 170, category: "culture", signal: 0.28, flags: { humor: 0.97 }, extra: { media: [pic("sleepy-cat", 900, 900)] } },
  { handle: "civicdesk", name: "Civic Desk", text: "The city council voted 7-4 tonight to approve the new housing plan along the north corridor.", minutesAgo: 200, category: "politics", signal: 0.7 },
  { handle: "macro_mia", name: "Mia on Macro", text: "Central bank holds rates steady; its projections now show two cuts next year instead of three. Bond markets barely moved.", minutesAgo: 230, category: "finance", signal: 0.72 },
  { handle: "rust_tips", name: "Rust Tips", text: "TIL you can use `let else` to flatten early returns in Rust. Makes parsing code so much cleaner.", minutesAgo: 260, category: "dev", signal: 0.8, flags: { thread: 0.7 } },
  { handle: "runner_sam", name: "Sam Runs", text: "Finished my first marathon today!! 4:12 and my legs are jelly but I'm so happy 🥹", minutesAgo: 290, category: "personal", signal: 0.33, extra: { media: [pic("marathon-a", 900, 1200), pic("marathon-b", 1200, 900)] } },
  { handle: "seedstage", name: "Seed Stage", text: "The best founders I've backed all had one thing in common: they talked to users every week, even at 500 people.", minutesAgo: 320, category: "startups", signal: 0.7 },
  { handle: "paperdigest", name: "Paper Digest", text: "New paper: small models fine-tuned on reasoning traces close most of the gap to much larger ones on math. Code and data released today.", minutesAgo: 350, category: "ai", signal: 0.9, flags: { launch: 0.8 } },
  { handle: "pizza_opinions", name: "Pizza Opinions", text: "Hot take: pineapple on pizza is fine and you're all being dramatic.", minutesAgo: 380, category: "culture", signal: 0.2, flags: { humor: 0.8 }, extra: { media: [pic("pizza-1", 800, 800), pic("pizza-2", 800, 800), pic("pizza-3", 800, 800), pic("pizza-4", 800, 800)] } },
  { handle: "toolchain_weekly", name: "Toolchain Weekly", text: "Our runtime 2.0 is out: a built-in object storage client, faster installs, and a watch mode for tests.", minutesAgo: 410, category: "dev", signal: 0.7, flags: { launch: 0.95 } },
  { handle: "climate_notes", name: "Climate Notes", text: "New satellite data shows sea ice hit a record low for September. Here's what's driving it and why it matters.", minutesAgo: 440, category: "science", signal: 0.75, extra: { media: [pic("sea-ice", 1280, 720)] } },
  { handle: "grumpy_traveler", name: "Grumpy Traveler", text: "Flight delayed 6 hours, no food vouchers, and the app keeps saying 'on time'. Never flying this airline again.", minutesAgo: 470, category: "personal", signal: 0.35 },
  { handle: "labsjobs", name: "Frontier Research", text: "We're hiring research engineers to work on open-weights models. Remote-friendly. Details below.", minutesAgo: 500, category: "ai", signal: 0.8, topics: { hiring: 0.99 } },
  { handle: "learn_systems", name: "Alex", text: "What's the best way to learn system design? Books, courses, or just building things?", minutesAgo: 530, category: "dev", signal: 0.55, flags: { question: 0.95 } },
  { handle: "indiegamer", name: "Pixel Pete", text: "Finally finished the hollow knight-like I've been playing for a month. No regrets about the sleep.", minutesAgo: 560, category: "culture", signal: 0.3, extra: { media: [pic("game-a", 1200, 800), pic("game-b", 800, 800), pic("game-c", 800, 800)] } },
]

export function demoTweets(now = Date.now()): { tweets: CapturedTweet[]; enrichments: { id: string; enrichment: Enrichment }[] } {
  const tweets: CapturedTweet[] = rows.map((r, i) => ({
    id: String(1_900_000_000_000_000_000n + BigInt(i * 7919)),
    authorId: `u_${r.handle}`,
    handle: r.handle,
    name: r.name,
    verified: i % 3 === 0,
    text: r.text,
    lang: "en",
    createdAt: now - r.minutesAgo * 60_000,
    likes: Math.round(40 + ((i * 7919) % 4800)),
    retweets: (i * 131) % 400,
    replies: (i * 37) % 200,
    quotes: 3,
    bookmarks: 10,
    views: 5000 + ((i * 104_729) % 390_000),
    media: [],
    urls: [],
    promoted: false,
    ...r.extra,
  }))
  // The second tweet quotes the first.
  tweets[1].quotedId = tweets[0].id
  const enrichments = rows.map((r, i) => ({
    id: tweets[i].id,
    enrichment: { category: r.category, categoryConfidence: 0.9, signal: r.signal, tone: 0.55, flags: r.flags ?? {}, topics: r.topics ?? {} },
  }))
  return { tweets, enrichments }
}
