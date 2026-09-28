import { Check, Database, Download, Eye, LogOut, Plus, RefreshCw, Trash2 } from "lucide-react"

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { VisionModelsReply } from "@/lib/rpc"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { query, send } from "@/lib/rpc"
import { DEFAULT_CATEGORIES, slug, type Category, type WatchTopic } from "@/lib/settings"
import type { StoredTweet } from "@/lib/types"
import { ask } from "@/lib/typesafe"
import { Button, Card, Input, PageTitle, Segmented, Slider, Spinner, Switch } from "../components/ui"
import { bytes, timeAgo, useLive, useRoute, useSettings, useStatus } from "../hooks"
import { play } from "../sounds"

/**
 * Ids from labels, fixed at save time (not on the first keystroke), kept for
 * items that already have one, and made unique so two labels can't merge.
 */
function withIds<T extends { id: string; label: string }>(items: T[], reserved: string[] = []): T[] {
  const taken = new Set(reserved)
  for (const it of items) if (it.id) taken.add(it.id)
  return items.map((it) => {
    if (it.id) return it
    const base = slug(it.label)
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return { ...it, id }
  })
}

export function downloadJson(name: string, data: unknown) {
  download(name, JSON.stringify(data, null, 2), "application/json")
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }))
  const a = Object.assign(document.createElement("a"), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function toCsv(tweets: StoredTweet[]): string {
  const cols = ["id", "url", "handle", "name", "created_at", "text", "category", "signal", "tone", "likes", "retweets", "views", "seen_count", "copies", "dup_of"]
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = tweets.map((t) =>
    [t.id, `https://x.com/${t.handle}/status/${t.id}`, t.handle, t.name, new Date(t.createdAt).toISOString(), t.text, t.enrichment?.category, t.enrichment?.signal?.toFixed(3), t.enrichment?.tone?.toFixed(3), t.likes, t.retweets, t.views, t.seenCount, t.copies, t.dupOf]
      .map(esc)
      .join(","),
  )
  return [cols.join(","), ...rows].join("\n")
}

export function SettingsPage() {
  const [settings, save] = useSettings()
  const [key, setKey] = useState("")
  const [keyState, setKeyState] = useState<"idle" | "testing" | "ok" | string>("idle")
  const [categories, setCategories] = useState<Category[]>(settings.categories)
  const [topics, setTopics] = useState<WatchTopic[]>(settings.topics)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const { status, refresh } = useStatus()
  const { params } = useRoute()
  const login = params.get("login")
  useEffect(() => {
    if (login === "ok") play("success")
    if (login === "failed") play("error")
  }, [login])
  const gpt = status?.chatgpt
  const [modelCheck, setModelCheck] = useState<"idle" | "testing" | string>("idle")
  const signedIn = Boolean(gpt?.signedIn)
  const models = useLive<VisionModelsReply | undefined>(() => (signedIn ? send<VisionModelsReply>({ type: "visionModels" }) : Promise.resolve(undefined)), [signedIn], { live: false })
  const offered = models.data?.ok ? models.data.models : []
  const current = offered.find((m) => m.slug === settings.visionModel)
  const testModel = async () => {
    setModelCheck("testing")
    try {
      const r = await send<{ ok: true; model: string; ms: number } | { ok: false; error: string }>({ type: "visionCheck", model: settings.visionModel })
      if (r.ok) {
        play("success")
        setModelCheck(`ok: ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s`)
      } else {
        play("error")
        setModelCheck(r.error)
      }
    } catch (err) {
      play("error")
      setModelCheck((err as Error).message)
    } finally {
      refresh()
    }
  }
  // Re-sync the editors only when the stored lists really changed, and never over unsaved edits.
  const syncedCategories = useRef(JSON.stringify(settings.categories))
  const syncedTopics = useRef(JSON.stringify(settings.topics))
  useEffect(() => {
    const next = JSON.stringify(settings.categories)
    if (next === syncedCategories.current) return
    if (JSON.stringify(categories) === syncedCategories.current) setCategories(settings.categories)
    syncedCategories.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.categories])
  useEffect(() => {
    const next = JSON.stringify(settings.topics)
    if (next === syncedTopics.current) return
    if (JSON.stringify(topics) === syncedTopics.current) setTopics(settings.topics)
    syncedTopics.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.topics])
  useEffect(() => setKey(settings.apiKey), [settings.apiKey])

  const testAndSaveKey = async () => {
    setKeyState("testing")
    try {
      await ask({ apiKey: key.trim(), model: settings.model }, "The sky is blue.", { ok: { type: "noul", instructions: "Is this statement about the sky?" } }, { retries: 0 })
      await save({ apiKey: key.trim() })
      setKeyState("ok")
      play("success")
    } catch (err) {
      setKeyState((err as Error).message)
      play("error")
    }
  }
  const categoriesDirty = JSON.stringify(categories) !== JSON.stringify(settings.categories)
  const topicsDirty = JSON.stringify(topics) !== JSON.stringify(settings.topics)

  return (
    <>
      <PageTitle title="Settings" subtitle="Your index lives in SQLite (OPFS) inside this browser profile. Only tweet text goes to TypeSafe, and only to be judged." />

      <Section title="TypeSafe" description="Jev judges every new tweet in batches. About $0.05 per thousand tweets.">
        <Row label="API key" hint={<>From <a className="underline" href="https://typesafe.ai" target="_blank" rel="noreferrer">typesafe.ai</a>. Stored in chrome.storage on this device.</>}>
          <div className="flex w-full max-w-md gap-2">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="apikey_…" autoComplete="off" spellCheck={false} />
            <Button variant="primary" onClick={testAndSaveKey} disabled={!key.trim() || keyState === "testing"}>
              {keyState === "ok" ? <><Check /> Saved</> : keyState === "testing" ? <><Spinner size={12} /> Testing</> : "Test & save"}
            </Button>
          </div>
          {keyState !== "idle" && keyState !== "ok" && keyState !== "testing" && <p className="mt-1.5 text-[12px] text-red-600 dark:text-red-400">{keyState}</p>}
        </Row>
        <Row label="Model" hint="jev-latest follows the stable release.">
          <select value={settings.model} onChange={(e) => void save({ model: e.target.value })} className="h-9 rounded-lg border border-border-strong bg-card px-3 text-sm">
            <option value="jev-latest">jev-latest</option>
            <option value="jev-preview">jev-preview</option>
          </select>
        </Row>
        <Row label="Judge automatically" hint="Off: tweets are still indexed; judge them from the sidebar when you like.">
          <Switch checked={settings.autoEnrich} onChange={(v) => void save({ autoEnrich: v })} label="Judge automatically" />
        </Row>
        <Row label="Batch size" hint={`${settings.batchSize} tweets per request, ${settings.concurrency} requests at a time.`}>
          <div className="flex w-64 items-center gap-3">
            <Slider value={settings.batchSize} min={1} max={12} step={1} onChange={(v) => void save({ batchSize: v })} label="Batch size" />
            <span className="w-6 text-right text-sm tabular-nums">{settings.batchSize}</span>
          </div>
        </Row>
        <Row label="Search candidates" hint="Keyword hits Jev reads per search. Accuracy plateaus around 20.">
          <div className="flex w-64 items-center gap-3">
            <Slider value={settings.searchCandidates} min={5} max={40} step={5} onChange={(v) => void save({ searchCandidates: v })} label="Search candidates" />
            <span className="w-6 text-right text-sm tabular-nums">{settings.searchCandidates}</span>
          </div>
        </Row>
      </Section>

      <Section title="Dashboard" description="How this page looks and sounds.">
        <Row label="Theme">
          <Segmented
            value={settings.theme}
            onChange={(theme) => void save({ theme })}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </Row>
        <Row label="Sounds" hint="Quiet ticks, a chime when Jev finishes ranking, a bell for watch-topic matches.">
          <Switch checked={settings.sounds} onChange={(v) => void save({ sounds: v })} label="Sounds" />
        </Row>
        {settings.sounds && (
          <Row label="Volume">
            <div className="flex w-64 items-center gap-3">
              <Slider value={settings.soundVolume} min={0.05} max={1} step={0.05} onChange={(v) => void save({ soundVolume: v })} label="Volume" />
              <Button size="sm" variant="ghost" onClick={() => play("ranked")}>Test</Button>
            </div>
          </Row>
        )}
      </Section>

      <Section title="ChatGPT" description="Describes the images in tweets with your ChatGPT subscription, the way Codex, Cline and OpenCode use it. Descriptions and any text in the image become searchable and go to Jev.">
        <Row
          label="Account"
          hint={
            gpt?.signedIn
              ? `Signed in${gpt.email ? ` as ${gpt.email}` : ""}${gpt.plan ? ` (${gpt.plan})` : ""}. Usage counts against your ChatGPT plan, not an API bill.`
              : "Opens OpenAI's sign-in in a new tab. Your password never reaches jevx; it keeps only the tokens OpenAI hands back."
          }
        >
          {gpt?.signedIn ? (
            <Button onClick={async () => { await send({ type: "chatgptLogout" }); refresh() }}>
              <LogOut /> Sign out
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void send({ type: "chatgptLogin" })}>
              Sign in with ChatGPT
            </Button>
          )}
          {login === "failed" && gpt?.lastError && <p className="mt-1.5 max-w-md text-right text-[12px] text-red-600 dark:text-red-400">{gpt.lastError}</p>}
        </Row>
        <Row label="Describe images" hint={gpt?.signedIn ? `${gpt.pendingImages} waiting · ${gpt.usedThisHour} of ${settings.visionPerHour} this hour${gpt.inFlight ? ` · ${gpt.inFlight} in progress` : ""}` : "Sign in first."}>
          <div className="flex items-center gap-3">
            {gpt?.signedIn && gpt.pendingImages > 0 && (
              <Button size="sm" onClick={() => void send({ type: "visionNow" })}>
                <Eye /> Describe now
              </Button>
            )}
            <Switch checked={settings.vision} onChange={(v) => void save({ vision: v })} label="Describe images" />
          </div>
        </Row>
        {gpt?.lastError && login !== "failed" && (
          <Row label="Last problem">
            <p className="max-w-md text-right text-[12px] text-red-600 dark:text-red-400">{gpt.lastError}</p>
          </Row>
        )}
        <Row
          label="Model"
          hint={
            offered.length > 0
              ? current?.description ?? `${offered.length} models offered to your account through Codex. A cheap, fast one is best: it only describes pictures.`
              : models.data && !models.data.ok
                ? `Couldn't list models: ${models.data.error}`
                : signedIn
                  ? "Fetching the models your account can use…"
                  : "Sign in to see which models your account can use."
          }
        >
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex gap-2">
              {offered.length > 0 ? (
                <NativeSelect
                  className="w-56"
                  value={current ? settings.visionModel : ""}
                  onChange={(e) => { setModelCheck("idle"); void save({ visionModel: e.target.value }) }}
                >
                  {!current && <NativeSelectOption value="">{settings.visionModel} (not offered)</NativeSelectOption>}
                  {offered.map((m) => (
                    <NativeSelectOption key={m.slug} value={m.slug}>{m.name}{m.name !== m.slug ? ` · ${m.slug}` : ""}</NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input className="w-56" value={settings.visionModel} onChange={(e) => { setModelCheck("idle"); void save({ visionModel: e.target.value.trim() }) }} spellCheck={false} />
              )}
              <Button size="icon" variant="ghost" aria-label="Refresh model list" title="Refresh model list" disabled={!signedIn} onClick={() => models.reload()}>
                <RefreshCw className={models.loading ? "animate-spin" : ""} />
              </Button>
              <Button onClick={testModel} disabled={!signedIn || modelCheck === "testing"}>
                {modelCheck === "testing" ? <><Spinner size={12} /> Testing</> : "Test"}
              </Button>
            </div>
            {modelCheck !== "idle" && modelCheck !== "testing" && (
              <p className={`max-w-md text-right text-[12px] ${modelCheck.startsWith("ok:") ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{modelCheck}</p>
            )}
          </div>
        </Row>
        <Row label="Images per hour" hint="A cap so a long scroll can't eat your plan's Codex allowance.">
          <div className="flex w-64 items-center gap-3">
            <Slider value={settings.visionPerHour} min={10} max={600} step={10} onChange={(v) => void save({ visionPerHour: v })} label="Images per hour" />
            <span className="w-8 text-right text-sm tabular-nums">{settings.visionPerHour}</span>
          </div>
        </Row>
      </Section>

      <Section title="On x.com" description="What jevx adds to the timeline itself.">
        <Row
          label="Only index tweets I've seen"
          hint="Store a tweet once it has been on your screen for a moment, not just because X loaded it ahead of your scroll. Quoted tweets come along with the tweet you saw."
        >
          <Switch checked={settings.indexOnlySeen} onChange={(v) => void save({ indexOnlySeen: v })} label="Only index tweets I've seen" />
        </Row>
        <Row label="Chips under tweets" hint="Category, signal, flags, watch topics and duplicate counts.">
          <Switch checked={settings.inlineBadges} onChange={(v) => void save({ inlineBadges: v })} label="Chips under tweets" />
        </Row>
        <Row label="Fade low-signal tweets" hint={settings.dimBelow > 0 ? `Tweets under ${Math.round(settings.dimBelow * 100)} fade until you hover.` : "Off"}>
          <div className="flex w-64 items-center gap-3">
            <Slider value={settings.dimBelow} min={0} max={0.8} step={0.05} onChange={(v) => void save({ dimBelow: v })} label="Fade threshold" />
            <span className="w-6 text-right text-sm tabular-nums">{Math.round(settings.dimBelow * 100)}</span>
          </div>
        </Row>
        <Row label="Fade engagement bait" hint="Rage bait, 'reply with…' and teaser hooks.">
          <Switch checked={settings.dimBait} onChange={(v) => void save({ dimBait: v })} label="Fade engagement bait" />
        </Row>
      </Section>

      <Section
        title="Categories"
        description="Jev picks exactly one per tweet. Describe each in plain words: the description is what Jev reads."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setCategories(DEFAULT_CATEGORIES)}>Reset</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!categoriesDirty || !categories.some((c) => c.label.trim())}
              title={!categories.some((c) => c.label.trim()) ? "Keep at least one category" : undefined}
              onClick={() => void save({ categories: withIds(categories.filter((c) => c.label.trim()), ["any"]) })}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-2 p-5">
          {categories.map((c, i) => (
            <div key={i} className="flex gap-2">
              <Input className="w-44" value={c.label} placeholder="Label" onChange={(e) => setCategories(categories.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Input value={c.description} placeholder="What belongs here" onChange={(e) => setCategories(categories.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setCategories(categories.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setCategories([...categories, { id: "", label: "", description: "" }])}><Plus /> Category</Button>
        </div>
      </Section>

      <Section
        title="Watch topics"
        description="A yes/no check Jev runs on every tweet. Write it as a condition."
        actions={<Button size="sm" variant="primary" disabled={!topicsDirty} onClick={() => void save({ topics: withIds(topics.filter((t) => t.label.trim() && t.description.trim())) })}>Save</Button>}
      >
        <div className="space-y-2 p-5">
          {topics.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input className="w-44" value={t.label} placeholder="Label" onChange={(e) => setTopics(topics.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Input value={t.description} placeholder="e.g. a new open-weights model is released" onChange={(e) => setTopics(topics.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
              <div className="flex w-36 shrink-0 items-center gap-2" title="How sure Jev must be">
                <Slider value={t.threshold} min={0.5} max={0.95} step={0.05} onChange={(v) => setTopics(topics.map((x, j) => (j === i ? { ...x, threshold: v } : x)))} label="Threshold" />
                <span className="w-7 text-right text-[12px] tabular-nums text-muted-foreground">{Math.round(t.threshold * 100)}%</span>
              </div>
              <Button size="icon" variant="ghost" aria-label="Remove" onClick={() => setTopics(topics.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setTopics([...topics, { id: "", label: "", description: "", threshold: 0.7 }])}><Plus /> Topic</Button>
        </div>
      </Section>

      <CaptureSection />

      <StorageSection />

      <Section title="Data" description="Everything is local. Take it with you or start over.">
        <Row label="Export" hint="Every tweet with its dedup and Jev fields.">
          <div className="flex gap-2">
            <Button onClick={async () => downloadJson(`jevx-${new Date().toISOString().slice(0, 10)}.json`, await query("exportAll"))}><Download /> JSON</Button>
            <Button onClick={async () => download(`jevx-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(await query("exportAll")), "text/csv")}><Download /> CSV</Button>
          </div>
        </Row>
        <Row label="Re-judge everything" hint="After changing categories or topics. Costs tokens again.">
          <Button onClick={() => void send({ type: "resetEnrichment" })}>Re-judge</Button>
        </Row>
        <Row label="Delete the index" hint="Removes every stored tweet from this browser. Settings are kept.">
          {confirmWipe ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setConfirmWipe(false)}>Cancel</Button>
              <Button variant="danger" onClick={async () => { await send({ type: "wipe" }); setConfirmWipe(false) }}>Delete everything</Button>
            </div>
          ) : (
            <Button variant="danger" onClick={() => setConfirmWipe(true)}>Delete…</Button>
          )}
        </Row>
      </Section>
    </>
  )
}

/**
 * Where indexing stands: responses the tap on x.com has seen, tweets that
 * reached the index, and responses that should have held tweets but didn't
 * (X changing its data shape shows up there first).
 */
function CaptureSection() {
  const { status } = useStatus()
  const c = status?.captured
  if (!c) return null
  const healthy = c.tweets > 0 && c.empty === 0
  const verdict = c.fellBack
    ? "jevx couldn't find tweets on the x.com page, so it can't tell what you've seen. It's storing everything the page loads until that's fixed."
    : c.responses === 0 && c.tweets === 0
      ? "Nothing from x.com yet since the extension last started. Open or refresh an x.com tab and scroll."
      : c.tweets === 0
        ? `x.com sent ${c.responses} responses but none held tweets jevx could read. X may have changed its data format.`
        : c.empty > 0
          ? `${c.empty} timeline responses had no readable tweets (latest: ${c.lastEmptySource}). Some tweets may be missed.`
          : "Capturing normally."
  return (
    <Section title="Capture" description="What the extension has picked up from x.com since it last started.">
      <Row label={healthy ? "Healthy" : c.tweets === 0 ? "Not capturing" : "Partly capturing"} hint={verdict}>
        <div className="text-right text-[12px] tabular-nums text-muted-foreground">
          <div>{c.responses.toLocaleString()} API responses seen · {c.tweets.toLocaleString()} tweets indexed</div>
          {c.waiting > 0 && <div>{c.waiting.toLocaleString()} loaded by X but not on your screen yet</div>}
          <div>{c.lastAt ? `last ${timeAgo(c.lastAt)} ago from ${c.lastSource}` : "no tweets yet"}</div>
        </div>
      </Row>
    </Section>
  )
}

/** How much disk the index takes, where it goes, and two ways to shrink it. */
function StorageSection() {
  const { data: report, reload, loading } = useLive(() => query("storage"), [])
  const [days, setDays] = useState(90)
  const [keepEngaged, setKeepEngaged] = useState(true)
  const { data: pruneCount } = useLive(() => query("pruneCount", days, keepEngaged), [days, keepEngaged])
  const [busy, setBusy] = useState<"prune" | "vacuum" | undefined>()
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<string>()
  if (!report) return null
  const quotaPct = report.quota && report.quota.quota > 0 ? report.quota.usage / report.quota.quota : undefined
  const weeklyGrowth = report.tweetsPerWeek * report.bytesPerTweet
  const yearAtThisRate = weeklyGrowth * 52
  const run = async (what: "prune" | "vacuum") => {
    setBusy(what)
    try {
      if (what === "prune") {
        const removed = await send<number>({ type: "prune", olderThanDays: days, keepEngaged })
        setNote(`Removed ${removed.toLocaleString()} tweets. Compact to give the space back to disk.`)
        setConfirm(false)
      } else {
        const after = await send<number>({ type: "vacuum" })
        setNote(`Compacted to ${bytes(after)}.`)
      }
      play("success")
    } catch (err) {
      setNote((err as Error).message)
      play("error")
    } finally {
      setBusy(undefined)
      reload()
    }
  }
  return (
    <Section title="Storage" description="The SQLite database in this browser profile. Chrome lets an extension use a large share of free disk, but it's worth knowing where the bytes go.">
      <div className="px-5 py-4">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-[26px] font-light tabular-nums tracking-tight">{bytes(report.bytes)}</span>
              <span className="text-[12px] text-muted-foreground">on disk{report.free > 0 ? ` · ${bytes(report.free)} reclaimable` : ""}</span>
              {loading && <Spinner size={12} />}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {report.tweets.toLocaleString()} tweets · {report.sightings.toLocaleString()} sightings · {report.withMedia.toLocaleString()} with media · {report.withVision.toLocaleString()} described
              {report.oldestAt ? ` · oldest ${timeAgo(report.oldestAt)} ago` : ""}
            </div>
          </div>
          <div className="text-right text-[12px] text-muted-foreground">
            <div>{bytes(report.bytesPerTweet)} per tweet · {bytes(weeklyGrowth)} a week at the current pace</div>
            <div>About {bytes(yearAtThisRate)} a year if you keep this up</div>
          </div>
        </div>

        <div className="mb-1.5 flex h-2 overflow-hidden rounded-full bg-active" title="Where the bytes go">
          {report.buckets.map((b, i) => (
            <span key={b.id} className={i % 2 ? "bg-foreground/45" : "bg-foreground/80"} style={{ width: `${(b.bytes / Math.max(1, report.bytes)) * 100}%` }} title={`${b.label}: ${bytes(b.bytes)}`} />
          ))}
        </div>
        <div className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          {report.buckets.filter((b) => b.bytes > 0).map((b, i) => (
            <span key={b.id} className="flex items-center gap-1.5">
              <span className={`inline-block size-2 rounded-sm ${i % 2 ? "bg-foreground/45" : "bg-foreground/80"}`} />
              {b.label} <span className="tabular-nums">{bytes(b.bytes)}</span>
            </span>
          ))}
        </div>

        {quotaPct != null && report.quota && (
          <div className="mb-5">
            <div className="mb-1 flex justify-between text-[12px] text-muted-foreground">
              <span>Browser quota for this extension</span>
              <span className="tabular-nums">{bytes(report.quota.usage)} of {bytes(report.quota.quota)} · {(quotaPct * 100).toFixed(quotaPct < 0.01 ? 2 : 0)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-active">
              <span className={`block h-full rounded-full ${quotaPct > 0.8 ? "bg-amber-500" : "bg-foreground/70"}`} style={{ width: `${Math.max(0.5, quotaPct * 100)}%` }} />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4">
          <Database className="size-4 text-muted-foreground" />
          <span className="text-[13px]">Remove tweets older than</span>
          <NativeSelect className="w-28" value={String(days)} onChange={(e) => { setDays(Number(e.target.value)); setConfirm(false) }}>
            {[30, 60, 90, 180, 365].map((d) => <NativeSelectOption key={d} value={String(d)}>{d} days</NativeSelectOption>)}
          </NativeSelect>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={keepEngaged} onChange={(v) => { setKeepEngaged(v); setConfirm(false) }} label="Keep tweets you engaged with" /> keep ones I read, clicked or that matched a topic
          </label>
          <span className="text-[12px] tabular-nums text-muted-foreground">{pruneCount == null ? "…" : `${pruneCount.toLocaleString()} tweets`}</span>
          {confirm ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" size="sm" disabled={busy != null || !pruneCount} onClick={() => run("prune")}>
                {busy === "prune" && <Spinner size={12} />} Remove {pruneCount?.toLocaleString()}
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={!pruneCount} onClick={() => setConfirm(true)}>Remove…</Button>
          )}
          <Button size="sm" className="ml-auto" disabled={busy != null} onClick={() => run("vacuum")}>
            {busy === "vacuum" && <Spinner size={12} />} Compact{report.free > 0 ? ` (frees ${bytes(report.free)})` : ""}
          </Button>
        </div>
        {note && <p className="mt-2 text-[12px] text-muted-foreground">{note}</p>}
      </div>
    </Section>
  )
}

function Section({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-medium">{title}</h2>
          <p className="text-[13px] text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
      <Card className="divide-y">{children}</Card>
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-48">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex flex-col items-end">{children}</div>
    </div>
  )
}
