import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { send, type Broadcast, type EnrichStatus } from "@/lib/rpc"
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from "@/lib/settings"

// ── hash router ───────────────────────────────────────────────────────────

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb)
  return () => window.removeEventListener("hashchange", cb)
}

export function useRoute(): { path: string; params: URLSearchParams } {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash)
  const [path, qs = ""] = hash.replace(/^#/, "").split("?")
  return { path: path || "/", params: new URLSearchParams(qs) }
}

export function navigate(path: string, params?: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(params ?? {}).filter((e): e is [string, string] => Boolean(e[1]))).toString()
  location.hash = `${path}${qs ? `?${qs}` : ""}`
}

// ── live data ─────────────────────────────────────────────────────────────

const listeners = new Set<(b: Broadcast) => void>()
chrome.runtime.onMessage.addListener((msg: Broadcast) => {
  if (msg?.type === "changed") for (const l of listeners) l(msg)
})

export function useChanged(cb: (b: Broadcast) => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    const l = (b: Broadcast) => ref.current(b)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
}

// Last time the background reported new tweets from x.com; drives the Home glow.
let lastIngestAt = 0
listeners.add((b) => {
  if (b.type === "changed" && b.what === "ingest") lastIngestAt = performance.now()
})

/** 0–1: jumps when tweets arrive from x.com, fades over a couple of seconds. Sampled every frame. */
export function ingestLevel(): number {
  if (!lastIngestAt) return 0
  return Math.exp(-(performance.now() - lastIngestAt) / 1800) * 0.9
}

/** Run a read, re-run it when deps change or the index changes. */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], { live = true } = {}) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const run = useCallback(() => {
    const id = ++seq.current
    setLoading(true)
    load()
      .then((d) => {
        if (id === seq.current) {
          setData(d)
          setError(undefined)
        }
      })
      .catch((e: Error) => id === seq.current && setError(e.message))
      .finally(() => id === seq.current && setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(run, [run])
  useChanged(() => {
    if (live) run()
  })
  return { data, error, loading, reload: run }
}

/**
 * Settings from chrome.storage. `loaded` is false until the stored values
 * arrive, so callers can avoid acting on defaults (e.g. flashing the wrong
 * theme). Saves apply locally at once, so sliders and inputs don't lag.
 */
export function useSettings(): [Settings, (patch: Partial<Settings>) => Promise<void>, boolean] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    const load = () =>
      void getSettings().then((s) => {
        setSettings(s)
        setLoaded(true)
      })
    load()
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.settings) load()
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])
  const save = useCallback(async (patch: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...patch }))
    await saveSettings(patch)
  }, [])
  return [settings, save, loaded]
}

export function useStatus() {
  const [status, setStatus] = useState<EnrichStatus>()
  const refresh = useCallback(() => {
    send<EnrichStatus>({ type: "status" }).then(setStatus, () => {})
  }, [])
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2500)
    return () => clearInterval(t)
  }, [refresh])
  useChanged(refresh)
  return { status, refresh }
}

// ── formatting ────────────────────────────────────────────────────────────

export function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function compact(n: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}
