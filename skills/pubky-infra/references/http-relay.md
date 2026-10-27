# Run the HTTP relay

`http-relay` is a store-and-forward HTTP mailbox. A producer `POST`s one payload to an inbox ID. A consumer long-polls `GET` and acknowledges with `DELETE`. Pubky uses it to carry the [`pubkyauth` handshake](../../pubky/references/auth.md#relays). This file covers running it (binary, Docker, embedded), the `/inbox` API, the TTL/persistence/CORS flags, and the rule that **inbox IDs are bearer secrets**.

> **Not the pkarr relay.** For DHT publish/resolve from browsers, see [`dns-and-relays.md`](./dns-and-relays.md). For where relays fit in the protocol, see [`concepts.md`](../../pubky/references/concepts.md). For how the SDK picks the inbox or link channel and encrypts payloads, see [`auth.md#relays`](../../pubky/references/auth.md#relays).

## Version and upstream

- Published crate: **0.7.0** (crates.io, 2026-03-10, MIT). crates.io lists no `rust-version`. Unreleased HEAD (`9ce3b83`) declares `rust-version = "1.85"` (edition 2021) and CI runs an MSRV 1.85 job. `pubky-homeserver` depends on `http-relay = "0.7"`.
- **Breaking change in 0.7.0: CORS is opt-in** (`--cors-allow-all`).
- Upstream docs are stale: the README pins `http-relay = "0.6"` and `openapi.yaml` says `version: 0.6.0`. Use 0.7. For flags, trust `http-relay --help` over the README table.

Sources (link, don't copy): [repo + README](https://github.com/pubky/http-relay) · [docs.rs](https://docs.rs/http-relay) · [crates.io](https://crates.io/crates/http-relay) · [releases](https://github.com/pubky/http-relay/releases) · [`openapi.yaml`](https://github.com/pubky/http-relay/blob/9ce3b83/openapi.yaml) (version field stale)

## Run the binary

Install from crates.io, or download a prebuilt v0.7.0 binary from [Releases](https://github.com/pubky/http-relay/releases) (linux arm64/x64/x64-musl, macOS arm64/x64, Windows arm64/x64).

```bash
cargo install http-relay

# Default: bind to 127.0.0.1:8080 (localhost only)
http-relay

# Bind to all interfaces (for production/Docker)
http-relay --bind 0.0.0.0

# Custom configuration
http-relay --bind 0.0.0.0 --port 15412 --inbox-cache-ttl 300 --inbox-timeout 25 -vv
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/9ce3b83/README.md#L37-L61), verbatim. Verified: each line installed and started 0.7.0 and answered `GET /`. **15412 is the relay port of the Pubky testnet and pubky-docker**, so the last line fails while a testnet is running (the verification run used 18412). Pick another port then.</sub>

Flags, from [`src/main.rs`](https://github.com/pubky/http-relay/blob/9ce3b83/src/main.rs#L14-L129):

| Flag | Default | Notes |
| :-- | :-- | :-- |
| `-b, --bind <IP>` | `127.0.0.1` | **Localhost only.** Use `0.0.0.0` in containers and on hosts. |
| `-p, --port <u16>` | `8080` | `0` picks a random port. |
| `--inbox-timeout <SECS>` | `25` | Long-poll limit for `GET` and `/await`. Keep it under the proxy's read timeout. |
| `--inbox-cache-ttl <SECS>` | `300` | Message lifetime, **counted from the `POST`**. An ACK does not extend it. |
| `--max-body-size <BYTES>` | `2048` | A larger `POST` body gets `413`. |
| `--max-entries <N>` | `10000` | When full, the oldest entry is **evicted silently** (see [Limits](#limits-and-eviction)). |
| `--persist-db <PATH>` | none | SQLite file. Without it, storage is in memory and lost on restart. |
| `--cors-allow-all` | off | See [CORS](#cors). |
| `--link-timeout <SECS>` | `600` | Legacy `/link` only. Missing from the README table. |
| `-v` (repeatable) | warn | `-v` info, `-vv` debug, `-vvv` trace. |
| `-q, --quiet` | — | Logging off; overrides `-v`. |

`RUST_LOG` overrides the `-v`/`-q` default (`EnvFilter::from_env_lossy`).

- **Shutdown: graceful only on SIGINT** (`ctrl_c`). There is no SIGTERM handler, so a plain `kill` or systemd stop kills the process at once. As PID 1 in the `scratch` container, SIGTERM is ignored, and `docker stop` SIGKILLs it after 10s. Use `docker run --stop-signal SIGINT …`, `KillSignal=SIGINT` in systemd, or your supervisor's equivalent. Even on SIGINT, in-flight long-polls are **not drained**: `shutdown()` consumes the relay and its `Drop` stops the server immediately ([`server.rs`](https://github.com/pubky/http-relay/blob/9ce3b83/src/http_relay/server.rs#L311-L323)). Inferred from code; upstream doesn't document it.
- **Health check:** `GET /` returns `200` with body `Http Relay`.

## Run in Docker

No image is published (not on Docker Hub, not in releases). Build one from the repo's [`Dockerfile`](https://github.com/pubky/http-relay/blob/9ce3b83/Dockerfile): a static musl build (`cargo build --release --all-features`) into `scratch`, with `ENTRYPOINT ["/http-relay"]` and `EXPOSE 8080`. Arguments after the image name become relay flags.

> **The upstream `Dockerfile` fails to build at HEAD (`9ce3b83`).** The builder is `rust:1.84-alpine`, but the crate declares `rust-version = "1.85"`, and cargo 1.84 can't parse the `edition2024` manifest of the dev-dependency `axum-test` 18.7.0 (exit 101). **Change `FROM` to `rust:1.85-alpine` or newer** before building. On a small (~2 GB) build VM, also set `ENV CARGO_BUILD_JOBS=1` to avoid running out of memory.

```bash
docker build -t http-relay .
# default bind 127.0.0.1 is unreachable from outside the container
docker run -p 8080:8080 http-relay --bind 0.0.0.0
```

<sub>Verified with the `FROM` fix: the image built, and with `--bind 0.0.0.0` the `GET /` and inbox `POST`/`GET` calls returned `200`. Without `--bind`, curl got an empty reply. Add `--stop-signal SIGINT` for a clean stop (see Shutdown above).</sub>

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

<sub>Adapted from the [README](https://github.com/pubky/http-relay/blob/9ce3b83/README.md#L78-L95). Needs `tokio` (full) and `anyhow`. Verified: clippy-clean (`-D warnings`) against `http-relay = "=0.7.0"` with default features, and it ran and shut down on SIGINT. Changes from the README: port 8080 instead of 15412 (testnet clash), and `local_url()` instead of `local_link_url()`, which returns the deprecated `/link` URL and exists only with `link-compat`. Full API on [docs.rs](https://docs.rs/http-relay).</sub>

Gotchas:

- **The library's default port is `0` (random), not 8080.** Set `.http_port(..)`, or read `relay.http_address()` (`SocketAddr`) / `relay.local_url()` (`http://localhost:{port}`) after `run()`.
- Setters: `bind_address`, `http_port`, `link_timeout`, `inbox_timeout`, `inbox_cache_ttl`, `max_body_size`, `max_entries`, `persist_db(Option<PathBuf>)`, `cors_allow_all(bool)`. Other defaults match the CLI.
- **Without the `persist` feature, `persist_db` is silently ignored.** It still compiles, but the in-memory backend (`storage_memory.rs`) discards the path and uses a `HashMap`. Enable `persist` if you need storage on disk.
- **Dropping `HttpRelay` stops the server.** Keep the value alive for as long as the relay should run.
- **`shutdown().await` is not a drain.** Don't count on in-flight long-polls completing.

Cargo features. The default is `["cli", "persist", "link-compat"]`:

| Feature | Provides |
| :-- | :-- |
| `server` | `HttpRelay` / `HttpRelayBuilder` (axum, axum-server, tower-http). Not a direct default: `cli` pulls it in, although the `lib.rs` docs say "(default)". |
| `persist` | SQLite storage (bundled rusqlite). Without it, storage is in memory only. |
| `link-compat` | Deprecated `/link/{id}` routes and `local_link_url()`. |
| `cli` | The `http-relay` binary (clap, tracing-subscriber, `server`). |

To embed only, use `default-features = false, features = ["server"]`, and add `"persist"` if messages must survive a restart. `pubky-testnet` and `pubky-sdk` deliberately use `["server", "link-compat"]` (in-memory, no `persist`). The static testnet binds `0.0.0.0` on port 15412 with `.cors_allow_all(true)` ([source](https://github.com/pubky/pubky-homeserver/blob/fd24bf0/pubky-testnet/src/static_testnet.rs#L339-L349)). For testnet usage, see [`testing-and-testnet.md`](../../pubky/references/testing-and-testnet.md).

## Inbox API

Routes: `GET|POST|DELETE /inbox/{id}`, `GET /inbox/{id}/ack`, `GET /inbox/{id}/await`. An ID holds **one message**, and a new `POST` overwrites it. Use `/inbox` for all new work.

```bash
curl -X POST http://localhost:8080/inbox/my-channel \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'

curl http://localhost:8080/inbox/my-channel

curl -X DELETE http://localhost:8080/inbox/my-channel

curl http://localhost:8080/inbox/my-channel/ack

curl http://localhost:8080/inbox/my-channel/await
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/9ce3b83/README.md#L119-L180), verbatim. Verified in order against a local 0.7.0 relay on 8080: every call returned `200`, `GET` kept `content-type: application/json`, `/ack` returned `true`, and `/await` returned at once. In real use, generate a random ID, never `my-channel` (see [Security](#security-inbox-ids-are-bearer-secrets)).</sub>

Status codes, from the [handlers](https://github.com/pubky/http-relay/blob/9ce3b83/src/http_relay/inbox_handler.rs#L26-L167). † marks codes the README omits.

| Request | Result |
| :-- | :-- |
| `POST /inbox/{id}` | `200` stored (overwrites; resets `acked`, `created_at` and the TTL) · `413`† body over `--max-body-size` · `500` "Failed to store message". **Never `503`**, despite the README: at `--max-entries` it evicts silently and still returns `200`. |
| `GET /inbox/{id}` | `200` with the stored `Content-Type` · `408` after `--inbox-timeout` · `404` "Entry expired"† (the TTL passed before cleanup removed the row, or the waiter was dropped) · `503` "Too many concurrent requests"† (more than 10 waiters on this ID) |
| `DELETE /inbox/{id}` (ACK) | `200` · `404` "Not found" |
| `GET /inbox/{id}/ack` | `200` with body `true`/`false` · `404` if no entry |
| `GET /inbox/{id}/await` | `200` when acked (at once if already acked) · `408` timeout · `404`† if no entry yet, or **the message was overwritten or expired while waiting** · `503`† more than 10 waiters |
| any inbox route | `400`† "Inbox ID too long" if the ID is over 256 bytes |

## Delivery semantics

- **At-least-once.** `GET` does **not** ACK, so a consumer can `GET` repeatedly until it `DELETE`s. The producer learns of delivery **only** through the ACK: `/await` blocks, `/ack` doesn't.
- **An ACK clears the body but keeps the row until the TTL ends.** `DELETE` runs `SET acked = 1, message_body = NULL`. After it, `/ack` returns `true` and `GET` long-polls to `408`, with no redelivery.
- **After the TTL** (default 5 min from the `POST`), `GET` returns `404 "Entry expired"` or `408`, depending on cleanup timing. Treat both as gone. A cleanup task runs every 15s and drops waiters on expired rows (hence the `404`). Since `--inbox-timeout` (25s) is longer than that interval, `404` is the usual result just after expiry, and `408` once the row is deleted.
- **If you rely on `/await`, don't reuse an ID for a second message.** The new `POST` drops pending `/await` waiters, which get `404`.
- **`Content-Type` is preserved** on `GET`.

**Client loops.** The README's [producer and consumer JS patterns](https://github.com/pubky/http-relay/blob/9ce3b83/README.md#L237-L328) are buggy. Each `throw` is caught by its own `try`/`catch`, so **every non-200 response is retried forever** at 1s intervals, including a `413` on `POST` and a `404` on `/await`. The consumer also ignores the `DELETE` status. If you adapt those loops:

- Retry only on network errors and `408`.
- Treat a `4xx` as terminal. On `404`, the message expired, was overwritten or was evicted.
- Check that the `DELETE` returned `200`.

## Security: inbox IDs are bearer secrets

> **This rule is load-bearing.** Upstream: "Anyone who knows an ID can read/write/ACK that inbox." The router has **no authentication and no rate limiting** (inferred from the code).
>
> - Generate IDs from a CSPRNG with at least 128 bits of entropy; the code comments say IDs **must** be random. Encode them as **base64url without padding** (32 bytes → 43 chars, as the SDK does for its channel) or hex (64 chars). **Don't use standard base64:** its `/` splits the URL path, so `/inbox/{id}` returns `404` or hits the `/ack` or `/await` route. A predictable ID lets an attacker intercept a message or forge an ACK.
> - **The relay provides no encryption.** A body sits in plaintext until it is ACKed or the TTL ends, whichever comes first, and unacknowledged messages stay for the full TTL. Freed SQLite pages and the WAL may keep residue (see [Persistence](#persistence)). Encrypt at the application layer. The Pubky SDK encrypts auth payloads; see [`auth.md#relays`](../../pubky/references/auth.md#relays).
> - **The ID is in the URL path, so it ends up in logs.** `TraceLayer` logs request URIs at debug level (`-vv`, or `RUST_LOG=debug`, which overrides `-v`). Reverse proxies log paths by default. In production, stay at `-v` or lower, leave `RUST_LOG` unset, and scrub path logging in the proxy.
> - `/link/{id}` and `/inbox/{id}` share one ID namespace, so a `/link` message can also be read and ACKed at `/inbox/{id}`. The same rules apply to both route families.

## Persistence

- With the `persist` feature (on by default in the binary), storage is always SQLite. `--persist-db <PATH>` opens a file with `journal_mode=WAL`, which also creates `<PATH>-wal` and `<PATH>-shm`. Without the flag, it uses an in-memory database that is lost on restart.
- Pending `GET` and `/await` waiters are in memory only. Clients must reconnect after a restart.
- **Plaintext on disk.** Bodies go as-is into the database and WAL. An ACK nulls the body in the live row, but `secure_delete` is not set, so freed pages and WAL frames may still hold old bodies (inferred). Restrict permissions on `<PATH>*`, use an encrypted volume, and rely on app-layer encryption.

## CORS

- **Off by default since 0.7.0** ([`37926a7`](https://github.com/pubky/http-relay/commit/37926a7)). The relay sends no CORS headers. A browser or WASM client that calls the relay directly needs `--cors-allow-all` or CORS set at the reverse proxy.
- **`--cors-allow-all` does not send `Access-Control-Allow-Origin: *`,** despite the help text and README. It uses tower-http `CorsLayer::very_permissive()`, which **mirrors the request `Origin`** and sends **`Access-Control-Allow-Credentials: true`** ([`server.rs`](https://github.com/pubky/http-relay/blob/9ce3b83/src/http_relay/server.rs#L210-L214)). **Don't host it on an origin or parent domain that carries credentialed cookies.**

## Limits and eviction

- IDs can be at most **256 bytes**. `POST` bodies default to at most **2048 bytes**.
- **At most 10 waiters per ID** (hardcoded). The 11th gets `503`.
- **`--max-entries` eviction is silent and FIFO by last `POST`, not LRU** (the code comments say LRU). It deletes the row with the oldest `created_at`; reads don't update it. Waiters on an evicted ID get no notice.
- Anyone who can reach the relay can flood unique IDs and **evict other users' pending messages**. Size `--max-entries` for your traffic, and rate-limit at the proxy.

## Legacy `/link` (deprecated)

`link-compat` (on by default) serves `GET|POST /link/{id}`. `POST` blocks until a consumer `GET`s; both sides are bounded by `--link-timeout` (600s). **Don't use it for new integrations:** it has no ACK, a consumer that disconnects still gives the producer a `200`, and 10 minutes exceeds typical proxy timeouts. It shares the ID namespace with `/inbox`, and its IDs are bearer secrets too.

## How Pubky uses it

- The SDK default is `DEFAULT_HTTP_RELAY_INBOX = "https://httprelay.pubky.app/inbox"` ([source](https://github.com/pubky/pubky-homeserver/blob/fd24bf0/pubky-sdk/src/actors/auth/relay/http_relay_inbox_channel.rs#L13)). `DEFAULT_HTTP_RELAY` (`…/link`) is `#[deprecated]` in favor of `HttpRelayInboxChannel`. The public relay is live behind nginx.
- **To use a self-hosted relay, pass its `/inbox/` base URL as the auth flow's `relay` option.** The code, and how the SDK picks the channel from the path, are in [`auth.md#relays`](../../pubky/references/auth.md#relays). Verified end to end: a grant flow approved through the testnet relay's `http://localhost:15412/inbox/` base with `@synonymdev/pubky` 0.12.0.
- **pubky-docker:** `docker-compose.yml` defaults `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY` to `http://localhost:15412/inbox/` ([source](https://github.com/pubky/pubky-docker/blob/bb01419/docker-compose.yml#L167)), but `.env-sample` still sets `http://localhost:15412/link/` (its commented staging line uses `…/link/` too). **Copying `.env-sample` selects the deprecated link channel; change it to `/inbox/`.**
- **Deployment checklist:**
  - Run with `--bind 0.0.0.0` behind TLS, and stop it with SIGINT (`--stop-signal SIGINT`, `KillSignal=SIGINT`).
  - Keep `--inbox-timeout` under the proxy's read timeout.
  - If browser apps call the relay, set CORS with the flag or at the proxy.
  - Use `--persist-db` only if messages must survive restarts, and protect that file.
  - Rate-limit at the proxy and keep paths out of logs.

## Known upstream README drift (don't copy)

- The embed example calls `local_link_url()` (deprecated `/link`, `link-compat` only). Use `local_url()`.
- The JS producer/consumer loops retry every non-200 forever. See [Delivery semantics](#delivery-semantics).
- It says `POST` can return `503`; it can't. It omits `400`, `404`, `413` and other `503` cases.
- It pins `http-relay = "0.6"`, and `openapi.yaml` says `0.6.0`. Use 0.7.
- Its Dockerfile builder (`rust:1.84-alpine`) can't build HEAD. See [Run in Docker](#run-in-docker).
