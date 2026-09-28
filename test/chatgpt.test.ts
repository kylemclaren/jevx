import { expect, test } from "bun:test"
import { authFromTokens, createLogin, parseCallback, parseSse, promptFileFor, REDIRECT_URI } from "../src/lib/chatgpt"
import { parseVision, smallImageUrl, visionInput } from "../src/lib/vision"

const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`

test("login URL carries PKCE, state and the Codex flow flags", async () => {
  const { url, pending } = await createLogin()
  const u = new URL(url)
  expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize")
  expect(u.searchParams.get("code_challenge_method")).toBe("S256")
  expect(u.searchParams.get("state")).toBe(pending.state)
  expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT_URI)
  expect(u.searchParams.get("codex_cli_simplified_flow")).toBe("true")
  expect(pending.verifier.length).toBeGreaterThan(40)
})

test("callback parsing checks origin and state", () => {
  const pending = { state: "abc", verifier: "v" }
  expect(parseCallback("https://x.com/home", pending)).toBeUndefined()
  expect(parseCallback(`${REDIRECT_URI}?code=c1&state=abc`, pending)).toEqual({ code: "c1" })
  expect(parseCallback(`${REDIRECT_URI}?code=c1&state=zzz`, pending)).toMatchObject({ error: expect.stringContaining("State") })
  expect(parseCallback(`${REDIRECT_URI}?error=access_denied&error_description=nope`, pending)).toEqual({ error: "nope" })
})

test("account id, email and plan come out of the tokens", () => {
  const auth = authFromTokens({
    access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_1", chatgpt_plan_type: "plus" } }),
    refresh_token: "r",
    expires_in: 3600,
    id_token: jwt({ email: "k@example.com" }),
  })
  expect(auth).toMatchObject({ accountId: "acc_1", plan: "plus", email: "k@example.com", refresh: "r" })
  expect(auth.expires).toBeGreaterThan(Date.now() + 3_500_000)
  expect(() => authFromTokens({ access_token: jwt({}), refresh_token: "r", expires_in: 1 })).toThrow(/account id/)
})

test("prompt file follows the model family", () => {
  expect(promptFileFor("gpt-5.2")).toBe("gpt_5_2_prompt.md")
  expect(promptFileFor("gpt-5.2-codex")).toBe("gpt-5.2-codex_prompt.md")
  expect(promptFileFor("gpt-5-mini")).toBe("gpt_5_1_prompt.md")
  expect(promptFileFor("gpt-5.5")).toBe("gpt_5_2_prompt.md")
})

test("SSE parsing prefers the completed response and falls back to deltas", () => {
  const done = [
    'data: {"type":"response.output_text.delta","delta":"{\\"a\\":"}',
    'data: {"type":"response.output_text.delta","delta":"1}"}',
    'data: {"type":"response.completed","response":{"model":"gpt-5.2","output":[{"type":"reasoning"},{"type":"message","content":[{"type":"output_text","text":"{\\"a\\":1}"}]}]}}',
  ].join("\n")
  expect(parseSse(done)).toEqual({ text: '{"a":1}', model: "gpt-5.2" })
  expect(parseSse('data: {"type":"response.output_text.delta","delta":"hi"}')).toEqual({ text: "hi", model: "" })
  expect(() => parseSse('data: {"type":"error","error":{"message":"boom"}}')).toThrow("boom")
})

test("vision input and answer parsing", () => {
  const row = { id: "1", handle: "a", text: "look", media: [{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }] }
  const input = visionInput(row, ["data:image/jpeg;base64,AAAA"])
  expect(input[0]).toMatchObject({ type: "input_text" })
  expect(input[1]).toEqual({ type: "input_image", image_url: "data:image/jpeg;base64,AAAA", detail: "low" })
  expect(parseVision('Sure:\n```json\n{"description":"A chart of GPU prices","text":"H100 $25k","kind":"chart","adds_information":true}\n```', "gpt-5.2")).toEqual({
    description: "A chart of GPU prices", text: "H100 $25k", kind: "chart", addsInformation: true, model: "gpt-5.2",
  })
  expect(parseVision('{"description":"x","text":"","kind":"nonsense","adds_information":false}').kind).toBe("other")
  expect(smallImageUrl("https://pbs.twimg.com/media/x.jpg")).toBe("https://pbs.twimg.com/media/x?format=jpg&name=small")
  expect(smallImageUrl("https://pbs.twimg.com/media/x?format=png&name=large")).toBe("https://pbs.twimg.com/media/x?format=png&name=small")
})

test("model list keeps listed models in backend order", async () => {
  const { parseModels } = await import("../src/lib/chatgpt")
  const models = parseModels({
    models: [
      { slug: "gpt-x-mini", display_name: "GPT-X mini", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }] },
      { slug: "secret", display_name: "Secret", visibility: "hide", priority: 0 },
      { slug: "gpt-x", display_name: "GPT-X", description: "Best", visibility: "list", priority: 1 },
    ],
  })
  expect(models.map((m) => m.slug)).toEqual(["gpt-x", "gpt-x-mini"])
  expect(models[1].reasoningLevels).toEqual(["low", "medium"])
})
