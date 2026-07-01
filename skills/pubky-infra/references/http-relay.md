# Run the HTTP relay

`http-relay` is Pubky's HTTP relay for **reliable asynchronous message passing** between a
producer and a consumer: store-and-forward delivery of one payload over a named channel, with
**explicit acknowledgment**. Built for Pubky — it's the delivery channel for the
[`pubkyauth` handshake](../../pubky/references/auth.md) (the relay only ever sees ciphertext) —
but usable as a general-purpose relay. This file covers running it (binary / Docker / embedded),
the inbox API, the TTL/persistence/CORS knobs, and the load-bearing rule that **inbox IDs are
bearer secrets**.

> **Not the pkarr relay.** This is the *message-passing* relay. The **pkarr relay** (DHT
> publish/resolve, so browsers and WASM can use PKARR) is a separate service — see
> [`./dns-and-relays.md`](./dns-and-relays.md). For where relays sit in the protocol generally,
> see [`concepts.md`](../../pubky/references/concepts.md). Do not restate `pubkyauth` or
> pkarr-relay mechanics here — link to those files.

## Upstream

Authoritative, summarize-don't-mirror sources:

- Repo + README: <https://github.com/pubky/http-relay>
- Rust API: [docs.rs/http-relay](https://docs.rs/http-relay)
- Crate: [crates.io/crates/http-relay](https://crates.io/crates/http-relay)
- OpenAPI: in-repo `openapi.yaml`
- Interactive demo: <https://pubky.github.io/http-relay/>
- Underlying HTTP Relay spec: <https://httprelay.io/>

> **Version (read before pinning).** Current crate is **0.7.0** (published 2026-03-10; edition
> 2021, MIT; MSRV **1.85** declared in the repo `Cargo.toml` — the published crate carries no
> MSRV metadata, so this gate bites `docker build` but not `cargo install`). Known doc drift at
> HEAD: the README install line still says `http-relay = "0.6"` and `openapi.yaml` `info.version`
> is `0.6.0` — both are **stale**. Treat **0.7** as current; confirm the authoritative flag list
> with `http-relay --help` and the API shape against the running server, not the checked-in
> `openapi.yaml`.

## Run the relay (CLI)

```bash
cargo install http-relay

# Default: bind to 127.0.0.1:8080 (localhost only)
http-relay

# Bind to all interfaces (for production/Docker)
http-relay --bind 0.0.0.0

# Custom configuration
http-relay --bind 0.0.0.0 --port 15412 --inbox-cache-ttl 300 --inbox-timeout 25 -vv
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/e4f3d9e/README.md)</sub>

Flags and defaults (source of truth is the `clap` `Args` in
[`src/main.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/main.rs#L14-L63) — the
README options table omits `--link-timeout`):

| Flag | Default | Meaning |
| :-- | :-- | :-- |
| `--bind, -b <IP>` | `127.0.0.1` | Bind address. **Localhost-only by default** — set `0.0.0.0` for prod/Docker. |
| `--port, -p <u16>` | `8080` | Listen port; `0` picks a random free port. |
| `--inbox-timeout <SECS>` | `25` | Inbox long-poll / `await` timeout. |
| `--inbox-cache-ttl <SECS>` | `300` | Inbox message TTL before expiry. |
| `--max-body-size <BYTES>` | `2048` | Max request body (2 KB). |
| `--max-entries <N>` | `10000` | Max stored entries (LRU); oldest evicted when full. Not the per-inbox waiter cap. |
| `--persist-db <PATH>` | _(none)_ | SQLite path. Omit → in-memory (data lost on restart). |
| `--cors-allow-all` | off | Enable permissive CORS (`tower_http` `very_permissive`). |
| `--link-timeout <SECS>` | `600` | Legacy `/link` producer/consumer wait (deprecated path). |
| `-v / --verbose` | `0` | Repeatable: `0`=warn, `1`=info, `2`=debug, `3+`=trace. |
| `-q / --quiet` | — | Silence output (overrides `--verbose`). |

## Run in Docker

The repo ships a multi-stage
[`Dockerfile`](https://github.com/pubky/http-relay/blob/e4f3d9e/Dockerfile): a musl static build
(`cargo build --release --all-features`) copied into a `scratch` image exposing `8080`, with the
binary as `ENTRYPOINT` (pass relay flags as container args). Build and run:

```bash
docker build -t http-relay .

# Must pass --bind: the default 127.0.0.1 is unreachable from outside the container
docker run -p 8080:8080 http-relay --bind 0.0.0.0
```

> **Upstream `Dockerfile` does not build at `e4f3d9e`.** Its builder image is `rust:1.84-alpine`
> (rustc 1.84), below the crate's declared `rust-version = "1.85"`; cargo hard-errors when the
> toolchain is under a crate's MSRV, so the `cargo build` step — and thus `docker build` — fails.
> Bump the builder to `rust:1.85-alpine` (or newer).

<sub>Source: [`Dockerfile`](https://github.com/pubky/http-relay/blob/e4f3d9e/Dockerfile)</sub>

## Embed as a Rust library

The `server` feature (built by default) exposes `HttpRelay` / `HttpRelayBuilder` for running the
relay in-process — useful for integration tests and bundled services. Accessors:
`builder.http_port(u16)`; `.run() -> Result<HttpRelay>`; `relay.local_url()` (base URL),
`relay.local_link_url()` (legacy `/link` URL), `relay.http_address() -> SocketAddr`;
`relay.shutdown().await`.

```rust
use http_relay::HttpRelayBuilder;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let relay = HttpRelayBuilder::default()
        .http_port(15412)
        .run()
        .await?;

    println!("Running at {}", relay.local_link_url());

    tokio::signal::ctrl_c().await?;
    relay.shutdown().await
}
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/e4f3d9e/README.md); API on [docs.rs/http-relay](https://docs.rs/http-relay)</sub>

## The inbox API

`/inbox` is the recommended endpoint set. `{id}` is the channel identifier shared by producer and
consumer (**max 256 bytes**; oversized IDs are rejected). A channel holds **one** value at a time
— a new `POST` overwrites any existing value.

| Method + path | Behavior | Returns |
| :-- | :-- | :-- |
| `POST /inbox/{id}` | Store message (overwrites existing); returns immediately. | `200` stored · `500` on persistence write failure (no capacity/`503` path — that exists only on legacy `/link`) |
| `GET /inbox/{id}` | Retrieve — **long-polls** up to `--inbox-timeout` (25s). | `200` + original `Content-Type` · `408` no message in time · `404` "Entry expired"† · `503` "Too many concurrent requests"† |
| `DELETE /inbox/{id}` | **ACK** — clears the message and wakes `await` waiters. | `200` acked · `404` "Not found" (nothing to ack) |
| `GET /inbox/{id}/ack` | Was it ACKed? | `200` body `"true"`/`"false"` · `404` if no message exists |
| `GET /inbox/{id}/await` | Block until ACKed. | `200` acked · `408` on timeout |
| `GET /` | Health/identity. | `200` body `"Http Relay"` |

† Not in the README/`openapi.yaml`, but emitted by the handlers: `404 "Entry expired"` when a
subscribed entry's sender is dropped while a `GET` waits; `503 "Too many concurrent requests"`
when one inbox exceeds the **hardcoded** per-entry waiter cap (`MAX_WAITERS_PER_ENTRY = 10`). This
is **not** `--max-entries` — that caps total stored entries (LRU) and silently evicts the oldest,
never returning `503`.

```bash
# Store a message (returns 200 immediately)
curl -X POST http://localhost:8080/inbox/my-channel \
  -H "Content-Type: application/json" \
  -d '{"hello": "world"}'

# Retrieve (long-poll up to 25s) -> 200 + original Content-Type, or 408
curl http://localhost:8080/inbox/my-channel

# Acknowledge / clear (200, or 404 if nothing to ack)
curl -X DELETE http://localhost:8080/inbox/my-channel

# Check ack status -> body "true"/"false", or 404 if no message
curl http://localhost:8080/inbox/my-channel/ack

# Block until acked -> 200, or 408 on timeout
curl http://localhost:8080/inbox/my-channel/await
```

<sub>Source: [`server.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/http_relay/server.rs#L187-L216), [`inbox_handler.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/http_relay/inbox_handler.rs#L26-L124), [README](https://github.com/pubky/http-relay/blob/e4f3d9e/README.md). Routes + status codes verified live against a local testnet relay.</sub>

## Delivery semantics and client patterns

Key behaviors to design around:

- **At-least-once.** A consumer may `GET` the same message repeatedly until it `DELETE`s (ACKs)
  it. The producer only learns delivery succeeded when the consumer ACKs.
- **No client poll loop needed.** A consumer can `GET` *before* the producer `POST`s; the `GET`
  long-polls (up to 25s) for the message to arrive.
- **`Content-Type` is preserved** — whatever the producer `POST`ed is returned to the consumer.
- **Mobile-friendly.** TCP can't detect a sudden consumer disconnect (Wi-Fi off, app killed) for
  30+ seconds — which is exactly why `/inbox` uses explicit ACKs instead of relying on the
  connection. If the consumer crashes before ACKing, the message stays available for retry
  (survives OS backgrounding). The 25s default stays under typical proxy limits (nginx,
  Cloudflare).

**Producer:** `POST`, then loop `GET /await` until `200`; retry on `408` (timeout) and on network
error — safe, because the message persists until ACKed.

```js
async function produceToRelay(channelId, data) {
  // Store the message (returns immediately)
  while (true) {
    try {
      const storeResponse = await fetch(`http://relay.example.com/inbox/${channelId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (storeResponse.status === 200) break;
      throw new Error(`Failed to store: ${storeResponse.status}`);
    } catch (error) {
      // Network error - retry after brief delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
  }

  // Wait for consumer to ACK (blocks up to 25s per call)
  while (true) {
    try {
      const awaitResponse = await fetch(
        `http://relay.example.com/inbox/${channelId}/await`
      );

      if (awaitResponse.status === 200) {
        return; // Consumer ACKed - delivery confirmed
      }

      if (awaitResponse.status === 408) {
        continue; // Timeout - keep waiting
      }

      throw new Error(`Unexpected status: ${awaitResponse.status}`);
    } catch (error) {
      // Network error - retry after brief delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
  }
}
```

**Consumer:** long-poll `GET` until `200`, then `DELETE` to ACK (critical — the producer is
blocked on `/await`). Retry the `DELETE` on network error; the message is **not** re-delivered
after a successful ACK.

```js
async function consumeFromRelay(channelId) {
  // Long-poll until message is available (waits up to 25s per call)
  while (true) {
    try {
      const response = await fetch(`http://relay.example.com/inbox/${channelId}`);

      if (response.status === 200) {
        const data = await response.text();

        // ACK the message (critical - producer is waiting for this)
        // Retry ACK on network error - message won't be re-delivered after success
        while (true) {
          try {
            await fetch(`http://relay.example.com/inbox/${channelId}`, {
              method: 'DELETE',
            });
            break;
          } catch (error) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
        }

        return data;
      }

      if (response.status === 408) {
        continue; // Timeout - no message yet, retry
      }

      throw new Error(`Unexpected status: ${response.status}`);
    } catch (error) {
      // Network error (app backgrounded, connection dropped, etc.)
      // Wait briefly then retry - message is still safe on the relay
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }
  }
}
```

<sub>Source: [README](https://github.com/pubky/http-relay/blob/e4f3d9e/README.md). Both functions run
end-to-end against a local testnet relay (producer `/await` confirmed delivery; consumer received
the exact payload and ACKed).</sub>

## Security: inbox IDs are bearer secrets

> **Load-bearing.** An inbox `{id}` is a **shared/bearer secret**: anyone who knows the ID can
> read, write, or ACK that inbox. IDs **must be cryptographically random** (e.g. 128-bit UUIDs) —
> predictable IDs let an attacker intercept messages or forge ACKs. Messages are held in
> **plaintext** (in memory, or in the SQLite DB when persistence is on) for the TTL window, so
> **do not relay sensitive one-time credentials** unless you encrypt at the application layer.
> (`pubkyauth` does exactly this: it derives the channel from a hashed client secret and posts
> only ciphertext — see [`auth.md`](../../pubky/references/auth.md).)

<sub>Source: [`inbox_handler.rs` module docs](https://github.com/pubky/http-relay/blob/e4f3d9e/src/http_relay/inbox_handler.rs#L1-L11)</sub>

## Persistence, CORS, and limits

**Persistence** is two layers. The `persist` Cargo feature (on by default) compiles in SQLite
support, but on-disk durability only happens when you pass `--persist-db <PATH>`. Without the
flag the default build still runs **in-memory** (SQLite via `Connection::open_in_memory()`, not a
`HashMap`) and **loses all data on restart**. Supply a path for durable storage across restarts.
(The plain-`HashMap` backend is compiled in only when the `persist` feature is *disabled*.)

**CORS** is off by default — **no** CORS headers are added, which suits deployment behind a
reverse proxy (nginx, caddy) that manages CORS. Pass `--cors-allow-all` for permissive CORS via
`tower_http::CorsLayer::very_permissive()` (reflects the request's `Origin`/method/headers rather
than emitting a literal `*`); you need this only when a browser/WASM client calls the relay
**directly**.

**Limits** (compile-time defaults, tunable via flags): max body `2048` bytes (2 KB,
`--max-body-size`, enforced by `axum::DefaultBodyLimit`); max channel ID `256` bytes; max stored
entries `10000` (`--max-entries`; oldest evicted via LRU when full).

<sub>Source: [`main.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/main.rs#L47-L50), [`server.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/http_relay/server.rs#L1-L7), [`response.rs`](https://github.com/pubky/http-relay/blob/e4f3d9e/src/http_relay/response.rs#L23-L30)</sub>

## Cargo features

Default = `["cli", "persist", "link-compat"]`.

| Feature | Default | Provides |
| :-- | :-- | :-- |
| `server` | (pulled by `cli`) | The HTTP server (axum handlers + middleware); enables `HttpRelay` / `HttpRelayBuilder`. |
| `persist` | yes | SQLite persistence (`EntryRepository`). Without it, in-memory `HashMap` only. |
| `link-compat` | yes | Legacy `/link/{id}` endpoints (deprecated; requires `server`). |
| `cli` | yes | The `http-relay` binary (pulls in `clap` + `tracing-subscriber` + `server`). |

The binary target requires `cli`. To embed only, depend on the crate with `server` (e.g.
`default-features = false, features = ["server"]`).

<sub>Source: [`Cargo.toml`](https://github.com/pubky/http-relay/blob/e4f3d9e/Cargo.toml#L31-L55)</sub>

## Legacy /link endpoint (deprecated)

Present only with the `link-compat` feature. `POST /link/{id}` sends a message and blocks until a
consumer retrieves it; `GET /link/{id}` retrieves and blocks until a producer sends; both use the
`--link-timeout` (default 600s = 10 min). This implements the standard HTTP Relay spec
(<https://httprelay.io/>).

**Prefer `/inbox` for new integrations.** `/link` has **no ACK mechanism** — if the consumer
disconnects right after receiving data, the producer still gets `200 OK` (false-positive
delivery) — and its 10-minute blocking timeout exceeds typical proxy limits (nginx, Cloudflare),
whereas the inbox 25s default stays under them.

<sub>Source: [README](https://github.com/pubky/http-relay/blob/e4f3d9e/README.md)</sub>
