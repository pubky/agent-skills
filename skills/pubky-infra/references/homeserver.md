# Run a homeserver

Operating a homeserver: how to launch it, the HTTP servers it exposes, `config.toml`, the admin
API (signup tokens, user enable/disable, quotas), the dashboard, public exposure via Cloudflare
Tunnel, and Umbrel vs standalone.

## What a homeserver is

For the protocol model — the per-public-key backend, PKARR discovery, the `/pub` tree, the
PostgreSQL-metadata-vs-filesystem split, and **homeserver-write vs Nexus-read** — read the
canonical [`concepts.md`](../../pubky/references/concepts.md#the-homeserver-model) and
[`concepts.md` write/read split](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).
This file is operations only — don't re-derive the model here.

> Versions below are from the `0.9.0` homeserver workspace (`[workspace.package] version`; the
> homeserver crate inherits via `version.workspace = true`, and the OpenAPI `info.version` is also
> `0.9.0`; `rust-version = 1.89`). Pubky is **pre-1.0**; treat any version-pinned or API-shape
> claim as drift-prone and confirm against the linked upstream source. (The Umbrel app is packaged
> at `0.9.1-<n>` — see [below](#umbrel-vs-standalone).)

## Run it

The binary takes `--data-dir` / `-d` (default `~/.pubky`, validated as a directory) plus an
optional `init` **subcommand**. With **no subcommand** it loads `config.toml` from the data dir,
inits tracing, and **starts the server**. `homeserver init` (or `homeserver --data-dir <dir>
init`) **initializes the data dir** (writes `config` + keypair) and **exits without starting**.

```bash
cargo run -- --data-dir=~/.pubky
```

[`main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/main.rs) is the
authoritative entrypoint and the only place to trust for CLI/startup:

```rust
#[derive(Parser, Debug)]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    /// Path to data directory. Defaults to ~/.pubky
    #[clap(short, long, default_value_os_t = default_config_dir_path(), value_parser = validate_config_dir_path)]
    data_dir: PathBuf,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Initialize the data directory (config and keypair) without starting the server.
    Init,
}
```

> The homeserver **README's library examples** are stale: they call `HomeserverApp::run_with_data_dir_path`,
> `server.core()`, `server.admin()`, `HomeserverCore::from_data_dir_path`, `DataDirMock` — none of
> which match `main.rs` (real surface: `HomeserverApp::start_with_persistent_data_dir_path`,
> `server.client_server()`, `server.admin_server()`, `server.metrics_server()`). **Do not copy the
> README examples verbatim** — trust `main.rs`.

Three ways to deploy:

- **From source / single binary** — `cargo run` (above), or run the built `homeserver` binary.
- **Local dev stack** — `pubky-docker` compose brings up homeserver + Nexus + frontends in one
  command. It is **local development / experimentation only, not production hosting** — see the
  guardrail below and [`local-stack.md`](local-stack.md).
- **Self-host (production)** — the [Umbrel app](#umbrel-vs-standalone), or a hand-rolled hardened
  deployment (reverse proxy + TLS + isolated metrics).

A **PostgreSQL** database is required and **must be created manually** (the `[general]` sample
comment: *"Important: The database must be created manually."*) — the binary applies its bundled
migrations but will not create the database. Default `[general].database_url` is
`postgres://localhost:5432/pubky_homeserver`.

## Three servers, four sockets

The homeserver runs **three independent HTTP servers**; the client (drive) server binds **two**
sockets (Pubky-TLS + ICANN HTTP), admin and metrics one each. Defaults are all loopback. The
client (`6286`/`6287`) and admin (`6288`) sockets are asserted in `test_default_config`; the
metrics default (`6289`) comes from `config.default.toml`.

| Server | Default socket | Runs by default? | Purpose |
| :-- | :-- | :-- | :-- |
| Client — ICANN HTTP | `127.0.0.1:6286` | yes | tenant file API, cleartext (behind your reverse proxy) |
| Client — Pubky-TLS | `127.0.0.1:6287` | yes | tenant file API over Pubky-TLS (raw public keys) |
| Admin | `127.0.0.1:6288` | yes (`[admin] enabled = true`) | operator API (tokens, users, quotas, WebDAV) |
| Metrics | `127.0.0.1:6289` | **no** (`[metrics] enabled = false`) | Prometheus `/metrics`, **unauthenticated** |

> **Metrics is disabled by default.** The embedded runtime default (`config.default.toml`, loaded
> via `include_str!` and used by `ConfigToml::default()`) has `[metrics] enabled = false`; only the
> annotated `config.sample.toml` ships `[metrics] enabled = true`. Admin is enabled by default in
> both. So out of the box you get three running listeners unless you copy the sample (or set
> `[metrics] enabled = true` yourself).

The **client** servers host the tenant file API (`/pub` `PUT`/`GET`/`DELETE`) and the **event
streams**; the **admin** and **metrics** servers are operator-only and should stay off the public
internet.

## config.toml

Defaults are embedded from `config.default.toml` and your `config.toml` is **deep-merged** on top.
Sections (see the maintained
[`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml)
for the full annotated list — link, don't memorize):

- `[general]` — `signup_mode`, `database_url` (Postgres URL), deprecated `user_storage_quota_mb`.
- `[drive]` — `pubky_listen_socket`, `icann_listen_socket`, and `[[drive.rate_limits]]`.
- `[storage]` — backend `type` + `default_quota_mb`.
- `[default_quotas]` — `rate_read`/`rate_write`/`unauthenticated_ip_rate_read`.
- `[admin]` — `enabled`, `listen_socket`, `admin_password`.
- `[metrics]` — `enabled`, `listen_socket`.
- `[pkdns]` — public-reachability advertisement (see below).
- `[logging]` — `level`, `module_levels`.

```toml
[admin]
# Enable or disable the admin server
enabled = true
listen_socket = "127.0.0.1:6288"
# If this API is ever exposed to the public internet, make sure to add a HTTPS cert.
admin_password = "admin"

[metrics]
enabled = true   # NOTE: the sample sets true; the EMBEDDED default is false (metrics off)
# Exposed at /metrics. Isolate from the public network — monitoring systems only.
listen_socket = "127.0.0.1:6289"
```

> The block above is the annotated `config.sample.toml`; the embedded `config.default.toml`
> differs on `[metrics] enabled` (false) — see the table above.

**Signup mode** — `[general].signup_mode` is `"open"` (anyone may sign up) or `"token_required"`
(a signup token is required). **Default is `token_required`** (the default config + the unit test
assert `SignupMode::TokenRequired`).

**Storage backends** — `[storage].type` is one of: `"file_system"` (local disk, default),
`"google_bucket"` (`bucket_name` + `credential` to a service-account JSON; **the bucket must
already exist**), or `"in_memory"` (test/dev only). Cargo's default feature is `storage-gcs`
(`default = ["storage-gcs"]`); `storage-memory` is a separate feature (`testing` pulls it in).
Per-user default quota is `[storage].default_quota_mb` — **omit = unlimited; `0` = zero storage
(not unlimited)**.

**Public reachability** — to be reachable from outside, `[pkdns]` must advertise a public address
on the DHT: `public_ip` (must be set), optional `public_pubky_tls_port` / `public_icann_http_port`
(sample sets `80`), and `icann_domain` (a real domain for legacy browsers). ICANN **TLS is not
natively supported** — *"you should be running a reverse proxy and managing certificates
yourself."* `user_keys_republisher_interval` (default `14400`s = 4h; `0` disables) controls DHT
republish cadence; `dht_bootstrap_nodes` / `dht_relay_nodes` (default relays
`https://pkarr.pubky.app`, `https://pkarr.pubky.org`) / `dht_request_timeout_ms` (`2000`) are also
present. DHT/relay operation lives in [`dns-and-relays.md`](dns-and-relays.md).

**Request-count rate limiting** — `[[drive.rate_limits]]` entries: `path` (fast-glob), `method`
(`GET`/`POST`/…), `quota` (`$rate'r'/$unit` request-count form, e.g. `20r/m`; `$rate` a positive
int up to `4,294,967,296`; only `s`/`m` units), `key` (`ip` or `user` — `user` requires an
authenticated endpoint), optional `burst` (defaults to the quota rate) and `whitelist` (IPs or
pubkeys). **Bandwidth quotas (`kb/s`/`mb/s`/`gb/s`) are not allowed here** — use `[default_quotas]`
for bandwidth throttling.

> **Default vs sample mismatch.** The embedded runtime default (`config.default.toml`, asserted by
> `test_default_config`) ships **one** rule: `GET /signup_tokens/* 10r/m` per-IP (slows invite-code
> brute-forcing). The annotated `config.sample.toml` instead **enables** `POST /session 20r/m`
> per-IP (whitelisting `127.0.0.1`) and leaves the `/signup_tokens/*` rule **commented**. What you
> get out of the box depends on whether you start from the embedded defaults or copy the sample.

**Bandwidth quotas** — `[default_quotas]` sets the system-wide fallbacks used when a user's quota
is `Default`: `rate_read` (download bandwidth, sample `10mb/s`), `rate_write` (uploads, sample
`5mb/s`), `unauthenticated_ip_rate_read` (anonymous-by-IP downloads, sample `1mb/s`). Per-user
overrides go through the admin API (`PATCH /users/{pubkey}/quota`).

## Admin API (:6288)

**Auth model:** the protected router is wrapped in `AdminAuthLayer`, which checks the
**`X-Admin-Password`** header against `[admin].admin_password` by **exact string match**. Missing
header → `401 "Missing admin password"`; wrong value → `401 "Invalid admin password"`. CORS is
**`CorsLayer::very_permissive()`**. `GET /` is public. The `/dav{*path}` route is mounted at the
top level and is **not** under `AdminAuthLayer` — it uses **HTTP Basic auth** in the dav handler
instead (tests send `Authorization: Basic base64(admin:)`).

Endpoint map (verified against `admin_server/app.rs`; the
[OpenAPI spec](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi.yml) admin
server is tagged `localhost:6288` — link, don't hardcode shapes):

| Method + path | Auth | Does |
| :-- | :-- | :-- |
| `GET /generate_signup_token` | header | mint a default-limit signup token |
| `POST /generate_signup_token` | header | mint a token with a custom `UserQuota` (JSON body) |
| `GET /info` | header | server stats (dashboard Overview) |
| `GET /signup_tokens` | header | paginated list (`state=all\|used\|unused`, `limit`, `cursor`) |
| `POST /users/{pubkey}/disable` | header | disable a user |
| `POST /users/{pubkey}/enable` | header | re-enable a user |
| `GET /users/{pubkey}/quota` | header | `{effective, overrides}` |
| `PATCH /users/{pubkey}/quota` | header | set per-user quota overrides (`UserQuotaPatch` body) |
| `DELETE /webdav/{*entry_path}` | header | admin delete by `{pubkey}/path` |
| `ANY /dav{*path}` | **Basic** | WebDAV (`PROPFIND`/`MKCOL`/`GET`/`PUT`/`DELETE`/…); user URLs are `/dav/{pubkey}/path` |
| `GET /` | none | `"Homeserver - Admin Endpoint"` |

`GET /info` returns `InfoResponse`: `num_users`, `num_disabled_users`, `total_disk_used_mb`,
`num_signup_codes`, `num_unused_signup_codes`, `public_key`, `pkarr_pubky_address`
(`Option`), `pkarr_icann_domain` (`Option`), `version`.

> **No `/users/disabled` route exists** in this homeserver version (only `/users/{pubkey}/disable`,
> `/enable`, `/quota`). The dashboard README claims its Users tab fetches a disabled-users list from
> `/users/disabled` — that endpoint is **not** in the homeserver admin router at this commit, so
> the dashboard is either ahead of this homeserver or computes the list differently. Don't rely on
> it; verify against the homeserver you actually run.

CLI-driven versions of these flows (`pubky-cli`) live in [`operator-cli.md`](operator-cli.md).

### Signup tokens and quotas

Mint a token (here with the **testnet default** password `admin` — change it for any real
deployment). `GET` returns `200` with the token id as the **plain-text body**:

```bash
curl -X GET "http://127.0.0.1:6288/generate_signup_token" \
     -H "X-Admin-Password: admin"
     # Use your admin password. This is testnet default pwd.
```

Token id format is **`XXXX-XXXX-XXXX`** — 14 chars: 12 Crockford-base32 chars (uppercase, from 7
random bytes), hyphen-grouped every 4. Validation requires `len == 14` and Crockford-decodability
after stripping hyphens; server-minted tokens are uppercase, but `is_valid` is **case-insensitive**
(Crockford decode), so don't rely on case to reject a token.

`GET /signup_tokens` lists them: query `state` (`all`/`used`/`unused`, default `all`), `limit`
(`NonZeroU16`; `limit=0` → `400`), `cursor` (a `SignupCode`; invalid → `400`). Response is
`{ items: [{token, created_at, used_at?, used_by? (z32)}], next_cursor? }`. Default list limit
`100`, max `1000`.

**Quotas use two different body types** — don't conflate them:

| Endpoint | Body type | Field **absent** means |
| :-- | :-- | :-- |
| `POST /generate_signup_token` | `UserQuota` | **Default** (resolve from system config) |
| `PATCH /users/{pubkey}/quota` | `UserQuotaPatch` | **keep existing** (unchanged) |

For both: field **`null`** → reset to Default; **`"unlimited"`** → no limit; a **value** → explicit
limit. Fields: `storage_quota_mb` (integer MB), `rate_read`, `rate_write` (bandwidth strings like
`"200mb/m"`). Invalid quota format → `422`.

`GET /users/{pubkey}/quota` returns `{effective, overrides}`: `effective` = overrides merged with
system defaults (**all fields always present**); `overrides` = only the per-user customizations
(Default fields **omitted**, so `Default` vs `Unlimited` are distinguishable — `Unlimited` shows as
`"unlimited"`, `Default` is absent). `404` for a nonexistent user; `PATCH` with an invalid rate
string → `422`.

### Enable and disable users

`POST /users/{pubkey}/disable` and `/enable` toggle a boolean (`user.disabled`) on the user row;
both return `200 "Ok"`. `404 "User not found"` if no such user; `400` if `{pubkey}` is not a valid
z-base-32 key (`Path<Z32Pubkey>` rejection).

> `{pubkey}` in admin paths is the **raw z32 form** (`publicKey.z32()`), **not** the `pubky<z32>`
> display form. Mixing these up is a common cause of `400`s — see the
> [public-key string formats table](../../pubky/references/concepts.md#public-key-string-formats).

## Metrics (:6289)

`GET /metrics` serves Prometheus text on `[metrics].listen_socket` and is **unauthenticated**.
Module doc: *"counters and histograms for event stream connections, database query latencies, and
broadcast channel health."* The sample warns it *"should be isolated from the public network and
only accessible to monitoring systems."* **Off by default** (see the sockets table); Umbrel
deliberately does not publish `6289` to the LAN (container-network only).

## Event streams (client server)

A **shipped** feature, exposed on the **client** server (`6286`/`6287`), **not** admin. This is
what a Nexus watcher or Pubky Backup consumes:

- `GET /events/` — legacy plain-text historical feed (`events::feed`).
- `GET /events-stream` — Server-Sent Events (`events::feed_stream`). Query params: `user=<z32>[:cursor]`
  (repeatable; a `pubky<z32>` prefix is **rejected**; an empty user list → `400 "user parameter is
  required"`), `path=` (repeatable, empty ignored), `limit=` (`u16`), `reverse=` (`true`/`1`),
  `live=` (`true`/`1`). `live` + `reverse` → `400 "Cannot use live mode with reverse ordering"`.
  There is a `MAX_EVENT_STREAM_USERS` cap (exceeding it → `400`).

The write-vs-read consumer model is canonical in
[`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read); operating the
watcher side is in [`nexus-operations.md`](nexus-operations.md).

> **Client-server auth is canonical, not restated here.** The OpenAPI describes it as grant-based
> (`Authorization: Bearer <token>` from `POST /auth/grant/session`) with a deprecated cookie path
> (`POST /signup` / `POST /session`), and tenant resolution by priority `pubky-host` header > `Host`
> (TLS SNI) > `?pubky-host=` query, the value being a z-base-32 Ed25519 public key. See
> [`concepts.md` § Authentication](../../pubky/references/concepts.md#authentication) and
> [`auth.md`](../../pubky/references/auth.md).

## homeserver-dashboard

A Next.js (App Router) + React + Tailwind/shadcn admin UI (Node 24+), single route `/dashboard`,
server binds port `8080` by default. Tabs: **Overview** (`GET /info`), **Users** (disable/enable),
**Invites** (`generate_signup_token` + QR), **Files** (WebDAV `/dav/*` via Basic Auth + admin
delete-by-path), **Logs** (tails the `HOMESERVER_LOG_PATH` JSON log; `/api/logs` returns `503` and
the tab is unavailable when unset), **API** (explorer for admin/client/metrics), plus **Settings**
(gear) with **Config** (view/edit the real `config.toml` — secret redaction, optimistic
concurrency, atomic writes, read-only fallback) and **Cloudflare**.

> The Umbrel build's release notes (dashboard `v0.1.26`) say the developer-only **"API" explorer
> tab was removed** from the normal interface; the standalone dashboard README still lists API as a
> tab. Treat the API tab as possibly absent on Umbrel — verify on the build you run.

Run it standalone in Docker, pointed at a homeserver's admin API. `ADMIN_BASE_URL` + `ADMIN_TOKEN`
are **server-only** env (no `NEXT_PUBLIC_` prefix) so credentials never reach the browser. In
Docker, use the **service name**, not `localhost`:

```bash
docker build -t homeserver-dashboard .

docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  homeserver-dashboard
```

Key env (all server-only, read lazily): `ADMIN_BASE_URL` / `ADMIN_TOKEN` (required), `CLIENT_BASE_URL`
(default `http://homeserver:6286`), `METRICS_BASE_URL` (default `http://homeserver:6289`),
`HOMESERVER_CONFIG_PATH` (default `/app/homeserver-data/config.toml`), `HOMESERVER_LOG_PATH`
(default unset → Logs tab unavailable), `PREVIEW_INSTANT_ORIGIN` (default `http://homeserver:6286`),
`CLOUDFLARE_CONFIG_DIR` / `CLOUDFLARED_BIN` / `CLOUDFLARED_RUNTIME_DIR` / `CF_API_BASE`,
`ADMIN_PASSWORD_MANAGED` (set `true` to lock `admin_password` edits), `PLATFORM`
(`umbrel` | unset = standalone), `PORT` / `HOSTNAME` (default `8080` / `0.0.0.0`).

## Cloudflare-tunnel exposure

Cloudflare Tunnel exposes the homeserver publicly **without port forwarding**. Only the **HTTP
endpoint (`6286`)** is tunneled — the public-hostname Service is the HTTP URL `homeserver:6286`;
**Pubky-TLS (`6287`) needs direct connectivity** and cannot be tunneled. The dashboard Settings →
Cloudflare tab offers four setups: **Connect account** (browser OAuth, recommended), **API token**,
**manual token + domain**, and **Preview** (a temporary, account-less `trycloudflare.com` quick
tunnel refreshed each restart). The manual / debugging reference is upstream in
[`CLOUDFLARE_TUNNEL.md`](https://github.com/pubky/homeserver-dashboard/blob/main/CLOUDFLARE_TUNNEL.md).

> **Preview tunnels break `/events`.** An account-less Preview (`trycloudflare.com` quick) tunnel
> does **not** pass the live `/events` SSE stream, so Pubky indexers (Nexus) may **miss the
> homeserver's content**; the address is also temporary and can drop on restart. Use a **permanent
> Cloudflare domain** (the persistent `cloudflared` service) for full `/events` support.

## Umbrel vs standalone

The dashboard's `PLATFORM` env var selects the deployment flavor:

- **`PLATFORM=umbrel`** — shows the Cloudflare setup tab/flows, umbrelOS backup guidance, and
  "restart from Umbrel" copy.
- **unset / standalone** — **hides** the Cloudflare setup UI and `/cloudflare-guide` (its setup API
  routes return `404 not_supported`) because a standalone deploy has no `cloudflared` containers.
  The read-only status views (public address, reachability, pkarr "Pubky network" check) remain, so
  a self-managed reverse proxy or tunnel can still be verified.

**Umbrel deployment** — the "Pubky Homeserver" app ships via the
[`pubky/umbrel-app-store`](https://github.com/pubky/umbrel-app-store) community store (add the store
URL `https://github.com/pubky/umbrel-app-store`, then install). Manifest: id `pubky-homeserver`,
version `0.9.1-17` (scheme `<homeserver-version>-<packaging-revision>`), port `8812`, repo
`pubky/pubky-homeserver`; `backupIgnore` excludes `homeserver.log`. Compose services:

- `app_proxy` — Umbrel's proxy (`APP_HOST=pubky-homeserver_web_1`, `APP_PORT=8812`).
- `postgres` — `postgres:17-alpine` (`POSTGRES_USER=pubky`, `POSTGRES_DB=pubky_homeserver`,
  `POSTGRES_PASSWORD=${APP_PASSWORD}`).
- `homeserver-config-wrapper` — one-shot (`synonymsoft/homeserver-umbrel-config-wrapper`); renders
  `/data/config.toml` from env, then exits. `homeserver` waits on it via
  `service_completed_successfully`.
- `homeserver` — the vanilla `synonymsoft/homeserver` binary; publishes `6286`/`6287`/`6288`;
  `6289` (metrics) intentionally **not** published.
- `web` — the dashboard (`synonymsoft/homeserver-dashboard:v0.1.26`, `PORT=8812`), no published
  ports, behind `app_proxy`.
- Cloudflared: **two** services at this commit — `cloudflared` (persistent; all tiers now write one
  `config.yml`) and `cloudflared-preview` (account-less quick tunnel).

> The Umbrel README still says "three mode-gated cloudflared services"; the compose file is now down
> to the **two** above (its comment: *"there is no separate token-mode container."*). Trust the
> compose file.

The homeserver runs the **vanilla binary as PID 1**; the surrounding FIFO + `tee` only mirrors
stdout/stderr to `/data/homeserver.log` for the dashboard Logs tab (rotated ~10 MB → ~2 MB):

```bash
exec homeserver --data-dir /data > /tmp/log-fifo 2>&1
```

On Umbrel the admin password is Umbrel's generated **`APP_PASSWORD`** — wired as the dashboard's
`ADMIN_TOKEN`, as the homeserver's `admin_password` (via the wrapper's `ADMIN_PASSWORD` env), and as
`POSTGRES_PASSWORD`. `web` gets `ADMIN_PASSWORD_MANAGED="true"` + `PLATFORM=umbrel`, so the Config
editor rejects `admin_password` edits (editing it would disconnect the dashboard). The manifest's
empty `defaultUsername` / `defaultPassword` suppress Umbrel's credentials modal; the password is
revealable in Settings (eye icon). Port `6288` (admin) **is** published to the LAN so users can
point `pubky-cli` at it; `6289` (metrics, unauthenticated) is **not**.

`exports.sh` advertises three URLs to other Umbrel apps, using the **static container name**
`pubky-homeserver_homeserver_1` (the `homeserver` compose alias resolves only inside this app's
network): `APP_PUBKY_HOMESERVER_ADMIN_URL` (`:6288`), `APP_PUBKY_HOMESERVER_CLIENT_URL` (`:6286`),
`APP_PUBKY_HOMESERVER_METRICS_URL` (`:6289`). The admin **token is deliberately not exported** — a
consumer must obtain it out of band.

## Homegate (signup gating)

Homegate sits in front of registration and integrates with the homeserver **purely via the admin
API**: its config has `[homeserver] admin_api_url = http://homeserver:6288` + `admin_password`. It
verifies users (SMS / Lightning / IP), then mints a signup token through the admin API; per-tier
signup quotas map to the same **`UserQuota`** body used by `/generate_signup_token`. Full routes and
secrets are in [`signup-gating.md`](signup-gating.md).

## Security guardrails

- **Change the admin password.** `admin_password` defaults to `"admin"` (testnet default) and the
  admin server is **cleartext HTTP with no built-in TLS** — the sample warns: *"If this API is ever
  exposed to the public internet, make sure to add a HTTPS cert."* Keep `:6288` (admin) and `:6289`
  (metrics, unauthenticated) off the public internet / behind a reverse proxy. Admin CORS is
  `very_permissive`.
- **`pubky-docker` is not production.** Its README banners that it is for **local development and
  experimentation only** — *"not production hosting infrastructure … production deployments require
  infrastructure that is hardened, monitored, maintained, and operated for that purpose."* Use the
  Umbrel app or a hand-rolled hardened deployment instead.
- **`/priv` storage is in `main` but not released — don't rely on it.** `authorization.rs` enforces
  a `/priv/` root (`PRIVATE_ROOT`): `/pub/*` is world-readable; `/priv/*` requires a session scoped
  to the matching tenant (`401` anonymous, `403` wrong-tenant / under-scoped); a write under
  **neither** root → `403`. It is **auth-scoped and access-controlled, *not* encrypted** — a trusted
  operator can still read the data — and it is **not in the latest release** (the released SDK types
  `/pub` paths only), so don't build on it from released code. Status detail:
  [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md#no-private-encrypted-or-guarded-storage).
  The `/pub` layout itself is also not stabilized.

## Upstream sources of truth

- Homeserver crate + `config.sample.toml` + `openapi.yml`:
  [pubky-homeserver/pubky-homeserver](https://github.com/pubky/pubky-homeserver/tree/main/pubky-homeserver)
- Full local stack: [pubky-docker](https://github.com/pubky/pubky-docker) ·
  [`local-stack.md`](local-stack.md)
- Dashboard: [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard)
- Umbrel app: [umbrel-app-store](https://github.com/pubky/umbrel-app-store)
