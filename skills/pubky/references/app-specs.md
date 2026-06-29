# Data models (`pubky-app-specs`)

> **CANONICAL.** Single source of truth for the Pubky **on-wire data contract** — model
> fields, `/pub/pubky.app/` paths, Timestamp vs Blake3 Hash IDs, validation limits, the
> `[DELETED]` keyword, and the `PubkySpecsBuilder` API. The `pubky-mobile` and `pubky-infra`
> skills link here — never copy.

For identity, `pubky://` addressing, pkarr, and the homeserver write-vs-Nexus-read model see
[`./concepts.md`](./concepts.md). For the JS client storage CRUD/auth used to actually
`PUT`/`GET` these objects see [`./sdk-js.md`](./sdk-js.md) (Rust:
[`./sdk-rust.md`](./sdk-rust.md)). For shipped-vs-planned guardrails see
[`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## What this is

`pubky-app-specs` defines the `pubky.app` social schema: typed models with strict validation
and deterministic ID/path generation, shipped as a **Rust crate** and a **WASM/JS package**
(`pubky-app-specs` on npm). Every model serializes to JSON, is stored as an opaque blob on the
author's homeserver under `/pub/pubky.app/...`, and is later indexed by Nexus.

**Authoritative source order.** The Rust source under
[`src/models/**`](https://github.com/pubky/pubky-app-specs/tree/main/src/models) is the source
of truth. The [README](https://github.com/pubky/pubky-app-specs/blob/main/README.md) is an
explicit faithful-but-secondary mirror: *"In case of disagreement between this document and the
Rust implementation, the Rust implementation prevails."* Where the two disagree this page
follows the Rust source (and flags the drift in [Doc-vs-code drift](#doc-vs-code-drift)).

> **Unstable, v0.x.** Verified against **0.5.3** (crate + npm latest). app-specs is in a
> self-declared "Rapid Development Phase"; model shapes, limits, and the `/pub/pubky.app/` path
> layout are **breaking-change-prone**. Paths only move to a versioned `pubky.app/v1/` form at
> the first LTS release. Treat every number below as "as of 0.5.3 — verify against your
> installed version", and read limits at runtime from `getValidationLimits()`. (Do **not**
> trust the exported `VERSION` constant — it stale-reads `"0.5.0"`.) This is all public `/pub`
> data; no `/priv` exists. See [`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## Paths and URIs

Protocol constants
([`src/constants.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/constants.rs)):
`PROTOCOL = "pubky://"`, `PUBLIC_PATH = "/pub/"`, `APP_PATH = "pubky.app/"`. Every object lives
at `/pub/pubky.app/<segment>[/<id>]`; the full URI is:

```text
pubky://<user_id>/pub/pubky.app/<segment>[/<id>]
```

`<user_id>` is the author's **52-char z-base-32 public key** — the raw `z32()` form, **not** the
`pubky`-prefixed display form (see
[concepts → public-key formats](./concepts.md#public-key-string-formats)).

| Model | Path under `/pub/pubky.app/` | ID type |
| :-- | :-- | :-- |
| `PubkyAppUser` | `profile.json` | singleton (no id) |
| `PubkyAppPost` | `posts/<id>` | Timestamp (13-char) |
| `PubkyAppFile` | `files/<id>` | Timestamp (13-char) |
| `PubkyAppTag` | `tags/<id>` | Hash (26-char) |
| `PubkyAppBookmark` | `bookmarks/<id>` | Hash (26-char) |
| `PubkyAppFeed` | `feeds/<id>` | Hash (26-char) |
| `PubkyAppBlob` | `blobs/<id>` | Hash of raw bytes (26-char) |
| `PubkyAppFollow` | `follows/<followee_pubky_id>` | target PubkyId (52-char) |
| `PubkyAppMute` | `mutes/<mutee_pubky_id>` | target PubkyId (52-char) |
| `PubkyAppLastRead` | `last_read` | singleton (no id) |

## Object IDs

Three ID schemes. ID/path generation lives in
[`src/traits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/traits.rs) and
[`src/types.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/types.rs).

**Timestamp IDs** (`Post`, `File`) — `create_id()` takes the current time in **microseconds**
since the Unix epoch, big-endian `i64` (8 bytes), Crockford Base32 → a **13-char** string.
`validate_id` requires: exactly 13 chars, valid Crockford decode to exactly 8 bytes (this
13-char/8-byte structural check is the public `validate_crockford_id` helper, also reused for
collection-item post-ids), and a timestamp after `2024-10-01T00:00:00Z` (`1727740800000000` µs)
and no more than 2 hours in the future. Example: `00321FCW75ZFY`.

**Hash IDs** (`Tag`, `Bookmark`, `Feed`, `Blob`) — Blake3-hash an input, take the **first 16
bytes** (first half of the 32-byte digest), Crockford Base32 → a **26-char** string. The hashed
input differs per model:

- `Tag` — the string `"{uri}:{label}"` (label is already trimmed + lowercased by sanitize)
- `Bookmark` — `uri`
- `Feed` — the serialized `feed` config object (JSON)
- `Blob` — the **entire raw byte payload** (not a string)

`validate_id` recomputes the id and requires an exact string match. Verified test vectors:

- `tag("<post_uri>", "cool")` → `CBYS8P6VJPHC5XXT4WDW26662W`
- `bookmark("<post_uri>")` → `2GN0JCHX9NYXPECQDS8KSMSE7M`
- `blob(vec![1, 2])` → `PZBQ010FF079VVZPQG1RNFN6DR`

Idempotence falls out of this: re-bookmarking the same URI yields the same id/path; two feeds
with identical config collide on id; identical blob bytes are content-addressed to the same id.

> **Crockford, not z-base32.** Inline comments in `traits.rs`/`blob.rs` wrongly say object IDs
> use the "Z-base32 alphabet"; the code actually calls `encode(Alphabet::Crockford, …)`. All
> generated Timestamp and Hash IDs are **Crockford Base32**. Only `PubkyId`/public keys use
> z-base-32.

**`PubkyId`** — a validated public-key string: exactly **52 chars**, z-base-32 (`Alphabet::Z`).
On native builds it wraps `pubky::PublicKey`; Display and Serde both emit the raw z32 string (it
serializes as a plain JSON string), i.e. the hostname/path form, not the `pubky`-prefixed
display form. It is the author host in every URI, the path id for `Follow`/`Mute`, and the host
of Collection items. Valid example:
`operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo`.

## The Validatable lifecycle

The `Validatable` trait defines deserialize → sanitize → validate:

```text
try_from(blob: &[u8], id: &str)  =  serde_json::from_slice → sanitize() → validate(Some(id))
```

- `sanitize()` trims whitespace, normalizes URLs, and lowercases tag labels. As a rule it does
  **not** truncate: over-limit or malformed values pass through unchanged and are **rejected by
  `validate()`**, not silently fixed. Two deliberate exceptions: `File.src` is **truncated** to
  `fileSrcMaxLength` (1024) chars and then blanked to `""` if the result isn't a valid URL (so a
  bad `src` still fails validate); and a `[DELETED]` user `name` is rewritten to `anonymous`.
- `validate()` returns `Result<(), String>`; error messages are prefixed `Validation Error: …`.
- The WASM `create*` / `fromJson` methods run the same pipeline and **throw the error string**
  on failure.

## Models

Fields and limits below are the contract as of 0.5.3; read the authoritative current shape in
[`src/models/**`](https://github.com/pubky/pubky-app-specs/tree/main/src/models).

### PubkyAppUser

Path `/pub/pubky.app/profile.json` (singleton).

| Field | Type | Rules |
| :-- | :-- | :-- |
| `name` | `String` (required) | 3–50 chars; must not be `[DELETED]`; default `anonymous` |
| `bio` | `Option<String>` | ≤160 |
| `image` | `Option<String>` | valid URL, ≤300, non-empty if present |
| `links` | `Option<Vec<PubkyAppUserLink>>` | ≤5; each `{ title: 1–100 non-empty, url: valid ≤300 }` |
| `status` | `Option<String>` | ≤50 |

```js
// On-wire PubkyAppUser shape, stored at the canonical path with @synonymdev/pubky.
import { Pubky, Keypair } from "@synonymdev/pubky";

async function storeProfile() {
  const pubky = new Pubky();
  const keypair = Keypair.random();
  const signer = pubky.signer(keypair);

  // Sign up at a homeserver (null token for open/testnet homeservers)
  const session = await signer.signup(homeserverPk, signupToken);
  console.log(`Public Key: ${signer.publicKey.z32()}`);

  // Store profile (following pubky-app-specs format)
  const profile = {
    name: "Alice",
    bio: "Building on Pubky",
    image: "pubky://user_id/pub/pubky.app/files/0000000000000",
    links: [{ title: "GitHub", url: "https://github.com/alice" }],
    status: "Exploring decentralized tech.",
  };

  // Store at standard pubky-app location
  await session.storage.putJson("/pub/pubky.app/profile.json", profile);
  console.log("Profile stored!");

  // Retrieve profile
  const retrieved = await session.storage.getJson(
    "/pub/pubky.app/profile.json",
  );
  console.log("Retrieved:", retrieved);
}
```

<sub>Source: [`pubky-knowledge-base-v2/snippets/js/src/profile-storage.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/profile-storage.ts) (CI type-checked; executed against a local testnet)</sub>

### PubkyAppPost

Path `/pub/pubky.app/posts/<timestamp_id>`.

| Field | Type | Notes |
| :-- | :-- | :-- |
| `content` | `String` | length cap depends on `kind` (below) |
| `kind` | `PubkyAppPostKind` | must be a known variant |
| `parent` | `Option<String>` | URI of parent post (replies) |
| `embed` | `Option<PubkyAppPostEmbed { kind, uri }>` | reposts; `embed.kind` must be known |
| `attachments` | `Option<Vec<String>>` | URIs; ≤10, each ≤200 chars, protocol ∈ `pubky`/`http`/`https` |

Rules: a post must have **at least one** of `content` / `embed` / `attachments` (all empty →
rejected); `content` cannot equal `[DELETED]`; `kind` and `embed.kind` must not be `Unknown`.

#### Post kinds

`PubkyAppPostKind` (`serde rename_all = lowercase`): `short`, `long`, `image`, `video`, `link`,
`file`, `collection` — plus `Unknown`, a `#[serde(other)]` forwards-compat catch-all. `Unknown`
lets old binaries deserialize newer kinds without panicking but is **always rejected** by
`validate()`; `FromStr` is strict and never yields it.

Content length cap is keyed on kind:

| kind | content max (Unicode scalars) |
| :-- | :-- |
| `short` | 2000 |
| `long` | 50000 |
| `image` / `video` / `link` / `file` | **2000** (reuse the Short cap) |
| `collection` | 40000 (JSON envelope) |

> Gotcha: `image`/`video`/`link`/`file` posts get the **Short 2000** cap — only `long` is
> allowed 50000.

#### Collection posts

For `kind = collection`, `content` holds a JSON envelope
`PubkyAppCollectionContent { name, description?, items, cover_image? }`. Rules: `parent` and
`embed` MUST be unset; `attachments` MUST be empty (items live in the envelope, not
attachments); `content` ≤40000 and must parse into the envelope; `name` 1–100 and not
whitespace-only (whitespace counts toward length — the validator does **not** trim before
counting); `description` ≤500; `cover_image` ≤200 with protocol `pubky`/`http`/`https`; `items`
≤100, each the **exact canonical 94-char** form
`pubky://<52-char-pubkyid>/pub/pubky.app/posts/<13-char-id>` (validated structurally, not via
`Url::parse`, to reject userinfo / extra segments / query / fragment).

Each host below is a **real** 52-char `PubkyId` (collections may span authors) — placeholder
hosts like `userA` would be **rejected** by `validate_collection_item_uri`:

```json
{
  "name": "AI papers",
  "description": "Best stuff",
  "cover_image": "pubky://operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/pub/pubky.app/files/0034A0X7NJ52C",
  "items": [
    "pubky://operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/pub/pubky.app/posts/0034A0X7NJ52A",
    "pubky://o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo/pub/pubky.app/posts/0034A0X7NJ52B"
  ]
}
```

Build this with `builder.createCollectionPost(...)`, which serializes the envelope into
`content` for you.

### PubkyAppTag

Path `/pub/pubky.app/tags/<hash_id>`, id = `Crockford(Blake3("{uri}:{label}")[:16])`.

| Field | Type | Rules |
| :-- | :-- | :-- |
| `uri` | `String` (required) | valid URI of the tagged object |
| `label` | `String` (required) | sanitize = trim + lowercase; 1–20 chars; no whitespace and none of `, : <space> <tab> \n \r` |
| `created_at` | `i64` | |

Because `label` is lowercased during sanitize, the hash id is computed over the lowercased
label. `sanitize_tag_label` / `validate_tag_label` are public and reused by `Feed`.

### PubkyAppBookmark

Path `/pub/pubky.app/bookmarks/<hash_id>`, id = `Crockford(Blake3(uri)[:16])`.

| Field | Type | Rules |
| :-- | :-- | :-- |
| `uri` | `String` (required) | valid URI of the bookmarked object |
| `created_at` | `i64` | does **not** affect the id (only `uri` does) |

Re-bookmarking the same URI yields the same path/id (idempotent).

### PubkyAppFollow and PubkyAppMute

Paths `/pub/pubky.app/follows/<followee_pubky_id>` and `/pub/pubky.app/mutes/<mutee_pubky_id>`.
Both bodies are just `{ "created_at": i64 }` — the relationship **target is encoded in the path
segment** (a valid 52-char `PubkyId`); there is no target field in the body. Validation only
checks that the path id is a valid `PubkyId`.

### PubkyAppFile

Path `/pub/pubky.app/files/<timestamp_id>`. A File is **metadata pointing at a separately-stored
Blob.**

| Field | Type | Rules |
| :-- | :-- | :-- |
| `name` | `String` | 1–255 |
| `created_at` | `i64` | |
| `src` | `String` | blob URL, e.g. `pubky://<id>/pub/pubky.app/blobs/<blob_id>`; valid URL, ≤1024 (sanitize truncates to 1024 chars, then blanks to `""` if not a valid URL → fails validate) |
| `content_type` | `String` | must parse as a MIME **and** be in the closed `VALID_MIME_TYPES` allowlist |
| `size` | `usize` | `> 0` and ≤ **100 MB** |

`VALID_MIME_TYPES` is a **closed allowlist of exactly 21 types** — anything outside it (e.g.
`image/heic`, `application/gzip`) is rejected: `application/javascript`, `application/json`,
`application/octet-stream`, `application/pdf`, `application/x-www-form-urlencoded`,
`application/xml`, `application/zip`, `audio/mpeg`, `audio/wav`, `image/gif`, `image/jpeg`,
`image/png`, `image/svg+xml`, `image/webp`, `multipart/form-data`, `text/css`, `text/html`,
`text/plain`, `text/xml`, `video/mp4`, `video/mpeg`. Exposed via `getValidMimeTypes()` (JS) and
the `VALID_MIME_TYPES` const (Rust).

### PubkyAppBlob

Path `/pub/pubky.app/blobs/<hash_id>`. Newtype `pub struct PubkyAppBlob(pub Vec<u8>)`;
id = `Crockford(Blake3(<all bytes>)[:16])`. Validate: non-empty and ≤ **100 MB**.
Content-addressed (same bytes → same id). Blobs back Files: store the blob first, then store a
File whose `src` is the blob's URL.

```js
import { PubkySpecsBuilder } from "pubky-app-specs";

// `session` is an AUTHENTICATED Session (from signer.signup / signer.signin).
// A Blob is RAW bytes, content-addressed by Blake3 over those bytes, so PUT blob.data
// with putBytes — NOT JSON.stringify(blob.toJson()), which stores the byte array as JSON
// text and breaks the blob's content hash. Writes target meta.path: @synonymdev/pubky
// client.fetch() only accepts http(s):// URLs and rejects the pubky:// meta.url.
async function uploadFile(session, fileData, fileName, contentType, fileSize) {
  const specs = new PubkySpecsBuilder(session.info.publicKey.z32());

  // First, store the raw blob bytes.
  const { blob, meta: blobMeta } = specs.createBlob(fileData);
  await session.storage.putBytes(blobMeta.path, blob.data);

  // Then store the file metadata pointing at the blob (src is the blob's pubky:// URI).
  const { file, meta: fileMeta } = specs.createFile(
    fileName,
    blobMeta.url, // Reference to the blob
    contentType,
    fileSize,
  );
  await session.storage.putJson(fileMeta.path, file.toJson());

  return { file, meta: fileMeta };
}
```

<sub>Adapted from [`pubky-app-specs/pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md) and **corrected** against `@synonymdev/pubky` 0.9.3 (executed against a local testnet). The README's verbatim `client.fetch(meta.url, …)` + `JSON.stringify(blob.toJson())` is broken on two counts: `client.fetch` is http(s)-only and rejects the `pubky://` `meta.url`, and serializing the bytes as a JSON number-array breaks the Blob's raw-byte content hash. Use `session.storage.putBytes`/`putJson` at `meta.path`.</sub>

### PubkyAppFeed

Path `/pub/pubky.app/feeds/<hash_id>`. The on-wire JSON is **nested** (not the flat fields the
README table implies): the config lives under a `feed` object.

```json
{
  "feed": {
    "tags": ["bitcoin"],
    "reach": "following",
    "layout": "columns",
    "sort": "recent",
    "content": "short"
  },
  "name": "My feed",
  "created_at": 1700000000000000
}
```

- `feed.reach` ∈ `following` | `followers` | `friends` | `all`
- `feed.layout` ∈ `columns` | `wide` | `visual` | `list`
- `feed.sort` ∈ `recent` | `popularity`
- `feed.content` — optional post-kind filter (a `PubkyAppPostKind`)
- `feed.tags` — optional, ≤5, each a valid tag label (trimmed/lowercased, empties filtered)
- `name` — required, non-empty

The Hash id is derived from the serialized `feed` config object, so two feeds with the same
config collide on id.

### PubkyAppLastRead

Path `/pub/pubky.app/last_read` (singleton). Body `{ "timestamp": i64 }` in **Unix epoch
milliseconds** (`> 0`).

> Unit gotcha: `new()` computes `timestamp()/1000`, so `LastRead` is in **milliseconds**, while
> the `created_at` fields populated by other models' `new()` are in **microseconds**.

## Validation limits

The single source of truth is `VALIDATION_LIMITS`
([`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs)), published
as camelCase JSON via `getValidationLimits()` / the `validationLimits` export (also importable
as `pubky-app-specs/validationLimits`). Read it at runtime rather than hardcoding. Values as of
0.5.3:

| Key | Value |
| :-- | :-- |
| `maxBlobSizeBytes` | `104857600` (100 MB) |
| `maxFileSizeBytes` | `104857600` (100 MB) |
| `tagLabelMinLength` / `tagLabelMaxLength` | `1` / `20` |
| `tagInvalidChars` | `[',', ':', ' ', '\t', '\n', '\r']` |
| `userNameMinLength` / `userNameMaxLength` | `3` / `50` |
| `userBioMaxLength` | `160` |
| `userImageUrlMaxLength` | `300` |
| `userLinksMaxCount` | `5` |
| `userLinkTitleMaxLength` / `userLinkUrlMaxLength` | `100` / `300` |
| `userStatusMaxLength` | `50` |
| `postShortContentMaxLength` | `2000` |
| `postLongContentMaxLength` | `50000` |
| `postAttachmentsMaxCount` | `10` |
| `postAttachmentUrlMaxLength` | `200` |
| `postAllowedAttachmentProtocols` | `[pubky, http, https]` |
| `collectionContentMaxLength` | `40000` |
| `collectionNameMinLength` / `collectionNameMaxLength` | `1` / `100` |
| `collectionDescriptionMaxLength` | `500` |
| `collectionItemsMaxCount` | `100` |
| `fileNameMinLength` / `fileNameMaxLength` | `1` / `255` |
| `fileSrcMaxLength` | `1024` |
| `feedTagsMaxCount` | `5` |

## The `[DELETED]` keyword

`RESERVED_CONTENT_DELETED = "[DELETED]"`. When an object that still has relationships (replies,
tags, etc.) is deleted, the system marks it with the literal `[DELETED]` so clients exact-match
it and apply tombstone effects. **Clients must never author it:**

- a `Post` whose `content` is exactly `[DELETED]` is **rejected** by validate.
- a `User` whose `name` is `[DELETED]` is silently rewritten to `anonymous` during sanitize.

Only the system writes `[DELETED]`.

## Unicode length counting

All length limits count **Unicode scalar values** via Rust `.chars().count()` — not bytes, and
not JS `.length` (UTF-16 code units). All validation runs inside the WASM module, so JS
delegates to Rust. For a client-side counter that must agree, use `[...str].length` or
`Array.from(str).length` (correct), never `str.length` (which would wrongly reject e.g.
`"🔥".repeat(25)` as 50). Grapheme clusters (family emoji, flags, combining marks) are **not**
collapsed — they are counted per code point. See
[`docs/UNICODE_NOTES.md`](https://github.com/pubky/pubky-app-specs/blob/main/docs/UNICODE_NOTES.md).

## Builder and crate APIs

### WASM / JS — `PubkySpecsBuilder`

Construct with the **author's** 52-char pubky id: `new PubkySpecsBuilder(pubkyId)` (throws on
invalid). Each `create*` method sanitizes + validates + generates id/path and returns a typed
result `{ <object>, meta }` where `meta = { id, path, url }` and `url = pubky://<pubkyId><path>`;
on failure it **throws the validation error string**. Convert objects with `obj.toJson()` /
`Model.fromJson(jsValue)`.

| Method | Notes |
| :-- | :-- |
| `createUser(name, bio, image, links, status)` | `meta` has no `id` |
| `createPost(content, kind, parent, embed, attachments)` | |
| `editPost(originalPost, postId, newContent)` | preserves id + timestamp |
| `createCollectionPost(name, description, items, cover_image)` | builds + serializes the envelope; omits `parent`/`embed` |
| `createFeed(tags, reach, layout, sort, content, name)` | |
| `createFile(name, src, content_type, size)` | |
| `createTag(uri, label)` | |
| `createBookmark(uri)` | |
| `createFollow(followeeId)` | |
| `createMute(muteeId)` | |
| `createLastRead()` | |
| `createBlob(blobData: Uint8Array)` | |

Free functions: `getValidationLimits()`, `getValidMimeTypes()`,
`parse_uri(uri) → { user_id, resource, resource_id }`. URI builders: `userUriBuilder`,
`postUriBuilder`, `bookmarkUriBuilder`, `followUriBuilder`, `tagUriBuilder`, `muteUriBuilder`,
`lastReadUriBuilder`, `blobUriBuilder`, `fileUriBuilder`, `feedUriBuilder`.

```js
import { PubkySpecsBuilder, PubkyAppPostKind } from "pubky-app-specs";

// `session` is an AUTHENTICATED Session (from signer.signup / signer.signin).
// Build + validate a Post (the {object, meta} contract), then write via session.storage
// at meta.path: @synonymdev/pubky client.fetch() only accepts http(s):// URLs and rejects
// the pubky:// meta.url the builder returns.
async function createPost(session, content) {
  const specs = new PubkySpecsBuilder(session.info.publicKey.z32());

  // Create the Post object
  const { post, meta } = specs.createPost(
    content,
    PubkyAppPostKind.Short,
    null, // parent post URI (for replies)
    null, // embed object (for reposts)
    null, // attachments (array of file URLs)
  );

  // Store the post
  await session.storage.putJson(meta.path, post.toJson());

  return { post, meta };
}
```

<sub>Adapted from [`pubky-app-specs/pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md) and **corrected** against `@synonymdev/pubky` 0.9.3 (executed against a local testnet): write with `session.storage.putJson(meta.path, …)`, not `client.fetch(meta.url, …)` — the `pubky://` `meta.url` is rejected by http(s)-only `client.fetch`. (The README's inline `attachments … max 3` comment is also **wrong** — the real cap is **10**.)</sub>

### Rust crate

Re-exports from
[`src/lib.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/lib.rs): models
(`PubkyAppUser`/`PubkyAppUserLink`, `PubkyAppPost`/`PubkyAppPostEmbed`/`PubkyAppPostKind`/`PubkyAppCollectionContent`,
`PubkyAppTag`, `PubkyAppBookmark`, `PubkyAppFollow`, `PubkyAppMute`,
`PubkyAppFile` + `VALID_MIME_TYPES`, `PubkyAppBlob`,
`PubkyAppFeed` + `PubkyAppFeedReach`/`Layout`/`Sort`, `PubkyAppLastRead`); traits `Validatable`,
`TimestampId`, `HashId`, `HasPath`, `HasIdPath`; `PubkyId`; `ParsedUri`/`Resource`;
`VALIDATION_LIMITS`; `validate_crockford_id`; URI builder fns. Each model exposes
`create_path()` / `create_path(id)` → `/pub/pubky.app/...`. `PubkyAppObject::from_uri(uri, blob)`
and `::from_resource(resource, blob)` parse + validate a homeserver blob into the right typed
object. `ParsedUri::try_from(uri)` yields `{ user_id: PubkyId, resource: Resource }` where
`Resource ∈ User | Post(id) | Follow(PubkyId) | Mute(PubkyId) | Bookmark(id) | Tag(id) | File(id) | Blob(id) | Feed(id) | LastRead | Unknown`.

```rust
use pubky_app_specs::{traits::HasPath, traits::Validatable, PubkyAppUser};
use serde_json::to_vec;

// Build a validated user profile
let user_profile = PubkyAppUser::new(
    "Test User".to_string(), // display name (3-50 chars)
    None,                    // bio
    None,                    // image
    None,                    // links
    None,                    // status
);

// Canonical path: /pub/pubky.app/profile.json
let path = PubkyAppUser::create_path();
let content = to_vec(&user_profile)?;
session.storage().put(&path, content.clone()).await?;

// Read back and re-validate (sanitize + validate). `Validatable::try_from` returns
// `Result<_, String>`; map the String into your error type — a bare `?` won't convert it
// (`String: std::error::Error` is not satisfied, e.g. under `anyhow::Result`).
let bytes = response.bytes().await?;
let retrieved = <PubkyAppUser as Validatable>::try_from(&bytes, "")
    .map_err(anyhow::Error::msg)?;
```

<sub>Source: [`pubky-app-specs/examples/create_user.rs`](https://github.com/pubky/pubky-app-specs/blob/main/examples/create_user.rs) (trimmed; executed against a local testnet). The upstream example uses `.expect(...)`; under `anyhow::Result` map the `String` error with `.map_err(anyhow::Error::msg)?` (or use an error type that impls `From<String>`, e.g. `Box<dyn Error + Send + Sync>`).</sub>

## Doc-vs-code drift

The Rust source is authoritative; do not repeat these stale README numbers.

| Source says | Reality (Rust, authoritative) |
| :-- | :-- |
| README File table: "Max size is 10Mb" | `maxFileSizeBytes = 104857600` = **100 MB** (same cap for Blob); validator error reads "exceeds maximum limit of 100MB" |
| pkg README post examples: attachments "max 3" | `postAttachmentsMaxCount = 10` |
| README Feed table: flat fields | on-wire JSON **nests** config under `feed` (see [PubkyAppFeed](#pubkyappfeed)) |
| `traits.rs`/`blob.rs` comments: IDs in "Z-base32" | object IDs are **Crockford** Base32; only `PubkyId` uses z-base-32 |
| `VERSION` constant = `"0.5.0"` | crate/npm version is **0.5.3** |

## Upstream references

- **Rust models (authoritative):**
  [`src/models/**`](https://github.com/pubky/pubky-app-specs/tree/main/src/models), plus
  [`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs),
  [`src/traits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/traits.rs),
  [`src/types.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/types.rs)
- **README (secondary mirror — Rust prevails on disagreement):**
  [pubky-app-specs/README.md](https://github.com/pubky/pubky-app-specs/blob/main/README.md)
- **npm package** (WASM builder + validators + `validationLimits` JSON):
  [`pubky-app-specs`](https://www.npmjs.com/package/pubky-app-specs) (latest 0.5.3)
