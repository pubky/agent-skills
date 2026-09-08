# Signup gating (Homegate)

[Homegate](https://github.com/pubky/homegate) is a standalone backend service that gatekeeps
homeserver signups. A client proves itself one of three ways — **SMS**, **Lightning payment**,
or **IP** — and Homegate mints a homeserver **signup token** for it. It is a separate repo /
process from Pubky Homeserver, sitting in front of the homeserver admin API. The production social app
gates onboarding (`https://pubky.app/onboarding/human`) through it.

What a signup token *is*, and the homeserver-write model, are canonical elsewhere — **do not
restate them here, link**:

- The token / "signup code" itself and `signer.signup(homeserverPk, signupToken)` (pass a token
  for gated homeservers, `null` for open/testnet):
  [`../../pubky/references/concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).
- The homeserver admin API that actually mints tokens (signup/invite tokens, enable/disable
  users): [`homeserver.md`](homeserver.md).

**Homegate's only job is to gate who gets a token.** Once a client holds the `signupCode`, it
signs up normally via the SDK.

> **Pre-1.0 (v0.2.0), drift-prone.** Rust edition 2024, built with `rust:1.89.0-alpine`. Treat
> the API like the rest of Pubky. The
> [`openapi.yaml`](https://github.com/pubky/homegate/blob/master/openapi.yaml) carries an explicit
> upstream warning that it is **AI-generated and may be inaccurate** — link it for shapes but
> **prefer the Rust source as ground truth** where they disagree (e.g. the `/await` timeout
> below).

## Three optional routes

Three independent verification routes, each **enabled only by adding its config section**. Omit
the section and that route is simply not mounted:

| Route | Mounted when | External dependency |
| :-- | :-- | :-- |
| `/sms_verification` | `[sms_verification]` present | [Prelude](https://docs.prelude.so/) (SMS provider) |
| `/ln_verification` | `[ln_verification]` present | [phoenixd](https://github.com/ACINQ/phoenixd) (Lightning node) |
| `/ip_verification` | `[ip_verification]` present | none |

```rust
if let Some(sms) = &config.sms_verification {
    app = app.nest("/sms_verification", router(homeserver_api, sms, db.clone(), hasher.clone()).await?);
}
if let Some(ln) = &config.ln_verification {
    app = app.nest("/ln_verification", ln_verification::router(homeserver_api, ln, db.clone()).await?);
}
if let Some(ip) = &config.ip_verification {
    app = app.nest("/ip_verification", ip_verification::router(homeserver_api, ip, db.clone(), hasher.clone()).await?);
}
```

<sub>Source: [`src/infrastructure/http/server.rs`](https://github.com/pubky/homegate/blob/master/src/infrastructure/http/server.rs)</sub>

## Configuration

Single TOML file at `<data-dir>/config.toml` (default `~/.homegate/`, override with
`--data-dir`). The data dir must **already exist** — Homegate errors `Data directory does not
exist` otherwise, so `mkdir ~/.homegate` first. On first run with no config it pre-fills
`<data-dir>/config.toml` with the bundled example template and **exits**, asking you to edit it
and restart. `database_url` and `[homeserver]` are **required**; everything else has defaults or
is optional. Run with `cargo run` or `cargo run -- --data-dir /path`.

```toml
database_url = "postgres://postgres:postgres@localhost:5432/pubky_homegate"  # required
http_listen_socket = "0.0.0.0:8080"   # default
# allow_cors = false                   # default; permissive CORS when true
# accept_proxy_ip_headers = false      # default; see IP route below

[homeserver]                           # required
admin_api_url = "http://localhost:6288"
admin_password = "admin"
```

Plus an optional `[logging]` section and the three optional `[sms_verification]` /
`[ln_verification]` / `[ip_verification]` sections documented below.

### PostgreSQL backing

`database_url` must point to an **existing** PostgreSQL database. Homegate stores **all** its
state there and **auto-runs migrations on startup**. This is Homegate's own DB, **separate** from
the homeserver's PostgreSQL. (Tests use a `DATABASE_URL` env var via `sqlx::test` and never read
`config.toml`.)

Migrations create three tables. **Phone numbers and IPs are stored only as hashes
(`phone_number_hash` / `ip_address_hash`), never plaintext:**

| Table | Columns |
| :-- | :-- |
| `sms_verifications` | `phone_number_hash`, `prelude_id`, `status` (`PENDING`/…), `signup_code`, `attempts`, `created_at`, `finalised_at`, `failure_reason` |
| `lightning_verifications` | `id` (uuid), `payment_hash`, `amount_sat`, `signup_code`, `expires_at`, `finalised_at`, `created_at` |
| `ip_verifications` | `ip_address_hash`, `signup_code`, `created_at` |

### The pepper secret

On first run Homegate generates a secret **pepper** at `<data-dir>/pepper.txt` (default
`~/.homegate/pepper.txt`): 32 random bytes hex-encoded = **64 hex chars** (read and validated on
startup). The pepper is a **global salt** mixed into the Argon2id hash of every phone number and
IP.

> **Back it up and treat it as a secret.** If `pepper.txt` is lost, Homegate can no longer match
> previously-verified phone numbers / IPs to new requests, so the **per-number / per-IP
> verification rate limits stop being enforced.**

Phone/IP hashing uses **Argon2id** with OWASP-recommended params (m_cost 19456 KiB, t_cost 2,
p_cost 1, 32-byte output), intentionally >100 ms per hash to slow pre-image brute force if the DB
leaks. The salt is **deterministic** — first 16 bytes of `blake3(pepper)` — so the same input
always yields the same digest, which is exactly what makes rate-limit lookups by hash possible.

```rust
let params = ParamsBuilder::new()
    .m_cost(19456)
    .t_cost(2)
    .p_cost(1)
    .output_len(32)
    .build()?;
let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
// salt = first 16 bytes of blake3(pepper), b64-encoded — deterministic per pepper
let salt_bytes = blake3::hash(self.pepper.as_bytes());
let salt = SaltString::encode_b64(&salt_bytes.as_bytes()[..16])?;
```

<sub>Source: [`src/shared/hasher_argon2id.rs`](https://github.com/pubky/homegate/blob/master/src/shared/hasher_argon2id.rs)</sub>

## Homeserver admin API

Homegate talks to the homeserver admin API (`admin_api_url`, default `http://localhost:6288`)
with an `X-Admin-Password` header. At **startup** it calls `GET /info` to verify the password and
read the homeserver `public_key`; if that fails (wrong `admin_password` or homeserver
unreachable) the process calls `std::process::exit(1)` and **refuses to start**. That fetched key
is what every route returns to clients as `homeserverPubky`.

To mint a token it calls `generate_signup_token` two ways; the returned token string becomes the
`signupCode`:

- `GET /generate_signup_token` — homeserver **system-default** quota.
- `POST /generate_signup_token` with a quota JSON body — **explicit** quota.

```rust
// GET = system defaults
http_client.get(base_url.join("generate_signup_token")?)
    .header("X-Admin-Password", &self.admin_password).send().await?;
// POST = explicit quota body
http_client.post(base_url.join("generate_signup_token")?)
    .header("X-Admin-Password", &self.admin_password).json(quota).send().await?;
// GET /info -> body["public_key"] becomes homeserverPubky
```

<sub>Source: [`src/shared/homeserver_admin_api.rs`](https://github.com/pubky/homegate/blob/master/src/shared/homeserver_admin_api.rs). Token minting itself is the homeserver's job — see [`homeserver.md`](homeserver.md).</sub>

> Only the **IP** route can attach an explicit quota (`POST`). SMS and Lightning always use `GET`
> (homeserver system defaults).

## Routes

Default listen `0.0.0.0:8080`; each group is mounted only with its config section. Full
request/response shapes live in
[`openapi.yaml`](https://github.com/pubky/homegate/blob/master/openapi.yaml) (AI-generated — verify
against source).

```http
GET  /                            # "Homegate Service"
POST /sms_verification/send_code
POST /sms_verification/validate_code
GET  /sms_verification/info
POST /ln_verification
GET  /ln_verification/{id}
GET  /ln_verification/{id}/await
GET  /ln_verification/info        # /price = deprecated alias (Franky back-compat)
POST /ip_verification
```

### SMS (Prelude)

1. `POST /sms_verification/send_code` `{phoneNumber, dispatchId?}` — `phoneNumber` is E.164
   (`^\+[1-9]\d{1,14}$`). Sends a code via Prelude; returns **200 with an empty body** (an
   existing pending verification is reused if one exists).
2. `POST /sms_verification/validate_code` `{phoneNumber, code}` — `code` is exactly 6 digits.
   Returns 200 with `{valid:"true", signupCode, homeserverPubky}` on success, or `{valid:"false"}`
   on a wrong code.

> `valid` is a **string** (`"true"`/`"false"`), not a JSON boolean.

```toml
[sms_verification]
prelude_api_key = "your-prelude-api-key"        # required
# prelude_api_url = "https://api.prelude.dev"   # default
# max_verifications_per_week = 2
# max_verifications_per_year = 4
# max_failed_validation_attempts = 5            # guards vs Prelude silently failing after N wrong codes
# limit_whitelist = []                          # phone numbers exempt from rate limits
```

### Lightning (phoenixd)

1. `POST /ln_verification` (no body) → `{id, bolt11Invoice, amountSat, expiresAt}` (`expiresAt`
   is unix ms). The user pays the BOLT11 invoice.
2. Poll `GET /ln_verification/{id}` →
   `{id, amountSat, expiresAt, isPaid, signupCode, homeserverPubky, createdAt}` (`signupCode` is
   `null` until paid), **or** long-poll `GET /ln_verification/{id}/await`, which blocks until
   payment confirms (or times out — the client should retry).
3. `GET /ln_verification/info` → `{amountSat}` (the configured price). `/price` is a deprecated
   alias.

> **`/await` timeout is 25 s, not 60 s.** `openapi.yaml` documents 60 s (and a 408 after 60 s),
> but the code uses `DEFAULT_TIMEOUT_SECS = 25` (below typical 30 s reverse-proxy timeouts) and
> returns **408 "Long poll timeout. Please try again."** Trust the code.

```rust
/// Set to 25 seconds to be below common reverse proxy timeouts (30 seconds)
const DEFAULT_TIMEOUT_SECS: u64 = 25;
```

<sub>Source: [`src/ln_verification/http.rs`](https://github.com/pubky/homegate/blob/master/src/ln_verification/http.rs)</sub>

```toml
[ln_verification]
phoenixd_api_url = "http://localhost:9740"        # required
phoenixd_api_password = "your-phoenixd-password"  # required
# invoice_price_sat = 1000
# invoice_expiry_seconds = 600                     # 10 min
# invoice_description = "Pubky Homegate Verification"
```

### IP

`POST /ip_verification` (no body) → `{signupCode, homeserverPubky}` immediately if the caller's IP
is under its weekly/annual limits. This is the low-friction alternative to SMS/LN.

| Status | Meaning |
| :-- | :-- |
| 404 | `[ip_verification]` section absent (route not mounted) |
| 400 | client IP couldn't be determined |
| 429 | per-IP limit exceeded |
| 500 | "Homeserver temporarily unavailable, please retry" (token minting failed) |

```toml
[ip_verification]
# max_verifications_per_week = 2
# max_verifications_per_year = 4
# limit_whitelist = []                  # IpAddr list (v4/v6) exempt from limits

[ip_verification.signup_quota]          # OPTIONAL, IP route only — see below
storage_quota_mb = 64
rate_read = "1mb/s"
rate_read_burst = 10
rate_write = "1mb/s"
rate_write_burst = 10
allowed_write_paths = ["/pub/"]
```

`[ip_verification.signup_quota]` exists **only** for the IP route: present → mint via
`POST /generate_signup_token` (with quota); absent → `GET` (homeserver defaults). SMS and LN have
no quota option.

> `allowed_write_paths` defaults to `["/pub/"]`, the only shipped storage namespace. **Do not
> present it as supporting private paths** — only public `/pub` exists today and the `/pub` layout
> is not stabilized. See
> [`../../pubky/references/shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

**Client IP determination.** By **default** only the TCP socket peer address is used. **Only when
`accept_proxy_ip_headers = true`** does Homegate trust proxy headers: it prefers `X-Forwarded-For`
taking the **rightmost** valid IP (the entry added by the closest trusted proxy, hardest to
spoof), then `X-Real-IP`, then the socket address.

```rust
// rightmost valid IP from X-Forwarded-For
headers.get(X_FORWARDED_FOR)
    .and_then(|hv| hv.to_str().ok())
    .and_then(|s| s.rsplit(',').find_map(|s| s.trim().parse::<IpAddr>().ok()))
```

<sub>Source: [`src/infrastructure/http/extractors/request_origin.rs`](https://github.com/pubky/homegate/blob/master/src/infrastructure/http/extractors/request_origin.rs)</sub>

> **Only enable `accept_proxy_ip_headers` behind a reverse proxy that authoritatively
> sets/overwrites `X-Forwarded-For`.** Otherwise a client supplies any IP and bypasses limits.

**IP rate limiting is inherently weak — never make it the sole anti-spam defence** (the source
says so). Three documented failure modes:

- **Header spoofing** — if the proxy doesn't set `X-Forwarded-For` authoritatively, a client
  supplies any IP and bypasses limits.
- **Shared IPs** — CGNAT, corporate proxies, VPNs: many users collectively exhaust one IP's limit.
- **Rotating IPs** — botnets, cloud instances trivially circumvent per-IP limits.

**Concurrency safety.** IP verification runs inside a Postgres transaction holding
`pg_advisory_xact_lock` keyed on a Blake3-derived `i64` of the IP hash (serializing concurrent
requests for the **same** IP while different IPs proceed in parallel). It checks limits, mints the
homeserver token **while still holding the lock**, inserts the row, then commits — so a
verification row is never recorded without a valid signup code.

## Rate limits

Rolling windows counted from prior verifications' `created_at` for the same hash: **weekly = last
7 days, annual = last 365 days**. Defaults are **2/week and 4/year** for both SMS and IP.
`limit_whitelist` entries skip the rate-limit check entirely.

## Operational notes

- **`info` endpoints** (`GET /sms_verification/info`, `GET /ln_verification/info`) let the Pubky
  frontend ("Franky") check which verification methods are available. Country **geo-blocking is
  done at the nginx layer, not by Homegate.**
- **CORS:** `allow_cors = true` enables a permissive layer (any origin/method/headers).
- **Deploy:** a multi-stage Dockerfile builds the binary into an `alpine:3.20` runtime with only
  `ca-certificates`. **Mount the data dir** (`config.toml` + `pepper.txt`) into the container and
  match the published port to `http_listen_socket`.

```bash
FROM rust:1.89.0-alpine3.20 AS builder
RUN cargo build --release --bin homegate
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=builder /usr/src/app/target/release/homegate /usr/local/bin/homegate
EXPOSE 8080
CMD ["homegate"]
```

<sub>Source: [`Dockerfile`](https://github.com/pubky/homegate/blob/master/Dockerfile)</sub>

## Upstream

- Repo + README: <https://github.com/pubky/homegate>
- API spec (AI-generated, verify against source): <https://github.com/pubky/homegate/blob/master/openapi.yaml>
- SMS provider [Prelude](https://docs.prelude.so/) · Lightning provider [phoenixd](https://github.com/ACINQ/phoenixd)
