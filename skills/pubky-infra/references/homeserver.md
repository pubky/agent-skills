# Run a homeserver

Operator reference for Pubky Homeserver: install and run, public deployment, `config.toml`, client
identity and rate limits, PKARR republishing, the admin and metrics servers (signup tokens,
enabling and disabling users, quotas), the dashboard, and Umbrel vs standalone.

Operations only. For the protocol model, see
[the homeserver model](../../pubky/references/concepts.md#the-homeserver-model) ·
[homeserver-write vs Nexus-read](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) ·
[`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

> **Versions (checked 2026-10-26).**
> - **Latest release: v0.16.2** (2026-10-15). Also the crates.io max version and the Docker Hub tag
>   `synonymsoft/homeserver:v0.16.2`. Releases since v0.12.0: v0.13.0 (09-23), v0.14.0 (09-28),
>   v0.15.0 (10-07), v0.16.0 (10-12), v0.16.1 (10-13), v0.16.2 (10-15).
> - **`main` is unreleased.** Its workspace version still says 0.16.2, but its MSRV is
>   `rust-version = 1.91` (1.89 at v0.16.2). At `fd24bf0` it was 24 commits ahead of v0.16.2,
>   adding PROXY-protocol client identity (#643), static websites (#718), HEAD rejection on the
>   token and SSE routes (#738), `quota` in `GET /signup_tokens` (#732), opendal 0.59 (breaking) and
>   the GCS misnamed-object repair (#706). More has landed since (e.g. #735). This file labels these
>   **main only (unreleased)**; upstream docs call this line v0.17.0.
> - **No v0.17.0 tag exists.** Upstream `docs/INSTALL.md` on `main` already says
>   `PUBKY_VERSION=0.17.0`, so its download URL returns 404 and `git checkout v0.17.0` fails. Use
>   0.16.2.
> - The Umbrel community app runs **v0.16.1** ([Umbrel vs standalone](#umbrel-vs-standalone)).
> - `openapi-admin.yml` still says `info.version: 0.9.0` (stale).
>
> Pubky is pre-1.0. Check every API shape below against the linked upstream file.

## Install and run

The binary is **`pubky-homeserver`**; in the Docker image and on Umbrel it is **`homeserver`**. The
CLI has one flag, `--data-dir` / `-d` (default `~/.pubky`), which must come **before** the
subcommand, and one optional subcommand:

- **`init`** (v0.10+): writes `config.toml` and the keypair, then **exits**. It does not start the
  server or touch Postgres.
- **No subcommand**: starts the server, which runs until **SIGINT** (Ctrl+C).

Release binary (substitute 0.16.2 for upstream's unreleased 0.17.0; asset names are the same):

```bash
PUBKY_VERSION=0.16.2  # upstream INSTALL.md says 0.17.0, which is not released yet
PUBKY_PLATFORM=linux-amd64  # or linux-arm64. Alternatively: osx-arm64, osx-amd64, windows-amd64
curl -LO https://github.com/pubky/pubky-homeserver/releases/download/v${PUBKY_VERSION}/pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
tar -xf pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
cp pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}/pubky-homeserver /usr/local/bin  # usually needs sudo
pubky-homeserver --version
```

From source or Docker, then initialise the data dir:

```bash
cargo build --release -p pubky-homeserver   # main needs Rust 1.91+
cp ./target/release/pubky-homeserver /usr/local/bin

# or Docker (the binary inside the image is `homeserver`)
docker build -t pubky-homeserver .
docker run --rm pubky-homeserver homeserver --version

# initialise the data dir (pick one)
pubky-homeserver init
pubky-homeserver --data-dir /path/to/pubky-data init
docker run -it -v ~/.pubky:/root/.pubky pubky-homeserver homeserver init
```

**Prebuilt images:** `synonymsoft/homeserver` on Docker Hub, tagged `v<version>`, by commit SHA,
and `latest`; pubky-docker and Umbrel use them. The binary is `/usr/local/bin/homeserver`. The
v0.16.2 image is built from `rust:1.89.0-alpine3.20` on an `alpine:3.20` runtime; main's
Dockerfile moves to cargo-chef on `rust:1.91.1-alpine3.23` / `alpine:3.23`. The image declares no
`STOPSIGNAL`. **Pin `v0.16.2`, not `latest`,** because `latest` may come to mean a release with
breaking changes.

**Data dir layout:** `config.toml`, `secret` (the server keypair, i.e. the server's identity), file
storage under `data/files`, and the upload staging area `data/files-tmp`.

> **Gotcha: keep `data/files-tmp` and `data/files` on the same filesystem (v0.14.0+).** Uploads are
> staged in `files-tmp` and renamed into `files`. Mount `data/` (or `~/.pubky`) as the volume, never
> `data/files` alone. Don't back up `files-tmp`.

> **Gotcha: set `database_url` with real credentials.** `init` writes the annotated sample with
> **every setting commented out**, so only the embedded defaults apply, and those set
> `database_url = "postgres://localhost:5432/pubky_homeserver"` (no credentials). Unless you override
> it, startup fails with a Postgres connection, auth or "database does not exist" error, not a
> missing-config error. (Upstream INSTALL.md's "works out of the box for local use" is wrong on this.)

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

<sub>The `sed` was run against a real `init`-generated config (GNU sed and BSD `sed -i ''`); the
result parses to `[general] database_url = "postgres://postgres:postgres@…"`.</sub>

Run the server:

```bash
# Docker: host networking, so the container can reach Postgres on the host
docker run -d --name pubky-homeserver --restart unless-stopped --network=host -v ~/.pubky:/root/.pubky pubky-homeserver homeserver

# native, in the foreground
pubky-homeserver

# from source (dev)
cargo run -p pubky-homeserver -- --data-dir ~/.pubky
```

> `--network=host` reaches host Postgres on **Linux Docker Engine** only. Docker Desktop and colima
> on macOS behave differently.

**Stop it with SIGINT, not SIGTERM.** `main.rs` waits only on `tokio::signal::ctrl_c()`. For
systemd, set `KillSignal=SIGINT`:

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
It then starts the user-keys republisher, StorageRepair (main only, GCS), the admin and metrics
servers if enabled, the client server, and last the homeserver key republisher, which makes an
**initial PKARR publish. If that first publish fails, startup aborts.**

**Upgrade notes:**

- v0.13.0 adds the `entry_locks` table (WebDAV locks).
- v0.15.0's migration `m20261002_entry_path_c_collation` rebuilds the entries path index on first
  start. Upstream expects under 5 s; no data changes.

> **GCS storage only: some files return 404.** v0.13.0 through v0.16.1 stored entries whose path
> has a character outside ``A-Za-z0-9 - _ . * ! ' ( ) ~ /`` under a percent-encoded object name
> (`a b` stored as `a%20b`); reads of those entries return 404. v0.16.2 (#687) fixes new writes.
> The repair job for existing objects (#706) is **on main only, not in any release**. It runs at
> startup, moves the misnamed objects, records completion in the migrations table, and logs
> conflicts, which you must repair by hand. A run that fails on an entry retries on the next
> startup.

**Logging:** `[logging] level = "info"`, but the default
`module_levels = ["pubky_homeserver=debug", "tower_http=debug"]` puts the homeserver's own logs and
HTTP traces at **DEBUG**. Set `module_levels` yourself to quiet them (your array replaces the
default). Output is plain-text tracing on stdout, not JSON. For the dashboard's Logs tab, tee stdout
to a file ([homeserver-dashboard](#homeserver-dashboard)).

### Embedding as a library

`HomeserverApp`'s API is the same on `main` as in v0.16.2.

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

<sub>Source: [`pubky-homeserver/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/README.md) (not CI-verified upstream). Verified here: compiles clean under `cargo clippy --all-targets -- -D warnings` with `pubky-homeserver = "=0.16.2"`, `tokio` (full) and `anyhow`; the leading `~/` is expanded. Other entry points: `start_with_persistent_data_dir`, `start`, `start_with_mock_data_dir` (`testing` feature), `client_server()`, `admin_server()` and `metrics_server()` (both `Option`), `public_key()`. On `main`, `lib.rs` also re-exports `ClientIdentityToml`.</sub>

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
Its unauthenticated `GET /info` (not the admin `/info`) returns `features` for SDK feature
discovery:

- v0.16.2: `["path-addressed-storage", "grant-proof-logout", "webdav-locks"]`.
- main only: also `"websites"`, only when `[drive] websites` is enabled.

## Client identity and rate limits

The client IP that IP-keyed rate limits and whitelists see depends on the version:

| | v0.16.2 and earlier (every release) | main only (unreleased, v0.17.0+) |
| :-- | :-- | :-- |
| Client IP source | first parseable `X-Forwarded-For`, then `X-Real-IP`, then the TCP peer | TCP peer, or a PROXY-protocol preface. Forwarding headers are **ignored** |
| Behind Caddy | works through the forwarding headers | all clients **share the proxy's IP limits** unless Caddy sends PROXY protocol |
| Config | `icann_client_identity` is **silently ignored** | `icann_client_identity` / `pubky_client_identity` |

> **Security, released versions:** a client that reaches a listener directly, notably Pubky TLS on
> `0.0.0.0:6287`, can probably set `X-Forwarded-For` and spoof the IP that rate limits and
> whitelists see. The sample whitelists `127.0.0.1` for `POST /session`. Don't rely on IP
> whitelists on v0.16.2 or earlier.

> **main only (inference):** in direct mode behind a local proxy, every request's TCP peer is
> `127.0.0.1`, so a `127.0.0.1` whitelist covers every client. Use `proxy_protocol` mode, or drop
> the whitelist.

main only (unreleased). Configure each listener separately:

```toml
[drive]
icann_client_identity = { mode = "direct" }
pubky_client_identity = { mode = "direct" }
# To use a local PROXY-protocol proxy, replace the ICANN direct line above with:
# icann_client_identity = { mode = "proxy_protocol", trusted_proxies = ["127.0.0.1/32"] }
```

- `proxy_protocol` mode requires a PROXY v1 or v2 preface from a peer in `trusted_proxies`. An
  allowed peer can claim any source IP, so **keep a proxy-mode listener unreachable by other
  clients**. For Pubky TLS, the preface must come before the TLS handshake.
- A proxy-mode listener rejects any connection without a preface and logs
  `Rejected connection during client identification`:
  - A direct request, such as a local `curl http://127.0.0.1:6286` health check or a same-host tool
    like the dashboard's client API explorer, gets its connection closed (empty reply or reset).
  - If Caddy is not sending `proxy_protocol`, Caddy returns **502** to the client.
- The inline table has `deny_unknown_fields`. These fail to parse: `trusted_proxies` without
  `mode`, `mode = "direct"` with `trusted_proxies`, and an empty `trusted_proxies` ("trusted_proxies
  must not be empty").
- **Unknown `[drive]` keys are silently ignored.** A typo such as `icann_client_identitiy` leaves
  direct mode in effect.
- User-keyed limits are unaffected. Cloudflare Tunnel must use direct mode, so its visitors share
  the tunnel's IP limits.
- **Breaking change (#643):** deployments that used forwarding headers for IP limits or allowlists
  must switch to PROXY protocol.

## config.toml

Your `config.toml` is **deep-merged over the embedded `config.default.toml`**, table by table and
key by key. The annotated
[`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
documents every key.

> **Gotcha: arrays replace the defaults, they don't merge (`replace_arrays = true`).** Any array you
> set, such as `[[drive.rate_limits]]`, `dht_relay_nodes` or `module_levels`, **replaces the
> default array entirely**. Defining your own `[[drive.rate_limits]]` **silently drops the default
> `GET /signup_tokens/*` 10r/m per-IP limit**, which slows token brute-forcing. Add it back.

> **Sample ≠ defaults.** The sample shows `[metrics] enabled = true` and a `POST /session` 20r/m
> per-IP limit that whitelists `127.0.0.1`. `init` writes all of it commented out, so **metrics are
> OFF** and only the `/signup_tokens/*` limit applies.

Embedded defaults (on `main`):

- `[general]`: `signup_mode = "token_required"` (or `"open"`),
  `database_url = "postgres://localhost:5432/pubky_homeserver"`. `user_storage_quota_mb = 0` is
  deprecated (`0` means unlimited) and ignored when `[storage].default_quota_mb` is set.
- `[drive]`: `pubky_listen_socket = "127.0.0.1:6287"`, `icann_listen_socket = "127.0.0.1:6286"`,
  the `/signup_tokens/*` rate limit, and on main only `websites = true`, `icann_client_identity`
  and `pubky_client_identity` (both `{ mode = "direct" }`). Rate-limit rules count requests only.
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

## Static websites (main only)

**Unreleased** (#718); see
[`docs/WEBSITES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md).
`[drive] websites = true` is the default on `main`; set `websites = false` to turn it off.

- Host `<user-key>` serves `/pub/website/_/`; Host `<label>.<user-key>` serves
  `/pub/website/<label>/`.
- GET and HEAD only, no range requests. Responses carry `Cache-Control: no-cache` and `nosniff`.
  Unknown user → 404; disabled user → 403.
- Paths whose first segment is `auth`, `events`, `events-stream`, `info`, `priv`, `pub`,
  `session`, `signup`, `signup_tokens` or `storage` stay on the client API.
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

> **Match the proxy config to the version you run.** The upstream Domain and IP-only guides now
> require "Homeserver v0.17.0 or later for PROXY protocol support", and v0.17.0 is unreleased.
> - **v0.16.2 or earlier (every release):** use plain `reverse_proxy 127.0.0.1:6286` with no
>   `transport http { proxy_protocol v2 }` block, and omit `icann_client_identity`. A PROXY
>   preface sent to a pre-0.17 listener would probably break every request (untested).
> - **main / v0.17+:** use the snippets below. Prepare both configs, then restart the homeserver
>   and reload Caddy together; requests fail while the two PROXY settings differ.

**Domain** (main / v0.17+). For IP-only, set `icann_domain = "YOUR_IP"`:

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

**IP-only** (main / v0.17+). Caddy needs `default_sni` (clients send no SNI to a bare IP) and the
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

**Cloudflare Tunnel** (standalone `cloudflared`, any version). The tunnel carries only HTTP, so
`pubky_listen_socket` keeps its default. Set `[pkdns] public_icann_http_port = 443` and
`icann_domain = "YOUR_DOMAIN"`. On v0.17+, keep direct mode:

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

<sub>Checked against the cloudflared 2026.10.4 source (not run): `login` is a valid top-level
alias, and `service install` honours the global `--config`, copying it to
`/etc/cloudflared/config.yml`. `service install` already enables the unit; the `systemctl` lines
are harmless.</sub>

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

<sub>Run against a local testnet: `/info` returned `public_key` and `version`; `resolve` returned
the A record and SVCB priority 1 (port 6287) and 10 (`icann_domain`). With no mode, `resolve` uses
the public DHT and relays; for a testnet, append `relays <relay-url>` (e.g.
`relays http://localhost:15411`). `http-get` needs `--features=reqwest-builder`.</sub>

**Reverse-proxy caching:** preserve upstream `Cache-Control` and `Vary`.

- Private responses are `no-store`.
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
[`docs/REPUBLISHING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/REPUBLISHING.md).

- **HomeserverKeyRepublisher** publishes at startup (a failure aborts the start), then **every
  hour**. All records have TTL 3600: HTTPS/SVCB priority 1 to the Pubky TLS port, priority 10 to
  `icann_domain`, and one A or AAAA record for `public_ip` (by address family).
- **UserKeysRepublisher** waits 60 s after start, then runs every
  `user_keys_republisher_interval` (default 14400 s).
  - `0` disables it.
  - Values under 1800 are **clamped to 1800** with a warning; values under 3600 log a "strongly
    discouraged" warning.
  - It republishes **only users whose `_pubky` HTTPS/SVCB target is this homeserver**. Others are
    `Skipped`, and their data is kept.
- Neither republisher publishes straight from cache. They retry only operational errors, with
  jittered exponential backoff. Outcomes: `Published`, `Skipped`, `Missing`,
  `InvalidSignedPacket`, `Failed`.

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
with the admin password. CORS is `very_permissive`.

| Route | What it does |
| :-- | :-- |
| `GET` / `POST /generate_signup_token` | Mint a token (`POST` takes a `UserQuota` body) |
| `GET /signup_tokens` | List tokens, paginated |
| `GET /info` | Stats and identity |
| `GET /events-stream` | SSE stream of **all** users' events, including `/priv` (alpha) |
| `POST /users/{pubkey}/disable` · `/enable` | Block or unblock writes (see below) |
| `GET` · `PATCH /users/{pubkey}/quota` | Read or override a user's quota (`{effective, overrides}`) |
| `DELETE /webdav/{pubkey}/{path}` | Delete a file; the path **must be under `/pub/`** |
| `/dav/{pubkey}/...` | WebDAV, any root (**Basic** auth) |
| `GET /` | Public |

> **`{pubkey}` must be raw z32** (`publicKey.z32()`). The `pubky<z32>` display form gets a 400
> (`Invalid PublicKey encoding`); an unregistered valid key gets 404. See
> [`concepts.md` § Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

> **HEAD mints tokens on released versions (inferred from the #738 regression test).** On v0.16.2
> and earlier, axum serves HEAD with the GET handler, so an authenticated
> `HEAD /generate_signup_token`, e.g. from an uptime probe, probably mints a token and throws it
> away. Use GET only, and **never point health checks at token or SSE routes**. main only (#738,
> breaking): HEAD returns `405` on admin `/generate_signup_token` (`Allow: GET, POST`), on both
> `/events-stream` routes (`Allow: GET`), and on client `/signup_tokens/{token}`. HEAD on storage
> and websites is unchanged.

`GET /users` and `GET /users/{pubkey}` (#735, merged to `main` 2026-10-26) are **not released**.
`GET /users` is paginated (`state=all|enabled|disabled`, `sort_by=created_at|used_bytes`,
`reverse`, `limit`, `cursor`); items have `pubkey`, `created_at`, `disabled`, `used_bytes` and
`quota {effective, overrides}`. Don't depend on these routes against a release.

### Signup tokens and quotas

Standalone homeservers require tokens by default. Token rules and client-side signup:
[`auth.md` § Signup tokens](../../pubky/references/auth.md#signup-tokens). Gating services such as
Homegate: [`signup-gating.md`](signup-gating.md). Mint a token with default limits (the response
body is the token):

```bash
curl -X GET "http://127.0.0.1:6288/generate_signup_token" \
  -H "X-Admin-Password: admin"   # use your real admin password
```

<sub>Run against a local testnet: HTTP 200 with a plain-text body such as `M9W3-R57N-RHX0`; a wrong
password returns 401.</sub>

- Format `XXXX-XXXX-XXXX`. This and the `UserQuota` / `UserQuotaPatch` semantics have not changed
  since v0.12.0. In a `POST /generate_signup_token` body, each field is absent or `null` (Default),
  `"unlimited"`, or a value. In `PATCH …/quota`, an absent field **keeps the current value** and
  `null` resets it to Default.
- **`GET /signup_tokens`** takes `state=all|used|unused` (default `all`), `limit` and `cursor`.
  `limit` defaults to 100; `0` returns 400; values above 1000 are **silently clamped to 1000**,
  although the spec says max 65535. Response: `{items: [{token, created_at, used_at, used_by}],
  next_cursor}`. main only (#732) adds `quota` per item: the overrides stored on the token, in the
  `UserQuota` shape, omitting fields left at system defaults.

```bash
curl -s "http://127.0.0.1:6288/signup_tokens?state=unused&limit=50" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

<sub>Run against a local testnet: the token minted above was listed with `used_at: null`.</sub>

### Enable and disable users

```bash
curl -X POST "http://127.0.0.1:6288/users/<user-z32>/disable" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

<sub>Checked against `openapi-admin.yml` (200 `Ok`) and probed on a local testnet: unknown user →
404, bad key → 400, no password → 401, GET → 405. Not run against a real user.</sub>

> **Disabling blocks writes; it doesn't lock the account.** PUT and WebDAV `LOCK` are rejected
> with `403 User is disabled`. Sign-in, reads, `DELETE` and `UNLOCK` still work, so the user can
> clean up. main only: website serving also returns 403 for a disabled owner. To remove a user's
> files as the operator, use `DELETE /webdav/...` for `/pub/` paths, or WebDAV `DELETE` on
> `/dav/...` for other paths.

### Admin event stream

`GET /events-stream` (SSE), unchanged since v0.12.0. It includes `/priv` events (alpha, not
encrypted from the operator). `user=<z32>` is repeatable, capped at 50 users. `cursor` is a single
global cursor, not the per-user form. For the client-server stream that Nexus consumes, see
[`nexus-operations.md`](nexus-operations.md).

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
maintainer decision, with the evidence, to be recorded in #529 after the review. Until then, legacy
`/pub` with `pubky-host`, the `pubky-host` header and cookie auth keep working. The `/pub` path
layout is still not stabilized (pre-1.0). Website requests (main only) pick the owner by Host and
are not counted, so a future legacy-Host removal must keep website routing. To get useful data,
scrape metrics now, keep the data for the whole period, and aggregate across instances. See
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

## homeserver-dashboard

[homeserver-dashboard](https://github.com/pubky/homeserver-dashboard) is a Next.js admin UI that
needs Node.js 24+. Latest tag and Docker Hub image: **`synonymsoft/homeserver-dashboard:v0.1.32`**
(2026-10-20); `main` says 0.1.33, which is untagged and unpublished. One route, `/dashboard`. Tabs:

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

<sub>Env names, port and admin URL checked against the dashboard source and Dockerfile (image not
built). To skip the build, run `synonymsoft/homeserver-dashboard:v0.1.32` instead.
`http://homeserver:6288` resolves only on a Docker network with a `homeserver` service.</sub>

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

> **The disabled-users list needs a route that no release has.** The dashboard probes admin
> `GET /users/disabled`, which is homeserver [PR #327](https://github.com/pubky/pubky-homeserver/pull/327)
> (still open); #735's `GET /users/{pubkey}` does not satisfy it. The list shows only if the probe
> succeeds. Disabling and enabling by pubkey works on every version.

> **main only (v0.17+):** with `icann_client_identity` in `proxy_protocol` mode, the API explorer's
> same-host client calls fail ([Client identity](#client-identity-and-rate-limits)).

## Umbrel vs standalone

| | Standalone | Umbrel (community store) |
| :-- | :-- | :-- |
| Homeserver version | any release, or `main` (v0.16.2 latest) | **v0.16.1**, app `0.16.1-1` (`<homeserver>-<packaging revision>`) |
| You manage | `config.toml`, Postgres, reverse proxy or tunnel, admin password, metrics, backups (`secret`, data, DB) | one-click install. The bundle has dashboard v0.1.31, `postgres:17-alpine`, a config-wrapper that renders `config.toml` from env on every start, and optional cloudflared tunnel and Preview services |
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

> **0.16.1-1 is the last update from the Pubky community store.** The app is moving to the official
> Umbrel App Store, which stores data differently and **cannot read this install's users, files or
> homeserver key**. Don't install the official app on top of it. Uninstall first, which means a
> fresh homeserver identity and fresh data. The official submission (getumbrel/umbrel-apps
> PR #6223) was still open on 2026-10-26.

> **Tunnels:** a Cloudflare tunnel carries only HTTP, so Pubky TLS (6287) needs direct
> connectivity. **Preview** (trycloudflare) is temporary and doesn't pass live `/events` updates,
> so indexers such as Nexus may miss this homeserver's content. Use a permanent domain.

## Security guardrails

- **Change `admin_password`** (default `"admin"`). The admin API is plain HTTP with permissive
  CORS: keep it on loopback or a private network. Metrics have no auth at all. Never run the
  dashboard without `DASHBOARD_PASSWORD` or your own auth in front.
- **Back up** `~/.pubky/secret`, the server's identity. **If you lose it, you can't recover it.**
  Also back up user data (`data/files`, not `files-tmp`) and the PostgreSQL database.
- **IP-based limits are spoofable on released versions** when clients reach a listener directly
  ([Client identity](#client-identity-and-rate-limits)).
- **The admin sees everything.** Through WebDAV the admin can read and write all tenant data,
  **including `/priv/`**, and the admin `/events-stream` includes `/priv` events. `/priv` is
  **alpha, not for production, and access-controlled but not encrypted from the operator**
  ([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)).
- **pubky-docker is for local development only.** It runs a testnet config with `latest` images.
  Never copy its config into production. See [`local-stack.md`](local-stack.md).
- The `/pub` path layout is not stabilized, and the admin and client APIs are pre-1.0.

## Upstream sources of truth

- Install and deploy: [`docs/INSTALL.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/INSTALL.md)
  (pins the unreleased 0.17.0),
  [`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md),
  [`docs/WEBSITES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md)
- Config: [`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
- APIs: [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml),
  [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml)
- Releases: [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
- Dashboard: [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard)
- Umbrel: [umbrel-app-store](https://github.com/pubky/umbrel-app-store)
