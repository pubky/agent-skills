# Nexus read API (`/v0`)

Nexus is the hosted **read aggregator** for the Pubky social graph. `nexus-watcher` indexes
homeserver events into Neo4j and Redis, and `nexus-webapi` serves REST reads. **Never write to
Nexus.** Write to the author's homeserver through the SDK, and Nexus indexes it. The write/read split
and the event streams behind it are defined in
[`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read). This file covers only the `/v0`
HTTP surface.

**Which tool to use:**
- **App features** (a feed, a profile, a follower list): use this file.
- **Ad-hoc or analytical graph questions** (mutual follows, follow distance, a whole reply thread,
  tag stats): don't chain `/v0` calls. Use the [`nexus-scout` skill](../../nexus-scout/SKILL.md).
  It is a public, read-only Cypher gateway (`https://nexus-scout.pubky.app`) over the same graph,
  and it needs no account or key.

> **`/v0` is unstable.** Upstream README: *"The API is currently **unstable**. We are using the
> `/v0` route prefix while the API undergoes active development and changes. Expect potential
> breaking changes as we work toward stability."* See
> [`./shipped-vs-planned.md`](./shipped-vs-planned.md#everything-is-v0). **Check every route,
> param and shape here against the live Swagger/OpenAPI before you rely on it.** Parse responses
> defensively and keep Nexus calls behind your own adapter.

## Base URLs and source of truth

| Env | API base | Swagger UI (authoritative) |
| :-- | :-- | :-- |
| Production ("current") | `https://nexus.pubky.app/v0` | <https://nexus.pubky.app/swagger-ui/> |
| Staging ("latest") | `https://nexus.staging.pubky.app/v0` | <https://nexus.staging.pubky.app/swagger-ui/> |
| Local dev | `http://localhost:8080/v0` | `http://localhost:8080/swagger-ui` |

- **OpenAPI JSON:** `/api-docs/v0/openapi.json` covers `/v0`, and `/api-docs/static/openapi.json`
  covers media under `/static`. Both are live on prod and staging.
- **Detect features by route, not by version.** On 2026-09-17, `GET /v0/info` reported
  `nexus-webapi` `0.4.1` on prod and staging, both at commit `9e20cbff`. Upstream `main` is ahead
  of that commit but still says `0.4.1`. Look for the route in the OpenAPI JSON. Behavior you
  find only in `main` is not live.
- **Browser calls work.** CORS allows any origin, method and header. The default body limit is
  1 MiB and the default request timeout is 30 s.

Pick the base URL with an env override and fall back to hosted production (pattern from ai-kit):

```js
// Synonym-hosted Nexus; set NEXT_PUBLIC_NEXUS to use a different instance.
const NEXUS_API_BASE_URL = process.env.NEXT_PUBLIC_NEXUS ?
  `${process.env.NEXT_PUBLIC_NEXUS}/v0` :
  'https://nexus.pubky.app/v0';
```

Verified 2026-09-17 with read-only `GET /info` against production Nexus, with and without the
override. The shared testnet has no Nexus.

## ID formats (a common source of 400s)

| Param | Format |
| :-- | :-- |
| `user_id`, `author_id`, `viewer_id`, `observer_id`, `tagger_id`, `author` | `PubkyId`: the **raw 52-char z-base-32 key** (`publicKey.z32()`) |
| `post_id` | 13-char Crockford Base32 Timestamp ID, e.g. `00000039YD9DP` |
| `post_ids[]`, `post_key` | `GlobalPostId` = `"<z32>:<postId>"` |
| `resource_id` | 32-char lowercase hex |
| `{label}`, `tags` | 1–20 chars, lowercased and trimmed, no commas, colons or whitespace. `tags` is a comma list of 1–5 |
| `by_id/{prefix}` / `by_name/{prefix}` | at least 3 chars / non-empty |

**Never pass the `pubky<z32>` display form.** `GET /v0/user/pubky<z32>/details` returns
`400 {"error":"Invalid input: Validation Error: the string is not 52 utf chars"}`. Key formats are
explained in [`./concepts.md`](./concepts.md#public-key-string-formats) and post IDs in
[`./app-specs.md`](./app-specs.md#object-ids).

## Endpoint map

This is the live prod route list from 2026-09-17: 43 paths in the OpenAPI. Treat it as an
overview. The OpenAPI is the contract.

- **Info:** `GET /v0/info`
- **Bootstrap / ingest:**
  - `GET /v0/bootstrap/{user_id}` returns the sign-in payload for pre-populating a client DB
    (keys: `files, ids, indexed, notifications, posts, users`).
  - `PUT /v0/ingest/{user_id}` resolves the user's homeserver and records the user. It does
    nothing if the user is already known. It returns 200, or 403 for a blacklisted homeserver.
- **User:** `GET /v0/user/{user_id}` plus `/counts` `/details` `/tags` `/taggers/{label}`
  `/followers` `/following` `/friends` `/notifications` `/relationship/{viewer_id}`
- **Post:** `GET /v0/post/{author_id}/{post_id}` plus `/details` `/counts` `/bookmark` `/tags`
  `/taggers/{label}`
- **Stream:** `GET /v0/stream/posts`, `GET /v0/stream/posts/keys`, `POST /v0/stream/posts/by_ids`,
  `GET /v0/stream/users`, `GET /v0/stream/users/ids`, `GET /v0/stream/users/username`,
  `POST /v0/stream/users/by_ids`, `GET /v0/stream/resources`, `GET /v0/stream/resources/ids`
- **Tags:** `GET /v0/tags/hot`, `/v0/tags/taggers/{label}`, `/v0/tags/{tagger_id}/{tag_id}`
- **Search:** `GET /v0/search/users/by_name/{prefix}`, `/v0/search/users/by_id/{prefix}`,
  `/v0/search/users/by_tags`, `/v0/search/posts/by_tag/{tag}`, `/v0/search/posts/by_content`,
  `/v0/search/tags/by_prefix/{prefix}`
- **Resource:** `GET /v0/resource/{resource_id}/tags`,
  `/v0/resource/{resource_id}/tags/{label}/taggers`, `/v0/resource/by-uri?uri=<raw uri>`
- **Files:** `GET /v0/files/file/{file_id}`, `POST /v0/files/by_ids`
- **Events:** `GET /v0/events`

The only non-`GET` routes are `PUT /v0/ingest` and the `POST .../by_ids` batch reads. The batch
reads use `POST` only to carry id lists (1–100) in the body.

**These routes don't exist. Don't call them:**
- `GET /v0/feeds/global` returns 404. A KB snippet uses it, but CI only type-checks that snippet.
  Use `GET /v0/stream/posts?source=all`.
- `GET /v0/user/{id}/muted` returns 404 with an empty body.
- `/v0/post/{a}/{p}/relationships` and `/v0/stream/tags/*` exist as constants in the source but
  have no route.

**ai-kit param names that are wrong on live:**

| ai-kit | Live |
| :-- | :-- |
| `maxTags` / `maxTaggers` | `limit_tags` / `limit_taggers` |
| hot tags `maxTaggers` | `taggers_limit` |
| `reach=all` | not a valid value |
| (timeframe list) | missing `this_week` |

## Post streams: `GET /v0/stream/posts`

`source` is a discriminated enum. **If a source's required param is missing, the call returns 400.**
Live: `?source=following&limit=1` returns
`400 {"error":"Invalid input: source 'following' requires 'observer_id' parameter"}`.

| `source` | Required | Notes |
| :-- | :-- | :-- |
| `all` | — | global timeline |
| `following`, `followers`, `friends` | `observer_id` | **excludes the observer's own posts** |
| `bookmarks` | `observer_id` | |
| `author`, `author_replies` | `author_id` | |
| `post_replies` | `author_id` + `post_id` | |
| `collection` | `author_id` + `post_id` of the Collection post | curator order; **400** if you send `tags`/`kind`/`exclude_kinds`/`sorting`/`order`/`start`/`end` |
| `wot` | `observer_id` | `depth` 1–3 (default 2), and `depth=0` is invalid; excludes the observer's own posts |
| `wot_domain` | `observer_id` + `domain_tags` (max 5) | `depth` 0–3 (default 2), where `0` is the observer-only "Me" trust set; **includes** the observer's own posts when the observer is tagged with a matching label |

Other params:
- `viewer_id` personalizes the result for a viewer. `observer_id` is the user whose graph defines
  the stream.
- `tags`: a comma list of up to 5. A post matches if it has any of them.
- `kind` / `exclude_kinds` (kinds are listed in [`./app-specs.md`](./app-specs.md#pubkyapppost);
  the Nexus enum adds `unknown`):
  - `kind` is lenient: an unknown value is treated as `unknown`. `exclude_kinds` is strict: a
    comma list of 1–7, and an unknown value returns 400.
  - **Sending both returns 400.**
  - `kind` is rejected for `post_replies` and `author_replies`. `exclude_kinds` is rejected for
    `collection`, `post_replies` and `author_replies`.
  - `exclude_kinds` never drops a post whose kind is missing or unrecognized.
- `sorting`: `timeline` or `total_engagement`. Ties break by post id, so paging across equal
  scores is best-effort.
- `order`: `ascending` or `descending` (default).
- `start` / `end`: `f64` cursors, holding a timestamp or a score.
- `skip` max 10000. `limit` 1–50 (default 10).
- `include_attachment_metadata=true` adds `attachments_metadata: FileDetails[]`.

**Gotchas:**
- `source=collection` drops items that are deleted, unindexed or have a bad URI. Pages can be
  **shorter than `limit`**, and `skip`/`limit` paging shifts when posts are deleted.
- `/stream/posts/keys` is a best-effort snapshot and can point at deleted posts. To get the posts,
  call `/stream/posts` or `POST /stream/posts/by_ids`. Both drop refs they can't resolve.

`POST /v0/stream/posts/by_ids` body:
`{ post_ids: GlobalPostId[] /*1-100*/, viewer_id?, include_attachment_metadata? }`.
**An empty `post_ids` returns 400** (`post_ids: At least 1 item(s) required`), even though the
OpenAPI lists only 200/429/500 for this route.

```js
// source=following requires observer_id (400 otherwise). IDs are raw z32, never "pubky<z32>".
const userZ32 = publicKey.z32();
const res = await fetch(
  `https://nexus.pubky.app/v0/stream/posts?source=following` +
    `&observer_id=${userZ32}&viewer_id=${userZ32}&limit=20`,
);
if (!res.ok) throw new Error(`Nexus ${res.status}`);
const posts = await res.json(); // PostView-shaped objects; [] when empty
```

Verified 2026-09-17 against production Nexus (read-only). It type-checks with
`@synonymdev/pubky` 0.9.3 and returns `[]` for a new key and 20 posts for a real user.

## User streams: `GET /v0/stream/users`

| `source` | Required / optional |
| :-- | :-- |
| `followers`, `following`, `friends`, `recommended` | `user_id` required |
| `most_followed` | — |
| `influencers` | optional `user_id` (none = global). `reach` (default `wot_2`) applies only when `user_id` is set **and** `timeframe` ≠ `all_time` |
| `post_replies` | `author_id` + `post_id` |
| `starter_pack` | `tags` (1–5 interest labels) required |

`starter_pack`:
- It works for brand-new accounts.
- Users are ranked by the summed TrustRank of their taggers.
- An optional `user_id` (or `viewer_id` if `user_id` is absent) excludes that user and everyone
  they follow.
- It rejects moderation labels and `skip` > 100.

**Every other source rejects `tags` with a 400.**

Other params:
- `reach`: `followers|following|friends|wot|wot_1|wot_2|wot_3`.
- `timeframe`: `today|this_week|this_month|all_time`.
- `depth` above 3 is ignored.
- `preview=true` returns 3 random users and ignores `skip`/`limit`.
- `limit` 1–20 (default 5).

`POST /v0/stream/users/by_ids` body: `{ user_ids /*1-100*/, viewer_id?, depth? }`.

## Search

- `GET /v0/search/posts/by_content?q=`:
  - Params: `q` (2–30 chars, up to 4 terms), plus optional `author`, `kind`, `skip`
    (**max 1000**) and `limit` (1–100, default 20).
  - It returns **keys only**, `[{ post_key: "<z32>:<postId>", score }]`, in relevance order.
  - Get the full posts from `POST /stream/posts/by_ids`.
- `GET /v0/search/users/by_tags?tags=` takes 1–5 tags. Users are scored by number of taggers,
  with ties broken by user id, descending.

```js
const NEXUS = "https://nexus.pubky.app/v0";
const viewerZ32 = publicKey.z32();
const hits = await (
  await fetch(`${NEXUS}/search/posts/by_content?q=${encodeURIComponent(q)}&limit=20`)
).json();
// hits: [{ post_key: "<z32>:<postId>", score }]
let posts = [];
if (hits.length > 0) { // by_ids returns 400 for an empty post_ids
  const res = await fetch(`${NEXUS}/stream/posts/by_ids`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_ids: hits.map((h) => h.post_key), viewer_id: viewerZ32 }),
  });
  if (!res.ok) throw new Error(`Nexus ${res.status}`);
  posts = await res.json();
}
```

Verified 2026-09-17 against production Nexus (read-only). `q=bitcoin` returned 20 posts, and a
query with no hits returned `[]` without calling `by_ids`.

## Users, posts, tags, notifications

- **WoT tag filtering:**
  - Routes: `GET /v0/user/{id}`, `/user/{id}/tags`, `/user/{id}/taggers/{label}` and
    `/post/{a}/{p}/tags`.
  - They accept `depth` (1–3) **together with** `viewer_id`. `depth` without `viewer_id`, or an
    out-of-range `depth`, returns 400. `viewer_id` without `depth` gives the global view.
  - `/post/{a}/{p}/taggers/{label}` ignores `depth`.
  - For WoT post tags, `limit_tags` defaults to the whole trusted set, so trusted moderation tags
    aren't paged out.
- `/user/{id}/followers|following|friends` return arrays of z32 IDs.
- `/user/{id}/notifications`:
  - Returns `{ timestamp, body }` items. `body.type` is one of `follow, new_friend, lost_friend,
    tag_post, tag_profile, untag_post, untag_profile, reply, repost, mention, post_deleted,
    post_edited`.
  - Supports `start`/`end` and `skip`/`limit`.
- `GET /v0/stream/resources` takes `app`, `tags` (max 5, matches any), `sorting`
  (`timeline|taggers_count`) and `viewer_id`.

## Response shapes (summaries; check the Swagger schemas)

- **`PostView`** = `{ details, counts, tags, relationships, bookmark }`:
  - `details` = `{ content, id, indexed_at (ms), author (z32), kind, uri, attachments?, lock? }`,
    with `uri` = `pubky://<z32>/pub/pubky.app/posts/<id>`.
  - `counts` = `{ tags, unique_tags, replies, reposts }`.
  - `relationships` = `{ replied, reposted, mentioned[] }`.
  - `PostViewDetailed` adds `attachments_metadata` when requested. Streams return this type.
- **`UserView`** = `{ details, counts, tags, relationship, social_graph_status? }`:
  - `relationship` = `{ following, followed_by }`.
  - `counts` keys: `tagged, tags, unique_tags, posts, replies, collections, following, followers,
    friends, bookmarks`.
  - **`social_graph_status`** is `new|networked|established|null`:
    - `null` means no ranking is available, so **hide the badge**. Don't treat `null` as `new`.
    - It is **not an endorsement**. A high value means the account would be expensive to fake,
      not that it's trustworthy.

## Pagination and errors

**An out-of-range `limit`/`skip` returns 400. The server doesn't clamp it.** For example,
`limit=51` on post streams returns
`400 {"error":"Invalid input: Failed to deserialize query string: Invalid input: limit exceeds maximum of 50"}`,
and `limit=0` returns 400 with "limit must be at least 1". `skip` max is 10000 everywhere except
content search, where it is 1000. These bounds change often, so check the OpenAPI.

| Endpoint | `limit` range (default) |
| :-- | :-- |
| stream posts (+ `/keys`) | 1–50 (10) |
| stream users (+ `/ids`) | 1–20 (5) |
| stream users `/username` | 1–20 (20) |
| stream resources (+ `/ids`) | 1–100 (10) |
| user followers/following/friends | 1–200 (50) |
| notifications | 1–100 (20) |
| `limit_tags` / `limit_taggers` | 1–100 (5) |
| `taggers/{label}` | 1–100 (40) |
| `tags/hot` | `limit` 1–40 (40), `taggers_limit` 1–20 (20) |
| `tags/taggers/{label}` | 1–20 (20) |
| search users by_name/by_id | 1–200 (50) |
| search users by_tags | 1–200 (20) |
| search posts by_tag | 1–200 (20) |
| search posts by_content | 1–100 (20) |
| search tags by_prefix | 1–100 (20) |
| events | 1–1000 (500) |

| Status | Body | Meaning |
| :-- | :-- | :-- |
| 400 | JSON `{"error": "..."}` | invalid input |
| 403 | JSON | e.g. ingest for a user on a blacklisted homeserver |
| 404 | JSON | user/post/file/tag/resource not found. **Treat it as "not indexed yet" and return `null`.** Empty streams are `200 []` |
| 404 | **empty, no content-type** | unrouted path (a bug in your code) |
| 408 | — | request timeout |
| 413 | — | body too large |
| 429 | **empty** + `Retry-After` (seconds) | rate limited |
| 500 | JSON | internal error |
| 503 | JSON | media load shedding. **Unreleased: only on `main`, not deployed to `nexus.pubky.app` as of commit `9e20cbff`** |

**Rate limits** (per IP; every route documents 429). Upstream's default config has two buckets:
- **expensive** (20/min, burst 5):
  - `GET stream/users`, `POST stream/users/by_ids`, `POST stream/posts/by_ids`, `tags/hot`,
    `search/posts/by_content`, `search/users/by_tags`, `POST files/by_ids`, `bootstrap`.
  - Media: `GET /static/files/{owner_id}/{file_id}/{variant}` and `GET /static/avatar/{user_id}`.
    **Image and avatar loads share this 20/min bucket**, so a feed UI that loads media in bulk
    will hit it first.
- **default** (300/min, burst 50): everything else, including the legacy
  `/static/files/{owner_id}/{file_id}`.

Upstream's default config turns rate limiting off, and the source doesn't show whether the hosted
instance turns it on. **Handle 429 anyway.**

Don't assume every error body is JSON. Tell data 404s apart from route 404s:

```js
async function nexusGet(url) {
  const res = await fetch(url);
  if (res.ok) return res.json(); // JSON routes only: /v0/events is text/plain
  const isJson = res.headers.get("content-type")?.includes("application/json");
  if (res.status === 404 && isJson) return null; // not found / not indexed yet
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1"); // body is empty
    throw Object.assign(new Error("Nexus rate limited"), { retryAfter });
  }
  const detail = isJson ? (await res.json()).error : await res.text();
  throw new Error(`Nexus ${res.status}: ${detail || "(empty body: unrouted path?)"}`);
}
```

Verified 2026-09-17 against production Nexus (read-only):
- `/info` returned an object.
- An unknown user returned `null`.
- `/feeds/global` threw `Nexus 404: (empty body: unrouted path?)`.
- A missing `observer_id` threw the JSON 400 message.
- The 429 branch was checked against upstream `rate_limit.rs` (empty body, `Retry-After`) but not
  triggered live.

## Files and media

- **Metadata:** `GET /v0/files/file/{file_id}`:
  - `file_id` is the **URL-encoded pubky file URI**:
    `encodeURIComponent("pubky://<z32>/pub/pubky.app/files/<id>")`.
  - A malformed URI returns 400, and a missing file returns 404.
  - Batch: `POST /v0/files/by_ids` with `{ "uris": [...] }` (1–100).
- `FileDetails` = `{ id, uri, owner_id, indexed_at, created_at, src, name, size, content_type,
  urls, metadata }`. In the live sample `created_at` was in microseconds. `src` is a
  `pubky://.../blobs/<id>` URI.
- **Gotcha: `urls` is a JSON-encoded string.** The OpenAPI says it's an object
  `{ main, feed?, small? }`, but the server sends a string. Handle both. The values are relative
  paths: `<owner_id>/<file_id>/<variant>`.
- **Bytes are served under `/static`, not `/v0`:**
  - `GET /static/files/{owner_id}/{file_id}/{variant}`. Add `?dl` for
    `Content-Disposition: attachment`.
  - `GET /static/avatar/{user_id}` (live: `image/webp`).
  - `GET /static/files/{owner_id}/{file_id}` is **legacy** and redirects to the variant path.
    Don't build new URLs with it.
  - Media URL = `<nexus>/static/files/` + a `urls` value.
- **`/v0/info` `base_file_url` is a server filesystem path** (e.g. `/home/pubky/static/files`),
  not a URL.

```js
// Adapted from pubky-app src/core/application/file/file.ts (types stripped).
let urls;
try {
  urls = typeof file.urls === "string" ? JSON.parse(file.urls) : file.urls;
} catch {
  console.warn("Ignoring file metadata with malformed URL JSON", file.id);
  urls = null;
}
const small = urls?.small && `https://nexus.pubky.app/static/files/${urls.small}`;
```

Verified 2026-09-17 against production Nexus (read-only). `urls` came back as a string, and the
built `small` URL returned 200 `image/webp`.

## Events feed (plain text)

`GET /v0/events?cursor=<n>&limit=<1-1000>` returns **`text/plain`, not JSON**, so don't pass it
through `nexusGet`:
- Each line is `PUT pubky://<pk>/<path>` or `DEL pubky://<pk>/<path>`.
- The last line is always `cursor: <n>`.
- A cursor past the end returns only the `cursor:` line.
- The OpenAPI marks `cursor` as required, but the server accepts a request without it and starts
  from the beginning.

This is Nexus re-serving the homeserver event stream. The native homeserver endpoints are in
[`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read).

```js
const res = await fetch("https://nexus.pubky.app/v0/events?cursor=0&limit=500");
const lines = (await res.text()).trimEnd().split("\n");
const nextCursor = lines.at(-1)?.replace("cursor: ", "");
const events = lines.slice(0, -1); // "PUT pubky://..." | "DEL pubky://..."
```

Verified 2026-09-17 against production Nexus (read-only), on a full page and on the empty page
past the end.

## Upstream references

- Swagger (source of truth): <https://nexus.pubky.app/swagger-ui/> (staging:
  <https://nexus.staging.pubky.app/swagger-ui/>)
- OpenAPI: <https://nexus.pubky.app/api-docs/v0/openapi.json>,
  <https://nexus.pubky.app/api-docs/static/openapi.json>
- Repo: <https://github.com/pubky/pubky-nexus>. Docs:
  <https://pubky.org/explore/pubky-apps/indexing-and-aggregation/pubky-nexus/>
- Ad-hoc graph queries: [`nexus-scout` skill](../../nexus-scout/SKILL.md)
- Canonical Pubky concepts: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read),
  [`./app-specs.md`](./app-specs.md),
  [`./shipped-vs-planned.md`](./shipped-vs-planned.md#everything-is-v0)
