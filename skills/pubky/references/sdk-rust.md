# Rust client (`pubky` crate)

The `pubky` crate is the official Rust SDK for signing in and reading or writing `pubky://` data. This page covers install, client setup, storage calls and error handling. Protocol knowledge lives elsewhere:

- **[`concepts.md`](./concepts.md):** identity, `pubky://` addressing, PKARR, the homeserver model, [public-key string formats](./concepts.md#public-key-string-formats) and [path rules](./concepts.md#path-rules).
- **[`auth.md`](./auth.md):** `pubkyauth` flows, capabilities, selective approval, signup tokens, session lifecycle and grant management.
- **[`testing-and-testnet.md`](./testing-and-testnet.md):** `EphemeralTestnet` and local development.
- **[`shipped-vs-planned.md`](./shipped-vs-planned.md):** which features are production-ready.

**Upstream (authoritative):**
- **API reference:** [docs.rs/pubky/0.18.0](https://docs.rs/pubky/0.18.0/pubky/) ([latest](https://docs.rs/pubky/latest/pubky/)). If this page and docs.rs for your installed version disagree on a signature, trust docs.rs.
- **Crate docs:** [SDK README at v0.18.0](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md).
- **Breaking changes:** [GitHub release notes](https://github.com/pubky/pubky-homeserver/releases) ([v0.17.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1), [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0)). The only SDK migration guide is [v0.10](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md) (0.9.x → 0.10). For 0.16 → 0.18, read the release notes.
- **Crate source:** [`pubky-sdk/`](https://github.com/pubky/pubky-homeserver/tree/v0.18.0/pubky-sdk) in `pubky-homeserver`.
- **Runnable examples:** [`examples/rust`](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust). The knowledge base has no Rust snippets; its developer guide only says `cargo add pubky` and links docs.rs.

> **Version:** latest release **0.18.0** (2026-11-09). Pre-1.0; expect breaking changes. **MSRV 1.91**, edition 2024. 0.17.1 shipped 2026-10-26; **0.17.0 was never published**, so don't pin it.
> - **`main` carries unreleased API** past the v0.18.0 tag (`3b615c3`): `request_timeout` applied on wasm, `BuildError::RequestTimeoutTooLong` with `PubkyHttpClientBuilder::MAX_REQUEST_TIMEOUT`, child/delegated grants and a `GrantKind` re-export. Don't use them against 0.18.0, and don't trust the README on `main` for your version; use the v0.18.0 tag or docs.rs.
> - **Snippet verification:** every Rust snippet below passed `cargo clippy -- -D warnings` against `pubky` 0.18.0, and all except the CA-roots one were executed against a local testnet (2026-11-12). Each snippet's source is given under it.
>
> **Changes since 0.16** (full lists in the release notes):
> - **0.17.1:** `Error::CredentialRefresh(CredentialRefreshError)` for failed automatic grant refresh, and `RequestError::kind()` request categories (see [Error handling](#error-handling)). MSRV raised to 1.91. Homeserver: `HEAD` now returns 405 on `/signup_tokens/{token}`, admin `/generate_signup_token` and both `/events-stream` endpoints (storage `HEAD`, used by `exists`/`stats`, is unchanged).
> - **0.18.0 (breaking):** storage paths are plain names, not percent-encoded (see [How the SDK handles paths](#how-the-sdk-handles-paths)). `PubkyResource::new` takes `IntoResourcePath`. Native grant requests and `revalidate()` recover after a rejected bearer. New: `GrantSessionView::account()`, `RequestErrorKind::TlsVerification`, `expected_signer` on grant auth flows. A failed `/info` fetch no longer downgrades storage to legacy addressing. Homeserver: legacy Base32 event cursors are removed.
>
> **Cookie auth will be removed in August 2027.** Deprecated since 0.10.0, with only limited security maintenance from 0.18.0. Use grant auth ([v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md)).
>
> **0.10 broke the 0.9.x API.** `signin` takes a `ClientId`, `signup` returns `()`, and grant secrets replace session files. Discard code that calls `signin()` with no argument or uses `start_auth_flow`.

## Install and runtime

```bash
cargo add pubky --features json
cargo add tokio --features macros,rt-multi-thread
cargo add anyhow serde_json
cargo add futures-util   # only for event streams (StreamExt)
```

<sub>Executed: resolves `pubky` 0.18.0 from crates.io. Needs Rust 1.91 or newer.</sub>

- **Async only.** The crate needs an async runtime. The examples use Tokio with `#[tokio::main]`.
- **Features.** `default = []`. `json` adds `put_json`/`get_json` on `SessionStorage` and `get_json` on `PublicStorage`. Without it, use `put`/`get` with bytes or text.
- **Targets.** Native builds use `reqwest` 0.13 with rustls, pkarr 8.1 and Tokio. `wasm32` uses reqwest's fetch backend; the JS bindings wrap that build.
- **`pubky::prelude` omits** `ClientId`, `PubkySigner`, `PubkySession`, `SessionStorage`, `PublicStorage`, `GrantManager`, `Pkdns`, `EventStreamBuilder`, `AccountInfo` and `CredentialRefreshError`. Import those explicitly. Contents: [docs.rs `prelude`](https://docs.rs/pubky/0.18.0/pubky/prelude/index.html).
- **Re-exports:** `pubky::StatusCode` and `pubky::Method` (from reqwest) and `pubky::pkarr`. You don't need `reqwest` as a direct dependency to match status codes.
- **Logging.** Native builds log through `tracing`; wasm uses `log`. Install a subscriber before calling the SDK, for example `tracing_subscriber::fmt().with_env_filter(..)`. See [`examples/rust/7-logging`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/7-logging/main.rs).

## Quick start

```rust
use pubky::{ClientId, Keypair, Pubky, PublicKey};

let pubky = Pubky::new()?;
let keypair = Keypair::random();
let signer = pubky.signer(keypair);

// A new key has no account yet: sign up on a homeserver first
// (production homeservers may require a signup token instead of `None`).
let homeserver = PublicKey::try_from("<homeserver z32 public key>")?;
signer.signup(&homeserver, None).await?;

// Sign in
let session = signer
    .signin(ClientId::new("myapp.example").unwrap())
    .await?;

// Write data (requires the "json" feature)
let profile = serde_json::json!({"name": "Alice", "bio": "Building on Pubky!"});
session
    .storage()
    .put_json("/pub/myapp/profile", &profile)
    .await?;

// Read data
let profile: serde_json::Value = session.storage().get_json("/pub/myapp/profile").await?;
```

<sub>Adapted from the last KB Rust snippet, [`snippets/rust/src/lib.rs` @ bb7232d](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/rust/src/lib.rs), with a signup step added: `signin` with a fresh `Keypair::random()` fails with "could not resolve homeserver". Executed against a local testnet (`Pubky::testnet()` and the testnet homeserver key). The body goes inside an `async fn` returning `anyhow::Result<()>`, because `PublicKey::try_from`'s error doesn't convert into `pubky::Error`. For a returning user, skip `signup` and load the existing key (`pubky.signer_from_recovery_file(..)`); see [`auth.md`](./auth.md).</sub>

| Type | Role |
|---|---|
| `Pubky` | Entry point. Holds the HTTP transport and creates the other handles |
| `PubkySigner` | Holds a key locally: `signup`, `signin`, approving QR auth, `pkdns()` |
| `PubkySession` | Authenticated handle for acting as the user; `session.storage()` |
| `SessionStorage` | Read/write the session user's data, including locks |
| `PublicStorage` | Unauthenticated reads of any user's public data |
| `GrantManager` | Grant management; see [`auth.md`](./auth.md#list-and-revoke-grants) |
| `Pkdns` | Resolves and publishes `_pubky` records |
| `PubkyHttpClient` | Transport; raw HTTP to `pubky` and `_pubky` hosts |

## Client setup

- `Pubky::new() -> Result<Self>`: mainnet, with **no HTTP timeouts**.
- `Pubky::testnet() -> Result<Self>`: local testnet (DHT `localhost:6881`, relay `http://localhost:15411`).
- `Pubky::with_client(PubkyHttpClient) -> Self`: wraps a client you configured.
- **Create one `Pubky` at startup and reuse it.** It is `Clone`; clone it, pass it down or hold it in a `OnceCell`. Don't create one per request.

In production, set timeouts (native only in 0.18.0):

```rust
use std::time::Duration;
use pubky::{Pubky, PubkyHttpClient};

let client = PubkyHttpClient::builder()
    .request_timeout(Duration::from_secs(30))
    .read_timeout(Duration::from_secs(10))
    .build()?;
let pubky = Pubky::with_client(client);
```

<sub>Source: [`Pubky::with_client` doc example](https://docs.rs/pubky/0.18.0/pubky/struct.Pubky.html#method.with_client). Works with `?` in a `pubky::Result` fn, because `Error::Build(BuildError)` has a `From` impl.</sub>

**`PubkyHttpClientBuilder`** ([docs.rs](https://docs.rs/pubky/0.18.0/pubky/struct.PubkyHttpClientBuilder.html)):
- Setters take `&mut self -> &mut Self`, and `build(&self)` returns `Result<PubkyHttpClient, BuildError>`, so one-expression chains compile.
- All targets: `testnet()`, `testnet_with_host(&str)`, `pkarr(|p| ..)`, `user_agent_extra(..)`, `max_error_body_bytes(usize)`.
- Native only: `request_timeout`, `read_timeout`, `pool_max_idle_per_host(usize)` (0 disables pooling) and `add_root_certificates_pem` (0.15.0+). **In 0.18.0, the two timeouts are deprecated no-ops on wasm.** (`main` applies `request_timeout` on wasm and makes `build()` fail above `MAX_REQUEST_TIMEOUT`; unreleased.)
- Defaults: pkarr default relays, **no total or read timeout**, 4096-byte error-body capture, user agent `pubky.org@<crate-version>`, Mozilla roots for ICANN HTTPS.
- `BuildError` is not `#[non_exhaustive]`, and `main` adds a variant. Keep a catch-all arm if you match on it.

Extra CA roots for ICANN HTTPS (0.15.0+; for example, a corporate proxy CA). They add to the Mozilla roots and do **not** affect PubkyTLS or the pkarr relay client. The method returns `Result`, so bind the builder with `let mut`:

```rust
use pubky::PubkyHttpClient;
let pem = std::fs::read(std::env::var("SSL_CERT_FILE")?)?;
let mut builder = PubkyHttpClient::builder();
builder.add_root_certificates_pem(&pem)?;
let client = builder.build()?;
```

<sub>Source: [`add_root_certificates_pem` doc example](https://docs.rs/pubky/0.18.0/pubky/struct.PubkyHttpClientBuilder.html#method.add_root_certificates_pem). Needs a fn returning `anyhow::Result` or `Result<_, Box<dyn Error>>`; the env and IO errors don't convert into `pubky::Error`. Compiled and run (`build()` succeeds), but makes no request, so it was not exercised against a testnet.</sub>

**Transport:** native clients prefer PubkyTLS, which verifies the homeserver's public key directly. The SDK uses an ICANN HTTPS endpoint advertised in PKARR only when the direct endpoint is absent or fails a TCP reachability check. A later TLS or request failure does **not** fall back. Native clients behind HTTPS proxies have known discovery and routing limits ([pubky-homeserver#657](https://github.com/pubky/pubky-homeserver/issues/657)). Model: [`concepts.md`](./concepts.md#transport-and-wire-addressing).

## Sign up and sign in

- `signer.signup(homeserver: &PublicKey, signup_token: Option<&str>) -> Result<()>` creates the account and publishes the homeserver record. It returns **no session**. Tokens: [`auth.md`](./auth.md#signup-tokens).
- `signer.signin(ClientId) -> Result<PubkySession>` locally signs a **root-capability** grant (`/:rw`, no encryption keys) and republishes a stale PKDNS record in the background.
- `signin_blocking(ClientId)` waits about 3–5 s for that republish. Use it for first-time setup, when the identity must be discoverable at once.
- Get a signer with `pubky.signer(keypair)`, which reuses the shared client. `PubkySigner::new(Keypair)` builds its own.
- `ClientId::new(&str)` only checks that the string is non-empty and at most 253 bytes. By convention, use your app's domain.

```rust
let pubky = if cli.testnet {
    Pubky::testnet()?
} else {
    Pubky::new()?
};

let signer = pubky.signer(keypair);
signer
    .signup(&homeserver, cli.signup_code.as_deref())
    .await?;
```

<sub>Source (runnable): [`examples/rust/1-signup/signup.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/1-signup/signup.rs). `homeserver` is a `PublicKey` from `PublicKey::try_from(&str)?`, in a fn returning `anyhow::Result`. Call `signin` afterwards to get a session.</sub>

> **Gotcha: `?` does not convert these errors into `pubky::Error`.** `ClientId::new` returns `pubky_common::auth::jws::Error` and `PublicKey::try_from` returns `ParseError`. Neither has a `From` impl into `pubky::Error`, so in a fn returning `pubky::Result`, `?` on either fails with E0277.
> - For static values, call `.expect(..)`, as the SDK README does.
> - Otherwise return `anyhow::Result`, as the examples do.

**Other auth APIs** (Rust calls in [`auth.md`](./auth.md)):
- **Third-party and keyless sign-in:** `pubky.start_grant_auth_flow(&caps, AuthFlowKind, ClientId)`. See [`auth.md`](./auth.md#third-party-app-grant-auth-flow).
- **Pin the approving identity (0.18.0+):** `PubkyGrantAuthFlow::builder(..).expected_signer(public_key)` adds `spk=<z32>` to a sign-in link, so an approval from any other key is rejected. Sign-up flows reject it. Use it only when the app already knows the user, for example to re-authorize or upgrade capabilities.
- **Selective approval (0.16.1+):** `signer.approve_auth_with_capabilities(url, &approved)` approves a subset; `approve_auth()` approves everything requested. See [`auth.md`](./auth.md#selective-approval).
- **Scoped encryption keys (0.16.0+):** the `e` capability action, read through `grant.encryption_keys()`. This is client-side key delivery, **not** homeserver-encrypted storage, which is still planned ([`shipped-vs-planned.md`](./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage)). The keys are **permanent**: they derive from the identity secret, survive grant revocation and expiry, and can't be rotated. Read [`auth.md`](./auth.md#scoped-encryption-keys) before requesting `e`.
- **Recovery files:** `pubky.signer_from_recovery_file(path, passphrase)` (native only), or `pubky::recovery_file::decrypt_recovery_file(&bytes, &passphrase)` (all targets). The examples try an **empty passphrase** first because the bundled testnet `sample_recovery.key` uses one. Don't copy that fallback into production code.

## Session storage (your own data)

`session.storage()` returns a `SessionStorage` ([docs.rs](https://docs.rs/pubky/0.18.0/pubky/struct.SessionStorage.html)). Paths are generic over `P: IntoResourcePath` (`&str`, `String`, `ResourcePath`).

| Method | Returns | Notes |
|---|---|---|
| `get(path)` | `Result<reqwest::Response>` | Every non-2xx is `Err`, **including 404** |
| `get_json::<T>(path)` | `Result<T>` | `json` feature |
| `put(path, body: impl Into<reqwest::Body>)` | `Result<Response>` | `Vec<u8>`, `String`, `bytes::Bytes` or a literal. A borrowed non-`'static` `&str` fails (E0597), so pass `.to_owned()` |
| `put_json(path, &body)` | `Result<Response>` | `json` feature |
| `delete(path)` | `Result<Response>` | |
| `exists(path)` | `Result<bool>` | Sends `HEAD`; 404 and 410 give `false`. Use it instead of catching a 404 from `get` |
| `stats(path)` | `Result<Option<ResourceStats>>` | `content_length`, `content_type`, `last_modified`, `etag` (each an `Option`) |
| `list(path)` | `Result<ListBuilder>` | **Not async.** Call `.send().await` on the builder |
| `lock` and friends | | See [Storage locks](#storage-locks) |

Ignore `prepare_blob_put`/`retry_blob_put`: they are wasm-only, `#[doc(hidden)]` helpers for the JS binding.

```rust
let storage = session.storage();

// Write
storage.put("/pub/my.app/hello.txt", "world").await?;

// Read
let body = storage.get("/pub/my.app/hello.txt").await?.text().await?;

// Check existence
let exists = storage.exists("/pub/my.app/hello.txt").await?;

// Metadata (content-length, content-type, etag, last-modified)
if let Some(stats) = storage.stats("/pub/my.app/hello.txt").await? {
    println!("size: {:?}", stats.content_length);
}

// List a directory (path must end with `/`)
let entries = storage.list("/pub/my.app/")?.limit(50).send().await?;

// Delete
storage.delete("/pub/my.app/hello.txt").await?;
```

<sub>Source: [`SessionStorage` rustdoc overview](https://docs.rs/pubky/0.18.0/pubky/struct.SessionStorage.html), inside `async fn(session: PubkySession) -> pubky::Result<()>`. Runnable put/get/delete program: [`examples/rust/3-storage`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/3-storage/main.rs).</sub>

**Failure contract:**
- An invalid path gives `Error::Request(RequestError::Validation { .. })`. A bad URL gives `Error::Parse`.
- Any non-2xx status, including 401, 403 and 5xx, gives `RequestError::Server { status, message }`.
- Only `exists` and `stats` treat 404/410 as "missing".
- With an expired grant bearer, storage calls refresh it automatically. A failed refresh returns `Error::CredentialRefresh`, not `Error::Request` (see [Error handling](#error-handling)).

### How the SDK handles paths

Protocol rules: [`concepts.md`](./concepts.md#path-rules).

- **A path is the file's plain name (0.18.0+).** Write `/pub/my.app/My File.txt`. `ResourcePath` stores it unencoded, and the SDK percent-encodes once when it builds the HTTP URL. `Display`, `as_str()` and `to_pubky_url()` return the plain name. Up to 0.17, they returned `/pub/My%20File.txt`.
- The SDK adds a missing leading `/`, so `"pub/app/f"` and `"/pub/app/f"` are the same path. It keeps a trailing `/`.
- Empty paths, `//` and `.`/`..` segments are `RequestError::Validation`. Other name rules (characters, length) belong to the homeserver, which answers 400.
- **`list()` needs a trailing `/`.** Without one, it fails at once with ``directory listings must end with `/` ``.
- **A path can't be both a file and a folder.** Writing one where the other exists returns **409 Conflict**.
- Keep app data under a domain-like folder, such as `/pub/my.app/`. The `/pub` layout is **not stabilized**.

```rust
use pubky::ResourcePath;
// Parse from &str (relative becomes absolute)
let p = ResourcePath::parse("pub/my-cool-app/file")?;
assert_eq!(p.to_string(), "/pub/my-cool-app/file");

// Trailing slash is preserved
let dir = ResourcePath::parse("/pub/my-cool-app/")?;
assert_eq!(dir.to_string(), "/pub/my-cool-app/");

// Names keep their characters as written
let name = ResourcePath::parse("pub/My File.txt")?;
assert_eq!(name.to_string(), "/pub/My File.txt");
```

<sub>Source: [`ResourcePath` rustdoc doctest](https://docs.rs/pubky/0.18.0/pubky/struct.ResourcePath.html) (CI-run), inside a fn returning `pubky::Result<()>`.</sub>

> **Upgrading from ≤0.17: old files keep their encoded names.** Files that SDK 0.6–0.17 wrote under a name that HTTP encoding escapes were stored with the escape in the name: `pub/my file.txt` was stored as `pub/my%20file.txt`. They are **not** renamed. From 0.18, read them at the stored name (`"pub/my%20file.txt"`); upstream says "`list()` will display the path correctly". A `%` in a name is now encoded once (`/pub/100%.txt` goes on the wire as `/pub/100%25.txt`). `StoragePath::url_encode` (`pubky-common`) remains only as a deprecated wrapper.

> **`/priv` is ALPHA (v0.10.0+) and NOT for production.** The rustdoc says `/priv/` paths are private to the signed-in user, but that is access control, **not encryption**: a homeserver admin can read and write all tenant data, including `/priv`. Apps that need confidentiality from the homeserver must encrypt data and manage keys themselves. Upstream's [`docs/PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md) has only JavaScript and raw-HTTP examples, no Rust. See [`shipped-vs-planned.md`](./shipped-vs-planned.md#priv-private-storage-alpha).

**Listing** (`ListBuilder`, `#[must_use]`; nothing is sent until `.send()`):
- `.reverse(bool)`, `.shallow(bool)` (skip subfolder contents), `.limit(u16)` (the homeserver may cap it) and `.cursor(&str)`.
- `.send().await` returns `Result<Vec<PubkyResource>>`. An empty page is an empty `Vec`. A missing directory is a 404 `RequestError::Server`. A bad cursor is a 400.
- To paginate, pass the previous page's last `entry.to_pubky_url()` to `.cursor(..)`.

**`PubkyResource` renderings:**
- `to_pubky_url()` gives `pubky://<z32><path>`, the form listings, event streams and cursors use. `FromStr` parses it back.
- `Display` gives the identifier form `pubky<z32><path>`.
- `to_transport_url()` gives `https://_pubky.<z32>/storage/<z32><path>` with the path percent-encoded.
- `PubkyResource::new(owner: PublicKey, path: impl IntoResourcePath)` (0.18.0; it took `AsRef<str>` before).

## Storage locks

WebDAV-style locks (SDK and homeserver 0.13.0+; JS bindings since 0.15.0). The homeserver advertises the `webdav-locks` feature. Model: [`concepts.md`](./concepts.md#storage-locks). API: [`StorageLock`](https://docs.rs/pubky/0.18.0/pubky/struct.StorageLock.html).

- `storage.lock(path, timeout: Duration) -> Result<StorageLock>`
- `storage.refresh_lock(&mut lock, Duration) -> Result<()>`
- `storage.put_locked(&lock, body) -> Result<Response>`
- `storage.delete_locked(&lock) -> Result<Response>`. This leaves the lock in place.
- `storage.unlock(&lock) -> Result<()>`
- `StorageLock` has `path()`, `token()` (`opaquelocktoken:<uuid>`), `timeout()` and `if_header()`. `timeout()` is the **granted** time, which may be shorter than requested.

```rust
let storage = session.storage();
let lock = storage.lock("/pub/my.app/state.json", Duration::from_secs(30)).await?;
let state = storage.get(lock.path()).await?.bytes().await?;
// ... modify `state` ...
storage.put_locked(&lock, state).await?;
storage.unlock(&lock).await?;
```

<sub>Source: [`StorageLock` rustdoc example](https://docs.rs/pubky/0.18.0/pubky/struct.StorageLock.html#example), inside `async fn example(session: pubky::PubkySession) -> pubky::Result<()>` with `use std::time::Duration;`. Needs a homeserver with lock support.</sub>

| Call | Status | Meaning / what to do |
|---|---|---|
| `lock` | 423 | Already locked; back off and retry |
| `lock` | 400 | Target is a directory, or a shared lock was requested |
| `lock` | 405 | Homeserver has no lock support |
| `refresh_lock`, `put_locked`, `delete_locked` | 412 | Lock expired or was unlocked. Take a new lock **and** re-read the file |
| `put_locked` | 409 | File changed since the write was prepared. Re-read and retry |
| `unlock` | 409 | Lock no longer exists |
| any write without the token | 423 | Someone else holds the lock |

The 412 refusal of locked writes after the lock is lost shipped in homeserver 0.15.0; 0.13/0.14 homeservers may not return it. All of these surface as `RequestError::Server { status, .. }`. Handling a held lock:

```rust
match storage.lock("/pub/my.app/state.json", Duration::from_secs(30)).await {
    Ok(lock) => { /* read, modify, put_locked, unlock */ storage.unlock(&lock).await?; }
    Err(pubky::Error::Request(pubky::errors::RequestError::Server { status, .. }))
        if status == pubky::StatusCode::LOCKED => { /* back off and retry */ }
    Err(e) => return Err(e),
}
```

<sub>Authored for this page (not upstream), inside `async fn(storage: SessionStorage) -> pubky::Result<()>`. Both the `Ok` and `LOCKED` arms were executed.</sub>

- **The homeserver caps a lock at 60 s** (default 30; `Infinite` gets the cap). Call `refresh_lock` to hold it longer. A write made under the lock keeps it alive until the write ends.
- **The lock token is a bearer token.** Anyone holding it who can write the path can use or release it. Don't log it.
- Ordinary `put`/`delete` never take locks. The app owns the lock lifecycle and retries.

## Public storage (other users' data)

`pubky.public_storage()` returns a read-only `PublicStorage` with `get`, `get_json` (`json` feature), `exists`, `stats` and `list`. Prefer it to `PublicStorage::new()`, which builds a separate client.

Accepted address forms (`A: IntoPubkyResource`): `pubky<z32>/pub/...` (preferred), `pubky://<z32>/...`, a `(PublicKey, path)` or `(&PublicKey, path)` tuple, and `PubkyResource`. **`https://_pubky.<z32>/...` is not accepted.**

```rust
use pubky::{Pubky, PublicKey};

let pubky = Pubky::new()?;
let public = pubky.public_storage();

let file = public
    .get(format!("{user_id}/pub/example.com/file.bin"))
    .await?
    .bytes()
    .await?;

let entries = public
    .list(format!("{user_id}/pub/example.com/"))?
    .limit(10)
    .send()
    .await?;
for entry in entries {
    println!("{}", entry.to_pubky_url());
}
```

<sub>Source: [SDK README, Storage API](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#storage-api-session--public) (doctest), inside `async fn run(user_id: PublicKey) -> pubky::Result<()>`. Use `Pubky::testnet()` against a local testnet. The tuple form `public.get((&user_id, "/pub/example.com/file.bin"))` also compiles.</sub>

**Key formats in Rust** (full rules: [`concepts.md`](./concepts.md#public-key-string-formats)):
- `format!("{user}")` / `.to_string()` gives `pubky<z32>`, valid in the compact address form above.
- `user.z32()` gives raw z32: use it for `pubky://` URLs, `_pubky.<z32>` hostnames, headers, query parameters and database keys. Example: `format!("pubky://{}/pub/pubky.app/profile.json", user.z32())`.
- Never write `pubky://pubky<z32>`; the parser rejects it.

## Error handling

- `pubky::Result<T>` is `Result<T, pubky::Error>`. Details: [docs.rs `Error`](https://docs.rs/pubky/0.18.0/pubky/errors/enum.Error.html).
- `pubky::Error` variants (0.18.0): `Request(RequestError)`, `CredentialRefresh(CredentialRefreshError)` (0.17.1+), `Pkarr(PkarrError)`, `Parse(url::ParseError)`, `Authentication(AuthError)` and `Build(BuildError)`.
- **Always keep a catch-all `Err(e)` arm.** The enum isn't `#[non_exhaustive]`; adding `CredentialRefresh` in 0.17.1 broke exhaustive matches, and later variants will too.
- `RequestError` (`pubky::errors::RequestError`):
  - `Server { status, message }`: any non-2xx response. `message` holds **at most the error-body limit**, not the whole body.
  - `Transport(reqwest::Error)`: the request didn't complete, or reading a response body failed (`From<reqwest::Error>` maps here, so `.text().await?` errors land in `Transport`).
  - `Validation { message }`: bad input, such as an invalid path.
  - `DecodeJson { message }`: a JSON body didn't parse.
- `PkarrError::is_retryable()` is `true` only for `Publish` and `Resolve`. `pubky::Error` itself has no `is_retryable()`.

**`CredentialRefreshError`** ([docs.rs](https://docs.rs/pubky/0.18.0/pubky/enum.CredentialRefreshError.html); crate root, `#[non_exhaustive]`, 0.17.1+):
- One variant: `Request { status: Option<StatusCode> }`. `status` is `None` for transport failures.
- Returned by storage calls, `refresh_if_needed()`, `force_refresh()` and `revalidate()` when automatic grant-bearer refresh fails. For `revalidate()`, a revoked grant gives `Ok(None)` instead. Other failures keep their original variants.
- Secret-safe: `Display`/`Debug` omit URLs, response bodies, grants, proofs and bearer values. The refresh path never reads the error body, whatever `max_error_body_bytes` says.

**Request categories (0.17.1+):** `RequestError::kind()` returns a [`RequestErrorKind`](https://docs.rs/pubky/0.18.0/pubky/errors/enum.RequestErrorKind.html) (`Copy + Eq + Hash`, `#[non_exhaustive]`, so a wildcard arm is required). Branch on it instead of digging into `reqwest::Error`. Several kinds can come from a `Transport` error, so don't infer the `RequestError` variant from the kind.

| `RequestErrorKind` | From | Notes |
|---|---|---|
| `Http { status: u16 }` | `Server`, or a `Transport` error that carries a status | |
| `Timeout` | `Transport` | Takes precedence over other transport kinds |
| `Connection` | `Transport` | Native only |
| `TlsVerification` | `Transport` | 0.18.0+, native only; see below |
| `Body` | `Transport` (upload) | In practice, request-body failures; response reads report as `Decode` |
| `Decode` | `DecodeJson`, or a `Transport` response-body read | Covers failed `.bytes().await?`/`.text().await?` and incomplete framing, not only JSON parsing |
| `InvalidRequest` | `Validation`, or a `Transport` builder error | |
| `Other` | `Transport` | Browsers often report `Other` |

- The kind carries no URL, body or credentials, so it is safe to log.
- **A kind describes what happened, not whether a retry is safe.** A timeout doesn't prove a write wasn't committed. Make retried writes idempotent, or check with `stats`/`get` first.
- **`TlsVerification`** means the server certificate was rejected: by the PubkyTLS verifier for pkarr hosts (the key presented isn't in the client's HTTPS/SVCB records), or by the X.509 verifier for ICANN hosts. A stale record after a legitimate key rotation looks the same as interception, so it doesn't prove tampering. Retrying without re-resolving the record is unlikely to help.

```rust
use pubky::errors::RequestErrorKind;

match storage.get("/pub/my.app/state.json").await {
    Ok(resp) => { let _bytes = resp.bytes().await?; }
    Err(pubky::Error::Request(e)) => match e.kind() {
        RequestErrorKind::Http { status: 404 } => { /* missing: prefer exists()/stats() */ }
        RequestErrorKind::Timeout | RequestErrorKind::Connection => { /* transient; a timed-out write may still have committed */ }
        RequestErrorKind::TlsVerification => { /* re-resolve the homeserver record before retrying */ }
        _ => return Err(pubky::Error::Request(e)),
    },
    Err(e) => return Err(e),
}
```

<sub>Authored for this page (not upstream), inside `async fn(storage: pubky::SessionStorage) -> pubky::Result<()>`; the 404 and `Ok` arms were executed. API from [`errors.rs` @ v0.18.0](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/src/errors.rs) and the [README "Request errors" section](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#request-errors).</sub>

**Error-body limit (0.13.0+):**
- Successful bodies are left unread. For an HTTP error, the client captures up to **4096 bytes** of the body into `message`. Longer bodies end with `\n[response body truncated at N bytes]`.
- Lossy UTF-8 decoding can make `message` up to 3x the byte cap.
- `max_error_body_bytes(0)` skips the body read and uses the HTTP status reason.
- The limit applies to every checked request except credential refresh, which never reads the body. (The v0.18.0 rustdoc on `max_error_body_bytes` says it includes credential refresh; that wording is stale. The README and the code exclude refresh.)
- A body that stalls below the cap still needs a request timeout.

```rust
use pubky::{Pubky, PubkyHttpClient};

let client = PubkyHttpClient::builder()
    .max_error_body_bytes(1024)
    .build()?;
let pubky = Pubky::with_client(client);
```

<sub>Source: [SDK README, Error-body limits](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#error-body-limits) (doctest), inside a fn returning `Result<_, pubky::BuildError>` or `pubky::Result`.</sub>

Match on the status code. This helper treats a repeated signup (409) as success:

```rust
pub async fn ensure_signup(signer: &PubkySigner, homeserver: &PublicKey) -> Result<()> {
    match signer.signup(homeserver, None).await {
        Ok(()) => println!("Signed up to the testnet homeserver."),
        Err(pubky::Error::Request(pubky::errors::RequestError::Server { status, .. }))
            if status == pubky::StatusCode::CONFLICT =>
        {
            println!("Testnet user already exists, continuing...");
            signer
                .pkdns()
                .publish_homeserver_force(Some(homeserver))
                .await?;
            println!("Published testnet homeserver record.");
        }
        Err(err) => return Err(err.into()),
    }

    Ok(())
}
```

<sub>Source (runnable helper): [`examples/rust/testnet.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/testnet.rs). Upstream writes `reqwest::StatusCode`; `pubky::StatusCode` is the same type, re-exported. Imports: `use anyhow::Result; use pubky::{PubkySigner, PublicKey};`.</sub>

## Sessions: sign out and persist

Refresh, revalidation, restore behavior and grants: [`auth.md`](./auth.md#session-lifecycle). This section shows the Rust calls.

- `PubkySession` is cheap to clone and thread-safe.
- `info() -> SessionInfo`, `public_key() -> PublicKey`, `storage() -> SessionStorage`, and the views `as_grant()` / `as_cookie()`.
- `revalidate() -> Result<Option<SessionInfo>>`: `Some` is valid, `None` means expired or invalidated, `Err` is a transport or server error. Grant sessions may refresh their bearer during the check. Since 0.18.0, native grant requests and `revalidate()` recover after the homeserver rejects a bearer.
- `client()` returns the raw HTTP client **without** credentials.
- `signout(self) -> Result<(), (Error, Self)>` consumes the session and gives it back on failure.

```rust
session.signout().await.map_err(|(e, _session)| e)?;

// non-fatal variant (examples/rust/6-session_management)
async fn signout(session: PubkySession) {
    if let Err((err, _session)) = session.signout().await {
        eprintln!("Warning: failed to sign out management session: {err}");
    }
}
```

<sub>Source: [`PubkySession` rustdoc](https://docs.rs/pubky/0.18.0/pubky/struct.PubkySession.html) and [`examples/rust/6-session_management`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/6-session_management/main.rs).</sub>

> **Signing out revokes the grant**, not just the session: every session from that grant stops working and its saved secrets no longer restore. Other grants are unaffected. If the session token was already invalid, sign-out can report success without revoking. Details: [`auth.md`](./auth.md#session-lifecycle).

**Persist** the exported grant secret, not the bearer token:

```rust
use pubky::{ClientId, Pubky};
let pubky = Pubky::new()?;
let signer = pubky.signer_from_recovery_file("/path/to/alice.pkarr", "passphrase")?;
let session = signer
    .signin(ClientId::new("my-cool-app").unwrap())
    .await?;
let grant = session
    .as_grant()
    .expect("signin creates a grant-backed session");
let secret = grant
    .export_local_secret()
    .await
    .expect("signin creates an exportable local PoP key");

// Store `secret` securely, then load it when the application restarts.
let restored = pubky.restore_session(&secret).await?;
```

<sub>Source: [SDK README, Keypair and session persistence](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#keypair-and-session-persistence), inside an `async fn` returning `anyhow::Result<()>`. Needs a real recovery file and a signed-up identity.</sub>

> **The exported secret is unencrypted and highly sensitive.** It contains the grant, its private proof-of-possession key and, for signed approvals, the encryption keys. Anyone holding it can act as the user within the capabilities until the grant expires or is revoked, and the encryption keys stay usable after that. Store it in a secret store (for example, the OS keychain). Never log or commit it.

> **Deprecated cookie auth, removed in August 2027. Don't use:** `start_cookie_auth_flow`, `resume_cookie_auth_flow`, `session_from_file`, `signup_cookie`, `signin_cookie`, `signin_cookie_blocking`, `export_secret` and `import_secret`. The `.sess` file helpers are cookie-only, and **`write_secret_file` panics on grant sessions**.

### Account info and quota (0.18.0+)

`session.as_grant()?.account().await -> Result<AccountInfo>` ([docs.rs](https://docs.rs/pubky/0.18.0/pubky/struct.GrantSessionView.html#method.account)) calls `GET /account`.

- **Grant sessions with root read only** (`/:r`, `/:rw`, …). A path-scoped session gets 403. Errors: 401/403 as `RequestError::Server`; an unparsable body as `RequestError::DecodeJson`.
- A disabled user can still read it, so use it to explain why writes fail.
- [`AccountInfo`](https://docs.rs/pubky/0.18.0/pubky/struct.AccountInfo.html): `pubky`, `created_at: String`, `disabled: bool`, `used_bytes: u64`, `quota: AccountQuota { effective, overrides }`.
- Every `QuotaLimits` field is an `Option`; `storage_quota_mb` and the read/write rates are `QuotaLimit<T>`, which is `Unlimited | Value(T)`. `AccountInfo`, `AccountQuota`, `QuotaLimit` and `QuotaLimits` are re-exported at the crate root.

```rust
let grant = session
    .as_grant()
    .expect("signin creates a grant-backed session");
let account = grant.account().await?;
println!(
    "used {} bytes, disabled: {}",
    account.used_bytes, account.disabled
);
```

<sub>Authored for this page (not upstream), inside `async fn(session: pubky::PubkySession) -> pubky::Result<()>` with a root-scoped session from `signer.signin`. `as_grant()` is `None` for a cookie session; where that is possible, handle the `None` instead of calling `expect`.</sub>

## Events, PKDNS and raw HTTP

**Event streams** ([`EventStreamBuilder`](https://docs.rs/pubky/0.18.0/pubky/struct.EventStreamBuilder.html)):
- **One user:** `pubky.event_stream_for_user(&user, cursor: Option<EventCursor>)`.
- **Several users on one homeserver:** `pubky.event_stream_for(&homeserver).add_users(..)?`. Resolve the homeserver first with `get_homeserver_of`.
- **Builder:** `.limit(u16)`, `.max_event_bytes(usize)` (0.13.0+), `.live()`, `.reverse()`, `.path(..)` (repeatable) and `.session(&PubkySession)`.
- `.subscribe().await` returns `Result<Pin<Box<dyn Stream<Item = Result<Event>> + Send>>>` (not `Send` on wasm). Consume it with `futures_util::StreamExt::next`.
- `Event` has `event_type` (`Display`; `.content_hash()` returns an `Option`), `resource` and `cursor`.
- **Cursors are numeric event IDs.** `EventCursor` is a `u64` newtype, so SDK code is unaffected by homeserver 0.18.0 removing legacy Base32 timestamp cursors (raw HTTP clients now get 400). Persist the numeric cursor, or restart from 0 and handle repeated events.

```rust
let stream = pubky.event_stream_for_user(&user, None)
    .max_event_bytes(8192)
    .live()
    .subscribe()
    .await?;
```

<sub>Source: [SDK README, Event-stream limits](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#event-stream-limits), inside `async fn example(pubky: pubky::Pubky, user: pubky::PublicKey) -> pubky::Result<()>`.</sub>

> **Set `max_event_bytes` on untrusted streams.** The default is `usize::MAX`, which is effectively unbounded. The limit applies separately to event data, the event name and the ID. It is independent of `.limit()` (event count) and `max_error_body_bytes`. `0` is rejected at subscription time.
>
> Stream behavior since 0.13.0:
> - **Overflow:** the SDK closes the response, yields **one** validation error and ends the stream.
> - **Invalid UTF-8** is replaced, not reported.
> - **Incomplete events at EOF** are discarded.
> - **A transport error ends the stream.** Reconnect from the last cursor.

```rust
let mut builder: EventStreamBuilder = if users.len() == 1 {
    let (user, cursor) = &users[0];
    pubky.event_stream_for_user(user, *cursor)
} else {
    let (first_user, _) = &users[0];
    let homeserver = pubky
        .get_homeserver_of(first_user)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Could not resolve homeserver for user {first_user}"))?;

    let users_refs: Vec<_> = users.iter().map(|(u, c)| (u, *c)).collect();
    pubky.event_stream_for(&homeserver).add_users(users_refs)?
};
// upstream then reassigns `builder` (e.g. `builder = builder.live();`), hence `let mut`
```

<sub>Source (runnable, excerpt): [`examples/rust/5-events_stream/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/5-events_stream/main.rs), inside an `async fn` returning `anyhow::Result<()>` with `users: Vec<(PublicKey, Option<EventCursor>)>`.</sub>

**PKDNS** (what `_pubky` records are: [`concepts.md`](./concepts.md#pkarr-resolution)):
- `pubky.get_homeserver_of(&pk) -> Result<Option<PublicKey>>`. It returns `Ok(None)` when there is no record or no homeserver configured, and `Err(Error::Pkarr(_))` when resolution fails or the `_pubky` target isn't a valid key; retry when `is_retryable()` is true.

```rust
use pubky::{Pubky, PublicKey, Keypair};
let pubky = Pubky::new()?;

// read-only homeserver resolver
let host: Option<PublicKey> = pubky.get_homeserver_of(&other).await?;

// publish with your key
let signer = pubky.signer(Keypair::random());
signer.pkdns().publish_homeserver_if_stale(None).await?;
// or force republish (e.g. homeserver migration)
signer.pkdns().publish_homeserver_force(Some(&new_homeserver_id)).await?;
// resolve your own homeserver
signer.pkdns().get_homeserver().await?;
```

<sub>Source: [SDK README, PKDNS](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/README.md#pkdns-pkarr), inside `async fn run(other: PublicKey, new_homeserver_id: PublicKey) -> pubky::Result<()>`. Use `Pubky::testnet()` against a local testnet.</sub>

**Raw HTTP** (only for requests the storage APIs don't cover):
1. `pubky::resolve_pubky(id)` turns a public resource id into its canonical `https://_pubky.<z32>/storage/<z32>/...` URL.
2. `client.request_async(Method, Url)` returns `Result<RequestBuilder>`. It picks PubkyTLS or ICANN transport and falls back to legacy storage addressing only when the homeserver doesn't advertise `path-addressed-storage`. **Use it for Pubky and PKDNS URLs.**
3. Since 0.18.0, a failed `/info` fetch no longer downgrades to legacy addressing: the SDK keeps the last known features and caches the failure for 5 s (success for 60 s).

`PubkyHttpClient::request(method, &url)` is native-only and synchronous. It does **not** negotiate storage addressing or ICANN fallback. The [`4-request`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/4-request/main.rs) example uses it.

## Runnable examples

[`pubky-homeserver/examples/rust`](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust) contains these binaries: `keygen`, `signup` (1-signup), `authenticator` and `auth_client` (2-auth_flow), `storage` (3-storage), `request` (4-request), `events_stream` (5-events_stream), `sessions` (6-session_management), `logging` (7-logging) and `testnet` (8-testnet). They have not changed since v0.16.2. They use `pubky.workspace = true`, so on `main` they build against the workspace SDK (0.18.0 plus unreleased changes), not a published crate.

- Run them from `examples/rust` with `cargo run --bin <name> -- --testnet`.
- Most need a running local testnet with PostgreSQL. `logging` and `testnet` start their own `EphemeralTestnet` (default feature `docker-postgres`).
- Testnet setup and an in-process roundtrip: [`testing-and-testnet.md`](./testing-and-testnet.md#rust-in-process-tests-ephemeraltestnet).
