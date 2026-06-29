# Run a homeserver

Operating a homeserver: how to launch it, the three HTTP servers it exposes, `config.toml`,
the admin API (signup tokens, user enable/disable, quotas), the dashboard, public exposure via
Cloudflare Tunnel, and Umbrel vs standalone.

## What a homeserver is

For the protocol model — the per-public-key backend, PKARR discovery, the `/pub` tree, the
PostgreSQL-metadata-vs-filesystem split, and **homeserver-write vs Nexus-read** — read the
canonical [`concepts.md`](../../pubky/references/concepts.md#the-homeserver-model) and
[`concepts.md` write/read split](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).
Don't re-derive it here. This file is operations only.

> Versions below are from the `0.9.0` homeserver workspace (the OpenAPI `info.version` is also
> `0.9.0`). Pubky is **pre-1.0**; treat any version-pinned or API-shape claim as drift-prone and
> confirm against the linked upstream source.

## Run it

The binary takes exactly **one** flag: `--data-dir` / `-d` (default `~/.pubky`), validated as a
directory. It expects a `config.toml` inside that dir, inits tracing, then starts the server.

```bash
cargo run -- --data-dir=~/.pubky
```

[`main.rs`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/src/main.rs) is the
authoritative entrypoint and the only place to trust for CLI/startup:

```rust
#[derive(Parser, Debug)]
#[command(version = env!("CARGO_PKG_VERSION"))]
struct Cli {
    /// Path to config file. Defaults to ~/.pubky/config.toml
    #[clap(short, long, default_value_os_t = default_config_dir_path(), value_parser = validate_config_dir_path)]
    data_dir: PathBuf,
}
```

> The homeserver **README's library examples** (`server.core()`, `DataDirMock`, …) contain
> method-name typos — do **not** copy them verbatim. Use `main.rs` for the real surface.

Three ways to deploy:

- **From source / single binary** — `cargo run` (above), or run the built `homeserver` binary.
- **Local dev stack** — `pubky-docker` compose brings up homeserver + Nexus + frontends in one
  command. It is **local development / experimentation only, not production hosting** — see the
  guardrail below and [`local-stack.md`](local-stack.md).
- **Self-host (production)** — the [Umbrel app](#umbrel-vs-standalone), or a hand-rolled
  hardened deployment (reverse proxy + TLS + isolated metrics).

A **PostgreSQL** database is required and **must be created manually** — the binary applies its
bundled `sqlx`/`sea-query` migrations but will not create the database. Default
`[general].database_url` is `postgres://localhost:5432/pubky_homeserver`.

## Three servers, four sockets

The homeserver runs **three independent HTTP servers**; the client (drive) server binds **two**
sockets (Pubky-TLS + ICANN HTTP), admin and metrics one each. Defaults are all loopback — the
client (`6286`/`6287`) and admin (`6288`) sockets are asserted in the config unit test
(`test_default_config`); the metrics default (`6289`) comes from `config.default.toml`:

| Server | Default socket | Purpose |
| :-- | :-- | :-- |
| Client — Pubky-TLS | `127.0.0.1:6287` | tenant file API over PubkyTLS (raw public keys) |
| Client — ICANN HTTP | `127.0.0.1:6286` | tenant file API, cleartext (behind your reverse proxy) |
| Admin | `127.0.0.1:6288` | operator API (tokens, users, quotas, WebDAV) |
| Metrics | `127.0.0.1:6289` | Prometheus `/metrics`, **unauthenticated** |

The **client** servers host the tenant file API (`/pub` `PUT`/`GET`/`DELETE`) and the **event
streams**; the **admin** and **metrics** servers are operator-only and should stay off the
public internet.

## config.toml

Defaults are embedded from `config.default.toml` and your `config.toml` is **deep-merged** on
top. Sections (see the maintained
[`config.sample.toml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/config.sample.toml)
for the full annotated list — link, don't memorize):

- `[general]` — `signup_mode`, `database_url` (Postgres URL), deprecated `user_storage_quota_mb`.
- `[drive]` — `pubky_listen_socket`, `icann_listen_socket`, and `[[drive.rate_limits]]`.
- `[storage]` — backend `type` + `default_quota_mb`.
- `[default_quotas]` — `rate_read`/`rate_write`/bursts/`unauthenticated_ip_rate_read`.
- `[admin]` — `enabled`, `listen_socket`, `admin_password`.
- `[metrics]` — `enabled`, `listen_socket`.
- `[pkdns]` — public-reachability advertisement (see below).
- `[logging]` — `level`, `module_levels`.

```toml
[admin]
# Enable or disable the admin server
enabled = true
# The port number to run the admin HTTP (clear text) server on.
# If this API is every exposed to the public internet, make sure to add a HTTPS cert.
listen_socket = "127.0.0.1:6288"
# The password for the admin user to access the admin UI.
admin_password = "admin"

[metrics]
enabled = true
# It exposes Prometheus metrics at the /metrics endpoint.
# It should be isolated from the public network and only accessible to monitoring systems.
listen_socket = "127.0.0.1:6289"
```

**Signup mode** — `[general].signup_mode` is `"open"` (anyone may sign up) or `"token_required"`
(a signup token is required). **Default is `token_required`.**

**Storage backends** — `[storage].type` is one of: `"file_system"` (local disk, default),
`"google_bucket"` (`bucket_name` + `credential` to a service-account JSON; the bucket must
already exist), or `"in_memory"` (test/dev only). Cargo's default feature is `storage-gcs`;
`storage-memory` is a separate feature. Per-user default quota is `[storage].default_quota_mb` —
**omit = unlimited; `0` = zero storage (not unlimited)**.

**Public reachability** — to be reachable from outside, `[pkdns]` must advertise a public
address on the DHT: `public_ip`, optional `public_pubky_tls_port` / `public_icann_http_port` (if
they differ from the listen sockets), and `icann_domain` (a real domain pointing at the machine,
for legacy browsers). ICANN **TLS is not natively supported** — terminate TLS in a reverse proxy
and manage certs yourself. `user_keys_republisher_interval` (default `14400`s = 4h; `0` disables)
controls DHT republish cadence. DHT/relay operation lives in [`dns-and-relays.md`](dns-and-relays.md).

**Request-count rate limiting** — `[[drive.rate_limits]]` entries take `path` (fast-glob),
`method`, `quota` (`$count'r'/$unit`, e.g. `20r/m`; only `s`/`m` units), `key` (`ip` or `user`),
optional `burst` and `whitelist`. The default config ships `20r/m` per-IP on `POST /session` and
a commented `10r/m` per-IP on `GET /signup_tokens/*` to slow invite-code brute-forcing.
**Bandwidth quotas (`mb/s`) are not allowed in path limits** — use `[default_quotas]` for
bandwidth throttling.

## Admin API (:6288)

**Auth model:** the protected router is wrapped in an auth layer that checks the
**`X-Admin-Password`** header against `[admin].admin_password` by **exact string match**. Missing
header → `401 Missing admin password`; wrong value → `401 Invalid admin password`. CORS is
**`very_permissive`**. The WebDAV routes use **HTTP Basic Auth** instead, and `GET /` is public.

Endpoint map (source of truth is the
[OpenAPI spec](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml),
admin server tagged `http://localhost:6288` — link, don't hardcode shapes):

| Method + path | Auth | Does |
| :-- | :-- | :-- |
| `GET /generate_signup_token` | header | mint a default-limit signup token |
| `POST /generate_signup_token` | header | mint a token with a custom `UserQuota` (JSON body) |
| `GET /info` | header | server stats (dashboard Overview) |
| `GET /signup_tokens` | header | paginated list (`state=all\|used\|unused`, `limit`, `cursor`) |
| `POST /users/{pubkey}/disable` | header | disable a user |
| `POST /users/{pubkey}/enable` | header | re-enable a user |
| `GET /users/{pubkey}/quota` | header | `{effective, overrides}` |
| `PATCH /users/{pubkey}/quota` | header | set per-user quota overrides (`UserQuota` body) |
| `DELETE /webdav/{*entry_path}` | header | admin delete by `{pubkey}/path` |
| `ANY /dav{*path}` | **Basic** | WebDAV (`PROPFIND`/`MKCOL`/`GET`/`PUT`/`DELETE`/…); user URLs are `/dav/{pubkey}/path` |
| `GET /` | none | `"Homeserver - Admin Endpoint"` |

`GET /info` returns `InfoResponse`: `num_users`, `num_disabled_users`, `total_disk_used_mb`,
`num_signup_codes`, `num_unused_signup_codes`, `public_key`, `pkarr_pubky_address`,
`pkarr_icann_domain`, `version`.

CLI-driven versions of these flows (`pubky-cli`) live in [`operator-cli.md`](operator-cli.md).

### Signup tokens and user quotas

Mint a token (here with the **testnet default** password `admin` — change it for any real
deployment):

```bash
curl -X GET "http://127.0.0.1:6288/generate_signup_token" \
     -H "X-Admin-Password: admin"
     # Use your admin password. This is testnet default pwd.
```

`POST /generate_signup_token` and `PATCH /users/{pubkey}/quota` take a **`UserQuota`** JSON body
with **override** semantics:

- field **absent** → keep / resolve from system config (Default);
- field **`null`** → reset to Default;
- field **`"unlimited"`** → no limit;
- a **value** → explicit limit.

Fields: `storage_quota_mb` (integer MB), `rate_read`, `rate_write` (bandwidth strings like
`"200mb/m"`, `"10mb/s"`). Invalid quota format → `422`. `GET /users/{pubkey}/quota` returns
`{effective, overrides}` where `effective` = overrides merged with system defaults and
`overrides` = only the per-user customizations.

### Enable and disable users

`POST /users/{pubkey}/disable` and `/enable` toggle a boolean (`user.disabled`) on the user row;
both return `200 "Ok"`. `404 "User not found"` if no such user; `400` if `{pubkey}` is not a
valid z-base-32 key.

> `{pubkey}` in admin paths is the **raw z32 form** (`publicKey.z32()`), **not** the
> `pubky<z32>` display form. Mixing these up is a common cause of `400`s — see the
> [public-key string formats table](../../pubky/references/concepts.md#public-key-string-formats).

## Metrics (:6289)

`GET /metrics` serves Prometheus text on `[metrics].listen_socket` and is **unauthenticated**.
Keep it isolated from the public network — only reachable by your monitoring systems. (Umbrel
deliberately does **not** publish `6289` to the LAN, only over the container network.)

## Event streams (client server)

A **shipped** feature, exposed on the **client** server (6286/6287), **not** admin. This is what
a Nexus watcher or Pubky Backup consumes:

- `GET /events/` — legacy plain-text historical feed (`cursor`+`limit` query, public /
  unauthenticated, `/pub` only).
- `GET /events-stream` — Server-Sent Events: `?user=<z32>[:cursor]` (repeatable), `?path=`,
  `?limit=`, `?reverse=`, `?live=true`. `live` **cannot** combine with `reverse`.

The write-vs-read consumer model is canonical in
[`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read); operating the
watcher side is in [`nexus-operations.md`](nexus-operations.md).

## homeserver-dashboard

A Next.js (App Router) + React + Tailwind/shadcn admin UI served at route `/dashboard`. Tabs:
**Overview** (`GET /info`), **Users** (disable/enable), **Invites** (`generate_signup_token` +
QR), **Files** (WebDAV `/dav/*` via Basic Auth + admin delete-by-path), **Logs** (tails the
`HOMESERVER_LOG_PATH` JSON log; hidden if unset), **API explorer**, plus **Settings** with a
Config editor (view/edit the real `config.toml` with secret redaction + optimistic concurrency)
and a Cloudflare tab.

Run it standalone in Docker, pointed at a homeserver's admin API. `ADMIN_BASE_URL` +
`ADMIN_TOKEN` are **server-only** env (no `NEXT_PUBLIC_` prefix) so credentials never reach the
browser. In Docker, use the **service name**, not `localhost`:

```bash
docker build -t homeserver-dashboard .

docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  homeserver-dashboard
```

Key env: `ADMIN_BASE_URL`/`ADMIN_TOKEN` (required), `CLIENT_BASE_URL` (default
`http://homeserver:6286`), `METRICS_BASE_URL` (default `http://homeserver:6289`),
`HOMESERVER_CONFIG_PATH`, `HOMESERVER_LOG_PATH`, `ADMIN_PASSWORD_MANAGED` (set `true` to lock
`admin_password` edits), `PORT`/`HOSTNAME`, and **`PLATFORM`** (see below).

## Cloudflare-tunnel exposure

Cloudflare Tunnel exposes the homeserver publicly **without port forwarding**. Only the **HTTP
endpoint (`6286`)** is tunneled; **Pubky-TLS (`6287`) requires direct connectivity** and cannot
be tunneled. The dashboard Settings → Cloudflare tab offers four setups: **Connect account**
(browser OAuth, recommended), **API token**, **manual token + domain**, and **Preview** (a
temporary, account-less `trycloudflare.com` quick tunnel refreshed each restart). The
public-hostname Service URL must point at `homeserver:6286`. The manual path and debugging
reference is upstream in
[`CLOUDFLARE_TUNNEL.md`](https://github.com/pubky/homeserver-dashboard/blob/main/CLOUDFLARE_TUNNEL.md).

## Umbrel vs standalone

The dashboard's `PLATFORM` env var selects the deployment flavor:

- **`PLATFORM=umbrel`** — shows the Cloudflare setup flows, umbrelOS backup guidance, and
  "restart from Umbrel" copy.
- **unset / standalone** — **hides** the Cloudflare setup UI (its setup API routes return `404
  not_supported`) because a standalone deploy has no `cloudflared` containers. The read-only
  reachability / pkarr status views remain, so a self-managed reverse proxy or tunnel can still
  be verified.

**Umbrel deployment** — the "Pubky Homeserver" app ships via the
[`pubky/umbrel-app-store`](https://github.com/pubky/umbrel-app-store) community store (add the
store URL, then install). It bundles five compose services: `postgres`, a one-shot
`homeserver-config-wrapper` (renders `/data/config.toml` from env, then exits), `homeserver`,
`web` (the dashboard, behind Umbrel's `app_proxy` on port `8812`), and mode-gated `cloudflared`
services. App version scheme is `<homeserver-version>-<packaging-revision>` (e.g. `0.9.1-17`).

The homeserver launch command inside the Umbrel app is the **vanilla binary** (matching
`main.rs`); the surrounding FIFO + `tee` only mirrors stdout to `/data/homeserver.log` for the
dashboard Logs tab while keeping the binary as PID 1:

```bash
exec homeserver --data-dir /data > /tmp/log-fifo 2>&1
```

On Umbrel the admin password is Umbrel's generated **`APP_PASSWORD`** (wired as `ADMIN_TOKEN`
for the dashboard and as `admin_password` via the config wrapper); `ADMIN_PASSWORD_MANAGED=true`
makes the config editor reject `admin_password` edits (editing it would disconnect the
dashboard). Port `6288` (admin) **is** published to the LAN so users can point `pubky-cli` at
it; `6289` (metrics) is intentionally **not** published. `exports.sh` advertises
`APP_PUBKY_HOMESERVER_ADMIN_URL` (`:6288`), `CLIENT_URL` (`:6286`), and `METRICS_URL` (`:6289`)
for other Umbrel apps.

## Homegate (signup gating)

Homegate sits in front of registration and integrates with the homeserver **purely via the
admin API**: its config has `[homeserver] admin_api_url = http://homeserver:6288` +
`admin_password`. It verifies users (SMS / Lightning / IP), then mints a signup token through
the admin API; per-tier signup quotas map to the same **`UserQuota`** override shape used by
`/generate_signup_token`. Full routes and secrets are in [`signup-gating.md`](signup-gating.md).

## Security guardrails

- **Change the admin password.** `admin_password` defaults to `"admin"` (testnet default) and
  the admin server is **cleartext HTTP with no built-in TLS** — the sample warns: *"If this API
  is ever exposed to the public internet, make sure to add a HTTPS cert."* Keep `:6288` (admin)
  and `:6289` (metrics, unauthenticated) off the public internet / behind a reverse proxy. Admin
  CORS is `very_permissive`.
- **`pubky-docker` is not production.** Its README banners that it is for **local development
  and experimentation only** — not hardened, monitored, or maintained for production. Do not
  present it as a production hosting option; use the Umbrel app or a hand-rolled hardened
  deployment.
- **`/pub` vs `/priv` — code-vs-doc drift; verify before relying.** `authorization.rs` now
  defines `STORAGE_ROOTS = ["/pub/", "/priv/"]`, so actual enforcement is: a write under
  **neither** root returns `403` (`"Writing to directories other than '/pub/' and '/priv/' is
  forbidden"`); `/pub/*` is world-readable; and **`/priv/*` is now an authenticated tier** — a
  `/priv/` write with a covering capability succeeds, and `/priv/` reads need a matching-tenant
  capability (`401` anonymous, `403` wrong-tenant / under-scoped). This **contradicts** both the
  OpenAPI spec and the canonical
  [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md), which still document
  `/pub`-only with everything else `403`. The guardrail is canonical there; until docs and code
  reconcile, treat `/priv` as **unstable and not safe to depend on**, and never tell users their
  homeserver data is private or encrypted (a trusted operator can still read it). The `/pub`
  layout itself is also not stabilized.

## Upstream sources of truth

- Homeserver crate + `config.sample.toml` + `openapi.yml`:
  [pubky-core/pubky-homeserver](https://github.com/pubky/pubky-core/tree/main/pubky-homeserver)
- Full local stack: [pubky-docker](https://github.com/pubky/pubky-docker) ·
  [`local-stack.md`](local-stack.md)
- Dashboard: [homeserver-dashboard](https://github.com/pubky/homeserver-dashboard)
- Umbrel app: [umbrel-app-store](https://github.com/pubky/umbrel-app-store)
