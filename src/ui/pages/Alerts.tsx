import { Bell, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { query, send } from "@/lib/rpc"
import { TweetRow } from "../components/tweet"
import { Button, Card, cn, Empty, PageTitle } from "../components/ui"
import { navigate, useLive, useSettings } from "../hooks"

export function Alerts() {
  const [settings] = useSettings()
  const [selected, setSelected] = useState<string | undefined>()
  const thresholds = Object.fromEntries(settings.topics.map((t) => [t.id, t.threshold]))
  const { data: counts } = useLive(() => query("topicCounts", thresholds), [JSON.stringify(thresholds)])
  const topic = settings.topics.find((t) => t.id === selected) ?? settings.topics[0]
  const { data } = useLive(
    () => (topic ? query("list", { topic: topic.id, topicThreshold: topic.threshold, hideCopies: true, limit: 50 }) : Promise.resolve(undefined)),
    [topic?.id, topic?.threshold],
  )

  useEffect(() => {
    void send({ type: "clearAlerts" })
  }, [])

  return (
    <>
      <PageTitle
        title="Watch topics"
        subtitle="Jev checks every new tweet against each topic. Matches light up the toolbar icon and get a ◆ chip on x.com."
        actions={
          <Button onClick={() => navigate("/settings")}>
            <Plus /> Edit topics
          </Button>
        }
      />
      {settings.topics.length === 0 ? (
        <Empty icon={<Bell />} title="No topics yet">Add one in Settings, e.g. “a new open-weights model is released”.</Empty>
      ) : (
        <div className="grid gap-6 md:grid-cols-[260px_1fr]">
          <div className="space-y-1">
            {settings.topics.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={cn("flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-hover", topic?.id === t.id && "bg-active")}
              >
                <span className="mt-0.5 text-violet-600 dark:text-violet-300">◆</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{t.label}</span>
                  <span className="line-clamp-2 text-[12px] text-muted-foreground">{t.description}</span>
                </span>
                <span className="text-[12px] tabular-nums text-muted-foreground">{counts?.[t.id] ?? 0}</span>
              </button>
            ))}
            <p className="px-3 pt-3 text-[11px] leading-4 text-muted-foreground">New topics apply to tweets judged from now on. Use “Re-judge everything” in Settings to check older ones.</p>
          </div>
          <Card>
            {data?.tweets.length ? (
              data.tweets.map((t) => <TweetRow key={t.id} tweet={t} settings={settings} />)
            ) : (
              <p className="p-6 text-sm text-muted-foreground">No matches yet.</p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
