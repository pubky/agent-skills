# Data models (`pubky-app-specs`)

> **CANONICAL.** This page is the single source of truth for the Pubky **on-wire data contract**: model fields,
> `/pub/pubky.app/` paths, Timestamp vs Blake3 Hash IDs, validation limits, the `[DELETED]` keyword, and the builder
> and crate APIs. Other skills **link** here and must not copy it.

Related pages: [`./concepts.md`](./concepts.md) covers identity, `pubky://` addressing, pkarr and the split between
homeserver writes and Nexus reads. The storage calls that `PUT` and `GET` these objects are in
[`./sdk-js.md`](./sdk-js.md) and [`./sdk-rust.md`](./sdk-rust.md). The Nexus read API is in
[`./nexus-api.md`](./nexus-api.md), and the guardrails are in [`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## Scope and stability

- **Use these specs only for Pubky social apps**, meaning apps that read or write `pubky.app` social data: profiles,
  posts and collections, follows, mutes, tags, bookmarks and feeds. Other apps should ignore `pubky-app-specs` and
  define their own schemas under their own `/pub/<app>/` prefix.
- **Versions (checked 2026-11-12):** the crate and npm `latest` are both **0.8.1**, published 2026-09-24. Upstream
  `main` is still at `86a561e` ("bump version to 0.8.1"). npm has no 0.8.0 release (0.7.0 went straight to 0.8.1). The
  only model change in 0.8.1 is the feed layout **`cards`** (see [PubkyAppFeed](#pubkyappfeed)).
- **Consumers:** Nexus `main` (2026-11-10) still pins `pubky-app-specs` **0.7.0** with the `openapi` feature. The latest
  Nexus tag is v0.3.1. The pubky.app frontend uses npm **0.8.1** with `@synonymdev/pubky` 0.17.1. Readers may not know
  the newest enum values.
- **Unstable, v0.x.** Upstream says "Rapid Development Phase ... Consider this a v0 draft". Model shapes, limits and the
  `/pub/pubky.app/` layout can break between releases. Upstream plans to move paths to `pubky.app/v1/` at the first
  long-term-support release. Read limits at runtime ([Validation limits](#validation-limits)) instead of hard-coding the
  numbers on this page.
- **All data on this page is public `/pub` data.** None of it is private or encrypted.
- **Source of truth:** the Rust code in [`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models).
  [`SPEC.md`](https://github.com/pubky/pubky-app-specs/blob/main/SPEC.md) has drifted from the code
  ([Doc-vs-code drift](#doc-vs-code-drift)). When they disagree, follow the Rust code.

## Paths and URIs

Constants: `PROTOCOL = "pubky://"`, `PUBLIC_PATH = "/pub/"`, `APP_PATH = "pubky.app/"`, and
`VERSION = env!("CARGO_PKG_VERSION")` (Rust only). A path is `PUBLIC_PATH + APP_PATH + segment + id`. A full URI is
`pubky://<author z32>` + path.

| Model | Path | ID kind | Indexed by Nexus `main` |
| :-- | :-- | :-- | :-- |
| `PubkyAppUser` | `/pub/pubky.app/profile.json` | none (fixed path) | yes |
| `PubkyAppLastRead` | `/pub/pubky.app/last_read` | none (fixed path) | **no** |
| `PubkyAppPost` | `/pub/pubky.app/posts/<id>` | Timestamp | yes |
| `PubkyAppFile` | `/pub/pubky.app/files/<id>` | Timestamp | yes |
| `PubkyAppTag` | `/pub/pubky.app/tags/<id>` | Blake3 hash | only if the target is a pubky.app post or profile |
| `PubkyAppBookmark` | `/pub/pubky.app/bookmarks/<id>` | Blake3 hash | only if the target is a pubky.app post |
| `PubkyAppFeed` | `/pub/pubky.app/feeds/<id>` | Blake3 hash | **no** |
| `PubkyAppBlob` | `/pub/pubky.app/blobs/<id>` | Blake3 hash (of raw bytes) | **no** |
| `PubkyAppFollow` | `/pub/pubky.app/follows/<pubky_id>` | target user's PubkyId | yes |
| `PubkyAppMute` | `/pub/pubky.app/mutes/<pubky_id>` | target user's PubkyId | **no** (removed in pubky-nexus #748, 2026-03-05) |

> **Write only to the exact `meta.path` the builder returns.** The Nexus watcher re-serializes each parsed URI and
> drops the event unless the result matches the original URI exactly. For example, `posts/<id>/extra` is a
> "non-canonical path" and is dropped. The watcher also **ignores LastRead, Feed, Blob and Mute events** ("Mute events
> are no longer handled by nexus"), so it never sees feeds, `last_read`, blobs or mutes. Clients read those directly
> from the homeserver.

> **An object can pass app-specs validation and still not be indexed by Nexus.** app-specs accepts any tag or bookmark
> `uri` that passes `Url::parse`, so a tag on `https://example.com` validates and is stored. For tags stored under
> **`/pub/pubky.app/tags/`**, Nexus `main` applies stricter rules (#1158 and #1167, 2026-11-02, not yet in a tag):
>
> - It indexes the tag only when the target parses as a pubky.app **post** or **profile.json** URI.
> - It indexes a bookmark only when the target is a pubky.app **post**.
> - It rejects file events whose `src` it can't parse.
>
> Every other target is classified `UnsupportedTarget` and dropped without retry. That includes `https://...`, another
> app's resource such as `/pub/mapky/places/1`, an invalid host and an unknown pubky.app resource. Don't expect them in
> Nexus reads. Universal tags follow a different rule (see [URI helpers](#uri-helpers)).

### `PubkyId`: raw z32 only

A `PubkyId` must be exactly 52 bytes of valid z-base-32. A wrong length fails with
`Validation Error: the string is not 52 utf chars`. Invalid characters fail with
`Validation Error: invalid public key encoding`. Native Rust also parses it as a `pubky::PublicKey`. A `PubkyId`
serializes as the raw z32 string and implements `Display`, `Deref<Target = str>` and `AsRef<str>` as z32.

**The `pubky`-prefixed display form is rejected** because its length is wrong. This applies to
`new PubkySpecsBuilder(...)`, `createFollow`, `createMute`, URI hosts and collection items.

- JS: pass `session.info.publicKey.z32()`. **Never** pass `.toString()`, which returns the display form.
- Rust: `From<pubky::PublicKey>`, `From<pubky::Keypair>` and `to_public_key()` use **`pubky` 0.10** types, because
  app-specs 0.8.1 still depends on `pubky = "0.10.0"`. The current `pubky` release is **0.18.0**, and its key type is
  a different type, so `PubkyId::from(pk)` fails with E0277. Convert through the z32 string instead. Both `pubky`
  versions then appear in `Cargo.lock`, which is harmless.

```rust
use pubky_app_specs::PubkyId;

let pk = session.info().public_key().clone();
// Not `PubkyId::from(pk)`: E0277 across pubky versions.
let id = PubkyId::try_from(&pk.z32()).map_err(anyhow::Error::msg)?;
```

<sub>Passed `clippy -D warnings` and was executed against a local testnet with `pubky` =0.12.0 + `pubky-app-specs` =0.8.1. It also compiles clean under `clippy -D warnings` with `pubky` 0.18.0, but was not executed there. A negative build with `PubkyId::from(...)` gave E0277. `PubkyId::try_from` is an inherent `fn(&str) -> Result<Self, String>`. `String` doesn't implement `std::error::Error`, so the snippet uses `map_err(anyhow::Error::msg)`.</sub>

### URI helpers

- **Builders** (snake_case in Rust, camelCase in JS): `base_uri_builder(user_id)` returns
  `pubky://<id>/pub/pubky.app/`. Each model also has a `*_uri_builder(author_id[, id])`: `user`, `post`, `follow`,
  `mute`, `bookmark`, `tag`, `file`, `blob`, `feed` and `last_read`. **Builders only concatenate strings and don't
  validate their inputs**, so validate IDs yourself.
- **JS `parse_uri(uri)`** returns a WASM class instance (`ParsedUriResult`) with the getters `user_id`, `resource` and
  `resource_id`. Read the getters: the result is not a plain object, so `JSON.stringify(parse_uri(...))` prints
  `{__wbg_ptr}`.
  - A post URI gives `resource: "posts"` and `resource_id: "<id>"`.
  - `profile.json` gives `resource_id: undefined` (not `null`).
  - An unknown segment such as `/pub/pubky.app/foo/bar` gives `resource: "unknown"` and doesn't throw.
  - It throws for any of these:
    - a scheme other than `pubky`
    - a host that is not a valid 52-char `PubkyId`
    - a path outside `/pub`
    - a different app (`Expected app path 'pubky.app' but got 'other.app' ...`)
    - fewer than 2 path segments (`Not enough path segments`)
    - a `follows` or `mutes` ID that is not a valid `PubkyId`
- **Rust** ([`src/uri/`](https://github.com/pubky/pubky-app-specs/tree/main/src/uri)):
  - `ParsedUri::try_from(&str)` returns `{ user_id: PubkyId, resource: Resource }`. `Resource` is one of `User`,
    `Post(String)`, `Follow(PubkyId)`, `Mute(PubkyId)`, `Bookmark`, `Tag`, `File`, `Blob` or `Feed` (these five take
    `String` IDs), `LastRead` or `Unknown`. `Resource::id()` returns `Option<String>`. `try_to_uri_str()` returns
    `Err` for `Unknown`.
  - `PubkyAppObject` has the variants `User`, `Post`, `Follow`, `Mute`, `Bookmark`, `Tag`, `File`, `Blob`, `Feed` and
    `LastRead`. `PubkyAppObject::from_uri(uri, blob)` and `from_resource(&resource, blob)` run
    `Validatable::try_from(blob, id)` with the ID from the path and return a typed, validated model. The ID is `""` for
    User and LastRead. `Unknown` gives `Err("Unrecognized resource ...")`.
  - `try_parse_pubky_path(uri)` returns `PubkyPath { user_id, app, segments }` for any `/pub/<app>/...` path.
    `is_pubky_scheme(scheme)` ignores case.
  - `ExtendedParsedUri` (for **ingest**) returns either `PubkyApp { user_id, resource }` or
    `UniversalTag { user_id, app, resource: Tag(id) }`. `UniversalTag` matches only
    `pubky://<id>/pub/<other-app>/tags/<tag_id>`, with exactly two segments after the app. Any other path outside
    `pubky.app` returns `Err("URI is not a recognized universal tag path")`. The body of a universal tag is still a
    `PubkyAppTag`, validated against its Blake3 ID.
  - **Nexus `main` indexes universal tags more broadly than `pubky.app` tags** (since #777, 2026-04-11, not yet in a
    tag). A tag stored under `/pub/<other-app>/tags/<id>` goes through `sync_put_resource`. Targets that aren't
    pubky.app resources, such as `https://...` or `/pub/mapky/...`, become a generic `Resource` node, and the label is
    indexed. The post/profile target rule applies only to tags under `/pub/pubky.app/tags/`.

## Object IDs

IDs use **Crockford** Base32. Source comments that say "Z-base32" are wrong. Only `PubkyId` is z-base-32.

### Timestamp IDs (Post, File)

- **Create:** take the current time in **microseconds** (`i64`), write it as 8 big-endian bytes, and encode those
  bytes in Crockford Base32. The result is **13 characters**.
- **Validate:** `validate_crockford_id` requires 13 valid Crockford characters that decode to 8 bytes.
  `TimestampId::validate_id` also requires the timestamp to be at least `1727740800000000` (2024-10-01T00:00:00Z) and
  at most **now + 2h**. The errors are `Validation Error: Invalid ID, timestamp must be after October 1st, 2024` and
  `Validation Error: Invalid ID, timestamp is too far in the future`.

> **Gotcha: JS produces duplicate IDs.** In WASM the clock is `Date.now() * 1000`, so IDs have only millisecond
> precision. With npm 0.8.1, 2000 `createPost` calls in a tight loop gave only a handful of unique IDs, and 200
> `createFile` calls gave 198 duplicates. A duplicate ID is the same path, so the second write **silently overwrites**
> the first. Make each create run in a different millisecond (for example, `await` between creates), or deduplicate
> the IDs. Native Rust uses `SystemTime` microseconds.

### Hash IDs (Tag, Bookmark, Feed, Blob)

- **Create:** compute Blake3 over the model's ID data. Take the first 16 of the 32 hash bytes and encode them in
  Crockford Base32. The result is **26 characters**.
- **Validate:** the ID is recomputed and must match. A mismatch fails with `Invalid ID: expected X, found Y`, which has
  no `Validation Error: ` prefix.

| Model | Hashed input | Consequence |
| :-- | :-- | :-- |
| Tag | `"{uri}:{label}"` after sanitize: the label is trimmed and lowercased, and the URI is normalized with `Url::parse` | The same target and label give the same path, so tagging is idempotent |
| Bookmark | `uri` exactly as given: no sanitize, so it isn't normalized | Bookmarking the same URI string again writes the same path; `created_at` is not part of the ID |
| Feed | `serde_json::to_string(&feed)`, the **config object only** | `name` and `icon` are not in the ID. Identical configs share one path. Changing `layout` or any other config field changes the ID. `domain_tags: None` is skipped in serialization |
| Blob | raw bytes (`create_id` is overridden) | Content-addressed |

Test vectors (npm 0.8.1), with `uri = postUriBuilder("user_id", "post_id")`:

- `createTag(uri, "cool").meta.id` returns `CBYS8P6VJPHC5XXT4WDW26662W`
- `createBookmark(uri).meta.id` returns `2GN0JCHX9NYXPECQDS8KSMSE7M`
- `createBlob([1, 2]).meta.id` returns `PZBQ010FF079VVZPQG1RNFN6DR`

## Validation lifecycle

- **Rust `Validatable::try_from(bytes, id)`** runs `serde_json::from_slice`, then `sanitize()`, then
  `validate(Some(id))`. It returns `Result<Self, String>`, so a bare `?` into `anyhow` won't compile; use
  `.map_err(anyhow::Error::msg)?`. Blob overrides `try_from` to take raw bytes instead of JSON. If you call
  `validate()` directly, call `sanitize()` first, because the rules that run after a trim (for example `[DELETED]`)
  depend on it.
- **Call it fully qualified: `<PubkyAppUser as Validatable>::try_from(...)`.** In edition 2021,
  `PubkyAppUser::try_from` is ambiguous with the prelude's `TryFrom` (E0034), even though upstream's README uses that
  form.
- **JS `Model.fromJson(obj)`** runs sanitize and then validate, passing `None` as the ID, so **the ID is not checked**.
  Only deserialization errors get the `Error parsing js object: ` prefix. Validation errors keep their normal
  `Validation Error: ...` text. For example, `PubkyAppPost.fromJson({content: "[DELETED]", kind: "short"})` throws
  `Validation Error: Content cannot be the reserved keyword ...`.
- **Builder `create*` methods** sanitize, compute the ID, run `validate(Some(id))`, and throw the error string on
  failure.
- **Don't match on error prefixes.** Most model errors start with `Validation Error: `, but these don't:
  - hash ID mismatches (`Invalid ID: ...`)
  - `FromStr` enum errors (`Invalid content kind: x`, `Invalid feed layout: spiral`, `Invalid feed reach: x`,
    `Invalid feed sort: x`, `Invalid collection layout: masonry`)
  - serde and tsify errors (``Error: Error: missing field `icon` ``, `` Error parsing js object: Error: unknown variant ... ``)
- **`sanitize()`** trims strings and normalizes URLs. It keeps an invalid URL (trimmed), and validation then rejects
  it. It also lowercases tag labels, feed icons and feed tags, drops empty feed tags, and rewrites a user `name` of
  `[DELETED]` to `anonymous`. It **doesn't truncate anything**, except `File.src` (see
  [PubkyAppFile and PubkyAppBlob](#pubkyappfile-and-pubkyappblob)).
- **Stored JSON contains `null`s. Readers must treat both `null` and a missing field as `None`.**
  - Both SDKs write top-level `None` fields as `null`: Post `parent`, `embed` and `attachments`; User `bio`, `image`,
    `links` and `status`; Feed config `tags` and `content`. JS `.toJson()` keeps those keys with the value
    `undefined`, and `session.storage.putJson` converts them to `null`. A JS-written post is therefore stored as
    `{"attachments":null,"content":"Hello, Pubky!","embed":null,"kind":"short","parent":null}`.
  - `getJson()` returns those fields as `undefined`, so only `getText()` shows the literal `null`s.
    `JSON.stringify(model.toJson())` drops them, so don't treat its output as the stored body.
  - Both SDKs **omit** these fields when they are `None`: post `lock`; feed `icon` and `domain_tags`; and the collection
    envelope's `description`, `cover_image` and `layout`.

## Models

The field lists below are summaries. The exact definitions are in
[`src/models/`](https://github.com/pubky/pubky-app-specs/tree/main/src/models). The limit values are for 0.8.1; read
them at runtime ([Validation limits](#validation-limits)).

### PubkyAppUser

`{ name, bio?, image?, links?: [{ title, url }], status? }`. The default name is `"anonymous"`.

- `name` is 3–50 characters, `bio` is at most 160 characters, and `status` is at most 50 characters.
- `image` is non-empty, at most 300 characters, and passes `Url::parse`.
- `links` has at most 5 entries. Each `title` is non-empty after trimming and at most 100 characters. Each `url` is
  non-empty, at most 300 characters, and passes `Url::parse`.
- `name: "[DELETED]"` is **rewritten to `"anonymous"`**, not rejected (see
  [The `[DELETED]` keyword](#the-deleted-keyword)).

```rust
use pubky_app_specs::{
    traits::{HasPath, Validatable},
    PubkyAppUser,
};
use serde_json::to_vec;

// Create a user profile
let user = PubkyAppUser::new("Alice".into(), None, None, None, None);
let path = PubkyAppUser::create_path(); // /pub/pubky.app/profile.json
let json = to_vec(&user).unwrap();

// Parse and validate JSON from storage
let profile = <PubkyAppUser as Validatable>::try_from(&json, "").unwrap();
```

<sub>Adapted from the upstream [`README.md`](https://github.com/pubky/pubky-app-specs/blob/main/README.md) Rust quick start. The only change is that upstream's `PubkyAppUser::try_from(&json, "")` is fully qualified, because the bare form is ambiguous with the prelude's `TryFrom` in edition 2021 (E0034). Passed `clippy -D warnings` with `pubky-app-specs` 0.8.1 (and alongside `pubky` 0.18.0). When run, it printed `{"name":"Alice","bio":null,"image":null,"links":null,"status":null}` and round-tripped. In library code, replace `.unwrap()` with `?` and `.map_err(anyhow::Error::msg)`. Writing `json` to `path` is a storage call; see [`./sdk-rust.md`](./sdk-rust.md).</sub>

### PubkyAppPost

`{ content, kind, parent?, embed?: { kind, uri }, attachments?: string[], lock? }`. In Rust, use
`PubkyAppPost::new(content, kind, parent, embed, attachments)` or `new_with_lock(..., lock)`, and
`PubkyAppPostKind::is_known()`.

- **`kind`** is lowercase on the wire: `short` (the default), `long`, `image`, `video`, `link`, `file` or
  `collection`. Any other value deserializes to `Unknown` (`#[serde(other)]`), and validation **rejects** it with
  `Validation Error: post kind is unknown` or `Validation Error: embed kind is unknown`. Rust `FromStr` is strict and
  fails with `Invalid content kind: x`.
  - JS `PubkyAppPostKind` is a **numeric** enum: `Short=0` through `Collection=6`, then `Unknown=7`.
  - The WASM `post.kind` getter returns `"Long"`, but `toJson().kind` is `"long"`. Always write the output of
    `toJson()`.
- **Replies:** set `parent` to the parent post's `pubky://` URI. That is `meta.url`, **not** `meta.path`.
- **Reposts:** set `embed = new PubkyAppPostEmbed(uri, kind)`. In JS the constructor's argument order is
  **(uri, kind)**. A repost with `content: ""` and an embed is valid by design.
- **Edit:** `editPost(originalPost, postId, newContent)` keeps the ID and path, then sanitizes and validates again with
  `validate(Some(postId))`, so the timestamp ID window still applies.
- **Gotcha: WASM consumes some arguments.** `createPost(..., embed)` and `editPost(originalPost, ...)` take
  `PubkyAppPostEmbed` and `PubkyAppPost` by value, so wasm-bindgen moves them into the call. What happens on reuse
  depends on the call:
  - Passing a consumed `embed` to another `createPost` **does not throw**. It **silently drops the embed** and stores
    a plain post. For example, `createPost("hi", Short, null, usedEmbed)` stores a post with no `embed`.
  - Calling a getter on a consumed object, or passing a consumed `PubkyAppPost` to `editPost` again, throws
    `Error: null pointer passed to rust`.
  - Build a new `PubkyAppPostEmbed` for each post. If you still need `originalPost`, call `originalPost.toJson()`
    before `editPost`.
- **Validation order:**
  1. Check the ID, if one is given.
  2. Reject the post if `content.trim()` is empty **and** `embed` is `None` **and** `attachments` is `None`.
  3. Reject content that is exactly `[DELETED]` after sanitize trims it:
     `Validation Error: Content cannot be the reserved keyword '[DELETED]'`.
  4. Reject an `Unknown` kind or embed kind.
  5. Run the `lock` checks.
  6. If `kind` is `collection`, run the collection rules and stop.
  7. Check the content length: at most **50000 characters for `long`** and at most **2000** for `short`, `image`,
     `video`, `link` and `file`.
  8. Check that `parent` and `embed.uri` pass `Url::parse`.
  9. Check attachments: **at most 10**. Each is non-empty, at most 200 characters, passes `Url::parse`, and uses the
     scheme `pubky`, `http` or `https` (case-insensitive).
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

<sub>Adapted from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js) and [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md). Last executed 2026-11-12 against a local testnet with `pubky-app-specs` 0.8.1 and `@synonymdev/pubky` 0.18.0, 0.16.2 and 0.12.0, and with app-specs 0.7.0 + pubky 0.12.0. Stored body (read with `getText`): `{"attachments":null,"content":"Hello, Pubky!","embed":null,"kind":"short","parent":null}`. In TypeScript, `meta.path` is typed `string` but `putJson` expects `Path`, so write `meta.path as Path`.</sub>

Replies, reposts, follow and unfollow, and edits (`session` and `specs` as above; `targetZ32` is another user's raw
z32):

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

<sub>Last executed 2026-11-12 against a local testnet with `pubky-app-specs` 0.8.1 and `@synonymdev/pubky` 0.18.0, 0.16.2 and 0.12.0, and with app-specs 0.7.0 + pubky 0.12.0. The stored reply's `parent` equalled the original's `meta.url`. The repost was stored as `{"attachments":null,"content":"","embed":{"kind":"short","uri":...},"kind":"short","parent":null}`. After the delete, `exists()` returned false, and the edited path equalled the original path. The 2 ms waits prevent duplicate IDs from overwriting earlier posts. The calls consume `embed` and `original`, so don't reuse them.</sub>

#### `lock` (optional, since 0.6.0)

- If `lock` is present, it must meet all of these rules:
  - It is non-empty; otherwise it fails with `Lock URL cannot be empty`.
  - It is **at most 200 characters** (`postAttachmentUrlMaxLength`).
  - It parses as a URL.
  - It uses the **`pubky://` scheme**; otherwise it fails with `Lock URL must use the pubky:// scheme`.
  - It **has a host**. The opaque form `pubky:lock-id` fails with `Lock URL must include a host`.

  These rules apply to every kind, including collections.
- A missing or `null` `lock` means **not locked**. The field is omitted from the JSON when it is `None`. Nexus indexes
  it and returns it as `lock` on `PostDetails`. Nexus `main` (#1207, not yet in a tag) also accepts a `locked` filter
  on post stream routes; see [`./nexus-api.md`](./nexus-api.md#locked-posts-locked).
- **app-specs defines `lock` only as a schema field.** It defines no lock-server protocol, no gating and no encryption,
  and the post body itself is in public `/pub`.
- **pubky.app's lock feature is an app convention, not part of the spec:**
  - The announcement post's `lock` points at a public `lock.json`. That file is the creator's
    `/pub/app.locks/<lockId>.json` on their own homeserver.
  - Its schema (`LockFile`) is a contract defined by a separate Lock Server, which stores and proxies the guarded
    content.
  - The guarded content is in homeserver `/priv`, at `/priv/app.locks/content/`, and reader copies are under
    `/priv/social/unlocked/<lockId>/`.
  - pubky.app also forbids `long` and `collection` announcements. That is an app rule, not a spec rule.
  - **`/priv` is alpha and not for production.** It is access-controlled but **not encrypted**, so the homeserver
    operator can read it.
- **Never** describe locked posts as private or encrypted. Encrypted or guarded data is not a shipped general primitive
  (see [`./shipped-vs-planned.md`](./shipped-vs-planned.md)).

#### Collection posts (`kind: "collection"`)

- `parent`, `embed` and `attachments` must all be `None`. Even `attachments: []` is rejected.
- `content` is at most 40000 characters and must parse as JSON in the shape
  `{ name, description?, items: string[], cover_image?, layout? }`. Extra unknown keys are allowed.
  - `name` is 1–100 characters, counted **without trimming**, and can't be only whitespace.
  - `description` is at most 500 characters.
  - `cover_image` is at most 200 characters, passes `Url::parse`, and uses the scheme `pubky`, `http` or `https`.
  - `items` has **at most 100** entries and defaults to `[]` if the key is missing. Each item must be exactly
    `pubky://<52-char PubkyId>/pub/pubky.app/posts/<13-char Crockford id>`. This is checked by splitting the string,
    deliberately not with `Url::parse`, and the post ID's timestamp range is not checked.
- **`layout`** (since 0.6.2) is `grid`, `list` or `visual`. If it is absent, the layout is `grid`. Any other value
  deserializes to `Unknown` and **passes validation** (`fromJson` with `"masonry"` succeeds), so render unrecognized
  values as `grid`. The builder parses `layout` strictly: `createCollectionPost(..., "masonry")` throws
  `Invalid collection layout: masonry`, and so does `"cards"`.
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

<sub>Last executed 2026-11-12 against a local testnet with `pubky-app-specs` 0.8.1 and `@synonymdev/pubky` 0.18.0, 0.16.2 and 0.12.0, and with app-specs 0.7.0 + pubky 0.12.0. `specs` and `session` are as in the post example. The stored post has `kind: "collection"`, and `content` holds the envelope as a JSON **string**. A `null` layout omits the key. The 5th argument, `layout`, requires 0.7.0 or later.</sub>

### PubkyAppTag

`{ uri, label, created_at }`, with `created_at` in microseconds.

- Sanitize trims and lowercases the label (`trim().to_lowercase()`) and normalizes the URI with `Url::parse`.
- Validation:
  - The label is **1–20 characters** and contains **no Unicode whitespace** (`char::is_whitespace`). For example,
    `"two words"` fails with `Validation Error: Tag 'two words' contains whitespace characters`.
  - The label also can't contain `,`, `:`, space, tab, `\n` or `\r`.
  - `uri` must pass `Url::parse`.
- **Nexus `main` indexes a tag stored under `/pub/pubky.app/tags/` only when it targets a pubky.app post or profile.**
  A tag on an `https://` URL or on another app's resource is valid and stored, but Nexus drops it (see
  [Paths and URIs](#paths-and-uris)). Universal tags under `/pub/<other-app>/tags/` follow a broader rule (see
  [URI helpers](#uri-helpers)).
- Code outside the crate can't call `sanitize_tag_label` or `validate_tag_label`. They are in a private module, aren't
  re-exported and have no WASM export. Mirror their rules in your client's input checks instead:
  - Trim and lowercase the label.
  - Read `tagLabelMinLength`, `tagLabelMaxLength` and `tagInvalidChars` from the
    [validation limits](#validation-limits).
  - Reject any Unicode whitespace.

### PubkyAppBookmark

`{ uri, created_at }`. Validation checks the ID and that `uri` passes `Url::parse`. The ID is the Blake3 hash of
`uri` exactly as given, so bookmarking the same URI string again writes the same path. Nexus `main` indexes a bookmark
only when `uri` is a pubky.app post.

### PubkyAppFollow and PubkyAppMute

The body is only `{ created_at }` (microseconds). **The target user exists only in the path** (`follows/<z32>` or
`mutes/<z32>`). Validation only checks that the path ID is a `PubkyId`. The builder's `meta.id` is the target's z32.
To unfollow or unmute, **delete that path** (see the reply/repost snippet above). Nexus `main` ignores mutes, so read a
user's mutes from their homeserver.

### PubkyAppFile and PubkyAppBlob

A file upload is **two writes**:

1. **Blob** (`PubkyAppBlob(Vec<u8>)`): the body is **raw bytes, not JSON**, and the ID is the Blake3 hash of the
   bytes. The blob must be non-empty and **at most 100 MB** (`maxBlobSizeBytes = 104857600`).
2. **File**: JSON metadata `{ name, created_at, src, content_type, size }`, where `src` is the blob's `pubky://` URL.
   - `size` is greater than 0 and at most 104857600.
   - `name` is 1–255 characters.
   - `src` is non-empty, at most 1024 characters, and passes `Url::parse`. It is **not** URL-normalized.
   - `content_type` is parsed with `mime::Mime`, and its essence must be in `VALID_MIME_TYPES`; otherwise validation
     fails with `Validation Error: Invalid content type`. The list has 21 entries in
     [`src/models/file.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/models/file.rs); in JS, call
     `getValidMimeTypes()`. Parameters are allowed and stored unchanged, so `image/png; charset=binary` is accepted.
     `image/heic` is rejected.

> **Gotcha: `File.src` is silently truncated.** Sanitize trims `src` and **cuts it to 1024 characters**, and only then
> checks that it parses as a URL. If it doesn't parse, `src` becomes `""` and validation fails with
> `Validation Error: Invalid src`. So a 2014-character https URL *succeeds* and stores its first 1024 characters, which
> is a different, broken URL (verified on 0.8.1). Check `src` against `fileSrcMaxLength` yourself before you call
> `createFile`.

- In JS, `blob.data` is a `Uint8Array`. Write it with `putBytes`, never as JSON.
- Set `src` to the blob's `meta.url`. Nexus `main` rejects file events whose `src` it can't parse.
- Released homeservers (through v0.18.0) have no hard per-request body cap to rely on: the streaming `PUT` handler
  bypasses the 100 MiB `DefaultBodyLimit`. Unreleased `main` enforces 100 MB (`MAX_UPLOAD_BYTES`, pubky-homeserver
  #808), which matches the blob cap; don't depend on it until a release ships it (see
  [`./shipped-vs-planned.md`](./shipped-vs-planned.md) and [`./concepts.md`](./concepts.md)). Operators can set lower
  quotas.
  pubky-ai-kit claims a 10 MB default limit per request (returning 413), and says Synonym's public homeserver allows
  1 GB per user and 10 MB per file. Those numbers conflict with the code default and are **unverified**, so handle 413
  responses.

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

<sub>Based on the pubky-ai-kit "File Upload with Metadata" pattern and upstream `pkg/example.js`. Last executed 2026-11-12 against a local testnet with `pubky-app-specs` 0.8.1 and `@synonymdev/pubky` 0.18.0, 0.16.2 and 0.12.0, and with app-specs 0.7.0 + pubky 0.12.0. The blob bytes read back identical through `getBytes`, and the blob ID was the same 26-character ID on every run. The file JSON was `{content_type, created_at, name, size, src: pubky://.../blobs/<26-char id>}`.</sub>

### PubkyAppFeed

`{ feed: { tags?, domain_tags?, reach, layout, sort, content? }, name, icon?, created_at }`, with `created_at` in
microseconds. The config is **nested under `feed`**.

- **`reach`**: `following`, `followers`, `friends`, `all`, `wot` or `me`.
- **`layout`**: `columns`, `wide`, `visual`, `list` or `cards`. `cards` is new in **0.8.1**. It is JS enum value 4,
  after `Columns=0`, `Wide=1`, `Visual=2` and `List=3`.
- **`sort`**: `recent` or `popularity`.
- **`content`**: an optional `PubkyAppPostKind` filter. Validation doesn't reject `Unknown` here, but the builder
  parses it strictly.
- **Validation:**
  - `name` must be non-empty after trimming.
  - `icon`, if present, must be non-empty, **at most 50 characters**, and contain only `[a-z0-9-]` after trimming and
    lowercasing. `" Mountain "` becomes `"mountain"`, and `"my_icon"` fails with `contains invalid character: _`.
  - `tags` and `domain_tags` each have **at most 5** entries, and each entry must be a valid tag label. Entries are
    trimmed and lowercased, and empty entries are dropped.
- **`icon`** is a [Lucide](https://lucide.dev/icons/) icon name. The spec validates only its shape, because the client
  chooses which icons it supports, so fall back to a default for names you don't recognize. A missing or `null` icon is
  valid (older feeds have none), but `""` is rejected. Rust `PubkyAppFeed::new(feed, name, icon: String)` requires an
  icon.

> **Gotcha: feed enums are closed.** Post `kind` and collection `layout` fall back to `Unknown`, but `reach`, `layout`
> and `sort` do **not**. `PubkyAppFeed.fromJson` with `layout: "masonry"` throws
> ``Error parsing js object: Error: unknown variant `masonry`, expected one of `columns`, `wide`, `visual`, `list`, `cards` ``.
> As a result, **any reader on `pubky-app-specs` 0.8.0 or earlier fails to deserialize a `cards` feed**, including
> Rust crates pinned to 0.7.x (confirmed on 0.7.0). Nexus is unaffected only because it ignores feed events. Write
> `cards` only if every app that reads your users' feeds is on 0.8.1 or later.

**JS `createFeed` takes one `CreateFeedInput` object** with **camelCase** keys:
`{ tags?, reach, layout, sort, content?, name, domainTags?, icon }`.

- `icon` is required. Omitting it throws ``missing field `icon` ``.
- Use `domainTags`. A snake_case `domain_tags` key in the input is **silently dropped**. The stored JSON key is still
  `domain_tags`.
- Don't use the form with 6 positional arguments that some docs show
  ([Doc-vs-code drift](#doc-vs-code-drift)).

```js
const { feed, meta: feedMeta } = specsBuilder.createFeed({
  tags: ["mountain", "hiking", "nature"],
  reach: "all",
  layout: "columns",
  sort: "recent",
  content: "image",
  name: "Outdoor Adventures",
  icon: "mountain",
});
```

<sub>Verbatim from upstream [`pkg/example.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/example.js) at `86a561e`; `specsBuilder` is a `PubkySpecsBuilder`. Executed 2026-11-12 with `pubky-app-specs` 0.8.1 and 0.7.0, which gave the path `/pub/pubky.app/feeds/8353SVA69WR6XT78F8PWDAFK4M`. To store it, call `session.storage.putJson(feedMeta.path, feed.toJson())`.</sub>

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

<sub>Input taken from the upstream [`pkg/test.js`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/test.js) cards round-trip test. Last executed 2026-11-12 against a local testnet with `pubky-app-specs` 0.8.1 and `@synonymdev/pubky` 0.18.0, 0.16.2 and 0.12.0. Stored body: `{"created_at":<micros>,"feed":{"content":null,"layout":"cards","reach":"all","sort":"recent","tags":["rust"]},"icon":"layout-dashboard","name":"Rust posts"}`. Rebuilding the feed from the stored `json.feed` reproduces `meta.id`. On 0.7.0 the builder throws `Invalid feed layout: cards`.</sub>

### PubkyAppLastRead

`{ timestamp }` in Unix **milliseconds** (`new()` uses `timestamp()/1_000`). It must be greater than 0. The path is
`/pub/pubky.app/last_read`, and the JS builder's result key is `last_read`. Nexus doesn't index it.

> **The units differ.** Every `created_at` is in **microseconds** (16 digits), but `LastRead.timestamp` is in
> **milliseconds** (13 digits). In JS, use `new Date(timestamp)`. Upstream `pkg/example.js` divides by 1000 first,
> which gives a date in 1970.

## Validation limits

Read limits at runtime instead of copying the numbers into code. The current values are in
[`src/limits.rs`](https://github.com/pubky/pubky-app-specs/blob/main/src/limits.rs): 28 keys in 0.8.1, unchanged since
0.8.0. The per-model values on this page come from that file.

- **JS:** use one of these:
  - `getValidationLimits()`, a root export that returns a copy
  - the `builder.validationLimits` getter
  - the **WASM-free** subpath `pubky-app-specs/validationLimits`, which has a default export plus the named exports
    `validationLimits` and `getValidationLimits`
  - the raw file `pubky-app-specs/validationLimits.json`
- **Rust:** `pubky_app_specs::VALIDATION_LIMITS`, which serializes as camelCase. Pass it to `serde_json::to_value` to
  send the limits to clients.

```js
import limits, {
  getValidationLimits,
  validationLimits,
} from "pubky-app-specs/validationLimits";

console.log(validationLimits.userNameMaxLength);
console.log(limits.postShortContentMaxLength);

const copy = getValidationLimits();
```

<sub>Verbatim from upstream [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md). Executed 2026-11-12 on Node with `pubky-app-specs` 0.8.1 and 0.7.0. It printed `50` and `2000`. `getValidationLimits()` returned a copy that was deep-equal to the original but a different object, with 28 keys.</sub>

JS key names (camelCase), grouped by area:

| Area | Keys |
| :-- | :-- |
| User | `userNameMinLength`, `userNameMaxLength`, `userBioMaxLength`, `userImageUrlMaxLength`, `userLinksMaxCount`, `userLinkTitleMaxLength`, `userLinkUrlMaxLength`, `userStatusMaxLength` |
| Post | `postShortContentMaxLength`, `postLongContentMaxLength`, `postAttachmentsMaxCount`, `postAttachmentUrlMaxLength` (also caps `lock` and `cover_image`), `postAllowedAttachmentProtocols` |
| Collection | `collectionContentMaxLength`, `collectionNameMinLength`, `collectionNameMaxLength`, `collectionDescriptionMaxLength`, `collectionItemsMaxCount` |
| Tag | `tagLabelMinLength`, `tagLabelMaxLength`, `tagInvalidChars` |
| File / Blob | `fileNameMinLength`, `fileNameMaxLength`, `fileSrcMaxLength`, `maxFileSizeBytes`, `maxBlobSizeBytes` |
| Feed | `feedTagsMaxCount`, `feedIconMaxLength` |

**Unicode counting:** length limits count **Unicode scalar values** (`.chars().count()`), not bytes and not JS UTF-16
`.length`. In client-side counters, use `[...str].length`. For example, a name made of 50 `🔥` characters is valid even
though `name.length === 100`. `PubkyId` and Crockford checks count bytes, which gives the same result because those
strings are ASCII. Details:
[`docs/UNICODE_NOTES.md`](https://github.com/pubky/pubky-app-specs/blob/main/docs/UNICODE_NOTES.md).

## The `[DELETED]` keyword

**Clients never write `[DELETED]`.** The indexer uses it to mark users whose `profile.json` was deleted, and deleted
posts that other users' objects still refer to.

**How app-specs handles it (unchanged in 0.8.1):**

- A post whose content is exactly `[DELETED]` after sanitize is **rejected** with
  `Validation Error: Content cannot be the reserved keyword '[DELETED]'`.
- A user `name: "[DELETED]"` is **silently changed to `"anonymous"`** by sanitize. For example,
  `createUser("[DELETED]")` stores `"name":"anonymous"`.

**How Nexus marks deletions: check both signals.** Nexus `main` has a boolean `deleted` on `PostDetails` and
`UserDetails`, plus a migration (`post_deleted_flag_1790899200`) that rewrites legacy `[DELETED]` rows. This is **not
in a release tag yet** (the latest is v0.3.1), and some code paths still return the legacy `[DELETED]` string.

- In a tombstone post, `content` is cleared, `kind` is forced to `short`, `embed`, `attachments` and `lock` are
  removed, `parent` is **kept**, and `deleted` is `true`.
- In a tombstone user, `name` is cleared and `deleted` is `true`.
- Older Nexus builds don't send `deleted`, so treat a missing value as `false`. Those builds still use `[DELETED]` as
  the content or name.
- Treat a post or user as deleted when **`deleted === true` OR its content or name is exactly `"[DELETED]"`**. pubky.app
  does this, and it treats a tombstone as not found when it validates the parent of a reply or repost. For field
  details, see
  [`./nexus-api.md`](./nexus-api.md#deleted-posts-and-users-check-deleted-not-a-string).

## Builder and crate APIs

### JS: `PubkySpecsBuilder`

The full API is in [`pkg/README.md`](https://github.com/pubky/pubky-app-specs/blob/main/pkg/README.md).

- `new PubkySpecsBuilder(z32)` throws unless you pass a raw 52-char z32 ID.
- Each `create*` method returns `{ <model>, meta: { id, path, url } }`, where `url = "pubky://" + builderId + path`.
  `id` is `""` for User and LastRead.
- Write each model with `putJson(meta.path, model.toJson())`, and write blobs with `putBytes`.
- You can omit trailing optional arguments.

| Method | Notes |
| :-- | :-- |
| `createUser(name, bio?, image?, links?, status?)` | `links` is `{title,url}[]` or `null` |
| `createPost(content, kind, parent?, embed?, attachments?, lock?)` | `kind` is a `PubkyAppPostKind` value; `embed` is `new PubkyAppPostEmbed(uri, kind)` and is consumed by the call (reusing it silently drops the embed) |
| `editPost(originalPost, postId, newContent)` | Keeps the ID; sanitizes and validates again; consumes `originalPost` |
| `createCollectionPost(name, description?, items?, cover_image?, layout?)` | `layout` is `'grid' \| 'list' \| 'visual'`, parsed strictly |
| `createFeed(input: CreateFeedInput)` | One camelCase object (`domainTags`); `icon` is required |
| `createFile(name, src, contentType, size)` | Timestamp ID; `src` is truncated at 1024 characters |
| `createTag(uri, label)` / `createBookmark(uri)` | Hash IDs |
| `createFollow(followeeId)` / `createMute(muteeId)` | Raw z32 target |
| `createLastRead()` | Result key is `last_read` |
| `createBlob(bytes)` | `Uint8Array` or `number[]`; `blob.data` is a `Uint8Array` |

The package also exports `getValidationLimits`, `getValidMimeTypes`, `parse_uri` and the `*UriBuilder` functions. Its
npm entry points are:

- `.`: ESM `index.js`, CJS `index.cjs`, types `pubky_app_specs.d.ts`
- `./validationLimits`
- `./validationLimits.json`

### Rust crate

[docs.rs/pubky-app-specs](https://docs.rs/pubky-app-specs) has the full export list. The crate uses edition 2021 and
has an MSRV of **1.89**. The `openapi` feature derives `utoipa::ToSchema`:
`pubky-app-specs = { version = "0.8", features = ["openapi"] }`.

- **Crate root re-exports:**
  - Models and their types: `PubkyAppUser`, `PubkyAppUserLink`, `PubkyAppPost`, `PubkyAppPostKind`,
    `PubkyAppPostEmbed`, `PubkyAppCollectionContent`, `PubkyAppCollectionLayout`, `PubkyAppFeed`,
    `PubkyAppFeedConfig`, `PubkyAppFeedLayout`, `PubkyAppFeedReach`, `PubkyAppFeedSort`, `PubkyAppTag`,
    `PubkyAppBookmark`, `PubkyAppFollow`, `PubkyAppMute`, `PubkyAppFile`, `PubkyAppBlob` and `PubkyAppLastRead`.
  - `PubkyAppObject` and `PubkyId`.
  - Validation: `VALIDATION_LIMITS`, `ValidationLimits`, `VALID_MIME_TYPES` and `validate_crockford_id`.
  - The path constants and the URI builders.
  - URI parsing: `ExtendedParsedUri`, `ParsedUri`, `PubkyPath`, `Resource`, `is_pubky_scheme` and
    `try_parse_pubky_path`.
- **Traits:** `use pubky_app_specs::traits::{Validatable, TimestampId, HashId, HasPath, HasIdPath};`. Call
  `Validatable::try_from` fully qualified (see [Validation lifecycle](#validation-lifecycle)).
- **`pubky` version:** app-specs 0.8.1 depends on `pubky` 0.10 (on native targets only), while the current release is
  **0.18.0**. The key types of the two versions aren't interchangeable; see
  [`PubkyId`](#pubkyid-raw-z32-only). The storage calls that write and read these models are in
  [`./sdk-rust.md`](./sdk-rust.md).

## Doc-vs-code drift

The Rust code is correct. Don't copy these errors from other sources.

| Source says | Rust code (correct) |
| :-- | :-- |
| SPEC.md File: "Max size is 10Mb" | 100 MB (`maxFileSizeBytes`); Blob has the same cap |
| SPEC.md Feed example `created_at: 1700000000` | Microseconds |
| SPEC.md attachments: "Each must be a valid URI" | Also at most 10 entries, each at most 200 characters, with a `pubky`, `http` or `https` scheme |
| SPEC.md Tag label: max 20 | Also at least 1 character; `,`, `:` and whitespace are not allowed |
| SPEC.md collection example hosts `pubky://userA/...` | Fail validation; use 52-char z32 IDs |
| SPEC.md User name "Cannot be [DELETED]" | Rewritten to `anonymous`, not rejected |
| README Rust quick start `PubkyAppUser::try_from(&json, "")` | E0034 in edition 2021; use `<PubkyAppUser as Validatable>::try_from` |
| Source comments: IDs are "Z-base32" | Crockford Base32 |
| `pkg/example.js` LastRead `timestamp / 1000` | Already in milliseconds; use `new Date(timestamp)` |
| Earlier guidance: "clients match the exact `[DELETED]` string" | Also check Nexus `deleted === true` |
| Earlier guidance: "JS `.toJson()` omits `None` fields" | `putJson` stores them as `null`; only `JSON.stringify` omits them |
| "A tag or bookmark that validates will show up in Nexus" | Under `/pub/pubky.app/`, Nexus indexes only tags on pubky.app posts or profiles and bookmarks on pubky.app posts. Universal tags under `/pub/<other-app>/tags/` are indexed for any target |
| "Mutes are indexed by Nexus" | Nexus `main` ignores mute events (#748); read mutes from the homeserver |
| pubky-ai-kit: `createFeed` with 6 positional arguments; layouts without `list`/`cards`; reach without `wot`/`me`; "Attachments: Max 4" | `createFeed` takes a single object and requires `icon`; the full enum values are on this page; up to 10 attachments |
| pubky-ai-kit placeholders `user_id`, `user_id_to_mute` | Throw in `parse_uri`, `createMute` and collection items; use real z32 IDs |
| pubky-ai-kit tag ID `FPB0AM9S93Q3M1GFY1KV09GMQM` | Only an example path from a doc comment, not a tested vector |
| pubky-ai-kit: `/priv` returns 403 | `/priv` shipped as **alpha** in homeserver v0.10.0: not for production, access-controlled but **not encrypted** from the operator. See [`./shipped-vs-planned.md`](./shipped-vs-planned.md) |

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
- **Nexus ingest (tag, bookmark, file and mute rules; universal tags):**
  [`nexus-watcher/src/events/`](https://github.com/pubky/pubky-nexus/tree/main/nexus-watcher/src/events)
- **Homeserver upload cap:**
  [`pubky-homeserver/src/constants.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/constants.rs)
  (`MAX_UPLOAD_BYTES`)
- **pubky.app locks (app convention):** [`docs/locks.md`](https://github.com/pubky/pubky-app/blob/dev/docs/locks.md)
- **Concept overview (universal tags, scope):**
  [KB: pubky-app-specs](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-app-specs.md)
