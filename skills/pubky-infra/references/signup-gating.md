# Signup gating (Homegate)

[Homegate](https://github.com/pubky/homegate) is a separate Rust service (its own process) that gates who gets a homeserver **signup token**. A client proves itself by **SMS**, **Lightning payment** or **IP**. Homegate then mints a token through the homeserver admin API and returns it as `signupCode`. The Pubky social app runs its onboarding (`https://pubky.app/onboarding/human`) through it.

Link, don't restate:

- **How a client uses the token** (`signer.signup(homeserverPk, signupToken)`, or `null` for open or testnet homeservers): [`auth.md`](../../pubky/references/auth.md#signup-tokens).
- **The admin endpoints Homegate calls** (`GET /info`, `GET`/`POST /generate_signup_token`, `X-Admin-Password`, the `UserQuota` body): [`homeserver.md`](homeserver.md#signup-tokens-and-quotas).

> **Release vs `master`.**
> - **Latest release: v0.2.0** (tag `ea838a8`, 2026-06-18). Deploy the Docker image **`synonymsoft/homegate:v0.2.0`**.
> - **GitHub releases are unpublished drafts** (v0.1.0 and v0.2.0, one glibc linux-amd64 binary each). Don't send operators there.
> - **v0.2.0 ships SMS, Lightning and IP.** Google verification is `master`-only ([below](#unreleased-google-verification-master-only)).
> - **The version string doesn't identify the build.** `Cargo.toml` on `master` still says `0.2.0`.
> - **Pre-1.0:** request and response shapes may change.

## Routes are opt-in per config section

A route is mounted only when its config section is present. Without it, requests get **404**.

| Route | Config section | External dependency |
| :-- | :-- | :-- |
| `/sms_verification` | `[sms_verification]` | [Prelude](https://docs.prelude.so/) (SMS) |
| `/ln_verification` | `[ln_verification]` | [phoenixd](https://github.com/ACINQ/phoenixd) (Lightning) |
| `/ip_verification` | `[ip_verification]` (an empty section is enough) | none |

```rust
if let Some(sms) = &config.sms_verification {
    tracing::info!("SMS verification enabled");
    app = app.nest(
        "/sms_verification",
        router(homeserver_api, sms, db.clone(), hasher.clone()).await?,
    );
}
if let Some(ln) = &config.ln_verification {
    tracing::info!("Lightning verification enabled");
    app = app.nest(
        "/ln_verification",
        ln_verification::router(homeserver_api, ln, db.clone()).await?,
    );
}
if let Some(ip) = &config.ip_verification {
    tracing::info!("IP verification enabled");
    app = app.nest(
        "/ip_verification",
        ip_verification::router(homeserver_api, ip, db.clone(), hasher.clone()).await?,
    );
}
```

<sub>Source: [`src/infrastructure/http/server.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/http/server.rs#L40-L60). `master` adds one more block, for `/google_verification`.</sub>

> **Config typos fail silently.** No config struct uses `deny_unknown_fields`:
> - A misspelled section (e.g. `[ip_verifcation]`) is ignored, so its route returns 404.
> - A misspelled **optional** key falls back to its default. A misspelled **required** key (e.g. `prelude_api_key`) fails startup with `missing field`.
> - A section the build doesn't support (e.g. `[google_verification]` on v0.2.0) is ignored.
>
> After startup, check the log for the `... verification enabled` lines.

**Other server behavior:**
- **`allow_cors = true`** adds a fully permissive CORS layer (any origin, method and header).
- **`GET /`** returns the text `Homegate Service`.
- **No TLS.** Plain HTTP only; terminate TLS at a reverse proxy.

## Startup and configuration

The only CLI flag is `--data-dir`, the directory holding `config.toml`, `pepper.txt` and other data (`cargo run -- --data-dir /path/to/data`). Startup runs in this order, and each step can stop the process:

1. **Data dir.** `--data-dir` defaults to `$HOME/.homegate`. Homegate panics if `$HOME` is unset, **even when `--data-dir` is given**. The directory must **already exist**, or startup fails with `Data directory '<p>' does not exist`.
2. **`config.toml`.** If `<data-dir>/config.toml` is missing, Homegate writes the bundled example there and **exits** ("No config file found. A template has been created at '<p>' — please edit it and restart.").
3. **Logging** starts.
4. **Pepper.** `<data-dir>/pepper.txt` is read, or generated if missing ([details](#the-pepper-secret)). This runs *before* the homeserver check, so a first start that fails later still leaves a new pepper behind.
5. **Homeserver check.** `GET <admin_api_url>/info` with `X-Admin-Password`, reading `public_key`. A wrong password, unreachable homeserver or missing `public_key` → `exit(1)`.
6. **Postgres.** Connects to `database_url` and runs migrations.
7. **Router.** Building it starts the Lightning background sync if Lightning is enabled, so an unreachable phoenixd exits the process ([Lightning](#lightning-phoenixd)).
8. **Serve.** Binds `http_listen_socket` and runs until Ctrl+C.

| Key | Required / default | Notes |
| :-- | :-- | :-- |
| `database_url` | **required** | `postgres://` or `postgresql://` scheme |
| `[homeserver] admin_api_url` | **required** | Bare origin, e.g. `http://homeserver:6288` ([gotcha](#token-minting)) |
| `[homeserver] admin_password` | **required** | Sent as `X-Admin-Password` |
| `http_listen_socket` | `0.0.0.0:8080` | |
| `allow_cors` | `false` | |
| `accept_proxy_ip_headers` | `false` | See [client IP](#client-ip-and-proxies) |
| `[logging]` | optional | `level` (default `info`; `trace`/`debug`/`info`/`warn`/`error`/`off`), `module_levels` e.g. `["hyper=warn"]` |

Start from the template for your release, not a hand-written config: [`config.toml.example` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example). The `master` template has an extra `[google_verification]` block that v0.2.0 silently ignores.

## PostgreSQL backing

- **Use a separate database**, not the homeserver's PostgreSQL. Homegate reaches the homeserver only through the admin HTTP API.
- **Create the database first.** Homegate creates tables, not the database.
- **Migrations run on every start**, each in its own transaction, tracked in a `migrations` table. A failure aborts startup with `Migration failed: ...`.
- **All tables are created regardless of enabled routes.** Schema: [`src/infrastructure/sql`](https://github.com/pubky/homegate/tree/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/sql).

| Table | Holds |
| :-- | :-- |
| `sms_verifications` | `phone_number_hash`, `prelude_id`, `status` (`PENDING`/`VERIFIED`/`FAILED`), `attempts`, `signup_code`, `failure_reason`, timestamps |
| `lightning_verifications` | `id` (uuid), `payment_hash` (unique), `amount_sat`, `signup_code`, `expires_at`, `finalised_at`, `created_at` |
| `ip_verifications` | `ip_address_hash`, `signup_code`, `created_at` |
| `google_verifications` | **`master` only**: `google_identity_hash`, … |

- **Identifiers are stored only as hashes.** Phone numbers and IPs are Argon2id digests salted from the [pepper](#the-pepper-secret).
- **Tests don't read `config.toml`.** They use `DATABASE_URL` with `sqlx::test`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pubky_homegate?pubky-test=true cargo test
# HTTP (E2E) tests only: cargo test http::tests
```

The README's `--lib e2e::` hint fails: the crate is binary-only (`no library targets found`), and `e2e::` holds only wiremock helpers (0 tests).

## The pepper secret

`<data-dir>/pepper.txt` holds **64 hex characters**: 32 bytes from `getrandom`, hex-encoded.

- **Load-or-create runs on every start**, even when no hashing route is enabled. A new pepper is generated **only if the file is missing** (log: `Generated new pepper at: <path>`).
- **Malformed file → panic.** After trimming it must be exactly 64 hex chars (`Pepper file should contain a 64 character hex string`). Unreadable → `Failed to read pepper file`.
- **Homegate doesn't restrict permissions.** `fs::write` follows the umask, and the Docker image runs as root. `chmod 600 pepper.txt`, or mount it with tight permissions. (Inferred from the code; upstream doesn't say it.)

> **Losing or regenerating the pepper silently resets every rate limit.** Per the upstream README, Homegate can no longer match requests to already-verified phone numbers, so limits stop being enforced. The same applies to IP hashes (and Google hashes on `master`). A non-persistent data volume regenerates the pepper whenever the container is recreated.

> **Back up the pepper, but never alongside the DB dump.** It protects the hashes if the database leaks: once the salt is known, phone numbers are feasible to brute-force (the E.164 space is small), even at >100 ms per Argon2id guess. Keep it in separate secret storage.

**Hashing:** Argon2id, OWASP parameters (19 MiB, t=2, p=1, 32-byte output), deliberately >100 ms per hash.
- **The salt is deterministic:** the first 16 bytes of `blake3(pepper)`. The same identifier always yields the same digest, which is what makes lookup and rate limiting by hash work.
- **The pepper only feeds the salt.** It is not a separate HMAC key.

```rust
let params = ParamsBuilder::new()
    .m_cost(19456)
    .t_cost(2)
    .p_cost(1)
    .output_len(32)
    .build()
    .expect("Failed to build Argon2 params");

let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
// ...
// Derive deterministic salt from pepper using Blake3
let salt_bytes = blake3::hash(self.pepper.as_bytes());
let salt = SaltString::encode_b64(&salt_bytes.as_bytes()[..16])
    .expect("Salt encoding should never fail with valid Blake3 output");
```

<sub>Source: [`src/shared/hasher_argon2id.rs` @ `master` 292ce68](https://github.com/pubky/homegate/blob/292ce68108c066fd5c3533b8629d0dd2b1566e61/src/shared/hasher_argon2id.rs#L28-L64)</sub>

> **Raw identifiers still reach the logs.** The SMS `send_code` "Retry" path logs `phone_number` in plain text at `info`, and a non-empty SMS or IP `limit_whitelist` is logged unhashed at startup. (Rate-limit warnings log only the hash.) Treat logs as personal data.

## Token minting

Homegate calls `generate_signup_token` on the admin API one of two ways ([endpoint details](homeserver.md#signup-tokens-and-quotas)):

| Call | Quota | Used by |
| :-- | :-- | :-- |
| `GET generate_signup_token` | Homeserver system defaults | SMS, Lightning, IP without `signup_quota` (and Google on `master`) |
| `POST generate_signup_token` + JSON quota | Explicit `UserQuota` (homeserver v0.8.0+) | IP with `[ip_verification.signup_quota]` |

- **Response:** the plain-text body becomes `signupCode`.
- **Failure:** surfaces as **500** "Homeserver temporarily unavailable, please retry".
- **`homeserverPubky`:** every route returns the `/info` `public_key` unchanged. That is **raw z-base-32** (`public_key().z32()`), **not** the `pubky<z32>` display form. Parse it as z32; never string-compare it with `toString()` output ([key formats](../../pubky/references/concepts.md#public-key-string-formats)).

> **`admin_api_url` and `phoenixd_api_url` must be bare origins.** Paths are joined with `url::Url::join`:
> - **`/info`, `/createinvoice`, `/payments/incoming`, `/websocket`** are absolute joins, which drop any path prefix.
> - **`generate_signup_token`** is a relative join, which replaces the last path segment unless the URL ends in `/`.
>
> A prefixed URL such as `https://proxy/admin` breaks. (Inferred from `url::Url::join` semantics; upstream has no test for it.)

## HTTP API

**Error bodies are `text/plain` strings, not JSON.** Shapes: [`openapi.yaml` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml), but treat the Rust source as ground truth: the spec's header says it is **AI-generated and may be inaccurate**, and its `servers` entry `https://api.example.com` is a placeholder.

```http
GET  /                                  # text "Homegate Service"
POST /sms_verification/send_code
POST /sms_verification/validate_code
GET  /sms_verification/info             # empty 200
POST /ln_verification
GET  /ln_verification/{id}
GET  /ln_verification/{id}/await
GET  /ln_verification/info              # {amountSat}
GET  /ln_verification/price             # legacy alias kept for Franky; not in openapi.yaml
POST /ip_verification
# master only (unreleased): POST /google_verification
```

The web frontend ("Franky") calls the `info` endpoints to check that a method is available. **Homegate has no country geo-blocking.** Upstream's deployment does it in nginx; add it at your proxy if you need it.

**Known `openapi.yaml` drift:**
- **`/ln_verification/{id}/await` timeout:** spec says 60 s; code uses **25 s**.
- **`/ln_verification/price`** is undocumented.
- **`validate_code`:** the **429** (too many attempts) is undocumented, and the **500** is documented only generically, without its "Homeserver temporarily unavailable" body.
- **`/google_verification` on `master`:** the spec claims a 20 KiB body limit, unknown-field rejection and a 400 `invalid_request`. None is implemented; Axum's default rejections apply.

### Abuse: rate-limit requests at the proxy

Homegate has **no per-request rate limiting**. Add it at the reverse proxy (e.g. nginx `limit_req`):

- **`POST /ip_verification`, `/sms_verification/send_code`, `/sms_verification/validate_code`:** each unauthenticated request computes a full Argon2id hash (19 MiB, >100 ms) **before** any limit check, synchronously in the async handler (no `spawn_blocking`). Requests that end in 429 still pay for it.
- **`POST /ln_verification`:** unauthenticated and unlimited; every call creates a phoenixd invoice and a database row.

### SMS (Prelude)

**`POST /sms_verification/send_code`** takes `{phoneNumber, dispatchId?}`. `phoneNumber` must be E.164 (`^\+[1-9]\d{1,14}$`).

1. **Check.** Hashes the number and checks the weekly and annual limits (skipped for `limit_whitelist`).
2. **Send.** Calls Prelude, forwarding client IP, User-Agent and `dispatchId` as fraud signals.
3. **Record.** Upserts a `PENDING` row. An older `PENDING` row with a different `prelude_id` is marked `FAILED` (`superseded_by_new_session`).

Returns **200 with an empty body**, including when Prelude answers "retry".

| Status | Body (text) | Cause |
| :-- | :-- | :-- |
| 422 | contains "Invalid phone number format. Must be in E.164 format" | Bad format (Axum JSON rejection, so match on "contains"), or Prelude rejects the number |
| 403 | "Phone number blocked for verification" | Blocked by Prelude or by region |
| 429 | "Phone number has exceeded weekly/annual verification limit" | Per-number limit |
| 429 | "External service rate limit exceeded" | Prelude returned 429; `Retry-After` copied through when present |
| 500 | | Prelude request, database or homeserver failure |

**`POST /sms_verification/validate_code`** takes `{phoneNumber, code}`; `code` is exactly 6 digits.

| Result | Response |
| :-- | :-- |
| Correct code | **200** `{"valid":"true","signupCode":…,"homeserverPubky":…}`; session marked `VERIFIED` |
| Wrong code | **200** `{"valid":"false"}`; client may retry |
| No `PENDING` session, or Prelude session expired | **422** "No active verification session for phone number" |
| Attempts > `max_failed_validation_attempts` (default 5) | **429** "Too many incorrect code attempts. Please request a new verification code." |
| Homeserver down while minting | **500** "Homeserver temporarily unavailable, please retry" |

> **Two ways a session dies (client must call `send_code` again):**
> - **Too many attempts.** The counter increments *before* the check, so with the default of 5 the **6th call returns 429 even with the right code**. Pending sessions are marked `FAILED`.
> - **Homeserver down while minting.** The session is also marked `FAILED`.

> **`valid` is a string, not a boolean** (internally tagged serde enum). Compare `valid === "true"`; never test truthiness, because `"false"` is truthy.

```rust
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "valid")]
pub enum ValidateCodeResponse {
    #[serde(rename = "true")]
    Valid {
        #[serde(rename = "signupCode")]
        signup_code: String,
        #[serde(rename = "homeserverPubky")]
        homeserver_pubky: String,
    },
    #[serde(rename = "false")]
    Invalid,
}
```

<sub>Source: [`src/sms_verification/types.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/sms_verification/types.rs#L28-L40)</sub>

| `[sms_verification]` key | Required / default |
| :-- | :-- |
| `prelude_api_key` | **required** |
| `prelude_api_url` | `https://api.prelude.dev` |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |
| `max_failed_validation_attempts` | `5` (upstream: Prelude seems to fail silently after 5 failures however it is configured) |
| `limit_whitelist` | `[]` (E.164 numbers, validated at parse time) |

The README's "maximum of 10 verifications" per number is **not enforced by Homegate**; it may be a Prelude-side limit. Homegate enforces the configurable values above.

### Lightning (phoenixd)

1. **`POST /ln_verification`** (no body) creates a phoenixd invoice → **200** `{id, bolt11Invoice, amountSat, expiresAt}` (`id` UUID; `expiresAt` unix ms).
2. **Poll `GET /ln_verification/{id}`.** Unless already finalised, re-syncs the invoice with phoenixd. Returns `{id, amountSat, expiresAt, isPaid, signupCode|null, homeserverPubky, createdAt}`. Unknown id → **404** "Not found"; malformed UUID → **400**.
3. **Or long-poll `GET /ln_verification/{id}/await`.** On timeout → **408** "Long poll timeout. Please try again."; call it again.

> **`isPaid` means finalised: paid *and* a token minted.** If the homeserver is down when a paid invoice syncs, `GET /ln_verification/{id}` returns **500** "Homeserver temporarily unavailable, please retry" and the invoice stays unfinalised until a later sync succeeds. Clients must **retry**, not show "unpaid".

> **The `/await` timeout is 25 s, not openapi.yaml's 60 s.** Keep proxy read timeouts above 25 s.

```rust
/// Default timeout for long-polling verification requests
/// Set to 25 seconds to be below common reverse proxy timeouts (30 seconds)
/// This way, you don't have to deal with proxy timeouts like nginx cutting the connection
/// before the application can respond with a timeout message.
const DEFAULT_TIMEOUT_SECS: u64 = 25;
```

<sub>Source: [`src/ln_verification/http.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/ln_verification/http.rs#L21-L25)</sub>

**Background sync.** Connects to phoenixd's `/websocket` (HTTP basic auth: empty username, `phoenixd_api_password`), finalises paid invoices missed while offline (pages of 100), then finalises live as payment events arrive.

- **Errors exit the process.** A phoenixd, websocket or database error calls `process::exit(1)`. Run under a restart policy (Docker `restart:`, systemd).
- **A clean websocket close neither reconnects nor exits.** The task logs `Websocket closed` (warn) and stops, so a restart policy never fires; until the next restart, invoices finalise only when a client polls `GET /{id}` or `/await`. **Alert on that log line.**
- **Catch-up can stop silently.** If the homeserver is unavailable during catch-up, the loop is cut short; those invoices finalise only when polled.
- **No per-identity limit, no hashing.** The payment is the cost. Still add [proxy rate limiting](#abuse-rate-limit-requests-at-the-proxy).

| `[ln_verification]` key | Required / default |
| :-- | :-- |
| `phoenixd_api_url` | **required** (bare origin) |
| `phoenixd_api_password` | **required** |
| `invoice_price_sat` | `1000` |
| `invoice_expiry_seconds` | `600` |
| `invoice_description` | `"Pubky Homegate Verification"` |

### IP

**`POST /ip_verification`** (no body): if the client IP is under its limits, returns **200** `{signupCode, homeserverPubky}` immediately.

| Status | Body (text) / cause |
| :-- | :-- |
| 400 | "Could not determine client IP address" |
| 404 | `[ip_verification]` absent |
| 429 | "IP address has exceeded weekly verification limit" / "...annual verification limit" (homeserver not called) |
| 500 | "Homeserver temporarily unavailable, please retry", or a database error |

| `[ip_verification]` key | Default |
| :-- | :-- |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |
| `limit_whitelist` | `[]` (IPv4/IPv6 addresses) |
| `[ip_verification.signup_quota]` | absent → tokens minted with `GET` and homeserver defaults |

#### Signup quota (IP only)

`signup_quota` accepts `storage_quota_mb`, `rate_read`, `rate_read_burst`, `rate_write`, `rate_write_burst` and `allowed_write_paths`, all optional. Homegate passes set fields through unchanged and omits unset ones; the homeserver decides what omitted fields mean ([`UserQuota`](homeserver.md#signup-tokens-and-quotas)).

- **Omitted `allowed_write_paths` = unrestricted writes, not `["/pub/"]`.** Homegate has no default; the `["/pub/"]` in `config.toml.example` is just an example. `[]` means read-only.
- **Invalid quotas fail on every request, not at startup.** Homegate doesn't validate the quota, but the homeserver rejects some with 422 — for example a zero burst, a burst without its rate, `/` in `allowed_write_paths`, or duplicate paths. Each IP request then returns 500 "Homeserver temporarily unavailable, please retry". After changing the quota, send one test request.
- **Storage can't be "unlimited" from Homegate.** `storage_quota_mb` is a plain `u64`, so the homeserver's `"unlimited"` value is unexpressible.
- **Keep write paths under `/pub/`** (the shipped storage root; its layout is not stabilized). Don't grant `/priv` paths to production signups: `/priv` is **alpha** (pubky-homeserver v0.10.0+), **not for production**, and access-controlled but **not encrypted from the operator**.

#### Client IP and proxies

By default Homegate uses **only the TCP peer address**. With `accept_proxy_ip_headers = true` it takes the **rightmost** valid IP in `X-Forwarded-For`, then `X-Real-IP`, then the peer address. The same client IP is forwarded to Prelude on SMS `send_code`.

```rust
fn maybe_x_forwarded_for(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get(X_FORWARDED_FOR)
        .and_then(|hv| hv.to_str().ok())
        .and_then(|s| s.rsplit(',').find_map(|s| s.trim().parse::<IpAddr>().ok()))
}
// ...
let ip = if parts.extensions.get::<AcceptProxyIpHeaders>().is_some() {
    let headers = HeaderMap::from_request_parts(parts, state).await?;
    maybe_x_forwarded_for(&headers)
        .or_else(|| maybe_x_real_ip(&headers))
        .or(socket_ip)
} else {
    socket_ip
};
```

<sub>Source: [`src/infrastructure/http/extractors/request_origin.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/http/extractors/request_origin.rs#L31-L65)</sub>

- **Flag off behind a proxy:** every client appears as the proxy's IP and shares one limit.
- **Flag on:** only behind a proxy that **sets or appends `X-Forwarded-For` itself** (nginx `$proxy_add_x_forwarded_for` or `$remote_addr`). `X-Forwarded-For` wins over `X-Real-IP`, so a proxy that sets only `X-Real-IP` and passes a client's `X-Forwarded-For` through lets clients spoof any IP.
- **Multiple hops** (CDN → nginx): the rightmost entry is the CDN edge, so all clients share a few IPs. Make the last proxy write the real client address.
- **IPv6:** every address hashes separately, so one /64 gives effectively unlimited identities.
- **Never rely on IP limiting alone** (upstream agrees). CGNAT, corporate proxies and VPNs make many users share one limit, while botnets and cloud hosts rotate IPs.

## Rate-limit semantics

Windows are rolling and fixed: **7 days** (weekly) and **365 days** (annual).

| | SMS | IP |
| :-- | :-- | :-- |
| When checked | at `send_code` only | at `POST /ip_verification` |
| What counts | only `VERIFIED` sessions, by `finalised_at` (pending/failed don't count) | every recorded issuance, by `created_at` |
| Concurrency | no lock or transaction | serialized per identity (below) |
| `limit_whitelist` | skips the check | skips the check, but the issuance is **still recorded** |

**IP issuance** runs in one Postgres transaction:
1. **Lock:** `pg_advisory_xact_lock(key)` on an `i64` from `blake3(identity_hash)`. Same IP serializes; different IPs run in parallel.
2. **Check limits** (skipped for whitelisted addresses).
3. **Mint the token** while the lock is held.
4. **Insert** the row, then **commit**.

A verification is never recorded without a valid signup code. Minting inside the transaction has two side effects:

- **A token can exist without a record.** If the insert or commit fails after minting, the token was issued but never counted.
- **A slow homeserver can stall every route.** The admin call holds a pooled Postgres connection and an open transaction, which can exhaust the pool.

## Deploy

- **Image:** pin **`synonymsoft/homegate:v0.2.0`** (linux/amd64, linux/arm64). Images build only from `v*.*.*` tags, so none contains unreleased `master` code. [`Dockerfile`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/Dockerfile): `rust:1.89.0-alpine3.20` builder, `alpine:3.20` runtime with only `ca-certificates`, `EXPOSE 8080`, `CMD ["homegate"]`.
- **Data dir:** no `USER`, so it runs as **root** with default data dir **`/root/.homegate`**. Mount a **persistent** volume holding `config.toml` and `pepper.txt` there (or pass `--data-dir`), and create the directory before first start.
- **Port:** publish the port matching `http_listen_socket`.
- **Reachable at startup:** Postgres; the homeserver admin API (`:6288`, kept off the public network — [homeserver.md](homeserver.md#security-guardrails)); phoenixd if Lightning is enabled.
- **Reverse proxy:** terminate TLS; add [per-request limits](#abuse-rate-limit-requests-at-the-proxy); set `X-Forwarded-For` correctly ([client IP](#client-ip-and-proxies)); keep read timeouts above 25 s.
- **Supervision:** use a restart policy (startup failures and Lightning sync errors exit the process), and **alert on `Websocket closed`**, which a restart policy won't catch.

## Unreleased: Google verification (`master` only)

**Not in v0.2.0 or any Docker image. Do not present it as available to release users.** Merged upstream after v0.2.0 (PR #30).

On `master`, `POST /google_verification` takes `{googleIdToken}`, enabled by `[google_verification]`:
- **Config:** `google_client_id` required; `max_verifications_per_week`/`max_verifications_per_year` default to 2 and 4.
- **Verification:** RS256 ID token checked against Google's JWKS, with `aud` = `google_client_id` and `iss` = `accounts.google.com` or `https://accounts.google.com`.
- **Rate limiting:** on an Argon2id hash of `iss` and `sub`, via the same transactional issuer as IP.
- **Errors** (`text/plain` codes): 401 `invalid_google_id_token`; 429 `weekly_limit_exceeded`/`annual_limit_exceeded`; 500 `homeserver_unavailable`, `google_verifier_unavailable` or `internal_error`.

Source: [`src/google_verification/`](https://github.com/pubky/homegate/tree/292ce68108c066fd5c3533b8629d0dd2b1566e61/src/google_verification).

> **Never set `HOMEGATE_GOOGLE_JWKS_URL` in production.** It overrides the JWKS URL for mocks and manual testing; whoever controls it can supply their own keys and forge ID tokens Homegate accepts.

## Upstream

- **Repo and README:** <https://github.com/pubky/homegate>
- **Example config (v0.2.0):** [`config.toml.example`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example)
- **API spec (v0.2.0):** [`openapi.yaml`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml) — AI-generated; verify against the source.
- **Docker image:** [`synonymsoft/homegate`](https://hub.docker.com/r/synonymsoft/homegate)
- **Providers:** [Prelude](https://docs.prelude.so/), [phoenixd](https://github.com/ACINQ/phoenixd)
