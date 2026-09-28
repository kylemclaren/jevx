import { BorderBeam } from "border-beam"
import { ArrowUp } from "lucide-react"
import { Comet } from "loading-dev"
import { useEffect, useRef, useState } from "react"
import { play } from "../sounds"
import { useResolvedTheme } from "../theme"
import { TweetRow } from "../components/tweet"
import { Card, cn, Empty } from "../components/ui"
import { navigate, useRoute, useSettings } from "../hooks"
import { useTweetSearch } from "../search"

const SUGGESTIONS = ["that thread about postgres performance", "someone hiring engineers", "new open source models", "funny posts about cats", "people complaining about airlines"]

export function SearchPage() {
  const { params } = useRoute()
  const [settings] = useSettings()
  const urlQ = params.get("q") ?? ""
  const [q, setQ] = useState(urlQ)
  // A new query arriving by URL (⌘K "all results", "Find similar") replaces the box.
  const lastUrlQ = useRef(urlQ)
  useEffect(() => {
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ
      setQ(urlQ)
    }
  }, [urlQ])
  const s = useTweetSearch(q, {}, { lexicalLimit: 60 })
  const theme = useResolvedTheme()
  useEffect(() => {
    if (s.phase === "done" && s.jev && !s.jev.cached) play("ranked")
  }, [s.phase, s.jev])

  // Keep the URL shareable without a history entry per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      lastUrlQ.current = q
      history.replaceState(null, "", q ? `#/search?q=${encodeURIComponent(q)}` : "#/search")
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  return (
    <>
      <div className="mx-auto mb-8 max-w-2xl pt-6 text-center">
        <h1 className="mb-6 text-[28px] font-light tracking-tight">What was that tweet?</h1>
        <BorderBeam size="md" active={s.phase === "judging"} colorVariant="ocean" theme={theme} strength={0.7}>
        <div className="flex items-center gap-2 rounded-full border border-border-strong bg-card py-1.5 pl-5 pr-1.5 shadow-sm focus-within:border-foreground/40">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Describe it the way you remember it"
            className="h-9 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
            {s.phase === "judging" ? (
              <span role="status" aria-label="Jev is reading the matches" className="flex">
                <Comet size={18} />
              </span>
            ) : (
              <ArrowUp className="size-4" />
            )}
          </span>
        </div>
        </BorderBeam>
        {!q && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((x) => (
              <button key={x} onClick={() => { play("tick"); setQ(x) }} className="rounded-full border border-border-strong px-3 py-1 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground">
                {x}
              </button>
            ))}
          </div>
        )}
      </div>

      {q && (
        <div className="mb-3 flex items-center gap-2 text-[12px] text-muted-foreground">
          {s.phase === "judging" && <span className="shimmer">Keyword hits in {s.lexicalMs} ms · Jev is reading them…</span>}
          {s.phase === "done" && s.jev && (
            <span>
              Keywords {s.lexicalMs} ms → Jev ranked {s.hits.length + Math.min(s.demoted.length, settings.searchCandidates)} in {s.jev.tookMs} ms
              {s.jev.cached ? " (cached)" : ` · ${s.jev.inputTokens.toLocaleString()} tokens`}
              {s.jev.expanded.length > 0 && ` · ${s.jev.expanded.length} found by topic, not keywords`}
              {" · "}
              <span className={cn(s.jev.answerable < 0.5 && "text-amber-600 dark:text-amber-400")}>
                {s.jev.answerable >= 0.5 ? "a match is likely here" : "probably not in your index yet"}
              </span>
            </span>
          )}
          {s.phase === "error" && <span className="text-amber-600 dark:text-amber-400">Showing keyword order. Jev: {s.error}</span>}
        </div>
      )}

      {q && s.hits.length === 0 && s.demoted.length === 0 && (s.phase === "done" || s.phase === "error") && (
        <Empty title="Nothing matches yet">
          Only tweets you've loaded on X are here. Try other words, or <button className="underline" onClick={() => navigate("/feed")}>browse the feed</button>.
        </Empty>
      )}

      {s.hits.length > 0 && (
        <Card>
          {s.hits.map((h) => (
            <TweetRow key={h.tweet.id} tweet={h.tweet} settings={settings} terms={h.terms} relevance={h.relevance} note={h.expanded ? "found by topic" : undefined} />
          ))}
        </Card>
      )}
      {s.phase === "done" && s.demoted.length > 0 && (
        <>
          <h2 className="mb-2 mt-8 text-[12px] text-muted-foreground">Keyword matches Jev thinks are off-target</h2>
          <Card>
            {s.demoted.slice(0, 20).map((h) => (
              <TweetRow key={h.tweet.id} tweet={h.tweet} settings={settings} terms={h.terms} relevance={h.relevance} dimmed />
            ))}
          </Card>
        </>
      )}
    </>
  )
}
