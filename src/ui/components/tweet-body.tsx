/** The body of a tweet: formatted text, long-text clamp, media grid and lightbox, quote and link cards. */
import { Dialog } from "@base-ui/react/dialog"
import { ChevronLeft, ChevronRight, Play, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { highlightSegments } from "@/lib/search-core"
import type { LinkCard, Media, QuotedTweet } from "@/lib/types"
import { timeAgo } from "../hooks"
import { play } from "../sounds"
import { cn } from "./ui"

// ── text ──────────────────────────────────────────────────────────────────

const TOKEN = /https?:\/\/[^\s]+|(?<![\w@])@\w{1,15}|(?<![\w&#])#[\p{L}\p{N}_]+|(?<![\w$])\$[A-Za-z]{1,6}\b/gu

function shortUrl(url: string, known: Map<string, string>): string {
  const display = known.get(url)
  if (display) return display
  const bare = url.replace(/^https?:\/\/(www\.)?/, "")
  return bare.length > 32 ? `${bare.slice(0, 30)}…` : bare
}

/** Plain text with links in their short display form, for places that can't hold real links (the ⌘K rows are buttons). */
export function displayText(text: string, urls: { url: string; display: string }[] = []): string {
  const known = new Map(urls.map((u) => [u.url, u.display]))
  return text.replace(/https?:\/\/[^\s]+/g, (u) => {
    const clean = u.replace(/[.,!?)\]}'"]+$/, "")
    return shortUrl(clean, known) + u.slice(clean.length)
  })
}

function Marked({ text, terms }: { text: string; terms?: string[] }) {
  if (!terms?.length) return <>{text}</>
  return <>{highlightSegments(text, terms).map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : s.text))}</>
}

/**
 * Tweet text with X's formatting: links shortened to their display form,
 * @mentions, #hashtags and $cashtags linked, and the trailing link dropped
 * when a card or quote already shows it.
 */
export function TweetText({
  text,
  urls = [],
  terms,
  hideUrls = [],
}: {
  text: string
  urls?: { url: string; display: string }[]
  terms?: string[]
  /** Links X would not print because a card or quote shows them. */
  hideUrls?: ((url: string) => boolean)[]
}) {
  const known = new Map(urls.map((u) => [u.url, u.display]))
  let body = text
  // Drop a trailing link that a card or quote already represents.
  const trailing = body.match(/\s*(https?:\/\/\S+)\s*$/)
  if (trailing && hideUrls.some((f) => f(trailing[1]))) body = body.slice(0, trailing.index)

  const out: ReactNode[] = []
  let last = 0
  let key = 0
  for (const m of body.matchAll(TOKEN)) {
    let token = m[0]
    const start = m.index ?? 0
    if (token.startsWith("http")) token = token.replace(/[.,!?)\]}'"]+$/, "")
    if (start > last) out.push(<Marked key={key++} text={body.slice(last, start)} terms={terms} />)
    const cls = "text-sky-600 dark:text-sky-400 hover:underline"
    if (token.startsWith("http")) {
      out.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer" className={cls} title={token}>
          <Marked text={shortUrl(token, known)} terms={terms} />
        </a>,
      )
    } else if (token.startsWith("@")) {
      out.push(<a key={key++} href={`https://x.com/${token.slice(1)}`} target="_blank" rel="noreferrer" className={cls}><Marked text={token} terms={terms} /></a>)
    } else if (token.startsWith("#")) {
      out.push(<a key={key++} href={`https://x.com/hashtag/${encodeURIComponent(token.slice(1))}`} target="_blank" rel="noreferrer" className={cls}><Marked text={token} terms={terms} /></a>)
    } else {
      out.push(<a key={key++} href={`https://x.com/search?q=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer" className={cls}><Marked text={token} terms={terms} /></a>)
    }
    last = start + token.length
  }
  if (last < body.length) out.push(<Marked key={key++} text={body.slice(last)} terms={terms} />)
  return <>{out}</>
}

// ── clamp ─────────────────────────────────────────────────────────────────

/**
 * Clamps long text to `lines` with a fade and Show more. Text only a little
 * over the limit is left alone. With `autoExpand`, opens itself when a search
 * highlight would otherwise be hidden.
 */
export function Clamp({ children, lines = 7, autoExpand, className }: { children: ReactNode; lines?: number; autoExpand?: boolean; className?: string }) {
  const outer = useRef<HTMLDivElement>(null)
  // The inner box is never height-limited, so its size is always the full text's.
  const inner = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ max: number; full: number }>()
  const [open, setOpen] = useState(false)
  /** Once the reader uses Show more / Show less, auto-expansion stays out of it. */
  const touched = useRef(false)

  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22
      const max = lineHeight * lines
      const full = el.getBoundingClientRect().height
      setBox((b) => (b && b.max === max && b.full === full ? b : { max, full }))
      if (autoExpand && !touched.current && full > max * 1.3) {
        const top = el.getBoundingClientRect().top
        const marks = [...el.querySelectorAll("mark")].map((m) => m.getBoundingClientRect().bottom - top)
        if (marks.length > 0 && marks.every((bottom) => bottom > max)) setOpen(true)
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [lines, autoExpand])

  const clamps = box != null && box.full > box.max * 1.3
  const collapsed = clamps && !open
  return (
    <div className={className}>
      <div
        ref={outer}
        className="overflow-hidden transition-[max-height] duration-300 ease-out"
        style={{
          maxHeight: box == null ? undefined : collapsed ? box.max : box.full + 4,
          maskImage: collapsed ? "linear-gradient(to bottom, black 70%, transparent)" : undefined,
        }}
      >
        <div ref={inner}>{children}</div>
      </div>
      {clamps && (
        <button
          onClick={() => {
            touched.current = true
            setOpen((o) => !o)
          }}
          className="mt-1 text-[13px] font-medium text-sky-600 dark:text-sky-400 hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

// ── media ─────────────────────────────────────────────────────────────────

/** pbs.twimg.com serves several sizes of the same image. */
export function sized(url: string, name: "small" | "medium" | "large" | "orig"): string {
  if (!url.includes("pbs.twimg.com") || url.includes("name=")) return url
  const m = url.match(/^(.*)\.(jpg|jpeg|png|webp)$/)
  return m ? `${m[1]}?format=${m[2] === "jpeg" ? "jpg" : m[2]}&name=${name}` : `${url}${url.includes("?") ? "&" : "?"}name=${name}`
}

function duration(ms?: number) {
  if (!ms) return undefined
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function Tile({ media: m, onOpen, cover, className }: { media: Media; onOpen: () => void; cover: boolean; className?: string }) {
  const [playing, setPlaying] = useState(false)
  const fit = cover ? "h-full w-full object-cover" : "h-full w-full object-contain"
  const isGif = m.type === "animated_gif"
  const isVideo = m.type === "video"
  return (
    <div className={cn("group/tile relative overflow-hidden bg-muted", className)} data-no-open>
      {isGif && m.video ? (
        <video src={m.video} poster={sized(m.url, "small")} autoPlay loop muted playsInline className={fit} />
      ) : isVideo && playing && m.video ? (
        <video src={m.video} poster={sized(m.url, "medium")} autoPlay controls playsInline className="h-full w-full bg-black object-contain" />
      ) : (
        <button onClick={isVideo && m.video ? () => setPlaying(true) : onOpen} className="block h-full w-full cursor-zoom-in" aria-label={m.alt ?? (isVideo ? "Play video" : "Open image")}>
          <img src={sized(m.url, "medium")} alt={m.alt ?? ""} loading="lazy" className={cn(fit, "transition-transform duration-300 group-hover/tile:scale-[1.015]")} />
        </button>
      )}
      {isVideo && !playing && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 backdrop-blur">
            <Play className="size-5 translate-x-px fill-current" />
          </span>
        </span>
      )}
      <span className="pointer-events-none absolute bottom-2 left-2 flex gap-1">
        {isGif && <span className="rounded bg-black/70 px-1.5 text-[11px] font-bold leading-5 text-white">GIF</span>}
        {isVideo && !playing && duration(m.durationMs) && <span className="rounded bg-black/70 px-1.5 text-[11px] leading-5 text-white tabular-nums">{duration(m.durationMs)}</span>}
        {m.alt && (
          <span className="pointer-events-auto rounded bg-black/70 px-1.5 text-[11px] font-bold leading-5 text-white" title={m.alt}>
            ALT
          </span>
        )}
      </span>
    </div>
  )
}

/** X's layouts: one at its own aspect ratio, two side by side, three as one big and two stacked, four in a grid. */
export function MediaGrid({ media, compact }: { media: Media[]; compact?: boolean }) {
  const [open, setOpenRaw] = useState<number | null>(null)
  const setOpen = (i: number | null) => {
    if (i != null && open == null) play("open")
    if (i == null && open != null) play("close")
    setOpenRaw(i)
  }
  const items = media.slice(0, 4)
  if (items.length === 0) return null
  const frame = cn("overflow-hidden rounded-2xl border", compact ? "max-w-[420px]" : "max-w-[560px]")

  let grid: ReactNode
  if (items.length === 1) {
    const m = items[0]
    const ratio = m.width && m.height ? m.width / m.height : 16 / 9
    grid = (
      <div className={frame} style={{ aspectRatio: String(Math.max(ratio, 0.75)), maxHeight: compact ? 360 : 520 }}>
        <Tile media={m} onOpen={() => setOpen(0)} cover className="h-full" />
      </div>
    )
  } else {
    grid = (
      <div
        className={cn(frame, "grid grid-cols-2 gap-0.5 bg-border", items.length > 2 && "grid-rows-2")}
        style={{ height: compact ? 220 : items.length === 2 ? 290 : 320 }}
      >
        {items.map((m, i) => (
          <Tile key={i} media={m} onOpen={() => setOpen(i)} cover className={cn("h-full", items.length === 3 && i === 0 && "row-span-2")} />
        ))}
      </div>
    )
  }
  return (
    <>
      {grid}
      <Lightbox media={items} index={open} onIndex={setOpen} />
    </>
  )
}

function Lightbox({ media, index, onIndex }: { media: Media[]; index: number | null; onIndex: (i: number | null) => void }) {
  const m = index == null ? undefined : media[index]
  const step = (d: number) => index != null && onIndex((index + d + media.length) % media.length)
  useEffect(() => {
    if (index == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(1)
      if (e.key === "ArrowLeft") step(-1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  return (
    <Dialog.Root open={index != null} onOpenChange={(o) => !o && onIndex(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/90" />
        <Dialog.Popup className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 outline-none" onClick={() => onIndex(null)}>
          <Dialog.Title className="sr-only">Media</Dialog.Title>
          {m && (
            <div className="flex max-h-full max-w-full flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
              {m.video && m.type !== "photo" ? (
                <video src={m.video} poster={sized(m.url, "large")} autoPlay controls loop={m.type === "animated_gif"} className="max-h-[85vh] max-w-[92vw] rounded-lg" />
              ) : (
                <img src={sized(m.url, "large")} alt={m.alt ?? ""} className="max-h-[85vh] max-w-[92vw] rounded-lg object-contain" />
              )}
              {m.alt && <p className="max-w-2xl text-center text-[13px] text-white/75">{m.alt}</p>}
            </div>
          )}
          <button onClick={() => onIndex(null)} aria-label="Close" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20">
            <X className="size-5" />
          </button>
          {media.length > 1 && (
            <>
              <button onClick={(e) => { e.stopPropagation(); step(-1) }} aria-label="Previous" className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20">
                <ChevronLeft className="size-5" />
              </button>
              <button onClick={(e) => { e.stopPropagation(); step(1) }} aria-label="Next" className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20">
                <ChevronRight className="size-5" />
              </button>
              <span className="absolute bottom-4 text-[12px] tabular-nums text-white/60">
                {(index ?? 0) + 1} / {media.length}
              </span>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// ── cards ─────────────────────────────────────────────────────────────────

export function QuoteCard({ quoted: q, terms }: { quoted: QuotedTweet; terms?: string[] }) {
  const url = `https://x.com/${q.handle}/status/${q.id}`
  const thumb = q.media[0]
  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Links inside the quoted text keep working; anywhere else opens the quoted tweet.
    if ((e.target as HTMLElement).closest("a")) return
    e.stopPropagation()
    window.open(url, "_blank")
  }
  // A div, not an <a>: the quoted text has its own links, and links can't nest.
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Quoted tweet by @${q.handle}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open(e)}
      className="block max-w-[560px] cursor-pointer overflow-hidden rounded-2xl border transition-colors hover:bg-hover"
      data-no-open
    >
      <div className="flex gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px]">
            {q.avatar ? <img src={q.avatar} alt="" className="size-5 rounded-full" /> : <span className="size-5 rounded-full bg-muted" />}
            <span className="truncate font-medium">{q.name || q.handle}</span>
            <span className="truncate text-muted-foreground">@{q.handle}</span>
            <span className="text-muted-foreground">·</span>
            <span className="shrink-0 text-muted-foreground">{timeAgo(q.createdAt)}</span>
          </div>
          <p className="mt-1 line-clamp-5 whitespace-pre-wrap break-words text-[14px] leading-[1.45] text-foreground/85">
            <TweetText text={q.text} terms={terms} />
          </p>
        </div>
        {thumb && (
          <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-muted">
            <img src={sized(thumb.url, "small")} alt={thumb.alt ?? ""} className="h-full w-full object-cover" loading="lazy" />
            {thumb.type !== "photo" && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Play className="size-5 fill-white text-white drop-shadow" />
              </span>
            )}
            {q.media.length > 1 && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white">+{q.media.length - 1}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

export function LinkCardView({ card }: { card: LinkCard }) {
  const domain = card.domain ?? new URL(card.url).hostname.replace(/^www\./, "")
  if (card.large && card.image) {
    const ratio = card.imageWidth && card.imageHeight ? card.imageWidth / card.imageHeight : 1.91
    return (
      <a href={card.url} target="_blank" rel="noreferrer" className="group/card block max-w-[560px] overflow-hidden rounded-2xl border" data-no-open>
        <div className="relative overflow-hidden bg-muted" style={{ aspectRatio: String(Math.max(ratio, 1.4)) }}>
          <img src={card.image} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-300 group-hover/card:scale-[1.015]" />
          <span className="absolute bottom-2 left-2 max-w-[80%] truncate rounded bg-black/70 px-1.5 text-[12px] leading-5 text-white">{card.title}</span>
        </div>
        <div className="px-3 py-2 text-[12px] text-muted-foreground">From {domain}</div>
      </a>
    )
  }
  return (
    <a href={card.url} target="_blank" rel="noreferrer" className="flex max-w-[560px] overflow-hidden rounded-2xl border transition-colors hover:bg-hover" data-no-open>
      {card.image && (
        <div className="w-28 shrink-0 border-r bg-muted">
          <img src={card.image} alt="" loading="lazy" className="h-full w-full object-cover" />
        </div>
      )}
      <div className="min-w-0 px-3 py-2.5">
        <div className="truncate text-[12px] text-muted-foreground">{domain}</div>
        <div className="truncate text-[14px]">{card.title}</div>
        {card.description && <div className="line-clamp-2 text-[13px] text-muted-foreground">{card.description}</div>}
      </div>
    </a>
  )
}
