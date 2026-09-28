import { ArrowUpRight } from "lucide-react"
import { ThinkingOrb } from "thinking-orbs"
import CountUp from "@/components/CountUp"
import { VoiceBeam } from "voice-glow"
import { useResolvedTheme } from "../theme"
import { useState } from "react"
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { query } from "@/lib/rpc"
import { FLAGS, type FlagId } from "@/lib/settings"
import { PRICE_PER_TOKEN } from "@/lib/typesafe"
import { Avatar, TweetRow } from "../components/tweet"
import { Card, cn, Empty } from "../components/ui"
import { compact, duration, ingestLevel, navigate, useLive, useSettings, usd } from "../hooks"
import type { Stats } from "@/lib/types"
import { play } from "../sounds"

type Metric = "tweets" | "copies" | "enriched" | "signal"

export function Overview() {
  const [settings] = useSettings()
  const { data: stats } = useLive(() => query("stats", 30), [])
  const { data: best } = useLive(() => query("list", { sort: "foryou", hideCopies: true, enrichedOnly: true, since: Date.now() - 86_400_000, limit: 5 }), [])
  const { data: authors } = useLive(() => query("authors", 6, "tweets"), [])
  const [metric, setMetric] = useState<Metric>("tweets")
  const theme = useResolvedTheme()

  const hour = new Date().getHours()
  const greeting = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"

  if (stats && stats.tweets === 0) {
    return (
      <>
        <Header greeting={greeting} live={false} />
        <Empty icon={<ThinkingOrb state="breathing" size={64} theme={theme} aria-label="Waiting for tweets" />} title="Nothing indexed yet">
          Open <a className="underline" href="https://x.com/home" target="_blank" rel="noreferrer">x.com</a> and scroll. Every tweet that loads is captured, deduplicated and stored in SQLite on this machine.
        </Empty>
      </>
    )
  }

  const metrics: { id: Metric; label: string; value: number; sub: string }[] = stats
    ? [
        { id: "tweets", label: "Tweets indexed", value: stats.tweets, sub: `${compact(stats.sightings)} loads · ${compact(stats.authors)} authors` },
        { id: "copies", label: "Duplicates caught", value: stats.sightings - stats.unique, sub: `${plural(stats.copies, "copy", "copies")} · ${plural(stats.retweets, "retweet")} · ${plural(stats.promoted, "ad")}` },
        { id: "enriched", label: "Judged by Jev", value: stats.enriched, sub: `${stats.pending} waiting · ${usd(stats.inputTokens * PRICE_PER_TOKEN)} spent` },
        { id: "signal", label: "Average signal", value: Math.round(stats.avgSignal * 100), sub: "0 noise · 100 worth saving" },
      ]
    : []

  const series = lastDays(14, stats?.perDay ?? []).map((d) => ({
    day: d.day.slice(5),
    value: metric === "tweets" ? d.tweets : metric === "enriched" ? d.enriched : metric === "signal" ? Math.round(d.avgSignal * 100) : d.copies,
  }))
  const maxCat = Math.max(1, ...(stats?.categories ?? []).map((c) => c.count))

  return (
    <>
      <Header greeting={greeting} live />
      {/* The glow along the bottom rises as tweets stream in from x.com. */}
      <VoiceBeam level={ingestLevel} theme={theme} reach={1.1} spread={0.8} className="mb-6">
      <Card className="overflow-hidden">
        <div className="grid grid-cols-2 border-b md:grid-cols-4" role="tablist">
          {metrics.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={metric === m.id}
              onClick={() => {
                if (m.id !== metric) play("tick")
                setMetric(m.id)
              }}
              className={cn("relative border-r px-5 py-4 text-left transition-colors last:border-r-0 hover:bg-hover", metric === m.id && "bg-hover")}
            >
              <div className="text-[12px] text-muted-foreground">{m.label}</div>
              <div className="mt-1 text-[26px] font-light tabular-nums tracking-tight">
                <Counter value={m.value} />
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.sub}</div>
              {metric === m.id && <span className="absolute inset-x-0 bottom-0 h-[2px] bg-foreground" />}
            </button>
          ))}
        </div>
        <div className="h-56 px-2 pb-2 pt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ left: 0, right: 12, top: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
              <YAxis width={36} tickLine={false} axisLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                cursor={{ stroke: "var(--border-strong)" }}
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--muted-foreground)" }}
                itemStyle={{ color: "var(--foreground)" }}
                formatter={(v) => [v, metrics.find((m) => m.id === metric)?.label ?? ""]}
              />
              <Area type="monotone" dataKey="value" stroke="var(--foreground)" strokeWidth={1.5} fill="url(#fill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
      </VoiceBeam>

      <div className="mb-6 grid gap-6 md:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-medium">Categories</h2>
          {(stats?.categories.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">Categories appear once Jev has judged a few tweets.</p>}
          <div className="space-y-1">
            {stats?.categories.map((c) => (
              <button key={c.category} onClick={() => navigate("/feed", { category: c.category })} className="group flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-hover">
                <span className="w-32 truncate text-[13px]">{settings.categories.find((x) => x.id === c.category)?.label ?? c.category}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-active">
                  <span className="block h-full rounded-full bg-foreground/80" style={{ width: `${(c.count / maxCat) * 100}%` }} />
                </span>
                <span className="w-10 text-right text-[12px] tabular-nums text-muted-foreground">{c.count}</span>
                <span className="w-8 text-right text-[11px] tabular-nums text-muted-foreground" title="Average signal">{Math.round(c.avgSignal * 100)}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-medium">What Jev flagged</h2>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FLAGS) as FlagId[]).map((f) => {
              const count = stats?.flags.find((x) => x.flag === f)?.count ?? 0
              return (
                <button key={f} onClick={() => navigate("/feed", { flag: f })} className="flex items-center gap-2 rounded-full border border-border-strong px-3 py-1.5 text-[13px] hover:bg-hover">
                  {FLAGS[f].label}
                  <span className="tabular-nums text-muted-foreground">{count}</span>
                </button>
              )
            })}
          </div>
          <h2 className="mb-3 mt-6 text-sm font-medium">Most seen authors</h2>
          <div className="space-y-1">
            {authors?.map((a) => (
              <button key={a.handle} onClick={() => navigate("/feed", { handle: a.handle })} className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left text-[13px] hover:bg-hover">
                <Avatar src={a.avatar} handle={a.handle} size={20} />
                <span className="truncate">{a.name}</span>
                <span className="truncate text-muted-foreground">@{a.handle}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{a.tweets}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      {stats && stats.attention.engaged > 0 && <AttentionCard stats={stats} labels={Object.fromEntries(settings.categories.map((c) => [c.id, c.label]))} />}

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">For you, last 24 hours</h2>
        <button onClick={() => navigate("/feed", { sort: "foryou" })} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          Jev's signal × your attention <ArrowUpRight className="size-3" />
        </button>
      </div>
      <Card>
        {best?.tweets.length ? best.tweets.map((t) => <TweetRow key={t.id} tweet={t} settings={settings} />) : <p className="p-6 text-sm text-muted-foreground">Nothing judged in the last day yet.</p>}
      </Card>
    </>
  )
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

/**
 * React Bits CountUp for the metric strip: counts up on first view, then
 * springs to each new value as tweets stream in. Big numbers stay compact.
 */
function Counter({ value }: { value: number }) {
  if (value >= 100_000 || reducedMotion.matches) return <>{compact(value)}</>
  return <CountUp to={value} separator="," duration={0.9} />
}

/** Where your reading time goes, next to what Jev thinks each category is worth. */
function AttentionCard({ stats, labels }: { stats: Stats; labels: Record<string, string> }) {
  const a = stats.attention
  const total = Math.max(1, a.byCategory.reduce((n, c) => n + c.dwellMs, 0))
  return (
    <Card className="mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Your attention</h2>
        <span className="text-[12px] text-muted-foreground">
          {duration(a.todayMs)} reading today · {duration(a.dwellMs)} in total · {a.clicks} clicks on {a.engaged} tweets
        </span>
      </div>
      <div className="mb-2 grid grid-cols-[8rem_1fr_3.5rem_3.5rem] gap-3 text-[11px] text-muted-foreground">
        <span />
        <span>Share of your reading time</span>
        <span className="text-right" title="Your average interest in tweets you read here">You</span>
        <span className="text-right" title="Jev's average signal for tweets you read here">Jev</span>
      </div>
      <div className="space-y-1.5">
        {a.byCategory.slice(0, 8).map((c) => {
          // Lots of time on low-signal tweets is worth a gentle nudge.
          const sink = c.dwellMs / total > 0.2 && c.avgSignal < 0.35
          return (
            <button key={c.category} onClick={() => navigate("/feed", { category: c.category, sort: "attention" })} className="grid w-full grid-cols-[8rem_1fr_3.5rem_3.5rem] items-center gap-3 rounded-md px-0 py-0.5 text-left hover:bg-hover">
              <span className="truncate text-[13px]">{labels[c.category] ?? c.category}</span>
              <span className="flex items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-active">
                  <span className={cn("block h-full rounded-full", sink ? "bg-amber-400/80" : "bg-foreground/80")} style={{ width: `${(c.dwellMs / total) * 100}%` }} />
                </span>
                <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground">{duration(c.dwellMs)}</span>
              </span>
              <span className="text-right text-[12px] tabular-nums">{Math.round(c.interest * 100)}</span>
              <span className={cn("text-right text-[12px] tabular-nums", sink ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{Math.round(c.avgSignal * 100)}</span>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

/** Every day in the window, zero-filled, so a quiet day reads as a dip rather than a gap. */
function lastDays<T extends { day: string; tweets: number; enriched: number; avgSignal: number; copies: number }>(n: number, rows: T[]) {
  const byDay = new Map(rows.map((r) => [r.day, r]))
  const earliest = rows[0]?.day
  const out: { day: string; tweets: number; enriched: number; avgSignal: number; copies: number }[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    if (earliest && day < earliest && out.length === 0 && i > 6) continue
    out.push(byDay.get(day) ?? { day, tweets: 0, enriched: 0, avgSignal: 0, copies: 0 })
  }
  return out
}

function Header({ greeting, live }: { greeting: string; live: boolean }) {
  return (
    <div className="mb-8">
      <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-border-strong px-2.5 py-1 text-[12px] text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", live ? "bg-emerald-400" : "bg-muted-foreground")} />
        {live ? "Indexing x.com as you scroll" : "Waiting for x.com"}
      </span>
      <h1 className="text-[32px] font-light tracking-tight">{greeting}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Everything you've scrolled past, deduplicated and sorted by Jev.</p>
    </div>
  )
}
