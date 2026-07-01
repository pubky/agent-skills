# Operator & admin CLI (pubky-cli)

[`pubky-cli`](https://github.com/pubky/pubky-cli) is a Rust CLI that wraps both the homeserver
**admin API** and the user-facing **client API**, reusing the official
[`pubky`](https://docs.rs/pubky/0.6.0-rc.6/pubky/) SDK. `main.rs` dispatches via clap to exactly
three top-level subcommands:

- **`admin`** — homeserver admin API (this file).
- **`user`** — client API via the `pubky` SDK (signup/session, `pubky://` CRUD).
- **`tools`** — helpers: `generate-recovery`, shell `completions`.

This file covers the **operator/admin** surface: server stats, signup/invite tokens,
enable/disable users, and WebDAV entry deletion. For the `user`/`tools` SDK flows see the
[README](https://github.com/pubky/pubky-cli/blob/main/README.md).

> **Pre-1.0, churn-prone.** Published `0.1.0-rc.1` (single release; `Changes.md` records only
> `v0.0.1 Initial Release`), built against `pubky = 0.6.0-rc.6`, Rust **edition 2024**. The admin
> command surface and the homeserver admin API are unstable. Treat the signatures below as a
> snapshot — link the [README](https://github.com/pubky/pubky-cli/blob/main/README.md) and the
> homeserver [`openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml)
> for current shape rather than relying on these as stable.

## Install & run

```bash
# pubky-cli is not published to crates.io — install from a clone:
cargo install --path .
```

`Cargo.toml` is **edition 2024**, so it needs a recent toolchain (~1.85+) — the README's
"Rust 1.76 or newer" note predates that and is stale. `reqwest` is built with
`default-features = false` + `["json", "rustls-tls"]` (rustls, no `native-tls`), so no system
OpenSSL is required. You also need a homeserver to talk to:

```bash
# local homeserver
cargo run -p pubky-homeserver -- --data-dir ~/.pubky
# or run the pubky-testnet binary for an ephemeral stack
```

For the "run a homeserver / expose the admin API on :6288" context, see the sibling
[`homeserver.md`](homeserver.md) and [`local-stack.md`](local-stack.md).

## Connection & auth (shared by every `admin` subcommand)

`ConnectionArgs` is `#[command(flatten)]`'d into each admin variant:

| Flag | Default / source | Notes |
| :-- | :-- | :-- |
| `--admin-url <URL>` | `http://127.0.0.1:6288` | Parsed by `Url::parse`; a bare `host:port` works (retries by prepending `http://`). Matches the homeserver's documented default of `localhost:6288`. |
| `--password <PW>` | `$PUBKY_ADMIN_PASSWORD` (clap `env`) | If neither flag nor env is set, prompts interactively with hidden input (rpassword). |

Every admin call sends the password in the **`X-Admin-Password`** header (the homeserver's
`adminPassword` scheme) and calls `error_for_status()`, so any non-2xx response surfaces as a CLI
error. The admin client is a plain `reqwest::Client`.

Environment variables:

| Var | Effect |
| :-- | :-- |
| `PUBKY_ADMIN_PASSWORD` | Admin password (alternative to `--password`); used by admin HTTP calls. |
| `PUBKY_CLI_RECOVERY_PASSPHRASE` | Auto-decrypt recovery files (CI/tests; **user** flows). |
| `PUBKY_PKARR_BOOTSTRAP` | Comma-separated `host:port` DHT bootstrap nodes (**user** flows). |
| `PUBKY_PKARR_RELAYS` | Comma-separated relay URLs (**user** flows). |
| `PUBKY_PKARR_TIMEOUT_MS` | PKARR request timeout override (**user** flows). |

The `PUBKY_PKARR_*` vars are read only in `util.rs`/user flows (`build_pubky_from_env`,
`load_keypair_from_recovery_file`) — they do **not** affect the admin HTTP client.

## Admin command tree

```text
pubky-cli admin info                            # GET    /info                      — server stats
pubky-cli admin generate-token                  # GET    /generate_signup_token     — mint default-limits token
pubky-cli admin user disable <pubky>            # POST   /users/<z32>/disable
pubky-cli admin user enable  <pubky>            # POST   /users/<z32>/enable
pubky-cli admin storage delete <pubky> <path>   # DELETE /webdav/<z32><path>
```

Each subcommand is a 1:1 call onto a homeserver admin route. `<pubky>` and `<path>` are positional
string args. clap kebab-cases the `GenerateToken` variant to `generate-token`.

**Argument ordering caveat.** For `info` and `generate-token`, `ConnectionArgs` is flattened
directly on the variant, so `--admin-url`/`--password` follow the subcommand. For `user` and
`storage`, the connection flags are flattened on the **parent** and the action (`disable`/
`enable`/`delete`) is a **nested** subcommand — so the flags must come **after** `user`/`storage`
but **before** the action. Using `$PUBKY_ADMIN_PASSWORD` (and the default URL) sidesteps the
question entirely.

### `admin info` — server stats

GETs `{admin-url}/info` and prints five fields parsed from `AdminInfoResponse`:

| Output label | Field |
| :-- | :-- |
| `Users:` | `num_users` |
| `Disabled users:` | `num_disabled_users` |
| `Disk usage (MB):` | `total_disk_used_mb` (printed `{:.2}`) |
| `Signup codes:` | `num_signup_codes` |
| `Unused signup codes:` | `num_unused_signup_codes` |

```bash
# server stats (Users / Disabled users / Disk MB / Signup codes / Unused signup codes)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin info

# point at a non-default admin endpoint
pubky-cli admin info --admin-url http://127.0.0.1:6288 --password admin
```

Gotchas:

- `total_disk_used_mb` is `integer`/`int64` on the wire (`openapi.yml`); the CLI deserializes it
  into `f64` and prints two decimals.
- The wire `AdminInfoResponse` also carries `public_key`, `pkarr_pubky_address`,
  `pkarr_icann_domain`, and `version` (homeserver pubkey/pkarr addresses/version) — the CLI
  **silently ignores** these. If you need them, GET `/info` directly.

### `admin generate-token` — mint a signup/invite token

GETs `{admin-url}/generate_signup_token` and prints the returned plain-text token to stdout. The
openapi summary for this route is *"Generate signup token (default limits)"* — so the CLI mints a
**default-limits** token. Each call increments both `num_signup_codes` and `num_unused_signup_codes`.
A user redeems it at signup with `--signup-code <token>`.

```bash
# 1) operator: mint a default-limits signup token (prints token to stdout)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin generate-token

# 2) user: redeem it at signup against the homeserver public key
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user signup <homeserver-pk> ./alice.recovery --signup-code <token> --testnet
```

> **The flag is `--signup-code`** (field `signup_code`, `#[arg(long)]`, `Option<String>`). The
> README Quick Start (line 37) has an upstream typo `--singup-code` (missing the `n`) and it is the
> **only** README example showing the flag — copying it produces a broken command. Other README
> signup examples omit the code entirely.
>
> For **custom-limit** tokens or **listing** tokens the CLI surfaces nothing — call the admin API
> directly (see *Coverage vs the full admin API* below).

### `admin user disable | enable` — gate a user

```bash
# disable (POST /users/<z32>/disable)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user disable <user-pubkey>

# re-enable (POST /users/<z32>/enable)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user enable <user-pubkey>
```

The positional arg is parsed by `PublicKey::from_str` **first** (invalid keys error out before any
HTTP), then interpolated into the route via `PublicKey`'s `Display` (raw z32). The CLI prints
`Disabled user <pk>` / `Enabled user <pk>`; the homeserver replies `200 text/plain "Ok"`, which the
CLI ignores. Disabling shows up in `admin info` as `num_disabled_users` incrementing while
`num_users` is unchanged; enabling reverses it.

### `admin storage delete` — remove one WebDAV entry

```bash
# DELETE /webdav/<z32>/pub/app/hello.txt
PUBKY_ADMIN_PASSWORD=admin \
  pubky-cli admin storage delete <user-pubkey> /pub/app/hello.txt
```

DELETEs `{admin-url}/webdav/{pubkey}{path}`. The pubkey is parsed via `PublicKey::from_str`; the
path is normalized to a leading slash and then **client-side guarded** — if it does not start with
`/pub/` the CLI aborts with `entry path must start with /pub/` **before** sending any request. It
deletes a **single** entry (one file path), **not** a recursive directory tree. On success it
prints `Deleted entry <pk><path>`.

### CI-verified invocation ordering

Lifted from the integration tests (`assert_cmd` against an ephemeral testnet), confirming the flag
placement for the nested subcommands:

```bash
# user: connection flags after `user`, before disable/enable
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user --admin-url "$ADMIN_URL" disable "$USER_PUBKEY"
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user --admin-url "$ADMIN_URL" enable  "$USER_PUBKEY"

# storage: connection flags after `storage`, before delete
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin storage --admin-url "$ADMIN_URL" delete "$USER_PUBKEY" /pub/app/hello.txt

# info / generate-token: connection flags right after the subcommand
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin info           --admin-url "$ADMIN_URL"
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin generate-token --admin-url "$ADMIN_URL"
```

The tests pass the user key as `keypair.public_key().to_string()` (the Rust `Display` form), which
round-trips through `PublicKey::from_str`.

## Public-key wire format (z32, not the JS `pubky<z32>` display form)

Routes are built with `PublicKey`'s `Display` impl (`format!("users/{}/disable", public_key)`,
`format!("webdav/{}{}", public_key, normalized_path)`). Rust pkarr's `Display` emits **raw
z-base-32 (z32)** — the *opposite* of the JS SDK's `toString()`, which yields the prefixed
`pubky<z32>` display form. This is the shared public-key formatting concept, covered canonically in
[`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats);
don't restate it.

The command-line arg goes through `PublicKey::from_str` (pkarr 3.10.0, pulled in by `pubky`
0.6.0-rc.6), which strips
`scheme://`, `user@`, `:port`, `/path`, `?query`, `#hash`, and a trailing dot, then z32-decodes the
TLD label. It therefore accepts raw `z32`, `pk:<z32>`, `pubky://<z32>`, `http(s)://…<z32>`, and
subdomain `host.<z32>.` forms — but **rejects** a bare `pubky<z32>` concatenation (no separator,
the JS `toString()` value): that survives stripping as a 57-char string and fails the 32-byte
decode. **Pass the raw z32, not a JS `toString()` value.**

## Two homeserver storage routes: `/webdav` vs `/dav`

The homeserver exposes **two** admin storage surfaces — only one of which the CLI uses:

| Route | Auth scheme | Methods | Used by CLI? |
| :-- | :-- | :-- | :-- |
| `DELETE /webdav/{entry_path}` | `adminPassword` (`X-Admin-Password`) | delete one entry | Yes — `storage delete` |
| `/dav/{path}` | `adminBasicAuth` (a **different** scheme) | full WebDAV: GET/PUT/DELETE + `any()` incl. PROPFIND/MKCOL | No |

The CLI only hits the `X-Admin-Password`-secured `/webdav` delete; it never touches `/dav`. The
openapi `entry_path` example shows a raw-z32 pubkey (`o1gg96ewuo…/pub/file.txt`), matching the
`Display` form the CLI sends.

## Coverage vs the full admin API

The admin API exposes **more than the five CLI commands**. Per the homeserver
[`openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml) (admin
routes declare `servers: http://localhost:6288`; all use security `adminPassword` **except `/dav`**,
which uses `adminBasicAuth`):

- **`POST /generate_signup_token`** — custom-limit tokens (`UserQuota` body: `storage_quota_mb`,
  `rate_read`, `rate_write`; accepts `"unlimited"`). The CLI only mints default-limits via the GET.
- **`GET /signup_tokens`** — paginated token list (query `limit`/`cursor`/`state`, where
  `state ∈ {all, used, unused}`).
- **`GET /users/{pubkey}/quota`** — effective + override quotas for a user.
- **The full `/dav` WebDAV surface** (see above).

The CLI surfaces none of these — call the admin API directly. For the authoritative route/schema
set and the "run the admin API on :6288" context, see the sibling
[`homeserver.md`](homeserver.md).

## Upstream references

- [pubky-cli README](https://github.com/pubky/pubky-cli/blob/main/README.md) — canonical usage
  (admin + user + tools flows, env vars, shell completions)
- [pubky-homeserver `openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml)
  — authoritative admin API routes/schemas (note: `.yml`, not `.yaml`)
- [`pubky` SDK on docs.rs](https://docs.rs/pubky/0.6.0-rc.6/pubky/) — the SDK the `user`
  subcommands wrap
- Sibling refs: [`homeserver.md`](homeserver.md), [`signup-gating.md`](signup-gating.md),
  [`local-stack.md`](local-stack.md)
