/**
 * What's in a tweet's images. One question per tweet, answered as JSON, so
 * the description and any visible text can be searched and handed to Jev.
 */
import type { PendingVision, VisionResult } from "./store"
import type { InputContent } from "./chatgpt"

export const VISION_KINDS = ["screenshot", "chart", "meme", "photo", "diagram", "text", "artwork", "product", "video", "other"] as const

export const VISION_SCHEMA = {
  name: "tweet_images",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["description", "text", "kind", "adds_information"],
    properties: {
      description: { type: "string", description: "One or two plain sentences: what the images show and what point they make. Name people, products, charts' subjects, numbers." },
      text: { type: "string", description: "All text readable in the images, verbatim, in reading order. Empty string if none." },
      kind: { type: "string", enum: [...VISION_KINDS] },
      adds_information: { type: "boolean", description: "True if the images carry information the tweet text does not already say." },
    },
  },
} as const

export function visionPrompt(t: PendingVision): string {
  return [
    `A tweet by @${t.handle}${t.text ? ` says:\n"""${t.text.slice(0, 1000)}"""` : " has no text"}.`,
    `Attached: ${t.media.length} image${t.media.length === 1 ? "" : "s"}${t.media.some((m) => m.type !== "photo") ? " (video frames are thumbnails)" : ""}.`,
    "Describe what the images show for someone who cannot see them, transcribe any text in them, classify the kind, and say whether they add information beyond the tweet text.",
    "Answer as JSON matching the schema. Do not run tools.",
  ].join("\n")
}

/** Text plus the images as data URLs, so the backend never has to fetch from X. */
export function visionInput(t: PendingVision, images: string[]): InputContent[] {
  return [{ type: "input_text", text: visionPrompt(t) }, ...images.map((image_url) => ({ type: "input_image" as const, image_url, detail: "low" as const }))]
}

/** The model's JSON, tolerating a fenced block or stray prose around it. */
export function parseVision(text: string, model?: string): VisionResult {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error(`No JSON in vision answer: ${text.slice(0, 120)}`)
  const j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const kind = String(j.kind ?? "other")
  return {
    description: String(j.description ?? "").trim(),
    text: String(j.text ?? "").trim(),
    kind: (VISION_KINDS as readonly string[]).includes(kind) ? kind : "other",
    addsInformation: Boolean(j.adds_information),
    model,
  }
}

/** The pbs.twimg.com small variant, which is plenty at detail "low". */
export function smallImageUrl(url: string): string {
  if (!url.includes("pbs.twimg.com")) return url
  const m = url.match(/^(.*)\.(jpg|jpeg|png|webp)$/)
  if (m) return `${m[1]}?format=${m[2] === "jpeg" ? "jpg" : m[2]}&name=small`
  return url.includes("name=") ? url.replace(/name=\w+/, "name=small") : `${url}${url.includes("?") ? "&" : "?"}name=small`
}

export async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url)
  // A missing image is the tweet's problem, not a transient one: surface it as a 4xx.
  if (!res.ok) throw Object.assign(new Error(`Image ${res.status}`), { status: res.status })
  const blob = await res.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${blob.type || "image/jpeg"};base64,${btoa(s)}`
}
