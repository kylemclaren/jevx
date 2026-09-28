/** User settings, kept in chrome.storage.local. The tweet index itself lives in SQLite. */

export interface Category {
  id: string
  label: string
  /** What belongs here, in plain words. Jev reads this as the Choice criterion. */
  description: string
}

export interface WatchTopic {
  id: string
  label: string
  /** The condition Jev checks, e.g. "announces a new open-weights model". */
  description: string
  threshold: number
}

export interface Settings {
  apiKey: string
  model: string
  autoEnrich: boolean
  /** Tweets judged per TypeSafe request. */
  batchSize: number
  concurrency: number
  categories: Category[]
  topics: WatchTopic[]
  /** Store a tweet only once it has actually been on screen, not just loaded by the page. */
  indexOnlySeen: boolean
  /** Show category/signal chips on tweets on x.com. */
  inlineBadges: boolean
  /** Fade tweets on x.com whose signal is below this (0 disables). */
  dimBelow: number
  /** Fade tweets Jev thinks are engagement bait. */
  dimBait: boolean
  /** Candidates Jev judges per search. */
  searchCandidates: number
  /** Dashboard theme. */
  theme: "system" | "light" | "dark"
  /** UI sounds in the dashboard. */
  sounds: boolean
  soundVolume: number
  /** Describe tweet images with ChatGPT (needs Sign in with ChatGPT). */
  vision: boolean
  visionModel: string
  /** Tweets with images analysed per hour, to protect your ChatGPT quota. */
  visionPerHour: number
}

export const FLAGS = {
  bait: {
    label: "Bait",
    instructions: "Is this tweet engagement bait or rage bait: written mainly to provoke replies, quote-tweets or outrage rather than to inform or share something?",
    criteria: { true: "Built to farm engagement: provocative hot take, 'reply with…', manufactured outrage, or a teaser that withholds the point", false: "A genuine post: information, opinion, humour or conversation offered in good faith" },
  },
  promo: {
    label: "Promo",
    instructions: "Is this tweet selling or advertising something: a product, course, newsletter, giveaway, sponsor or affiliate link?",
    criteria: { true: "Its main purpose is to promote or sell", false: "Not primarily promotional" },
  },
  launch: {
    label: "Launch",
    instructions: "Does this tweet announce something new that the author or their organisation released or shipped: a product, feature, version, paper, dataset or open-source project?",
    criteria: { true: "Announces a new release or launch", false: "No release is being announced" },
  },
  question: {
    label: "Question",
    instructions: "Is the author genuinely asking their audience a question and hoping for answers or recommendations?",
    criteria: { true: "A real request for answers, help or recommendations", false: "Not a question, or a rhetorical one" },
  },
  humor: {
    label: "Humor",
    instructions: "Is this tweet mainly a joke, meme or shitpost?",
    criteria: { true: "Primarily meant to be funny", false: "Primarily serious" },
  },
  thread: {
    label: "Resource",
    instructions: "Is this tweet a resource worth saving for later: a tutorial, guide, thread of tips, useful link, reference or in-depth explanation?",
    criteria: { true: "Something a reader would bookmark and come back to", false: "Ephemeral: chatter, reaction or news with no lasting reference value" },
  },
} as const

export type FlagId = keyof typeof FLAGS

export const DEFAULT_CATEGORIES: Category[] = [
  { id: "ai", label: "AI & ML", description: "Artificial intelligence, machine learning, LLMs, models, agents, AI products and research" },
  { id: "dev", label: "Software", description: "Programming, developer tools, infrastructure, open source, engineering practice" },
  { id: "startups", label: "Startups & business", description: "Startups, fundraising, companies, markets, product strategy, careers and work" },
  { id: "science", label: "Science & tech", description: "Science, hardware, space, biology, energy, and technology outside software and AI" },
  { id: "politics", label: "Politics & news", description: "Politics, government, policy, elections, geopolitics and current events" },
  { id: "finance", label: "Money & crypto", description: "Investing, stocks, economics, personal finance, crypto and web3" },
  { id: "culture", label: "Culture", description: "Entertainment, sports, art, music, film, games, food, travel and internet culture" },
  { id: "personal", label: "Personal", description: "Personal life, feelings, day-to-day updates, family, health and self-improvement" },
  { id: "other", label: "Other", description: "Fits none of the other categories" },
]

export const DEFAULT_TOPICS: WatchTopic[] = [
  { id: "open-model", label: "Open model releases", description: "A new open-weights AI model is released or announced", threshold: 0.7 },
  { id: "hiring", label: "Hiring", description: "Someone is hiring or announcing an open job", threshold: 0.7 },
]

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  model: "jev-latest",
  autoEnrich: true,
  batchSize: 6,
  concurrency: 2,
  categories: DEFAULT_CATEGORIES,
  topics: DEFAULT_TOPICS,
  indexOnlySeen: true,
  inlineBadges: true,
  dimBelow: 0,
  dimBait: false,
  searchCandidates: 20,
  theme: "system",
  sounds: true,
  soundVolume: 0.6,
  vision: true,
  visionModel: "gpt-5.2",
  visionPerHour: 120,
}

/** Stored settings over the defaults; list items written by older versions get today's defaults for new fields. */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...stored }
  s.topics = (s.topics ?? []).map((t) => ({ ...t, threshold: typeof t.threshold === "number" ? t.threshold : 0.7 }))
  if (!Array.isArray(s.categories) || s.categories.length === 0) s.categories = DEFAULT_CATEGORIES
  return s
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings((await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined)
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch }
  await chrome.storage.local.set({ settings: next })
  return next
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || `x${Date.now().toString(36)}`
}
