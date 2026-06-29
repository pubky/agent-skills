# Nexus read API (`/v0`)

Nexus is the hosted **read aggregator / indexer** for the Pubky social graph: apps **read**
aggregated social data — feeds, followers, tags, notifications, search — from its hosted `/v0`
REST API. **Nexus never accepts content writes** — apps write to the author's own homeserver
via the SDK. This homeserver-write vs Nexus-read split is canonical in
[`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read) — read it first; this file is
only the `/v0` surface.

> **`/v0` is unstable and breaking-change-prone.** The catalog and response shapes below are a
> map for orientation, not a frozen contract — **confirm every endpoint and shape against the
> live Swagger / OpenAPI before relying on it.** Do not hardcode response shapes; parse
> defensively. See the [instability guardrail](#instability-the-v0-guardrail).

## Base URLs and Swagger (source of truth)

The Swagger UI / OpenAPI JSON is the **authoritative catalog** — always reconcile against it.

| Environment | API base | Swagger UI | OpenAPI JSON |
| :-- | :-- | :-- | :-- |
| Production | `https://nexus.pubky.app/v0` | `https://nexus.pubky.app/swagger-ui/` | `/api-docs/v0/openapi.json` |
| Staging (latest) | `https://nexus.staging.pubky.app/v0` | `https://nexus.staging.pubky.app/swagger-ui/` | `/api-docs/v0/openapi.json` |
| Self-hosted (local) | `http://localhost:8080` | `http://localhost:8080/swagger-ui` | `/api-docs/v0/openapi.json` |

Static/media docs are at `/api-docs/static/openapi.json`. The ai-kit pattern picks the base
from an env override, falling back to production:

```js
const NEXUS_API_BASE_URL = process.env.NEXT_PUBLIC_NEXUS
  ? `${process.env.NEXT_PUBLIC_NEXUS}/v0`
  : "https://nexus.pubky.app/v0";
```

**Browser-callable.** The webapi layers a permissive CORS policy (any origin, method, and
header), so `/v0` can be called directly from browser JS with no proxy. It also enforces a
request-body size limit (relevant to the `POST .../by_ids` batch reads) and a request timeout.

## Instability: the `/v0` guardrail

`/v0` endpoints appear and disappear between releases. README warning, verbatim:

> The API is currently unstable. We are using the /v0 route prefix while the API undergoes
> active development and changes. Expect potential breaking changes as we work toward stability.

This is part of the shipped-vs-planned guardrail — see
[`./shipped-vs-planned.md`](./shipped-vs-planned.md). **Concrete proof of drift** (verified live
2026-06-29): production `GET /v0/info` reports `nexus-webapi` version `0.4.1`. The upstream
clone defines `GET /v0/search/posts/by_content` (full-text content search) that is **not** in
the deployed production OpenAPI. An agent must confirm any endpoint against the live Swagger
before relying on it — a route that exists in `main` may not be deployed.

## ID formats in paths and queries

| Param | Format | Notes |
| :-- | :-- | :-- |
| `user_id`, `author_id`, `viewer_id`, `observer_id`, `tagger_id` | `PubkyId` = raw 52-char z-base-32 public key | `publicKey.z32()` — **not** the `pubky`-prefixed display form |
| `post_id`, `tag_id` | Crockford base32 | the app-specs Timestamp ID |
| `resource_id` | 32-char hex string | |
| `{label}` | tag label string | |

Public-key string-format rules (`.z32()` vs `.toString()`) are canonical in
[`./concepts.md`](./concepts.md#public-key-string-formats) — don't mix them; Nexus expects the
raw `z32()` form everywhere.

## Endpoint catalog

Production `0.4.1` (confirmed against live OpenAPI). Treat as a map, not a contract — reconcile
with Swagger.

- **Info:** `GET /v0/info`
- **Bootstrap:** `GET /v0/bootstrap/{user_id}` (full client-prefill payload on sign-in),
  `PUT /v0/ingest/{user_id}` (begin homeserver ingestion)
- **User:** `GET /v0/user/{user_id}` + `/counts` `/details` `/tags` `/taggers/{label}`
  `/followers` `/following` `/friends` `/notifications` `/relationship/{viewer_id}`
- **Post:** `GET /v0/post/{author_id}/{post_id}` + `/details` `/counts` `/bookmark` `/tags`
  `/taggers/{label}`
- **Stream:** `GET /v0/stream/posts`, `/stream/posts/keys`, `POST /v0/stream/posts/by_ids`,
  `GET /v0/stream/users`, `/stream/users/ids`, `/stream/users/username`,
  `POST /v0/stream/users/by_ids`, `GET /v0/stream/resources`, `/stream/resources/ids`
- **Tags:** `GET /v0/tags/hot`, `/tags/taggers/{label}`, `/tags/{tagger_id}/{tag_id}`
- **Search:** `GET /v0/search/users/by_name/{prefix}`, `/search/users/by_id/{prefix}`,
  `/search/posts/by_tag/{tag}`, `/search/tags/by_prefix/{prefix}`
- **Resource:** `GET /v0/resource/{resource_id}/tags`,
  `/resource/{resource_id}/tags/{label}/taggers`, `/resource/by-uri`
- **File:** `GET /v0/files/file/{file_id}`, `POST /v0/files/by_ids`
- **Events:** `GET /v0/events`
- **Clone-only (not yet in prod):** `GET /v0/search/posts/by_content`

**The only two state-mutating endpoints are operational, not content:**
`PUT /v0/ingest/{user_id}` tells Nexus to start monitoring a user's homeserver, and the
`POST .../by_ids` batch reads are `POST` purely to carry large id lists in the body. You never
write content to Nexus.

## Post streams (the `source` footgun)

`GET /v0/stream/posts` (and `/stream/posts/keys`) takes a discriminated `source` enum
(snake_case) that **requires specific params or returns 400** — the #1 mistake. Returns
`PostStreamDetailed` (array of `PostViewDetailed`).

| `source` | Required params | Notes |
| :-- | :-- | :-- |
| `all` (default) | — | global timeline |
| `following`, `followers`, `friends`, `bookmarks` | `observer_id` | reach-based |
| `author`, `author_replies` | `author_id` | |
| `post_replies` | `author_id` + `post_id` | |
| `collection` | `author_id` + `post_id` | also **rejects** `tags`/`kind`/`sorting`/`order`/`start`/`end` with 400 |
| `wot` | `observer_id` | optional `depth` 1–3 (default 2) |
| `wot_domain` | `observer_id` + `domain_tags` | |

Common params: `viewer_id`; `tags` (comma list, max 5); `kind`; `sorting`
(`timeline` \| `total_engagement`); `order` (`ascending` \| `descending`, default
`descending`); `skip`/`limit` (1–50, default 10); `start`/`end` (f64 timestamp/score cursor);
`include_attachment_metadata`.

```js
// Global timeline feed (read-only aggregation from Nexus)
const res = await fetch(
  "https://nexus.pubky.app/v0/stream/posts?source=all&limit=20",
);
const posts = await res.json(); // PostStreamDetailed: PostViewDetailed[]
```

```js
// `source=following` requires observer_id; 400 if omitted.
const userZ32 = publicKey.z32();
const res = await fetch(
  `https://nexus.pubky.app/v0/stream/posts?source=following` +
    `&observer_id=${userZ32}&viewer_id=${userZ32}&limit=20`,
);
if (!res.ok) throw new Error(`Nexus ${res.status}`);
const posts = await res.json();
```

### `viewer_id` vs `observer_id`

Two independent personalization params (both may be supplied):

- **`viewer_id`** personalizes a response from one user's perspective — sets bookmark state,
  relationship flags, and WoT-filtered tags on returned items.
- **`observer_id`** is the structural pivot for reach-based post streams — the user whose
  follow/friend graph defines `following`/`followers`/`friends`/`bookmarks`/`wot`.

### `kind` filter

`PubkyAppPostKind` values (from pubky-app-specs): `short`, `long`, `image`, `video`, `link`,
`file`, `collection`. Used on `/v0/stream/posts` and `/v0/search/posts/*`. The full post/data
model is canonical in [`./app-specs.md`](./app-specs.md) — link, don't restate.

## User streams

`GET /v0/stream/users` (and `/stream/users/ids`) — `source` enum (default `followers`). Returns
`UserStream`.

| `source` | Required / optional | Notes |
| :-- | :-- | :-- |
| `followers` (default), `following`, `friends`, `recommended` | `user_id` (required) | |
| `most_followed` | — | |
| `influencers` | optional `user_id` + `reach` + `timeframe` | no `user_id` → global influencers; default `reach` `wot_2` |
| `post_replies` | `author_id` + `post_id` (required) | |

Other params: `viewer_id`; `reach`
(`followers` \| `following` \| `friends` \| `wot` \| `wot_1`..`wot_3`; bare `wot` = depth 2);
`timeframe` (default `all_time`); `depth` (>3 ignored); `preview` (random sample of 3, ignores
`skip`/`limit`); `skip`/`limit` (1–20, default 5).

## Single post view

```js
// author_id = z-base-32 pubky, post_id = Crockford32 id
const res = await fetch(
  `https://nexus.pubky.app/v0/post/${authorZ32}/${postId}?viewer_id=${viewerZ32}`,
);
if (res.status === 404) return null; // post not found / not indexed
const post = await res.json(); // PostViewDetailed
```

`GET /v0/post/{author_id}/{post_id}` returns **404** when the post is unknown — clients should
treat 404 as `null`. (Empty *streams*, by contrast, return 200 with an empty array.)

## Pagination

`skip` + `limit`, both optional; absent → compile-time defaults. **Out-of-range values are
rejected with 400 at deserialization — not silently clamped.** `start`/`end` are optional `f64`
cursor values (timestamp or engagement score). Offset (`skip`) pagination is **not stable
across deletions** — items removed between pages shift the window; prefer `start`/`end` cursors
for stable paging.

| Endpoint group | `limit` range | Default | Notes |
| :-- | :-- | :-- | :-- |
| Post streams | 1–50 | 10 | `skip` max 10000 |
| User streams | 1–20 | 5 | |
| Username search | 1–20 | 20 | |
| Hot tags | 1–40 | 40 | |
| User/post-view tags | 1–100 | 5 | |
| User search | 1–200 | 50 | |
| Post search | 1–200 | 20 | |
| Events | 1–1000 | 500 | |
| Content search (clone-only) | 1–100 | 20 | |

## Errors

Error responses are JSON `{ "error": "<message>" }` (`ErrorResponsePayload`). Status codes:
**400** invalid/missing params (including out-of-range pagination and a `source` missing its
required params), **404** not found (user/post/resource/file), **500** internal. Treat a 404 on
a single-resource `GET` as `null`; empty streams are 200 with `[]`.

## Files and media

- `GET /v0/files/file/{file_id}` returns file **metadata** (`FileDetails`), where `{file_id}` is
  the **URL-encoded pubky file URI** — `encodeURIComponent("pubky://<pk>/pub/pubky.app/files/<id>")`
  — **not** a hash. Malformed URI → 400, missing → 404.
- `POST /v0/files/by_ids` with body `{ "uris": [...] }` → `FileDetails[]` (invalid URIs are
  silently skipped).
- Post-view / stream endpoints accept `include_attachment_metadata=true` to inline attachment
  `FileDetails` instead of a separate lookup.

**Media blobs live under `/static`, not `/v0`.** Actual file content and processed image
variants are served by a separate tree: `GET /static/files/{owner_id}/{file_id}/{variant}`,
`GET /static/files/{owner_id}/{file_id}` (legacy), and `GET /static/avatar/{user_id}`. The
`/v0/info` `base_file_url` field reports the server's **local** files root (e.g.
`/home/pubky/static/files`), **not** a public URL. Rule of thumb: `/static/...` to fetch media,
`/v0/files/...` for metadata.

## Events feed (plain text)

`GET /v0/events?cursor={n}&limit={1-1000}` returns **`text/plain`, not JSON**: newline-separated
`PUT pubky://<pk>/<path>` / `DEL pubky://<pk>/<path>` lines, with a trailing `cursor: <n>` line
giving the next cursor. This is Nexus's re-served view of the homeserver event stream — the
homeserver-native event endpoints are canonical in
[`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read), link don't restate.

```js
// Nexus /v0/events returns text/plain, not JSON.
const res = await fetch(
  "https://nexus.pubky.app/v0/events?cursor=0&limit=500",
);
const text = await res.text();
const lines = text.trimEnd().split("\n");
const nextCursor = lines.at(-1)?.replace("cursor: ", "");
const events = lines.slice(0, -1); // "PUT pubky://..." / "DEL pubky://..."
```

## Response models

Drift-prone — confirm field-by-field against the Swagger schemas. Short summaries only:

- **`ServerInfo`** (`GET /v0/info`): `{ description, homepage, license, name, repository,
  version, commit_hash, last_index_snapshot, base_file_url }`. `last_index_snapshot` is the
  Redis RDB save time formatted `YYYY-MM-DD HH:MM:SS` — a useful **freshness/health signal**.
  Live prod sample (2026-06-29): `name` `nexus-webapi`, `version` `0.4.1`.
- **`UserView`** = `{ details: UserDetails{name,bio,id,links,status,image,indexed_at}, counts:
  UserCounts, tags: TagDetails[], relationship: Relationship }`.
- **`PostView`** = `{ details: PostDetails, counts: PostCounts, tags: TagDetails[],
  relationships: PostRelationships, bookmark: Bookmark? }`. **`PostViewDetailed`** flattens
  `PostView` and adds `attachments_metadata: FileDetails[]` (present only when
  `include_attachment_metadata=true`).
- **Resource tag endpoints** return `{ resource: ResourceDetails, tags: TagDetails[] }`.

The post/user/tag data model itself is canonical in [`./app-specs.md`](./app-specs.md).

## Upstream references

- **Swagger UI (source of truth):** <https://nexus.pubky.app/swagger-ui/> ·
  OpenAPI JSON: <https://nexus.pubky.app/api-docs/v0/openapi.json>
- **Repo:** <https://github.com/pubky/pubky-nexus> ·
  **Docs:** <https://docs.pubky.org/explore/pubky-apps/indexing-and-aggregation/pubky-nexus/>
- **Canonical concepts (never restate):**
  [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read) (write/read split, event
  streams, public-key formats), [`./app-specs.md`](./app-specs.md) (post/user/tag data model),
  [`./shipped-vs-planned.md`](./shipped-vs-planned.md) (the `/v0` instability guardrail).
