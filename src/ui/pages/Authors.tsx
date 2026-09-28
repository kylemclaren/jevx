import { BadgeCheck } from "lucide-react"
import { useState } from "react"
import { query } from "@/lib/rpc"
import { Avatar, SignalBars } from "../components/tweet"
import { Card, PageTitle, Segmented } from "../components/ui"
import { duration, navigate, timeAgo, useLive, useSettings } from "../hooks"

export function Authors() {
  const [settings] = useSettings()
  const [sort, setSort] = useState<"tweets" | "signal" | "attention">("tweets")
  const { data } = useLive(() => query("authors", 200, sort), [sort])
  return (
    <>
      <PageTitle
        title="Authors"
        subtitle="Who fills your timeline, and whether it's worth it."
        actions={<Segmented value={sort} onChange={setSort} options={[{ value: "tweets", label: "Most tweets" }, { value: "signal", label: "Best signal" }, { value: "attention", label: "Your attention" }]} />}
      />
      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b text-left text-[12px] text-muted-foreground">
              <th className="px-4 py-2.5 font-normal">Author</th>
              <th className="px-4 py-2.5 font-normal">Usually posts</th>
              <th className="px-4 py-2.5 text-right font-normal">Tweets</th>
              <th className="px-4 py-2.5 text-right font-normal">Avg signal</th>
              <th className="px-4 py-2.5 text-right font-normal" title="How much you engage with them, from reading time and clicks">Your affinity</th>
              <th className="px-4 py-2.5 text-right font-normal">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((a) => (
              <tr
                key={a.handle}
                tabIndex={0}
                role="link"
                aria-label={`Tweets by @${a.handle}`}
                onClick={() => navigate("/feed", { handle: a.handle })}
                onKeyDown={(e) => e.key === "Enter" && navigate("/feed", { handle: a.handle })}
                className="cursor-pointer border-b last:border-b-0 hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar src={a.avatar} handle={a.handle} size={28} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 truncate font-medium">
                        {a.name}
                        {a.verified && <BadgeCheck className="size-3.5 text-muted-foreground" />}
                      </div>
                      <div className="truncate text-[12px] text-muted-foreground">@{a.handle}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  {a.topCategory && (
                    <span className="rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-muted-foreground">
                      {settings.categories.find((c) => c.id === a.topCategory)?.label ?? a.topCategory}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{a.tweets}</td>
                <td className="px-4 py-2.5 text-right">
                  {a.avgSignal != null ? (
                    <span className="inline-flex items-center gap-2 tabular-nums">
                      <SignalBars value={a.avgSignal} className="h-2.5" />
                      {Math.round(a.avgSignal * 100)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {a.affinity != null ? (
                    <span title={`Read ${duration(a.dwellMs)}, ${a.clicks} click${a.clicks === 1 ? "" : "s"}`}>
                      {Math.round(a.affinity * 100)}
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{duration(a.dwellMs)}</span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{timeAgo(a.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
