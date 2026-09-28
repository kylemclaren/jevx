import { BarChart3 as SignalIcon, Clock, Copy, Download, Eye, Heart, Inbox, Megaphone, MessageSquareOff, Repeat, Sparkles, Timer, X } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { query } from "@/lib/rpc"
import { FLAGS, type FlagId } from "@/lib/settings"
import type { TweetFilters } from "@/lib/types"
import { TweetRow } from "../components/tweet"
import { Card, PageTitle, Spinner } from "../components/ui"
import { navigate, useLive, useRoute, useSettings } from "../hooks"
import { play } from "../sounds"
import { downloadJson } from "./Settings"

type Sort = NonNullable<TweetFilters["sort"]>
type SeenRange = "any" | "1h" | "today" | "7d" | "30d"

const SORTS: Record<Sort, string> = {
  foryou: "For you",
  recent: "Latest",
  lastSeen: "Last seen",
  signal: "Top signal",
  likes: "Most liked",
  attention: "Your attention",
  seen: "Most seen",
}

const SORT_ICONS: Record<Sort, typeof Eye> = {
  foryou: Sparkles,
  recent: Clock,
  lastSeen: Eye,
  signal: SignalIcon,
  likes: Heart,
  attention: Timer,
  seen: Repeat,
}

const SEEN_SHORT: Record<SeenRange, string> = { any: "Any time", "1h": "1h", today: "Today", "7d": "7d", "30d": "30d" }

const SEEN: Record<SeenRange, string> = {
  any: "Seen any time",
  "1h": "Seen in the last hour",
  today: "Seen today",
  "7d": "Seen this week",
  "30d": "Seen this month",
}

/** The cutoff for a range, rounded to the minute so the list query doesn't change on every render. */
function seenSinceFor(range: SeenRange): number | undefined {
  const minute = Math.floor(Date.now() / 60_000) * 60_000
  switch (range) {
    case "1h": return minute - 3_600_000
    case "today": return new Date().setHours(0, 0, 0, 0)
    case "7d": return minute - 7 * 86_400_000
    case "30d": return minute - 30 * 86_400_000
    default: return undefined
  }
}

const PAGE = 50

/** Category and flag chips: outline at rest, inverse when selected. */
const CHIP =
  "rounded-full px-3 text-[12px] text-muted-foreground data-[pressed]:border-primary data-[pressed]:bg-primary data-[pressed]:text-primary-foreground [&[data-pressed]_span]:text-primary-foreground/70"

/**
 * Everything captured, filtered and sorted. All filters live in the URL, so a
 * view survives reloads, back/forward and bookmarks.
 */
export function Feed() {
  const { params } = useRoute()
  const [settings] = useSettings()
  const [limit, setLimit] = useState(PAGE)

  const sort = (params.get("sort") as Sort | null) ?? "recent"
  const seen = (params.get("seen") as SeenRange | null) ?? "any"
  const category = params.get("category") ?? undefined
  const flag = (params.get("flag") as FlagId | null) ?? undefined
  const topic = settings.topics.find((t) => t.id === params.get("topic"))
  const handle = params.get("handle") ?? undefined
  const minSignal = Number(params.get("signal") ?? 0) / 100
  const hideReplies = params.get("replies") === "hide"
  const showAds = params.get("ads") === "show"
  const showCopies = params.get("copies") === "show"

  const filters: TweetFilters = {
    sort,
    seenSince: seenSinceFor(seen),
    category,
    flag,
    topic: topic?.id,
    topicThreshold: topic?.threshold,
    handle,
    minSignal,
    hideReplies,
    hidePromoted: !showAds,
    hideCopies: !showCopies,
    limit,
  }
  const { data, loading } = useLive(() => query("list", filters), [JSON.stringify(filters)])

  /** Change some URL filters; the list starts from the top again. */
  const set = (patch: Record<string, string | undefined>) => {
    navigate("/feed", { ...Object.fromEntries(params.entries()), ...patch })
    setLimit(PAGE)
    play("tick")
  }

  const chips: { key: string; label: string; clear: Record<string, undefined> }[] = [
    ...(handle ? [{ key: "handle", label: `@${handle}`, clear: { handle: undefined } }] : []),
    ...(topic ? [{ key: "topic", label: `◆ ${topic.label}`, clear: { topic: undefined } }] : []),
    ...(category ? [{ key: "category", label: settings.categories.find((c) => c.id === category)?.label ?? category, clear: { category: undefined } }] : []),
    ...(seen !== "any" ? [{ key: "seen", label: SEEN[seen], clear: { seen: undefined } }] : []),
    ...(flag ? [{ key: "flag", label: FLAGS[flag].label, clear: { flag: undefined } }] : []),
    ...(minSignal > 0 ? [{ key: "signal", label: `Signal ≥ ${Math.round(minSignal * 100)}`, clear: { signal: undefined } }] : []),
    ...(hideReplies ? [{ key: "replies", label: "No replies", clear: { replies: undefined } }] : []),
    ...(showAds ? [{ key: "ads", label: "Ads shown", clear: { ads: undefined } }] : []),
    ...(showCopies ? [{ key: "copies", label: "Copies shown", clear: { copies: undefined } }] : []),
  ]
  const showLastSeen = sort === "lastSeen" || seen !== "any"

  const { data: stats } = useLive(() => query("stats", 30), [])
  const catCount = new Map((stats?.categories ?? []).map((c) => [c.category, c.count]))
  const flagCount = new Map((stats?.flags ?? []).map((f) => [f.flag, f.count]))
  const anyFilter = chips.length > 0

  return (
    <>
      <PageTitle
        title={handle ? `@${handle}` : "Feed"}
        subtitle="Everything you've scrolled past on X, deduplicated and judged."
        actions={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="sm" onClick={async () => downloadJson(`jevx-feed-${Date.now()}.json`, (await query("list", { ...filters, limit: 10_000, offset: 0 })).tweets)} />
              }
            >
              <Download /> Export
            </TooltipTrigger>
            <TooltipContent>Download this view as JSON</TooltipContent>
          </Tooltip>
        }
      />

      {/* Sticks to the top of the page while the list scrolls under it. */}
      <div className="sticky top-0 z-20 -mx-8 mb-4 border-b bg-background/85 px-8 backdrop-blur-md">
        <Tabs value={sort} onValueChange={(v) => set({ sort: String(v) })}>
          {/* The wrapper scrolls, with room below for the active tab's underline (it sits 5px under the tab). */}
          <div className="overflow-x-auto pb-2 pt-2 [scrollbar-width:none]">
          <TabsList variant="line" className="gap-4">
            {(Object.keys(SORTS) as Sort[]).map((s) => {
              const Icon = SORT_ICONS[s]
              return (
                <TabsTrigger key={s} value={s} className="h-8 flex-none px-0.5 text-[13px] data-active:text-foreground">
                  <Icon /> {SORTS[s]}
                </TabsTrigger>
              )
            })}
          </TabsList>
          </div>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2 py-3">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            value={[seen]}
            onValueChange={(v) => {
              const next = (v as string[])[0]
              set({ seen: !next || next === "any" ? undefined : next })
            }}
            aria-label="Seen within"
          >
            {(Object.keys(SEEN_SHORT) as SeenRange[]).map((r) => (
              <ToggleGroupItem key={r} value={r} className="px-2.5 text-[12px] text-muted-foreground data-[pressed]:bg-active data-[pressed]:text-foreground" title={SEEN[r]}>
                {r === "any" ? <Eye /> : null}
                {SEEN_SHORT[r]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          <Separator orientation="vertical" className="mx-1 h-5" />

          {[
            { key: "replies", label: "No replies", tip: "Leave out replies to other tweets", icon: MessageSquareOff, pressed: hideReplies, patch: (on: boolean) => ({ replies: on ? "hide" : undefined }) },
            { key: "ads", label: "No ads", tip: "Leave out promoted tweets", icon: Megaphone, pressed: !showAds, patch: (on: boolean) => ({ ads: on ? undefined : "show" }) },
            { key: "copies", label: "Fold copies", tip: "Show each copied tweet once, under its original", icon: Copy, pressed: !showCopies, patch: (on: boolean) => ({ copies: on ? undefined : "show" }) },
          ].map((t) => (
            <Tooltip key={t.key}>
              <TooltipTrigger
                render={
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={t.pressed}
                    onPressedChange={(on) => set(t.patch(on))}
                    className="text-[12px] text-muted-foreground data-[pressed]:border-foreground/25 data-[pressed]:bg-active data-[pressed]:text-foreground"
                  />
                }
              >
                <t.icon /> {t.label}
              </TooltipTrigger>
              <TooltipContent>{t.tip}</TooltipContent>
            </Tooltip>
          ))}

          <div className="flex h-7 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg border px-2.5 text-[12px]">
            <SignalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">Signal ≥</span>
            <Slider
              className="w-24 shrink-0 data-horizontal:w-24"
              value={[Math.round(minSignal * 100)]}
              max={90}
              step={10}
              onValueChange={(v) => {
                const n = Array.isArray(v) ? v[0] : v
                set({ signal: n > 0 ? String(n) : undefined })
              }}
              aria-label="Minimum signal"
            />
            <span className="w-5 text-right tabular-nums">{Math.round(minSignal * 100)}</span>
          </div>

          <div className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground">
            {loading && <Spinner size={12} />}
            <span className="tabular-nums">{data ? `${data.total.toLocaleString()} tweets` : "…"}</span>
            {anyFilter && (
              <Button variant="ghost" size="xs" onClick={() => set(Object.fromEntries(chips.flatMap((c) => Object.keys(c.clear)).map((k) => [k, undefined])))}>
                <X /> Clear
              </Button>
            )}
          </div>
        </div>

        {/* Scrolls sideways when there are many categories; the fade says there's more. */}
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-3 [mask-image:linear-gradient(to_right,black_92%,transparent)] [scrollbar-width:none]">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={1}
            value={[category ?? "all"]}
            onValueChange={(v) => {
              const next = (v as string[])[0]
              set({ category: !next || next === "all" ? undefined : next })
            }}
            aria-label="Category"
            className="flex-none"
          >
            <ToggleGroupItem value="all" className={CHIP}>All</ToggleGroupItem>
            {settings.categories.map((c) => (
              <ToggleGroupItem key={c.id} value={c.id} className={CHIP}>
                {c.label}
                {catCount.get(c.id) ? <span className="tabular-nums text-muted-foreground">{catCount.get(c.id)}</span> : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Separator orientation="vertical" className="mx-1 h-5 flex-none" />
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={1}
            value={flag ? [flag] : []}
            onValueChange={(v) => set({ flag: (v as string[])[0] })}
            aria-label="Flag"
            className="flex-none"
          >
            {(Object.keys(FLAGS) as FlagId[]).map((f) => (
              <ToggleGroupItem key={f} value={f} className={CHIP}>
                {FLAGS[f].label}
                {flagCount.get(f) ? <span className="tabular-nums text-muted-foreground">{flagCount.get(f)}</span> : null}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      {/* Filters that arrive by link (an author, a watch topic) aren't in the toolbar; show them here. */}
      {(handle || topic) && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {chips
            .filter((c) => c.key === "handle" || c.key === "topic")
            .map((c) => (
              <Badge key={c.key} variant="secondary" className="gap-1 pr-1">
                {c.label}
                <button onClick={() => set(c.clear)} aria-label={`Remove ${c.label}`} className="rounded-full p-0.5 hover:bg-foreground/10">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
        </div>
      )}

      {data && data.total === 0 && !loading ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>No tweets here</EmptyTitle>
            <EmptyDescription>{chips.length > 0 ? "Loosen or clear a filter." : "Scroll x.com for a while; tweets appear as they load."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="fade-bottom">
          {data
            ? data.tweets.map((t) => <TweetRow key={t.id} tweet={t} settings={settings} showLastSeen={showLastSeen} />)
            : Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex gap-3 border-b px-4 py-4 last:border-b-0">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </div>
                </div>
              ))}
        </Card>
      )}
      {data && data.tweets.length < data.total && (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" onClick={() => setLimit((l) => l + PAGE)} disabled={loading}>
            {loading && <Spinner size={12} />} Show more
          </Button>
        </div>
      )}
    </>
  )
}
