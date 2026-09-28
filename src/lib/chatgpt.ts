/**
 * Sign in with ChatGPT, and calls billed to that subscription.
 *
 * This is the same OAuth flow Codex CLI uses, which OpenAI has said third-party
 * tools may use (Codex for Open Source; Cline, OpenCode and pi ship it). The
 * pieces the backend expects: the Codex OAuth client, `store: false`,
 * streaming, and Codex's own published system prompt as `instructions`.
 */

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const TOKEN_URL = "https://auth.openai.com/oauth/token"
/** Codex's registered callback. Nothing listens there; the extension reads it off the tab. */
export const REDIRECT_URI = "http://localhost:1455/auth/callback"
export const SCOPE = "openid profile email offline_access"
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const RESPONSES_URL = `${CODEX_BASE_URL}/responses`
/** Codex CLI version we present when asking for the model list. */
export const CLIENT_VERSION = "0.154.0"
const JWT_CLAIM = "https://api.openai.com/auth"

export interface ChatGPTAuth {
  access: string
  refresh: string
  /** ms since epoch */
  expires: number
  accountId: string
  email?: string
  plan?: string
}

export interface PendingLogin {
  state: string
  verifier: string
}

// ── PKCE ──────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function createLogin(): Promise<{ url: string; pending: PendingLogin }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const url = new URL(AUTHORIZE_URL)
  const params: Record<string, string> = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return { url: url.toString(), pending: { state, verifier } }
}

/** The callback URL the login tab lands on, or nothing if it's not ours. */
export function parseCallback(url: string, pending: PendingLogin): { code: string } | { error: string } | undefined {
  if (!url.startsWith(REDIRECT_URI)) return undefined
  const u = new URL(url)
  const error = u.searchParams.get("error")
  if (error) return { error: u.searchParams.get("error_description") ?? error }
  const code = u.searchParams.get("code")
  if (!code) return { error: "No code in callback" }
  if (u.searchParams.get("state") !== pending.state) return { error: "State mismatch; try signing in again" }
  return { code }
}

// ── tokens ────────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

export function decodeJwt(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1]
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Account id, email and plan from the tokens OpenAI returns. */
export function authFromTokens(t: TokenResponse): ChatGPTAuth {
  if (!t.access_token || !t.refresh_token || typeof t.expires_in !== "number") throw new Error("Token response is missing fields")
  const access = decodeJwt(t.access_token) ?? {}
  const id = t.id_token ? (decodeJwt(t.id_token) ?? {}) : {}
  const claim = (access[JWT_CLAIM] ?? id[JWT_CLAIM] ?? {}) as Record<string, unknown>
  const accountId = claim.chatgpt_account_id
  if (typeof accountId !== "string" || !accountId) throw new Error("Could not read the ChatGPT account id from the token")
  const email = [id.email, access.email, claim.email].find((e): e is string => typeof e === "string")
  const plan = [claim.chatgpt_plan_type, claim.plan_type].find((p): p is string => typeof p === "string")
  return { access: t.access_token, refresh: t.refresh_token, expires: Date.now() + t.expires_in * 1000, accountId, email, plan }
}

async function tokenRequest(body: Record<string, string>): Promise<ChatGPTAuth> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
  if (!res.ok) throw new ChatGPTError(`OpenAI sign-in ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, res.status)
  return authFromTokens((await res.json()) as TokenResponse)
}

export function exchangeCode(code: string, pending: PendingLogin): Promise<ChatGPTAuth> {
  return tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: pending.verifier, redirect_uri: REDIRECT_URI })
}

export function refreshAuth(auth: ChatGPTAuth): Promise<ChatGPTAuth> {
  return tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: auth.refresh })
}

// ── Codex instructions ────────────────────────────────────────────────────

const PROMPT_FILE: Record<string, string> = {
  "gpt-5.2-codex": "gpt-5.2-codex_prompt.md",
  "gpt-5.2": "gpt_5_2_prompt.md",
  "gpt-5.1": "gpt_5_1_prompt.md",
}

/** Which of Codex's prompts a model expects. Newer models than the files cover get the latest general one. */
export function promptFileFor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes("5.2") && m.includes("codex")) return PROMPT_FILE["gpt-5.2-codex"]
  if (m.includes("5.1") && m.includes("codex")) return "gpt-5.1-codex-max_prompt.md"
  if (m.includes("gpt-5-codex") || m === "codex-mini-latest") return "gpt_5_codex_prompt.md"
  if (m.includes("gpt-5.1") || m.includes("gpt-5-")) return PROMPT_FILE["gpt-5.1"]
  return PROMPT_FILE["gpt-5.2"]
}

/** Codex's system prompt for the model, from the latest release on GitHub. Cached a day. */
export async function codexInstructions(model: string, cache: { get: (k: string) => Promise<string | undefined>; set: (k: string, v: string) => Promise<void> }): Promise<string> {
  const file = promptFileFor(model)
  const key = `codex-prompt:${file}`
  const cached = await cache.get(key)
  if (cached) {
    const { at, text } = JSON.parse(cached) as { at: number; text: string }
    if (Date.now() - at < 86_400_000) return text
  }
  const stale = cached ? (JSON.parse(cached) as { text: string }).text : undefined
  let res: Response
  try {
    const rel = await fetch("https://api.github.com/repos/openai/codex/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    const tag = rel.ok ? ((await rel.json()) as { tag_name?: string }).tag_name : undefined
    res = await fetch(`https://raw.githubusercontent.com/openai/codex/${tag ?? "main"}/codex-rs/core/${file}`)
  } catch (err) {
    if (stale) return keepStale(key, stale, cache)
    throw err
  }
  if (!res.ok) {
    // Keep using the old prompt and don't ask GitHub again for a while (60 requests/hour unauthenticated).
    if (stale) return keepStale(key, stale, cache)
    throw new ChatGPTError(`Could not fetch Codex instructions (${res.status})`)
  }
  const text = await res.text()
  await cache.set(key, JSON.stringify({ at: Date.now(), text }))
  return text
}

async function keepStale(key: string, text: string, cache: { set: (k: string, v: string) => Promise<void> }): Promise<string> {
  // Retry in an hour rather than on every image.
  await cache.set(key, JSON.stringify({ at: Date.now() - 86_400_000 + 3_600_000, text }))
  return text
}

// ── models ────────────────────────────────────────────────────────────────

export interface CodexModel {
  slug: string
  name: string
  description?: string
  /** Backend ordering; lower is more prominent. */
  priority: number
  reasoningLevels: string[]
}

function authHeaders(auth: ChatGPTAuth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.access}`,
    "chatgpt-account-id": auth.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
  }
}

/** The models your ChatGPT account may use through Codex, as the backend lists them for Codex CLI. */
export async function listModels(auth: ChatGPTAuth): Promise<CodexModel[]> {
  const res = await fetch(`${CODEX_BASE_URL}/models?client_version=${CLIENT_VERSION}`, { headers: authHeaders(auth) })
  if (!res.ok) throw new ChatGPTError(`ChatGPT models ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, res.status)
  const body = (await res.json()) as { models?: Record<string, unknown>[] }
  return parseModels(body)
}

export function parseModels(body: { models?: Record<string, unknown>[] }): CodexModel[] {
  return (body.models ?? [])
    .filter((m) => typeof m.slug === "string" && String(m.visibility ?? "list").toLowerCase() === "list")
    .map((m) => ({
      slug: String(m.slug),
      name: String(m.display_name ?? m.slug),
      description: typeof m.description === "string" ? m.description : undefined,
      priority: Number(m.priority ?? 0),
      reasoningLevels: ((m.supported_reasoning_levels as { effort?: string }[] | undefined) ?? []).map((l) => String(l.effort ?? "")).filter(Boolean),
    }))
    .sort((a, b) => a.priority - b.priority)
}

// ── requests ──────────────────────────────────────────────────────────────

export type InputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "low" | "high" | "auto" }

export interface ResponsesRequest {
  model: string
  instructions: string
  input: { role: "user"; content: InputContent[] }[]
  /** JSON schema the answer must match. */
  schema?: { name: string; schema: Record<string, unknown> }
  reasoningEffort?: "minimal" | "low" | "medium" | "high"
}

export class ChatGPTError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** One call to the Codex backend. Returns the model's final text. */
export async function respond(auth: ChatGPTAuth, req: ResponsesRequest, { timeoutMs = 60_000 } = {}): Promise<{ text: string; model: string }> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: req.reasoningEffort ?? "low" },
    text: {
      verbosity: "low",
      ...(req.schema ? { format: { type: "json_schema", name: req.schema.name, schema: req.schema.schema, strict: true } } : {}),
    },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: { ...authHeaders(auth), "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300)
      // The backend reports an exhausted plan as a 404 with a usage code.
      const status = res.status === 404 && /usage_limit|usage_not_included|rate_limit/i.test(text) ? 429 : res.status
      throw new ChatGPTError(`ChatGPT ${res.status}: ${text}`, status)
    }
    return parseSse(await res.text())
  } catch (err) {
    if (controller.signal.aborted) throw new ChatGPTError("ChatGPT timed out")
    throw err
  } finally {
    clearTimeout(timer)
  }
}

interface StreamErrorBody {
  code?: string
  type?: string
  message?: string
}

/** Mid-stream errors carry codes, not HTTP statuses; map the ones that mean "back off". */
function streamError(e: StreamErrorBody | undefined, fallback: string): ChatGPTError {
  const code = `${e?.code ?? ""} ${e?.type ?? ""}`
  const status = /rate_limit|usage_limit|insufficient_quota|usage_not_included/i.test(code) ? 429 : /server_error|overloaded/i.test(code) ? 503 : undefined
  return new ChatGPTError(e?.message ?? fallback, status)
}

/** The final text out of a Responses SSE stream. */
export function parseSse(sse: string): { text: string; model: string } {
  let deltas = ""
  let final: { text: string; model: string } | undefined
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(line.slice(6))
    } catch {
      continue
    }
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") deltas += ev.delta
    if (ev.type === "response.completed" || ev.type === "response.done") {
      const r = ev.response as { model?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] } | undefined
      const text = (r?.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("")
      final = { text: text || deltas, model: r?.model ?? "" }
    }
    if (ev.type === "error") throw streamError(ev.error as StreamErrorBody | undefined, "ChatGPT stream error")
    if (ev.type === "response.failed") throw streamError((ev.response as { error?: StreamErrorBody } | undefined)?.error, "ChatGPT response failed")
    if (ev.type === "response.incomplete") {
      const reason = (ev.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details?.reason ?? "unknown"
      throw new ChatGPTError(`ChatGPT stopped early (${reason})`, reason === "max_output_tokens" ? 422 : undefined)
    }
  }
  if (!final) {
    if (deltas) return { text: deltas, model: "" }
    throw new ChatGPTError("ChatGPT returned no answer")
  }
  return final
}
