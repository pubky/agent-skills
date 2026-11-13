# Run the HTTP relay

`http-relay` is a store-and-forward HTTP mailbox. A producer `POST`s one payload to an inbox ID. A consumer long-polls `GET` and acknowledges with `DELETE`. Pubky uses it to carry the [`pubkyauth` handshake](../../pubky/references/auth.md#relays). This file covers running the relay (binary, Docker, embedded), deploying it behind a proxy, the `/inbox` API, the TTL, persistence and CORS flags, and the rule that **inbox IDs are bearer secrets**.

> **This is not the pkarr relay.** For DHT publish and resolve from browsers, see [`dns-and-relays.md`](./dns-and-relays.md). For where relays fit in the protocol, see [`concepts.md`](../../pubky/references/concepts.md). For how the SDK picks the inbox or link channel and encrypts payloads, see [`auth.md#relays`](../../pubky/references/auth.md#relays).

## Version and upstream

- **Latest: 0.8.0** (crates.io and GitHub release, 2026-11-12). `rust-version = "1.89"`, edition 2021. 0.7.0 (2026-03-10) declared no MSRV.
- **0.8.0 breaking changes** ([CHANGELOG](https://github.com/pubky/http-relay/blob/f35c7f9/CHANGELOG.md#L9-L87)):
  - The crate exports only `HttpRelay` and `HttpRelayBuilder`. Storage and waiting-list types are private.
  - The MSRV is 1.89.
  - **A full store returns `503` instead of evicting the oldest entry.**
  - New: per-client limits, `--trusted-proxy`, `secure_delete`, and sandbox headers on relayed messages.
- **Downstream Pubky crates still pin 0.7.** `pubky-homeserver` has `http-relay = { version = "0.7", default-features = false }` and `pubky-core` has `http-relay = "0.7"`. The testnet relay therefore has **0.7 behaviour**: no per-client limits, and FIFO eviction when full. Don't expect 0.8 semantics from the testnet until those crates bump.
- The README (`http-relay = "0.8"`) and `openapi.yaml` (`0.8.0`) match 0.8.0.

Sources (link, don't copy): [repo + README](https://github.com/pubky/http-relay) · [DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md) · [CHANGELOG](https://github.com/pubky/http-relay/blob/f35c7f9/CHANGELOG.md) · [docs.rs](https://docs.rs/http-relay) · [crates.io](https://crates.io/crates/http-relay) · [releases](https://github.com/pubky/http-relay/releases) · [`openapi.yaml`](https://github.com/pubky/http-relay/blob/f35c7f9/openapi.yaml)

## Run the binary

Install with `cargo install http-relay` (Rust 1.89 or newer), or download a prebuilt v0.8.0 binary from [Releases](https://github.com/pubky/http-relay/releases): linux arm64, x64 and x64-musl; macOS arm64 and x64; Windows arm64 and x64.

```bash
# Default: bind to 127.0.0.1:8080 (localhost only)
http-relay

# Bind to all interfaces (for Docker, behind a reverse proxy)
http-relay --bind 0.0.0.0

# Custom configuration
http-relay --bind 0.0.0.0 --port 15412 --inbox-cache-ttl 300 --inbox-timeout 25 -vv
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/f35c7f9/README.md#L61-L70), verbatim. Executed locally against http-relay 0.8.0: every line starts and serves `GET /`. **15412 is the relay port of the Pubky testnet and pubky-docker**, so the last line fails with `Address already in use` while a testnet is running; pick another port. `-vv` logs inbox IDs (see [Security](#security-inbox-ids-are-bearer-secrets)), so don't use it in production.</sub>

Flags are defined in [`src/main.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/main.rs#L14-L90) and listed in the [README table](https://github.com/pubky/http-relay/blob/f35c7f9/README.md#L74-L89). Defaults come from the `HttpRelayBuilder::DEFAULT_*` constants.

| Flag | Default | Notes |
| :-- | :-- | :-- |
| `-b, --bind <IP>` | `127.0.0.1` | Keep the relay port unreachable from the internet (see [Deploy](#deploy-behind-a-reverse-proxy)). |
| `-p, --port <u16>` | `8080` | `0` picks a random port. |
| `--inbox-timeout <SECS>` | `25` | Long-poll limit for `GET` and `/await`. |
| `--inbox-cache-ttl <SECS>` | `300` | Message lifetime, **counted from the `POST`**. An ACK doesn't extend it. |
| `--max-body-size <BYTES>` | `2048` | A larger body gets `413`. |
| `--max-entries <N>` | `10000` | Caps both stored entries and IDs with waiting requests. See [Limits](#limits). |
| `--max-entries-per-client <N>` | `100` | Unacknowledged messages per client. Must be at least 1. |
| `--max-waiting-per-client <N>` | `100` | Open waiting requests per client. Must be at least 1. |
| `--trusted-proxy <CIDR>` | none | Repeatable. A bare IP means `/32` or `/128`. See [Client IPs](#client-ips---trusted-proxy). |
| `--persist-db <PATH>` | none | SQLite file. Exists only with the `persist` feature. |
| `--cors-allow-all` | off | See [CORS](#cors). |
| `--link-timeout <SECS>` | `600` | Legacy `/link` only. |
| `-v` (repeatable) / `-q` | warn | `-v` info, `-vv` debug, `-vvv` trace; `-q` off. `RUST_LOG` overrides both. |

- **Stop it with SIGINT, not SIGTERM.** The binary waits on `ctrl_c()` and has no SIGTERM handler. As PID 1 in a `scratch` container it ignores SIGTERM, so `docker stop` sends SIGKILL after 10s. Use `docker run --stop-signal SIGINT`, `KillSignal=SIGINT` in systemd, or your supervisor's equivalent.
- **Shutdown grace period is 1 second** ([`server.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/server.rs#L416-L433)). `shutdown()` stops accepting connections, waits up to 1s for open requests, then returns the server task's error. Long-polls (25s default) are cut off, so clients must reconnect.
- **Health check:** `GET /` returns `200` with body `Http Relay`. With `--trusted-proxy 127.0.0.1`, a direct check from the relay host without `X-Forwarded-For` gets `400`. Check through the proxy, or send the header:

```bash
curl -H "X-Forwarded-For: 127.0.0.1" http://127.0.0.1:8080/
# Http Relay
```

<sub>Source: [DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L236-L241), verbatim. Executed locally against 0.8.0 with `--trusted-proxy 127.0.0.1`: `200 Http Relay` with the header, `400 Invalid X-Forwarded-For header` without it.</sub>

## Deploy behind a reverse proxy

**Exposing the relay directly to the internet is not supported** ([DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L6-L35)). The relay has no authentication, no request-rate limits, no request-read timeout and no connection limit. Put an HTTP-parsing proxy in front: Nginx, HAProxy in HTTP mode, or Caddy. TCP-only proxies (nginx `stream`, HAProxy TCP mode) don't qualify. The proxy must provide:

- **TLS.** Inbox IDs are in every path; without TLS anyone on the path can read IDs and take over inboxes.
- **Slow-client timeouts and full request buffering:** `client_header_timeout` and `client_body_timeout` (10s), and `proxy_request_buffering on` (the Nginx default). Without them, slow clients can exhaust file descriptors.
- **Per-IP connection and rate limits:** `limit_conn_zone`/`limit_conn` and `limit_req_zone`/`limit_req`.
- **A read timeout longer than the longest long-poll:** over 25s for `/inbox`, over 10 minutes if you serve `/link`. Upstream uses `proxy_read_timeout 11m`.
- **`X-Forwarded-For` set by the proxy:** `proxy_set_header X-Forwarded-For $remote_addr;` (replace) or `$proxy_add_x_forwarded_for` (append). **Never pass the client's header through unchanged.**

Start the relay so it trusts only an Nginx on the same host:

```bash
http-relay --bind 127.0.0.1 --port 8080 --trusted-proxy 127.0.0.1
```

<sub>Source: [DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L127-L131), verbatim; executed locally against 0.8.0. Copy the full Nginx `server` block from [DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L125-L192) rather than writing your own. Its notes: `http2 on;` needs Nginx 1.25.1+ (older: `listen 443 ssl http2;`); `limit_conn` keyed on `$binary_remote_addr` doesn't constrain an IPv6 host rotating addresses within its /64.</sub>

**Behind a CDN** (e.g. Cloudflare) in front of Nginx, add `set_real_ip_from <range>` for each published CDN range, plus `real_ip_header X-Forwarded-For;` and `real_ip_recursive on;` (`ngx_http_realip_module`). The relay config doesn't change ([DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L194-L211)).

### Client IPs (`--trusted-proxy`)

Per-client limits key on the client address, so the relay must know the real client IP ([DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L37-L71)).

- **Without `--trusted-proxy`**, the client is the TCP peer and `X-Forwarded-For` is ignored. Behind a proxy, every user shares the proxy's address and one per-client bucket (100 messages, 100 waiters), so users soon get `429` (inferred from the code). **Always pair a proxy deployment with `--trusted-proxy`.**
- **With it**, for requests from a trusted proxy, the client is the rightmost `X-Forwarded-For` entry that isn't itself a trusted proxy. All header instances are read right to left. If every entry is trusted, the leftmost is the client. IPv4-mapped IPv6 addresses become IPv4.
- **A missing header, or an entry the relay reads before it finds the client that isn't a plain IP (`ip:port` included), gets `400 "Invalid X-Forwarded-For header"`**, logged as `Rejected request from trusted proxy`. Entries left of the client are never parsed. The relay never falls back to the proxy's address.
- **Trust only your proxies' own addresses,** never a network clients connect from, or those clients can claim any address. Trusting `127.0.0.1` trusts every process on the host.

## Run in Docker

No image is published. Build one from the repo's [`Dockerfile`](https://github.com/pubky/http-relay/blob/f35c7f9/Dockerfile): `rust:1.89-alpine` builder, `cargo build --release --all-features`, `scratch` runtime, `ENTRYPOINT ["/http-relay"]`, `EXPOSE 8080`. 0.7.0's Dockerfile didn't build; 0.8.0's does. Arguments after the image name become relay flags.

```bash
docker build -t http-relay .
docker run --stop-signal SIGINT -p 127.0.0.1:8080:8080 \
  http-relay --bind 0.0.0.0 --trusted-proxy 172.17.0.1
```

<sub>Authored for this file from the [DEPLOY.md container guidance](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L186-L192). The image build was not run; Docker's parser accepted the `run` flags and the 0.8.0 relay accepted the container arguments. Inside the container the default bind `127.0.0.1` is unreachable, hence `--bind 0.0.0.0`. **Publish the port on loopback only.** `172.17.0.1` is the usual default bridge gateway, the address a host Nginx connects from. Confirm yours with `docker network inspect bridge` and trust that address instead of `127.0.0.1`.</sub>

> **On rootless Docker and Docker Desktop**, connections to a port published on all interfaces can arrive from the bridge gateway, so outside clients would count as a trusted proxy and could claim any address. Keep `-p 127.0.0.1:…`.

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

<sub>Adapted from the [README](https://github.com/pubky/http-relay/blob/f35c7f9/README.md#L91-L108). Needs `tokio` (full) and `anyhow`. Changes from the README: port 8080 instead of 15412 (testnet clash), and `local_url()` instead of the deprecated `local_link_url()`. Clippy-clean (`-D warnings`) and executed against 0.8.0. Full API on [docs.rs](https://docs.rs/http-relay).</sub>

- **The library's default port is `0` (random), not 8080.** Set `.http_port(..)`, or read `relay.http_address()` / `relay.local_url()` after `run()`.
- Setters: `bind_address`, `http_port`, `link_timeout`, `inbox_timeout`, `inbox_cache_ttl`, `max_body_size`, `max_entries`, `max_entries_per_client`, `max_waiting_per_client`, `persist_db` (`persist` feature only), `cors_allow_all`, and `trusted_proxies(impl IntoIterator<Item = ipnet::IpNet>)`. Other defaults match the CLI.
- **`http-relay` doesn't re-export `ipnet`.** To call `trusted_proxies`, add `ipnet = "2"` to your own `Cargo.toml` so you can build `IpNet` values.
- **A per-client limit of `0` fails at `run()`** with "max_… must be at least 1".
- **`persist_db` without the `persist` feature is a compile error** (0.7 silently ignored it).
- **Dropping `HttpRelay` stops the server immediately**, with no grace period. Keep the value alive and call `shutdown().await` to get the 1-second grace period.

Cargo features; the default is `["cli", "persist", "link-compat"]`:

| Feature | Provides |
| :-- | :-- |
| `persist` | SQLite storage (bundled rusqlite) and `--persist-db`. Without it, entries live in an in-memory `HashMap`. |
| `link-compat` | The deprecated `/link/{id}` routes and `local_link_url()`. |
| `cli` | The `http-relay` binary (clap, tracing-subscriber). |
| `server` | **No effect in 0.8.** The server is always built; the feature exists only so dependents that enable it still build. |

To embed, use `default-features = false`; add `"persist"` for on-disk storage, and `"link-compat"` only if you need `/link`. `pubky-testnet` and `pubky-sdk` use `["server", "link-compat"]` (in-memory, 0.7). For testnet usage, see [`testing-and-testnet.md`](../../pubky/references/testing-and-testnet.md).

## Inbox API

Routes: `GET|POST|DELETE /inbox/{id}`, `GET /inbox/{id}/ack`, `GET /inbox/{id}/await`. Each ID holds **one message**; a new `POST` overwrites it. Use `/inbox` for all new work. Spec: [`openapi.yaml`](https://github.com/pubky/http-relay/blob/f35c7f9/openapi.yaml).

```bash
curl -X POST http://localhost:8080/inbox/my-channel \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'

curl http://localhost:8080/inbox/my-channel

curl -X DELETE http://localhost:8080/inbox/my-channel

curl http://localhost:8080/inbox/my-channel/ack

curl http://localhost:8080/inbox/my-channel/await
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/f35c7f9/README.md#L140-L218), verbatim. Executed locally in order against a default 0.8.0 relay: `200`; `200` with the JSON body and `application/json`; `200`; `200 true`; `200` at once (already ACKed). In real use, generate a random ID, never `my-channel` (see [Security](#security-inbox-ids-are-bearer-secrets)).</sub>

Status codes in 0.8.0, from the [handlers](https://github.com/pubky/http-relay/blob/f35c7f9/src/endpoint.rs#L161-L200). Error bodies are short `text/plain`. † marks codes the README omits.

| Request | Result |
| :-- | :-- |
| `POST /inbox/{id}` | `200` stored · `413`† body too large · `429` client's unACKed limit (`Retry-After`) · `503` "Server at capacity" |
| `GET /inbox/{id}` | `200` with the original `Content-Type` · `408` "Request timed out" · `429` client's waiting limit (only when nothing is stored; `Retry-After: 1`) · `503` "Too many concurrent requests" |
| `DELETE /inbox/{id}` (ACK) | `200` · `404` "Not found" (never posted, or expired) |
| `GET /inbox/{id}/ack` | `200` with body `true` or `false` · `404` if never posted, expired, or the ACKed entry was deleted to make room |
| `GET /inbox/{id}/await` | `200` (at once if already ACKed) · `404` if there's no entry, or it expired or was replaced while waiting · `408` · `429` · `503` |
| any route | `400` "ID too long" (over 256 bytes) · `500` "Storage error" · `400` "Invalid X-Forwarded-For header" (only with `--trusted-proxy`) |

**In 0.8.0 an expired entry doesn't return `404 "Entry expired"`.** Expired entries are never returned, so a `GET` on one waits and ends in `408`. (0.7, which the Pubky testnet runs, still returns `404 Entry expired`.)

Relayed messages carry `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`, so a `text/html` message can't run scripts on the relay origin. This doesn't affect `fetch()` or non-browser clients. A stored `Content-Type` that isn't a valid header value is dropped.

## Delivery semantics

- **At-least-once.** `GET` does **not** ACK; a consumer can `GET` repeatedly until it `DELETE`s. The producer learns of delivery **only** through the ACK: `/await` blocks until then, `/ack` doesn't.
- **A `POST` replaces the message, resets the ACK flag and the TTL, and makes the poster the entry's owner.** It delivers to pending `GET` waiters and drops pending `/await` waiters of the replaced message, which get `404`. **If you rely on `/await`, don't reuse an ID for a second message.**
- **An ACK clears the body but keeps the row**: `message_body` is nulled and `acked` set. The row stays until the TTL ends or it is deleted to make room. After the ACK, `GET` long-polls to `408`; there is no redelivery.
- The TTL is counted from the `POST`. A cleanup task runs every 15s.
- A rejected or failed `POST` changes nothing.

**Client loops.** The README's [producer and consumer JS loops](https://github.com/pubky/http-relay/blob/f35c7f9/README.md#L287-L388) retry every non-200 response forever, because each `throw` is caught by its own `try`/`catch`, which sleeps 1s and retries. On `429` they retry every second instead of honoring `Retry-After`, which can be up to the TTL (300s). The consumer also ignores the `DELETE` status. If you adapt them:

- Retry on network errors and `408`.
- On `429`, wait for `Retry-After`. On `503`, back off.
- Treat `400`, `404` and `413` as terminal.
- Check that `DELETE` returned `200`.

## Security: inbox IDs are bearer secrets

> **This rule is load-bearing.** Upstream: "Anyone who knows an ID can read/write/ACK that inbox." The relay has no authentication and no request-rate limits ([`server.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/server.rs#L3-L10)).
>
> - **Generate IDs from a CSPRNG with at least 128 bits of entropy** ([module docs](https://github.com/pubky/http-relay/blob/f35c7f9/src/inbox.rs#L3-L12): IDs **must** be random). Encode as base64url without padding, or hex. **Don't use standard base64:** its `/` splits the path and hits the wrong route. Anyone who can predict an ID can intercept the message or forge an ACK.
> - **The relay doesn't encrypt.** A body stays in plaintext until it is ACKed or expires, and with `--persist-db` deleted bodies can remain on disk after that (see [Persistence](#persistence)). Encrypt at the application layer. The Pubky SDK encrypts auth payloads; see [`auth.md#relays`](../../pubky/references/auth.md#relays).
> - **Serve the relay only over TLS.** The ID is in every path.
> - **IDs and client IPs reach logs.** The debug-level request span logs `method`, `uri` (contains the ID) and `client_ip`. In production, stay at `-v` or lower, leave `RUST_LOG` unset, and turn off path logging in the proxy.
> - `/link/{id}` and `/inbox/{id}` share one ID namespace; the same rules apply to both.

## Limits

From [DEPLOY.md](https://github.com/pubky/http-relay/blob/f35c7f9/DEPLOY.md#L73-L119) and [`storage/mod.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/storage/mod.rs#L1-L22). The Pubky testnet (0.7) has none of the per-client limits.

- **A client is an IPv4 address or an IPv6 /56.** Behind a proxy this depends on [`--trusted-proxy`](#client-ips---trusted-proxy).
- **`--max-entries-per-client` (100)** counts a client's unACKed stored messages. A `POST` beyond it gets `429 "Too many unacknowledged messages from this client"`, with `Retry-After` = seconds until that client's first message expires (rounded up, at least 1). A client can always replace one of its own unACKed messages.
- **`--max-waiting-per-client` (100)** counts open waiting requests: inbox `GET`, `/await`, and both `/link` methods. Beyond it: `429 "Too many waiting requests from this client"` with `Retry-After: 1`. A `GET` for an already-stored message doesn't wait, so it doesn't count. The two limits are counted separately.
- **A waiting request counts until it ends** with a response, a timeout or a disconnect. If a client's network drops without closing the connection, its waiting request still counts toward `--max-waiting-per-client` until the relay notices, at the latest when the request times out.
- **The store is full at `--max-entries` (10000).** A `POST` to a **new** ID first deletes expired entries, then the ACKed entries stored longest ago. **UnACKed entries are never deleted.** If that frees no room, the `POST` gets `503 "Server at capacity"` and nothing changes. A `POST` to an existing ID needs no room.
- **`--max-entries` also caps the IDs that have waiting requests.** A long-poll or `/link` request for a new ID beyond the cap gets `503 "Too many concurrent requests"`.
- **Each ID allows at most 10 waiters of each kind** (message waiters and ACK waiters counted separately). Disconnected waiters are pruned before counting.
- **Sizing:** on `429`, raise the limit the response body names. A server long-polling many IDs from one address may need a higher `--max-waiting-per-client`. A per-client limit at or above `--max-entries` protects nothing.
- **Known gaps:** clients with many addresses can still fill the store together; one IPv6 /48 holds 256 /56s and can fill it with the default limits. The relay limits neither request rate nor connections, so set both at the proxy.

## Persistence

- With the `persist` feature (on by default in the binary), storage is SQLite. `--persist-db <PATH>` opens a file in WAL mode, which also creates `<PATH>-wal` and `<PATH>-shm`. Without the flag the database is in memory and lost on restart. Pending waiters are always in memory only, so clients must reconnect after a restart.
- **`secure_delete` is on, best-effort.** Freed bodies are overwritten with zeros, but older page versions stay in `-wal` until overwritten, and filesystem blocks, SSD wear leveling and backups may keep copies. Restrict permissions on `<PATH>*`, use an encrypted volume, and rely on app-layer encryption ([`sqlite.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/storage/sqlite.rs#L1-L75)).
- The page cache is 64 MB (`cache_size=-65536`).
- **Upgrading a pre-0.8 database** adds an `owner` column holding a keyed hash of the client's network, so no IPs are written to disk. The key is random and memory-only, so after a restart pre-restart messages count against no client's limit until they expire. 0.7.0 can still open the file, so rollback works ([CHANGELOG](https://github.com/pubky/http-relay/blob/f35c7f9/CHANGELOG.md#L55-L59)).

## CORS

- **CORS is off by default** (since 0.7.0). A browser or WASM client calling the relay directly needs `--cors-allow-all`, or CORS set at the reverse proxy.
- **`--cors-allow-all` does not send `Access-Control-Allow-Origin: *`**, despite the help text and README. It uses tower-http's `CorsLayer::very_permissive()`, which **mirrors the request `Origin`** and **allows credentials** ([`server.rs`](https://github.com/pubky/http-relay/blob/f35c7f9/src/server.rs#L295-L299)). **Don't host the relay on an origin or parent domain that carries credentialed cookies.**

## Legacy `/link` (deprecated)

The `link-compat` feature (on by default) serves `GET|POST /link/{id}`. `POST` blocks until a consumer `GET`s; both sides are bounded by `--link-timeout` (600s, also the message TTL). Responses carry an RFC 9745 `Deprecation: @1772668800` header. Both methods count toward `--max-waiting-per-client`, and `POST` also toward `--max-entries-per-client`. **Don't use `/link` for new integrations:** it has no ACK, and its 10-minute polls need a proxy read timeout over 10 minutes. It shares the ID namespace with `/inbox`.

## How Pubky uses it

- The SDK exports `DEFAULT_HTTP_RELAY_INBOX`; the older `DEFAULT_HTTP_RELAY` (`/link`) is deprecated. **To use a self-hosted relay, pass its `/inbox/` base URL as the auth flow's `relay` option.** Code: [`auth.md#relays`](../../pubky/references/auth.md#relays).
- The static testnet relay binds `0.0.0.0:15412` with `.cors_allow_all(true)` ([source](https://github.com/pubky/pubky-homeserver/blob/8612a64/pubky-testnet/src/static_testnet.rs#L339-L349)). It is still 0.7.
- **pubky-docker:** `docker-compose.yml` defaults `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY` to `http://localhost:15412/inbox/`, but `.env-sample` (and its commented staging line) still sets `…/link/`. **Copying `.env-sample` selects the deprecated link channel; change it to `/inbox/`.**
- **Production checklist:**
  - Run behind an HTTP-parsing proxy with TLS, slow-client timeouts, connection and rate limits, and a read timeout over 25s.
  - Bind to `127.0.0.1` or a private network, and set `--trusted-proxy` to the proxy's address only.
  - Stop the relay with SIGINT.
  - Log at `-v` or lower, and keep paths out of proxy logs.
  - If browser apps call the relay, set CORS with the flag or at the proxy.
  - Use `--persist-db` only if messages must survive a restart, and protect the file.
