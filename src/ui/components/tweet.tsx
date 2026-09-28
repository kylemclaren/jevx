import { BotAvatar } from "bot-avatars"
import { useState } from "react"
import { BadgeCheck, Copy, ExternalLink, Eye, Heart, Link2, Megaphone, MoreHorizontal, Repeat2, Search, Text, Timer, User } from "lucide-react"
import type { ReactNode } from "react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { queryTerms } from "@/lib/search-core"
import { SIGNAL_LEVELS, TONE_LEVELS } from "@/lib/typesafe"
import { play } from "../sounds"
import { CLICK_LABEL, CLICK_WEIGHT, type ClickKind } from "@/lib/engagement"
import { FLAGS, type FlagId, type Settings } from "@/lib/settings"
import { highlightSegments } from "@/lib/search-core"
import type { StoredTweet } from "@/lib/types"
import { compact, duration, navigate, timeAgo } from "../hooks"
import { useResolvedTheme } from "../theme"
import { Clamp, LinkCardView, MediaGrid, QuoteCard, TweetText } from "./tweet-body"
import { Badge, cn } from "./ui"

const FLAG_TONE: Record<FlagId, string> = {
  bait: "border-red-500/40 text-red-600 dark:text-red-400",
  promo: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  launch: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  question: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  humor: "border-fuchsia-500/40 text-fuchsia-600 dark:text-fuchsia-400",
  thread: "border-blue-500/40 text-blue-600 dark:text-blue-400",
}

export function SignalBars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-end gap-[2px]", className)} title={`Signal ${Math.round(value * 100)}/100`}>
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={cn("w-[3px] rounded-[1px]", value >= (i + 0.5) / 4 ? "bg-foreground" : "bg-active")} style={{ height: 4 + i * 2.5 }} />
      ))}
    </span>
  )
}

export function ToneDot({ value }: { value: number }) {
  // Hostile red → neutral grey → enthusiastic green, through the ends only.
  const color = value < 0.4 ? "bg-red-400" : value > 0.65 ? "bg-emerald-400" : "bg-muted-foreground/50"
  const label = value < 0.2 ? "Hostile" : value < 0.4 ? "Negative" : value <= 0.65 ? "Neutral" : value < 0.85 ? "Positive" : "Enthusiastic"
  return <span className={cn("inline-block size-1.5 rounded-full", color)} title={`Tone: ${label}`} />
}

const BOTS = ["clover", "flower", "triangle", "square", "blob", "ghost", "circle", "drop", "star", "droid", "mech", "alien", "hexagon", "cat", "cloud", "pill", "pebble", "puddle"] as const

function botFor(handle: string) {
  let h = 0
  for (const ch of handle.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return BOTS[h % BOTS.length]
}

/** Profile photo, or a bot avatar picked from the handle when there is none or it fails to load. */
export function Avatar({ src, handle, size = 36 }: { src?: string; handle: string; size?: number }) {
  const [failed, setFailed] = useState(false)
  const theme = useResolvedTheme()
  if (src && !failed) {
    return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} className="shrink-0 rounded-full bg-muted object-cover" style={{ width: size, height: size }} loading="lazy" />
  }
  return (
    <span className="shrink-0" style={{ width: size, height: size }}>
      <BotAvatar type={botFor(handle)} size={size} interactive={false} theme={theme} aria-label={`@${handle}`} />
    </span>
  )
}

export function Highlighted({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length) return <>{text}</>
  return (
    <>
      {highlightSegments(text, terms).map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  )
}

/** A shadcn tooltip around an inline element. */
function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" data-no-open />}>{children}</TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5 text-left">{content}</TooltipContent>
    </Tooltip>
  )
}

/** Your reading time and the strongest thing you did with the tweet. */
function AttentionBadge({ tweet: t }: { tweet: StoredTweet }) {
  const kinds = (Object.keys(t.clicks) as ClickKind[]).filter((k) => (t.clicks[k] ?? 0) > 0).sort((a, b) => CLICK_WEIGHT[b] - CLICK_WEIGHT[a])
  const parts = [t.dwellMs >= 1000 ? `read ${duration(t.dwellMs)}` : "glanced", ...kinds.slice(0, 1).map((k) => CLICK_LABEL[k])]
  const strong = (t.interest ?? 0) >= 0.5
  return (
    <Tip
      content={
        <>
          <span className="font-medium">Your interest {Math.round((t.interest ?? 0) * 100)}/100</span>
          <span>{duration(t.dwellMs)} at your reading position</span>
          <span>{kinds.length ? `You ${kinds.map((k) => CLICK_LABEL[k]).join(", ")}` : "No clicks"}</span>
          {t.authorAffinity != null && <span className="opacity-70">Affinity with @{t.handle}: {Math.round(t.authorAffinity * 100)}</span>}
        </>
      }
    >
      <Badge tone={strong ? "border-foreground/40 text-foreground" : undefined}>
        <Timer className="size-3" /> {parts.join(" · ")}
      </Badge>
    </Tip>
  )
}

function levelLabel(levels: string[], v: number) {
  return levels[Math.round(v * (levels.length - 1))].split(":")[0]
}

/** Open, copy, jump to the author, or search for tweets like this one. */
function RowMenu({ tweet: t, url }: { tweet: StoredTweet; url: string }) {
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
    play("tick")
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-no-open
        aria-label="Tweet actions"
        className="flex size-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-active hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52" data-no-open>
        <DropdownMenuItem onClick={() => window.open(url, "_blank")}>
          <ExternalLink /> Open on X
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => copy(url)}>
          <Link2 /> Copy link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => copy(t.text)}>
          <Text /> Copy text
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/feed", { handle: t.handle })}>
          <User /> More from @{t.handle}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/search", { q: queryTerms(t.text).slice(0, 10).join(" ") })}>
          <Search /> Find similar
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TweetRow({
  tweet: t,
  settings,
  terms,
  relevance,
  note,
  dimmed,
  showLastSeen,
}: {
  tweet: StoredTweet
  settings: Settings
  terms?: string[]
  relevance?: number
  note?: string
  dimmed?: boolean
  /** Show when the tweet was last loaded on x.com, for lists ordered that way. */
  showLastSeen?: boolean
}) {
  const e = t.enrichment
  const category = e ? settings.categories.find((c) => c.id === e.category) : undefined
  const url = `https://x.com/${t.handle}/status/${t.id}`
  const hideUrls = [
    (u: string) => u === t.card?.url,
    (u: string) => Boolean(t.quoted && new RegExp(`/status/${t.quoted.id}(\\b|/|$)`).test(u)),
  ]
  // Click anywhere that isn't a link, button or media opens the tweet, as on X.
  const openTweet = (ev: React.MouseEvent) => {
    // React bubbles clicks from portals (image viewer, menus, tooltips) up to here; those aren't row clicks.
    if (!ev.currentTarget.contains(ev.target as Node)) return
    if ((ev.target as HTMLElement).closest("a, button, video, input, [data-no-open]")) return
    if (window.getSelection()?.toString()) return
    window.open(url, "_blank")
  }
  return (
    <article
      onClick={openTweet}
      className={cn("group relative flex cursor-pointer gap-3 border-b px-4 py-4 transition-colors last:border-b-0 hover:bg-hover", dimmed && "opacity-45 hover:opacity-100")}
    >
      <Avatar src={t.avatar} handle={t.handle} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px]">
          <button onClick={() => navigate("/feed", { handle: t.handle })} className="truncate font-medium hover:underline">
            {t.name || t.handle}
          </button>
          {t.verified && <BadgeCheck className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="truncate text-muted-foreground">@{t.handle}</span>
          <span className="text-muted-foreground">·</span>
          <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-muted-foreground hover:underline" title={new Date(t.createdAt).toLocaleString()}>
            {timeAgo(t.createdAt)}
          </a>
          <span className="ml-auto flex shrink-0 items-center gap-2">
          {relevance != null && (
            <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground" title="Jev relevance">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-active">
                <span className="block h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${Math.round(relevance * 100)}%` }} />
              </span>
              {Math.round(relevance * 100)}
            </span>
          )}
          <RowMenu tweet={t} url={url} />
          </span>
        </div>
        {t.replyTo && (
          <div className="mt-0.5 text-[13px] text-muted-foreground">
            Replying to{" "}
            <a href={`https://x.com/${t.replyTo}`} target="_blank" rel="noreferrer" className="text-sky-600 dark:text-sky-400 hover:underline">
              @{t.replyTo}
            </a>
          </div>
        )}
        {t.text && (
          <Clamp autoExpand={Boolean(terms?.length)} className="mt-1">
            <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-foreground/90">
              <TweetText text={t.text} urls={t.urls} terms={terms} hideUrls={hideUrls} />
            </p>
          </Clamp>
        )}
        {t.media.length > 0 && (
          <div className="mt-3">
            <MediaGrid media={t.media} />
            {t.vision && (
              <Tip
                content={
                  <>
                    <span className="font-medium capitalize">{t.vision.kind}{t.vision.addsInformation ? " · adds to the tweet" : ""}</span>
                    {t.vision.text ? <span className="line-clamp-6 whitespace-pre-wrap">“{t.vision.text}”</span> : <span>No text in the image</span>}
                    <span className="opacity-70">described by ChatGPT{t.vision.model ? ` (${t.vision.model})` : ""}</span>
                  </>
                }
              >
                <p className="mt-1.5 max-w-[560px] text-[12px] leading-[1.45] text-muted-foreground">
                  <Eye className="mr-1 inline size-3 align-[-2px]" />
                  <Highlighted text={t.vision.description} terms={terms} />
                </p>
              </Tip>
            )}
          </div>
        )}
        {t.card && t.media.length === 0 && (
          <div className="mt-3">
            <LinkCardView card={t.card} />
          </div>
        )}
        {t.quoted && (
          <div className="mt-3">
            <QuoteCard quoted={t.quoted} terms={terms} />
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {category ? (
            <Badge className="border-border-strong text-foreground/80">
              {category.label}
            </Badge>
          ) : e ? null : (
            <Badge className="border-dashed">
              <span className="shimmer">judging…</span>
            </Badge>
          )}
          {e && (
            <Tip
              content={
                <>
                  <span className="font-medium">Signal {Math.round(e.signal * 100)}/100 · {levelLabel(SIGNAL_LEVELS, e.signal)}</span>
                  <span>Tone: {levelLabel(TONE_LEVELS, e.tone)}</span>
                  <span className="opacity-70">
                    {category?.label ?? e.category}, {Math.round(e.categoryConfidence * 100)}% confident · judged by Jev
                  </span>
                </>
              }
            >
              <Badge className="gap-1.5 tabular-nums">
                <SignalBars value={e.signal} className="h-2.5" />
                {Math.round(e.signal * 100)}
                <ToneDot value={e.tone} />
              </Badge>
            </Tip>
          )}
          {e &&
            (Object.keys(FLAGS) as FlagId[])
              .filter((f) => (e.flags[f] ?? 0) >= 0.6)
              .map((f) => (
                <Badge key={f} tone={FLAG_TONE[f]}>
                  {FLAGS[f].label}
                </Badge>
              ))}
          {e &&
            settings.topics
              .filter((tp) => (e.topics[tp.id] ?? 0) >= tp.threshold)
              .map((tp) => (
                <Badge key={tp.id} tone="border-violet-400/50 text-violet-600 dark:text-violet-300">
                  ◆ {tp.label}
                </Badge>
              ))}
          {t.promoted && (
            <Badge>
              <Megaphone className="size-3" /> Ad
            </Badge>
          )}
          {t.copies > 0 && (
            <Badge title="Other accounts posted the same text">
              <Copy className="size-3" /> {t.copies + 1} copies
            </Badge>
          )}
          {t.viaHandles.length > 0 && (
            <Badge title={t.viaHandles.map((h) => `@${h}`).join(", ")}>
              <Repeat2 className="size-3" /> via @{t.viaHandles[0]}
              {t.viaHandles.length > 1 && ` +${t.viaHandles.length - 1}`}
            </Badge>
          )}
          {t.interest != null && <AttentionBadge tweet={t} />}
          {note && <Badge className="border-dashed">{note}</Badge>}
          <span className="ml-auto flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
            <span className="flex items-center gap-1" title="Likes">
              <Heart className="size-3" /> {compact(t.likes)}
            </span>
            {t.views != null && (
              <span className="flex items-center gap-1" title="Views">
                <Eye className="size-3" /> {compact(t.views)}
              </span>
            )}
            <span title={`You loaded this ${t.seenCount} time${t.seenCount === 1 ? "" : "s"}; first ${new Date(t.firstSeen).toLocaleString()}, last ${new Date(t.lastSeen).toLocaleString()}`}>
              seen {t.seenCount}×{showLastSeen && <span className="text-foreground/80"> · {timeAgo(t.lastSeen)} ago</span>}
            </span>
          </span>
        </div>
      </div>
    </article>
  )
}
