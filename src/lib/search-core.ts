/**
 * Query handling shared by the SQLite keyword pass and the UI highlighter.
 * Tokenizer, stop words and highlighter come from jev-search
 * (github.com/kylemclaren/jevsearch, MIT); FTS5's porter tokenizer does the
 * stemming on the SQLite side.
 */

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "the", "to",
  "what", "with", "you", "your", "about", "tweets", "tweet", "someone", "people",
  "who", "that", "this", "any", "was", "were", "me", "show", "find",
])

/** Latin combining accents, which FTS5's remove_diacritics also drops. */
const LATIN_ACCENTS = /[̀-ͯ]/g

/**
 * Lowercase, strip Latin accents, then recompose, so Hangul, kana and Indic
 * scripts stay whole. Combining marks count as word characters for the same
 * reason (Devanagari vowel signs are marks).
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(LATIN_ACCENTS, "")
    .normalize("NFC")
    .split(/[^\p{L}\p{M}\p{N}_]+/u)
    .filter((t) => t.length > 0)
}

/** Query words: stop words dropped unless the query is nothing but stop words. */
export function queryTerms(query: string): string[] {
  const all = words(query)
  const kept = all.filter((t) => !STOP.has(t))
  return [...new Set(kept.length > 0 ? kept : all)]
}

/** Single characters are words in Chinese, Japanese and Korean; elsewhere they're noise. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * An FTS5 MATCH expression. Terms are OR'd so a question written in plain
 * words still recalls tweets that share only some of them; bm25 rewards the
 * ones that share more. Each term is quoted and prefix-matched.
 */
export function ftsQuery(query: string): string | undefined {
  const terms = queryTerms(query).filter((t) => t.length > 1 || /\d/.test(t) || CJK.test(t))
  if (terms.length === 0) return undefined
  return terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ")
}

/**
 * Split text into [plain, match, plain, match…] segments for highlighting.
 * Matching runs on a folded copy (lowercase, Latin accents off, as the query
 * terms are) with a map back to the original characters, so "cafe" lights up
 * "café" and Hangul or kana are compared whole.
 */
export function highlightSegments(text: string, terms: string[]): { text: string; match: boolean }[] {
  if (!text || terms.length === 0) return [{ text, match: false }]
  const usable = terms.filter((t) => t.length > 1 || CJK.test(t)).sort((a, b) => b.length - a.length)
  if (usable.length === 0) return [{ text, match: false }]

  const chars = [...text]
  let folded = ""
  /** UTF-16 unit in `folded` → index in `chars`. */
  const back: number[] = []
  chars.forEach((ch, i) => {
    const f = ch.normalize("NFD").replace(LATIN_ACCENTS, "").normalize("NFC").toLowerCase()
    folded += f
    for (let u = 0; u < f.length; u++) back.push(i)
  })
  back.push(chars.length)

  const re = new RegExp(`(${usable.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gu")
  const out: { text: string; match: boolean }[] = []
  let last = 0
  for (const m of folded.matchAll(re)) {
    const from = back[m.index ?? 0]
    const to = back[(m.index ?? 0) + m[0].length - 1] + 1
    if (from > last) out.push({ text: chars.slice(last, from).join(""), match: false })
    out.push({ text: chars.slice(from, to).join(""), match: true })
    last = to
  }
  if (last < chars.length) out.push({ text: chars.slice(last).join(""), match: false })
  return out
}
