# Rust client (`pubky` crate)

The `pubky` crate is the official Rust SDK — auth + data ops over `pubky://`. Canonical
protocol knowledge lives elsewhere: identity, `pubky://` addressing, PKARR, the homeserver
model, public-key string formats, and the write-own vs public-read split are in
[`./concepts.md`](./concepts.md); the full `pubkyauth` flow, capabilities, signup tokens, and
session-persistence semantics are in [`./auth.md`](./auth.md); `EphemeralTestnet` and local dev
are in [`./testing-and-testnet.md`](./testing-and-testnet.md).

**Upstream (authoritative — summarize, don't mirror):** the maintained API reference is docs.rs
— pin to your installed version ([0.9.3](https://docs.rs/pubky/0.9.3/pubky/)) or follow
[floating-latest](https://docs.rs/pubky); version source of truth is
[crates.io](https://crates.io/crates/pubky). Runnable programs:
[`pubky-homeserver/examples/rust`](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust)
(`keygen`, `0-logging`, `1-testnet`, `2-signup`, `3-auth_flow`, `4-storage`, `5-request`,
`6-auth_flow_signup`, `7-events_stream`); CI-verified snippets:
[`pubky-knowledge-base-v2/snippets/rust`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs).
When a signature here looks stale, trust docs.rs for the version you installed.

> **Version:** latest published is **0.9.3** (2026-06-24) — what `cargo add pubky` resolves to
> today and what this page is anchored on. Pubky is pre-1.0; treat APIs as **unstable**.

> **Version drift.** The `pubky-homeserver` examples on `main` track the *next* (unreleased) release,
> not 0.9.3. Two breaking changes are on `main` but **not** in 0.9.3: `signer.signin(...)` takes
> a required `ClientId` (0.9.3 `signin()` takes **no** argument), and `start_auth_flow` was
> renamed `start_cookie_auth_flow` (0.9.3 still uses `start_auth_flow`). Trust the 0.9.3 surface
> (docs.rs 0.9.3, KB snippets) for what you installed.

## Install and runtime

```bash
cargo add pubky --features json
cargo add tokio --features macros,rt-multi-thread
# Optional, for typed records: cargo add serde --features derive && cargo add serde_json
```

- The crate is **fully async** (futures + `reqwest` under the hood) and needs a Tokio runtime —
  examples use `#[tokio::main]`.
- The **`json` feature** gates `put_json` / `get_json`; without it use raw `put` / `get` with
  bytes/text.
- Event streams need **`futures_util::StreamExt`** in scope to call `.next()`.

The CI-verified snippet crate (`pubky-doc-snippets`) uses edition 2024, rust-version 1.89, and
the minimal idiomatic dep set: `pubky = { version = "=0.9.3", features = ["json"] }`, `serde`
1.0 (derive), `serde_json` 1.0, `anyhow` 1.0, `futures-util` 0.3, `tokio` 1.0 (`macros`,
`rt-multi-thread`).

## Initialize the client

```rust
use pubky::Pubky;

let pubky = Pubky::new()?;
```

`Pubky::new()` returns a `Result` (note the `?`) and builds the facade wired to **mainnet PKARR
defaults**. Construct it **once** and share it across the app — don't build one per request.
`Pubky::testnet()?` builds the same facade wired to local testnet defaults instead (see
[`./testing-and-testnet.md`](./testing-and-testnet.md)). Idiomatic toggle:

```rust
let pubky = if cli.testnet { Pubky::testnet()? } else { Pubky::new()? };
```

## The type model

- `pubky.signer(keypair)` → **`PubkySigner`** — the key holder that signs.
- `signer.signin()` / `signer.signup(...)` → **`PubkySession`** — the authenticated,
  per-identity, stateful API driver.

Two storage surfaces share one read API:

- `session.storage()` → **`SessionStorage`** — read **and write** your **own** data, with
  **absolute** `/pub/...` paths.
- `pubky.public_storage()` → **`PublicStorage`** — **read-only** access to **anyone's** public
  data, addressed as `(&PublicKey, path)` tuples (or a `pubky://` URL). No writes.

This write-own vs read-public split is canonical — see [`./concepts.md`](./concepts.md).

## Sign up and sign in

```rust
use pubky::{Keypair, Pubky, PublicKey};

let pubky = Pubky::new()?;
let keypair = Keypair::random();
let homeserver =
    PublicKey::try_from("8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo").unwrap();

let signer = pubky.signer(keypair);
let session = signer.signup(&homeserver, signup_token.as_deref()).await?;
```

`signup`'s second arg is `Option<&str>` — `None` for open/testnet homeservers, `Some(token)`
for gated ones (see [`./auth.md`](./auth.md)). Recovery files (passphrase-encrypted keypair
backups) load a keypair via `pubky::recovery_file::decrypt_recovery_file(&bytes, &passphrase)?`
(the encrypt side, `create_recovery_file`, lives in `pubky_common::recovery_file`); details in
[`./auth.md`](./auth.md).

Sign in an existing identity. In published **0.9.3 `signin()` takes no argument** and returns a
`PubkySession`:

```rust
use pubky::{Keypair, Pubky};

let pubky = Pubky::new()?;
let signer = pubky.signer(Keypair::random());

// Fast: PKDNS refresh happens in the background
let session = signer.signin().await?;

// Blocking: waits for PKDNS to be discoverable (~3-5s)
let session = signer.signin_blocking().await?;
```

Use `signin_blocking()` when the user's homeserver must be resolvable immediately after
sign-in; otherwise `signin()` is faster (PKDNS refresh runs in the background). Both return
`PubkySession`.

## Storage operations

Typed JSON to your **own** storage (requires the `json` feature):

```rust
// Requires the "json" feature on the pubky crate
session
    .storage()
    .put_json("/pub/myapp/profile", &profile)
    .await?;

let profile: serde_json::Value = session.storage().get_json("/pub/myapp/profile").await?;

session.storage().delete("/pub/myapp/profile").await?;
```

Raw bytes/text (no `json` feature). `put` accepts anything `Into<Body>` — both `&str` and
`Vec<u8>` work; `get` returns a response with `.bytes().await?` / `.text().await?`:

```rust
let storage = session.storage();

// PUT raw bytes
storage.put(&path, content.as_bytes().to_vec()).await?;

// GET and read body
let response = storage.get(&path).await?;
let body = response.bytes().await?;
println!("{}", String::from_utf8_lossy(&body));

// DELETE
storage.delete(&path).await?;
```

List a directory in your own storage — the builder ends with `.send().await?`, directory paths
end with `/`, and it yields a `Vec` of entries:

```rust
let entries = session
    .storage()
    .list("/pub/myapp/posts/")?
    .limit(20)
    .reverse(true)
    .send()
    .await?;

for entry in entries {
    println!("{}", entry);
}
```

Read **another** user's public data, unauthenticated. `public_storage().get(...)` takes a
`(&PublicKey, &str)` **tuple**:

```rust
let user = PublicKey::try_from(user_public_key).unwrap();
let resp = pubky
    .public_storage()
    .get((&user, "/pub/myapp/profile"))
    .await?;
let text = resp.text().await?;
```

The same `get` also accepts a `pubky://<user>/pub/...` resource string directly (not just a
tuple). The response exposes `.version()`, `.status()`, `.headers()`, and `.bytes().await?` /
`.text().await?`.

Lightweight presence/metadata checks without downloading the body — `exists(path) -> bool`
(HEAD) and `stats(path) -> Option<_>` with `.content_length` / `.content_type` / `.etag`. Both
also work on `public_storage()` with the tuple form:

```rust
// Check if a resource exists (lightweight HEAD request)
let exists = session.storage().exists("/pub/myapp/profile").await?;

// Get resource metadata without downloading the body
if let Some(stats) = session.storage().stats("/pub/myapp/profile").await? {
    println!("Size: {:?}", stats.content_length);
    println!("Type: {:?}", stats.content_type);
    println!("ETag: {:?}", stats.etag);
}

// Also available on public storage
let user = PublicKey::try_from(user_public_key).unwrap();
let public_exists = pubky
    .public_storage()
    .exists((&user, "/pub/myapp/profile"))
    .await?;
```

**Path rules:** write only under `/pub/`. The `/pub` layout is **not stabilized** and `/priv`
private storage is **not shipped** — see [`./shipped-vs-planned.md`](./shipped-vs-planned.md).
For `pubky.app` record schemas, IDs, and path conventions see
[`./app-specs.md`](./app-specs.md).

## Error handling

The top-level error type is **`pubky::Error`** (also re-exported at `pubky::errors::Error`).
Published 0.9.3 has 5 exhaustive variants — match on them:

```rust
use pubky::{Error, errors::RequestError};

match session.storage().get("/pub/myapp/data").await {
    Ok(resp) => println!("Retrieved: {}", resp.text().await?),
    Err(Error::Request(RequestError::Server { status, message })) => {
        eprintln!("Server error {status}: {message}");
    }
    Err(Error::Request(e)) => eprintln!("Request failed: {e}"),
    Err(Error::Pkarr(e)) => eprintln!("PKARR error: {e}"),
    Err(Error::Parse(e)) => eprintln!("URL parse error: {e}"),
    Err(Error::Authentication(e)) => eprintln!("Auth failed: {e}"),
    Err(Error::Build(e)) => eprintln!("Client build failed: {e}"),
}
```

Variants (see [docs.rs](https://docs.rs/pubky/0.9.3/pubky/errors/enum.Error.html)):

- `Request(RequestError)` — HTTP request/response failed (transport, server, validation, JSON).
  `RequestError::Server { status, message }` carries the HTTP status.
- `Pkarr(PkarrError)` — PKARR/DHT operation failed.
- `Parse(ParseError)` — URL parsing failed.
- `Authentication(AuthError)` — auth flow failed (token, session, crypto, or validation).
- `Build(BuildError)` — building the client failed (reqwest or pkarr configuration).

## Sessions: info, signout, persistence

```rust
let signer = pubky.signer(Keypair::random());
let session = signer.signin().await?;

// Session info
println!("User: {}", session.info().public_key());

// Sign out invalidates the session
session.signout().await.map_err(|(e, _)| e)?;
```

`session.info().public_key()` returns the user's `PublicKey`. `signout()`'s `Err` is a tuple
`(Error, _)` (it hands the session back on failure) — recover just the error with
`.map_err(|(e, _)| e)?`.

Persist a session across restarts. **Rust naming differs from JS:** `export_secret` /
`import_secret` (JS uses `export` / `restore`).

```rust
// Export session as a portable string (e.g. save to disk before shutdown)
let token = session.export_secret();

// On restart, restore without re-authenticating.
// Pass the existing client to reuse its connection pool.
let restored = pubky::PubkySession::import_secret(&token, Some(pubky.client().clone())).await?;
```

> **The exported token is a bearer credential** (the auth secret). Persist it only for the
> short relay TTL and treat it like a password. Persistence semantics are detailed in
> [`./auth.md`](./auth.md).

**Multiple identities:** call `pubky.signer(keypair).signin()` per keypair; each returns an
independent `PubkySession` for a separate identity — idiomatic for multi-account apps.

## Event streams

Event streams are **shipped**. Bring `futures_util::StreamExt` into scope for `.next()`. For
**one** user:

```rust
use futures_util::StreamExt;
use pubky::{Pubky, PublicKey};

let pubky = Pubky::new()?;
let user = PublicKey::try_from("o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo").unwrap();

let mut stream = pubky
    .event_stream_for_user(&user, None)
    .live()
    .subscribe()
    .await?;

while let Some(result) = stream.next().await {
    let event = result?;
    println!("{}: {} (cursor: {})", event.event_type, event.resource, event.cursor);
}
```

Each event exposes `.event_type`, `.resource`, and `.cursor`. For **multiple** users on one
homeserver, resolve the homeserver via `get_homeserver_of`, then add users with per-user
cursors (`EventCursor::new(n)`):

```rust
use futures_util::StreamExt;
use pubky::{EventCursor, Pubky, PublicKey};

let homeserver = pubky.get_homeserver_of(&user1).await.unwrap();

let mut stream = pubky
    .event_stream_for(&homeserver)
    .add_users([(&user1, None), (&user2, Some(EventCursor::new(100)))])?
    .live()
    .limit(100)
    .path("/pub/")
    .subscribe()
    .await?;

while let Some(result) = stream.next().await {
    let event = result?;
    println!("{}: {}", event.event_type, event.resource);
}
```

## `pubkyauth` flow

The full `pubkyauth` model (capabilities, signup tokens, the single-session-cookie caveat) is
canonical in [`./auth.md`](./auth.md). API shape (relying-app side):

```rust
use pubky::{AuthFlowKind, Capabilities, Pubky};

let pubky = Pubky::new()?;
let caps = Capabilities::default();
let flow = pubky.start_auth_flow(&caps, AuthFlowKind::signin())?;

// Display flow.authorization_url() as QR code for Pubky Ring to scan
let session = flow.await_approval().await?;
```

Resumable flows are also shipped — persist `flow.authorization_url().to_string()` and reconnect
to the same relay channel after a restart:

```rust
let flow = pubky.start_auth_flow(&caps, AuthFlowKind::signin())?;

// Persist only for the short relay TTL; the URL contains a client secret.
let authorization_url = flow.authorization_url().to_string();

// After restart or refresh, reconnect to the same relay channel.
let resumed = pubky.resume_auth_flow(&authorization_url)?;
let session = resumed.await_approval().await?;
```

(0.9.3 entrypoint is `start_auth_flow`; `main` renames it `start_cookie_auth_flow` — see the
drift note at the top.)

## End-to-end: typed records

Derive `Serialize` / `Deserialize`, `put_json` to your own storage, then read another user's
feed via `public_storage().list(...)` + `get_json` per entry. `PubkyResource` is the list-entry
type; the `put_json` / `get_json` calls require the `json` feature (`list` and `PubkyResource`
do not):

```rust
use pubky::{Keypair, Pubky, PubkyResource, PubkySession, PublicKey};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Post {
    content: String,
    timestamp: i64,
    author: String,
}

async fn publish_post(session: &PubkySession, post: &Post) -> anyhow::Result<()> {
    let post_id = post.timestamp.to_string();
    let path = format!("/pub/social/posts/{}", post_id);
    session.storage().put_json(&path, post).await?;
    Ok(())
}

async fn get_feed(pubky: &Pubky, public_key: &PublicKey) -> anyhow::Result<Vec<Post>> {
    let entries: Vec<PubkyResource> = pubky
        .public_storage()
        .list((public_key, "/pub/social/posts/"))?
        .limit(50)
        .reverse(true)
        .send()
        .await?;

    let mut posts = Vec::new();
    for entry in entries {
        let post: Post = pubky.public_storage().get_json(&entry).await?;
        posts.push(post);
    }
    Ok(posts)
}
```

## Escape hatch: raw requests

For raw HTTP/Pubky requests, `PubkyHttpClient` bypasses the storage helpers. Prefer
`session.storage()` / `public_storage()` for normal use.

```rust
use pubky::{Method, PubkyHttpClient};

let client = PubkyHttpClient::new()?; // or ::testnet()?
let mut rb = client.request(method, &url);
rb = rb.header(name, value);
if let Some(body) = data { rb = rb.body(body); }
let response = rb.send().await?;
```

It accepts `pubky://`, bare `pubky<user>/...`, and plain `https://` URLs; use `pubky::Method`.

## Crate map

Crate-root re-exports (docs.rs 0.9.3): structs `Pubky`, `PubkySigner`, `PubkySession`,
`PubkyAuthFlow`, `PubkyHttpClient`, `PublicStorage`, `SessionStorage`, `PublicKey`, `Keypair`,
`Capabilities`, `Pkdns`; modules `prelude` (common imports for quick starts), `errors` (`Error`
+ variant types), `pkarr`, `deep_links` (`SigninDeepLink` / `SignupDeepLink`), `recovery_file`.
`PublicKey` renders with a `pubky` prefix (public-key string formats are canonical in
[`./concepts.md`](./concepts.md)).

For a full testnet roundtrip (`EphemeralTestnet::builder()`, `testnet.sdk()?`, the local
`homeserver_app()`), the `pubky` crate is re-exported from `pubky_testnet::pubky` — see
[`./testing-and-testnet.md`](./testing-and-testnet.md).
