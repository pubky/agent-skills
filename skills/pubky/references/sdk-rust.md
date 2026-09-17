# Rust client (`pubky` crate)

The `pubky` crate is the official Rust SDK for signing in and reading or writing `pubky://` data. This page covers install, client setup, storage calls and error handling. Other pages own the protocol knowledge:

- **[`concepts.md`](./concepts.md):** identity, `pubky://` addressing, PKARR, the homeserver model, [public-key string formats](./concepts.md#public-key-string-formats) and [path rules](./concepts.md#path-rules).
- **[`auth.md`](./auth.md):** `pubkyauth` flows, capabilities, signup tokens, session persistence and grant management.
- **[`testing-and-testnet.md`](./testing-and-testnet.md):** `EphemeralTestnet` and local development.
- **[`shipped-vs-planned.md`](./shipped-vs-planned.md):** which features are production-ready.

**Upstream (authoritative):**
- **API reference:** [docs.rs/pubky](https://docs.rs/pubky) (pinned: [0.12.0](https://docs.rs/pubky/0.12.0/pubky/)). If this page and docs.rs for your installed version disagree on a signature, trust docs.rs.
- **Crate docs:** [SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) and the [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md), which covers the breaking changes from 0.9.x.
- **Crate source:** [`pubky-sdk/`](https://github.com/pubky/pubky-homeserver/tree/main/pubky-sdk) in `pubky-homeserver`.
- **CI-verified snippets:** [`pubky-knowledge-base-v2/snippets/rust`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs).

> **Version:** the latest release is **0.12.0** (2026-09-14). Earlier releases were 0.11.0 (2026-08-19), 0.10.0 (2026-08-05) and 0.9.3 (2026-06-24). The crate is pre-1.0, so expect breaking changes.
> - The examples in `pubky-homeserver/examples/rust` match 0.12.0.
> - **The SDK README on `main` may already document unreleased API.** It changed after the 0.12.0 tag. Trust docs.rs for your version.
> - The KB snippets pin `=0.10.0`. The sign-in and storage signatures on this page are the same in 0.10.0, 0.11.0 and 0.12.0. **`read_timeout` needs 0.12.0.**
> - Every snippet below was compiled against 0.12.0 with clippy, and the storage, auth, error and event snippets also ran against a local testnet.
>
> **0.10 broke the 0.9.x API.** From 0.10 on:
> - `signin` takes a `ClientId`.
> - `signup` returns `()`, not a session.
> - Cookie auth is deprecated.
> - Session persistence uses grant secrets.
>
> Discard 0.9.x-era code that calls `signin()` with no argument or uses `start_auth_flow`, `export_secret` or `import_secret`.

## Install and runtime

```bash
cargo add pubky --features json
cargo add tokio --features macros,rt-multi-thread
cargo add anyhow serde_json
cargo add serde --features derive
cargo add futures-util   # only for event streams (StreamExt)
```

- **Async only.** The crate needs a Tokio runtime. The examples use `#[tokio::main]`.
- **Features.** `default = []`. The `json` feature adds `put_json`/`get_json` on session storage and `get_json` on public storage. Without it, use `put`/`get` with bytes or text.
- **Targets.** Native builds use Tokio and `reqwest` with rustls. The crate also builds for `wasm32`, and the JS bindings wrap that build.
- **`pubky::prelude` omits** `ClientId`, `PubkySession`, `SessionStorage` and `PublicStorage`. Import them explicitly, for example `use pubky::ClientId;`.
- **Logging.** On native targets the SDK logs through `tracing`; wasm uses `log`. Install a `tracing-subscriber` before calling the SDK. See `examples/rust/7-logging`.

## Quick start

```rust
use pubky::{ClientId, Keypair, Pubky};

let pubky = Pubky::new()?;
let keypair = Keypair::random();

// Sign in (user already has an account on a homeserver)
let signer = pubky.signer(keypair);
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

<sub>Source (CI type-checked): [`pubky-knowledge-base-v2/snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs). The body goes inside an `async fn` that returns `anyhow::Result<()>`. `Keypair::random()` creates a new identity with no account, so `signin` fails for it (it cannot find a homeserver). Real code must load an existing key; see [`auth.md`](./auth.md).</sub>

| Type | Role |
|---|---|
| `Pubky` | Entry point. Holds the HTTP transport and creates the other handles |
| `PubkySigner` | Holds a key locally: `signup`, `signin`, approving QR auth, publishing PKDNS |
| `PubkySession` | Authenticated handle for acting as the user; `session.storage()` |
| `PublicStorage` | Unauthenticated reads of any user's public data |
| `GrantManager` | Lists and revokes grants (needs a root session) |
| `Pkdns` | Resolves and publishes `_pubky` records |
| `PubkyHttpClient` | Raw HTTP to `pubky` and `_pubky` hosts |

## Client setup

- `Pubky::new() -> Result<Self>`: mainnet, with **no HTTP timeouts**.
- `Pubky::testnet() -> Result<Self>`: a local testnet.
- `Pubky::with_client(PubkyHttpClient) -> Self`: wraps a client you configured.
- **Create one `Pubky` and reuse it.** It is `Clone`, so clone it, pass it down or store it in a `OnceCell`. Don't create one per request, because each one rebuilds the transport.

```rust
let pubky = if cli.testnet {
    Pubky::testnet()?
} else {
    Pubky::new()?
};
```

<sub>Source (runnable): [`examples/rust/3-storage/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/3-storage/main.rs)</sub>

To set timeouts in production, build the client yourself:

```rust
use std::time::Duration;
use pubky::{Pubky, PubkyHttpClient};

let client = PubkyHttpClient::builder()
    .request_timeout(Duration::from_secs(30))
    .read_timeout(Duration::from_secs(10))
    .build()?;
let pubky = Pubky::with_client(client);
```

<sub>Source: [`Pubky::with_client` doc example](https://docs.rs/pubky/0.12.0/pubky/struct.Pubky.html#method.with_client). `read_timeout` needs 0.12.0; 0.11.0 has only `request_timeout`. Timeout and pool settings apply only to native targets, and wasm ignores them.</sub>

## Sign up and sign in

- `signer.signup(homeserver: &PublicKey, signup_token: Option<&str>) -> Result<()>` creates the account.
  - Call it once. It returns **no session**.
  - It force-publishes the user's `_pubky` record.
  - Tokens: [`auth.md`](./auth.md#signup-tokens).
- `signer.signin(ClientId) -> Result<PubkySession>`:
  1. Resolves the user's homeserver through PKDNS. It fails if the user has none.
  2. Signs a root-capability grant locally with a new proof-of-possession key and exchanges it for a session.
  3. If the PKDNS record is stale, republishes it in the background.
- `signin_blocking(ClientId)` waits about 3–5 s for that republish.
  - Use it when the identity must be discoverable at once, such as first-time setup.
  - Use `signin` in interactive apps.
- `ClientId::new(&str)` only checks that the string is non-empty and at most 253 bytes. By convention it is your app's domain. The homeserver records it as the app that holds the grant.

```rust
let signer = pubky.signer(keypair);
signer
    .signup(&homeserver, cli.signup_code.as_deref())
    .await?;
// signup returns (); get a session separately:
let session = signer.signin(ClientId::new("storage.example")?).await?;
```

<sub>Adapted from [`examples/rust/1-signup/signup.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/1-signup/signup.rs) and [`3-storage/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/3-storage/main.rs). `homeserver` is a `PublicKey` parsed from a z32 string, and the function returns `anyhow::Result`.</sub>

> **Gotcha: `?` does not convert these errors into `pubky::Error`.** `pubky::Error` has no `From` impl for `ClientId::new` errors or `PublicKey::try_from` parse errors. In a function that returns `pubky::Result`, both give E0277 (confirmed by compiling against 0.12.0).
> - For static values, call `.expect(..)`, as the SDK README does.
> - Otherwise return `anyhow::Result`, which accepts `?`, as the examples do.

**Other auth APIs:**
- **Third-party and keyless sign-in** (`start_grant_auth_flow`, `Capabilities`): see [`auth.md`](./auth.md#third-party-app-grant-auth-flow).
  - Since 0.10, a trailing `/` on a capability scope matters: `/pub/app/:rw` covers the folder's contents, while `/pub/app:rw` covers only `/pub/app` itself.
- **Recovery files** (native only):
  - `pubky.signer_from_recovery_file(path, passphrase)` returns a signer. The lower-level function is `pubky::recovery_file::decrypt_recovery_file(&bytes, &passphrase)`.
  - The examples try an empty passphrase first because the bundled testnet `sample_recovery.key` uses one.
  - Don't copy that fallback, and don't create production recovery files with an empty passphrase.

## Session storage (your own data)

`session.storage()` returns a `SessionStorage`. It is cheap to clone and uses the session's auto-refreshing credential.

| Method | Returns | Notes |
|---|---|---|
| `get(path)` | `Result<reqwest::Response>` | Every non-2xx is `Err`, **including 404** |
| `get_json::<T>(path)` | `Result<T>` | `json` feature |
| `put(path, body: impl Into<reqwest::Body>)` | `Result<Response>` | `Vec<u8>`, `String`, `bytes::Bytes`, or a literal (`&'static str` / `&'static [u8]`). A borrowed `&str` fails (E0597), so pass `.to_owned()` |
| `put_json(path, &body)` | `Result<Response>` | `json` feature |
| `delete(path)` | `Result<Response>` | |
| `exists(path)` | `Result<bool>` | Sends `HEAD`; 404 and 410 return `false`. Use it instead of catching a 404 from `get` |
| `stats(path)` | `Result<Option<ResourceStats>>` | `content_length`, `content_type`, `last_modified`, `etag` (each an `Option`) |
| `list(path)` | `Result<ListBuilder>` | **Not async.** Call `.send().await` on the builder |

```rust
let storage = session.storage();

storage
    .put(&cli.path, cli.content.as_bytes().to_vec())
    .await?;

let response = storage.get(&cli.path).await?;
let body = response.bytes().await?;
println!("  Content: {}", String::from_utf8_lossy(&body));

storage.delete(&cli.path).await?;
```

<sub>Source (runnable; `println!` lines trimmed): [`examples/rust/3-storage/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/3-storage/main.rs). For text, `.put(path, "hi")` with `.get(path).await?.text().await?` also works; see [`8-testnet`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/8-testnet/main.rs).</sub>

**How the SDK handles paths** (the protocol rules are in [`concepts.md`](./concepts.md#path-rules)):
- **Paths are absolute.** The SDK adds a missing leading `/`, so `"pub/app/f"` and `"/pub/app/f"` are the same path.
- **Invalid paths** (empty, containing `//`, or with `.`/`..` segments) return an `Error::Request` validation error.
- **The SDK percent-encodes segments.** `"pub/My File.txt"` becomes `/pub/My%20File.txt`.
- **`list()` needs a trailing `/`.** Without one, it fails at once with ``directory listings must end with `/` ``.
- **A path can't be both a file and a folder.** Writing one where the other exists returns **409 Conflict**.
- **Keep app data under a domain-like folder**, such as `/pub/my-new-app/`. The `/pub` layout is **not stabilized**.

> **`/priv` is ALPHA (v0.10.0+) and NOT for production.** It is access-controlled but **not encrypted**, so a homeserver admin can read and write all tenant data, including `/priv`. Upstream's `docs/PRIVATE_STORAGE.md` has only a JavaScript storage example. The Rust `EventStreamBuilder` docs show a `/priv/` event subscription. See [`shipped-vs-planned.md`](./shipped-vs-planned.md).

**Listing:**
- `ListBuilder` is `#[must_use]`, and nothing is sent until `.send()`.
- Options:
  - `.reverse(bool)`: reverse **lexicographic path order**, not time order (see [`concepts.md`](./concepts.md#the-homeserver-model)).
  - `.shallow(bool)`: skip subfolder contents.
  - `.limit(u16)`: page size (the homeserver may cap it).
- To paginate, pass the previous page's last `entry.to_pubky_url()` to `.cursor(&str)`.
- `.send().await` returns `Vec<PubkyResource>`. Each entry has `owner`, `path` and `.to_pubky_url()`.

```rust
let entries = session
    .storage()
    .list("/pub/my-cool-app/")?
    .limit(100)
    .shallow(true)
    .send()
    .await?;
for entry in entries {
    println!("{}", entry.to_pubky_url());
}
```

<sub>Source: [`SessionStorage::list` doc example](https://docs.rs/pubky/0.12.0/pubky/struct.SessionStorage.html#method.list)</sub>

## Public storage (other users' data)

`pubky.public_storage()` returns a read-only `PublicStorage` with `get`, `get_json` (`json` feature), `exists`, `stats` and `list`. Use it rather than `PublicStorage::new()`, which builds a separate client instead of reusing your `Pubky`'s.

Accepted address forms:
- `"pubky://<z32>/pub/..."`
- `"pubky<z32>/pub/..."`
- a `(PublicKey, path)` or `(&PublicKey, path)` tuple
- a `PubkyResource`

```rust
use pubky::{Pubky, PublicKey};

// inside: async fn run(user_id: PublicKey) -> pubky::Result<()>
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

// Tuple form avoids string formatting entirely:
let resp = public.get((&user_id, "/pub/example.com/file.bin")).await?;
```

<sub>Source: [SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) doctest. The tuple line comes from the [`PublicStorage::get` docs](https://docs.rs/pubky/0.12.0/pubky/struct.PublicStorage.html#method.get).</sub>

**Key formats:**
- `format!("{user}")` (`Display`) gives `pubky<z32>`. That is valid in the compact address form above.
- For `pubky://` URLs, `_pubky.<z32>` hostnames, headers, query parameters, JSON and database keys, use `user.z32()`. Example: `format!("pubky://{}/pub/...", user.z32())`.
- Never write `pubky://pubky<z32>`.
- `PublicKey::try_from` accepts both forms, but JSON serde uses raw z32 only.

Full rules: [`concepts.md`](./concepts.md#public-key-string-formats).

## Error handling

- `pubky::Result<T>` is `Result<T, pubky::Error>`.
- `pubky::Error` variants: `Request`, `Pkarr`, `Parse`, `Authentication`, `Build`.
  - The enum is not `#[non_exhaustive]`, but the crate is pre-1.0, so keep a catch-all `Err(e)` arm.
- `RequestError` variants:
  - `Server { status, message }`: any non-2xx response. In 0.12.0, `message` holds the whole response body.
  - `Transport(reqwest::Error)`: the request didn't complete.
  - `Validation { message }`: bad input, such as an invalid path.
  - `DecodeJson { message }`: a JSON body didn't parse.
- `PkarrError::is_retryable()` is `true` for `Publish` and `Resolve`. `pubky::Error` itself has no `is_retryable()`.
- `pubky::StatusCode` and `pubky::Method` are re-exported, so you don't need `reqwest` as a direct dependency.
- Variant details: [docs.rs `Error`](https://docs.rs/pubky/0.12.0/pubky/errors/enum.Error.html).

Match on the status code. This example treats a repeated signup as success:

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

<sub>Source (runnable helper): [`examples/rust/testnet.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/testnet.rs). Upstream uses `reqwest::StatusCode`; this version uses the `pubky::StatusCode` re-export. `Result` is `anyhow::Result`, and the imports are `use pubky::{PubkySigner, PublicKey};`.</sub>

`get_homeserver_of` (0.10+) returns `Result<Option<PublicKey>>`:
- `Ok(None)`: the user has no record.
- `Err(Error::Pkarr(_))`: resolution failed or the record is malformed. Retry when `is_retryable()` is true.
- `signin`, grant exchange and event-stream `subscribe` can return the same PKARR errors.

```rust
use pubky::Error;

match pubky.get_homeserver_of(&user).await {
    Ok(Some(homeserver)) => println!("Homeserver: {homeserver}"),
    Ok(None) => println!("User has no homeserver"),
    Err(Error::Pkarr(error)) if error.is_retryable() => {
        eprintln!("Temporary PKARR failure: {error}");
    }
    Err(error) => return Err(error),
}
```

<sub>Source: [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md). The code must be inside a function that returns `pubky::Result`.</sub>

## Sessions: sign out and persist

Refresh, revalidation, restore behavior and `GrantManager` are covered in [`auth.md`](./auth.md#session-lifecycle). This section shows the Rust calls.

- **Session methods:**
  - `session.info()` and `session.public_key()`.
  - `session.revalidate() -> Result<Option<SessionInfo>>`, where `None` means the session expired.
  - `session.storage()`.
  - `session.client()` returns the raw HTTP client **without** credentials.
- **Sign out:** `signout(self) -> Result<(), (Error, Self)>` consumes the session and gives it back if sign-out fails.

```rust
session.signout().await.map_err(|(e, _session)| e)?;
```

- **Persist:** store the grant secret, not the one-hour bearer token. `restore_session` creates a new bearer token.

```rust
let grant = session
    .as_grant()
    .expect("expected a grant-backed session");
let secret = grant
    .export_local_secret()
    .await
    .expect("expected a local PoP key");

let restored = pubky.restore_session(&secret).await?;
```

<sub>Source: [`docs/v0.10-migration/grant-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md)</sub>

> **The exported secret works like a bearer token.** Anyone who holds it can act as the user, within the granted capabilities, until the grant expires or is revoked. Store it like a password (for example, in the OS keychain), and never log or commit it.

> **Deprecated (cookie auth, to be removed). Don't use:**
> - `start_cookie_auth_flow`, `resume_cookie_auth_flow`
> - `signup_cookie`, `signin_cookie`, `signin_cookie_blocking`
> - `session_from_file`, `write_secret_file`, `from_secret_file`
> - `import_secret`, `CookieSessionView::export_secret`
>
> The SDK README's "Keypair and Session persistence" section still uses `write_secret_file` and `session_from_file`. Don't copy it.

## Events, PKDNS and raw HTTP

**Event streams:**
- **One user:** `pubky.event_stream_for_user(&user, cursor)`.
- **Several users on one homeserver:** `pubky.event_stream_for(&homeserver).add_users(..)?`. Get the homeserver first with `get_homeserver_of`, which returns an `Option`.
- **Builder options:**
  - `.limit(u16)`, `.live()` and `.reverse()`.
  - `.path(..)`: repeat it to filter on several paths.
  - `.session(&PubkySession)`.
- **Path filters:**
  - With no filter, only `/pub/` events are returned.
  - Private events need an explicit `/priv/...` path **and** that user's session.
  - Without a trailing `/`, a path matches one file. With a trailing `/`, it matches the folder and everything under it.

```rust
use pubky::{Pubky, PublicKey};
use futures_util::StreamExt;

// inside: async fn example() -> pubky::Result<()>
let pubky = Pubky::new()?;
let user = PublicKey::try_from("o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo").unwrap();

let mut stream = pubky.event_stream_for_user(&user, None)
    .live()
    .subscribe()
    .await?;

while let Some(result) = stream.next().await {
    let event = result?;
    println!("Event: {:?} at {}", event.event_type, event.resource);
}
```

<sub>Source: [`Pubky::event_stream_for_user` doc example](https://docs.rs/pubky/0.12.0/pubky/struct.Pubky.html#method.event_stream_for_user). With `.live()` the loop runs until the connection closes, so bound it with a timeout or a cancel signal if you need it to stop. `event_type` prints as `Put { content_hash }` or `Delete`. For several users, see [`examples/rust/5-events_stream`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/5-events_stream/main.rs).</sub>

**PKDNS:**
- Look up another user's homeserver with `pubky.get_homeserver_of(&pk)`.
- The signer's `pkdns()` handle has:
  - `publish_homeserver_if_stale(None)`.
  - `publish_homeserver_force(Some(&hs))`, for example when migrating.
  - `get_homeserver()`.
- What `_pubky` records are: [`concepts.md`](./concepts.md#pkarr-resolution).

**Raw HTTP** (only for requests the storage APIs don't cover, since they already handle addressing):
- **Recommended path:**
  1. `resolve_pubky(id)` converts an address to its canonical `https://_pubky.<z32>/storage/<z32>/...` URL.
  2. `client.request_async(Method, url)` sends it. It negotiates storage addressing, falls back to the legacy addressing that pre-0.10 homeservers use, and resolves ICANN fallback endpoints.
- **Low-level alternative:** `PubkyHttpClient::request(method, &url)` returns a `reqwest::RequestBuilder`.
  - It is native-only.
  - It does **not** negotiate storage addressing or resolve ICANN fallback endpoints. Upstream says to use `request_async` for Pubky and PKDNS URLs.
  - [`4-request`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/4-request/main.rs) uses it.

## Runnable examples

[`pubky-homeserver/examples/rust`](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust) contains these binaries: `keygen`, `1-signup` (`signup`), `2-auth_flow` (`authenticator`, `auth_client`), `3-storage` (`storage`), `4-request` (`request`), `5-events_stream` (`events_stream`), `6-session_management` (`sessions`), `7-logging` (`logging`) and `8-testnet` (`testnet`).

- **Run** from `examples/rust` with `cargo run --bin <name> -- --testnet`.
- **Testnet:**
  - Most examples need a local testnet running with Postgres.
  - `7-logging` and `8-testnet` start their own `EphemeralTestnet`.
  - Setup: [`testing-and-testnet.md`](./testing-and-testnet.md).
