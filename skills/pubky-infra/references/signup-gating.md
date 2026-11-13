# Signup gating (Homegate)

[Homegate](https://github.com/pubky/homegate) is a standalone Rust service that decides who gets a homeserver **signup token**. A client proves itself by **SMS**, **Lightning payment** or **IP**. Homegate then mints a token through the homeserver admin API and returns it as `signupCode`. The Pubky social app's onboarding (`https://pubky.app/onboarding/human`) runs through Homegate.

Link, don't restate:

- **How a client uses the token** (`signer.signup(homeserverPk, signupToken)`, or `null` for open or testnet homeservers): [`auth.md`](../../pubky/references/auth.md#signup-tokens).
- **The admin endpoints Homegate calls** (`GET /info`, `GET`/`POST /generate_signup_token`, `X-Admin-Password`, the `UserQuota` body and its validation rules): [`homeserver.md`](homeserver.md#signup-tokens-and-quotas).

> **Release vs `master`** (checked 2026-11-12; `master` HEAD `9418e87`, 2026-11-11):
> - **Latest release: v0.2.0** (commit `ea838a8`, 2026-06-18). Nothing has been released since. Deploy **`synonymsoft/homegate:v0.2.0`**.
> - **Pin the version tag, not `latest`.** `latest` points at v0.2.0 today, but the next release will move it ([release process](#release-process)).
> - **Don't use the `v0.1.0` image.** It was built from commit `887e4d5`, not from the git tag `v0.1.0` (`9e57814`).
> - **GitHub releases are unpublished drafts** (v0.1.0 and v0.2.0, one linux-amd64 binary each). Don't point operators at them.
> - **v0.2.0 ships SMS, Lightning and IP.** Everything under [Unreleased on `master`](#unreleased-on-master) (Google and Apple verification, metrics, overload protection, dependency timeouts) is in no release and no image. This file describes v0.2.0 unless a line says `master`.
> - **The version string doesn't identify the build.** `Cargo.toml` and `openapi.yaml` on `master` still say `0.2.0`.
> - **Pre-1.0:** request and response shapes may change.

## Routes are opt-in per config section

A route is mounted only when its config section is present. If the section is missing, the route returns **404**.

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

<sub>Source: [`src/infrastructure/http/server.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/http/server.rs#L40-L60) (verbatim; the v0.2.0 tree builds). This is v0.2.0 only. On `master`, each `router(...)` call also takes a metrics argument, and two more blocks follow for `[google_verification]` and `[apple_verification]`.</sub>

> **Config typos fail silently.** No config struct uses `deny_unknown_fields`, so:
> - A misspelled section (e.g. `[ip_verifcation]`) is ignored, and its route returns 404.
> - A misspelled **optional** key falls back to its default. A misspelled **required** key (e.g. `prelude_api_key`) stops startup with `missing field`.
> - Sections and keys the build doesn't know are ignored. On v0.2.0 that covers `[google_verification]`, `[apple_verification]`, `[metrics]` and `max_concurrent_hashes`.
>
> After startup, check the log for the `... verification enabled` lines.

**Other server behavior:**
- **`allow_cors = true`** adds a fully permissive CORS layer (any origin, method and header).
- **`GET /`** returns the text `Homegate Service`.
- **No TLS.** Homegate serves plain HTTP only. Terminate TLS at a reverse proxy.

## Startup and configuration

The only CLI flag is `--data-dir`, the directory that holds `config.toml` and `pepper.txt`. Startup runs these steps in order, and any of them can stop the process:

1. **Data dir.** `--data-dir` defaults to `$HOME/.homegate`. Homegate panics if `$HOME` is unset, **even when you pass `--data-dir`**. The directory must **already exist**, or startup fails with `Data directory '<p>' does not exist` (or `is not a directory`).
2. **`config.toml`.** If `<data-dir>/config.toml` is missing, Homegate writes the bundled example there and **exits** ("No config file found. A template has been created at '<p>' — please edit it and restart.").
3. **Logging** starts.
4. **Pepper.** Homegate reads `<data-dir>/pepper.txt`, or generates it if missing ([details](#the-pepper-secret)). This runs *before* the homeserver check, so a first start that fails at a later step still leaves a new pepper behind.
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

Start from the template for your release instead of writing a config by hand: [`config.toml.example` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example). The [`master` template](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/config.toml.example) adds `max_concurrent_hashes`, `[metrics]`, `[google_verification]` and `[apple_verification]`, and v0.2.0 silently ignores all four.

## PostgreSQL backing

- **Create the database first.** `database_url` must point to an existing PostgreSQL database. Homegate creates tables, not the database. README example: `postgres://postgres:postgres@localhost:5432/pubky_homegate`.
- **Use a separate database, not the homeserver's.** Homegate reaches the homeserver only through the admin HTTP API.
- **Migrations run on every start.** Each one runs in its own transaction and is tracked in a `migrations` table. A failure stops startup with `Migration failed: ...`.
- **Every table is created, whichever routes are enabled.** v0.2.0 migrations: `m20251201_create_sms_verifications`, `m20251216_create_ln_verification`, `m20260120_add_validation_attempts`, `m20260324_create_ip_verifications`. `master` adds `m20260630_create_google_verifications` and `m20261105_create_apple_verifications`. Schema: [`src/infrastructure/sql` @ v0.2.0](https://github.com/pubky/homegate/tree/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/infrastructure/sql).
- **The pool uses sqlx defaults** (`PgPool::connect`, 10 connections max). Size Postgres for the connection hold times described under [Rate-limit semantics](#rate-limit-semantics).
- **Phone numbers and IPs are stored only as hashes** (Argon2id, salted from the [pepper](#the-pepper-secret)). On `master`, so are Google and Apple identities.

**Tests read `DATABASE_URL` (the `sqlx::test` convention), never `config.toml`:**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pubky_homegate?pubky-test=true cargo test
# HTTP-level tests only (they live in each module's http.rs `mod tests`):
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pubky_homegate?pubky-test=true cargo test http::tests
```

<sub>Checked: both commands parse with real `cargo` under bash and zsh (the `?` is not globbed). The filter selects 10 `http.rs` tests at v0.2.0 (IP 5, SMS 4, LN 1) and 36 on `master`. The tests were compiled and listed, not run against a live Postgres.</sub>

The README's `cargo test --lib e2e::` hint is still broken on `master`. The crate is binary-only (there is no `src/lib.rs`), and `src/e2e/` contains only `mod.rs` and `wiremock_helpers.rs`, with no tests.

## The pepper secret

`<data-dir>/pepper.txt` holds **64 hex characters**: 32 bytes from `getrandom`, hex-encoded.

- **Load-or-create runs on every start**, even when no hashing route is enabled. A new pepper is generated **only when the file is missing** (log: `Generated new pepper at: <path>`).
- **A malformed file panics.** After trimming, the file must be exactly 64 hex characters (`Pepper file should contain a 64 character hex string`). An unreadable file panics with `Failed to read pepper file`.
- **Homegate doesn't restrict the file's permissions.** `fs::write` follows the umask, and the Docker image runs as root. Run `chmod 600 pepper.txt`, or mount the file with tight permissions. (Inferred from the code; upstream gives no such advice.)

> **Losing or regenerating the pepper silently resets every rate limit.** The upstream README warns that Homegate can then no longer match new requests to phone numbers it has already verified, so limits stop being enforced. The same goes for IP hashes, and for Google and Apple hashes on `master`. On a non-persistent data volume, the pepper is regenerated every time the container is recreated.

> **Back up the pepper, but never next to the DB dump.** The pepper protects the hashes only while it stays secret, so keep it in separate secret storage. If the database and the pepper leak together, brute-forcing targeted phone numbers or per-country ranges becomes feasible with parallel hardware, because the E.164 space is small. (Inferred. Upstream says only that the slow hash raises an attacker's cost, and its >100 ms figure depends on hardware.)

**Hashing:** Argon2id with 19 MiB memory, t=2, p=1 and a 32-byte output, which upstream sizes at >100 ms per hash. The hasher was written for phone numbers and is reused for IPs (and for Google and Apple identities on `master`).
- **The salt is deterministic:** the first 16 bytes of `blake3(pepper)` (blake3 over the pepper's hex string). The same identifier always produces the same digest, which is what makes lookup and rate limiting by hash possible.
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

<sub>Source: `src/shared/hasher_argon2id.rs` @ v0.2.0, [parameters L27-35](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/shared/hasher_argon2id.rs#L27-L35) and [salt L42-45](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/shared/hasher_argon2id.rs#L42-L45) (verbatim). The values are unchanged on `master` 9418e87, where the same lines sit at [parameters L58-66](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/hasher_argon2id.rs#L58-L66) and [salt L126-130](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/hasher_argon2id.rs#L126-L130) (inside `hash_blocking`).</sub>

> **Raw identifiers still reach the logs.** The SMS `send_code` "Retry" path logs `phone_number` in plain text at `info`. A non-empty SMS or IP `limit_whitelist` is logged unhashed at startup. Only the rate-limit warnings restrict themselves to the hash. Treat the logs as personal data.

## Token minting

Homegate calls `generate_signup_token` on the admin API in one of two ways ([endpoint details](homeserver.md#signup-tokens-and-quotas)):

| Call | Quota | Used by |
| :-- | :-- | :-- |
| `GET generate_signup_token` | Homeserver system defaults | SMS, Lightning, and IP without `signup_quota` (also Google and Apple on `master`) |
| `POST generate_signup_token` + JSON quota | Explicit `UserQuota` | IP with `[ip_verification.signup_quota]` |

- **Response:** the plain-text body becomes `signupCode`.
- **Failure:** returns **500** "Homeserver temporarily unavailable, please retry" on SMS, Lightning and IP. On `master`, Google and Apple return 500 `homeserver_unavailable` instead.
- **No timeout on v0.2.0.** Homegate's HTTP clients are built with `reqwest::Client::new()`, which sets no request timeout, so a hung admin API (or phoenixd) hangs the request. `master` adds a 10 s timeout ([below](#overload-protection-and-timeouts)).
- **`homeserverPubky`:** every route returns the `/info` `public_key` unchanged. That value is **raw z-base-32** (`public_key().z32()`), **not** the `pubky<z32>` display form. Parse it as z32, and never string-compare it with `toString()` output ([key formats](../../pubky/references/concepts.md#public-key-string-formats)).

> **`admin_api_url` and `phoenixd_api_url` must be bare origins.** Paths are joined with `url::Url::join`:
> - **`/info`, `/createinvoice`, `/payments/incoming` and `/websocket`** are absolute joins, so any path prefix is dropped.
> - **`generate_signup_token`** is a relative join, so it replaces the last path segment unless the URL ends in `/`.
>
> A prefixed URL such as `https://proxy/admin` therefore breaks. (Inferred from `url::Url::join` semantics; upstream has no test for this.)

## HTTP API

**Error bodies are `text/plain` strings, not JSON.** For request and response shapes, see [`openapi.yaml` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml) (or [@ `master` 9418e87](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/openapi.yaml)), but treat the Rust source as ground truth. The spec's own header says it is **AI-generated and may not be accurate**, and its `servers` list is `localhost:8080` plus the placeholder `https://api.example.com`. The file is `openapi.yaml` (there is no `openapi.yml`).

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
# master only (unreleased): POST /google_verification, POST /apple_verification,
# and GET /metrics on the separate [metrics] listener
```

<sub>Checked against the v0.2.0 routers and `openapi.yaml`; not exercised against a running instance.</sub>

The web frontend ("Franky") calls the `info` endpoints to check whether a method is available. **Homegate has no country geo-blocking.** Upstream's deployment does it in nginx, so add it at your proxy if you need it.

**`500` bodies can leak internals.** Have your proxy or client show a generic message instead:
- **Prelude** failures return `HTTP request failed: <reqwest error>`.
- **Lightning** failures return `Phoenixd: Api: <reqwest error>` (which includes the internal phoenixd URL) or `Phoenixd: Websocket: ...`.
- **Database** failures return the database error text (`Database error: ...` on Lightning).

**Known `openapi.yaml` drift (still present on `master`):**
- **`/ln_verification/{id}/await` timeout:** the spec says 60 s; the code uses **25 s**.
- **`/ln_verification/price`** is undocumented.
- **`validate_code`:** the spec omits the **429** (too many attempts).
- **`/google_verification` (`master`):** the spec claims a 20 KiB body limit, rejection of unknown fields and a 400 `invalid_request`. None of these is implemented. The real limits are the 64 KiB global body limit, a 16 KiB token cap that returns 401, and Axum's default rejections.
- **413 (`master`):** the 64 KiB body limit is mentioned only in the spec's description prose, not as a response on any path.

### Abuse: rate-limit requests at the proxy

Homegate has **no per-request rate limiting**. Add it at the reverse proxy (e.g. nginx `limit_req`):

- **`POST /ip_verification`, `/sms_verification/send_code`, `/sms_verification/validate_code`:** each unauthenticated request computes a full Argon2id hash (19 MiB, >100 ms) **before** any limit check. On v0.2.0 the hash runs synchronously inside the async handler (there is no `spawn_blocking`), so requests that end in 429 still pay the full cost. `master` caps concurrent hashes and returns 503 when the cap is reached ([overload protection](#overload-protection-and-timeouts)). That bounds CPU and memory, but a flood still fills the slots and legitimate requests then get 503 too, so keep the proxy limits. (Inferred from the process-wide cap.)
- **`POST /ln_verification`:** unauthenticated and unlimited. Every call creates a phoenixd invoice and a database row.

### SMS (Prelude)

**`POST /sms_verification/send_code`** takes `{phoneNumber, dispatchId?}`. `phoneNumber` must be E.164 (`^\+[1-9]\d{1,14}$`). The handler:

1. **Checks** the weekly and annual limits for the number's hash. Numbers in `limit_whitelist` skip the check.
2. **Sends** the code through Prelude, forwarding the client IP, User-Agent and `dispatchId` as fraud signals.
3. **Records** a `PENDING` row. Any older `PENDING` row with a different `prelude_id` is marked `FAILED` (`superseded_by_new_session`). A repeat of the same `prelude_id` changes nothing. If Prelude reports the number blocked, the row is marked `FAILED` and the call returns 403.

It returns **200 with an empty body**, including when Prelude answers "retry".

| Status | Body (text) | Cause |
| :-- | :-- | :-- |
| 422 | contains "Invalid phone number format. Must be in E.164 format (e.g., +30123456789)" | Bad format. Match with "contains": a parse failure arrives wrapped in Axum's JSON rejection text |
| 403 | "Phone number blocked for verification" | Prelude blocked the number |
| 429 | "Phone number has exceeded weekly verification limit" / "...annual verification limit" | Per-number limit |
| 429 | "External service rate limit exceeded" | Prelude returned 429; its `Retry-After` is passed through when present |
| 500 | internal error text | Prelude request or database failure |

422 and 403 can also originate from Prelude (Prelude rejecting the number, or a region block), not only from Homegate's own checks.

**`POST /sms_verification/validate_code`** takes `{phoneNumber, code}`. `code` must be 6 digits (`^\d{6}$`).

| Result | Response |
| :-- | :-- |
| Correct code | **200** `{"valid":"true","signupCode":…,"homeserverPubky":…}`; session marked `VERIFIED` |
| Wrong code | **200** `{"valid":"false"}`; the client may retry |
| No `PENDING` session, or the Prelude session expired | **422** "No active verification session for phone number" |
| Attempts > `max_failed_validation_attempts` (default 5) | **429** "Too many incorrect code attempts. Please request a new verification code." |
| Homeserver down while minting | **500** "Homeserver temporarily unavailable, please retry" |

> **A session ends in two ways, and either way the client must call `send_code` again:**
> - **Too many attempts.** The counter increments *before* the check, so with the default of 5 the **6th call returns 429 even with the right code**. All pending sessions for the number are marked `FAILED`.
> - **Homeserver down while minting.** The session is marked `FAILED` as well.

> **`valid` is a string, not a boolean** (an internally tagged serde enum). Compare `valid === "true"`. Never test truthiness: the string `"false"` is truthy.

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

<sub>Source: [`src/sms_verification/types.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/sms_verification/types.rs#L28-L40) (verbatim; unchanged on `master`). Run with serde_json, it serializes to `{"valid":"true",...}` / `{"valid":"false"}`, and a boolean `true` fails to deserialize.</sub>

| `[sms_verification]` key | Required / default |
| :-- | :-- |
| `prelude_api_key` | **required** |
| `prelude_api_url` | `https://api.prelude.dev` |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |
| `max_failed_validation_attempts` | `5` (upstream comment: Prelude seems to fail silently after 5 failures however it is configured) |
| `limit_whitelist` | `[]` (E.164 numbers, validated at parse time) |

Homegate does **not enforce** the README's "maximum of 10 verifications" per number (still true on `master`). It may be a Prelude-side limit. Homegate enforces only the configurable values above.

### Lightning (phoenixd)

1. **`POST /ln_verification`** (no body) creates a phoenixd invoice → **200** `{id, bolt11Invoice, amountSat, expiresAt}` (`expiresAt` in unix ms).
2. **Poll `GET /ln_verification/{id}`.** Unless the invoice is already finalised, this re-syncs it with phoenixd. Returns `{id, amountSat, expiresAt, isPaid, signupCode|null, homeserverPubky, createdAt}` (timestamps in ms). Unknown id → **404** "Not found".
3. **Or long-poll `GET /ln_verification/{id}/await`.** On timeout it returns **408** "Long poll timeout. Please try again."; call it again. Unknown id → **404** "Not found".

> **`isPaid` means finalised: paid *and* a token minted.** If the homeserver is down when a paid invoice syncs, `GET /ln_verification/{id}` returns **500** "Homeserver temporarily unavailable, please retry", and the invoice stays unfinalised until a later sync succeeds. Clients must **retry**, not show "unpaid".

> **The `/await` timeout is 25 s, not the 60 s in `openapi.yaml`.** Keep proxy read timeouts above 25 s. On `master` it also stays under the new 30 s request timeout.

```rust
/// Default timeout for long-polling verification requests
/// Set to 25 seconds to be below common reverse proxy timeouts (30 seconds)
/// This way, you don't have to deal with proxy timeouts like nginx cutting the connection
/// before the application can respond with a timeout message.
const DEFAULT_TIMEOUT_SECS: u64 = 25;
```

<sub>Source: [`src/ln_verification/http.rs` @ v0.2.0](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/src/ln_verification/http.rs#L21-L25) (verbatim). Identical on `master`.</sub>

**Background sync.** Homegate connects to phoenixd's `/websocket` with HTTP basic auth (empty username, `phoenixd_api_password`; every phoenixd call uses this auth). It first catches up on invoices paid while it was offline, in pages of 100, and then finalises invoices live as `payment_received` events arrive. Everything below also holds on `master`, apart from metrics and the phoenixd REST timeout.

- **Errors exit the process.** A phoenixd, websocket or database error calls `process::exit(1)`. Run Homegate under a restart policy (Docker `restart:`, systemd).
- **A clean websocket close neither reconnects nor exits.** The task logs `Websocket closed` (warn; also at error level when the stream ends without a Close frame) and stops, so a restart policy never fires. Until the next restart, invoices finalise only when a client polls `GET /{id}` or `/await`. **Alert on that log line.**
- **Catch-up can stop silently.** If the homeserver is unavailable during catch-up, the loop ends early without an error. Those invoices finalise only when polled.
- **Syncing an invoice holds a Postgres transaction** across the phoenixd lookup and the homeserver mint, so slow upstreams tie up pooled connections.
- **A paid invoice can consume two tokens.** Sync reads the row without `FOR UPDATE`, and the finalise update doesn't re-check `finalised_at`. A websocket event and a client poll racing on the same invoice can therefore both mint, and the second overwrites `signup_code`. (Inferred from the code.)
- **No per-identity limit and no hashing.** The payment is the cost. Still add [proxy rate limiting](#abuse-rate-limit-requests-at-the-proxy).

| `[ln_verification]` key | Required / default |
| :-- | :-- |
| `phoenixd_api_url` | **required** (bare origin) |
| `phoenixd_api_password` | **required** |
| `invoice_price_sat` | `1000` |
| `invoice_expiry_seconds` | `600` |
| `invoice_description` | `"Pubky Homegate Verification"` |

### IP

**`POST /ip_verification`** (no body): if the client IP is within its limits, the route returns **200** `{signupCode, homeserverPubky}` immediately.

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

`signup_quota` accepts `storage_quota_mb`, `rate_read`, `rate_read_burst`, `rate_write`, `rate_write_burst` and `allowed_write_paths`, all optional. Homegate forwards the fields you set unchanged and leaves out the rest. The homeserver decides what a missing field means and which values are valid ([`UserQuota`](homeserver.md#signup-tokens-and-quotas)).

- **Leaving out `allowed_write_paths` means unrestricted writes, not `["/pub/"]`.** Homegate sets no default. The `["/pub/"]` in `config.toml.example` is only an example. `[]` means read-only.
- **An invalid quota fails on every request, not at startup.** Homegate doesn't validate the quota, so the homeserver rejects it at each mint ([its rules](homeserver.md#signup-tokens-and-quotas)) and every IP request returns 500 "Homeserver temporarily unavailable, please retry". After you change the quota, send one test request.
- **Homegate can't set storage to "unlimited".** `storage_quota_mb` is a plain `u64`, so it can't express the homeserver's `"unlimited"` value.
- **Keep write paths under `/pub/`**, the shipped storage root (its layout is not stabilized). Don't grant `/priv` paths to production signups: `/priv` is **alpha** (pubky-homeserver v0.10.0+), **not for production**, and access-controlled but **not encrypted from the operator** ([guardrail](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha)).

#### Client IP and proxies

By default Homegate uses **only the TCP peer address**. With `accept_proxy_ip_headers = true`, it takes the **rightmost** valid IP in `X-Forwarded-For`, then `X-Real-IP`, then the peer address. SMS `send_code` forwards this same client IP to Prelude.

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
- **Flag on:** enable it only behind a proxy that **sets or appends `X-Forwarded-For` itself** (nginx `$proxy_add_x_forwarded_for` or `$remote_addr`). `X-Forwarded-For` takes precedence over `X-Real-IP`, so a proxy that sets only `X-Real-IP` and passes the client's `X-Forwarded-For` through lets clients spoof any IP.
- **Multiple hops** (e.g. CDN → nginx): the rightmost entry is the CDN edge, so all clients share a few IPs. Make the last proxy write the real client address. (Inferred from the rightmost-entry rule.)
- **IPv6:** each address hashes separately, so one client with a large prefix has many identities. (Inferred.)
- **Never rely on IP limiting alone.** Upstream calls it "inherently weak" and says it "should not be the sole line of defence". CGNAT, corporate proxies and VPNs put many users behind one limit, while botnets and cloud hosts rotate IPs.

## Rate-limit semantics

The windows are rolling: **7 days** (weekly) and **365 days** (annual).

| | SMS | IP |
| :-- | :-- | :-- |
| When checked | at `send_code` only | at `POST /ip_verification` |
| What counts | only `VERIFIED` sessions, by `finalised_at` (pending or failed sessions don't count) | every recorded issuance, by `created_at` |
| Concurrency | no lock or transaction | serialized per identity (below) |
| `limit_whitelist` | skips the check | skips the check, but the issuance is **still recorded** |

**IP issuance** (and Google and Apple issuance on `master`) runs in a single Postgres transaction:
1. **Lock:** `pg_advisory_xact_lock(key)` on an `i64` derived from `blake3(identity_hash)`. Requests from the same IP run one at a time; different IPs run in parallel.
2. **Check limits** (skipped for whitelisted addresses).
3. **Mint the token** while holding the lock.
4. **Insert** the row, then **commit**.

Upstream designs it this way so a verification is never recorded without a valid signup code. Minting inside the transaction has two side effects:

- **A token can exist without a record.** If the insert or commit fails after minting, the token was issued but never counted.
- **A slow homeserver can stall every route.** The admin call holds a pooled Postgres connection and an open transaction. On v0.2.0, with no HTTP timeout ([token minting](#token-minting)), a hung admin API holds both indefinitely and can exhaust the default pool of 10 connections. On `master` the call fails after 10 s and the transaction rolls back. IP then returns 500 "Homeserver temporarily unavailable, please retry", and Google and Apple return 500 `homeserver_unavailable`.

On `master` this logic lives in the shared `RateLimitedSignupIssuer`. Its [module docs](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/rate_limited_signup_issuer.rs#L1-L38) are the recipe for adding a provider. Copy the `m20260630_create_google_verifications` migration shape (`id`, `<your>_hash`, `signup_code`, `created_at`, plus an index on `(<your>_hash, created_at)`), then add a `#[from] HasherBusy` error variant mapped to 503, a `SignupType` variant for metrics, and `failure_kind()`.

## Deploy

- **Image:** pin **`synonymsoft/homegate:v0.2.0`** (linux/amd64 and linux/arm64). The `v0.1.0` image predates the tag-driven pipeline and was built from `master` commit `887e4d5`. No published image contains anything from [Unreleased on `master`](#unreleased-on-master). The [`Dockerfile`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/Dockerfile) builds on `rust:1.89.0-alpine3.20` and runs on `alpine:3.20` with only `ca-certificates`, `EXPOSE 8080` and `CMD ["homegate"]`.
- **Data dir:** the image sets no `USER`, so Homegate runs as **root** and the default data dir is **`/root/.homegate`**. Mount a **persistent** volume there (or pass `--data-dir`) to hold `config.toml` and `pepper.txt`, and create the directory before the first start.
- **Port:** publish the port that matches `http_listen_socket`.
- **Must be reachable at startup:** Postgres; the homeserver admin API (`:6288`, which must stay off the public network — see [homeserver.md](homeserver.md#security-guardrails)); and phoenixd if Lightning is enabled.
- **Reverse proxy:** terminate TLS, add [per-request limits](#abuse-rate-limit-requests-at-the-proxy), set `X-Forwarded-For` correctly ([client IP](#client-ip-and-proxies)), and keep read timeouts above 25 s.
- **Supervision:** use a restart policy, because startup failures and Lightning sync errors exit the process. Also **alert on `Websocket closed`**, which a restart policy won't catch.
- **Shutdown:** only SIGINT (Ctrl+C) is handled (still true on `master`). Running as PID 1, Homegate ignores the SIGTERM from `docker stop` until the grace period ends and SIGKILL arrives. Set the container's stop signal to `SIGINT` for a clean stop.

## Unreleased on `master`

**Nothing in this section is in v0.2.0 or any Docker image. Don't present it as available to release users.** Pinned sources: [README](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/README.md), [`openapi.yaml`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/openapi.yaml) and [`config.toml.example`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/config.toml.example), all @ `9418e87`. Since the last sync, `master` has gained metrics (PR #40), overload protection and timeouts (PR #42), Apple verification (PR #41) and a release workflow (PR #44). Google verification (PR #30) landed earlier.

### Google verification

`[google_verification]` enables `POST /google_verification`, which takes `{googleIdToken}` and returns `{signupCode, homeserverPubky}`:
- **Config:** `google_client_id` is required; `max_verifications_per_week` and `max_verifications_per_year` default to 2 and 4.
- **Verification:** an RS256 ID token checked against Google's JWKS (`https://www.googleapis.com/oauth2/v3/certs`, through the [shared JWKS cache](#jwks-cache-google-and-apple)). `exp`, `iss`, `aud` and `sub` are required, with `aud` = `google_client_id` and `iss` = `accounts.google.com` or `https://accounts.google.com`. Homegate rewrites the bare `accounts.google.com` to the `https://` form before hashing, so both spellings count against one quota.
- **Rate limiting:** on an Argon2id hash of `iss` and `sub`, through the same transactional issuer as IP. Hashing happens only after the token verifies. Tokens are minted with homeserver defaults (no quota).
- **Errors** (`text/plain` codes): 401 `invalid_google_id_token`; 429 `weekly_limit_exceeded` / `annual_limit_exceeded`; 500 `homeserver_unavailable`, `google_verifier_unavailable` or `internal_error`; 503 `server_busy`.

Source: [`src/google_verification/` @ `master` 9418e87](https://github.com/pubky/homegate/tree/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/google_verification).

> **Never set `HOMEGATE_GOOGLE_JWKS_URL` in production.** It overrides the JWKS URL for mocks and manual testing. Whoever controls that URL can serve their own keys and forge ID tokens that Homegate accepts.

### Apple verification

`[apple_verification]` enables `POST /apple_verification`, which takes JSON `{appleIdToken}` and returns **200** `{signupCode, homeserverPubky}` (Sign in with Apple). Without the section, the route returns 404.

| `[apple_verification]` key | Required / default |
| :-- | :-- |
| `allowed_audiences` | **required**: Services IDs (web) and/or bundle IDs (native). Parsing fails if the list is missing or empty, or if any entry is empty or whitespace-padded |
| `max_verifications_per_week` | `2` |
| `max_verifications_per_year` | `4` |

> **All `allowed_audiences` must belong to one Apple developer team.** Apple's `sub` is team-scoped, and limits are shared across audiences by `sub`. Adding IDs from another team gives each user a separate quota per team.

**Token checks:** RS256 only, `kid` required, `iss` exactly `https://appleid.apple.com`, `aud` one of `allowed_audiences`, 60 s leeway, non-empty `sub`, `iat` no more than 60 s in the future, token no larger than 16 KiB.

```rust
let decoding_key = DecodingKey::from_jwk(&jwk)
    .map_err(|_| AppleIdTokenVerificationError::DependencyUnavailable)?;
let mut validation = Validation::new(Algorithm::RS256);
validation.set_audience(&self.allowed_audiences);
validation.set_issuer(&[APPLE_ISSUER]);
validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
validation.leeway = CLOCK_SKEW_LEEWAY_SECS;

let token = decode::<AppleClaims>(id_token, &decoding_key, &validation)
    .map_err(|_| AppleIdTokenVerificationError::Invalid)?;

if token.claims.sub.trim().is_empty() {
    return Err(AppleIdTokenVerificationError::Invalid);
}
if token.claims.iat > now_unix_secs() + CLOCK_SKEW_LEEWAY_SECS {
    return Err(AppleIdTokenVerificationError::Invalid);
}
```

<sub>Source: [`src/apple_verification/apple_id_token_verifier.rs` @ `master` 9418e87](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/apple_verification/apple_id_token_verifier.rs#L84-L100) (verbatim fragment; constants at L6-14, `AppleClaims` at L110-119). Unreleased: not in v0.2.0.</sub>

- **No nonce check.** Homegate doesn't bind the token to a request, so anyone holding an unexpired token can redeem it, up to that identity's limits. (Inferred; the source comment says "A nonce is not required.")
- **`aud` is deserialized as a single string**, so a token with several audiences is rejected.
- **Rate limiting:** Homegate verifies the token, hashes `format!("{iss}\n{sub}")` with Argon2id and issues through the same transactional issuer as IP. There is no whitelist and no quota, so tokens are minted with homeserver defaults. Rows go to `apple_verifications` (`id`, `apple_identity_hash`, `signup_code`, `created_at`). Email claims are ignored, and raw Apple IDs and emails are never stored.

| Status | Body (text) / cause |
| :-- | :-- |
| 400 / 415 / 422 | Axum's default JSON rejections: invalid JSON / missing `application/json` Content-Type / missing `appleIdToken` |
| 401 | `invalid_apple_id_token` (also for an empty or >16 KiB token, not 400) |
| 429 | `weekly_limit_exceeded` / `annual_limit_exceeded` |
| 500 | `homeserver_unavailable`, `apple_verifier_unavailable` or `internal_error` (database) |
| 503 | `server_busy` with `Retry-After: 1` |

Source: [`src/apple_verification/` @ `master` 9418e87](https://github.com/pubky/homegate/tree/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/apple_verification); [README § Apple verification](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/README.md#apple-verification).

> **Never set `HOMEGATE_APPLE_JWKS_URL` in production.** It overrides the Apple JWKS URL (default `https://appleid.apple.com/auth/keys`) and carries the same forgery risk as the Google override. If it is set to an invalid URL, Homegate **panics at startup** while building the router.

### JWKS cache (Google and Apple)

Both verifiers share one [`JwksCache`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/jwks_cache.rs#L1-L36):
- **Lifetime:** the provider's `Cache-Control` `max-age` (5 min when absent), clamped between 1 min and 1 day. Only one fetch runs at a time.
- **Unknown `kid`:** forces at most one refetch per minute. Within a minute of a failed fetch, an unknown `kid` is reported as unavailable (500 `*_verifier_unavailable`), not invalid.
- **Fetch failure** while keys are missing or expired: the next fetch waits 5 s, and requests during that window fail with 500 `*_verifier_unavailable`.
- **The JWKS client follows no redirects** and uses the 10 s dependency timeout.

### Overload protection and timeouts

**Hashing cap.** Argon2id runs on Tokio's blocking pool behind a process-wide semaphore. The default is one slot per CPU (`available_parallelism`, falling back to 1). The top-level key `max_concurrent_hashes` overrides it. It is a `NonZeroUsize`, so `0` fails config parsing. When every slot is taken, the request fails immediately with `HasherBusy`; it is never queued.

```rust
let slot = Arc::clone(&self.hash_slots)
    .try_acquire_owned()
    .map_err(|_| HasherBusy)?;
// The slot moves into the blocking task, so it is released only when
// the work has actually finished (or panicked), even if the caller's
// future is dropped first (client disconnect, request timeout).
let task = tokio::task::spawn_blocking(move || {
    let _slot = slot;
    work()
});
```

<sub>Source: [`src/shared/hasher_argon2id.rs` @ `master` 9418e87](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/hasher_argon2id.rs#L108-L117) (verbatim). Unreleased: v0.2.0 hashes synchronously in the handler.</sub>

- **Busy response:** **503** with `Retry-After: 1`. The body is `Server busy, please retry` on SMS (`send_code`, `validate_code`) and IP, and `server_busy` on Google and Apple. (The README lists only SMS, IP and Google, but Apple returns it too.) Lightning doesn't hash and never returns busy.
- **A busy 503 is safe to retry.** Each route hashes first, before any database write or Prelude call, so nothing has changed.
- **CORS:** with `allow_cors = true`, `Retry-After` is exposed to browsers.
- **Size containers explicitly.** Without a CPU limit, the default counts every host CPU. Each running hash uses about 19 MiB, so memory peaks near `max_concurrent_hashes × 19 MiB`.
- **`max_concurrent_hashes` is top-level.** In TOML it must come before the first `[table]` header (the example puts it above `[homeserver]`). Placed under a section, it is silently ignored. (Inferred: no `deny_unknown_fields`.)

**Request limits.** Every public request has a 30 s limit (503, body `request_timeout`), and bodies are capped at 64 KiB (413, enforced on streamed bodies too):

```rust
/// Upper bound for one request; the slowest legitimate route is the 25 s
/// Lightning long poll. Slower requests get 503 `request_timeout`.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// Calls to external services must fail before the request is cut.
const _: () = assert!(DEPENDENCY_REQUEST_TIMEOUT.as_secs() < REQUEST_TIMEOUT.as_secs());

/// Request bodies are small JSON documents (an ID token is a few KiB).
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024;
```

<sub>Source: [`src/infrastructure/http/server.rs` @ `master` 9418e87](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/infrastructure/http/server.rs#L33-L40) (verbatim). Unreleased: v0.2.0 has no request timeout or body limit.</sub>

> **After a 503 `request_timeout`, the outcome is unknown.** The request may have been partly processed: a token may have been minted, or an SMS sent. Don't treat it like a busy 503, and don't assume nothing happened.

**Dependency timeout.** `DEPENDENCY_REQUEST_TIMEOUT` is **10 s** for the homeserver admin API, Prelude, the JWKS clients and each phoenixd REST call. For phoenixd it is set per request, because the payments websocket shares the client. The phoenixd websocket connect and stream have **no timeout**.

### Metrics

A `[metrics]` section starts a **second listener** that serves Prometheus text format at `GET /metrics`. Without the section, metrics are off.

- **`listen_socket`** defaults to `127.0.0.1:8081`. In a container, set `listen_socket = "0.0.0.0:8081"` and publish the port only on the private network Prometheus uses. Upstream's scrape example targets `homegate:8081`.
- **`/metrics` has no authentication** (inferred from `metrics_server.rs`). Keep it off the public network.
- **The metrics listener binds first**, so a port that is already in use stops startup.

For metric names, labels and `reason` values, see the [README metrics table](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/README.md#metrics) and [`src/shared/metrics.rs`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/src/shared/metrics.rs#L91-L131). Useful for alerting: `homegate_dependency_errors_total{dependency}` (`homeserver`, `prelude`, `phoenixd`, `google_jwks`, `apple_jwks`), `homegate_http_requests_total{route,method,status}` and `homegate_route_enabled{type}` (`sms`, `lightning`, `ip`, `google`, `apple`). `route` is the matched template, or `unmatched`.

> **Metric gotchas:**
> - **Counters reset on restart.** Query them with `increase()` or `rate()`.
> - **Exclude `/ln_verification/{id}/await` from latency percentiles.** It long-polls for up to 25 s.
> - **`homegate_verification_rejected_total` is incomplete.** It omits extractor rejections (malformed JSON, unparseable phone numbers), Lightning unknown-id 404s and all other Lightning rejections, the IP 400, database errors and busy 503s. Use `homegate_http_requests_total` by `status` for the full picture.
> - **Homegate can't see whether a code was redeemed.** Upstream points to the homeserver's own `signup_count` metric.
> - **`homegate_build_info{version}` reports `0.2.0` on `master` builds**, so it can't distinguish them from the release.

### Release process

`master` has a new [release process](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/RELEASING.md). No release has used it yet.

- **Pushing a `v*` tag** runs `release.yml`. It checks that the tag is semver and matches `Cargo.toml` and `openapi.yaml` `info.version`, creates a GitHub Release with a conventional-commit changelog and **no binaries**, and publishes `synonymsoft/homegate` for linux/amd64 and linux/arm64, tagged with the version.
- **The Docker image is the only deployable artifact.** The old workflow that produced draft releases with binaries has been deleted.
- **`latest`:** a stable release also takes `latest`. A pre-release (e.g. `v0.3.0-rc.1`) doesn't, and is marked as a pre-release. A hotfix for an older release line still takes `latest` and has to be pointed back by hand, which is one more reason to pin version tags.

## Upstream

- **Repo and README:** <https://github.com/pubky/homegate>
- **Example config (v0.2.0):** [`config.toml.example`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/config.toml.example)
- **API spec (v0.2.0):** [`openapi.yaml`](https://github.com/pubky/homegate/blob/ea838a80b6463124906b8837f8c47e0b0731ecc8/openapi.yaml). It is AI-generated, so verify it against the source.
- **Unreleased `master` sources (9418e87):** [README](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/README.md), [`openapi.yaml`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/openapi.yaml), [`config.toml.example`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/config.toml.example), [`RELEASING.md`](https://github.com/pubky/homegate/blob/9418e87f2bfb7036d7a72c2e95958a6a41f211fa/RELEASING.md)
- **Docker image:** [`synonymsoft/homegate`](https://hub.docker.com/r/synonymsoft/homegate) ([tags](https://hub.docker.com/r/synonymsoft/homegate/tags))
- **Providers:** [Prelude](https://docs.prelude.so/), [phoenixd](https://github.com/ACINQ/phoenixd)
