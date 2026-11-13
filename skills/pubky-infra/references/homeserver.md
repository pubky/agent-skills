# Run a homeserver

Operator reference for Pubky Homeserver: install and run, upgrades, public deployment,
`config.toml`, client identity and rate limits, PKARR republishing, the admin and metrics servers
(signup tokens, users, quotas), the dashboard, and Umbrel vs standalone.

Operations only. For the protocol model, see
[the homeserver model](../../pubky/references/concepts.md#the-homeserver-model) ·
[homeserver-write vs Nexus-read](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) ·
[`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

> **Versions (checked 2026-11-12).**
> - **Latest release: v0.18.0** (2026-11-09). Also the crates.io max version and Docker Hub
>   `synonymsoft/homeserver:v0.18.0` (`latest` now points at it). Earlier: v0.17.1 (10-26), v0.16.2
>   (10-15), v0.16.1 (10-13), v0.16.0 (10-12), v0.15.0 (10-07), v0.14.0 (09-28), v0.13.0 (09-23).
> - **There is no v0.17.0.** Its version bump shipped inside v0.17.1. Upstream `docs/INSTALL.md`
>   still says `PUBKY_VERSION=0.17.0` (download 404s, `git checkout v0.17.0` fails), and the Domain
>   and IP-only guides say "v0.17.0 or later": read both as **v0.17.1**.
> - MSRV: `rust-version = 1.91` at v0.17.1 and v0.18.0.
> - **`main` is unreleased**, 9 commits past v0.18.0 at `8612a64`: cargo-deny CI, http-relay
>   persistence off, dependency bumps, SDK WASM `request_timeout`, streaming upload size limit
>   (#808), SignupService (#777) and FileService refactors, deep-link parsing refactor, and **child
>   grants (#792, breaking)**. This file labels those **main only**.
> - The Umbrel community app runs **v0.16.1** ([Umbrel vs standalone](#umbrel-vs-standalone)).
> - `openapi-admin.yml` and `openapi-client.yml` still say `info.version: 0.9.0` (stale).
>
> Pubky is pre-1.0. Check every API shape below against the linked upstream file.

## Install and run

The binary is **`pubky-homeserver`**; in the Docker image and on Umbrel it is **`homeserver`**. The
CLI has one flag, `--data-dir` / `-d` (default `~/.pubky`), which must come **before** the
subcommand, and one optional subcommand:

- **`init`** (v0.10+): writes `config.toml` and the keypair, then **exits**. It does not start the
  server or touch Postgres.
- **No subcommand**: starts the server, which runs until **SIGINT** (Ctrl+C).

Release binary (upstream INSTALL.md with the version corrected to the latest release):

```bash
PUBKY_VERSION=0.18.0  # upstream INSTALL.md says 0.17.0, which was never tagged (404)
PUBKY_PLATFORM=linux-amd64  # or linux-arm64. Alternatively: osx-arm64, osx-amd64, windows-amd64
curl -LO https://github.com/pubky/pubky-homeserver/releases/download/v${PUBKY_VERSION}/pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
tar -xf pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
cp pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}/pubky-homeserver /usr/local/bin  # usually needs sudo
pubky-homeserver --version
```

<sub>Run on osx-arm64 (the `cp` step skipped): `--version` printed `pubky-homeserver 0.18.0`. All
five v0.18.0 platform URLs return 200; the v0.17.0 URL returns 404. Each tarball holds a
`pubky-homeserver-v<ver>-<platform>/` folder with both `pubky-homeserver` and `homeservercli`
([`operator-cli.md`](operator-cli.md)).</sub>

From source or Docker, then initialise the data dir:

```bash
cargo build --release -p pubky-homeserver   # needs Rust 1.91+
cp ./target/release/pubky-homeserver /usr/local/bin

# or Docker (the binary inside the image is `homeserver`)
docker build -t pubky-homeserver .
docker run --rm pubky-homeserver homeserver --version

# initialise the data dir (pick one)
pubky-homeserver init
pubky-homeserver --data-dir /path/to/pubky-data init
docker run -it -v ~/.pubky:/root/.pubky pubky-homeserver homeserver init
```

<sub>The cargo build and both native `init` forms were run against v0.18.0 (writes `config.toml` and
`secret`). The image was not built; the `docker run` flags were parser-checked and the in-image
binary name comes from the Dockerfile.</sub>

**Prebuilt images:** `synonymsoft/homeserver` on Docker Hub, tagged `v<version>` (v0.18.0,
v0.17.1, v0.16.2, v0.16.1, …), by commit SHA, and `latest`; pubky-docker and Umbrel use them. The
binary is `/usr/local/bin/homeserver` (`CMD ["homeserver"]`). v0.18.0 builds on a digest-pinned
`rust:1.99.0-alpine3.23` with a digest-pinned `alpine:3.24` runtime (v0.17.1: `rust:1.91.1-alpine3.23`
/ `alpine:3.23`). The image declares no `STOPSIGNAL`. **Pin a version tag, not `latest`:** `latest`
moved to v0.18.0, which has breaking changes ([Upgrade notes](#upgrade-notes)).

**Data dir layout:** `config.toml`, `secret` (the server keypair, i.e. the server's identity), file
storage under `data/files`, and the upload staging area `data/files-tmp`.

> **Gotcha: keep `data/files-tmp` and `data/files` on the same filesystem (v0.14.0+).** Uploads are
> staged in `files-tmp` and renamed into `files`. Mount `data/` (or `~/.pubky`) as the volume, never
> `data/files` alone. Don't back up `files-tmp`.

> **Gotcha: set `database_url` with real credentials.** `init` writes the annotated sample with
> **every setting commented out**, so only the embedded defaults apply, and those set
> `database_url = "postgres://localhost:5432/pubky_homeserver"` (no user, so the client falls back to
> the OS username). Unless you override it, startup **usually** fails with a Postgres connection,
> auth or "database does not exist" error, not a missing-config error. It can work only with a local
> Postgres using trust/peer auth, a matching role and an existing `pubky_homeserver` DB. Upstream
> INSTALL.md's "works out of the box for local use" is misleading for the Docker Postgres setup it
> describes.

**PostgreSQL is required.** The homeserver runs its own migrations but **does not create the
database**. Create an empty one first:

```bash
docker run --name pubky-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pubky_homeserver \
  -p 127.0.0.1:5432:5432 \
  -v postgres-data:/var/lib/postgresql \
  -d postgres:18

# Uncomment [general] and set database_url (GNU sed; on macOS use `sed -i ''`)
sed -i 's|^# \[general\]|[general]|; s|^# database_url = .*|database_url = "postgres://postgres:postgres@localhost:5432/pubky_homeserver"|' ~/.pubky/config.toml
```

<sub>The `sed` was run against a real v0.18.0 `init`-generated config (GNU sed and BSD `sed -i ''`);
the result parses as TOML with `[general] database_url = "postgres://postgres:postgres@…"`. The
`docker run` flags were parser-checked (container not started). The `/var/lib/postgresql` mount
matches the `postgres:18` layout and upstream INSTALL.md.</sub>

Run the server:

```bash
# Docker: host networking, so the container can reach Postgres on the host
docker run -d --name pubky-homeserver --restart unless-stopped --network=host -v ~/.pubky:/root/.pubky pubky-homeserver homeserver

# native, in the foreground
pubky-homeserver

# from source (dev)
cargo run -p pubky-homeserver -- --data-dir ~/.pubky
```

<sub>`cargo run … -- --data-dir <dir>` was confirmed to forward the flag (run with `init`). The
`docker run` flags were parser-checked.</sub>

> `--network=host` reaches host Postgres on **Linux Docker Engine** only. Docker Desktop and colima
> on macOS behave differently.

**Stop it with SIGINT, not SIGTERM.** `main.rs` (v0.18.0 included) waits only on
`tokio::signal::ctrl_c()`. For systemd, set `KillSignal=SIGINT`:

```ini
[Unit]
Description=Pubky Homeserver
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/pubky-homeserver --data-dir /home/YOUR_USER/.pubky
User=YOUR_USER
# The homeserver listens for SIGINT (Ctrl+C), not SIGTERM.
KillSignal=SIGINT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> **Containers (inferred from `main.rs`, not stated upstream):** the binary runs as PID 1 with no
> SIGTERM handler and the image sets no `STOPSIGNAL`, so `docker stop` probably waits out the grace
> period and then sends SIGKILL. For a clean shutdown, add `--stop-signal SIGINT` to `docker run`,
> or set `stop_signal: SIGINT` in compose.

**Startup:** the binary (not an embedding app) logs `Pubky Homeserver version <x.y.z>` (v0.13.0+).
It then starts the user-keys republisher, StorageRepair (v0.17.1+, GCS only), the admin and metrics
servers if enabled, the client server, and last the homeserver key republisher, which makes an
**initial PKARR publish. If that first publish fails, startup aborts.**

**Logging:** `[logging] level = "info"`, but the default
`module_levels = ["pubky_homeserver=debug", "tower_http=debug"]` puts the homeserver's own logs and
HTTP traces at **DEBUG**. Set `module_levels` yourself to quiet them (your array replaces the
default). Output is plain-text tracing on stdout, not JSON. For the dashboard's Logs tab, tee stdout
to a file ([homeserver-dashboard](#homeserver-dashboard)).

### Upgrade notes

Read the [release notes](https://github.com/pubky/pubky-homeserver/releases) for every version you
skip. What changes operations:

- **v0.13.0** adds the `entry_locks` table (WebDAV locks).
- **v0.15.0**'s migration `m20261002_entry_path_c_collation` rebuilds the entries path index on
  first start. Upstream expects under 5 s; no data changes.
- **v0.17.1 (breaking):**
  - **Client IP comes from the TCP peer or a PROXY preface; `X-Forwarded-For` / `X-Real-IP` are no
    longer read** (#643). Behind a reverse proxy, all clients now share the proxy's IP limits until
    you configure a proxy mode ([Client identity](#client-identity-and-rate-limits)).
  - **Behind Caddy, switch both sides together.** Caddy `proxy_protocol v2` and homeserver
    `proxy_protocol` mode must change in the same restart/reload: while they differ, a proxy-mode
    listener closes preface-less connections and Caddy returns **502**. Or leave both direct and
    accept shared IP limits.
  - HEAD returns 405 on the token and SSE routes (#738, [Admin API](#admin-api-6288)).
  - opendal 0.59 (breaking). The GCS misnamed-object repair (#706) runs at startup (below).
  - Static websites are **on by default** ([Static websites](#static-websites)).
- **v0.18.0 (breaking):**
  - **Config validation is now enforced (#769).** A config that loaded on v0.17.1 or earlier can
    refuse to start ([config.toml](#configtoml)).
  - **Legacy Base32 event cursors are rejected (#753)** on client `/events/`, client
    `/events-stream` and admin `/events-stream`: non-numeric cursors get **400**; all-digit values
    are event IDs. Omit the cursor or use `0` to start over (and handle repeated events), or resume
    from a saved numeric event ID **for the same homeserver**. Check any indexer
    ([`nexus-operations.md`](nexus-operations.md)).
  - A new default rate limit, `GET /account` 60r/m per IP ([config.toml](#configtoml)).
  - Private file reads change caching headers ([Reverse-proxy caching](#reverse-proxy-caching)).
  - **SDK path encoding (#797, client side):** paths are now percent-encoded once. Files that SDK
    v0.6–v0.17 wrote under names HTTP encoding escapes (e.g. `pub/my file.txt`) are stored as
    `pub/my%20file.txt`. **The homeserver does not rename them; there is no server-side
    migration.** Clients read them at the stored name: see
    [`sdk-rust.md`](../../pubky/references/sdk-rust.md) / [`sdk-js.md`](../../pubky/references/sdk-js.md).
  - **Cookie auth** (deprecated since v0.10.0) now gets only limited security maintenance and
    **will be removed in August 2027**. Move apps to grant auth:
    [`auth.md` § Deprecated: cookie auth](../../pubky/references/auth.md#deprecated-cookie-auth).
- **main only:** migration `m20261103_add_grant_delegation` adds `Kind` and `ParentId` columns to
  the grants table for child grants (#792, breaking). Semantics belong to the auth model:
  [`auth.md`](../../pubky/references/auth.md#session-lifecycle) and upstream
  [`docs/delegated-grants.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md).
  v0.17.1 and v0.18.0 add no SQL migrations beyond those already on `main` at the previous sync.

> **GCS storage only: some files return 404 on v0.13.0–v0.16.1.** Those versions stored entries
> whose path has a character outside ``A-Za-z0-9 - _ . * ! ' ( ) ~ /`` under a percent-encoded
> object name (`a b` stored as `a%20b`), so reads 404. v0.16.2 (#687) fixes new writes; **v0.17.1+
> (#706) repairs existing objects** at startup, records completion in the migrations table, and
> logs conflicts, which you must repair by hand. A run that fails on an entry retries on the next
> startup.

### Embedding as a library

`HomeserverApp`'s public API is unchanged from v0.16.2 through `main`.

```rust
use pubky_homeserver::HomeserverApp;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = HomeserverApp::start_with_persistent_data_dir_path(
        PathBuf::from("~/.pubky")
    ).await?;

    println!("Homeserver HTTP: {}", app.icann_http_url());
    println!("Homeserver Pubky TLS: {}", app.pubky_url());

    if let Some(admin) = app.admin_server() {
        println!("Admin server: http://{}", admin.listen_socket());
    }

    tokio::signal::ctrl_c().await?;
    Ok(())
}
```

<sub>Source: [`pubky-homeserver/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/README.md) (not CI-verified upstream). Verified here with `pubky-homeserver = "=0.18.0"` from crates.io, `tokio` (full) and `anyhow` under `cargo clippy --all-targets -- -D warnings`. The leading `~/` is expanded by `PersistentDataDir`. Other entry points: `start_with_persistent_data_dir`, `start`, `start_with_mock_data_dir` (`testing` feature), `client_server()`, `admin_server()` and `metrics_server()` (both `Option`), `public_key()`. `lib.rs` also re-exports `ClientIdentityToml` (v0.17.1+, #643); main only: `MAX_UPLOAD_BYTES` (#808).</sub>

## Servers and sockets

Every default binds to loopback.

| Server | Default socket | On by default | Expose publicly? |
| :-- | :-- | :-- | :-- |
| Client, ICANN HTTP | `127.0.0.1:6286` | yes | **No.** Put a reverse proxy or tunnel in front |
| Client, Pubky TLS | `127.0.0.1:6287` | yes | **Yes** (Domain / IP-only). Set `0.0.0.0:6287` for direct access |
| Admin | `127.0.0.1:6288` | yes | **Never** |
| Metrics (`/metrics`, no auth) | `127.0.0.1:6289` | **no** | **Never** |

The client server hosts tenant storage, auth and event feeds; spec:
[`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml).

- **`GET /info`** (unauthenticated, `Cache-Control: no-store`; not the admin `/info`) returns
  `features` for SDK feature discovery: `["path-addressed-storage", "grant-proof-logout",
  "webdav-locks"]`, plus `"websites"` when `[drive] websites` is on (v0.17.1+). main only (#792):
  also `"grant-delegation"`.
- **`GET /account`** (v0.18.0+, #749/#754) returns the caller's own account in the same shape as an
  admin `GET /users/{pubkey}` item. Grant sessions only (cookie → 401); needs read on the root
  scope (`/:r` or `/:rw`), else `403 Read access to all storage required`. Disabled users can still
  read it. `no-store`, `Vary: Authorization`, HEAD → 405. SDK usage:
  [`auth.md` § Session lifecycle](../../pubky/references/auth.md#session-lifecycle).
- **Uploads:** tenant `PUT` bodies have a **100 MiB** limit, but **through v0.18.0 it is not
  enforced on streamed bodies without `Content-Length`**. main only (#808): enforced on both PUT
  routes including streamed bodies, returning **413** and cleaning up staged files. Quota exceeded
  stays **507**.

## Client identity and rate limits

The client IP that IP-keyed rate limits and whitelists see:

| | v0.16.2 and earlier | v0.17.1+ |
| :-- | :-- | :-- |
| Client IP source | first parseable `X-Forwarded-For`, then `X-Real-IP`, then the TCP peer | per listener mode (below). In `direct` and `proxy_protocol`, forwarding headers are **ignored** |
| Behind a local proxy | works through the forwarding headers | all clients **share the proxy's IP limits** unless you set a proxy mode |
| Config | `*_client_identity` is **silently ignored** | `drive.icann_client_identity` / `drive.pubky_client_identity` |

Modes, set independently on each listener:

| Mode | Since | Client IP from |
| :-- | :-- | :-- |
| `direct` (default) | v0.17.1 | TCP peer |
| `proxy_protocol` | v0.17.1 | PROXY v1/v2 preface from a peer in `trusted_proxies` |
| `http_header` | **v0.18.0** | one configured single-IP header, from a peer in `trusted_proxies`; the proxy **must overwrite** it with the client IP |

```toml
[drive]
icann_client_identity = { mode = "direct" }
pubky_client_identity = { mode = "direct" }
# Local PROXY-protocol proxy (v0.17.1+), replacing the ICANN line above:
# icann_client_identity = { mode = "proxy_protocol", trusted_proxies = ["127.0.0.1/32"] }
# Local proxy that sets X-Real-IP (v0.18.0+):
# icann_client_identity = { mode = "http_header", header = "X-Real-IP", trusted_proxies = ["127.0.0.1/32"] }
```

Upstream's table form of `http_header` (v0.18.0+). Remove any inline `icann_client_identity` from
`[drive]` first, then add this after the other `[drive]` settings:

```toml
[drive.icann_client_identity]
mode = "http_header"
header = "X-Real-IP"
trusted_proxies = ["127.0.0.1/32"]
```

Rules ([`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md#client-addresses-and-rate-limits)):

- **Both proxy modes need a nonempty `trusted_proxies`, and an allowed peer can claim any client
  IP.** Keep a proxy-mode listener unreachable by anyone but the proxy. Connections from other
  peers are closed before HTTP processing or the TLS handshake.
  - `proxy_protocol` logs `Rejected connection during client identification`; for Pubky TLS the
    preface must come before the TLS handshake.
  - `http_header` logs `Rejected connection from untrusted HTTP header proxy`.
- **`http_header`:** every request must carry exactly one header value, a bare IPv4 or IPv6
  address with no port. Missing, duplicate or malformed values get **400**, even on routes without
  IP limits. Address lists (`X-Forwarded-For` chains) are unsupported and there is no fallback
  header. IPv4-mapped IPv6 shares limits with its IPv4 form.
- **Same-host tools break in proxy modes.** A local `curl http://127.0.0.1:6286` health check or the
  dashboard's client API explorer gets its connection closed (`proxy_protocol`), or **400** unless
  it sends the header (`http_header`, inferred: the middleware wraps the whole client router). If
  Caddy isn't sending `proxy_protocol` to a proxy-mode listener, Caddy returns **502**.
- **Don't put `pubky_client_identity` in `http_header` mode** while clients reach Pubky TLS (6287)
  directly: they aren't trusted peers, so they are disconnected (inferred).
- **Parsing:** the inline table is `deny_unknown_fields`, tagged by `mode`. These fail: missing
  `mode`, `mode = "direct"` with `trusted_proxies`, `http_header` without `header` or
  `trusted_proxies`, and an empty `trusted_proxies` ("trusted_proxies must not be empty"). An
  invalid header name fails when the client server is built.
- **Unknown `[drive]` keys are silently ignored.** A typo such as `icann_client_identitiy` leaves
  direct mode in effect.
- User-keyed limits are unaffected by any mode.

> **Security, v0.17.1+ direct mode behind a local proxy (inference):** every request's TCP peer is
> `127.0.0.1`, so the sample's `POST /session` 20r/m limit that whitelists `127.0.0.1` exempts
> **every** client, and all clients share the proxy's IP limits. Use `proxy_protocol` or
> `http_header`, or drop the `127.0.0.1` whitelist.

> **Security, v0.16.2 and earlier:** a client that reaches a listener directly, notably Pubky TLS
> on `0.0.0.0:6287`, can probably set `X-Forwarded-For` and spoof the IP that limits and whitelists
> see. Don't rely on IP whitelists there.

## config.toml

Your `config.toml` is **deep-merged over the embedded `config.default.toml`**, table by table and
key by key. The annotated
[`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
documents every key.

> **Gotcha: arrays replace the defaults, they don't merge (`replace_arrays = true`).** Any array you
> set, such as `[[drive.rate_limits]]`, `dht_relay_nodes` or `module_levels`, **replaces the
> default array entirely**. On v0.18.0+ the embedded config has **two** default rate limits; defining
> your own `[[drive.rate_limits]]` **silently drops both**. Add them back:

```toml
[[drive.rate_limits]]
path = "/signup_tokens/*"
method = "GET"
quota = "10r/m"
key = "ip"

[[drive.rate_limits]]
path = "/account"
method = "GET"
quota = "60r/m"
key = "ip"
```

<sub>Verbatim from the embedded `config.default.toml` (v0.18.0+). Before v0.18.0 only the
`/signup_tokens/*` limit exists (it slows token brute-forcing); the `/account` route is v0.18.0+.</sub>

> **Gotcha: v0.18.0 enforces validation at load (#769).** These used to load and now **fail
> startup**:
> - A `[[drive.rate_limits]]` `whitelist` entry of the wrong type for its `key` (e.g. an IP in a
>   `key = "user"` limit): `Whitelist key type mismatch …`.
> - An empty GCS `bucket_name`: `string must not be empty` (only empty is rejected).

> **Sample ≠ defaults.** The sample shows `[metrics] enabled = true`, bandwidth quotas and a
> `POST /session` 20r/m per-IP limit that whitelists `127.0.0.1`. `init` writes all of it commented
> out, so **metrics are OFF**, there is **no bandwidth throttling**, and only the embedded rate
> limits apply.

> **Unknown keys are silently ignored.** Only the client-identity tables use
> `deny_unknown_fields`; a typo elsewhere (e.g. in `[drive]`) leaves the default in effect.

Embedded defaults:

- `[general]`: `signup_mode = "token_required"` (or `"open"`),
  `database_url = "postgres://localhost:5432/pubky_homeserver"`. `user_storage_quota_mb = 0` is
  deprecated (`0` means unlimited) and ignored when `[storage].default_quota_mb` is set.
- `[drive]`: `pubky_listen_socket = "127.0.0.1:6287"`, `icann_listen_socket = "127.0.0.1:6286"`,
  the rate limits above, and (v0.17.1+) `websites = true`, `icann_client_identity` and
  `pubky_client_identity` (both `{ mode = "direct" }`). Rate-limit rules count requests only.
- `[default_quotas]`: **empty**, so there is **no bandwidth throttling by default**. Keys:
  `rate_read`, `rate_write`, their `*_burst`, `unauthenticated_ip_rate_read`. The sample's
  10mb/s / 5mb/s / 1mb/s values are commented-out examples.
- `[storage]`: `type = "file_system"` (default) or `"google_bucket"` (`bucket_name` and
  `credential`; the **bucket must already exist**; Cargo default feature `storage-gcs`).
  `"in_memory"` **parses only in builds with the `storage-memory` or `testing` feature**, although
  upstream INSTALL.md lists it without that caveat. For `default_quota_mb`, **absent means
  unlimited and `0` means zero storage**.
- `[admin]`: `enabled = true`, `127.0.0.1:6288`, `admin_password = "admin"` (**change it**).
- `[metrics]`: `enabled = false`, `127.0.0.1:6289`.
- `[pkdns]`: `public_ip = "127.0.0.1"`, `icann_domain = "localhost"`,
  `user_keys_republisher_interval = 14400`, and `dht_relay_nodes` set to `pkarr.pubky.app` and
  `pkarr.pubky.org`.
  - `dht_request_timeout_ms` (UDP, per DHT request) and `relay_request_timeout_ms` (relay HTTP)
    are separate since v0.15.0 (#661). Both are optional; omitted means Pkarr's default, and `0` is
    rejected. The sample's 2000 and 5000 are **not** the effective defaults.
- `[logging]`: `level = "info"` and `module_levels = ["pubky_homeserver=debug", "tower_http=debug"]`
  (so the homeserver itself logs at DEBUG).

The homeserver has **no built-in ICANN TLS.** Run a reverse proxy and manage certificates yourself.

## Static websites

v0.17.1+ (#718); see
[`docs/WEBSITES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md).
`[drive] websites = true` is the **default**; set `websites = false` to turn it off.

- Host `<user-key>` serves `/pub/website/_/`; Host `<label>.<user-key>` serves
  `/pub/website/<label>/`.
- GET and HEAD only, no range requests. Responses carry `Cache-Control: no-cache` and `nosniff`.
  Unknown user → 404; disabled user → 403.
- Paths whose first segment is `account` (v0.18.0+), `auth`, `events`, `events-stream`, `info`,
  `priv`, `pub`, `session`, `signup`, `signup_tokens` or `storage` stay on the client API.
- Path rate limits match the site file's storage path. Website requests are **not** counted in
  `storage_request_count_total`.
- The SDK has no helper yet to publish the record that points a user key at the homeserver.

## Deploy publicly

Pick a guide from
[`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md):

| Guide | Needs | Pubky TLS (6287) | Certs |
| :-- | :-- | :-- | :-- |
| [Domain](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/domain.md) | static IP + domain; open 80/443/6287 | yes | Caddy, 90-day |
| [IP-only](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/ip-only.md) | static IP; Caddy v2.10.1+ | yes | Caddy `shortlived`, ~6-day |
| [Cloudflare Tunnel](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/cloudflare-tunnel.md) | domain on Cloudflare; no static IP or open ports | **no** | Cloudflare |

> **Rules for every deployment.** Never set `0.0.0.0` on the ICANN, admin or metrics socket, and
> never expose 6286, 6288 or 6289 to the internet.
> **Domain and IP-only:** bind only `pubky_listen_socket` to `0.0.0.0:6287`, and use a static IP,
> because the PKARR record contains `public_ip`. Cloudflare Tunnel needs neither.

> **Match the proxy config to the version you run.** The Domain and IP-only guides say "Homeserver
> v0.17.0 or later for PROXY protocol support"; the first such release is **v0.17.1**.
> - **v0.16.2 or earlier:** plain `reverse_proxy 127.0.0.1:6286` with no
>   `transport http { proxy_protocol v2 }` block, and no `icann_client_identity`. A PROXY preface
>   sent to a pre-0.17.1 listener would probably break every request (untested).
> - **v0.17.1+:** use the snippets below. Restart the homeserver and reload Caddy together
>   ([Upgrade notes](#upgrade-notes)).

**Domain** (v0.17.1+). For IP-only, set `icann_domain = "YOUR_IP"`:

```toml
# ~/.pubky/config.toml
[drive]
pubky_listen_socket = "0.0.0.0:6287"
# icann_listen_socket defaults to 127.0.0.1:6286 — no change needed.
# Accept client addresses from the local Caddy proxy.
icann_client_identity = { mode = "proxy_protocol", trusted_proxies = ["127.0.0.1/32"] }

[pkdns]
public_ip = "YOUR_IP"
icann_domain = "YOUR_DOMAIN"
```

The Caddyfile host must exactly match both the DNS A record and `icann_domain`:

```caddyfile
your_domain.com {
    reverse_proxy 127.0.0.1:6286 {
        transport http {
            proxy_protocol v2
        }
    }
}
```

**IP-only** (v0.17.1+). Caddy needs `default_sni` (clients send no SNI to a bare IP) and the
`shortlived` ACME profile (required for IP certificates):

```caddyfile
{
    default_sni YOUR_IP
}

YOUR_IP {
    tls {
        issuer acme {
            profile shortlived
        }
    }
    reverse_proxy 127.0.0.1:6286 {
        transport http {
            proxy_protocol v2
        }
    }
}
```

**Cloudflare Tunnel** (standalone `cloudflared`). The tunnel carries only HTTP, so
`pubky_listen_socket` keeps its default. Set `[pkdns] public_icann_http_port = 443` and
`icann_domain = "YOUR_DOMAIN"`.

```bash
cloudflared login
cloudflared tunnel create pubky-homeserver
cloudflared tunnel route dns pubky-homeserver YOUR_DOMAIN
# write ~/.cloudflared/config.yml (below), then install it as a service.
# Pass --config explicitly, because sudo changes HOME.
sudo cloudflared --config ~/.cloudflared/config.yml service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

```yaml
# ~/.cloudflared/config.yml
tunnel: <TUNNEL_ID>
credentials-file: /home/<YOUR_USER>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: YOUR_DOMAIN
    service: http://127.0.0.1:6286
  - service: http_status:404
```

<sub>Every `cloudflared` command, including the global `--config` before `service install`, was
accepted by the real cloudflared 2026.10.7 CLI parser (not run against Cloudflare). `service
install` copies the config to `/etc/cloudflared/config.yml` and already enables the unit; the
`systemctl` lines (Linux only, not run) are harmless.</sub>

Tunnel client IPs: in the default `direct` mode **every visitor shares the tunnel's IP limits**. On
**v0.18.0+**, use `http_header` mode with Cloudflare's header, and trust only the connector's TCP
source address:

```toml
[drive]
# 127.0.0.1 assumes cloudflared runs on the same host; use the connector's actual source address.
icann_client_identity = { mode = "http_header", header = "CF-Connecting-IP", trusted_proxies = ["127.0.0.1/32"] }
```

<sub>From `config.sample.toml` ("For Cloudflare Tunnel, use header = "CF-Connecting-IP"") and
`docs/deploy/cloudflare-tunnel.md`. Untrusted peers are disconnected before HTTP; missing,
duplicate or invalid `CF-Connecting-IP` returns 400. This supersedes the older upstream advice that
tunnels "must use direct mode". On v0.17.1, tunnels stay on `direct`.</sub>

**Post-setup checks**, from
[`post-setup.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/post-setup.md):

```bash
# On the server: get the homeserver public key (use your admin password)
curl -s "http://127.0.0.1:6288/info" -H "X-Admin-Password: admin"

# In a pkarr clone: expect an A record for public_ip plus HTTPS/SVCB records
cargo run --example resolve <homeserver-public-key>

# From ANOTHER machine, in a pkarr clone (skip for Cloudflare Tunnel): prints "Pubky Homeserver"
cargo run --features=reqwest-builder --example http-get https://<homeserver-public-key>
```

<sub>Run against a local testnet: `/info` returned `public_key` and `version`; `resolve` (with
`relays http://localhost:15411` appended, since the default public DHT can't see a testnet)
returned the A record and SVCB priority 1 (port 6287) and 10 (`icann_domain`). `http-get` was built
(it requires `--features=reqwest-builder`) but not run, because it uses the public resolver; the
`Pubky Homeserver` root body was confirmed over HTTP.</sub>

### Reverse-proxy caching

Preserve upstream `Cache-Control` and `Vary`. Shared caches must store no private response. Details:
[README § Caching and proxies](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/README.md#caching-and-proxies).

- **v0.18.0+ (#790):** private file reads (GET/HEAD returning 200 or 304) send
  `Cache-Control: private, no-cache`: the browser may keep the file but must revalidate with the
  ETag. Every other private response (errors, directory listings, `/events-stream`) stays
  `no-store`. Before v0.18.0, all private responses were `no-store`.
  - **Tradeoff:** private file bodies stay on the browser's disk after sign-out (no
    `Clear-Site-Data`).
- `/storage/{user_z32}/priv/...` varies on `Authorization` and `Cookie`. The deprecated
  `/priv/...` and `/events-stream` also vary on `pubky-host`. `/priv` is **alpha, not for
  production, and not encrypted from the operator**
  ([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)).
- `/storage/{user_z32}/pub/...` is cacheable and doesn't vary on `pubky-host`; the deprecated
  `/pub/...` still does.

## PKARR republishing

Client-side resolution:
[`concepts.md` § PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution). DHT and
relay operations: [`dns-and-relays.md`](dns-and-relays.md#republishing). Full algorithm:
[`docs/REPUBLISHING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/REPUBLISHING.md)
(unchanged through v0.18.0).

- **HomeserverKeyRepublisher** builds its own packet from config and publishes it at startup (a
  failure aborts the start), then **every hour**. After startup a failed hourly publish is only
  logged as a warning, with **no retry or backoff**. All records have TTL 3600: HTTPS/SVCB
  priority 1 to the Pubky TLS port, priority 10 to `icann_domain`, and one A or AAAA record for
  `public_ip` (by address family).
- **UserKeysRepublisher** waits 60 s after start, then runs every
  `user_keys_republisher_interval` (default 14400 s).
  - `0` disables it.
  - Values under 1800 are **clamped to 1800** with a warning; values under 3600 log a "strongly
    discouraged" warning.
  - It republishes **only users whose `_pubky` HTTPS/SVCB target is this homeserver**. Others are
    `Skipped`, and their data is kept.
  - It does not publish straight from cache, and retries only operational errors, with jittered
    exponential backoff. Outcomes: `Published`, `Skipped`, `Missing`, `InvalidSignedPacket`,
    `Failed`.

> **Relay gotcha.** The defaults always set `dht_relay_nodes` to the mainnet relays
> (`pkarr.pubky.app`, `pkarr.pubky.org`). If you point the DHT at a testnet, also set
> `dht_relay_nodes` to matching relays; your array replaces the default one.

## Admin API (:6288)

Spec:
[`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml)
(its `info.version` is stale). Link to it rather than hardcoding response shapes. CLI wrappers:
[`operator-cli.md`](operator-cli.md).

**Auth:** send **`X-Admin-Password`**. Missing → `401 Missing admin password`; wrong →
`401 Invalid admin password`. **`/dav{*path}` differs:** **HTTP Basic auth, username `admin`**,
with the admin password. `GET /` is public. CORS is `very_permissive`.

| Route | What it does |
| :-- | :-- |
| `GET` / `POST /generate_signup_token` | Mint a token (`POST` takes a `UserQuota` body) |
| `GET /signup_tokens` | List tokens, paginated |
| `GET /users` · `GET /users/{pubkey}` | List users, or get one (v0.17.1+) |
| `POST /users/{pubkey}/disable` · `/enable` | Block or unblock writes (see below) |
| `GET` · `PATCH /users/{pubkey}/quota` | Read or override a user's quota (`{effective, overrides}`) |
| `GET /info` | Stats and identity |
| `GET /events-stream` | SSE stream of **all** users' events, including `/priv` (alpha) |
| `DELETE /webdav/{pubkey}/{path}` | Delete a file; the path **must be under `/pub/`** |
| `/dav/{pubkey}/...` | WebDAV, any root (**Basic** auth) |

> **`{pubkey}` must be raw z32** (`publicKey.z32()`). The `pubky<z32>` display form gets a 400
> (`unexpected `pubky` prefix; expected raw z32`); other malformed keys also get a 400; an
> unregistered valid key gets 404. See
> [`concepts.md` § Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

> **HEAD on token and SSE routes.** v0.17.1+ (#738): HEAD returns `405` on admin
> `/generate_signup_token` (`Allow: GET, POST`), on both `/events-stream` routes, and on client
> `/signup_tokens/{token}`; HEAD on storage and websites is unchanged. **v0.16.2 and earlier**
> serve HEAD with the GET handler, so an authenticated `HEAD /generate_signup_token` (e.g. an
> uptime probe) probably mints and discards a token. On any version, **never point health checks at
> token or SSE routes**.

### Users

`GET /users` and `GET /users/{pubkey}` (v0.17.1+, #735/#745):

- **Item fields:** `pubky` (raw z-base-32; **not `pubkey`**), `created_at`, `disabled`,
  `used_bytes`, `quota {effective, overrides}`. `created_at` is ISO 8601 **without a UTC offset**
  (e.g. `2026-10-22T10:11:12.123456`); don't parse it as RFC 3339.
- **`GET /users` query:** `state=all|enabled|disabled` (default `all`),
  `sort_by=created_at|used_bytes` (default `created_at`; ties by signup order), `reverse` (default
  `false`), `limit`, `cursor`. Response `{items, next_cursor}`; `next_cursor` is `null` on the last
  page.
- `limit` defaults to 100 and is **silently clamped to 1000** (the spec says max 65535).
  `limit=0`, an unknown `state`/`sort_by`, or a bad cursor → 400.
- Cursors continue from the cursor user's **current** position, so pages can shift when sorting by
  `used_bytes`.
- `GET /users/{pubkey}`: invalid key → 400, unknown → 404.
- `quota.effective` always has `storage_quota_mb`, `rate_read`, `rate_write`; burst fields and
  `allowed_write_paths` appear only when set.

```bash
curl -s "http://127.0.0.1:6288/users?state=disabled&limit=100" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

<sub>Run against a local testnet (v0.18.0): returned `{"items":[],"next_cursor":null}`, and a freshly
disabled user appeared in the list; a wrong password returns 401. Follow `next_cursor` until it is
`null`.</sub>

### Signup tokens and quotas

Standalone homeservers require tokens by default. Token rules and client-side signup:
[`auth.md` § Signup tokens](../../pubky/references/auth.md#signup-tokens). Gating services such as
Homegate: [`signup-gating.md`](signup-gating.md). Mint a token with default limits (the response
body is the token):

```bash
curl -X GET "http://127.0.0.1:6288/generate_signup_token" \
  -H "X-Admin-Password: admin"   # use your real admin password
```

<sub>Run against a local testnet: HTTP 200 with a plain-text body such as `VCNG-C62J-CGC0`, which
then appears in the unused-token list; a wrong password returns 401.</sub>

- Format `XXXX-XXXX-XXXX`. This and the `UserQuota` / `UserQuotaPatch` semantics have not changed
  since v0.12.0. In a `POST /generate_signup_token` body, each field is absent or `null` (Default),
  `"unlimited"`, or a value. In `PATCH …/quota`, an absent field **keeps the current value** and
  `null` resets it to Default.
- **`GET /signup_tokens`** takes `state=all|used|unused` (default `all`), `limit` and `cursor`, with
  the same `limit` rules as `GET /users` (default 100, `0` → 400, clamped to 1000). Response:
  `{items: [{token, created_at, used_at, used_by}], next_cursor}`; `created_at` / `used_at` have no
  UTC offset. v0.17.1+ (#732) adds `quota` per item: the overrides stored on the token, in the
  `UserQuota` shape, omitting fields left at system defaults.
- main only (#777): a token used concurrently is reported as already used, and a concurrent signup
  for the same key as a conflict. Admin token routes are unchanged.

```bash
curl -s "http://127.0.0.1:6288/signup_tokens?state=unused&limit=50" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

<sub>Run against a local testnet: HTTP 200 with `{items: [{token, created_at, used_at: null, used_by:
null, quota: {}}, …]}`; the token minted above was listed.</sub>

### Enable and disable users

```bash
curl -X POST "http://127.0.0.1:6288/users/<user-z32>/disable" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

<sub>Run end to end on a local testnet against a throwaway user (signed up with
`@synonymdev/pubky` 0.12.0): 200 `Ok`, then `GET /users/{pubkey}` showed `"disabled": true`; the
user was re-enabled with `POST …/enable` (200). Unknown user → 404, bad key → 400, no password →
401, GET → 405.</sub>

> **Disabling blocks writes; it doesn't lock the account.** PUT and WebDAV `LOCK` are rejected
> with `403 User is disabled`. Sign-in, reads (including `GET /account`), `DELETE` and `UNLOCK`
> still work, so the user can clean up. Website serving returns 403 for a disabled owner. To remove
> a user's files as the operator, use `DELETE /webdav/...` for `/pub/` paths, or WebDAV `DELETE` on
> `/dav/...` for other paths. List disabled users with `GET /users?state=disabled`.

### Admin event stream

`GET /events-stream` (SSE). It includes `/priv` events (alpha, not encrypted from the operator).
`user=<z32>` is repeatable, capped at 50 users. `cursor` is a single global cursor, not the
per-user form; **on v0.18.0+ it must be a numeric event ID** (omit or `0` to start; Base32 → 400).
Event paths after `pubky://<user>` are the stored name, not percent-encoded. For the client-server
stream that Nexus consumes, see [`nexus-operations.md`](nexus-operations.md).

## Metrics (:6289)

Off by default; enable with `[metrics] enabled = true`. One route, `GET /metrics` (Prometheus
text), with **no authentication**: keep it on a private network. Instruments:

- `events_db_query_duration_ms`
- `event_stream_db_query_duration_ms`
- `event_stream_broadcast_lagged_count`
- `event_stream_broadcast_half_full_count`
- `event_stream_active_connections`
- `event_stream_connection_duration_ms`
- `signup_count`
- `storage_request_count`

Counters reset on restart.

> **Query the exposed names.** Prometheus exposes `storage_request_count` as
> **`storage_request_count_total`**, with labels `addressing_mode`, `pubky_host_header`,
> `pubky_host_query` and `auth_method` (at most 36 combinations).

**Storage-addressing migration.** The clock has been declared since v0.15.0 (#650). The first
stable path-addressing SDK release was v0.12.0 (2026-09-14), so the **earliest legacy-removal
review is 2027-09-14**. That date does **not** authorize removal: removal needs an explicit
maintainer decision, with the evidence, recorded in #529 after the review. Until then, legacy
`/pub` with `pubky-host`, the `pubky-host` header and cookie auth keep working (cookie auth itself
is scheduled for removal in August 2027; see [Upgrade notes](#upgrade-notes)). The `/pub` path
layout is still not stabilized (pre-1.0). Website requests pick the owner by Host and are not
counted, so a future legacy-Host removal must keep website routing. Scrape metrics now, keep the
data for the whole period, and aggregate across instances. See
[`STORAGE_ADDRESSING_MIGRATION.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md).

```promql
# Path-addressed versus legacy requests over the last 30 days.
sum by (addressing_mode) (increase(storage_request_count_total[30d]))

# Remaining pubky-host header usage, split by addressing mode.
sum by (addressing_mode, pubky_host_header, pubky_host_query) (
  increase(storage_request_count_total{
    pubky_host_header!="absent"
  }[30d])
)

# Remaining pubky-host query-parameter usage.
sum by (addressing_mode) (
  increase(storage_request_count_total{pubky_host_query="true"}[30d])
)

# Cookie versus grant authentication on storage requests.
sum by (auth_method) (increase(storage_request_count_total[30d]))
```

<sub>From upstream `STORAGE_ADDRESSING_MIGRATION.md`; not run here.</sub>

## homeserver-dashboard

[homeserver-dashboard](https://github.com/pubky/homeserver-dashboard) is a Next.js admin UI that
needs Node.js 24+. Latest tag and Docker Hub image: **`synonymsoft/homeserver-dashboard:v0.1.33`**
(2026-10-27, also `latest`). 0.1.33 is a security update: Node.js 24.22.1 and embedded
cloudflared 2026.10.3 (cloudflared before 2026.10.2 trusts eight weak-key eMudhra/emSign
intermediates). **Upgrade from 0.1.32 or earlier.** One route, `/dashboard`. Tabs:

- **Overview**: admin `/info`.
- **Users**: disable and enable users.
- **Invites**: `GET /generate_signup_token`, with a QR code.
- **Files**: WebDAV through `/dav/*` (Basic auth).
- **Logs**: reads the file named by `HOMESERVER_LOG_PATH`. The homeserver writes plain text to
  stdout, so tee stdout to that file (as Umbrel does); non-JSON lines are shown raw.
- **API explorer**: admin, client and metrics APIs.

Settings dialog:

- **Config** edits the real `config.toml` with redaction and atomic writes; read-only if the file
  isn't writable.
- **Cloudflare** sets up a tunnel.

```bash
docker build -t homeserver-dashboard .
docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e DASHBOARD_PASSWORD=choose-a-login-password \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  homeserver-dashboard
```

<sub>Env names, port and Dockerfile checked against the dashboard source (`d0163e9`) and README;
`docker run` flags parser-checked, image not built. To skip the build, run
`synonymsoft/homeserver-dashboard:v0.1.33` instead.</sub>

> **`http://homeserver:6288` resolves only on a Docker network with a container named
> `homeserver`.** With the [Run the server](#install-and-run) snippet (`--network=host`, name
> `pubky-homeserver`), also run the dashboard with `--network=host` and set
> `ADMIN_BASE_URL=http://127.0.0.1:6288` (and the client/metrics URLs likewise); drop `-p`, which
> host networking ignores.

- **Required, server-only:** `ADMIN_BASE_URL`, and `ADMIN_TOKEN` (the admin password).
- **Optional:**
  - `CLIENT_BASE_URL` (default `http://homeserver:6286`) and `METRICS_BASE_URL` (default
    `http://homeserver:6289`).
  - `HOMESERVER_CONFIG_PATH` and `HOMESERVER_LOG_PATH`.
  - `PLATFORM=umbrel`. Leave it unset for standalone, which hides the Cloudflare setup UI (its API
    returns `404 not_supported`) but keeps the read-only reachability and PKARR checks.
  - `ADMIN_PASSWORD_MANAGED`, which locks `admin_password` edits.
  - `DASHBOARD_PASSWORD`.
  - `PORT` and `HOSTNAME` (default `8080` and `0.0.0.0`).

> **Without `DASHBOARD_PASSWORD` (0.1.30+), the dashboard has no login.** It proxies admin calls
> with `ADMIN_TOKEN`, so anyone who can reach its port has full admin. For standalone, set
> `DASHBOARD_PASSWORD` or put your own auth in front. Never expose it publicly without auth.

> **The disabled-users list never shows.** The dashboard probes admin `GET /users/disabled`, which
> is homeserver [PR #327](https://github.com/pubky/pubky-homeserver/pull/327) (still open). On
> v0.17.1+ that path routes to `GET /users/{pubkey}` with `pubkey = "disabled"` and fails
> (inferred: 400), so the list stays hidden. The released equivalent,
> `GET /users?state=disabled` ([Users](#users)), isn't used by the dashboard. Disabling and
> enabling by pubkey works on every version.

> **Proxy client-identity modes break the API explorer's same-host client calls** (v0.17.1+
> `proxy_protocol`; v0.18.0+ `http_header` unless the header is sent). See
> [Client identity](#client-identity-and-rate-limits).

## Umbrel vs standalone

| | Standalone | Umbrel (community store) |
| :-- | :-- | :-- |
| Homeserver version | any release (v0.18.0 latest) or `main` | **v0.16.1**, app `0.16.1-2` (`<homeserver>-<packaging revision>`) |
| You manage | `config.toml`, Postgres, reverse proxy or tunnel, admin password, metrics, backups (`secret`, data, DB) | one-click install. The bundle has dashboard v0.1.33, `postgres:17-alpine`, config-wrapper `v0.0.6` that renders `config.toml` from env on every start, and optional cloudflared (2026.10.3) tunnel and Preview services |
| Admin password | `[admin].admin_password` | Umbrel's `APP_PASSWORD`, also used for Postgres and the dashboard login (`DASHBOARD_PASSWORD`). `ADMIN_PASSWORD_MANAGED=true` |
| Public exposure | [Deploy publicly](#deploy-publicly) | Cloudflare Tunnel or Preview, from the dashboard |
| Backups | yours | umbrelOS backups (`homeserver.log` excluded) |

To install, add `https://github.com/pubky/umbrel-app-store` under Community App Stores. The
dashboard is served through `app_proxy` on port 8812. The host publishes 6286, 6287 and **6288**;
the admin port is published deliberately so `pubky-cli` can reach it from the LAN. 6289 (metrics)
is not published but is reachable on the container network. Logs are teed to
`/data/homeserver.log`, capped at about 10 MB. Other apps get
`APP_PUBKY_HOMESERVER_{ADMIN,CLIENT,METRICS}_URL` =
`http://pubky-homeserver_homeserver_1:{6288,6286,6289}`.

Umbrel runs v0.16.1, so the **v0.16.2-and-earlier** behaviour in this file applies to it: forwarding
headers for client IP, HEAD on token routes, no `/users` or `/account`, no websites.

> **App 0.16.1-2 is a security update** (dashboard v0.1.33, cloudflared 2026.10.3 for tunnel and
> Preview), safe to install on top of 0.16.1-1. Install it.

> **Moving to the official Umbrel App Store.** The official app (getumbrel/umbrel-apps
> [PR #6223](https://github.com/getumbrel/umbrel-apps/pull/6223), still open as of 2026-10-27)
> stores data differently and **cannot read the community install's users, files or homeserver
> key**. Don't install it on top. To switch, uninstall the community app first, which means a fresh
> homeserver identity and fresh data. Updates still ship from the community store until then.

> **Tunnels:** a Cloudflare tunnel carries only HTTP, so Pubky TLS (6287) needs direct
> connectivity. **Preview** (trycloudflare) is temporary and doesn't pass live `/events` updates,
> so indexers such as Nexus may miss this homeserver's content. Use a permanent domain.

## Security guardrails

- **Change `admin_password`** (default `"admin"`). The admin API is plain HTTP with permissive
  CORS: keep it on loopback or a private network. Metrics have no auth at all. Never run the
  dashboard without `DASHBOARD_PASSWORD` or your own auth in front, and run dashboard v0.1.33+.
- **Back up** `~/.pubky/secret`, the server's identity. **If you lose it, you can't recover it.**
  Also back up user data (`data/files`, not `files-tmp`) and the PostgreSQL database.
- **IP-based limits:** spoofable on v0.16.2 and earlier when clients reach a listener directly; on
  v0.17.1+ in direct mode behind a local proxy, all clients share the proxy's IP and a `127.0.0.1`
  whitelist exempts everyone. Any trusted proxy can claim any client IP
  ([Client identity](#client-identity-and-rate-limits)).
- **Redefining `[[drive.rate_limits]]` drops the defaults**, including the token brute-force limit
  ([config.toml](#configtoml)).
- **Upload size:** through v0.18.0 the 100 MiB body limit is not enforced on streamed uploads
  without `Content-Length`; rely on storage quotas ([Servers and sockets](#servers-and-sockets)).
- **The admin sees everything.** Through WebDAV the admin can read and write all tenant data,
  **including `/priv/`**, and the admin `/events-stream` includes `/priv` events. `/priv` is
  **alpha, not for production, and access-controlled but not encrypted from the operator**
  ([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)). On v0.18.0+, browsers
  may keep private file bodies on disk after sign-out.
- **pubky-docker is for local development only.** It runs a testnet config with `latest` images.
  Never copy its config into production. See [`local-stack.md`](local-stack.md).
- The `/pub` path layout is not stabilized, and the admin and client APIs are pre-1.0.

## Upstream sources of truth

- Install and deploy: [`docs/INSTALL.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/INSTALL.md)
  (still pins the nonexistent 0.17.0),
  [`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md),
  [`docs/WEBSITES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md)
- Config: [`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml),
  [`config.default.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/data_directory/config.default.toml)
- APIs: [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml),
  [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml)
- Releases: [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
  ([v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0),
  [v0.17.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1))
- Dashboard: [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard)
  ([CHANGELOG](https://github.com/pubky/homeserver-dashboard/blob/main/CHANGELOG.md))
- Umbrel: [umbrel-app-store](https://github.com/pubky/umbrel-app-store)
