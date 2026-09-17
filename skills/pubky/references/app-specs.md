# Data models (`pubky-app-specs`)

> **CANONICAL.** Single source of truth for the Pubky **on-wire data contract**: model fields,
> `/pub/pubky.app/` paths, Timestamp vs Blake3 Hash IDs, validation limits, the `[DELETED]`
> keyword, and the builder/crate APIs. Other skills **link** here; do not copy this content.

Related: identity, `pubky://` addressing, pkarr and the homeserver-write vs Nexus-read split are in
[`./concepts.md`](./concepts.md). The storage calls that `PUT`/`GET` these objects are in
[`./sdk-js.md`](./sdk-js.md) and [`./sdk-rust.md`](./sdk-rust.md). Guardrails:
[`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## Scope and stability

- **Only for Pubky Social apps** (apps that read or write `pubky.app` social data). Other Pubky apps
  should ignore `pubky-app-specs` and use their own schemas under their own `/pub/<app>/` prefix. Nexus
  consumes these models (it pins `pubky-app-specs` 0.7.0 with the `openapi` feature).
- **Versions (checked 2026-09-16):** crate **0.8.0**, npm `latest` **0.7.0**. Between them only Rust
  dependencies changed (`pubky` 0.9.1 → 0.10.0); `src/` is identical, so npm 0.7.0 has the same JS API
  as `main`. Rust `VERSION` is `env!("CARGO_PKG_VERSION")` (accurate); it is not exported to JS.
- **Unstable, v0.x.** Upstream calls this a "Rapid Development Phase ... v0 draft". Model shapes,
  limits and the `/pub/pubky.app/` layout can break between any releases. Upstream plans to move paths
  to `pubky.app/v1/` at the first long-term-support release. Read limits at runtime (see
  [Validation limits](#validation-limits)); do not hard-code the numbers on this page.
- **All of this is public `/pub` data.** Nothing here is private or encrypted.
- **Source of truth:** the Rust code in [`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models).
  [`SPEC.md`](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md) calls itself "a faithful
  representation" of it but has drifted (see [Doc-vs-code drift](#doc-vs-code-drift)); when they
  disagree, follow the Rust code. The root README only lists the models (type + purpose); it has no
  field or validation tables.

## Paths and URIs

Constants: `PROTOCOL = "pubky://"`, `PUBLIC_PATH = "/pub/"`, `APP_PATH = "pubky.app/"`. Path =
`PUBLIC_PATH + APP_PATH + segment + id`. Full URI = `pubky://<author z32>` + path.

| Model | Path | ID kind |
| :-- | :-- | :-- |
| `PubkyAppUser` | `/pub/pubky.app/profile.json` | none (fixed path) |
| `PubkyAppLastRead` | `/pub/pubky.app/last_read` | none (fixed path) |
| `PubkyAppPost` | `/pub/pubky.app/posts/<id>` | Timestamp |
| `PubkyAppFile` | `/pub/pubky.app/files/<id>` | Timestamp |
| `PubkyAppTag` | `/pub/pubky.app/tags/<id>` | Blake3 hash |
| `PubkyAppBookmark` | `/pub/pubky.app/bookmarks/<id>` | Blake3 hash |
| `PubkyAppFeed` | `/pub/pubky.app/feeds/<id>` | Blake3 hash |
| `PubkyAppBlob` | `/pub/pubky.app/blobs/<id>` | Blake3 hash (of raw bytes) |
| `PubkyAppFollow` | `/pub/pubky.app/follows/<pubky_id>` | target user's PubkyId |
| `PubkyAppMute` | `/pub/pubky.app/mutes/<pubky_id>` | target user's PubkyId |

### `PubkyId`: raw z32 only

`PubkyId` must be exactly 52 characters of valid z-base-32 (otherwise `invalid public key encoding`).
Native Rust also checks that it parses as a `pubky::PublicKey`. The **`pubky`-prefixed display form is
rejected** with `Validation Error: the string is not 52 utf chars`. This applies to
`new PubkySpecsBuilder(...)`, `createFollow`, `createMute` and URI hosts.

- JS: pass `session.info.publicKey.z32()`. **Never** pass `.toString()` (display only).
- Rust: `PubkyId` has `From<pubky::PublicKey>`, `From<pubky::Keypair>` and `to_public_key()`, but these
  use **`pubky` 0.10** types (app-specs 0.8.0 depends on `pubky = "0.10.0"`). On `pubky` 0.12 they do
  not type-check, because the two crates' key types are distinct. Go through the string:
  `PubkyId::try_from(&pk.z32())` (an inherent `fn try_from(&str) -> Result<Self, String>`).

### URI helpers

- **Builders** (Rust snake_case, JS camelCase): `base_uri_builder(user_id)` → `pubky://<id>/pub/pubky.app/`,
  plus one `*_uri_builder(author_id[, id])` per model: `user`, `post`, `follow`, `mute`, `bookmark`,
  `tag`, `file`, `blob`, `feed`, `last_read`. **Builders do not validate inputs**; validate IDs yourself.
- **JS `parse_uri(uri)`** returns `{ user_id, resource, resource_id }`. `resource` is e.g. `"posts"`,
  `"profile.json"` or `"unknown"`; `resource_id` is a string or **`undefined`** (not `null`). It throws
  on a non-`pubky` scheme, a host that is not a valid 52-char z32 `PubkyId`, a path outside `/pub`, an
  app other than `pubky.app`, fewer than 2 path segments, or a `follows`/`mutes` id that is not a valid
  `PubkyId`. An unknown resource segment returns `resource: "unknown"` without throwing.
- **Rust** ([`src/uri/`](https://github.com/pubky/pubky-app-specs/tree/main/src/uri)):
  - `ParsedUri::try_from(&str)` → `{ user_id: PubkyId, resource: Resource }`, with
    `Resource ∈ User | Post(id) | Follow(PubkyId) | Mute(PubkyId) | Bookmark(id) | Tag(id) | File(id) | Blob(id) | Feed(id) | LastRead | Unknown`.
    `try_to_uri_str()` returns `Err` for `Unknown`; `Resource::id()` gives the ID.
  - `PubkyAppObject::from_uri(uri, blob)` / `from_resource(&resource, blob)` parse and validate a
    homeserver body into the typed model; `Err` for `Unknown`.
  - `try_parse_pubky_path(uri)` → `PubkyPath { user_id, app, segments }` for any `/pub/<app>/...`.
    `is_pubky_scheme(scheme)` is case-insensitive.
  - `ExtendedParsedUri` is for **ingest**: `PubkyApp { user_id, resource }` or
    `UniversalTag { user_id, app, resource: Tag(id) }`. The second accepts cross-app tags at
    `pubky://<id>/pub/<other-app>/tags/<tag_id>`; any other non-`pubky.app` path is `Err`.

## Object IDs

IDs use **Crockford** Base32. Source comments saying "Z-base32" are wrong; only `PubkyId` is z-base-32.

### Timestamp IDs (Post, File)

- **Create:** current time in **microseconds** (`i64`) → 8 big-endian bytes → Crockford Base32 =
  **13 characters**.
- **Validate** (`validate_crockford_id`): 13 characters decoding to exactly 8 bytes; timestamp
  ≥ `1727740800000000` (2024-10-01T00:00:00Z) and ≤ **now + 2h**. Errors: `...timestamp must be after
  October 1st, 2024`, `...timestamp is too far in the future`.

> **Gotcha: JS can produce duplicate IDs.** In WASM the clock is `Date.now() * 1000` (millisecond
> precision). Two `createPost`/`createFile` calls in the same millisecond return the **same ID**
> (reproduced: both `0035QAMNW87E0`), and writing the second silently overwrites the first. In batches,
> ensure each create lands in a different millisecond (e.g. `await` between them) or dedupe IDs.
> Native Rust uses `SystemTime` microseconds.

### Hash IDs (Tag, Bookmark, Feed, Blob)

- **Create:** Blake3 over the model's ID data, first 16 of 32 bytes, Crockford Base32 = **26 characters**.
- **Validate:** recomputed and must match, else `Invalid ID: expected X, found Y` (no
  `Validation Error: ` prefix).

| Model | Hashed input | Consequence |
| :-- | :-- | :-- |
| Tag | `"{uri}:{label}"` after sanitizing (label trimmed + lowercased, URI normalized via `Url::parse`) | Same tag on the same target → same path; tagging is idempotent |
| Bookmark | `uri` as given (not normalized) | Re-bookmarking the same URI writes the same path; `created_at` is not in the ID |
| Feed | `serde_json::to_string(&feed)`, the **config object only**, after sanitizing | `name`/`icon` not in the ID: rename or change icon without moving it. Identical configs share one path. `domain_tags: None` is skipped in serialization, so feeds without it keep their old IDs |
| Blob | raw bytes | Content-addressed |

Test vectors (confirmed in Rust and npm 0.7.0), with `uri = post_uri_builder("user_id", "post_id")`:

- `tag(uri, "cool")` → `CBYS8P6VJPHC5XXT4WDW26662W`
- `bookmark(uri)` → `2GN0JCHX9NYXPECQDS8KSMSE7M`
- `blob([1, 2])` → `PZBQ010FF079VVZPQG1RNFN6DR`

## Validation lifecycle

- **Rust `Validatable::try_from(bytes, id)`**: `serde_json::from_slice` → `sanitize()` →
  `validate(Some(id))`, returning `Result<Self, String>`. `String` is not `std::error::Error`, so a bare
  `?` into `anyhow` does not compile; use `.map_err(anyhow::Error::msg)?`. Blob overrides this to take
  raw bytes, not JSON.
- **JS `Model.fromJson(obj)`** runs sanitize + validate with `None` for the ID, so **the ID is not checked**.
- **Builder `create*` methods** throw the error string. Most model-validation errors start with
  `Validation Error: `; hash-ID mismatches, enum parse errors (`Invalid collection layout: …`,
  `Invalid content kind: …`, `Invalid feed reach: …`) and serde/tsify errors (``missing field `icon` ``)
  do not. Don't match on the prefix.
- **`sanitize()`** trims strings and normalizes URLs (an invalid URL is kept, trimmed, so validation
  rejects it). It also lowercases tag labels and feed icons/tags and drops empty feed tags. It **does not
  truncate**, with one exception: `File.src` is cut to 1024 characters and set to `""` if not a valid URL
  (then fails with `Invalid src`); `src` is not URL-normalized.
- **JSON nulls differ by SDK. Readers must accept both forms** (a missing optional field reads as `None`):
  - Rust `serde_json` writes top-level `None` fields as `null`: Post `parent`/`embed`/`attachments`,
    User `bio`/`image`/`links`/`status`, Feed config `tags`/`content`. Omitted when `None`: `lock`,
    `icon`, `domain_tags`, and the collection envelope's `description`/`cover_image`/`layout`.
  - JS `.toJson()` **omits** every `None` field, e.g. `{"content":"hi","kind":"short"}`.

## Models

Field lists are summaries; exact definitions are in
[`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models).

### PubkyAppUser

`{ name, bio?, image?, links?: [{ title, url }], status? }`. Default name `"anonymous"`.

- `name` 3–50 characters. `bio` ≤ 160. `status` ≤ 50.
- `image`: non-empty, ≤ 300, valid URL.
- `links` ≤ 5 entries; each `title` non-empty after trimming and ≤ 100; each `url` non-empty, ≤ 300, valid URL.
- `name: "[DELETED]"` is **rewritten to `"anonymous"`** by sanitize, not rejected.

### PubkyAppPost

`{ content, kind, parent?, embed?: { kind, uri }, attachments?: string[], lock? }`. Rust:
`PubkyAppPost::new(content, kind, parent, embed, attachments)` or `new_with_lock(..., lock)`.

- **`kind`** is lowercase on the wire: `short` (default), `long`, `image`, `video`, `link`, `file`,
  `collection`. Anything else deserializes to `Unknown` and validation **rejects** it (for both `kind`
  and `embed.kind`). Rust `FromStr` is strict.
  - JS `PubkyAppPostKind.*` values are **numeric** enums.
  - WASM `post.kind` getter returns a capitalized name (`"Long"`), but `toJson().kind` is lowercase
    (`"long"`). Always write `toJson()`.
- **Replies:** `parent` = parent post's `pubky://` URI. **Reposts:** `embed = { kind, uri }`. Both must
  pass `Url::parse`.
- **Validation order:**
  1. ID, if given.
  2. Reject if `content.trim()` is empty **and** `embed` is `None` **and** `attachments` is `None`.
  3. Reject content exactly `[DELETED]` after trimming.
  4. Reject `Unknown` kinds.
  5. Check `lock`.
  6. If `kind` is `collection`: run the collection rules and stop.
  7. Content limit: **`long` 50000 characters, every other kind 2000**.
  8. `parent` and `embed.uri` via `Url::parse`.
  9. Attachments: **≤ 10**, each non-empty, ≤ 200 characters, valid URL with scheme `pubky`, `http` or
     `https` (case-insensitive).
- **Gotcha:** step 2 uses `attachments.is_none()`, so `content: ""` with `attachments: []` **passes**
  and is stored with `"attachments":[]`. Pass `null` (field omitted) when there are no attachments, and
  reject empty posts in your own UI.

```js
import { Pubky, Keypair, PublicKey } from "@synonymdev/pubky";
import { PubkySpecsBuilder, PubkyAppPostKind } from "pubky-app-specs";

const pubky = Pubky.testnet();
const signer = pubky.signer(Keypair.random());
const homeserverPk = "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo"; // static testnet homeserver
await signer.signup(PublicKey.from(homeserverPk), null); // returns void
const session = await signer.signin("myapp.example");

// Builder takes the RAW 52-char z32 id, not the `pubky`-prefixed toString() form.
const specs = new PubkySpecsBuilder(session.info.publicKey.z32());

// Throws the validation error string on failure.
const { post, meta } = specs.createPost(
  "Hello, Pubky!",
  PubkyAppPostKind.Short,
  null, // parent URI (replies)
  null, // PubkyAppPostEmbed (reposts)
  null, // attachments: null omits the field; [] is stored and skips the empty-post check
);

// Write to meta.path (session-relative); meta.url is the pubky:// URI for references.
await session.storage.putJson(meta.path, post.toJson());
```

<sub>Adapted from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js) and [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md). Executed against a local testnet with `pubky-app-specs` 0.7.0 + `@synonymdev/pubky` 0.12.0 (`signup` returns `void`, `signin(clientId)` returns the session; older SDKs differ, see [`./sdk-js.md`](./sdk-js.md)). TypeScript: `meta.path` is typed `string` but `putJson` wants `Path`, so write `meta.path as Path`.</sub>

#### `lock` (optional, since 0.6.0)

- If present: non-empty, **≤ 200 characters**, parses as a URL, **`pubky://` scheme with a host**. The
  opaque form `pubky:lock-id` is rejected; an `https` URL fails with
  `Lock URL must use the pubky:// scheme`. Applies to every kind, including collections.
- Missing or `null` = **not locked**; consumers "must treat the post as a regular unlocked post". Nexus
  stores the field.
- **`lock` is only a schema field.** app-specs defines no lock-server protocol, no content gating and no
  encryption; the field only *advertises* protection, and the post body is in public `/pub`. **Never**
  describe locked posts as private or encrypted. Encrypted/guarded data is not shipped (see
  [`./shipped-vs-planned.md`](./shipped-vs-planned.md)).

#### Collection posts (`kind: "collection"`)

- `parent`, `embed` and `attachments` must all be `None`; even `attachments: []` is rejected.
- `content` ≤ 40000 characters and must parse as JSON
  `{ name, description?, items: string[], cover_image?, layout? }`. Unknown extra keys are allowed.
  - `name` 1–100 characters counted **before trimming**; cannot be only whitespace.
  - `description` ≤ 500.
  - `cover_image` ≤ 200, parses as a URL, scheme `pubky`, `http` or `https`.
  - `items` **≤ 100**, each exactly `pubky://<52-char PubkyId>/pub/pubky.app/posts/<13-char Crockford id>`
    (structural check, not `Url::parse`).
- **`layout`** (since 0.6.2): `grid`, `list` or `visual`; absent means `grid`. Any other value
  deserializes to `Unknown` and **passes validation** (e.g. `fromJson` with `"masonry"`), so consumers
  must render unrecognized values as `grid`. The builder parses strictly:
  `createCollectionPost` throws `Invalid collection layout: masonry`.
- SPEC.md's example hosts `pubky://userA/...` **fail** validation. Always use real 52-char z32 IDs.

```js
const { post, meta } = specs.createCollectionPost(
  "AI papers",                // name 1-100
  "Best stuff",               // description <=500 or null
  [
    // exact canonical 94-char post URIs with a REAL 52-char z32 host
    "pubky://8kkppkmiubfq4pxn6f73nqrhhhgkb5xyfprntc9si3np9ydbotto/pub/pubky.app/posts/0034A0X7NJ52A",
  ],
  null,                       // cover_image (pubky/http/https, <=200)
  "visual",                   // layout: "grid" | "list" | "visual" (null = omitted = grid)
);
await session.storage.putJson(meta.path, post.toJson());
```

<sub>Executed against a local testnet with `pubky-app-specs` 0.7.0 (`specs`/`session` as in the post example). The 5th `layout` argument needs ≥ 0.7.0; 0.5.3 silently ignores it.</sub>

`post.toJson()` has `kind: "collection"` and `content` holds the envelope as a JSON **string**.

### PubkyAppTag

`{ uri, label, created_at }`. Rust `new(uri, label)` sets `created_at` to now in microseconds.

- Sanitize trims and lowercases the label (`" Cool "` → `"cool"`) and normalizes the URI.
- Validation: label **1–20 characters**, **no Unicode whitespace** (`"two words"` fails with
  `contains whitespace characters`), none of `,` `:` space, tab, `\n`, `\r`. `uri` must pass `Url::parse`.
- The crate's `sanitize_tag_label`/`validate_tag_label` are **not reachable** by consumers (private
  module, not re-exported, no WASM export). Mirror the rules in client input checks: trim + lowercase,
  read `tagLabelMinLength`/`tagLabelMaxLength`/`tagInvalidChars` from the
  [validation limits](#validation-limits), and reject any Unicode whitespace.

### PubkyAppBookmark

`{ uri, created_at }`. Validation checks the ID and that `uri` passes `Url::parse`. ID = Blake3 of the
URI, so re-bookmarking the same URI writes the same path.

### PubkyAppFollow and PubkyAppMute

Body is only `{ created_at }`; the **target user exists only in the path** (`follows/<pubky_id>`,
`mutes/<pubky_id>`). Validation only checks that the ID is a `PubkyId`. The builder's `meta.id` is the
target's ID: `createFollow(z32)` → path `/pub/pubky.app/follows/<z32>`, body `{"created_at": <micros>}`.
To unfollow/unmute, delete that path.

### PubkyAppFile and PubkyAppBlob

A file upload is **two writes**:

1. **Blob**: `PubkyAppBlob(Vec<u8>)`. Body is **raw bytes, not JSON**; ID = Blake3 of the bytes.
   Non-empty, **≤ 100 MB**.
2. **File**: JSON metadata `{ name, created_at, src, content_type, size }`, with `src` pointing at the blob.
   - `size` > 0 and ≤ 104857600 bytes (100 MB).
   - `name` 1–255 characters.
   - `src` non-empty, ≤ 1024 characters, valid URL.
   - `content_type` must parse as a MIME type whose base type is in `VALID_MIME_TYPES` (21 entries; JS
     `getValidMimeTypes()`). Parameters are allowed and stored unchanged (`image/png; charset=binary`
     is accepted). Not included: e.g. `image/heic`.

In JS `blob.data` is a `Uint8Array` but `blob.toJson()` is a plain **number array**. Write `blob.data`
with `putBytes`; never write a blob as JSON.

```js
import { PubkySpecsBuilder } from "pubky-app-specs";

// `session` from signer.signin(clientId); bytes is a Uint8Array.
async function uploadFile(session, bytes, name, contentType) {
  const specs = new PubkySpecsBuilder(session.info.publicKey.z32());

  // Blob body is RAW bytes, content-addressed by Blake3 — never JSON.
  const { blob, meta: blobMeta } = specs.createBlob(bytes);
  await session.storage.putBytes(blobMeta.path, blob.data);

  // File = JSON metadata pointing at the blob. contentType must be in getValidMimeTypes().
  const { file, meta } = specs.createFile(name, blobMeta.url, contentType, bytes.length);
  await session.storage.putJson(meta.path, file.toJson());
  return meta.url; // use as a post attachment / profile image
}
```

<sub>Based on the pubky-ai-kit "File Upload with Metadata" pattern and upstream `pkg/example.js`. Executed against a local testnet (blob bytes and file JSON read back identical) on `pubky-app-specs` 0.7.0 and 0.5.3.</sub>

### PubkyAppFeed

`{ feed: { tags?, domain_tags?, reach, layout, sort, content? }, name, icon?, created_at }`. The config
is **nested under `feed`**.

- **`reach`**: `following`, `followers`, `friends`, `all`, `wot`, `me`.
- **`layout`**: `columns`, `wide`, `visual`, `list`.
- **`sort`**: `recent`, `popularity`.
- **`content`**: optional post-kind filter. **Not** checked for `Unknown` during validation; the
  builder parses it strictly.
- **Validation:**
  - `name` non-empty after trimming.
  - `icon`, if present: non-empty, **≤ 50 characters**, only `[a-z0-9-]` after trim + lowercase.
    `" Mountain "` → `"mountain"`; `"my_icon"` fails with `contains invalid character: _`.
  - `tags` and `domain_tags`: **≤ 5** entries each, each passing the tag-label rules; trimmed,
    lowercased, empty entries removed.
- **`icon`** is a [Lucide](https://lucide.dev/icons/) icon name. The spec lists no valid names, so fall
  back to a default icon for unknown names. Missing or `null` icon is valid (older feeds); `""` is
  rejected. Rust `PubkyAppFeed::new(feed, name, icon: String)` **requires** an icon on create.
- Nexus has code for `wot` reach (with a depth) and `domain_tags` filtering, but nothing states that
  production Nexus or pubky.app use `wot`, `me`, `domain_tags` or `icon`. Treat them as unstable.

**Breaking change since 0.5.x:** JS `createFeed` takes **one `CreateFeedInput` object** with
**camelCase** keys and a **required `icon`** (omitting it throws ``missing field `icon` ``). Unknown keys
are ignored, so snake_case `domain_tags` is **silently dropped**: use `domainTags`. The stored JSON key
is still `domain_tags`.

```js
const { feed: wotFeed, meta: wotFeedMeta } = specsBuilder.createFeed({
  tags: ["rust"],
  reach: "wot",
  layout: "columns",
  sort: "recent",
  content: "image",
  name: "Rust WoT",
  domainTags: ["synonym"],
  icon: "users",
});
```

<sub>Verbatim from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js); `specsBuilder` is a `PubkySpecsBuilder`. Executed against a local testnet with `pubky-app-specs` 0.7.0 (0.5.3 has a positional `createFeed` instead).</sub>

Stored JSON (`created_at` in **microseconds**; SPEC.md's `1700000000` is seconds and wrong):

```json
{
  "feed": {
    "tags": ["crab", "rust"],
    "domain_tags": ["synonym"],
    "reach": "wot",
    "layout": "columns",
    "sort": "recent",
    "content": "video"
  },
  "name": "My Feed",
  "icon": "bitcoin",
  "created_at": 1700000000000000
}
```

### PubkyAppLastRead

`{ timestamp }` in Unix **milliseconds** (`new()` uses `timestamp()/1000`); must be > 0.

> **Unit split:** every `created_at` is **microseconds** (16 digits); `LastRead.timestamp` is
> **milliseconds** (13 digits). In JS use `new Date(timestamp)`. Upstream `pkg/example.js` divides by
> 1000, which yields a 1970 date.

## Validation limits

Read limits at runtime; don't copy numbers into code. Values change between releases; the current
values are in [`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs)
(28 keys as of crate 0.8.0 / npm 0.7.0, which match; the per-model numbers above reflect them).

- **JS:** `getValidationLimits()` (root export, returns a copy), the `builder.validationLimits` getter,
  or the **WASM-free** subpath `pubky-app-specs/validationLimits` (raw file:
  `pubky-app-specs/validationLimits.json`).
- **Rust:** `pubky_app_specs::VALIDATION_LIMITS` (`serde_json::to_value` it to ship to clients).

```js
import limits, {
  getValidationLimits,
  validationLimits,
} from "pubky-app-specs/validationLimits";

console.log(validationLimits.userNameMaxLength);
console.log(limits.postShortContentMaxLength);

const copy = getValidationLimits();
```

<sub>Executed on Node 24 with `pubky-app-specs` 0.7.0. The 0.5.3 subpath module fails to load on Node 22+ (`import ... assert { type: "json" }` syntax error); use ≥ 0.7.0.</sub>

JS key names (camelCase), by area:

| Area | Keys |
| :-- | :-- |
| User | `userNameMinLength`, `userNameMaxLength`, `userBioMaxLength`, `userImageUrlMaxLength`, `userLinksMaxCount`, `userLinkTitleMaxLength`, `userLinkUrlMaxLength`, `userStatusMaxLength` |
| Post | `postShortContentMaxLength`, `postLongContentMaxLength`, `postAttachmentsMaxCount`, `postAttachmentUrlMaxLength` (same 200 cap as `lock` and `cover_image`), `postAllowedAttachmentProtocols` |
| Collection | `collectionContentMaxLength`, `collectionNameMinLength`, `collectionNameMaxLength`, `collectionDescriptionMaxLength`, `collectionItemsMaxCount` |
| Tag | `tagLabelMinLength`, `tagLabelMaxLength`, `tagInvalidChars` |
| File / Blob | `fileNameMinLength`, `fileNameMaxLength`, `fileSrcMaxLength`, `maxFileSizeBytes`, `maxBlobSizeBytes` |
| Feed | `feedTagsMaxCount`, `feedIconMaxLength` |

**Unicode counting:** length limits count **Unicode scalar values** (`.chars().count()`), not bytes and
not JS UTF-16 `.length`. In client counters use `[...str].length`: a name of 50 `🔥` is valid although
`name.length === 100`. Grapheme clusters are not merged. `PubkyId` and Crockford ID checks count bytes
(fine, they are ASCII). Details:
[`docs/UNICODE_NOTES.md`](https://github.com/pubky/pubky-app-specs/blob/main/docs/UNICODE_NOTES.md).

## The `[DELETED]` keyword

`"[DELETED]"` is **reserved for indexers** such as Nexus. **Clients never write it.**

- **Posts:** Nexus sets this content for a post deleted from its homeserver that still has replies, tags
  or other links from other users. Clients match the exact string to render the post as deleted. Writing
  a post whose content is exactly `[DELETED]` (after trimming) fails with
  `Content cannot be the reserved keyword`.
- **Users:** Nexus uses it for a user whose `profile.json` was deleted. A client write of
  `name: "[DELETED]"` is **silently sanitized to `"anonymous"`**. SPEC.md's "Cannot be [DELETED]" states
  the intent, not the code's behavior.

## Builder and crate APIs

### JS: `PubkySpecsBuilder`

Full API: [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md).
`new PubkySpecsBuilder(z32)` throws unless given a raw 52-char z32 ID. Each `create*` returns
`{ <model>, meta: { id, path, url } }`, where `url = "pubky://" + builderId + path` and `id` is `""` for
User and LastRead. Write `putJson(meta.path, model.toJson())`; use `putBytes` for blobs. Trailing
optional arguments may be omitted.

| Method | Notes |
| :-- | :-- |
| `createUser(name, bio?, image?, links?, status?)` | `links` is `{title,url}[]` or `null` |
| `createPost(content, kind, parent?, embed?, attachments?, lock?)` | `kind` is `PubkyAppPostKind.*` |
| `editPost(originalPost, postId, newContent)` | Keeps the ID; re-sanitizes and re-validates |
| `createCollectionPost(name, description?, items?, cover_image?, layout?)` | `layout` is `'grid' \| 'list' \| 'visual'` |
| `createFeed(input: CreateFeedInput)` | One camelCase object; `icon` required |
| `createFile(name, src, contentType, size)` | Timestamp ID |
| `createTag(uri, label)` / `createBookmark(uri)` | Hash IDs |
| `createFollow(followeeId)` / `createMute(muteeId)` | Raw z32 target |
| `createLastRead()` | Result key is `last_read` |
| `createBlob(bytes)` | `Uint8Array` or `number[]` |

### Rust crate

Docs: [docs.rs/pubky-app-specs](https://docs.rs/pubky-app-specs) (full export list). MSRV **1.89**.
The `openapi` feature derives `utoipa::ToSchema`:
`pubky-app-specs = { version = "0.8", features = ["openapi"] }`.

- **Crate root** re-exports the `PubkyApp*` models and their enums, `PubkyAppObject`, `PubkyId`,
  `VALIDATION_LIMITS`, `VALID_MIME_TYPES`, `validate_crockford_id`, the path constants, the URI
  builders and the URI parsing types listed above.
- **Traits:** `use pubky_app_specs::traits::{Validatable, TimestampId, HashId, HasPath, HasIdPath};`.
  `create_path()` for fixed-path models, `create_path(id)` for models with IDs.
- **`pubky` version:** app-specs 0.8.0 depends on `pubky` 0.10. An app on `pubky` 0.12 compiles both
  versions side by side (harmless), but their key types are not interchangeable; see
  [`PubkyId`](#pubkyid-raw-z32-only).

```rust
use pubky::{ClientId, Keypair, Pubky, PublicKey};
use pubky_app_specs::{traits::HasPath, traits::Validatable, PubkyAppUser};
use serde_json::to_vec;

let pubky = Pubky::new()?;
let signer = pubky.signer(Keypair::random());
signer.signup(&homeserver, None).await?;
let session = signer.signin(ClientId::new("pubky.app")?).await?;

let user_profile = PubkyAppUser::new("Test User".to_string(), None, None, None, None);
let path = PubkyAppUser::create_path(); // /pub/pubky.app/profile.json
session.storage().put(&path, to_vec(&user_profile)?).await?;

let bytes = session.storage().get(&path).await?.bytes().await?;
let retrieved = <PubkyAppUser as Validatable>::try_from(&bytes, "")
    .map_err(anyhow::Error::msg)?;
```

<sub>Shortened from upstream [`examples/create_user.rs`](https://github.com/pubky/pubky-app-specs/blob/main/examples/create_user.rs) (upstream uses `pubky` 0.10 and `.expect(...)`). Fragment: `homeserver` is a `PublicKey`, inside an `async fn` returning `anyhow::Result`. Verified with `pubky` 0.12.0 + `pubky-app-specs` 0.8.0: passes `clippy -D warnings`, and executed against a local testnet with `Pubky::testnet()` in place of `Pubky::new()` (which targets mainnet). Stored body: `{"name":"Test User","bio":null,"image":null,"links":null,"status":null}`.</sub>

## Doc-vs-code drift

The Rust code is correct. Do not copy these errors from other sources.

| Source says | Rust code (correct) |
| :-- | :-- |
| SPEC.md header "_Version 0.7.0_" | Crate 0.8.0 (npm `latest` 0.7.0) |
| SPEC.md File: "Max size is 10Mb" | 100 MB (`maxFileSizeBytes`); same cap for Blob |
| SPEC.md Feed example `created_at: 1700000000` | Microseconds |
| SPEC.md attachments rule | Also ≤ 10 entries, ≤ 200 characters each, `pubky`/`http`/`https` scheme |
| SPEC.md Tag label | Also ≥ 1 character; bans `,` `:` and whitespace |
| SPEC.md collection example hosts `userA`/`userB` | Fail validation; use 52-char z32 IDs |
| SPEC.md User name "cannot be [DELETED]" | Rewritten to `anonymous`, not rejected |
| Source comments: IDs are "Z-base32" | Crockford Base32 |
| `pkg/example.js` LastRead `timestamp / 1000` | Already milliseconds; use `new Date(timestamp)` |
| pubky-ai-kit: `createFeed` with 6 positional args, "Attachments: Max 4", no `list` layout, no `wot`/`me` reach, no `lock`/`cover_image`/`layout` | Single-object `createFeed` with required `icon`; 10 attachments; all fields on this page |
| pubky-ai-kit tag ID `FPB0AM9S93Q3M1GFY1KV09GMQM` | Only an example path from a doc comment, not a tested vector |

## Upstream references

- **Rust models (source of truth):** [`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models),
  [`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs),
  [`src/traits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/traits.rs),
  [`src/types.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/types.rs),
  [`src/uri/`](https://github.com/pubky/pubky-app-specs/tree/main/src/uri)
- **Spec (secondary, drifted):** [`SPEC.md`](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md)
- **JS API:** [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md),
  [`pubky-app-specs` on npm](https://www.npmjs.com/package/pubky-app-specs)
- **Rust API:** [docs.rs/pubky-app-specs](https://docs.rs/pubky-app-specs)
- **Unicode:** [`docs/UNICODE_NOTES.md`](https://github.com/pubky/pubky-app-specs/blob/main/docs/UNICODE_NOTES.md)
