# Run the HTTP relay

`http-relay` is a store-and-forward HTTP mailbox. A producer `POST`s one payload to a channel ID. A consumer long-polls `GET` and acknowledges with `DELETE`. Pubky uses it to carry the [`pubkyauth` handshake](../../pubky/references/auth.md#relays), and the relay sees only ciphertext. This file covers running it (binary, Docker, embedded), the `/inbox` API, the TTL/persistence/CORS flags, and the rule that **inbox IDs are bearer secrets**.

> **Not the pkarr relay.** For DHT publish/resolve for browsers, see [`dns-and-relays.md`](./dns-and-relays.md). For where relays fit in the protocol, see [`concepts.md`](../../pubky/references/concepts.md). For handshake encryption and channel derivation, see [`auth.md`](../../pubky/references/auth.md). Link to those files; don't restate them.

## Version and upstream

- Published crate: **0.7.0** (crates.io, 2026-03-10, MIT). It declares no `rust-version`. Unreleased HEAD (after `e38cba9`) declares `1.85`. `pubky-homeserver` depends on `http-relay = "0.7"`.
- **Breaking change in 0.7.0: CORS is opt-in** (`--cors-allow-all`). `/inbox` already shipped in **0.6.0**.
- Stale upstream docs: the README says `http-relay = "0.6"`, and `openapi.yaml` has `info.version: 0.6.0`. Use 0.7. For flags, trust `http-relay --help` over the README table.

Sources (link to them, don't copy): [repo + README](https://github.com/pubky/http-relay) · [docs.rs](https://docs.rs/http-relay) · [crates.io](https://crates.io/crates/http-relay) · [releases](https://github.com/pubky/http-relay/releases) · [`openapi.yaml`](https://github.com/pubky/http-relay/blob/main/openapi.yaml) (version field stale) · [demo](https://pubky.github.io/http-relay/) · [HTTP Relay spec](https://httprelay.io/) (legacy `/link` only)

## Run the binary

Install from crates.io, or download a prebuilt binary from [Releases](https://github.com/pubky/http-relay/releases): linux x64/x64-musl/arm64, macOS x64/arm64, Windows x64/arm64.

```bash
cargo install http-relay

# Default: bind to 127.0.0.1:8080 (localhost only)
http-relay

# Bind to all interfaces (for production/Docker)
http-relay --bind 0.0.0.0

# Custom configuration
http-relay --bind 0.0.0.0 --port 15412 --inbox-cache-ttl 300 --inbox-timeout 25 -vv
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/99ffeca/README.md#L37-L61). Executed against a locally installed 0.7.0: every line parsed and started the server. The verification used ports other than 15412, because **15412 is the relay port of the Pubky testnet and pubky-docker**. On macOS, binding `127.0.0.1:15412` while a testnet listens on `*:15412` does not fail. It silently takes over localhost traffic. Pick another port when a testnet is running.</sub>

Flags (from [`src/main.rs`](https://github.com/pubky/http-relay/blob/99ffeca/src/main.rs#L14-L63) and `--help` on 0.7.0):

| Flag | Default | Notes |
| :-- | :-- | :-- |
| `-b, --bind <IP>` | `127.0.0.1` | **Localhost only.** Use `0.0.0.0` in containers and on hosts. |
| `-p, --port <u16>` | `8080` | `0` picks a random port. |
| `--inbox-timeout <SECS>` | `25` | Long-poll limit for `GET` and `/await`. Keep it under the proxy's read timeout. |
| `--inbox-cache-ttl <SECS>` | `300` | Message lifetime, **counted from the `POST`**. An ACK does not extend it. |
| `--max-body-size <BYTES>` | `2048` | A larger body gets `413`. |
| `--max-entries <N>` | `10000` | When full, the oldest entry is **evicted silently** (see [Limits](#limits-and-eviction)). |
| `--persist-db <PATH>` | none | SQLite file. Without it, messages are lost on restart. |
| `--cors-allow-all` | off | See [CORS](#cors). |
| `--link-timeout <SECS>` | `600` | Legacy `/link` only. Missing from the README table. |
| `-v` (repeatable) | warn | `-v` info, `-vv` debug, `-vvv` trace. |
| `-q, --quiet` | — | Logging off. |

`RUST_LOG` overrides both `-v` and `-q`.

- **Shutdown:** the binary exits **only on SIGINT**. It has no SIGTERM handler. In-flight requests are **not drained**: `shutdown()` consumes the relay, and its `Drop` forces an immediate stop. Under `docker stop` or a supervisor, send SIGINT (for example `docker run --stop-signal SIGINT …`). Otherwise PID 1 in `scratch` ignores SIGTERM and gets SIGKILLed after 10s. This comes from reading the code ([`server.rs`](https://github.com/pubky/http-relay/blob/99ffeca/src/http_relay/server.rs#L311-L323)); upstream doesn't document it.
- **Health check:** `GET /` returns `200` with body `Http Relay`.

## Run in Docker

No image is published. Build one from the repo's [`Dockerfile`](https://github.com/pubky/http-relay/blob/99ffeca/Dockerfile), which does a static musl build into `scratch` with `ENTRYPOINT ["/http-relay"]` and `EXPOSE 8080`. Arguments after the image name become relay flags.

> **The upstream `Dockerfile` fails to build at HEAD (`99ffeca`).** The builder is `rust:1.84-alpine`, and cargo 1.84.1 can't parse the `edition2024` manifest of the dev-dependency `axum-test` 18.7.0 (exit 101). **Change `FROM` to `rust:1.85-alpine` or newer.** On small Docker VMs (about 2 GB), also set `ENV CARGO_BUILD_JOBS=1`, or the build gets OOM-killed.

```bash
docker build -t http-relay .
# default bind 127.0.0.1 is unreachable from outside the container
docker run -p 8080:8080 http-relay --bind 0.0.0.0
```

<sub>Executed with the 1.85-alpine fix: `GET /` returned `200` and `POST`/`GET /inbox` worked. Without `--bind 0.0.0.0`, curl got an empty reply.</sub>

For a full local stack (relay on **15412**), see [`local-stack.md`](./local-stack.md).

## Embed as a Rust library

```rust
use http_relay::HttpRelayBuilder;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let relay = HttpRelayBuilder::default()
        .http_port(8080)
        .run()
        .await?;

    println!("Running at {}", relay.local_url());

    tokio::signal::ctrl_c().await?;
    relay.shutdown().await
}
```

<sub>Adapted from the [README](https://github.com/pubky/http-relay/blob/99ffeca/README.md#L78-L95). It compiles clippy-clean against 0.7.0 with `tokio` (full) and `anyhow`, and was run end to end. Changes from the README: the port is 8080 instead of 15412 (see the testnet port warning above), and it calls `local_url()` instead of `local_link_url()`. `local_link_url()` returns the deprecated `/link` URL and doesn't exist without `link-compat`. Full API on [docs.rs](https://docs.rs/http-relay).</sub>

Gotchas:

- **The library's default port is `0` (random), not 8080.** Set `.http_port(..)`, or read `relay.http_address()` / `relay.local_url()` after `run()`.
- Builder defaults match the CLI: bind `127.0.0.1`, inbox timeout 25s, TTL 5 min, body 2 KB, 10 000 entries, no persistence, CORS off. The setters are `bind_address`, `http_port`, `link_timeout`, `inbox_timeout`, `inbox_cache_ttl`, `max_body_size`, `max_entries`, `persist_db(Option<PathBuf>)` and `cors_allow_all(bool)`.
- **Dropping `HttpRelay` stops the server immediately.** Keep the value alive for as long as the relay should run.
- **`shutdown().await` is not graceful.** It stops accepting connections and ends open ones at once. The public API has no way to drain in-flight long-polls.

Cargo features. The default is `["cli", "persist", "link-compat"]`:

| Feature | Provides |
| :-- | :-- |
| `server` | `HttpRelay` / `HttpRelayBuilder` (axum). Not a direct default: `cli` pulls it in, although the `lib.rs` docs say "(default)". |
| `persist` | SQLite storage (bundled rusqlite). Without it, storage is an in-memory `HashMap`. |
| `link-compat` | Deprecated `/link/{id}` routes and `local_link_url()`. |
| `cli` | The `http-relay` binary (clap, tracing-subscriber, `server`). |

To embed only, use `default-features = false, features = ["server"]`. `pubky-testnet` uses `["server", "link-compat"]` in memory, with `.cors_allow_all(true)` on port 15412 ([source](https://github.com/pubky/pubky-homeserver/blob/28f4bf3/pubky-testnet/src/static_testnet.rs#L339-L349)). For testnet usage (`.with_http_relay()`, `testnet.http_relay()`), see [`testing-and-testnet.md`](../../pubky/references/testing-and-testnet.md).

## Inbox API

`{id}` is the channel name shared by producer and consumer. A channel holds **one message**, and a new `POST` overwrites it. Use `/inbox` for all new work.

```bash
curl -X POST http://localhost:8080/inbox/my-channel \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'

curl http://localhost:8080/inbox/my-channel

curl -X DELETE http://localhost:8080/inbox/my-channel

curl http://localhost:8080/inbox/my-channel/ack

curl http://localhost:8080/inbox/my-channel/await
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/99ffeca/README.md#L119-L180). Executed in order against a local 0.7.0 relay: every call returned `200`, `GET` kept `Content-Type: application/json`, `/ack` returned `true`, and `/await` returned at once. In real use, generate a random ID, never `my-channel` (see [Security](#security-inbox-ids-are-bearer-secrets)).</sub>

Status codes come from the [handlers](https://github.com/pubky/http-relay/blob/99ffeca/src/http_relay/inbox_handler.rs#L26-L167) and were checked against 0.7.0. † marks codes that the README and `openapi.yaml` omit.

| Request | Result |
| :-- | :-- |
| `POST /inbox/{id}` | `200`: stored. Overwrites any existing message and resets `acked`, `created_at` and the TTL. `500` if persistence fails. **Never `503`**, despite the README: at `--max-entries` it evicts silently and still returns `200`. |
| `GET /inbox/{id}` | `200` with the stored `Content-Type` · `408` after `--inbox-timeout` · `404` "Entry expired"†, only when the 15s cleanup drops a waiter on a row that still exists but has expired (for example an acked row reaching its TTL) · `503` "Too many concurrent requests"† (more than 10 waiters on this ID) |
| `DELETE /inbox/{id}` (ACK) | `200`, including a repeated DELETE before expiry · `404` "Not found" if there is no entry, it expired, or the SQLite ack update failed |
| `GET /inbox/{id}/ack` | `200` with body `true`/`false` · `404` if there is no entry or it expired, **even if it was acked** |
| `GET /inbox/{id}/await` | `200` when acked (at once if already acked) · `408` timeout · `404`† if there is no entry yet (await before POST), **the message was overwritten while waiting, or it expired while waiting** · `503`† if more than 10 waiters |
| any inbox route | `400`† "… too long" if the ID is over 256 bytes · `413`† if the body is over `--max-body-size` |

## Delivery semantics

- **At-least-once.** `GET` does **not** ACK, so a consumer can `GET` repeatedly until it `DELETE`s. The producer learns of delivery **only** through the ACK: `/await` blocks, `/ack` doesn't.
- **The consumer may subscribe first.** A `GET` before the `POST` long-polls. Re-issue the request after a `408`; no other poll loop is needed.
- **An ACK clears the body but keeps the row until the TTL ends.** Until then, `/ack` returns `true`, `/await` returns `200`, and `GET` long-polls to `408` with no redelivery.
- **After the TTL** (5 min from the `POST`): `DELETE`, `/ack` and `/await` return `404`. `GET` acts as if nothing was ever posted: it long-polls, then returns `408` (or `404` "Entry expired" in the cleanup race above). `POST` returns `200` and starts a fresh message. A cleanup task deletes expired rows every 15s.
- **If you rely on `/await`, don't reuse an ID for a second message.** The new `POST` sends pending `/await` waiters a `404`.
- **Only `Content-Type` passes through.** No other request headers are forwarded.
- **Why ACKs exist:** TCP can take 30s or more to notice a vanished mobile consumer. The 25s default timeout stays under typical nginx and Cloudflare limits.

**Client loops.** The README's [producer and consumer JS patterns](https://github.com/pubky/http-relay/blob/99ffeca/README.md#L239-L328) are buggy. Each `throw` is caught by its own `try`/`catch`, so **every non-200 response is retried forever** at 1s intervals, including a `413` on `POST` and a `404` on `/await`. The consumer also ignores the `DELETE` status. If you adapt those loops:

- Retry only on network errors and `408`.
- Treat a `4xx` as terminal. On `404`, the message expired, was overwritten or was evicted.
- Check that the `DELETE` returned `200`.

## Security: inbox IDs are bearer secrets

> **This rule is load-bearing.** Anyone who knows an inbox ID can **read, overwrite, or ACK** it. Reading the router shows **no authentication, no rate limiting and no per-client isolation** (inferred from the code, not stated upstream).
>
> - Generate IDs from a CSPRNG. **Prefer base64url of 32 random bytes.** A v4 UUID (122 random bits) is the minimum. A predictable ID lets an attacker intercept a message or forge an ACK.
> - Bodies are stored **in plaintext** for the whole TTL. Encrypt at the application layer. The Pubky SDK already does: it derives the channel ID from a hash of a shared secret and encrypts with that secret, so the relay sees only ciphertext and the ID doesn't reveal the key. See [`auth.md`](../../pubky/references/auth.md) for the details.
> - **The ID is in the URL path, so it ends up in logs.** The relay's `TraceLayer` logs URIs at debug level, which `-vv` or `RUST_LOG=debug` enables regardless of `-v`. Reverse proxies log paths by default. In production, use `-v` or lower, leave `RUST_LOG` unset, and scrub or disable path logging in nginx, caddy or similar. This is inferred from the code.

## Persistence

- With the default `persist` feature, storage is always SQLite. `--persist-db <PATH>` opens a file in WAL mode, which creates `<PATH>`, `<PATH>-wal` and `<PATH>-shm`. Without the flag, the database is in memory and lost on restart.
- Pending `GET` and `/await` connections are **not** persisted. Clients must reconnect after a restart.
- **Plaintext on disk.** Bodies go as-is into the database and the WAL. An ACK sets the body to `NULL` and expiry deletes the row. The code never enables `secure_delete`, so freed pages and WAL frames may still hold old bodies (inferred). Restrict permissions on `<PATH>`, use an encrypted volume, and rely on app-layer encryption.

## CORS

- **Off by default since 0.7.0.** The relay sends no `access-control-*` headers. That suits a reverse proxy that sets CORS itself. The public `httprelay.pubky.app` does this: its nginx adds the CORS headers.
- A browser or WASM client that calls the relay **directly** needs `--cors-allow-all` or proxy-set CORS. By inference from the 0.7.0 default, the upstream Next.js demo (`:3000` calling `:8080`) needs `cargo run -- --cors-allow-all`. Nobody has tested this in a browser.
- **`--cors-allow-all` does not send `Access-Control-Allow-Origin: *`,** despite the help text and README. It uses `CorsLayer::very_permissive()`, which **echoes the request `Origin`**, sends **`Access-Control-Allow-Credentials: true`**, and echoes the requested methods and headers in preflights. The relay sets no cookies, but **don't serve it from an origin or parent domain that carries credentialed cookies**.

## Limits and eviction

- IDs can be at most **256 bytes**. Bodies default to **2048 bytes**.
- **At most 10 waiters per ID.** The limit is hardcoded, and the 11th gets `503`.
- **`--max-entries` eviction is silent and FIFO-like, not LRU.** It removes the row with the oldest `created_at`. A new `POST` resets `created_at`; reads don't.
  - Acked rows count toward the cap until they expire, and so do expired rows the 15s cleanup hasn't removed yet.
  - At the cap, re-`POST`ing an existing ID still evicts the oldest row.
  - Waiters on an evicted ID get no notice: they time out with `408`, and a retry gets `404` or waits again.
- Anyone who can reach the relay can flood unique IDs and **evict other users' pending messages**. Size `--max-entries` for your traffic, and rate-limit at the proxy.

## Legacy `/link` (deprecated)

`link-compat` (on by default) serves `GET|POST /link/{id}` per [httprelay.io](https://httprelay.io/). `POST` blocks until a consumer `GET`s, and that `GET` counts as the ACK. Both sides are bounded by `--link-timeout` (600s), and responses carry `Deprecation: true`. **Don't use it:**

- A consumer that drops right after receiving still gives the producer a `200`, a false delivery.
- 600s exceeds typical proxy timeouts.

`503 "Server at capacity"` exists only on `/link`. IDs are bearer secrets there too.

## How Pubky uses it

- The SDK default is `DEFAULT_HTTP_RELAY_INBOX = "https://httprelay.pubky.app/inbox"`. `DEFAULT_HTTP_RELAY` (`…/link`) is `#[deprecated]`. The public relay is live behind nginx.
- To use a self-hosted relay, pass its **`/inbox/` base URL** (for example `https://httprelay.example.com/inbox/`) as the auth flow's `relay` option. A CI-verified example is in the [knowledge-base snippet](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30c/snippets/js/src/getting-started.ts#L50-L62); for the relay model, see [`auth.md#relays`](../../pubky/references/auth.md#relays). pubky-docker defaults to `http://localhost:15412/inbox/`.
- **Deployment checklist:**
  - Run with `--bind 0.0.0.0` behind TLS, and run it with `--stop-signal SIGINT` or an equivalent.
  - Keep `--inbox-timeout` under the proxy's read timeout.
  - If browser apps call the relay, set CORS with the flag or at the proxy.
  - Use `--persist-db` only if messages must survive restarts, and protect that file.
  - Rate-limit at the proxy.
  - Keep paths out of logs.

## Known drift elsewhere (don't copy)

- The knowledge base's self-hosting link points to a nonexistent `pubky-http-relay` crate. The real crate is `http-relay` ([github.com/pubky/http-relay](https://github.com/pubky/http-relay)).
- The knowledge base and [`auth.md`](../../pubky/references/auth.md#relays) say inbox messages are deleted on retrieval. They aren't: `GET` removes nothing, `DELETE` (the ACK) clears the body, and the row stays until the TTL ends.
- `auth.md` says `/inbox` replaced `/link` in 0.7.0. `/inbox` shipped in 0.6.0, and the breaking change in 0.7.0 was opt-in CORS.
- The upstream README's embed example calls `local_link_url()`, its JS loops retry forever, and it says `POST` can return `503`. See the sections above.
