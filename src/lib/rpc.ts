/**
 * Messages between the pieces of the extension.
 *
 *   x.com (MAIN world)  ── postMessage ──▶  content script  ── runtime ──▶  background
 *   dashboard           ── runtime ────────────────────────────────────▶  background
 *   background          ── runtime (target: "offscreen") ─▶  offscreen doc ─▶ SQLite worker
 */
import type { BadgeInfo, Store } from "./store"
import type { EngagementEvent } from "./engagement"
import type { CapturedTweet, StoredTweet } from "./types"
import type { Ranked } from "./typesafe"
import type { CodexModel } from "./chatgpt"

export type VisionModelsReply = { ok: true; models: CodexModel[]; fetchedAt: number } | { ok: false; error: string }

/** Store methods callable from outside the worker. */
export const DB_OPS = [
  "ingest", "engage", "touchSeen", "saveEnrichment", "pendingVision", "pendingVisionCount", "saveVision", "markVisionFailed", "markEnrichFailed", "addUsage", "resetEnrichment", "wipe",
  "pending", "pendingCount", "lookup", "byIds", "list", "search", "topInCategories",
  "stats", "authors", "topicCounts", "exportAll", "storage", "pruneCount", "prune", "vacuum",
] as const satisfies readonly (keyof Store)[]
export type DbOp = (typeof DB_OPS)[number]

/** Ops the dashboard may call directly through the background. Writes go through named messages. */
export const READ_OPS: readonly DbOp[] = ["lookup", "byIds", "list", "search", "stats", "authors", "topicCounts", "exportAll", "pendingCount", "storage", "pruneCount"]

export type DbResult<Op extends DbOp> = ReturnType<Store[Op]>
export type DbArgs<Op extends DbOp> = Parameters<Store[Op]>

export interface EnrichStatus {
  /** What reached the background from x.com since the service worker last started. */
  captured: {
    messages: number
    tweets: number
    lastAt: number
    lastSource: string
    responses: number
    empty: number
    lastEmptySource: string
    /** Loaded by X but not on screen yet, so not stored (index-only-seen mode). */
    waiting: number
    /** A tab couldn't find tweets on screen and fell back to storing everything. */
    fellBack: boolean
  }
  pending: number
  inFlight: number
  apiKeySet: boolean
  autoEnrich: boolean
  lastError?: string
  lastRunAt?: number
  unseenAlerts: number
  chatgpt: {
    signedIn: boolean
    email?: string
    plan?: string
    pendingImages: number
    inFlight: number
    /** Analyses done in the current hour window. */
    usedThisHour: number
    lastError?: string
  }
}

export interface RerankReply {
  ranked: Ranked[]
  tweets: StoredTweet[]
  expanded: string[]
  answerable: number
  inputTokens: number
  model: string
  tookMs: number
  cached: boolean
}

export type Request =
  | { type: "ingest"; tweets: CapturedTweet[]; source: string }
  | { type: "lookup"; ids: string[] }
  | { type: "engage"; events: EngagementEvent[]; seen?: string[] }
  | { type: "tapStats"; responses: number; empty: number; lastEmptySource: string; waiting?: number; released?: number; fellBack?: boolean }
  | { type: "db"; op: DbOp; args: unknown[] }
  | { type: "rerank"; query: string; ids: string[] }
  | { type: "enrichNow" }
  | { type: "status" }
  | { type: "resetEnrichment" }
  | { type: "wipe" }
  | { type: "clearAlerts" }
  | { type: "chatgptLogin" }
  | { type: "chatgptLogout" }
  | { type: "visionNow" }
  | { type: "visionCheck"; model: string }
  | { type: "visionModels"; refresh?: boolean }
  | { type: "prune"; olderThanDays: number; keepEngaged: boolean }
  | { type: "vacuum" }

/** Broadcasts from the background. */
export type Broadcast =
  | { type: "changed"; what: "ingest" | "enrich" | "wipe" }
  | { type: "badges"; data: Record<string, BadgeInfo> }

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string }

export async function send<T>(req: Request): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(req)) as Reply<T> | undefined
  if (!reply) throw new Error("No reply from background")
  if (!reply.ok) throw new Error(reply.error)
  return reply.data
}

/** Typed read from the dashboard. */
export function query<Op extends DbOp>(op: Op, ...args: DbArgs<Op>): Promise<DbResult<Op>> {
  return send<DbResult<Op>>({ type: "db", op, args })
}
