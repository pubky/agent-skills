# Operator & admin CLI (pubky-cli)

[`pubky-cli`](https://github.com/pubky/pubky-cli) is a Rust CLI that wraps both the homeserver
**admin API** and the user-facing **client API**, reusing the official
[`pubky`](https://docs.rs/pubky/0.6.0-rc.6/pubky/) SDK and the `pubky-testnet` harness. Top-level
subcommands are `admin`, `user`, and `tools`. This file covers the **operator/admin** surface:
server stats, signup/invite tokens, enable/disable users, and WebDAV entry deletion. The `user`
and `tools` subcommands wrap the SDK — see the [README](https://github.com/pubky/pubky-cli/blob/main/README.md).

> **Pre-1.0, churn-prone.** Published `0.1.0-rc.1` (single release; `Changes.md` records only
> `v0.0.1`), built against `pubky = 0.6.0-rc.6`, Rust **edition 2024**. The admin command surface
> and the homeserver admin API are unstable. Treat the signatures below as a snapshot — link the
> [README](https://github.com/pubky/pubky-cli/blob/main/README.md) and the homeserver
> [`openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml) for
> current shape rather than relying on these as stable.

## Install & run

```bash
# from a clone
cargo install --path .
# or from crates.io
cargo install pubky-cli
```

Needs a recent Rust toolchain — `Cargo.toml` is **edition 2024** (the README's "1.76+" note
predates that; in practice a newer toolchain is required). You also need a homeserver to talk to:

```bash
# local homeserver
cargo run -p pubky-homeserver -- --data-dir ~/.pubky
# or run the pubky-testnet binary for an ephemeral stack
```

For the "run a homeserver / expose the admin API on :6288" context, see the sibling
[`homeserver.md`](homeserver.md) and [`local-stack.md`](local-stack.md).

## Connection & auth (shared by every `admin` subcommand)

| Flag | Default / source | Notes |
| :-- | :-- | :-- |
| `--admin-url <URL>` | `http://127.0.0.1:6288` | Also accepts a bare `host:port` (retries by prepending `http://`). |
| `--password <PW>` | `$PUBKY_ADMIN_PASSWORD` (clap `env`) | If neither flag nor env is set, prompts interactively with hidden input (rpassword). |

The password is sent in the **`X-Admin-Password`** request header on every admin call, matching
the homeserver admin auth scheme. The client calls `error_for_status()`, so any non-2xx admin
response surfaces as a CLI error.

Environment variables:

| Var | Effect |
| :-- | :-- |
| `PUBKY_ADMIN_PASSWORD` | Admin password (alternative to `--password`); admin HTTP calls. |
| `PUBKY_CLI_RECOVERY_PASSPHRASE` | Auto-decrypt recovery files (CI/tests; **user** flows). |
| `PUBKY_PKARR_BOOTSTRAP` | Comma-separated `host:port` DHT bootstrap nodes. |
| `PUBKY_PKARR_RELAYS` | Comma-separated relay URLs. |
| `PUBKY_PKARR_TIMEOUT_MS` | PKARR request timeout override. |

The `PUBKY_PKARR_*` vars affect the `pubky` client used by **user** flows, not the admin HTTP calls.

## Admin command tree

```text
pubky-cli admin info                            # GET    /info                      — server stats
pubky-cli admin generate-token                  # GET    /generate_signup_token     — mint default-limits token
pubky-cli admin user disable <pubky>            # POST   /users/<z32>/disable
pubky-cli admin user enable  <pubky>            # POST   /users/<z32>/enable
pubky-cli admin storage delete <pubky> <path>   # DELETE /webdav/<z32><path>
```

`<pubky>` and `<path>` are positional string args. (clap renders the `GenerateToken` enum variant
as the kebab-case subcommand `generate-token`.)

### `admin info` — server stats

GETs `{admin-url}/info` and prints five fields parsed from `AdminInfoResponse`:

| Output label | Field |
| :-- | :-- |
| Users | `num_users` |
| Disabled users | `num_disabled_users` |
| Disk usage (MB) | `total_disk_used_mb` |
| Signup codes | `num_signup_codes` |
| Unused signup codes | `num_unused_signup_codes` |

`total_disk_used_mb` is `integer` (int64) on the wire (openapi.yml); the CLI parses it as `f64`
and prints it with 2 decimals.

```bash
# server stats (Users / Disabled users / Disk MB / Signup codes / Unused signup codes)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin info

# point at a non-default admin endpoint
pubky-cli admin info --admin-url http://127.0.0.1:6288 --password admin
```

### `admin generate-token` — mint a signup/invite token

GETs `{admin-url}/generate_signup_token` and prints the returned token (plain text) to stdout.
Generates a token with **all-default limits**. Each call increments both `num_signup_codes` and
`num_unused_signup_codes`. A user redeems it at signup with `--signup-code <token>`.

```bash
# 1) operator: mint a default-limits signup token (prints token to stdout)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin generate-token

# 2) user: redeem it at signup against the homeserver public key
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user signup <homeserver-pk> ./alice.recovery --signup-code <token> --testnet
```

> **The flag is `--signup-code`** (field `signup_code`, `#[arg(long)]`). The README Quick Start
> has an upstream typo `--singup-code` (missing the `n`) — still present on `main`. Do not copy it.
>
> For **custom-limit** tokens (`POST /generate_signup_token`) or **listing** tokens
> (`GET /signup_tokens`), the CLI surfaces neither — call the admin API directly
> (see [`openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml)).

### `admin user disable|enable` — gate a user

```bash
# disable (POST /users/<z32>/disable)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user disable <user-pubkey>

# re-enable (POST /users/<z32>/enable)
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user enable <user-pubkey>
```

The positional arg is parsed by `PublicKey::from_str` first (invalid keys error out), then
interpolated into the route. Disabling shows up in `admin info` as `num_disabled_users`
incrementing while `num_users` is unchanged. If you pass `--password`/`--admin-url` as flags
rather than via env, place them before `disable`/`enable`
(`pubky-cli admin user --password ... disable <pk>`); using the env var avoids the ordering
question.

### `admin storage delete` — remove one WebDAV entry

```bash
# DELETE /webdav/<z32>/pub/app/hello.txt
PUBKY_ADMIN_PASSWORD=admin \
  pubky-cli admin storage delete <user-pubkey> /pub/app/hello.txt
```

DELETEs `{admin-url}/webdav/{pubkey}{path}`. The path is normalized to a leading slash and then
**client-side guarded**: if it does not start with `/pub/` the CLI aborts with
`entry path must start with /pub/` **before** sending any request. It deletes a **single** entry
(one file path), **not** a recursive directory tree.

## Public-key wire format (z32, not the JS `pubky<z32>` display form)

Routes are built with `PublicKey`'s `Display` impl — `format!("users/{}/disable", public_key)`,
`format!("webdav/{}{}", public_key, normalized_path)`. Rust pkarr's `Display` emits **raw
z-base-32 (z32)** — the *opposite* of the JS SDK's `toString()`, which yields the prefixed
`pubky<z32>` display form (see
[`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)).
So on the wire the CLI sends `users/<z32>/disable` and `webdav/<z32>/pub/...`, matching the
homeserver routes.

The command-line arg goes through `PublicKey::from_str`, which accepts raw `z32`, `pk:<z32>`,
`pubky://<z32>`, `http(s)://…<z32>`, and `hostname.<z32>` forms — but **not** a bare `pubky<z32>`
concatenation (no separator). Don't paste a JS `toString()` value as the arg; pass the raw z32.

## Coverage vs the full admin API

Every `admin` subcommand is a 1:1 call onto the homeserver **admin API** (port `6288`,
`X-Admin-Password`); the HTTP method + route per command is annotated in the command tree above
(`storage delete` hits the `DELETE /webdav/{*entry_path}` wildcard route). The admin API exposes
**more than the CLI surfaces** — notably `POST /generate_signup_token` (custom limits) and
`GET /signup_tokens` (list tokens). For the authoritative route/schema set and the "run the admin
API on :6288" context, see the sibling [`homeserver.md`](homeserver.md) and the homeserver
[`openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml).

## Upstream references

- [pubky-cli README](https://github.com/pubky/pubky-cli/blob/main/README.md) — canonical usage
  (admin + user + tools flows, env vars, shell completions)
- [pubky-homeserver `openapi.yml`](https://github.com/pubky/pubky-core/blob/main/pubky-homeserver/openapi.yml)
  — authoritative admin API routes/schemas
- [`pubky` SDK on docs.rs](https://docs.rs/pubky/0.6.0-rc.6/pubky/) — the SDK the `user`
  subcommands wrap
- Sibling refs: [`homeserver.md`](homeserver.md), [`signup-gating.md`](signup-gating.md),
  [`local-stack.md`](local-stack.md)
