# Run a homeserver

Operator reference for Pubky Homeserver: install and run, public deployment, `config.toml`, PKARR
republishing, the admin and metrics servers (signup tokens, enable/disable users, quotas), the
dashboard, and Umbrel vs standalone.

Operations only. For the protocol model, link to the canonical files and don't restate them:
[the homeserver model](../../pubky/references/concepts.md#the-homeserver-model) ·
[homeserver-write vs Nexus-read](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) ·
[`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

> **Versions.** Standalone `main` is workspace version **0.12.0** (`rust-version = 1.89`). Recent
> tags: v0.12.0 (2026-09-14), v0.11.0, v0.10.0, v0.9.3. The **Umbrel app still runs v0.9.1**
> (see [Umbrel vs standalone](#umbrel-vs-standalone)). `openapi-admin.yml` still says
> `info.version: 0.9.0`, which is stale. Pubky is pre-1.0: check every API shape below against the
> linked upstream file.

## Install and run

The binary is **`pubky-homeserver`**. In the project's Docker image (and on Umbrel) it is
installed as **`homeserver`**. CLI: one flag, `--data-dir` / `-d` (default `~/.pubky`, must not be
an existing file), and one optional subcommand:

- **`init`** (v0.10+): creates the data dir, writes `config.toml` and the keypair if missing, then
  **exits** without starting the server or touching Postgres. On v0.9 and earlier, the first run
  creates these files and then fails without Postgres.
- **No subcommand**: starts the server; runs until **SIGINT** (Ctrl+C).

Install a release binary (upstream
[`INSTALL.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/INSTALL.md) still pins
0.11.0; v0.12.0 assets use the same names, and the tarball also contains `homeservercli`):

```bash
PUBKY_VERSION=0.12.0
PUBKY_PLATFORM=linux-amd64  # or linux-arm64, osx-arm64, osx-amd64, windows-amd64
curl -LO https://github.com/pubky/pubky-homeserver/releases/download/v${PUBKY_VERSION}/pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
tar -xf pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}.tar.gz
cp pubky-homeserver-v${PUBKY_VERSION}-${PUBKY_PLATFORM}/pubky-homeserver /usr/local/bin  # usually needs sudo
pubky-homeserver --version
```

Or build from source / Docker, then initialise the data dir:

```bash
cargo build --release -p pubky-homeserver
cp ./target/release/pubky-homeserver /usr/local/bin

# or Docker (the binary inside the image is `homeserver`)
docker build -t pubky-homeserver .
docker run --rm pubky-homeserver homeserver --version

# initialise the data dir (pick one)
pubky-homeserver init
pubky-homeserver --data-dir /path/to/pubky-data init
docker run -it -v ~/.pubky:/root/.pubky pubky-homeserver homeserver init
```

**Data dir layout:** `config.toml`, `secret` (the server keypair, i.e. its identity), and file
storage under `data/files` by default.

> **Gotcha: set `database_url` with real credentials.** `init` writes the annotated sample with
> **every setting commented out**, so only the embedded `config.default.toml` applies. That default
> always supplies `database_url = "postgres://localhost:5432/pubky_homeserver"` (no credentials).
> If you don't override `[general].database_url`, startup fails with a **Postgres connection / auth
> / "database does not exist" error**, not a missing-config error.

**PostgreSQL is required.** The homeserver runs its own migrations but **does not create the
database**; create an empty one first:

```bash
docker run --name pubky-postgres \
  --restart unless-stopped \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=pubky_homeserver \
  -p 127.0.0.1:5432:5432 \
  -v postgres-data:/var/lib/postgresql \
  -d postgres:18

# Uncomment [general] and set database_url in ~/.pubky/config.toml (GNU sed syntax)
sed -i 's|^# \[general\]|[general]|; s|^# database_url = .*|database_url = "postgres://postgres:postgres@localhost:5432/pubky_homeserver"|' ~/.pubky/config.toml
```

Run it:

```bash
# Docker: host networking so the container can reach Postgres on the host
docker run -d --name pubky-homeserver --restart unless-stopped --network=host -v ~/.pubky:/root/.pubky pubky-homeserver homeserver

# native, in the foreground
pubky-homeserver

# from source (dev)
cargo run -p pubky-homeserver -- --data-dir ~/.pubky
```

For systemd, **set `KillSignal=SIGINT`**. The server waits on `tokio::signal::ctrl_c`, not SIGTERM,
so the default stop signal does not shut it down cleanly:

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

**Startup order:** user-keys republisher → admin server (if enabled) → metrics server (if enabled)
→ client server → homeserver key republisher, which does an **initial PKARR publish. If that first
DHT publish fails, startup fails.**

**Logging:** stdout only, filtered by `[logging].level` / `module_levels`; a `RUST_LOG` env filter
overrides the config. No built-in log file.

### Embedding as a library

Matches the real `pubky-homeserver` 0.12.0 API (compiles cleanly under clippy against the crates.io
release). A leading `~/` in the data-dir path is expanded.

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

<sub>Source: [`pubky-homeserver/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/README.md) (not CI-verified upstream). Other `HomeserverApp` entry points: `start_with_persistent_data_dir`, `start(AppContext)`, `start_with_mock_data_dir` (`testing` feature), `client_server()`, `admin_server()` / `metrics_server()` (both `Option`), `public_key()`.</sub>

## Servers and sockets

All defaults bind to loopback.

| Server | Default socket | On by default | Expose publicly? |
| :-- | :-- | :-- | :-- |
| Client, ICANN HTTP | `127.0.0.1:6286` | yes | **No.** Put a reverse proxy or tunnel in front |
| Client, Pubky TLS | `127.0.0.1:6287` | yes | **Yes.** Set `0.0.0.0:6287` for direct access |
| Admin | `127.0.0.1:6288` | yes (`[admin] enabled = true`) | **Never** |
| Metrics (`/metrics`, no auth) | `127.0.0.1:6289` | **no** (`[metrics] enabled = false`) | **Never** |

> The annotated `config.sample.toml` shows `[metrics] enabled = true`, but `init` comments it out.
> The **effective default is metrics OFF**.

The client server hosts tenant storage, auth, and event feeds (spec:
[`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml)).
Its unauthenticated `GET /info` returns `{"features": ["path-addressed-storage"]}` for SDK feature
discovery. This is **not** the admin `GET /info`.

## config.toml

Your `config.toml` is **deep-merged over the embedded `config.default.toml`**, table by table, key
by key. Read the annotated
[`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
for every key.

> **Gotcha: arrays replace, they don't merge (`replace_arrays = true`).** Any array you set
> (`[[drive.rate_limits]]`, `dht_relay_nodes`, `module_levels`, ...) **replaces the default array
> entirely**. Defining your own `[[drive.rate_limits]]` **silently drops the default
> `GET /signup_tokens/*` 10r/m per-IP limit** that slows token brute-forcing; add it back. A value
> whose type doesn't match the default fails with `Incompatible types at path ...`.

Embedded defaults and what they mean:

- `[general]`: `signup_mode = "token_required"` (or `"open"`);
  `database_url = "postgres://localhost:5432/pubky_homeserver"` (database must already exist; see
  the credentials gotcha above). `user_storage_quota_mb` is deprecated (`0` = unlimited), migrated
  into `[storage].default_quota_mb` only when that key is unset.
- `[drive]`: `pubky_listen_socket`, `icann_listen_socket`, `[[drive.rate_limits]]` (`path` glob,
  `method`, `quota` as `"<n>r/s"` / `"<n>r/m"`, `key = "ip" | "user"`, optional `burst`,
  `whitelist`). **Request-count quotas only**; put bandwidth limits in `[default_quotas]`. The
  sample (not the defaults) enables `POST /session` 20r/m per IP with `127.0.0.1` whitelisted, and
  leaves the `/signup_tokens/*` rule commented out.
- `[default_quotas]`: `rate_read`, `rate_write`, `unauthenticated_ip_rate_read` (sample: `10mb/s` /
  `5mb/s` / `1mb/s`). Apply when a user's quota is `Default`.
- `[storage]`: `type = "file_system"` (default) or `"google_bucket"` (`bucket_name` + `credential`;
  **bucket must already exist**; Cargo default feature `storage-gcs`). `"in_memory"` **only parses
  in builds with the `storage-memory` (or `testing`) feature**; release/default builds reject it.
  `default_quota_mb`: **absent = unlimited, `0` = zero storage**.
- `[admin]`: `enabled`, `listen_socket`, `admin_password = "admin"` (**change it**).
- `[metrics]`: `enabled`, `listen_socket`.
- `[pkdns]`: `public_ip` (default `127.0.0.1`), `public_pubky_tls_port`, `public_icann_http_port`,
  `icann_domain` (default `localhost`), `user_keys_republisher_interval = 14400`,
  `dht_bootstrap_nodes`, `dht_relay_nodes` (default `https://pkarr.pubky.app`,
  `https://pkarr.pubky.org`), `dht_request_timeout_ms` (2000).
- `[logging]`: `level = "info"`, `module_levels = ["pubky_homeserver=debug", "tower_http=debug"]`.

**No built-in ICANN TLS.** Run a reverse proxy and manage certificates yourself.

## Deploy publicly

Pick a guide from [`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md):

| Guide | Needs | Pubky TLS (6287) | Certs |
| :-- | :-- | :-- | :-- |
| [Domain](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/domain.md) (recommended for production) | static IP + domain; open 80/443/6287 | yes | Caddy, 90-day |
| [IP-only](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/ip-only.md) | static IP; open 80/443/6287; Caddy v2.10.1+ | yes | Caddy `shortlived` profile, ~6 days |
| [Cloudflare Tunnel](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/cloudflare-tunnel.md) | domain on Cloudflare; no static IP or open ports | **no** | Cloudflare |

Pubky TLS (6287) needs no CA: clients resolve the server key on the DHT. HTTPS (443) is what
browsers and the browser SDK need.

> **Rules for every deployment.** Bind **only** `pubky_listen_socket` to `0.0.0.0:6287`. Never set
> `0.0.0.0` on `icann_listen_socket`, `admin.listen_socket`, or `metrics.listen_socket`; never
> expose 6286, 6288, or 6289 to the internet. Use a **static (reserved) IP**: the PKARR record
> embeds `public_ip` and **silently breaks if the IP changes**.

**Domain.** The Caddyfile host must exactly match both the DNS A record and `icann_domain`:

```toml
# ~/.pubky/config.toml
[drive]
pubky_listen_socket = "0.0.0.0:6287"

[pkdns]
public_ip = "YOUR_IP"
icann_domain = "YOUR_DOMAIN"
```

```caddyfile
# /etc/caddy/Caddyfile
your_domain.com {
    reverse_proxy 127.0.0.1:6286
}
```

**IP-only.** Set `icann_domain = "YOUR_IP"` (same `[drive]` / `public_ip` as above). Caddy needs
`default_sni` (clients send no SNI to a bare IP) and the `shortlived` ACME profile (without it:
`rejectedIdentifier`):

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
    reverse_proxy 127.0.0.1:6286
}
```

**Cloudflare Tunnel (standalone `cloudflared`).** Only HTTP is tunneled, so `pubky_listen_socket`
can stay at its default. Advertise port 443:

```bash
cloudflared login
cloudflared tunnel create pubky-homeserver
cloudflared tunnel route dns pubky-homeserver YOUR_DOMAIN
# write ~/.cloudflared/config.yml and ~/.pubky/config.toml (below), then install as a service.
# Pass --config explicitly: sudo changes HOME.
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

```toml
# ~/.pubky/config.toml
[pkdns]
public_icann_http_port = 443
icann_domain = "YOUR_DOMAIN"
```

**Post-setup checks** (from
[`post-setup.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/post-setup.md);
the first two steps were run against a local testnet, the third needs a public server):

```bash
# On the server: get the homeserver public key (use your admin password)
curl -s "http://127.0.0.1:6288/info" -H "X-Admin-Password: admin"

# In a pkarr clone: expect an A record with public_ip plus HTTPS/SVCB records
cargo run --example resolve <homeserver-public-key>

# From ANOTHER machine, in a pkarr clone (skip for Cloudflare Tunnel): prints "Pubky Homeserver"
cargo run --features=reqwest-builder --example http-get https://<homeserver-public-key>
```

You can also check the record on pkdns.net. After changing `icann_domain` or `public_ip`, restart
and wait a few minutes for the DHT. If Pubky TLS times out, check the firewall and that the server
listens on `0.0.0.0:6287`.

**Reverse-proxy caching.** Preserve upstream `Cache-Control` and `Vary`. Private responses are
`no-store`. `/storage/{user_z32}/priv/...` varies on `Authorization` and `Cookie`; the deprecated
`/priv/...` and `/events-stream` also vary on `pubky-host`. (`/priv` is **alpha, not for
production, not encrypted from the operator**; see
[`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).)
`/storage/{user_z32}/pub/...` is cacheable and does not vary on `pubky-host`; the deprecated
`/pub/...` still does.

## PKARR republishing

How clients resolve these records:
[`concepts.md` § PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution).
The homeserver's own packet (all TTL 3600):

- HTTPS/SVCB, priority 1, target `.`, port `public_pubky_tls_port` (or the bound TLS port), IP
  hints `public_ip`.
- If `icann_domain` is set: HTTPS/SVCB, priority 10, targeting that domain;
  `public_icann_http_port` defaults to the bound ICANN port.
- A/AAAA for `public_ip`.

Two background jobs:

- **HomeserverKeyRepublisher**: publishes the server's packet at startup (failure aborts start),
  then **every hour**; later failures are only logged.
- **UserKeysRepublisher**: republishes user packets every `user_keys_republisher_interval` seconds
  after a 60 s delay. Default 14400 (4 h); `0` disables; values under 1800 are **clamped to 1800**
  with a warning.

Each attempt reads cache then network and picks the newest valid packet; it never publishes
straight from cache. The user republisher **only republishes users whose `_pubky` record points at
this homeserver**; others are `Skipped` and their stored data is **not** removed. Only operational
errors are retried, with jittered backoff. Full algorithm:
[`docs/REPUBLISHING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/REPUBLISHING.md).

> **Relay gotcha: relays stay on unless you override `dht_relay_nodes`.** The embedded default
> always supplies `dht_relay_nodes` (`pkarr.pubky.app`, `pkarr.pubky.org`), so setting only
> custom/testnet `dht_bootstrap_nodes` still leaves the **mainnet** relays enabled. If you point
> `dht_bootstrap_nodes` at a testnet, also set `dht_relay_nodes` to matching relays. (The sample's
> "If not set and no bootstrap nodes are set..." comment is misleading for the binary.) DHT and
> relay operation: [`dns-and-relays.md`](dns-and-relays.md#republishing).

## Admin API (:6288)

Spec:
[`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml);
link to it rather than hardcoding response shapes. CLI wrappers such as `homeservercli` (password
from flag, then `PUBKY_HOMESERVER_ADMIN_PASSWORD`, then `config.toml`) are in
[`operator-cli.md`](operator-cli.md).

**Auth:** send **`X-Admin-Password`**, exactly matching `[admin].admin_password`. Missing →
`401 Missing admin password`; wrong → `401 Invalid admin password`. **`/dav{*path}` differs:** it
sits outside that layer and uses **HTTP Basic auth, username `admin`, password = admin password**.
CORS is `very_permissive`.

| Route | Does |
| :-- | :-- |
| `GET /generate_signup_token` | Mint a token with default limits (text body = token) |
| `POST /generate_signup_token` | Mint a token with a `UserQuota` JSON body |
| `GET /signup_tokens` | List tokens, paginated |
| `GET /info` | Stats + identity |
| `GET /events-stream` | SSE stream of **all** users' events, including `/priv` (alpha, not for production) |
| `POST /users/{pubkey}/disable` · `/enable` | Block / unblock writes |
| `GET` · `PATCH /users/{pubkey}/quota` | Read / override per-user quota |
| `DELETE /webdav/{pubkey}/{path}` | Delete a file; **path must be under `/pub/`** (`204`; `400` bad key or non-`/pub/` path, `404` missing) |
| `ANY /dav/{pubkey}/...` | WebDAV, any root (**Basic** auth) |
| `GET /` | Public: `Homeserver - Admin Endpoint` |

`GET /info` returns `num_users`, `num_disabled_users`, `total_disk_used_mb`, `num_signup_codes`,
`num_unused_signup_codes`, `public_key` (z32), `pkarr_pubky_address` and `pkarr_icann_domain`
(nullable), and `version`.

> **`{pubkey}` is raw z32** (`publicKey.z32()`), **not** the `pubky<z32>` display form, which gets
> ``400 Invalid URL: unexpected `pubky` prefix; expected raw z32``. See
> [`concepts.md` § Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

### Signup tokens and quotas

Standalone homeservers require tokens by default (`signup_mode = "token_required"`). Client-side
signup with a token: [`auth.md` § Signup tokens](../../pubky/references/auth.md#signup-tokens).
Mint one:

```bash
curl -X GET "http://127.0.0.1:6288/generate_signup_token" \
  -H "X-Admin-Password: admin"   # use your real admin password
```

- **Format:** `XXXX-XXXX-XXXX` (14 chars): 7 random bytes, Crockford base32, uppercase, hyphenated.
  Valid = 14 chars and Crockford-decodable with hyphens removed.
- **`POST /generate_signup_token`** takes a `UserQuota` body (invalid → `422`). Per field: absent
  or `null` = Default, `"unlimited"` = no limit, value = explicit limit. Fields:
  `storage_quota_mb`; `rate_read`, `rate_write` (e.g. `"200mb/m"`); `rate_read_burst`,
  `rate_write_burst` (integer ≥ 1; absent = burst equals rate); `allowed_write_paths` (absent =
  unrestricted, `[]` = read-only, `["/pub/tokens/"]` = only those prefixes or exact files; `/` and
  duplicates rejected).
- **`GET /signup_tokens`**: `state=all|used|unused` (default `all`), `limit` (default 100, max
  1000, `0` → `400`), `cursor` (previous page's `next_cursor`). Response
  `{items: [{token, created_at, used_at, used_by}], next_cursor}`. Read-only; run as written
  against a local testnet:

```bash
curl -s "http://127.0.0.1:6288/signup_tokens?state=unused&limit=50" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

- **Client-server check:** `GET /signup_tokens/{token}` returns `{status: valid|used, created_at}`;
  `404 Token not found`, `400` bad format, `400 Signup tokens not required` in open mode. Protected
  by the default 10r/m per-IP limit (see the arrays gotcha under [config.toml](#configtoml)).
- **Per-user quota:** `GET /users/{pubkey}/quota` returns `{effective, overrides}` (`effective` =
  every field merged with defaults; `overrides` = only customizations). `PATCH` takes a
  `UserQuotaPatch`, where field semantics differ:

| Field in body | `POST /generate_signup_token` (`UserQuota`) | `PATCH …/quota` (`UserQuotaPatch`) |
| :-- | :-- | :-- |
| absent | Default | **keep current** |
| `null` | Default | reset to Default (`allowed_write_paths`: unrestricted) |
| `"unlimited"` / value | no limit / explicit | no limit / explicit |

PATCH errors: `400` invalid pubkey, `404` unknown user, `422` invalid quota. Homegate mints tokens
through this same API; see [`signup-gating.md`](signup-gating.md).

### Enable and disable users

`POST /users/{pubkey}/disable` and `/enable` return `200 Ok`, `400` for non-z32 keys, `404` for an
unknown user.

```bash
curl -X POST "http://127.0.0.1:6288/users/<user-z32>/disable" \
  -H "X-Admin-Password: $ADMIN_PASSWORD"
```

> **Disabling blocks writes; it does not lock the account.** A disabled user can still **sign in,
> read (`GET 200`), and DELETE their own files (`204`)**. Only PUT is rejected
> (`403 User is disabled`). To remove a user's files as operator, use `DELETE /webdav/...` for
> `/pub/` paths, or a WebDAV `DELETE` on `/dav/...` (Basic auth) for other roots.

### Admin event stream

`GET /events-stream` (SSE, `no-store`, v0.10+). Includes `/priv` events (alpha, not for
production, not encrypted from the operator). Query parameters:

- `user=<z32>`: repeatable; omit for all users. More than 50 → `400`; `pubky`-prefixed key →
  `400`; unknown user → `404`.
- `cursor=`: one global cursor, **not** the per-user `user=pk:cursor` form.
- `limit`: `0` → `400`.
- `reverse` and `live` (`true` or `1`): both together → `400`.
- `path=`: repeatable. Trailing `/` = directory prefix; otherwise exact file match.

Each event is `event: PUT|DEL` with data lines `pubky://user/path` and `cursor: N`; **only PUT
events** add `content_hash: <base64>`. Slow live clients are disconnected. The 50-user cap
(`MAX_EVENT_STREAM_USERS`) also applies to the client-server stream Nexus consumes; see
[`nexus-operations.md`](nexus-operations.md).

## Metrics (:6289)

Off by default; enable with `[metrics] enabled = true`. One route, `GET /metrics` (Prometheus
text), **no authentication**: keep it on a private network. Instruments (from `observability.rs`):
`events_db_query_duration_ms`, `event_stream_db_query_duration_ms`,
`event_stream_broadcast_lagged_count`, `event_stream_broadcast_half_full_count`,
`event_stream_active_connections`, `event_stream_connection_duration_ms`, `signup_count`,
`storage_request_count`.

> **Query the exposed names, not the instrument names.** Prometheus exposition adds suffixes:
> counters get `_total` (e.g. `storage_request_count_total`), histograms appear as `*_count`,
> `*_sum`, `*_bucket`. Querying bare `storage_request_count` returns nothing.

**Storage-addressing migration metric (v0.12.0).** `storage_request_count_total` counts each tenant
storage request once. Labels: `addressing_mode` (`path` = `/storage/{user-z32}/pub/...`, `legacy` =
`/pub/...` plus `pubky-host`), `pubky_host_header` (`absent|matching|other`), `pubky_host_query`
(`true|false`), `auth_method` (`none|cookie|grant`). At most 36 label combinations; no keys,
tokens, or paths in labels.

Legacy addressing, `pubky-host`, and cookie auth all still work. Upstream's removal policy requires
at least one year after the first stable path-addressing SDK plus an explicit review. The SDKs
(`pubky` / `@synonymdev/pubky` 0.12.0) already build `/storage/<owner>/...` URLs, but the upstream
migration table has **not yet declared a qualifying release**, so the clock start is undeclared.
Both the path layout and this policy are pre-1.0 and may change (the `/pub` layout is not
stabilized). To have your data count:

- Enable and scrape metrics **now**.
- Retain the data for the whole migration period.
- Aggregate across all instances; counters reset on restart.

```promql
sum by (addressing_mode) (increase(storage_request_count_total[30d]))
sum by (addressing_mode, pubky_host_header, pubky_host_query) (increase(storage_request_count_total{pubky_host_header!="absent"}[30d]))
sum by (addressing_mode) (increase(storage_request_count_total{pubky_host_query="true"}[30d]))
sum by (auth_method) (increase(storage_request_count_total[30d]))
```

Detail and current status:
[`STORAGE_ADDRESSING_MIGRATION.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md).

## homeserver-dashboard

[homeserver-dashboard](https://github.com/pubky/homeserver-dashboard) v0.1.27: Next.js admin UI
(Node 24+) served at `/dashboard` on port 8080. Tabs:

- **Overview**: `GET /info`.
- **Users**: disable / enable users.
- **Invites**: mints a token, shows a QR code.
- **Files**: WebDAV (Basic auth) plus delete by path.
- **Logs**: needs `HOMESERVER_LOG_PATH`; without it `/api/logs` returns `503`.
- **Settings**: **Config** edits the real `config.toml` (secrets redacted, atomic writes, falls
  back to read-only); **Cloudflare** configures a tunnel.

Since v0.1.26 the **API explorer tab is hidden** unless built with
`NEXT_PUBLIC_API_EXPLORER=true`, though the README still lists it.

```bash
docker build -t homeserver-dashboard .

docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  homeserver-dashboard
```

All env vars are **server-only** (no `NEXT_PUBLIC_` prefix), so credentials never reach the
browser. `http://homeserver:6288` only resolves on a Docker network with a `homeserver` service:
use the compose **service name**, not `localhost`.

- **Required:** `ADMIN_BASE_URL`, `ADMIN_TOKEN`.
- **Optional (defaults):** `CLIENT_BASE_URL` (`http://homeserver:6286`), `METRICS_BASE_URL`
  (`http://homeserver:6289`), `HOMESERVER_CONFIG_PATH` (`/app/homeserver-data/config.toml`),
  `HOMESERVER_LOG_PATH` (unset), `PREVIEW_INSTANT_ORIGIN` (`http://homeserver:6286`),
  `CLOUDFLARE_CONFIG_DIR`, `CLOUDFLARED_BIN`, `CLOUDFLARED_RUNTIME_DIR`, `ADMIN_PASSWORD_MANAGED`
  (`true` locks `admin_password` edits), `PLATFORM` (`umbrel`, or unset for standalone),
  `PORT` / `HOSTNAME` (`8080` / `0.0.0.0`).

> **Users tab vs a stock homeserver.** The dashboard calls admin `GET /users/disabled`, which is
> **not in any merged or released pubky-homeserver version** (proposed in open
> [PR #327](https://github.com/pubky/pubky-homeserver/pull/327)). Against a stock homeserver the
> disabled-users list is unavailable. The per-user `disable` / `enable` routes exist; call them
> directly or via [`operator-cli.md`](operator-cli.md).

> **Invite links use `pubkyauth://direct_signup`** (v0.1.27), not the relayed `pubkyauth://signup`
> cookie flow, so they need a Pubky Ring build that understands `direct_signup`. The dashboard
> detects completed signup by polling token stats, not per-token status. Auth flows:
> [`auth.md`](../../pubky/references/auth.md).

## Umbrel vs standalone

| | Standalone | Umbrel |
| :-- | :-- | :-- |
| Homeserver version | 0.12.0 (`main`) | **v0.9.1** (`synonymsoft/homeserver` pinned at commit `f90548c7`) |
| Missing on this version (among others) | — | admin `/events-stream`, `GET /signup_tokens`, `init`, grant auth, `/priv` (alpha anyway), path-addressed `/storage/{user}/` routes and client `GET /info` (v0.11), `storage_request_count` metric (v0.12) |
| Dashboard `PLATFORM` | unset: Cloudflare setup UI and `/cloudflare-guide` hidden (setup routes return `404 not_supported`); read-only reachability and PKARR checks remain | `umbrel`: Cloudflare setup flows, umbrelOS backup guidance, "restart from Umbrel" copy |
| Admin password | you set `[admin].admin_password` | Umbrel's `APP_PASSWORD`, shared by homeserver, dashboard `ADMIN_TOKEN`, and Postgres; `ADMIN_PASSWORD_MANAGED=true` |
| Public exposure | your own reverse proxy or tunnel ([Deploy publicly](#deploy-publicly)) | Dashboard Settings → Cloudflare: Connect account (recommended), API token, Preview, or Manual |

**Install on Umbrel:** add community store `https://github.com/pubky/umbrel-app-store`, install
**Pubky Homeserver**. Manifest id `pubky-homeserver`, version `0.9.1-18`
(`<homeserver>-<packaging revision>`), port 8812. No credentials modal; reveal the password in
Settings with the eye icon.

Compose services:

- `app_proxy`
- `postgres` (`postgres:17-alpine`)
- `homeserver-config-wrapper`: one-shot, renders `/data/config.toml`
- `homeserver`: publishes 6286, 6287, and **6288** on the Umbrel host; **6289 is not published**
- `web`: dashboard `v0.1.27`, `PORT=8812`
- `cloudflared` (persistent)
- `cloudflared-preview`

The Umbrel README still mentions three cloudflared services; trust the compose file (two). The
homeserver runs as PID 1 with stdout tee'd (via a FIFO set up earlier in the entrypoint) to
`/data/homeserver.log` for the Logs tab, rotated from ~10 MB down to ~2 MB:

```bash
exec homeserver --data-dir /data > /tmp/log-fifo 2>&1
```

`exports.sh` gives other Umbrel apps `APP_PUBKY_HOMESERVER_ADMIN_URL` (`:6288`), `..._CLIENT_URL`
(`:6286`), and `..._METRICS_URL` (`:6289`), all at `pubky-homeserver_homeserver_1` on the container
network. **The admin token is not exported**; other apps must obtain it separately.

> **Tunnels on Umbrel.** Any Cloudflare tunnel carries only HTTP (6286); Pubky TLS (6287) needs
> direct connectivity. **Preview mode** (`trycloudflare.com` quick tunnel) has an address that can
> change on restart and **does not pass live `/events` updates, so indexers such as Nexus may miss
> this homeserver's content.** Use a permanent Cloudflare domain.

## Security guardrails

- **Change `admin_password`** (default `"admin"`). The admin API is plain HTTP with permissive CORS;
  keep it on loopback or a private network. Metrics has no auth at all.
- **Back up** `~/.pubky/secret` (the homeserver identity: **lose it and the server cannot be
  recovered**), user data (`data/files` by default, per `storage.type`), and the PostgreSQL
  database.
- **The admin sees everything.** Via WebDAV an admin can read and write all tenant data,
  **including `/priv/`**, and the admin `/events-stream` includes `/priv` events. `/priv` is
  **alpha (v0.10.0+), not for production, access-controlled but not encrypted from the operator**.
  Never tell users it is private from you. Status:
  [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
- **`pubky-docker` is local development only.** It uses the testnet image with
  `signup_mode = "open"` and binds admin to `0.0.0.0:6288` with password `admin`. Never copy that
  config. See [`local-stack.md`](local-stack.md).
- **The `/pub` path layout is not stabilized**; the admin and client APIs are pre-1.0.

## Upstream sources of truth

- Install / deploy: [`docs/INSTALL.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/INSTALL.md),
  [`docs/DEPLOY.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEPLOY.md)
- Config: [`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
- APIs: [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml),
  [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml)
- Release notes: [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
- Dashboard: [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard) ·
  Umbrel: [umbrel-app-store](https://github.com/pubky/umbrel-app-store)
