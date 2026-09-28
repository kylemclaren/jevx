import { beforeEach, expect, test } from "bun:test"
import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import { extractFromRelay, type RelaySource } from "../src/lib/extract"
import { Store } from "../src/lib/store"

/** A normalized store shaped like x.com's (2026) Relay records. */
function relay(records: Record<string, Record<string, unknown>>): RelaySource {
  return { getRecordIDs: () => Object.keys(records), get: (id) => records[id] }
}

const user = (id: string, handle: string) => ({
  [`User:${id}`]: { __typename: "User", rest_id: id, core: { __ref: `User:${id}:core` }, avatar: { __ref: `User:${id}:avatar` }, verification: { __ref: `User:${id}:v` } },
  [`User:${id}:core`]: { __typename: "UserCore", name: handle.toUpperCase(), screen_name: handle },
  [`User:${id}:avatar`]: { __typename: "UserAvatar", image_url: `https://pbs.twimg.com/profile_images/${id}_normal.jpg` },
  [`User:${id}:v`]: { __typename: "UserVerification", is_blue_verified: true, verified: false },
  [`UserResults:${id}`]: { __typename: "UserResults", result: { __ref: `User:${id}` } },
})

const tweet = (id: string, userId: string, text: string, extra: Record<string, unknown> = {}) => ({
  [`Tweet:${id}`]: {
    __typename: "Tweet", rest_id: id,
    core: { __ref: `Tweet:${id}:core` }, counts: { __ref: `Tweet:${id}:counts` }, views: { __ref: `Tweet:${id}:views` },
    details: { __ref: `Tweet:${id}:details` }, legacy: { __ref: `Tweet:${id}:legacy` },
    media_entities2: { __refs: [] }, url_entities: { __refs: [] }, note_tweet: null, reply_to_results: null, reply_to_user_results: null, quoted_tweet_results: null,
    ...extra,
  },
  [`Tweet:${id}:core`]: { __typename: "TweetCore", user_results: { __ref: `UserResults:${userId}` } },
  [`Tweet:${id}:counts`]: { __typename: "ApiCounts", reply_count: 1, retweet_count: 2, favorite_count: 30, quote_count: 0, bookmark_count: 4 },
  [`Tweet:${id}:views`]: { __typename: "ViewCountInfo", count: "1234" },
  [`Tweet:${id}:details`]: { __typename: "TBirdData", full_text: text, display_text_range: [0, [...text].length], created_at_ms: 1790357367000 },
  [`Tweet:${id}:legacy`]: { __typename: "LegacyTweet", retweeted_status_results: null, lang: "en" },
  [`TweetResults:${id}`]: { __typename: "TweetResults", result: { __ref: `Tweet:${id}` } },
})

test("reads tweets, media, ads, retweets, replies and quotes out of the Relay store", () => {
  const records = {
    ...user("1", "alice"), ...user("2", "bob"), ...user("3", "carol"),
    ...tweet("100", "1", "Shipping today https://t.co/media", {
      details: { __ref: "Tweet:100:details" },
      media_entities2: { __refs: ["Tweet:100:m0"] },
    }),
    "Tweet:100:details": { __typename: "TBirdData", full_text: "Shipping today https://t.co/media", display_text_range: [0, 14], created_at_ms: 1790357367000 },
    "Tweet:100:m0": { __typename: "ApiMediaEntity", type: "photo", media_url_https: "https://pbs.twimg.com/media/x.jpg", original_info: { __ref: "Tweet:100:m0:oi" }, ext_alt_text: "a chart" },
    "Tweet:100:m0:oi": { __typename: "ApiMediaEntityOriginalInfo", width: 2048, height: 1177 },
    ...tweet("101", "2", "Buy our thing"),
    "TimelineTweet:ad": { __typename: "TimelineTweet", tweet_results: { __ref: "TweetResults:101" }, promoted_metadata: { __ref: "promo" } },
    promo: { __typename: "PromotedMetadata", advertiser_results: null },
    ...tweet("102", "3", "Yup", { quoted_tweet_results: { __ref: "TweetResults:100" }, reply_to_results: { __ref: "TweetResults:100" }, reply_to_user_results: { __ref: "UserResults:1" } }),
    // A retweet: bob reposts alice's tweet.
    ...tweet("103", "2", "RT @alice: Shipping today"),
    "Tweet:103:legacy": { __typename: "LegacyTweet", retweeted_status_results: { __ref: "TweetResults:100" } },
    // A partial record, as the page holds for quote-of-quote stubs: no text yet.
    "Tweet:104": { __typename: "Tweet", rest_id: "104", core: { __ref: "Tweet:104:core" } },
    "Tweet:104:core": { __typename: "TweetCore", user_results: { __ref: "UserResults:3" } },
  }
  const tweets = Object.fromEntries(extractFromRelay(relay(records)).map((t) => [t.id, t]))
  expect(Object.keys(tweets).sort()).toEqual(["100", "101", "102"])
  // The display range drops the trailing media link; media keeps sizes and alt text.
  expect(tweets["100"].text).toBe("Shipping today")
  expect(tweets["100"]).toMatchObject({ handle: "alice", name: "ALICE", verified: true, likes: 30, views: 1234, createdAt: 1790357367000, via: "bob" })
  expect(tweets["100"].media[0]).toMatchObject({ type: "photo", width: 2048, height: 1177, alt: "a chart" })
  expect(tweets["101"].promoted).toBe(true)
  expect(tweets["100"].promoted).toBe(false)
  expect(tweets["102"]).toMatchObject({ quotedId: "100", inReplyTo: "100", replyTo: "alice" })
})

test("the only() filter reads just the given records", () => {
  const records = { ...user("1", "alice"), ...tweet("100", "1", "one"), ...tweet("200", "1", "two") }
  expect(extractFromRelay(relay(records), (id) => id === "Tweet:200").map((t) => t.id)).toEqual(["200"])
})

const sqlite3 = await sqlite3InitModule()
let store: Store
beforeEach(() => {
  store = new Store(new sqlite3.oo1.DB(":memory:", "c"))
})
const mk = (id: string, extra: Record<string, unknown> = {}) => ({
  id, authorId: "a", handle: "a", name: "a", verified: false, text: `tweet number ${id} with enough words`, createdAt: Number(id),
  likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: 0, media: [], urls: [], promoted: false, ...extra,
})

test("on-screen sightings move tweets to the top of Last seen", () => {
  store.ingest([mk("1"), mk("2"), mk("3")], "relay", 1_000_000)
  expect(store.touchSeen(["1"], 5_000_000)).toBe(1)
  store.touchSeen(["1"], 5_010_000) // same minute: no extra count
  const [first] = store.list({ sort: "lastSeen" }).tweets
  expect(first).toMatchObject({ id: "1", lastSeen: 5_010_000, seenCount: 2 })
})

test("hide replies", () => {
  store.ingest([mk("1"), mk("2", { inReplyTo: "1", replyTo: "a" }), mk("3", { replyTo: "b" })], "relay")
  expect(store.list({ hideReplies: true }).tweets.map((t) => t.id)).toEqual(["1"])
  expect(store.list({}).total).toBe(3)
})
