import { Dialog } from "@base-ui/react/dialog"
import { Bell, CornerDownLeft, Play, House, KeyRound, List, Monitor, Moon, Sun, Search as SearchIcon, Settings as SettingsIcon, Users } from "lucide-react"
import {
  Sidebar as ShadSidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BotAvatar } from "bot-avatars"
import { BorderBeam } from "border-beam"
import { Comet } from "loading-dev"
import { MetalFx } from "metal-fx"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { send } from "@/lib/rpc"
import { PRICE_PER_TOKEN } from "@/lib/typesafe"
import { Avatar, Highlighted } from "./components/tweet"
import { displayText, sized } from "./components/tweet-body"
import type { Media } from "@/lib/types"
import { Button, buttonClass, cn, Kbd, Segmented } from "./components/ui"
import { play, setSoundPrefs } from "./sounds"
import { bytes, compact, navigate, useLive, useRoute, useSettings, useStatus, usd } from "./hooks"
import { query } from "@/lib/rpc"
import { useTweetSearch } from "./search"
import { applyTheme, useResolvedTheme, type Theme } from "./theme"
import { Alerts } from "./pages/Alerts"
import { Authors } from "./pages/Authors"
import { Feed } from "./pages/Feed"
import { Overview } from "./pages/Overview"
import { SearchPage } from "./pages/Search"
import { SettingsPage } from "./pages/Settings"

const NAV = [
  { group: "Index", items: [
    { path: "/", label: "Home", icon: House },
    { path: "/feed", label: "Feed", icon: List },
    { path: "/search", label: "Search", icon: SearchIcon },
  ] },
  { group: "Explore", items: [
    { path: "/authors", label: "Authors", icon: Users },
    { path: "/alerts", label: "Watch topics", icon: Bell },
  ] },
  { group: "Configure", items: [{ path: "/settings", label: "Settings", icon: SettingsIcon }] },
]

const TITLES: Record<string, string> = { "/": "Home", "/feed": "Feed", "/search": "Search", "/authors": "Authors", "/alerts": "Watch topics", "/settings": "Settings" }

export function App() {
  const { path } = useRoute()
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("jevx-sidebar") !== "closed"
    } catch {
      return true
    }
  })
  const setSidebar = (open: boolean) => {
    setSidebarOpen(open)
    play("tick")
    try {
      localStorage.setItem("jevx-sidebar", open ? "open" : "closed")
    } catch {
      // Per-browser convenience only.
    }
  }
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settings, saveSettings, settingsLoaded] = useSettings()
  // Until stored settings arrive, keep the theme main.tsx applied from its cache.
  useEffect(() => {
    if (settingsLoaded) applyTheme(settings.theme)
  }, [settings.theme, settingsLoaded])
  useEffect(() => {
    if (settingsLoaded) setSoundPrefs(settings.sounds, settings.soundVolume)
  }, [settings.sounds, settings.soundVolume, settingsLoaded])
  const paletteOpenRef = useRef(false)
  paletteOpenRef.current = paletteOpen

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        // Sound outside the state updater: StrictMode runs updaters twice.
        play(paletteOpenRef.current ? "close" : "open")
        setPaletteOpen(!paletteOpenRef.current)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  let page: ReactNode
  switch (path) {
    case "/feed": page = <Feed />; break
    case "/search": page = <SearchPage />; break
    case "/authors": page = <Authors />; break
    case "/alerts": page = <Alerts />; break
    case "/settings": page = <SettingsPage />; break
    default: page = <Overview />
  }

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebar} style={{ "--sidebar-width": "16rem", "--sidebar-width-icon": "3.5rem" } as React.CSSProperties} className="h-full min-h-0">
      <Sidebar path={path} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <span>jevx</span>
            <span>/</span>
            <span className="text-foreground">{TITLES[path] ?? "Home"}</span>
          </div>
          <button
            onClick={() => {
              play("open")
              setPaletteOpen(true)
            }}
            className="mx-auto flex h-8 w-full max-w-sm items-center gap-2 rounded-lg border border-border-strong px-3 text-[13px] text-muted-foreground transition-colors hover:bg-hover"
          >
            <SearchIcon className="size-3.5" />
            Search everything you've scrolled past…
            <span className="ml-auto flex gap-0.5"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          </button>
          <ThemeToggle value={settings.theme} onChange={(theme) => void saveSettings({ theme })} />
          <a href="https://docs.typesafe.ai" target="_blank" rel="noreferrer" className={buttonClass("outline", "sm")}>
            Jev docs
          </a>
          <a href="https://x.com/home" target="_blank" rel="noreferrer" className={buttonClass("primary", "sm")}>
            Open X
          </a>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1150px] px-8 pb-24 pt-10">{page}</div>
        </main>
      </SidebarInset>
      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  )
}

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Match system", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

function ThemeToggle({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <Segmented<Theme>
      label="Theme"
      value={value}
      onChange={onChange}
      options={THEMES.map(({ value: v, label, icon: Icon }) => ({ value: v, title: label, label: <Icon /> }))}
      className="[&_button]:px-2"
    />
  )
}

function Sidebar({ path }: { path: string }) {
  const { status } = useStatus()
  const { state } = useSidebar()
  const collapsed = state === "collapsed"
  const [settings] = useSettings()
  const { data: stats } = useLive(() => query("stats", 1), [])
  // Chime when a watch topic matches a newly judged tweet.
  const alerts = useRef<number | undefined>(undefined)
  useEffect(() => {
    const n = status?.unseenAlerts
    if (n != null && alerts.current != null && n > alerts.current) play("alert")
    alerts.current = n
  }, [status?.unseenAlerts])
  const categories = (stats?.categories ?? []).slice(0, 6)
  const maxCat = Math.max(1, ...categories.map((c) => c.count))

  return (
    <ShadSidebar collapsible="icon" className="border-r bg-panel">
      <SidebarHeader className="h-12 flex-row items-center gap-2 px-3.5">
        <a href="#/" className="flex items-center gap-2" aria-label="jevx home">
          <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-foreground">
            <span className="size-1.5 rounded-full bg-foreground" />
          </span>
          {!collapsed && <span className="text-[15px] font-semibold tracking-tight">jevx</span>}
        </a>
      </SidebarHeader>

      <SidebarContent className="gap-4 px-1.5 pt-2">
        {NAV.map((g) => (
          <SidebarGroup key={g.group} className="p-0">
            <SidebarGroupLabel className="h-6 px-2 text-[11px] text-muted-foreground">{g.group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((item) => {
                  const active = path === item.path
                  const Icon = item.icon
                  const badge = item.path === "/alerts" ? (status?.unseenAlerts ?? 0) : 0
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        isActive={active}
                        tooltip={item.label}
                        onClick={() => !active && play("tick")}
                        render={<a href={`#${item.path}`} />}
                        className="h-8 gap-2.5 rounded-lg px-2 text-[13px] text-muted-foreground hover:bg-hover hover:text-foreground data-[active=true]:bg-active data-[active=true]:font-normal data-[active=true]:text-foreground"
                      >
                        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                      {badge > 0 && (
                        <SidebarMenuBadge className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground group-data-[collapsible=icon]:right-0.5 group-data-[collapsible=icon]:top-0.5 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:h-3.5 group-data-[collapsible=icon]:min-w-3.5 group-data-[collapsible=icon]:px-1">
                          {badge}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {categories.length > 0 && (
          <SidebarGroup className="p-0 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel className="h-6 px-2 text-[11px] text-muted-foreground">Categories</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {categories.map((c) => {
                  const label = settings.categories.find((x) => x.id === c.category)?.label ?? c.category
                  return (
                    <SidebarMenuItem key={c.category}>
                      <SidebarMenuButton
                        onClick={() => {
                          play("tick")
                          navigate("/feed", { category: c.category })
                        }}
                        className="h-7 gap-2 rounded-lg px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
                      >
                        <span className="w-16 shrink-0 truncate">{label}</span>
                        <span className="h-1 flex-1 overflow-hidden rounded-full bg-active">
                          <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${(c.count / maxCat) * 100}%` }} />
                        </span>
                        <span className="w-7 text-right tabular-nums">{compact(c.count)}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="p-0">
        <QueueCard collapsed={collapsed} />
      </SidebarFooter>
      <SidebarRail />
    </ShadSidebar>
  )
}

function QueueCard({ collapsed }: { collapsed: boolean }) {
  const { status } = useStatus()
  const { data: stats } = useLive(() => query("stats", 1), [])
  const { data: storage } = useLive(() => query("storage"), [])
  const theme = useResolvedTheme()
  if (!status) return null
  const busy = status.inFlight > 0
  // Jev, as a little bot: hopping while it judges, asleep when there is nothing left.
  const botState = busy ? "working" : status.pending > 0 ? "default" : "sleeping"
  const headline = busy ? `Jev is judging ${status.inFlight}` : status.pending > 0 ? `${status.pending} waiting` : "All caught up"
  if (!status.apiKeySet) {
    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger render={<button onClick={() => navigate("/settings")} aria-label="Add your TypeSafe key" className="mx-auto mb-3 flex size-9 items-center justify-center rounded-full border border-border-strong text-muted-foreground hover:bg-hover hover:text-foreground" />}>
            <KeyRound className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="right">Add your TypeSafe key</TooltipContent>
        </Tooltip>
      )
    }
    return (
      <div className="m-3 flex justify-center">
        <MetalFx preset="silver" theme={theme}>
          <button onClick={() => navigate("/settings")} className="flex h-10 items-center gap-2 rounded-full bg-card px-5 text-[13px] font-medium">
            <KeyRound className="size-4" /> Add your TypeSafe key
          </button>
        </MetalFx>
      </div>
    )
  }
  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={<button onClick={() => navigate("/")} aria-label={headline} className="mx-auto mb-3 flex size-9 items-center justify-center" />}>
          <BotAvatar type="clover" state={botState} size={30} theme={theme} aria-label={`Jev, ${botState}`} />
        </TooltipTrigger>
        <TooltipContent side="right" className="flex-col items-start">
          <span>{headline}</span>
          {status.chatgpt.signedIn && status.chatgpt.pendingImages > 0 && <span className="opacity-70">{status.chatgpt.pendingImages} images waiting for ChatGPT</span>}
        </TooltipContent>
      </Tooltip>
    )
  }
  return (
    <div className="m-3 rounded-xl border bg-card p-3 text-[12px]">
      <div className="flex items-center gap-2.5">
        <BotAvatar type="clover" state={botState} size={30} theme={theme} aria-label={`Jev, ${botState}`} />
        <span className={cn("font-medium", busy && "shimmer")}>{headline}</span>
      </div>
      {status.lastError && <p className="mt-1.5 line-clamp-2 text-red-600 dark:text-red-400" title={status.lastError}>{status.lastError}</p>}
      {stats && (
        <p className="mt-1.5 text-muted-foreground">
          {compact(stats.enriched)} judged · {compact(stats.inputTokens)} tokens · {usd(stats.inputTokens * PRICE_PER_TOKEN)}
        </p>
      )}
      {storage && (
        <button onClick={() => navigate("/settings")} className="mt-1 text-left text-muted-foreground hover:text-foreground" title="Storage details in Settings">
          {bytes(storage.bytes)} on disk · {compact(storage.tweets)} tweets
        </button>
      )}
      {status.chatgpt.signedIn && (status.chatgpt.pendingImages > 0 || status.chatgpt.inFlight > 0) && (
        <p className="mt-1 text-muted-foreground">
          {status.chatgpt.inFlight > 0 ? <span className="shimmer">ChatGPT reading {status.chatgpt.inFlight} image{status.chatgpt.inFlight === 1 ? "" : "s"}</span> : `${status.chatgpt.pendingImages} images waiting`}
        </p>
      )}
      {status.pending > 0 && !busy && (
        <Button size="sm" className="mt-2 w-full" onClick={() => void send({ type: "enrichNow" })}>
          Judge now
        </Button>
      )}
    </div>
  )
}

/** The tweet's first image (or video poster) beside a ⌘K result, with a count when there are more. */
function PaletteThumb({ media }: { media: Media[] }) {
  const first = media[0]
  if (!first?.url) return null
  return (
    <span className="relative size-12 shrink-0 self-center overflow-hidden rounded-md border bg-muted">
      <img src={sized(first.url, "small")} alt={first.alt ?? ""} loading="lazy" className="size-full object-cover" />
      {first.type !== "photo" && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/25">
          <Play className="size-4 fill-white text-white drop-shadow" />
        </span>
      )}
      {media.length > 1 && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[9px] font-medium leading-3.5 text-white">+{media.length - 1}</span>}
    </span>
  )
}

function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [q, setQ] = useState("")
  const [settings] = useSettings()
  const [active, setActive] = useState(0)
  const theme = useResolvedTheme()
  const s = useTweetSearch(open ? q : "", {}, { lexicalLimit: 30 })
  const results = s.hits.slice(0, 8)
  useEffect(() => setActive(0), [q, s.phase])
  useEffect(() => {
    if (s.phase === "done" && s.jev && !s.jev.cached) play("ranked")
  }, [s.phase, s.jev])

  const go = (i: number) => {
    const t = results[i]?.tweet
    if (t) window.open(`https://x.com/${t.handle}/status/${t.id}`, "_blank")
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) play("close")
        onOpenChange(o)
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Popup className="fixed left-1/2 top-[12vh] z-50 w-[min(680px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-card shadow-2xl">
          <Dialog.Title className="sr-only">Search tweets</Dialog.Title>
          <BorderBeam size="line" active={s.phase === "judging"} colorVariant="ocean" theme={theme} strength={0.8}>
          <div className="flex items-center gap-2 border-b px-4">
            {s.phase === "judging" ? (
              <span role="status" aria-label="Jev is ranking" className="flex size-4 items-center justify-center text-foreground">
                <Comet size={16} />
              </span>
            ) : (
              <SearchIcon className="size-4 text-muted-foreground" />
            )}
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)) }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
                if (e.key === "Enter") {
                  // While the keyword pass for what was just typed is still running, the
                  // rows on screen belong to the previous query; open the full search instead.
                  if (e.metaKey || e.ctrlKey || results.length === 0 || s.phase === "lexical") { navigate("/search", { q }); onOpenChange(false) }
                  else go(active)
                }
              }}
              placeholder="Ask for a tweet the way you remember it…"
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            />
            {s.phase === "judging" && <span className="shimmer text-[12px]">Jev ranking</span>}
          </div>
          </BorderBeam>
          <div className="max-h-[52vh] overflow-y-auto p-1.5">
            {q.trim() === "" && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">Try “that thread about postgres vacuum” or “someone hiring rust people”.</p>}
            {q.trim() !== "" && results.length === 0 && s.phase !== "lexical" && s.phase !== "judging" && (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">Nothing yet. Scroll X a bit more and it will be here.</p>
            )}
            {results.map((h, i) => {
              const cat = settings.categories.find((c) => c.id === h.tweet.enrichment?.category)
              return (
                <button
                  key={h.tweet.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(i)}
                  className={cn("flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-all duration-300", i === active && "bg-active")}
                >
                  <Avatar src={h.tweet.avatar} handle={h.tweet.handle} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground">@{h.tweet.handle}</span>
                      {cat && <span>{cat.label}</span>}
                      {h.expanded && <span>· found by topic</span>}
                      {h.relevance != null && <span className="ml-auto tabular-nums">{Math.round(h.relevance * 100)}</span>}
                    </div>
                    <p className="line-clamp-2 text-[13px] leading-5">
                      <Highlighted text={displayText(h.tweet.text, h.tweet.urls)} terms={h.terms} />
                    </p>
                  </div>
                  <PaletteThumb media={h.tweet.media} />
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><Kbd><CornerDownLeft className="size-3" /></Kbd> open on X</span>
            <span className="flex items-center gap-1"><Kbd>⌘</Kbd><Kbd><CornerDownLeft className="size-3" /></Kbd> all results</span>
            <span className="ml-auto">
              {s.phase === "done" && s.jev ? `Jev ranked ${s.hits.length + s.demoted.length} in ${s.jev.tookMs} ms${s.jev.cached ? " (cached)" : ""}` : s.phase === "error" ? `Keyword order: ${s.error}` : s.lexicalMs != null ? `keywords ${s.lexicalMs} ms` : ""}
            </span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
