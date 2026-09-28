/** Trimmed HomeTimeline-shaped responses, covering the shapes X actually sends. */

export const user = (handle: string, id = handle.length.toString()) => ({
  result: {
    __typename: "User",
    rest_id: `u${id}`,
    is_blue_verified: true,
    core: { screen_name: handle, name: handle.toUpperCase() },
    avatar: { image_url: `https://pbs.twimg.com/${handle}.jpg` },
    legacy: {},
  },
})

export const tweet = (id: string, handle: string, text: string, extra: Record<string, unknown> = {}) => ({
  __typename: "Tweet",
  rest_id: id,
  core: { user_results: user(handle) },
  views: { count: "1234" },
  legacy: {
    full_text: text,
    created_at: "Wed Sep 24 10:00:00 +0000 2026",
    favorite_count: 10,
    retweet_count: 2,
    reply_count: 1,
    quote_count: 0,
    bookmark_count: 3,
    lang: "en",
    conversation_id_str: id,
    entities: { urls: [] },
    ...extra,
  },
})

const entry = (content: unknown, promoted = false) => ({
  entryId: "tweet-x",
  content: {
    entryType: "TimelineTimelineItem",
    itemContent: { itemType: "TimelineTweet", tweet_results: { result: content }, ...(promoted ? { promotedMetadata: { advertiser_results: {} } } : {}) },
  },
})

export function homeTimeline() {
  const plain = {
    ...tweet("100", "alice", "Shipping a new SQLite WASM build today &amp; it is fast https://t.co/abc", {
      entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://sqlite.org/wasm", display_url: "sqlite.org/wasm" }] },
    }),
    card: {
      legacy: {
        name: "summary_large_image",
        url: "https://t.co/abc",
        binding_values: [
          { key: "title", value: { string_value: "SQLite WASM" } },
          { key: "description", value: { string_value: "SQLite compiled to WebAssembly" } },
          { key: "vanity_url", value: { string_value: "sqlite.org" } },
          { key: "card_url", value: { string_value: "https://t.co/abc" } },
          { key: "summary_photo_image_large", value: { image_value: { url: "https://pbs.twimg.com/card_img/1.jpg", width: 800, height: 419 } } },
        ],
      },
    },
  }
  const wrapped = { __typename: "TweetWithVisibilityResults", tweet: tweet("101", "bob", "Limited visibility tweet about compilers") }
  const original = tweet("102", "carol", "Retweeted original about Rust borrow checker")
  const retweet = tweet("103", "dave", "RT @carol: Retweeted original about...", { retweeted_status_result: { result: original } })
  const quoted = tweet("104", "erin", "The quoted tweet about databases")
  const quoting = { ...tweet("105", "frank", "Look at this", { quoted_status_id_str: "104" }), quoted_status_result: { result: quoted } }
  const ad = tweet("106", "brand", "Buy our product now")
  const long = {
    ...tweet("107", "gina", "Truncated…"),
    note_tweet: { note_tweet_results: { result: { text: "A very long note tweet that goes on and on about vector search", entity_set: { urls: [] } } } },
  }
  const withMedia = tweet("108", "hank", "Look at this chart https://t.co/media", {
    in_reply_to_status_id_str: "100",
    in_reply_to_screen_name: "alice",
    extended_entities: {
      media: [
        { type: "photo", url: "https://t.co/media", media_url_https: "https://pbs.twimg.com/media/x.jpg", original_info: { width: 1200, height: 800 }, ext_alt_text: "A bar chart" },
        {
          type: "video", url: "https://t.co/media", media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/v.jpg", original_info: { width: 1280, height: 720 },
          video_info: { duration_millis: 12000, variants: [
            { content_type: "application/x-mpegURL", url: "https://video.twimg.com/v.m3u8" },
            { content_type: "video/mp4", bitrate: 256000, url: "https://video.twimg.com/low.mp4" },
            { content_type: "video/mp4", bitrate: 2176000, url: "https://video.twimg.com/high.mp4" },
            { content_type: "video/mp4", bitrate: 832000, url: "https://video.twimg.com/mid.mp4" },
          ] },
        },
      ],
    },
  })
  return {
    data: {
      home: {
        home_timeline_urt: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [entry(plain), entry(wrapped), entry(retweet), entry(quoting), entry(ad, true), entry(long), entry(withMedia)],
            },
          ],
        },
      },
    },
  }
}
