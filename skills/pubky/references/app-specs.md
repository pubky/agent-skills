# Data models (`pubky-app-specs`)

> **CANONICAL.** This is the single source of truth for the Pubky **on-wire data contract**: model fields,
> `/pub/pubky.app/` paths, Timestamp vs Blake3 Hash IDs, validation limits, the `[DELETED]`
> keyword, and the builder and crate APIs. Other skills **link** here; do not copy this content.

Related: identity, `pubky://` addressing, pkarr and the homeserver-write vs Nexus-read split are in
[`./concepts.md`](./concepts.md). The storage calls that `PUT`/`GET` these objects are in
[`./sdk-js.md`](./sdk-js.md) and [`./sdk-rust.md`](./sdk-rust.md). Nexus read API:
[`./nexus-api.md`](./nexus-api.md). Guardrails: [`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## Scope and stability

- **Use these specs only for Pubky social apps**, meaning apps that read or write `pubky.app` social data (profiles, posts and
  collections, follows, mutes, tags, bookmarks, feeds). Other apps should ignore `pubky-app-specs` and define their own
  schemas under their own `/pub/<app>/` prefix.
- **Versions (checked 2026-10-26):** crate **0.8.1** and npm `latest` **0.8.1** were both published on 2026-09-24. The
  crate's `.cargo_vcs_info.json` names commit `86a561e`. npm records no commit, and there is no git tag, so "same commit"
  is inferred for npm (same day, same version bump). npm skipped 0.8.0 (it went 0.7.0 → 0.8.1). The only model change
  from 0.8.0 to 0.8.1 is the feed layout **`cards`** (see [PubkyAppFeed](#pubkyappfeed)).
- **Consumers:** Nexus `main` pins `pubky-app-specs` **0.7.0** (`openapi` feature). The pubky.app frontend uses npm
  **0.8.1**. Don't assume every reader knows the newest enum values.
- **Unstable, v0.x.** Upstream says "Rapid Development Phase ... Consider this a v0 draft". Model shapes, limits and the
  `/pub/pubky.app/` layout can break between releases. Upstream plans to move paths to `pubky.app/v1/` at the first
  long-term-support release. Read limits at runtime ([Validation limits](#validation-limits)); don't hard-code the
  numbers on this page.
- **Everything here is public `/pub` data.** Nothing on this page is private or encrypted.
- **Source of truth:** the Rust code in [`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models).
  [`SPEC.md`](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md) has drifted from it
  ([Doc-vs-code drift](#doc-vs-code-drift)). When they disagree, follow the Rust code.

## Paths and URIs

Constants: `PROTOCOL = "pubky://"`, `PUBLIC_PATH = "/pub/"`, `APP_PATH = "pubky.app/"`,
`VERSION = env!("CARGO_PKG_VERSION")` (Rust only). Path = `PUBLIC_PATH + APP_PATH + segment + id`.
Full URI = `pubky://<author z32>` + path.

| Model | Path | ID kind | Indexed by Nexus |
| :-- | :-- | :-- | :-- |
| `PubkyAppUser` | `/pub/pubky.app/profile.json` | none (fixed path) | yes |
| `PubkyAppLastRead` | `/pub/pubky.app/last_read` | none (fixed path) | **no** |
| `PubkyAppPost` | `/pub/pubky.app/posts/<id>` | Timestamp | yes |
| `PubkyAppFile` | `/pub/pubky.app/files/<id>` | Timestamp | yes |
| `PubkyAppTag` | `/pub/pubky.app/tags/<id>` | Blake3 hash | yes |
| `PubkyAppBookmark` | `/pub/pubky.app/bookmarks/<id>` | Blake3 hash | yes |
| `PubkyAppFeed` | `/pub/pubky.app/feeds/<id>` | Blake3 hash | **no** |
| `PubkyAppBlob` | `/pub/pubky.app/blobs/<id>` | Blake3 hash (of raw bytes) | **no** |
| `PubkyAppFollow` | `/pub/pubky.app/follows/<pubky_id>` | target user's PubkyId | yes |
| `PubkyAppMute` | `/pub/pubky.app/mutes/<pubky_id>` | target user's PubkyId | yes |

> **Write only at the exact `meta.path` the builder returns.** The Nexus watcher re-serializes each parsed URI and
> ignores the event unless the result equals the original URI exactly. For example, `posts/<id>/extra` is a
> "non-canonical path" and is dropped. The watcher also **skips LastRead, Feed and Blob events**, so Nexus never sees
> feeds, `last_read` or blobs. Clients read those directly from the homeserver.

### `PubkyId`: raw z32 only

A `PubkyId` must be exactly 52 bytes of valid z-base-32. A wrong length fails with
`Validation Error: the string is not 52 utf chars`; bad characters fail with
`Validation Error: invalid public key encoding`. Native Rust also parses it as a `pubky::PublicKey`.
The **`pubky`-prefixed display form is rejected** (wrong length). This applies to `new PubkySpecsBuilder(...)`,
`createFollow`, `createMute`, URI hosts and collection items.

- JS: pass `session.info.publicKey.z32()`. **Never** pass `.toString()`, which is for display only.
- Rust: `From<pubky::PublicKey>`, `From<pubky::Keypair>` and `to_public_key()` use **`pubky` 0.10** types, because
  app-specs 0.8.1 still depends on `pubky = "0.10.0"`. The current `pubky` (0.16.2) has a different key type, so
  `PubkyId::from(pk)` fails with E0277. Convert through the z32 string. Both `pubky` versions then compile side by side
  in `Cargo.lock`, which is harmless.

```rust
use pubky_app_specs::PubkyId;

let pk = session.info().public_key().clone();
// Not `PubkyId::from(pk)`: E0277 across pubky versions.
let id = PubkyId::try_from(&pk.z32()).map_err(anyhow::Error::msg)?;
```

<sub>Passes `clippy -D warnings` and was executed against a local testnet with `pubky` =0.12.0 + `pubky-app-specs` =0.8.1. A negative build with `PubkyId::from(...)` gave E0277, as the comment says. The `pubky` 0.16.2 API (`session.info().public_key()`, `PublicKey::z32()` returning raw z-base-32) was checked against source but not executed. `try_from` here is an inherent `fn(&str) -> Result<Self, String>`. `String` is not `std::error::Error`, so the code uses `map_err(anyhow::Error::msg)`.</sub>

### URI helpers

- **Builders** (Rust snake_case, JS camelCase): `base_uri_builder(user_id)` returns `pubky://<id>/pub/pubky.app/`.
  Each model also has a `*_uri_builder(author_id[, id])`: `user`, `post`, `follow`, `mute`, `bookmark`, `tag`,
  `file`, `blob`, `feed`, `last_read`. **Builders only concatenate strings and don't validate their inputs**, so
  validate IDs yourself.
- **JS `parse_uri(uri)`** returns a WASM class instance (`ParsedUriResult`) with getters `user_id`, `resource` and
  `resource_id`. It is not a plain object: `JSON.stringify(parse_uri(...))` prints `{__wbg_ptr}`, so read the getters.
  - A post URI gives `resource: "posts"` and `resource_id: "<id>"`.
  - `profile.json` gives `resource_id: undefined` (not `null`).
  - An unknown segment (`/pub/pubky.app/foo/bar`) gives `resource: "unknown"` without throwing.
  - It throws for: a non-`pubky` scheme; a host that is not a valid 52-char `PubkyId`; a path outside `/pub`; a
    different app (`Expected app path 'pubky.app' but got 'other.app' ...`); fewer than 2 path segments
    (`Not enough path segments`); a `follows`/`mutes` ID that is not a valid `PubkyId`.
- **Rust** ([`src/uri/`](https://github.com/pubky/pubky-app-specs/tree/main/src/uri)):
  - `ParsedUri::try_from(&str)` returns `{ user_id: PubkyId, resource: Resource }`, with
    `Resource ∈ User | Post(String) | Follow(PubkyId) | Mute(PubkyId) | Bookmark | Tag | File | Blob | Feed (String ids) | LastRead | Unknown`.
    `Resource::id()` returns `Option<String>`. `try_to_uri_str()` returns `Err` for `Unknown`.
  - `PubkyAppObject::from_uri(uri, blob)` and `from_resource(&resource, blob)` run `Validatable::try_from` with the ID
    from the path and return a typed, validated model. They return `Err` for `Unknown`.
  - `try_parse_pubky_path(uri)` returns `PubkyPath { user_id, app, segments }` for any `/pub/<app>/...` path.
    `is_pubky_scheme(scheme)` is case-insensitive.
  - `ExtendedParsedUri` (for **ingest**) returns either `PubkyApp { user_id, resource }` or
    `UniversalTag { user_id, app, resource: Tag(id) }`. `UniversalTag` matches only
    `pubky://<id>/pub/<other-app>/tags/<tag_id>`, with exactly two segments after the app. Any other non-`pubky.app`
    path returns `Err("URI is not a recognized universal tag path")`. Nexus `main` indexes universal tags. Their body
    is still a `PubkyAppTag`, validated against its Blake3 ID.

## Object IDs

IDs use **Crockford** Base32. Source comments that say "Z-base32" are wrong. Only `PubkyId` is z-base-32.

### Timestamp IDs (Post, File)

- **Create:** current time in **microseconds** (`i64`), as 8 big-endian bytes, encoded in Crockford Base32. The result
  is **13 characters**.
- **Validate:** `validate_crockford_id` requires 13 valid Crockford characters that decode to 8 bytes.
  `TimestampId::validate_id` also requires a timestamp of at least `1727740800000000` (2024-10-01T00:00:00Z) and at most
  **now + 2h**. Errors: `...timestamp must be after October 1st, 2024` and `...timestamp is too far in the future`.

> **Gotcha: JS produces duplicate IDs.** In WASM the clock is `Date.now() * 1000`, so it only has millisecond precision.
> In a tight loop, 2000 `createPost` calls gave only 8 unique IDs, and 200 `createFile` calls gave 198 duplicates
> (npm 0.8.1). A duplicate ID means the same path, so the second write **silently overwrites** the first. Make each
> create land in a different millisecond (for example, `await` between creates) or dedupe the IDs. Native Rust uses
> `SystemTime` microseconds.

### Hash IDs (Tag, Bookmark, Feed, Blob)

- **Create:** Blake3 over the model's ID data. The first 16 of the 32 bytes are encoded in Crockford Base32, giving
  **26 characters**.
- **Validate:** the ID is recomputed and must match. Otherwise the error is `Invalid ID: expected X, found Y`, with no
  `Validation Error: ` prefix.

| Model | Hashed input | Consequence |
| :-- | :-- | :-- |
| Tag | `"{uri}:{label}"` after sanitize (label trimmed and lowercased, URI normalized via `Url::parse`) | Same target and same label give the same path, so tagging is idempotent |
| Bookmark | `uri` exactly as given (no sanitize, so not normalized) | Re-bookmarking the same URI string writes the same path; `created_at` is not part of the ID |
| Feed | `serde_json::to_string(&feed)`: the **config object only** | `name` and `icon` are not in the ID. Identical configs share one path; changing `layout` (or any config field) changes the ID. `domain_tags: None` is skipped in serialization |
| Blob | raw bytes | Content-addressed |

Test vectors (npm 0.8.1), with `uri = postUriBuilder("user_id", "post_id")`:

- `createTag(uri, "cool").meta.id` returns `CBYS8P6VJPHC5XXT4WDW26662W`
- `createBookmark(uri).meta.id` returns `2GN0JCHX9NYXPECQDS8KSMSE7M`
- `createBlob([1, 2]).meta.id` returns `PZBQ010FF079VVZPQG1RNFN6DR`

## Validation lifecycle

- **Rust `Validatable::try_from(bytes, id)`** runs `serde_json::from_slice`, then `sanitize()`, then
  `validate(Some(id))`, and returns `Result<Self, String>`. A bare `?` into `anyhow` won't compile; use
  `.map_err(anyhow::Error::msg)?`. Blob overrides `try_from` to take raw bytes instead of JSON. If you call
  `validate()` directly, call `sanitize()` first: the trim-based rules (for example `[DELETED]` "after trim") depend on it.
- **JS `Model.fromJson(obj)`** runs sanitize and then validate with `None` as the ID, so **the ID is not checked**.
- **Builder `create*` methods** sanitize, compute the ID, run `validate(Some(id))`, and throw the error string.
- **Don't match on error prefixes.** Most model errors start with `Validation Error: `. These don't:
  - hash-ID mismatches (`Invalid ID: ...`)
  - `FromStr` enum errors (`Invalid content kind: x`, `Invalid feed layout: spiral`, `Invalid feed reach: x`,
    `Invalid feed sort: x`, `Invalid collection layout: masonry`)
  - serde/tsify errors (``Error: Error: missing field `icon` ``, `` Error parsing js object: Error: unknown variant ... ``)
- **`sanitize()`** trims strings and normalizes URLs. An invalid URL is kept (trimmed), and validation then rejects it.
  Sanitize also lowercases tag labels, feed icons and feed tags, drops empty feed tags, and rewrites a user `name` of
  `[DELETED]` to `anonymous`. It **does not truncate**, except for `File.src` (see below).
- **Stored JSON has `null`s; readers must accept both `null` and a missing field** as `None`.
  - Both SDKs write top-level `None` fields as `null`: Post `parent`/`embed`/`attachments`, User
    `bio`/`image`/`links`/`status`, Feed config `tags`/`content`. JS `.toJson()` keeps those keys with value
    `undefined`, and `session.storage.putJson` converts them to `null`. So a JS-written post is stored as
    `{"attachments":null,"content":"Hello, Pubky!","embed":null,"kind":"short","parent":null}`.
  - Only `JSON.stringify(model.toJson())` drops them. Don't treat that output as what is stored.
  - Fields **omitted** when `None` (in both SDKs): post `lock`, feed `icon`, `domain_tags`, and the collection
    envelope's `description`/`cover_image`/`layout`.

## Models

Field lists are summaries. The exact definitions are in
[`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models). The limit numbers below are for 0.8.1;
read them at runtime ([Validation limits](#validation-limits)).

### PubkyAppUser

`{ name, bio?, image?, links?: [{ title, url }], status? }`. The default name is `"anonymous"`.

- `name` 3–50 characters. `bio` ≤ 160. `status` ≤ 50.
- `image`: non-empty, ≤ 300, passes `Url::parse`.
- `links` ≤ 5 entries. Each `title` is non-empty after trim and ≤ 100. Each `url` is non-empty, ≤ 300 and passes
  `Url::parse`.
- `name: "[DELETED]"` is **rewritten to `"anonymous"`**, not rejected (see [`[DELETED]`](#the-deleted-keyword)).

### PubkyAppPost

`{ content, kind, parent?, embed?: { kind, uri }, attachments?: string[], lock? }`. In Rust, use
`PubkyAppPost::new(content, kind, parent, embed, attachments)` or `new_with_lock(..., lock)`, and
`PubkyAppPostKind::is_known()`.

- **`kind`** is lowercase on the wire: `short` (default), `long`, `image`, `video`, `link`, `file`, `collection`. Any
  other value deserializes to `Unknown` (`#[serde(other)]`), and validation **rejects** it with `post kind is unknown`
  or `embed kind is unknown`. Rust `FromStr` is strict (`Invalid content kind: x`).
  - JS `PubkyAppPostKind` is a **numeric** enum: `Short=0` through `Collection=6`, then `Unknown=7`.
  - The WASM `post.kind` getter returns `"Long"`, but `toJson().kind` is `"long"`. Always write `toJson()`.
- **Replies:** set `parent` to the parent post's `pubky://` URI (`meta.url`, **not** `meta.path`).
- **Reposts:** set `embed = new PubkyAppPostEmbed(uri, kind)`. In JS the constructor argument order is **(uri, kind)**.
  A repost with `content: ""` and an embed is valid by design.
- **Edit:** `editPost(originalPost, postId, newContent)` keeps the ID and path, then re-sanitizes and re-validates with
  `validate(Some(postId))`, so the timestamp-ID window still applies.
- **Gotcha: WASM arguments are consumed.** `createPost(..., embed)` and `editPost(originalPost, ...)` take their
  `PubkyAppPostEmbed`/`PubkyAppPost` arguments by value. wasm-bindgen moves them, so using `embed` (or `originalPost`)
  again afterwards throws `Error: null pointer passed to rust`. Build a new `PubkyAppPostEmbed` for each post, and
  call `originalPost.toJson()` before `editPost` if you still need it.
- **Validation order:**
  1. ID, if one is given.
  2. Reject if `content.trim()` is empty **and** `embed` is `None` **and** `attachments` is `None`.
  3. Reject content that is exactly `[DELETED]` (after sanitize trims it):
     `Validation Error: Content cannot be the reserved keyword '[DELETED]'`.
  4. Reject an `Unknown` kind or embed kind.
  5. Run the `lock` checks.
  6. If `kind` is `collection`, run the collection rules and stop.
  7. Content length: **`long` 50000 characters**; `short`/`image`/`video`/`link`/`file` **2000**.
  8. `parent` and `embed.uri` must pass `Url::parse`.
  9. Attachments: **≤ 10**. Each is non-empty, ≤ 200 characters, passes `Url::parse`, and uses the scheme `pubky`,
     `http` or `https` (case-insensitive).
- **Gotcha: `attachments: []` skips the empty-post check.** Step 2 checks `attachments.is_none()`, so
  `createPost("", Short, null, null, [])` **passes** and stores `content: ""` with `attachments: []`. Pass `null` when
  there are no attachments, and reject empty posts in your own UI.

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
  null, // attachments: null = none (putJson stores "attachments":null); [] is stored as [] and skips the empty-post check
);

// Write to meta.path (session-relative); meta.url is the pubky:// URI for references.
await session.storage.putJson(meta.path, post.toJson());
```

<sub>Adapted from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js) and [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md). Executed 2026-10-26 against a local testnet with `pubky-app-specs` 0.8.1 + `@synonymdev/pubky` 0.16.2, and with 0.7.0 + 0.12.0. Stored body: `{"attachments":null,"content":"Hello, Pubky!","embed":null,"kind":"short","parent":null}`. TypeScript: `meta.path` is typed `string` but `putJson` wants `Path`, so write `meta.path as Path`.</sub>

Replies, reposts, follow/unfollow and edits (`session` and `specs` as above; `targetZ32` is another user's raw z32):

```js
import { PubkyAppPostKind, PubkyAppPostEmbed } from "pubky-app-specs";

const tick = () => new Promise((r) => setTimeout(r, 2)); // JS timestamp IDs have ms precision

const { post: original, meta: originalMeta } = specs.createPost("Original", PubkyAppPostKind.Short);
await session.storage.putJson(originalMeta.path, original.toJson());
await tick();

// Reply: parent = the parent post's pubky:// URI (meta.url, not meta.path).
const { post: reply, meta: replyMeta } = specs.createPost("A reply", PubkyAppPostKind.Short, originalMeta.url);
await session.storage.putJson(replyMeta.path, reply.toJson());
await tick();

// Repost: embed { kind, uri }. Constructor argument order is (uri, kind).
const embed = new PubkyAppPostEmbed(originalMeta.url, PubkyAppPostKind.Short);
const { post: repost, meta: repostMeta } = specs.createPost("", PubkyAppPostKind.Short, null, embed);
await session.storage.putJson(repostMeta.path, repost.toJson());

// Follow = PUT follows/<target z32>; unfollow = DELETE the same path.
const { follow, meta: followMeta } = specs.createFollow(targetZ32);
await session.storage.putJson(followMeta.path, follow.toJson());
await session.storage.delete(followMeta.path);

// Edit keeps the original ID and path.
const { post: edited, meta: editedMeta } = specs.editPost(original, originalMeta.id, "Original (edited)");
await session.storage.putJson(editedMeta.path, edited.toJson());
```

<sub>Executed 2026-10-26 against a local testnet with `pubky-app-specs` 0.8.1 + `@synonymdev/pubky` 0.16.2 (and 0.7.0 + 0.12.0). The stored reply had `parent` equal to the original's `meta.url`. The repost was stored as `{"attachments":null,"content":"","embed":{"kind":"short","uri":...},"kind":"short","parent":null}`. `exists()` returned false after the delete, and the edited path equalled the original path. The 2 ms waits avoid the duplicate-ID overwrite. `embed` and `original` are consumed by the calls that take them; don't reuse them.</sub>

#### `lock` (optional, since 0.6.0)

- If present, `lock` must be non-empty, **≤ 200 characters**, parse as a URL, use the **`pubky://` scheme** (otherwise
  `Lock URL must use the pubky:// scheme`), and **have a host**. The opaque form `pubky:lock-id` fails with
  `Lock URL must include a host`. These rules apply to every kind, including collections.
- Missing or `null` means **not locked**. Nexus indexes the field and returns it as `lock` on `PostDetails`.
- **app-specs defines `lock` only as a schema field.** It defines no lock-server protocol, no gating and no encryption,
  and the post body itself sits in public `/pub`.
- **pubky.app's lock feature is an app convention, not part of the spec.** The announcement post's `lock` points at a
  public `lock.json`, the creator's `/pub/app.locks/<lockId>.json` on their own homeserver. Its schema (`LockFile`) is
  a contract defined by a separate Lock Server, which stores and proxies the guarded content. That content lives under
  homeserver `/priv`, at `/priv/app.locks/content/`, with reader copies under `/priv/social/unlocked/<lockId>/`.
  pubky.app also forbids `long` and `collection` announcements; that is an app rule, not a spec rule. **`/priv` is alpha
  and not for production.** It is access-controlled, **not encrypted**: the homeserver operator can read it.
- **Never** describe locked posts as private or encrypted. Encrypted or guarded data is not a shipped general primitive
  (see [`./shipped-vs-planned.md`](./shipped-vs-planned.md)).

#### Collection posts (`kind: "collection"`)

- `parent`, `embed` and `attachments` must all be `None`. Even `attachments: []` is rejected.
- `content` is ≤ 40000 characters and must JSON-parse to `{ name, description?, items: string[], cover_image?, layout? }`.
  Extra unknown keys are allowed.
  - `name`: 1–100 characters, counted **without trimming**. It can't be whitespace only.
  - `description` ≤ 500.
  - `cover_image`: ≤ 200, passes `Url::parse`, scheme `pubky`, `http` or `https`.
  - `items` **≤ 100**, and defaults to `[]` if the key is missing. Each item must be exactly
    `pubky://<52-char PubkyId>/pub/pubky.app/posts/<13-char Crockford id>`. This is checked by a structural string
    split, deliberately not `Url::parse`, and the post ID is not range-checked.
- **`layout`** (since 0.6.2) is `grid`, `list` or `visual`; absent means `grid`. Any other value deserializes to
  `Unknown` and **passes validation** (`fromJson` with `"masonry"` succeeds), so render unrecognized values as `grid`.
  The builder parses strictly: `createCollectionPost(..., "masonry")` throws `Invalid collection layout: masonry`.
- SPEC.md's example hosts (`pubky://userA/...`) **fail** validation. Use real 52-char z32 IDs.

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

<sub>Executed 2026-10-26 against a local testnet with `pubky-app-specs` 0.8.1 + `@synonymdev/pubky` 0.16.2 (and 0.7.0 + 0.12.0); `specs`/`session` as in the post example. The stored post has `kind: "collection"`, and `content` holds the envelope as a JSON **string**. The 5th `layout` argument needs ≥ 0.7.0.</sub>

### PubkyAppTag

`{ uri, label, created_at }`, with `created_at` in microseconds.

- Sanitize trims and lowercases the label and normalizes the URI with `Url::parse`.
- Validation: label **1–20 characters**, with **no Unicode whitespace** (`char::is_whitespace`). For example,
  `"two words"` fails with `Tag 'two words' contains whitespace characters`. The label also can't contain `,`, `:`,
  space, tab, `\n` or `\r`. `uri` must pass `Url::parse`.
- `sanitize_tag_label` and `validate_tag_label` can't be called from outside the crate: they live in a private module,
  aren't re-exported and have no WASM export. Mirror the rules in your client's input checks: trim and lowercase, read
  `tagLabelMinLength`/`tagLabelMaxLength`/`tagInvalidChars` from the [validation limits](#validation-limits), and reject
  any Unicode whitespace.
- Tags on other apps' resources (`/pub/<other-app>/tags/<id>`) are "universal tags" (see `ExtendedParsedUri` under
  [URI helpers](#uri-helpers)).

### PubkyAppBookmark

`{ uri, created_at }`. Validation checks the ID and that `uri` passes `Url::parse`. The ID is the Blake3 hash of `uri`
as given, so re-bookmarking the same URI string writes the same path.

### PubkyAppFollow and PubkyAppMute

The body is only `{ created_at }` (microseconds). The **target user exists only in the path** (`follows/<z32>`,
`mutes/<z32>`). Validation only checks that the path ID is a `PubkyId`. The builder's `meta.id` is the target's z32.
To unfollow or unmute, **delete that path** (see the reply/repost snippet above).

### PubkyAppFile and PubkyAppBlob

A file upload is **two writes**:

1. **Blob** (`PubkyAppBlob(Vec<u8>)`): the body is **raw bytes, not JSON**, and the ID is the Blake3 hash of the bytes.
   It must be non-empty and **≤ 100 MB** (`maxBlobSizeBytes = 104857600`).
2. **File**: JSON metadata `{ name, created_at, src, content_type, size }`, where `src` is the blob's `pubky://` URL.
   - `size` > 0 and ≤ 104857600.
   - `name` 1–255 characters.
   - `src` non-empty, ≤ 1024 characters, passes `Url::parse`. It is **not** URL-normalized.
   - `content_type` is parsed with `mime::Mime`, and its essence must be in `VALID_MIME_TYPES` (21 entries,
     [`src/models/file.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/models/file.rs); in JS,
     `getValidMimeTypes()`). Parameters are allowed and stored unchanged, so `image/png; charset=binary` is accepted.
     `image/heic` is rejected with `Invalid content type`.

> **Gotcha: `File.src` is silently truncated.** Sanitize trims `src`, **cuts it to 1024 characters**, and only then
> checks that it parses as a URL (otherwise it becomes `""` and fails with `Invalid src`). So a 2014-char https URL
> *succeeds* and stores a 1024-char prefix, which is a different, broken URL (verified on 0.8.1). Check `src` against
> `fileSrcMaxLength` yourself before calling `createFile`.

- In JS, `blob.data` is a `Uint8Array`. Write it with `putBytes`, never as JSON.
- The homeserver's tenant storage routes cap request bodies at 100 MB (`DefaultBodyLimit`), matching the blob cap.
  Operators can set lower quotas. pubky-ai-kit claims a 10 MB default per-request limit (returning 413), and says
  Synonym's public homeserver enforces 1 GB per user with a 10 MB per-file limit. Those numbers conflict with the code
  default and are **unverified**, so handle 413.

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

<sub>Based on the pubky-ai-kit "File Upload with Metadata" pattern and upstream `pkg/example.js`. Executed 2026-10-26 against a local testnet with `pubky-app-specs` 0.8.1 + `@synonymdev/pubky` 0.16.2 (and 0.7.0 + 0.12.0). The blob bytes read back identical via `getBytes`, and the file JSON was `{content_type, created_at, name, size, src: pubky://.../blobs/<26-char id>}`.</sub>

### PubkyAppFeed

`{ feed: { tags?, domain_tags?, reach, layout, sort, content? }, name, icon?, created_at }`, with `created_at` in
microseconds. The config is **nested under `feed`**.

- **`reach`**: `following`, `followers`, `friends`, `all`, `wot`, `me`.
- **`layout`**: `columns`, `wide`, `visual`, `list`, `cards`. `cards` is new in **0.8.1**; it is JS enum value 4,
  after `Columns=0 Wide=1 Visual=2 List=3`.
- **`sort`**: `recent`, `popularity`.
- **`content`**: optional `PubkyAppPostKind` filter. Validation doesn't reject `Unknown` here, but the builder parses it
  strictly.
- **Validation:**
  - `name` must be non-empty after trim.
  - `icon`, if present, must be non-empty, **≤ 50 characters**, and only `[a-z0-9-]` after trim and lowercase.
    `" Mountain "` becomes `"mountain"`; `"my_icon"` fails with `contains invalid character: _`.
  - `tags` and `domain_tags`: **≤ 5** entries each, and each must be a valid tag label. Entries are trimmed and
    lowercased, and empty entries are dropped.
- **`icon`** is a [Lucide](https://lucide.dev/icons/) icon name. The spec validates only its shape, because the client
  curates the icon set; fall back to a default for names you don't recognize. A missing or `null` icon is valid (legacy
  feeds), but `""` is rejected. Rust `PubkyAppFeed::new(feed, name, icon: String)` requires an icon.

> **Gotcha: feed enums are closed.** Post `kind` and collection `layout` have an `Unknown` fallback, but `reach`,
> `layout` and `sort` do **not**. `PubkyAppFeed.fromJson` with `layout: "masonry"` throws
> ``Error parsing js object: Error: unknown variant `masonry`, expected one of `columns`, `wide`, `visual`, `list`, `cards` ``.
> So **a `cards` feed fails to deserialize in any reader on `pubky-app-specs` ≤ 0.8.0**, including Rust crates pinned
> to 0.7.x (confirmed on 0.7.0). Nexus is unaffected only because it skips feed events. Write `cards` only if every
> reader of your users' feeds is on 0.8.1 or later.

**JS `createFeed` takes one `CreateFeedInput` object** with **camelCase** keys
`{ tags?, reach, layout, sort, content?, name, domainTags?, icon }`. `icon` is required: omitting it throws
``missing field `icon` ``. Snake_case `domain_tags` in the input is **silently dropped**, so use `domainTags`. The
stored JSON key is still `domain_tags`.

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

<sub>Verbatim from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js); `specsBuilder` is a `PubkySpecsBuilder`. Executed and written to a local testnet on 0.8.1 + 0.16.2 (and 0.7.0 + 0.12.0): stored `feed` had `"domain_tags":["synonym"]`, and the 26-char hash ID was identical on both versions.</sub>

```js
const { feed, meta } = specs.createFeed({
  tags: ["rust"],
  reach: "all",
  layout: "cards", // 0.8.1+: readers on older pubky-app-specs reject this feed
  sort: "recent",
  name: "Rust posts",
  icon: "layout-dashboard",
});
await session.storage.putJson(meta.path, feed.toJson());
```

<sub>Input lifted from the upstream [`pkg/test.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/test.js) cards round-trip test. Executed 2026-10-26 against a local testnet with `pubky-app-specs` 0.8.1 + `@synonymdev/pubky` 0.16.2. Stored `{"created_at":<micros>,"feed":{"content":null,"layout":"cards","reach":"all","sort":"recent","tags":["rust"]},"icon":"layout-dashboard","name":"Rust posts"}`. Rebuilding from the stored `json.feed` reproduces `meta.id`. On 0.7.0 the builder throws `Invalid feed layout: cards`.</sub>

### PubkyAppLastRead

`{ timestamp }` in Unix **milliseconds** (`new()` uses `timestamp()/1000`). It must be > 0. The path is
`/pub/pubky.app/last_read`, and the JS builder result key is `last_read`. Nexus doesn't index it.

> **Unit split:** every `created_at` is in **microseconds** (16 digits), but `LastRead.timestamp` is in
> **milliseconds** (13 digits). In JS, use `new Date(timestamp)`. Upstream `pkg/example.js` divides by 1000, which
> gives a 1970 date.

## Validation limits

Read limits at runtime; don't copy the numbers into code. The current values are in
[`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs): 28 keys in 0.8.1, unchanged since
0.8.0. The per-model numbers above reflect them.

- **JS:** `getValidationLimits()` (root export, returns a copy), the `builder.validationLimits` getter, the
  **WASM-free** subpath `pubky-app-specs/validationLimits` (default export plus named `validationLimits` and
  `getValidationLimits`), or the raw file `pubky-app-specs/validationLimits.json`.
- **Rust:** `pubky_app_specs::VALIDATION_LIMITS` (serializes as camelCase; `serde_json::to_value` it to ship the limits
  to clients).

```js
import limits, {
  getValidationLimits,
  validationLimits,
} from "pubky-app-specs/validationLimits";

console.log(validationLimits.userNameMaxLength);
console.log(limits.postShortContentMaxLength);

const copy = getValidationLimits();
```

<sub>Verbatim from upstream [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md). Executed on Node 24.22.1 with `pubky-app-specs` 0.8.1 (and 0.7.0): prints `50` and `2000`, and the copy has 28 keys.</sub>

JS key names (camelCase), by area:

| Area | Keys |
| :-- | :-- |
| User | `userNameMinLength`, `userNameMaxLength`, `userBioMaxLength`, `userImageUrlMaxLength`, `userLinksMaxCount`, `userLinkTitleMaxLength`, `userLinkUrlMaxLength`, `userStatusMaxLength` |
| Post | `postShortContentMaxLength`, `postLongContentMaxLength`, `postAttachmentsMaxCount`, `postAttachmentUrlMaxLength` (also caps `lock` and `cover_image`), `postAllowedAttachmentProtocols` |
| Collection | `collectionContentMaxLength`, `collectionNameMinLength`, `collectionNameMaxLength`, `collectionDescriptionMaxLength`, `collectionItemsMaxCount` |
| Tag | `tagLabelMinLength`, `tagLabelMaxLength`, `tagInvalidChars` |
| File / Blob | `fileNameMinLength`, `fileNameMaxLength`, `fileSrcMaxLength`, `maxFileSizeBytes`, `maxBlobSizeBytes` |
| Feed | `feedTagsMaxCount`, `feedIconMaxLength` |

**Unicode counting:** length limits count **Unicode scalar values** (`.chars().count()`), not bytes and not JS UTF-16
`.length`. In client counters, use `[...str].length`. For example, a name of 50 `🔥` is valid even though
`name.length === 100`. `PubkyId` and Crockford checks count bytes, which is fine because those strings are ASCII.
Details: [`docs/UNICODE_NOTES.md`](https://github.com/pubky/pubky-app-specs/blob/main/docs/UNICODE_NOTES.md).

## The `[DELETED]` keyword

**Clients never write `[DELETED]`.** The indexer uses it to mark posts that were deleted but still have relationships
from other users, and users whose `profile.json` was deleted.

**app-specs side (unchanged in 0.8.1):**

- A post whose content is exactly `[DELETED]` after sanitize is **rejected** with
  `Validation Error: Content cannot be the reserved keyword '[DELETED]'`.
- A user `name: "[DELETED]"` is **silently sanitized to `"anonymous"`**: `createUser("[DELETED]")` stores
  `"name":"anonymous"`.

**Nexus side: check both signals.** Nexus `main` has **replaced** the sentinel with a boolean `deleted` flag: for
users in #1009 (2026-09-24) and for posts in #1103 (2026-10-07). Neither change is in a release tag yet (the latest
Nexus tag is v0.3.1).

- A tombstone post has its content cleared, `kind` forced to `short`, `embed`/attachments/`lock` wiped, `parent`
  **kept**, and `deleted: true`.
- A tombstone user has `name` cleared and `deleted: true`.
- Migrations rewrite legacy `[DELETED]` rows. Older Nexus builds don't send `deleted` (treat a missing value as `false`)
  and still use the `[DELETED]` content or name.
- Treat a post or user as deleted when **`deleted === true` OR the content/name is exactly `"[DELETED]"`**. pubky.app
  does this, and treats tombstones as not-found when it validates a reply or repost parent. Field details:
  [`./nexus-api.md`](./nexus-api.md).

## Builder and crate APIs

### JS: `PubkySpecsBuilder`

Full API: [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md).
`new PubkySpecsBuilder(z32)` throws unless you pass a raw 52-char z32 ID. Each `create*` returns
`{ <model>, meta: { id, path, url } }`, where `url = "pubky://" + builderId + path`. `id` is `""` for User and
LastRead. Write each model with `putJson(meta.path, model.toJson())`, and blobs with `putBytes`. You can omit trailing
optional arguments.

| Method | Notes |
| :-- | :-- |
| `createUser(name, bio?, image?, links?, status?)` | `links` is `{title,url}[]` or `null` |
| `createPost(content, kind, parent?, embed?, attachments?, lock?)` | `kind` is `PubkyAppPostKind.*`; `embed` is `new PubkyAppPostEmbed(uri, kind)`, consumed by the call |
| `editPost(originalPost, postId, newContent)` | Keeps the ID; re-sanitizes and re-validates; consumes `originalPost` |
| `createCollectionPost(name, description?, items?, cover_image?, layout?)` | `layout` is `'grid' \| 'list' \| 'visual'`, parsed strictly |
| `createFeed(input: CreateFeedInput)` | One camelCase object; `icon` required |
| `createFile(name, src, contentType, size)` | Timestamp ID; `src` truncated at 1024 |
| `createTag(uri, label)` / `createBookmark(uri)` | Hash IDs |
| `createFollow(followeeId)` / `createMute(muteeId)` | Raw z32 target |
| `createLastRead()` | Result key is `last_read` |
| `createBlob(bytes)` | `Uint8Array` or `number[]` |

Also exported: `getValidationLimits`, `getValidMimeTypes`, `parse_uri`, and the `*UriBuilder` functions.

### Rust crate

Docs: [docs.rs/pubky-app-specs](https://docs.rs/pubky-app-specs) has the full export list. MSRV is **1.89**. The
`openapi` feature derives `utoipa::ToSchema`: `pubky-app-specs = { version = "0.8", features = ["openapi"] }`.

- **Crate root** re-exports the `PubkyApp*` models and their enums (`PubkyAppFeed{Config,Layout,Reach,Sort}`,
  `PubkyAppPost{CollectionContent,CollectionLayout,PostEmbed,PostKind}`, `PubkyAppUserLink`), `PubkyAppObject`,
  `PubkyId`, `VALIDATION_LIMITS`/`ValidationLimits`, `VALID_MIME_TYPES`, `validate_crockford_id`, the path constants,
  the URI builders, and `ExtendedParsedUri`/`ParsedUri`/`PubkyPath`/`Resource`/`is_pubky_scheme`/`try_parse_pubky_path`.
- **Traits:** `use pubky_app_specs::traits::{Validatable, TimestampId, HashId, HasPath, HasIdPath};`.
- **`pubky` version:** app-specs 0.8.1 depends on `pubky` 0.10, while the current release is 0.16.2. The key types
  don't interchange; see [`PubkyId`](#pubkyid-raw-z32-only).

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

<sub>Shortened from upstream [`examples/create_user.rs`](https://github.com/pubky/pubky-app-specs/blob/main/examples/create_user.rs), which uses `pubky` 0.10 and `.expect`. This is a fragment inside an `async fn` returning `anyhow::Result`; `homeserver` is a `pubky::PublicKey` (testnet key `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`; on 0.16.2 parse it with `PublicKey::try_from_z32(...)?`). Verified 2026-10-26 with `pubky` =0.12.0 (feature `json`) + `pubky-app-specs` =0.8.1: it passes `clippy -D warnings` as written, and it ran against a local testnet with `Pubky::testnet()?` in place of `Pubky::new()?` (mainnet). Stored body: `{"name":"Test User","bio":null,"image":null,"links":null,"status":null}`. The `pubky` 0.16.2 API used here (`Pubky::new`/`testnet`, `signup(&PublicKey, Option<&str>)`, `signin(ClientId)`, `storage().put`/`get`) was checked against source but not executed.</sub>

## Doc-vs-code drift

The Rust code is correct. Don't copy these errors from other sources.

| Source says | Rust code (correct) |
| :-- | :-- |
| SPEC.md File: "Max size is 10Mb" | 100 MB (`maxFileSizeBytes`); same cap for Blob |
| SPEC.md Feed example `created_at: 1700000000` | Microseconds |
| SPEC.md attachments: "Each must be a valid URI" | Also ≤ 10 entries, ≤ 200 characters each, `pubky`/`http`/`https` scheme |
| SPEC.md Tag label: max 20 | Also ≥ 1 character; bans `,`, `:` and whitespace |
| SPEC.md collection example hosts `pubky://userA/...` | Fail validation; use 52-char z32 IDs |
| SPEC.md User name "Cannot be [DELETED]" | Rewritten to `anonymous`, not rejected |
| Source comments: IDs are "Z-base32" | Crockford Base32 |
| `pkg/example.js` LastRead `timestamp / 1000` | Already milliseconds; use `new Date(timestamp)` |
| Earlier guidance: "clients match the exact `[DELETED]` string" | Also check Nexus `deleted === true` |
| Earlier guidance: "JS `.toJson()` omits `None` fields" | `putJson` stores them as `null`; only `JSON.stringify` omits them |
| pubky-ai-kit: `createFeed` with 6 positional args; layouts without `list`/`cards`; reach without `wot`/`me`; "Attachments: Max 4" | Single-object `createFeed` with required `icon`; all values on this page; 10 attachments |
| pubky-ai-kit placeholders `user_id`, `user_id_to_mute` | Throw in `parse_uri`/`createMute`/collection items; use real z32 |
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
- **pubky.app locks (app convention):** [`docs/locks.md`](https://github.com/pubky/pubky-app/blob/dev/docs/locks.md)
- **Concept overview (universal tags, scope):** [KB: pubky-app-specs](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-app-specs.md)
