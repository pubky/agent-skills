# Nexus read API (`/v0`)

Nexus is the hosted **read aggregator** for the Pubky social graph. `nexus-watcher` indexes
homeserver events into the graph (Neo4j) and the cache (Redis). `nexus-webapi` serves REST reads.
**Never write to Nexus.** Write to the author's homeserver through the SDK, and Nexus indexes it.
[`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read) defines the write/read split and
the event streams behind it. This file covers only the `/v0` HTTP surface.

**Which tool to use:**
- **App features** (a feed, a profile, a follower list, search): use this file.
- **Ad-hoc or analytical graph questions** (mutual follows, follow distance, a whole reply thread,
  tag stats): don't chain `/v0` calls. Use the [`nexus-scout` skill](../../nexus-scout/SKILL.md)
  instead. It is a public, read-only Cypher gateway at `https://nexus-scout.pubky.app`
  (`POST /v1/query {cypher, params?, limit?}` or `GET /v1/query?cypher=`). It needs no account or
  key. It reads a periodically refreshed replica, so its results can lag behind `/v0`.

> **`/v0` is unstable.** The upstream README says: *"The API is currently **unstable**. We are using
> the `/v0` route prefix while the API undergoes active development and changes. Expect potential
> breaking changes as we work toward stability."* See
> [`./shipped-vs-planned.md`](./shipped-vs-planned.md#everything-is-v0).
> Between 2026-09-17 and 2026-11-12 the live API gained a stream source, search params, `deleted`
> flags, a media variant, a count field, the `locked` post-stream filter, the notification `types`
> filter, `tag_uri`, `epoch` and documented 400 responses. It reported version `0.4.1` the whole
> time. **Check every route, param and shape here against the live Swagger/OpenAPI before you rely
> on it.** Parse responses defensively, and keep Nexus calls behind your own adapter.

## Base URLs and source of truth

| Env | API base | Swagger UI (authoritative) |
| :-- | :-- | :-- |
| Production ("current") | `https://nexus.pubky.app/v0` | <https://nexus.pubky.app/swagger-ui/> |
| Staging ("latest") | `https://nexus.staging.pubky.app/v0` | <https://nexus.staging.pubky.app/swagger-ui/> |
| Local dev | `http://localhost:8080/v0` | `http://localhost:8080/swagger-ui` |

- **OpenAPI JSON:** `/api-docs/v0/openapi.json` covers `/v0` (43 paths), and
  `/api-docs/static/openapi.json` covers media under `/static`. On 2026-11-12, prod and staging
  served a byte-identical `/v0` document.
- **Detect features by route or param, not by version.** On 2026-11-12, `GET /v0/info` reported
  `nexus-webapi` `0.4.1` on prod and staging, at commit `fc030621` (2026-11-03). Upstream `main`
  was 3 commits ahead, none of them API-visible. To check for a feature, look for its route or
  param in the OpenAPI JSON. Before you code against anything that exists only in upstream `main`,
  compare the `/v0/info` `commit_hash`.
- **Browser calls work.** Responses carry `access-control-allow-origin: *`. The default body limit
  is 1 MiB, and the default request timeout is 30 s.
- **Local Nexus:** the local `pubky-docker` stack runs one on `:8080`. See the
  [`pubky-infra` local-stack reference](../../pubky-infra/references/local-stack.md).

Read the base URL from an env override, and fall back to hosted production. This pattern comes
from ai-kit:

```js
// Synonym-hosted Nexus; set NEXT_PUBLIC_NEXUS to use a different instance.
const NEXUS_API_BASE_URL = process.env.NEXT_PUBLIC_NEXUS ?
  `${process.env.NEXT_PUBLIC_NEXUS}/v0` :
  'https://nexus.pubky.app/v0';
```

Verified on 2026-11-12 (Node). With the env var unset, the snippet gave the production base, and
`GET <base>/info` returned 200. With it set, the snippet gave `<override>/v0`.

**A missing result can mean "not indexed" rather than "absent".** Nexus returns only what this
instance has indexed, and indexing takes time. The primary homeserver is bulk-indexed. Users on
third-party homeservers are indexed one at a time after PKDNS resolution. Upstream
[`docs/decentralization.md`](https://github.com/pubky/pubky-nexus/blob/main/docs/decentralization.md)
has the full coverage rules, and the
[`pubky-infra` skill](../../pubky-infra/references/nexus-operations.md) has operator detail.

## ID formats (a common source of 400s)

| Param | Format |
| :-- | :-- |
| `user_id`, `author_id`, `viewer_id`, `observer_id`, `tagger_id`, `author` | `PubkyId`: the **raw 52-char z-base-32 key** (`publicKey.z32()`) |
| `post_id` | 13-char Crockford Base32 Timestamp ID, e.g. `00000039YD9DP` |
| `post_ids[]`, `post_key` | `GlobalPostId` = `"<z32>:<postId>"` |
| `resource_id` | 32-char lowercase hex |
| `{label}`, `tags` | 1–20 chars, lowercased and trimmed, with no commas, colons or whitespace. `tags` is a comma list of 1–5 labels |
| `by_id/{prefix}` / `by_name/{prefix}` | at least 3 chars / non-empty |

**Never pass the `pubky<z32>` display form.** Each bad input fails in its own way:

| Input | Response |
| :-- | :-- |
| `pubky<z32>` display form | `400 {"error":"Invalid input: Validation Error: the string is not 52 utf chars"}` |
| 52 chars, not a valid Ed25519 point | `400 {"error":"Invalid input: Validation Error: Invalid Ed25519 publickey; Cannot decompress Edwards point"}` |
| Valid key, not indexed | `404` JSON `{"error":"User not found: <z32>"}` |

Key formats: [`./concepts.md`](./concepts.md#public-key-string-formats). Post IDs:
[`./app-specs.md`](./app-specs.md#object-ids).

## Endpoint map

An overview of the live routes (43 paths as of 2026-11-12, the same set as on 2026-09-17). The
OpenAPI is the contract.

- **Info:** `GET /v0/info`
- **Bootstrap / ingest:**
  - `GET /v0/bootstrap/{user_id}` returns the sign-in payload for pre-populating a client DB. Its
    keys are `files, ids, indexed, notifications, posts, users`.
  - `PUT /v0/ingest/{user_id}` resolves the user's homeserver and records the user. If Nexus
    already knows the user, the call does nothing. It returns 200, or 403 if the homeserver is
    blacklisted.
- **User:** `GET /v0/user/{user_id}`, plus `/counts` `/details` `/tags` `/taggers/{label}`
  `/followers` `/following` `/friends` `/notifications` `/relationship/{viewer_id}`
- **Post:** `GET /v0/post/{author_id}/{post_id}`, plus `/details` `/counts` `/bookmark` `/tags`
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

Every route is a `GET` except `PUT /v0/ingest` and the `POST .../by_ids` batch reads. The batch
reads use `POST` only so they can carry an id list (1–100 ids) in the body.

**Don't call these routes. They don't exist:**
- `GET /v0/feeds/global` returns 404 with an empty body. For the global feed, use
  `GET /v0/stream/posts` (see below).
- `GET /v0/user/{id}/muted` returns 404 with an empty body.

**Some ai-kit (`pubky-dev-context.md`) param names are wrong on live.** Live Nexus silently ignores
unknown query params and returns 200, so a wrong name raises no error. It just has no effect:

| ai-kit | Live |
| :-- | :-- |
| `maxTags` / `maxTaggers` | `limit_tags` / `limit_taggers` |
| hot tags `maxTaggers` | `taggers_limit` |
| `reach: 'all'` | 400: ``Invalid input: Failed to deserialize query string: reach: unknown variant `all`, expected one of `followers`, `following`, `friends`, `wot`, `wot_1`, `wot_2`, `wot_3` `` |
| timeframe list | missing `this_week` |
| `GET /user/{id}/muted` | 404 |

## Post streams: `GET /v0/stream/posts`

This global-feed snippet is CI-verified, from `pubky-knowledge-base-v2`
`snippets/js/src/developer-guide.ts`. Without a `source` param, the stream defaults to `all` with
`sorting=timeline`:

```js
const response = await fetch(
  "https://nexus.pubky.app/v0/stream/posts?limit=10",
);
const posts = await response.json();
```

Verified 2026-11-12 against production Nexus: it returned 10 `PostView` objects.

`source` is a discriminated enum. **If you omit a source's required param, the call returns 400.**
For example, `?source=following` without `observer_id` returns
`400 {"error":"Invalid input: source 'following' requires 'observer_id' parameter"}`.

| `source` | Required | Notes |
| :-- | :-- | :-- |
| `all` (default) | — | Global timeline |
| `following`, `followers`, `friends` | `observer_id` | **Excludes the observer's own posts** |
| `bookmarks` | `observer_id` | |
| `author`, `author_replies` | `author_id` | |
| `post_replies` | `author_id` + `post_id` | |
| `collection` | `author_id` + `post_id` of the Collection post | Curator order. **400** if you send `tags`/`kind`/`exclude_kinds`/`locked`/`sorting`/`order`/`start`/`end` |
| `post_collections` | `author_id` + `post_id` of **any** post | The Collection posts that contain it, newest first. **400** on `kind`/`exclude_kinds`/`locked` |
| `wot` | `observer_id` | `depth` 1–3 (default 2). `depth=0` is invalid. Excludes the observer, even through follow cycles |
| `wot_domain` | `observer_id` + `domain_tags` (max 5) | `depth` 0–3 (default 2). `0` is the observer-only "Me" trust set. Returns every post by authors the WoT has tagged. Add `tags=` to scope results to a topic. **Includes** the observer's own posts if the observer carries a matching label |

Other params:
- `viewer_id` personalizes the result for a viewer. `observer_id` is the user whose graph defines
  the stream.
- `tags` is a comma list of up to 5 labels. A post matches if it has any of them.
- `kind` / `exclude_kinds` take the kinds listed in [`./app-specs.md`](./app-specs.md#pubkyapppost):
  `short, long, image, video, link, file, collection`. The Nexus enum adds `unknown`.
  - **Sending both returns 400.**
  - `exclude_kinds` is strict. It takes a comma list of 1–7 kinds, and an unknown value returns 400.
  - `post_collections`, `post_replies` and `author_replies` reject `kind`. `collection`,
    `post_collections`, `post_replies` and `author_replies` reject `exclude_kinds`.
  - `exclude_kinds` never drops a post whose kind is missing or unrecognized.
- `locked=true` keeps only posts that have a `lock` set (see [Locked posts](#locked-posts-locked)).
  `false` (default) applies no filter.
- `sorting` is `timeline` (default) or `total_engagement`. Ties are broken by post id, so paging
  through equal scores is best-effort.
- `order` is `ascending` or `descending` (default).
- `start` / `end` are `f64` cursors that hold a timestamp or a score.
- `skip` max 10000. `limit` 1–50 (default 10). `limit=51` returns
  `400 {"error":"Invalid input: Failed to deserialize query string: Invalid input: limit exceeds maximum of 50"}`.
- `include_attachment_metadata=true` adds `attachments_metadata: FileDetails[]`.

**Gotchas:**
- `source=collection` drops items that are deleted, unindexed or have a bad URI. A page can be
  **shorter than `limit`**, and `skip`/`limit` paging shifts when posts are deleted.
- `source=post_collections` links are materialized when the Collection is written. If an item is
  indexed **after** the Collection that lists it, the link won't exist until someone edits the
  Collection. An empty result doesn't prove the post is in no Collection.
- `/stream/posts/keys` is a best-effort snapshot and can point at deleted posts. To get the posts,
  call `/stream/posts` or `POST /stream/posts/by_ids`. Both drop any ref they can't resolve.
- **The global feed may hide unranked authors.** The deployed code has a
  `[features] hide_unranked_authors` switch. When it is on, the OpenAPI says posts by authors
  outside the trust ranking are left out of `source=all` (any sorting, tags or kind). Sending
  `viewer_id` with `source=all`, `sorting=timeline` and no `tags` brings back the viewer's own
  posts. Upstream defaults the switch to `false`, but no public source says how the hosted
  instance sets it. **Don't treat a post missing from `all` as proof that it isn't indexed.** Fetch
  it by id, and send `viewer_id` so users see their own new posts.

To find which Collections contain a post (Collection model:
[`./app-specs.md`](./app-specs.md#collection-posts-kind-collection)):

```js
// author_id + post_id of ANY post; returns the Collection posts that list it (newest first)
const res = await fetch(
  `https://nexus.pubky.app/v0/stream/posts?source=post_collections` +
    `&author_id=${authorZ32}&post_id=${postId}&limit=10`,
);
if (!res.ok) throw new Error(`Nexus ${res.status}`);
const collections = await res.json(); // PostView[] with details.kind === "collection"
```

Verified 2026-11-12 against production Nexus (read-only): it returned the one Collection that
contains the post. Without `author_id`, the call returns
`400 "source 'post_collections' requires 'author_id' parameter"`.

The `POST /v0/stream/posts/by_ids` body is
`{ post_ids: GlobalPostId[] /*1-100*/, viewer_id?, include_attachment_metadata? }`.
**An empty `post_ids` returns 400** (`post_ids: At least 1 item(s) required`). The OpenAPI lists
200/400/429/500 for this route.

### Locked posts (`locked`)

`locked=true` on `GET /v0/stream/posts` and `GET /v0/stream/posts/keys` returns only posts whose
`details.lock` is set. It matches **every** locked post, whoever the viewer is and whether or not
they unlocked it. It doesn't tell you what a viewer can read.

```js
const NEXUS = "https://nexus.pubky.app/v0";
// locked=true keeps only posts whose details.lock is set (any kind, any viewer).
// Don't combine with kind/exclude_kinds (400); rejected for collection,
// post_collections, post_replies and author_replies sources.
const res = await fetch(`${NEXUS}/stream/posts?locked=true&limit=10`);
if (!res.ok) throw new Error(`Nexus ${res.status}: ${(await res.json()).error}`);
const lockedPosts = await res.json(); // PostView[]; every details.lock is a pubky:// URL
```

Verified 2026-11-12 against production Nexus (read-only, Node 24): it returned 10 posts, each with
`details.lock` set. Every 400 in the table below was probed live. The error path assumes a JSON
body, so a 429 (empty body) throws a `SyntaxError` there. Use `nexusGet` (below) in real code.

- **Replies are left out**, except with `source=bookmarks`, which keeps locked replies. Every other
  source returns parent posts only.
- Upstream tests cover `locked` with the sources `all`, `author`, `following` and `bookmarks`, with
  `sorting=total_engagement`, with `skip`/`limit` and with `viewer_id`. Like `kind`, it is served
  from the graph rather than the Redis cache.
- Send the literal `true` or `false`. These are the 400s it can return:

  | Request | `error` |
  | :-- | :-- |
  | `locked=true` + `kind` or `exclude_kinds` | ``Invalid input: `locked` cannot be combined with `kind` or `exclude_kinds` `` |
  | `source=post_replies` or `author_replies` | ``Invalid input: `kind`, `exclude_kinds` and `locked` are not supported with `source=post_replies` or `source=author_replies` `` |
  | `source=post_collections` | ``Invalid input: `kind`, `exclude_kinds` and `locked` are not supported with `source=post_collections` `` |
  | `source=collection` | ``Invalid input: `locked` is not supported with `source=collection` `` |
  | `locked=yes` | ``Invalid input: Failed to deserialize query string: locked: provided string was not `true` or `false` `` |

- **A locked post is not private or encrypted.** `lock` is only a schema field, and the post body
  is public. The lock convention pubky.app uses (a lock file URL and teaser `content`) and the
  `/priv` caveats are in [`./app-specs.md`](./app-specs.md#lock-optional-since-060). Read that
  before you render or describe locked posts.

## User streams: `GET /v0/stream/users`

| `source` | Required / optional |
| :-- | :-- |
| `followers`, `following`, `friends`, `recommended` | `user_id` required |
| `most_followed` | — |
| `influencers` | Optional `user_id` (omit it for global). `reach` (default `wot_2`) applies only when `user_id` is set **and** `timeframe` ≠ `all_time` |
| `post_replies` | `author_id` + `post_id` |
| `starter_pack` | `tags` (1–5 interest labels) required |

**`most_followed` lags.** A scheduled job rebuilds it from graph follower counts, once a day at
04:06 UTC in upstream's default config. Follows and unfollows don't update it directly, so a new
follow can take up to a day to show up.

`starter_pack`:
- Works for brand-new accounts.
- Ranks users by the summed TrustRank of their taggers (profile or post tags). Each label is ranked
  separately, and the results are interleaved in the order you gave the labels.
- An optional `user_id` excludes that user and everyone they follow. If `user_id` is absent,
  `viewer_id` does the same. An unindexed id excludes nothing.
- `timeframe` keeps only candidates who posted in that window.
- Rejects moderation labels and `skip` > 100.

**Every other source rejects `tags` with a 400.**

**Global `influencers` also caps `skip` at 100** when `timeframe` ≠ `all_time`:
`400 "Invalid input: skip must be at most 100 for source 'influencers' without user_id and a timeframe other than 'all_time'"`.

Other params:
- `reach`: `followers|following|friends|wot|wot_1|wot_2|wot_3`.
- `timeframe`: `today|this_week|this_month|all_time`.
- `depth` above 3 is ignored.
- `preview=true` returns 3 random users and ignores `skip`/`limit`.
- `limit` 1–20 (default 5).

The `POST /v0/stream/users/by_ids` body is `{ user_ids /*1-100*/, viewer_id?, depth? }`.

## Search

Every post search returns **keys only**: `[{ post_key: "<z32>:<postId>", score }]`. To get the full
posts, pass the keys to `POST /stream/posts/by_ids`.

| Route | Params | Returns |
| :-- | :-- | :-- |
| `GET /v0/search/posts/by_content` | `q` (2–30 chars, up to 4 terms), `author`, `kind`, `user_id`+`reach`, `skip` (**max 1000**), `limit` 1–100 (20) | `[{post_key, score}]`, in relevance order |
| `GET /v0/search/posts/by_tag/{tag}` | `sorting`, `user_id`+`reach`, `start`/`end`, `skip` (max 10000), `limit` 1–200 (20) | `[{post_key, score}]` |
| `GET /v0/search/users/by_tags` | `tags` (1–5, any match), `user_id`+`reach`, `skip` (max 10000), `limit` 1–200 (20) | `[{user_id, score}]`. The score is the number of taggers. Ties sort by user id, descending |

**Reach-scoped search.** `reach` is `followers|following|friends|wot|wot_1|wot_2|wot_3`, and bare
`wot` means depth 2.
- **Send `user_id` and `reach` together.** Either one alone returns
  `400 {"error":"Invalid input: user_id and reach should be both provided together"}`.
- Results never include `user_id` itself or its posts.
- `by_content` with `author` returns that author's posts if the author is in reach. Otherwise it
  returns an empty list.
- In reach mode, `by_tag` returns only parent posts, never replies. Its `total_engagement` score
  then counts taggers, replies and reposts, but not mentions. **`start`/`end` cursors from reach
  mode don't work in non-reach mode, and vice versa.**
- In reach mode, `users/by_tags` keeps the global scores and filters out users who are not in reach.

```js
const NEXUS = "https://nexus.pubky.app/v0";
const meZ32 = publicKey.z32(); // raw z32, never "pubky<z32>"
// user_id and reach must be sent together (400 otherwise); results never include meZ32's own posts
const searchRes = await fetch(
  `${NEXUS}/search/posts/by_content?q=${encodeURIComponent(q)}` +
    `&user_id=${meZ32}&reach=following&limit=20`,
);
if (!searchRes.ok) throw new Error(`Nexus ${searchRes.status}`);
const hits = await searchRes.json(); // [{ post_key: "<z32>:<postId>", score }]
let posts = [];
if (hits.length > 0) { // by_ids returns 400 for an empty post_ids
  const res = await fetch(`${NEXUS}/stream/posts/by_ids`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ post_ids: hits.map((h) => h.post_key), viewer_id: meZ32 }),
  });
  if (!res.ok) throw new Error(`Nexus ${res.status}`);
  posts = await res.json();
}
```

Verified 2026-11-12 against production Nexus (read-only, `@synonymdev/pubky` 0.12.0 `PublicKey`).
It returned 20 hits, none of them by the searcher, and resolved all 20 to `PostView`s. Sending
`user_id` without `reach` returned 400, and so did an empty `post_ids`. The `searchRes.ok` check was
added after that run, so a 400 or 429 throws instead of being read as "no hits". For a global
search, drop `user_id`/`reach`.

## Users, posts, tags, notifications

- **WoT tag filtering:**
  - Applies to `GET /v0/user/{id}`, `/user/{id}/tags`, `/user/{id}/taggers/{label}` and
    `/post/{a}/{p}/tags`.
  - These routes accept `depth` (1–3) **only together with** `viewer_id`. `depth` without
    `viewer_id` returns ``400 {"error":"Invalid input: `depth` requires `viewer_id`"}``.
    `viewer_id` without `depth` returns the global view.
- `/user/{id}/followers|following|friends` return arrays of z32 IDs.
- `/user/{id}/notifications`:
  - Returns `{ timestamp, body }` items. As of 2026-11-12, `body.type` is one of `follow,
    new_friend, lost_friend, tag_post, tag_profile, untag_post, untag_profile, reply, repost,
    mention, post_deleted, post_edited`. Don't fail on unknown types.
  - `post_deleted` / `post_edited` carry `delete_source` / `edit_source`
    (`reply|repost|bookmark|reply_parent|repost_embed|tagged_post`), plus `linked_uri` and
    `post_kind`.
  - Supports `start`/`end` and `skip`/`limit`.
  - **`types` filter:** a comma list of 1–12 of the types above (duplicates are ignored). An
    unknown value returns
    `400 "Invalid input: Failed to deserialize query string: types: unknown notification type: bogus"`.
    With `types`, `skip`/`limit` count matching notifications only.
  - **A filtered page can be short or empty before the history ends.** Each request scans at most
    10,000 notifications. If it hits that cap before the page fills, the response carries an
    **`X-Next-Start`** header (int64): send it as `start` on the next request. If the header is
    absent, the page is full or the history has been read to the end. Don't stop paging on an
    empty page while `X-Next-Start` is present. CORS exposes the header, so browsers can read it.

## Response shapes (summaries; check the Swagger schemas)

- **`PostView`** = `{ details, counts, tags, relationships, bookmark? }`:
  - `details`: required `{ content, id, indexed_at (ms), author (z32), kind, uri }`, plus
    `attachments?`, `lock?` (a `pubky://` URL, or `null` when the post isn't locked) and `deleted`
    (bool). `uri` = `pubky://<z32>/pub/pubky.app/posts/<id>`.
  - **`lock`:** the OpenAPI calls it the lock server's URL, but on live pubky.app posts it points at
    the creator's lock file, `pubky://<z32>/pub/app.locks/<lockId>.json`. See
    [`./app-specs.md`](./app-specs.md#lock-optional-since-060) for what that means.
  - `counts` = `{ tags, unique_tags, replies, reposts, collections }`. `collections` is the number
    of Collections that contain the post. If it's absent, treat it as `0`.
  - `relationships` = `{ mentioned: z32[], replied?: uri|null, reposted?: uri|null }`.
    `mentioned` holds raw z32 user IDs. Only `replied` and `reposted` are `pubky://` URIs.
  - `tags[]` = `TagDetails { label, taggers[], taggers_count, relationship?, tag_uri? }`.
    `tag_uri` (`string|null`) is the address of the **viewer's** tag file for this label, so it
    needs `viewer_id`. `relationship` is `true` exactly when `tag_uri` is set.
  - `PostViewDetailed` adds `attachments_metadata` when you request it.
- **`UserView`** = `{ details, counts, tags, relationship, social_graph_status? }`:
  - `details`: required `{ name, id, indexed_at }`, plus `bio, image, links, status, deleted,
    epoch`.
  - `epoch` is `"v0"` or `"v1"`. It is Nexus indexing state, not app data, so don't treat it as
    part of the profile.
  - `relationship` = `{ following, followed_by }`.
  - `counts` keys: `tagged, tags, unique_tags, posts, replies, collections, following, followers,
    friends, bookmarks`.
  - **`social_graph_status`** is `new|networked|established|null`:
    - `null` means no ranking is available. **Hide the badge**, and don't treat `null` as `new`.
    - It is **not an endorsement**. It describes the account's position in the graph (a high
      value means the account would be expensive to fake). It never means the account is
      trustworthy.

### Deleted posts and users: check `deleted`, not a string

**Render deletion from `details.deleted === true`.** Don't match on a content or name string.

- A deleted post that still has relationships (tags, replies, bookmarks, Collection membership)
  stays as a **tombstone**: `content: ""`, `kind` forced to `"short"`, `attachments: []`,
  `lock: null`, `deleted: true`. It keeps its `uri`, and a reply stays a reply.
- A deleted post with none of these relationships is hard-deleted, and its routes return 404.
- A deleted profile that still has relationships becomes a tombstone: `name: ""`,
  `bio`/`links`/`status`/`image` `null`, `deleted: true`. Its counts and edges remain.

The deployed Nexus no longer emits a `"[DELETED]"` sentinel for posts or user names.
[`./app-specs.md`](./app-specs.md#the-deleted-keyword) still says it does, and that Nexus-side
description is stale for `/v0` reads. The client-side write rules in that section still apply.

## Pagination and errors

**An out-of-range `limit`/`skip` returns 400. The server doesn't clamp it.** The table shows the
bounds as of 2026-10-26. They change, so check the OpenAPI.

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

As of 2026-11-12, the OpenAPI documents the 400 response on 42 of the 43 `/v0` routes (all except
`/v0/info`).

| Status | Body | Meaning |
| :-- | :-- | :-- |
| 400 | JSON `{"error": "..."}` | Invalid input |
| 403 | JSON | For example, ingest for a user on a blacklisted homeserver |
| 404 | JSON | User, post, file, tag or resource not found. **Treat it as "not indexed yet" and return `null`.** An empty stream returns `200 []` |
| 404 | **Empty, no content-type** | Unrouted path, which means your code has a bug |
| 408 | — | Request timeout (30 s) |
| 413 | — | Body too large (1 MiB) |
| 429 | **Empty**, plus `Retry-After` (seconds) | Rate limited |
| 500 | JSON | Internal error |
| 503 | JSON `{"error":"Service unavailable: service temporarily unavailable"}` | Media load shedding on `/static/files/{owner_id}/{file_id}/{variant}` (deployed). No `Retry-After` header, so back off on your own schedule |

**Rate limits** are per IP. Upstream's default config defines two buckets:
- **expensive** (20/min, burst 5):
  - `GET stream/users`, `POST stream/users/by_ids`, `POST stream/posts/by_ids`, `tags/hot`,
    `search/posts/by_content`, `search/users/by_tags`, `POST files/by_ids`, `bootstrap`.
  - Media: `GET /static/files/{owner_id}/{file_id}/{variant}` and `GET /static/avatar/{user_id}`.
    **Image and avatar loads share this 20/min bucket.** A feed UI that loads media in bulk hits
    this limit first.
- **default** (300/min, burst 50): every other route, including the legacy
  `/static/files/{owner_id}/{file_id}`.

Upstream's default config sets `enabled = false`, and no public source says whether the hosted
instance turns rate limiting on. **Handle 429 anyway.**

Don't assume every error body is JSON, and tell data 404s apart from route 404s:

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

Verified 2026-11-12 against production Nexus (read-only, Node 24; it also type-checks under
`tsc --checkJs`):
- A 200 returned parsed JSON.
- An unindexed key returned `null`.
- `/feeds/global` threw `Nexus 404: (empty body: unrouted path?)`.
- A JSON 400 threw with its `error` text.

The 429 branch follows the OpenAPI and upstream's rate-limit middleware (empty body plus a
`Retry-After` integer). It was not triggered live.

## Files and media

- **Metadata:** `GET /v0/files/file/{file_id}`.
  - `file_id` is the **URL-encoded pubky file URI**:
    `encodeURIComponent("pubky://<z32>/pub/pubky.app/files/<id>")`.
  - To fetch several at once, call `POST /v0/files/by_ids` with `{ "uris": [...] }` (1–100 URIs).
- `FileDetails` = `{ id, uri, owner_id, indexed_at, created_at, src, name, size, content_type,
  urls, metadata }`. **In live samples, `created_at` is in microseconds**, while `indexed_at` is in
  ms.
- **Gotcha: `urls` arrives as a JSON-encoded string.** The OpenAPI declares it as an object
  `{ main, large?, feed?, small? }`, but the server sends a string. Handle both. Each value is a
  relative path `<owner_id>/<file_id>/<variant>`. Build the media URL as
  `<nexus>/static/files/` + value.
- **Variants:**

  | Variant | Images | Video | Other types |
  | :-- | :-- | :-- | :-- |
  | `main` | original upload | yes | yes |
  | `large` | fits 1440 px wide, never enlarged, `image/webp` | — | — |
  | `feed` | 720 px, `image/webp` | — | — |
  | `small` | 320 px, `image/webp` | — | — |

- **Nexus serves the bytes under `/static`, not `/v0`:**
  - `GET /static/files/{owner_id}/{file_id}/{variant}`. Add `?dl` to get
    `Content-Disposition: attachment`. Under load this route can return 503 (see the status
    table).
  - `GET /static/avatar/{user_id}` (live: `image/webp`). This route doesn't return 503 under load.
    It falls back to serving `main` with a short cache TTL.
  - `GET /static/files/{owner_id}/{file_id}` is **legacy** and returns 308 to the `/main` path.
    Don't build new URLs with it.
- **`/v0/info` `base_file_url` is a filesystem path on the server** (e.g.
  `/home/pubky/static/files`), not a URL. Don't build media URLs from it.

```js
// Adapted from pubky-app src/core/application/file/file.ts (types stripped).
let urls;
try {
  urls = typeof file.urls === "string" ? JSON.parse(file.urls) : file.urls;
} catch {
  console.warn("Ignoring file metadata with malformed URL JSON", file.id);
  urls = null;
}
const large = urls?.large && `https://nexus.pubky.app/static/files/${urls.large}`;
```

Verified 2026-11-12 against production Nexus (read-only). `urls` came back as a string with the
keys `[main, large, feed, small]`, and the `large` URL built from it returned 200 `image/webp`. The
object form also worked, and malformed JSON left `large` as `undefined`. If a variant is absent,
fall back to `main`. Videos and non-image files have only `main`.

## Events feed (plain text)

`GET /v0/events?cursor=<n>&limit=<1-1000>` returns **`text/plain`, not JSON**. Don't pass it
through `nexusGet`.
- Each line is `PUT pubky://<pk>/<path>` or `DEL pubky://<pk>/<path>`.
- The last line is always `cursor: <n>`.
- The OpenAPI marks `cursor` as required, but the server also accepts a request without it and
  starts from the beginning.

This route is Nexus re-serving the homeserver event stream. For the native homeserver endpoints,
see [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read).

```js
const res = await fetch("https://nexus.pubky.app/v0/events?cursor=0&limit=500");
const lines = (await res.text()).trimEnd().split("\n");
const nextCursor = lines.at(-1)?.replace("cursor: ", "");
const events = lines.slice(0, -1); // "PUT pubky://..." | "DEL pubky://..."
```

Verified 2026-11-12 against production Nexus: it returned `text/plain` with 500 `PUT`/`DEL` lines
and a numeric `nextCursor`.

## Upstream references

- Swagger (source of truth): <https://nexus.pubky.app/swagger-ui/> (staging:
  <https://nexus.staging.pubky.app/swagger-ui/>)
- OpenAPI: <https://nexus.pubky.app/api-docs/v0/openapi.json>,
  <https://nexus.pubky.app/api-docs/static/openapi.json>
- Repo: <https://github.com/pubky/pubky-nexus>. Indexing coverage:
  <https://github.com/pubky/pubky-nexus/blob/main/docs/decentralization.md>. Docs:
  <https://pubky.org/explore/pubky-apps/indexing-and-aggregation/pubky-nexus/>
- `locked` filter: [pubky-nexus#1207](https://github.com/pubky/pubky-nexus/commit/1e61c2768aa23fc0dcd1501aa7ac31f98de74ee1)
- Ad-hoc graph queries: [`nexus-scout` skill](../../nexus-scout/SKILL.md)
  (<https://nexus-scout.pubky.app/llms.txt>)
- Running your own Nexus: [`pubky-infra` nexus-operations](../../pubky-infra/references/nexus-operations.md),
  [local stack](../../pubky-infra/references/local-stack.md)
- Canonical Pubky concepts: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read),
  [`./app-specs.md`](./app-specs.md),
  [`./shipped-vs-planned.md`](./shipped-vs-planned.md#everything-is-v0)
