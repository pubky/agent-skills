# Signup gating (Homegate)

[Homegate](https://github.com/pubky/homegate) is a separate Rust service, running as its own process, that decides who gets a homeserver **signup token**. A client proves itself by **SMS**, **Lightning payment** or **IP**. Homegate then mints a token through the homeserver admin API and returns it as `signupCode`. The Pubky social app runs its onboarding (`https://pubky.app/onboarding/human`) through Homegate.

Link, don't restate:

- **How a client uses the token** (`signer.signup(homeserverPk, signupToken)`, or `null` for open or testnet homeservers): [`auth.md`](../../pubky/references/auth.md#signup-tokens).
- **The admin endpoints Homegate calls** (`GET /info`, `GET`/`POST /generate_signup_token`, `X-Admin-Password`, the `UserQuota` body and its validation rules): [`homeserver.md`](homeserver.md#signup-tokens-and-quotas).

> **Release vs `master`** (checked 2026-10-26; `master` HEAD `7623d8a`, whose only change since `292ce68` is CI):
> - **Latest release: v0.2.0** (commit `ea838a8`, 2026-06-18). Deploy the Docker image **`synonymsoft/homegate:v0.2.0`**.
> - **Pin the version tag, not `latest`.** Today `latest` points at v0.2.0, but the next release moves it.
> - **Don't use the `v0.1.0` image.** It was built from commit `887e4d5`, not from the git tag `v0.1.0` (`9e57814`).
> - **GitHub releases are unpublished drafts** (v0.1.0 and v0.2.0, one linux-amd64 binary each). Don't send operators there.
> - **v0.2.0 ships SMS, Lightning and IP.** Google verification is `master`-only ([below](#unreleased-google-verification-master-only)).
> - **The version string doesn't identify the build.** `Cargo.toml` on `master` still says `0.2.0`.
> - **Pre-1.0:** request and response shapes may change.

## Routes are opt-in per config section

A route is mounted only when its config section is present. Without the section, requests to the route get **404**.

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

<sub>Source: [`src/infrastructure/http/server.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/http/server.rs#L40-L60) (verbatim; also matches `master`). `master` adds one more block, for `/google_verification`.</sub>

> **Config typos fail silently.** No config struct uses `deny_unknown_fields`, so:
> - A misspelled section (e.g. `[ip_verifcation]`) is ignored, and its route returns 404.
> - A misspelled **optional** key falls back to its default. A misspelled **required** key (e.g. `prelude_api_key`) stops startup with `missing field`.
> - A section the build doesn't support (e.g. `[google_verification]` on v0.2.0) is ignored.
>
> After startup, check the log for the `... verification enabled` lines.

**Other server behavior:**
- **`allow_cors = true`** adds a fully permissive CORS layer (any origin, method and header).
- **`GET /`** returns the text `Homegate Service`.
- **No TLS.** Homegate serves plain HTTP only. Terminate TLS at a reverse proxy.

## Startup and configuration

The only CLI flag is `--data-dir`. It names the directory that holds `config.toml` and `pepper.txt`. Startup runs in this order, and any step can stop the process:

1. **Data dir.** `--data-dir` defaults to `$HOME/.homegate`. Homegate panics if `$HOME` is unset, **even when you pass `--data-dir`**. The directory must **already exist**. Otherwise startup fails with `Data directory '<p>' does not exist` (or `is not a directory`).
2. **`config.toml`.** If `<data-dir>/config.toml` is missing, Homegate writes the bundled example there and **exits** ("No config file found. A template has been created at '<p>' — please edit it and restart.").
3. **Logging** starts.
4. **Pepper.** Homegate reads `<data-dir>/pepper.txt`, or generates it if missing ([details](#the-pepper-secret)). This happens *before* the homeserver check, so a first start that fails at a later step still leaves a new pepper behind.
5. **Homeserver check.** Homegate calls `GET <admin_api_url>/info` with `X-Admin-Password` and reads `public_key`. A wrong password, an unreachable homeserver or a missing `public_key` → `exit(1)`.
6. **Postgres.** Homegate connects to `database_url` and runs migrations ([PostgreSQL](#postgresql-backing)).
7. **Router.** If Lightning is enabled, building the router spawns the Lightning background sync as a separate task. If phoenixd is unreachable, that task exits the process shortly after startup, **possibly after the port is bound and `Homegate HTTP listening` is logged** ([Lightning](#lightning-phoenixd)). A clean listening log line does not prove Lightning works.
8. **Serve.** Homegate binds `http_listen_socket` and runs until Ctrl+C (SIGINT).

| Key | Required / default | Notes |
| :-- | :-- | :-- |
| `database_url` | **required** | `postgres://` or `postgresql://` only ("Only postgres database urls are supported") |
| `[homeserver] admin_api_url` | **required** | Bare origin, e.g. `http://homeserver:6288` ([gotcha](#token-minting)) |
| `[homeserver] admin_password` | **required** | Sent as `X-Admin-Password` |
| `http_listen_socket` | `0.0.0.0:8080` | |
| `allow_cors` | `false` | |
| `accept_proxy_ip_headers` | `false` | See [client IP](#client-ip-and-proxies) |
| `[logging]` | optional | `level` (default `info`; `trace`/`debug`/`info`/`warn`/`error`/`off`); `module_levels` takes tracing directives, e.g. `["hyper=warn"]` |

Start from the template for your release, not a hand-written config: [`config.toml.example` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example). The `master` template has an extra `[google_verification]` block, which v0.2.0 silently ignores.

## PostgreSQL backing

- **Create the database first.** `database_url` must point to an existing PostgreSQL database. Homegate creates tables, not the database. README example: `postgres://postgres:postgres@localhost:5432/pubky_homegate`.
- **Use a separate database, not the homeserver's.** Homegate talks to the homeserver only through the admin HTTP API.
- **Migrations run on every start.** Each runs in its own transaction and is tracked in a `migrations` table. A failure stops startup with `Migration failed: ...`.
- **All tables are created whichever routes are enabled.** The v0.2.0 migrations are `m20251201_create_sms_verifications`, `m20251216_create_ln_verification`, `m20260120_add_validation_attempts` and `m20260324_create_ip_verifications`. `master` adds `m20260630_create_google_verifications`. Schema: [`src/infrastructure/sql` @ v0.2.0](https://github.com/pubky/homegate/tree/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/sql).
- **The pool uses sqlx defaults** (`PgPool::connect`, 10 connections max). Size Postgres for the connection hold times described under [Rate-limit semantics](#rate-limit-semantics).
- **Phone numbers, IPs and Google identities are stored only as hashes** (Argon2id, salted from the [pepper](#the-pepper-secret)).

**Tests read `DATABASE_URL` (the `sqlx::test` convention), never `config.toml`:**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pubky_homegate?pubky-test=true cargo test
# HTTP-level tests only (they live in each module's http.rs `mod tests`):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pubky_homegate?pubky-test=true cargo test http::tests
```

<sub>Checked: the command and test filter parse with real `cargo` under bash and zsh (the `?` is not globbed), and at v0.2.0 the filter selects the 10 `http.rs` tests (IP 5, SMS 4, LN 1). Not run against upstream's suite and a live Postgres.</sub>

The README's `cargo test --lib e2e::` hint is broken. The crate is binary-only (there is no `src/lib.rs`), and `src/e2e/` holds only wiremock helpers, with no tests.

## The pepper secret

`<data-dir>/pepper.txt` holds **64 hex characters**: 32 bytes from `getrandom`, hex-encoded.

- **Load-or-create runs on every start**, even when no hashing route is enabled. A new pepper is generated **only when the file is missing** (log: `Generated new pepper at: <path>`).
- **A malformed file panics.** After trimming, the file must be exactly 64 hex characters (`Pepper file should contain a 64 character hex string`). An unreadable file panics with `Failed to read pepper file`.
- **Homegate doesn't restrict the file's permissions.** `fs::write` follows the umask, and the Docker image runs as root. Run `chmod 600 pepper.txt`, or mount the file with tight permissions. (Inferred from the code; upstream doesn't give this advice.)

> **Losing or regenerating the pepper silently resets every rate limit.** The upstream README warns that Homegate can then no longer match new requests to phone numbers that were already verified, so the limits stop being enforced. The same applies to IP hashes, and to Google hashes on `master`. A non-persistent data volume regenerates the pepper whenever the container is recreated.

> **Back up the pepper, but never next to the DB dump.** The pepper protects the hashes only while it stays secret. Keep it in separate secret storage. If the database and the pepper leak together, brute-forcing targeted phone numbers or per-country ranges becomes feasible with parallel hardware, because the E.164 space is small. (Inferred; upstream says only that the slow hash raises an attacker's cost, and its >100 ms figure depends on hardware.)

**Hashing:** Argon2id with 19 MiB memory, t=2, p=1 and a 32-byte output. Upstream sizes it to take >100 ms per hash. The hasher was built for phone numbers and is reused for IPs and Google identities.
- **The salt is deterministic:** the first 16 bytes of `blake3(pepper)` (blake3 over the pepper's hex string). The same identifier always gives the same digest, which is what makes lookup and rate limiting by hash work.
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

<sub>Source: [`src/shared/hasher_argon2id.rs` @ `master` 7623d8a](https://github.com/pubky/homegate/blob/7623d8ae358c75f3f1eb97eccdec81807c2c9fd2/src/shared/hasher_argon2id.rs#L28-L64) (verbatim; identical at v0.2.0)</sub>

> **Raw identifiers still reach the logs.** The SMS `send_code` "Retry" path logs `phone_number` in plain text at `info`. A non-empty SMS or IP `limit_whitelist` is logged unhashed at startup. Only the rate-limit warnings log just the hash. Treat the logs as personal data.

## Token minting

Homegate calls `generate_signup_token` on the admin API in one of two ways ([endpoint details](homeserver.md#signup-tokens-and-quotas)):

| Call | Quota | Used by |
| :-- | :-- | :-- |
| `GET generate_signup_token` | Homeserver system defaults | SMS, Lightning, and IP without `signup_quota` (also Google on `master`) |
| `POST generate_signup_token` + JSON quota | Explicit `UserQuota` | IP with `[ip_verification.signup_quota]` |

- **Response:** the plain-text body becomes `signupCode`.
- **Failure:** shows up as **500** "Homeserver temporarily unavailable, please retry".
- **No timeout.** Homegate's HTTP clients are built with `reqwest::Client::new()`, which has no request timeout, so a hung admin API (or phoenixd) hangs the request.
- **`homeserverPubky`:** every route returns the `/info` `public_key` unchanged. That value is **raw z-base-32** (`public_key().z32()`), **not** the `pubky<z32>` display form. Parse it as z32, and never string-compare it with `toString()` output ([key formats](../../pubky/references/concepts.md#public-key-string-formats)).

> **`admin_api_url` and `phoenixd_api_url` must be bare origins.** Paths are joined with `url::Url::join`:
> - **`/info`, `/createinvoice`, `/payments/incoming`, `/websocket`** are absolute joins, which drop any path prefix.
> - **`generate_signup_token`** is a relative join, which replaces the last path segment unless the URL ends in `/`.
>
> So a prefixed URL such as `https://proxy/admin` breaks. (Inferred from `url::Url::join` semantics; upstream has no test for it.)

## HTTP API

**Error bodies are `text/plain` strings, not JSON.** For request and response shapes, see [`openapi.yaml` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml), but treat the Rust source as ground truth. The spec's header says it is **AI-generated and may not be accurate**, and its `servers` entry `https://api.example.com` is a placeholder. The spec exists only as `openapi.yaml` (there is no `openapi.yml`).

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

<sub>Checked against the v0.2.0 routers and `openapi.yaml`; not exercised against a running instance.</sub>

The web frontend ("Franky") calls the `info` endpoints to check that a method is available. **Homegate has no country geo-blocking.** Upstream's deployment does it in nginx, so add it at your proxy if you need it.

**`500` bodies can leak internals.** Have your proxy or client show a generic message for them:
- **Prelude** failures return `HTTP request failed: <reqwest error>`.
- **Lightning** failures return `Phoenixd: Api: <reqwest error>`, which includes the internal phoenixd URL, or `Phoenixd: Websocket: ...`.
- **Database** failures return the database error text (`Database error: ...` on Lightning).

**Known `openapi.yaml` drift:**
- **`/ln_verification/{id}/await` timeout:** the spec says 60 s; the code uses **25 s**.
- **`/ln_verification/price`** isn't documented.
- **`validate_code`:** the spec lists 200/400/422/500 but not the **429** (too many attempts).
- **`/google_verification` on `master`:** the spec claims a 20 KiB body limit, unknown-field rejection and a 400 `invalid_request`. None of these is implemented; Axum's default rejections apply.

### Abuse: rate-limit requests at the proxy

Homegate has **no per-request rate limiting**. Add it at the reverse proxy (e.g. nginx `limit_req`):

- **`POST /ip_verification`, `/sms_verification/send_code`, `/sms_verification/validate_code`:** each unauthenticated request computes a full Argon2id hash (19 MiB, >100 ms) **before** any limit check. The hash runs synchronously inside the async handler (there is no `spawn_blocking`), so requests that end in 429 still pay for it.
- **`POST /ln_verification`:** unauthenticated and unlimited. Every call creates a phoenixd invoice and a database row.

### SMS (Prelude)

**`POST /sms_verification/send_code`** takes `{phoneNumber, dispatchId?}`. `phoneNumber` must be E.164 (`^\+[1-9]\d{1,14}$`). The handler:

1. **Checks** the weekly and annual limits for the number's hash. Numbers in `limit_whitelist` skip this.
2. **Sends** the code through Prelude, forwarding the client IP, User-Agent and `dispatchId` as fraud signals.
3. **Records** a `PENDING` row. Any older `PENDING` row with a different `prelude_id` is marked `FAILED` (`superseded_by_new_session`). Repeating the same `prelude_id` has no extra effect. If Prelude reports the number blocked, the row is marked `FAILED` and the call returns 403.

It returns **200 with an empty body**, including when Prelude answers "retry".

| Status | Body (text) | Cause |
| :-- | :-- | :-- |
| 422 | contains "Invalid phone number format. Must be in E.164 format (e.g., +30123456789)" | Bad format. Match on "contains": a parse failure arrives wrapped in Axum's JSON rejection text |
| 403 | "Phone number blocked for verification" | Prelude blocked the number |
| 429 | "Phone number has exceeded weekly verification limit" / "...annual verification limit" | Per-number limit |
| 429 | "External service rate limit exceeded" | Prelude returned 429; Prelude's `Retry-After` is copied through when present |
| 500 | internal error text | Prelude request or database failure |

422 and 403 can also come from Prelude itself (Prelude rejecting the number, or a region block), not only from Homegate's own checks.

**`POST /sms_verification/validate_code`** takes `{phoneNumber, code}`. `code` must be 6 digits (`^\d{6}$`).

| Result | Response |
| :-- | :-- |
| Correct code | **200** `{"valid":"true","signupCode":…,"homeserverPubky":…}`; session marked `VERIFIED` |
| Wrong code | **200** `{"valid":"false"}`; the client may retry |
| No `PENDING` session, or the Prelude session expired | **422** "No active verification session for phone number" |
| Attempts > `max_failed_validation_attempts` (default 5) | **429** "Too many incorrect code attempts. Please request a new verification code." |
| Homeserver down while minting | **500** "Homeserver temporarily unavailable, please retry" |

> **Two ways a session dies. In both cases the client must call `send_code` again:**
> - **Too many attempts.** The counter increments *before* the check, so with the default of 5 the **6th call returns 429 even with the right code**. All pending sessions for the number are marked `FAILED`.
> - **Homeserver down while minting.** The session is marked `FAILED` too.

> **`valid` is a string, not a boolean** (an internally tagged serde enum). Compare `valid === "true"`. Never test truthiness, because the string `"false"` is truthy.

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

<sub>Source: [`src/sms_verification/types.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/sms_verification/types.rs#L28-L40) (verbatim). Unchanged on `master`.</sub>

| `[sms_verification]` key | Required / default |
| :-- | :-- |
| `prelude_api_key` | **required** |
| `prelude_api_url` | `https://api.prelude.dev` |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |
| `max_failed_validation_attempts` | `5` (upstream comment: Prelude seems to fail silently after 5 failures however it is configured) |
| `limit_whitelist` | `[]` (E.164 numbers, validated at parse time) |

The README's "maximum of 10 verifications" per number is **not enforced by Homegate**; it may be a Prelude-side limit. Homegate enforces only the configurable values above.

### Lightning (phoenixd)

1. **`POST /ln_verification`** (no body) creates a phoenixd invoice → **200** `{id, bolt11Invoice, amountSat, expiresAt}` (`expiresAt` in unix ms).
2. **Poll `GET /ln_verification/{id}`.** Unless the invoice is already finalised, this re-syncs it with phoenixd. It returns `{id, amountSat, expiresAt, isPaid, signupCode|null, homeserverPubky, createdAt}` (timestamps in ms). An unknown id → **404** "Not found".
3. **Or long-poll `GET /ln_verification/{id}/await`.** On timeout → **408** "Long poll timeout. Please try again."; call it again. An unknown id → **404** "Not found".

> **`isPaid` means finalised: paid *and* a token minted.** If the homeserver is down when a paid invoice syncs, `GET /ln_verification/{id}` returns **500** "Homeserver temporarily unavailable, please retry", and the invoice stays unfinalised until a later sync succeeds. Clients must **retry**, not show "unpaid".

> **The `/await` timeout is 25 s, not the 60 s in `openapi.yaml`.** Keep proxy read timeouts above 25 s.

```rust
/// Default timeout for long-polling verification requests
/// Set to 25 seconds to be below common reverse proxy timeouts (30 seconds)
/// This way, you don't have to deal with proxy timeouts like nginx cutting the connection
/// before the application can respond with a timeout message.
const DEFAULT_TIMEOUT_SECS: u64 = 25;
```

<sub>Source: [`src/ln_verification/http.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/ln_verification/http.rs#L21-L25) (verbatim). Identical on `master`.</sub>

**Background sync.** Homegate connects to phoenixd's `/websocket` with HTTP basic auth (empty username, `phoenixd_api_password`; all phoenixd calls use this auth). It first catches up on invoices paid while it was offline, in pages of 100. It then finalises invoices live as `payment_received` events arrive.

- **Errors exit the process.** A returned phoenixd, websocket or database error calls `process::exit(1)`. Run Homegate under a restart policy (Docker `restart:`, systemd).
- **A clean websocket close neither reconnects nor exits.** The task logs `Websocket closed` (warn; also at error level when the stream ends without a Close frame) and stops, so a restart policy never fires. Until the next restart, invoices finalise only when a client polls `GET /{id}` or `/await`. **Alert on that log line.**
- **Catch-up can stop silently.** If the homeserver is unavailable during catch-up, the loop ends early without an error. Those invoices finalise only when polled.
- **Syncing an invoice holds a Postgres transaction** across the phoenixd lookup and the homeserver mint. Slow upstreams therefore tie up pooled connections.
- **A paid invoice can consume two tokens.** Sync reads the row without `FOR UPDATE` and the finalise update doesn't re-check `finalised_at`, so a websocket event and a client poll racing on the same invoice can both mint; the second overwrites `signup_code`. (Inferred from the code.)
- **No per-identity limit and no hashing.** The payment is the cost. Still add [proxy rate limiting](#abuse-rate-limit-requests-at-the-proxy).

| `[ln_verification]` key | Required / default |
| :-- | :-- |
| `phoenixd_api_url` | **required** (bare origin) |
| `phoenixd_api_password` | **required** |
| `invoice_price_sat` | `1000` |
| `invoice_expiry_seconds` | `600` |
| `invoice_description` | `"Pubky Homegate Verification"` |

### IP

**`POST /ip_verification`** (no body): if the client IP is under its limits, the route returns **200** `{signupCode, homeserverPubky}` straight away.

| Status | Body (text) / cause |
| :-- | :-- |
| 400 | "Could not determine client IP address" |
| 404 | `[ip_verification]` is absent |
| 429 | "IP address has exceeded weekly verification limit" / "...annual verification limit" (the homeserver isn't called) |
| 500 | "Homeserver temporarily unavailable, please retry", or database error text |

| `[ip_verification]` key | Default |
| :-- | :-- |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |
| `limit_whitelist` | `[]` (IPv4/IPv6 addresses) |
| `[ip_verification.signup_quota]` | absent → tokens minted with `GET` and homeserver defaults |

#### Signup quota (IP only)

`signup_quota` accepts `storage_quota_mb`, `rate_read`, `rate_read_burst`, `rate_write`, `rate_write_burst` and `allowed_write_paths`, all optional. Homegate passes the fields you set through unchanged and leaves out unset ones. The homeserver decides what a missing field means and which values are valid ([`UserQuota`](homeserver.md#signup-tokens-and-quotas)).

- **Leaving out `allowed_write_paths` means unrestricted writes, not `["/pub/"]`.** Homegate has no default for it; the `["/pub/"]` in `config.toml.example` is only an example. `[]` means read-only.
- **An invalid quota fails on every request, not at startup.** Homegate doesn't validate the quota; the homeserver rejects an invalid one with 422 ([validation rules](homeserver.md#signup-tokens-and-quotas)). Every IP request then returns 500 "Homeserver temporarily unavailable, please retry". After changing the quota, send one test request.
- **Storage can't be set to "unlimited" from Homegate.** `storage_quota_mb` is a plain `u64`, so the homeserver's `"unlimited"` value can't be expressed.
- **Keep write paths under `/pub/`**, the shipped storage root (its layout isn't stabilized). Don't grant `/priv` paths to production signups: `/priv` is **alpha** (pubky-homeserver v0.10.0+), **not for production**, and access-controlled but **not encrypted from the operator** ([guardrail](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha)).

#### Client IP and proxies

By default Homegate uses **only the TCP peer address**. With `accept_proxy_ip_headers = true`, it takes the **rightmost** valid IP in `X-Forwarded-For`, then `X-Real-IP`, then the peer address. The same client IP is forwarded to Prelude on SMS `send_code`.

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

<sub>Source: [`src/infrastructure/http/extractors/request_origin.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/http/extractors/request_origin.rs#L31-L65) (verbatim). Identical on `master`.</sub>

- **Flag off behind a proxy:** every client appears as the proxy's IP, so all clients share one limit.
- **Flag on:** use it only behind a proxy that **sets or appends `X-Forwarded-For` itself** (nginx `$proxy_add_x_forwarded_for` or `$remote_addr`). `X-Forwarded-For` wins over `X-Real-IP`. A proxy that sets only `X-Real-IP` and passes a client's `X-Forwarded-For` through lets clients spoof any IP.
- **Multiple hops** (e.g. CDN → nginx): the rightmost entry is the CDN edge, so all clients share a few IPs. Make the last proxy write the real client address. (Inferred from the rightmost-entry rule.)
- **IPv6:** each address hashes separately, so one client with a large prefix gets many identities. (Inferred.)
- **Never rely on IP limiting alone.** Upstream calls it "inherently weak" and says it "should not be the sole line of defence". CGNAT, corporate proxies and VPNs make many users share one limit, while botnets and cloud hosts rotate IPs.

## Rate-limit semantics

The windows are rolling: **7 days** (weekly) and **365 days** (annual).

| | SMS | IP |
| :-- | :-- | :-- |
| When checked | at `send_code` only | at `POST /ip_verification` |
| What counts | only `VERIFIED` sessions, by `finalised_at` (pending or failed sessions don't count) | every recorded issuance, by `created_at` |
| Concurrency | no lock or transaction | serialized per identity (below) |
| `limit_whitelist` | skips the check | skips the check, but the issuance is **still recorded** |

**IP issuance** (and Google issuance on `master`) runs in one Postgres transaction:
1. **Lock:** `pg_advisory_xact_lock(key)` on an `i64` derived from `blake3(identity_hash)`. Requests from the same IP run one at a time; different IPs run in parallel.
2. **Check limits** (skipped for whitelisted addresses).
3. **Mint the token** while the lock is held.
4. **Insert** the row, then **commit**.

Upstream does this so that a verification is never recorded without a valid signup code. Minting inside the transaction has two side effects:

- **A token can exist without a record.** If the insert or commit fails after minting, the token was issued but never counted.
- **A slow homeserver can stall every route.** The admin call holds a pooled Postgres connection and an open transaction. With no HTTP timeout ([token minting](#token-minting)), a hung admin API holds them indefinitely and can exhaust the 10-connection default pool.

On `master` this logic lives in the shared `RateLimitedSignupIssuer`. For a new provider, its module docs say to copy the `google_verifications` migration shape: `id`, `<your>_hash`, `signup_code`, `created_at`, plus an index on `(<your>_hash, created_at)`.

## Deploy

- **Image:** pin **`synonymsoft/homegate:v0.2.0`** (linux/amd64 and linux/arm64). The current pipeline builds images only on `v*.*.*` tag pushes; the `v0.1.0` image predates it and was built from `master` commit `887e4d5`. No published image contains Google verification. The [`Dockerfile`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/Dockerfile) uses a `rust:1.89.0-alpine3.20` builder and an `alpine:3.20` runtime with only `ca-certificates`, `EXPOSE 8080` and `CMD ["homegate"]`.
- **Data dir:** the image sets no `USER`, so Homegate runs as **root** with the default data dir **`/root/.homegate`**. Mount a **persistent** volume there (or pass `--data-dir`) holding `config.toml` and `pepper.txt`, and make sure the directory exists before the first start.
- **Port:** publish the port that matches `http_listen_socket`.
- **Must be reachable at startup:** Postgres; the homeserver admin API (`:6288`, which must stay off the public network — [homeserver.md](homeserver.md#security-guardrails)); and phoenixd if Lightning is enabled.
- **Reverse proxy:** terminate TLS, add [per-request limits](#abuse-rate-limit-requests-at-the-proxy), set `X-Forwarded-For` correctly ([client IP](#client-ip-and-proxies)), and keep read timeouts above 25 s.
- **Supervision:** use a restart policy, because startup failures and Lightning sync errors exit the process. Also **alert on `Websocket closed`**, which a restart policy won't catch.
- **Shutdown:** only SIGINT (Ctrl+C) is handled. As PID 1, Homegate ignores the SIGTERM from `docker stop` until the SIGKILL after the grace period; set the container's stop signal to `SIGINT` if you want a clean stop.

## Unreleased: Google verification (`master` only)

**Not in v0.2.0 or in any Docker image. Don't present it as available to release users.** It was merged upstream after v0.2.0 (PR #30).

On `master`, `[google_verification]` enables `POST /google_verification`, which takes `{googleIdToken}` and returns `{signupCode, homeserverPubky}`:
- **Config:** `google_client_id` is required; `max_verifications_per_week` and `max_verifications_per_year` default to 2 and 4.
- **Verification:** an RS256 ID token checked against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached). It requires `exp`, `iss`, `aud` and `sub`, with `aud` = `google_client_id` and `iss` = `accounts.google.com` or `https://accounts.google.com`.
- **Rate limiting:** on an Argon2id hash of `iss` and `sub`, through the same transactional issuer as IP. Hashing happens only after the token verifies. Tokens are minted with homeserver defaults (no quota).
- **Errors** (`text/plain` codes): 401 `invalid_google_id_token`; 429 `weekly_limit_exceeded` / `annual_limit_exceeded`; 500 `homeserver_unavailable`, `google_verifier_unavailable` or `internal_error`.

Source: [`src/google_verification/` @ `master` 7623d8a](https://github.com/pubky/homegate/tree/7623d8ae358c75f3f1eb97eccdec81807c2c9fd2/src/google_verification).

> **Never set `HOMEGATE_GOOGLE_JWKS_URL` in production.** It overrides the JWKS URL for mocks and manual testing. Whoever controls that URL can supply their own keys and forge ID tokens that Homegate accepts.

## Upstream

- **Repo and README:** <https://github.com/pubky/homegate>
- **Example config (v0.2.0):** [`config.toml.example`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example)
- **API spec (v0.2.0):** [`openapi.yaml`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml). It is AI-generated, so verify it against the source.
- **Docker image:** [`synonymsoft/homegate`](https://hub.docker.com/r/synonymsoft/homegate)
- **Providers:** [Prelude](https://docs.prelude.so/), [phoenixd](https://github.com/ACINQ/phoenixd)
