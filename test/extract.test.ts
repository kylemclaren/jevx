import { describe, expect, test } from "bun:test"
import { contentHash, extractTweets, operationName } from "../src/lib/extract"
import { homeTimeline, tweet } from "./fixtures"

describe("extractTweets", () => {
  const tweets = extractTweets(homeTimeline())
  const byId = Object.fromEntries(tweets.map((t) => [t.id, t]))

  test("finds every real tweet and skips retweet wrappers", () => {
    expect(Object.keys(byId).sort()).toEqual(["100", "101", "102", "104", "105", "106", "107", "108"])
  })
  test("expands t.co links and decodes entities", () => {
    expect(byId["100"].text).toBe("Shipping a new SQLite WASM build today & it is fast https://sqlite.org/wasm")
    expect(byId["100"].urls).toEqual([{ url: "https://sqlite.org/wasm", display: "sqlite.org/wasm" }])
  })
  test("reads the new user shape", () => {
    expect(byId["100"]).toMatchObject({ handle: "alice", name: "ALICE", verified: true, views: 1234, likes: 10 })
    expect(byId["100"].avatar).toContain("alice.jpg")
  })
  test("unwraps visibility results", () => expect(byId["101"].handle).toBe("bob"))
  test("records who retweeted", () => expect(byId["102"].via).toBe("dave"))
  test("captures quoted tweets", () => expect(byId["104"].handle).toBe("erin"))
  test("marks promoted tweets", () => {
    expect(byId["106"].promoted).toBe(true)
    expect(byId["100"].promoted).toBe(false)
  })
  test("prefers note tweet text", () => expect(byId["107"].text).toContain("vector search"))
  test("strips media links and records media with sizes, alt text and video", () => {
    expect(byId["108"].text).toBe("Look at this chart")
    expect(byId["108"].media[0]).toMatchObject({ type: "photo", url: "https://pbs.twimg.com/media/x.jpg", width: 1200, height: 800, alt: "A bar chart" })
    // Second-best MP4, not the HLS playlist or the 1080p one.
    expect(byId["108"].media[1]).toMatchObject({ type: "video", video: "https://video.twimg.com/mid.mp4", durationMs: 12000, width: 1280 })
  })
  test("records reply context", () => expect(byId["108"].replyTo).toBe("alice"))
  test("reads link cards and resolves the t.co url", () => {
    expect(byId["100"].card).toEqual({
      url: "https://sqlite.org/wasm", title: "SQLite WASM", description: "SQLite compiled to WebAssembly", domain: "sqlite.org",
      image: "https://pbs.twimg.com/card_img/1.jpg", imageWidth: 800, imageHeight: 419, large: true,
    })
    expect(byId["101"].card).toBeUndefined()
  })
})

test("tweets inside visibility wrappers are found without a __typename", () => {
  const inner = { ...tweet("300", "zed", "wrapped with no typename") } as Record<string, unknown>
  delete inner.__typename
  const got = extractTweets({ data: { tweet_results: { result: { __typename: "TweetWithVisibilityResults", tweet: inner } } } })
  expect(got.map((t) => t.id)).toEqual(["300"])
})

test("entities decode once", () => {
  const got = extractTweets({ result: tweet("301", "amp", "use &amp;lt;b&amp;gt; for bold &amp; more") })
  expect(got[0].text).toBe("use &lt;b&gt; for bold & more")
})

test("contentHash ignores links, mentions, case and punctuation", () => {
  expect(contentHash("Hello, WORLD! @bob https://t.co/x")).toBe(contentHash("hello world"))
  expect(contentHash("hello world")).not.toBe(contentHash("hello there"))
})

test("operationName", () => {
  expect(operationName("https://x.com/i/api/graphql/abc123/HomeTimeline?variables=1")).toBe("HomeTimeline")
})
