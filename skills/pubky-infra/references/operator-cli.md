# Operator & admin CLIs

Two Rust CLIs wrap the homeserver **admin API**. The admin server listens on `[admin] listen_socket = "127.0.0.1:6288"` by default, and every CLI request sends an `X-Admin-Password` header. (On the admin server, `GET /` is public and `/dav` uses HTTP Basic auth with user `admin`, not that header.)

- **`homeservercli`**: the first-party CLI, in the [`pubky/pubky-homeserver`](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli) workspace. **Use it.**
- **`pubky-cli`**: **deprecated and archived** ([`pubky/pubky-cli`](https://github.com/pubky/pubky-cli)), pinned to an old SDK. Use it only for the one admin task `homeservercli` lacks (WebDAV delete), or call the admin API directly instead.

This file does not repeat routes, request/response schemas, quota semantics or exposure rules. For those, see [`homeserver.md` → Admin API](homeserver.md#admin-api-6288), [Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas), [Security guardrails](homeserver.md#security-guardrails) and upstream [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml), which is authoritative.

> **Pre-1.0 and unstable.** The admin API keeps changing: v0.18.0 shipped breaking changes to event cursors and path encoding. v0.16.2, v0.17.1 and v0.18.0 were released within 25 days, so **use the `homeservercli` from the same release as your homeserver**.
>
> **Snapshot:** `homeservercli` 0.18.0, which depends on `pubky` 0.18.0 by path. The latest release is v0.18.0 (2026-11-09). `main` @ `8612a64` is **unreleased** and 9 commits ahead of v0.18.0. From v0.16.2 to `8612a64`, the only change under `homeservercli/` is `Cargo.toml` (version and `pubky` bumps). The CLI source and README are byte-identical.
>
> **Verification:** the `homeservercli` source install, `info` via env vars, `signup-tokens generate`, every `users quota-set` example (including the `allowed_write_paths` 403 check) and the `pubky-cli --locked` install were run on 2026-11-12 against a local 0.18.0 testnet. Neither CLI has CI-verified snippets in `pubky-knowledge-base-v2` or `pubky-homeserver/examples`. `pubky-homeserver/docs` never mentions `homeservercli`; its [post-setup guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/deploy/post-setup.md) calls `/info` with `curl`.

## Which CLI

| Task | Use |
| :-- | :-- |
| Server stats, homeserver public key, version | `homeservercli info` |
| Signup token with default or custom limits | `homeservercli signup-tokens generate` |
| Enable or disable a user | `homeservercli users enable\|disable` |
| Read or set per-user quotas | `homeservercli users quota-get\|quota-set` |
| Delete one `/pub` WebDAV entry as admin | Admin `DELETE /webdav/<z32>/pub/...` directly, or legacy `pubky-cli admin storage delete` (install with `--locked`) |
| List users, get one user, list signup tokens, read the event stream, reset `allowed_write_paths` to unrestricted or read-only, use the full `/dav` WebDAV | **No CLI.** Call the admin API directly (see the notes below). |
| User-side signup, session or CRUD | Not a CLI job. Use an SDK ([`sdk-rust.md`](../../pubky/references/sdk-rust.md), [`sdk-js.md`](../../pubky/references/sdk-js.md)). |

Notes for direct admin calls:

- `GET /users` and `GET /users/{pubkey}` (#735, #745) are **released** in v0.17.1 and later, and so are the quota overrides in `GET /signup_tokens` (#732). `GET /users` is paginated, and its cursor is a raw z32 key. Take parameters and response fields from [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml), not from memory.
- **Since v0.18.0 (#753), `/events-stream` returns 400 for legacy Base32 timestamp cursors.** Pass a numeric event ID, or omit the cursor (or pass `0`) to start from the beginning. In each event, the path after `pubky://<user>` is the stored name, not percent-encoded (#797).
- Path keys must be **raw z32**. The server rejects `pubky<z32>` with ``unexpected `pubky` prefix; expected raw z32``. See [`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

## homeservercli

### Install

- **Prebuilt (preferred):** every `pubky-homeserver` [GitHub release](https://github.com/pubky/pubky-homeserver/releases) tarball contains **both** `pubky-homeserver` and `homeservercli`. The targets are linux-amd64, linux-arm64, osx-amd64, osx-arm64 and windows-amd64, for example `pubky-homeserver-v0.18.0-osx-arm64.tar.gz`. There is no v0.17.0 release; v0.17.1 replaced it the same day.
- **Not on crates.io.** `cargo install homeservercli` fails.
- **From source:** the workspace needs Rust **1.91+** for v0.17.1, v0.18.0 and `main` (1.89 for v0.16.2). The repo root is a virtual workspace. The upstream README's `cargo install --path .` works only from inside `homeservercli/`; from the repo root, use `--path homeservercli`.

```bash
# From the root of a pubky-homeserver clone, checked out at the tag matching your homeserver
cargo install --path homeservercli --locked
```

<sub>Executed against a local testnet (2026-11-12): built `homeservercli 0.18.0` from the workspace root, and `--locked` left `Cargo.lock` untouched.</sub>

### Connection and auth

The CLI resolves each setting in this order: **flag → env var → `config.toml`**.

| Setting | Flag | Env | `config.toml` |
| :-- | :-- | :-- | :-- |
| Admin password | `--admin-password` (global) | `PUBKY_HOMESERVER_ADMIN_PASSWORD` | `[admin].admin_password` |
| Admin endpoint | `--admin-endpoint` (global) | `PUBKY_HOMESERVER_ADMIN_ENDPOINT` | `[admin].listen_socket` |
| Config dir | `-d`, `--data-dir` (**not** global) | `PUBKY_HOMESERVER_DATA_DIR` | default `~/.pubky`; the CLI reads `<dir>/config.toml` |

The CLI reads the homeserver's own `config.toml` format, so `--data-dir` can point at the homeserver's data dir.

**The endpoint format depends on where it comes from:**

- The flag and the env var are parsed as a `url::Url` and **must include a scheme**, for example `http://127.0.0.1:6288`. A bare `127.0.0.1:6288` fails with `relative URL without a base`. `localhost:6288` does parse, but with `localhost` as the scheme, so it is also wrong.
- Only `config.toml` `listen_socket` accepts a bare `host:port`. If the value has no `://`, the CLI prepends `http://`.
- A full URL such as `https://homeserver.example.com` is used as given, for example when the admin API sits behind TLS.

```bash
export PUBKY_HOMESERVER_ADMIN_PASSWORD="your-admin-password"
export PUBKY_HOMESERVER_ADMIN_ENDPOINT="http://127.0.0.1:6288"   # scheme required here
export PUBKY_HOMESERVER_DATA_DIR="/path/to/config/dir"            # optional

homeservercli info
```

<sub>Executed against a local 0.18.0 testnet (2026-11-12): printed all 9 `info` fields with `"version": "0.18.0"`. With a wrong password it printed `Error: missing or invalid admin password` and exited 1.</sub>

Gotchas:

- **Silent defaults: always set the password and endpoint explicitly.**
  - If `<data-dir>/config.toml` **exists** but has no `[admin]` table or is missing a key, the CLI silently uses `admin_password = "admin"` and `listen_socket = "localhost:6288"`.
  - If the file is **missing**, the CLI skips it (logged only at debug level) and you get the missing-value errors below. A file that can't be read or parsed is a hard error.
  - The default dir is `~/.pubky`, even though a comment in the source says `~/.config`.
- **`--data-dir`:** a path to an existing *file* fails with `Given path is not a directory: <path>`. A path that doesn't exist is accepted, and config loading is skipped.
- **Missing-value errors.** The password is resolved first, so its error appears first:
  - `Missing admin password. Provide it via '--admin-password', the PUBKY_HOMESERVER_ADMIN_PASSWORD environment variable, or in the config file.`
  - `Missing admin endpoint. Provide it via '--admin-endpoint' or in the config file.` The message doesn't mention the env var, but `PUBKY_HOMESERVER_ADMIN_ENDPOINT` works. An unparsable `listen_socket` produces the same error.
- **Flag placement:** `-d`/`--data-dir` is not global (the upstream README's "Global options" table is wrong). Put it **before** the subcommand: `homeservercli --data-dir X info`.
- **Don't pass `--admin-password` on the command line.** It ends up in shell history and the process list. Use the env var or the config file instead. (`Debug` output redacts it as `AdminPassword(***)`.)
- **HTTP behavior:** blocking `reqwest`, 30 s timeout, **redirects not followed**, `User-Agent: homeservercli/<version>`. If the base URL has no trailing slash, the CLI adds one (it warns only with `-v`). Paths are joined relative to the base, so a prefix is kept: `http://host/admin` becomes `/admin/info`.
- **Errors hide the server's response body:**
  - Every command maps `401` to `missing or invalid admin password`.
  - `users` commands also map `404` to `user not found`, `400` to `invalid pubkey format` and `422` to `invalid quota format`.
  - `signup-tokens` maps `422` to `invalid quota format`.
  - Any other non-2xx status prints `<url> returned <status> <body>`.
  - **To see the message behind a 422, call the admin API directly.**

### Command tree

| Command | Request |
| :-- | :-- |
| `homeservercli info` | `GET /info` |
| `homeservercli signup-tokens generate [QUOTA FLAGS]` | `POST /generate_signup_token` (JSON) |
| `homeservercli users enable <PUBKY>` | `POST /users/<z32>/enable` |
| `homeservercli users disable <PUBKY>` | `POST /users/<z32>/disable` |
| `homeservercli users quota-get <PUBKY>` | `GET /users/<z32>/quota` |
| `homeservercli users quota-set <PUBKY> <QUOTA FLAGS>` | `PATCH /users/<z32>/quota` (JSON) |

The quota flags are `--storage-quota-mb`, `--rate-read`, `--rate-write`, `--rate-read-burst`, `--rate-write-burst` and `--allowed-write-paths` (repeatable). Run `homeservercli <cmd> --help` for the full list.

### `<PUBKY>` argument

- Parsed as `pubky::PublicKey`, which strips an optional `pubky` prefix, so **raw z32 and `pubky<z32>`** both work.
- The CLI always puts `.z32()` in the route. With `curl`, send **raw z32**, because the server rejects the prefixed form.
- An invalid key fails during argument parsing, before any HTTP call.

### `info`

Parses `/info` into a fixed struct and pretty-prints 9 fields: `num_users`, `num_disabled_users`, `total_disk_used_mb`, `num_signup_codes`, `num_unused_signup_codes`, `public_key` (raw z32), `pkarr_pubky_address` and `pkarr_icann_domain` (both optional), and `version`. This matches the server at HEAD, but **the CLI drops any field the server adds later**. For the raw JSON, call `GET /info` directly.

### `signup-tokens generate`

- Sends a `POST` with a JSON body. Omitted flags are left out of the body, so running it with no flags sends `{}`. A missing field means Default, which the server resolves when it enforces the quota: storage from `[storage].default_quota_mb`, and rates and bursts from `[default_quotas]` (see [`homeserver.md` → Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas)).
- **Doesn't accept `default`.** Pass `unlimited` or a value.
- Prints the token (`XXXX-XXXX-XXXX`) as plain text on stdout.
- The server validates the quota. A 422 shows only as `invalid quota format`.
- **Token limits apply only when `signup_mode = "token_required"`.** With open signup, the server neither checks nor consumes the token, and the user gets the default quota. For production gating, see [`signup-gating.md`](signup-gating.md).

```bash
# Unlimited storage, default rates
homeservercli signup-tokens generate --storage-quota-mb unlimited

# 500 MB storage, 10 MB/s read, 1 MB/s write
homeservercli signup-tokens generate \
  --storage-quota-mb 500 \
  --rate-read 10mb/s \
  --rate-write 1mb/s
```

<sub>Executed against a local 0.18.0 testnet (2026-11-12): each command printed a token. Raw `GET /signup_tokens` showed the stored quotas `{"storage_quota_mb": "unlimited"}` and `{"storage_quota_mb": 500, "rate_read": "10mb/s", "rate_write": "1mb/s"}`.</sub>

### `users enable | disable`

Sends a `POST` with no body and prints the response text (`Ok`). An unknown user gives `user not found`; a malformed key is rejected at parse time. Writes by a disabled user get `403 User is disabled`.

### `users quota-get`

Prints `{"effective": {...}}` as pretty JSON. **It drops `overrides`**, so you can't tell a per-user override from a system default. To see both, call `GET /users/{pubkey}/quota` directly.

How to read `effective` (per `openapi-admin.yml` since v0.18.0, #749):

- `storage_quota_mb`, `rate_read` and `rate_write` are always present. A Default with no system default resolves to unlimited.
- The burst fields and `allowed_write_paths` appear only when set. **The CLI prints the absent ones as `null`.**
- `allowed_write_paths: null` means **unrestricted**, not "unset".
- An effective burst comes from `[default_quotas]` only when the rate in the same direction is Default. A user with an explicit rate override and no burst override shows a `null` burst.

### `users quota-set`

- Requires at least one quota flag; otherwise clap prints a usage error.
- On success it prints an empty line, because the server returns 200 with no body.

Each scalar flag becomes a field in the PATCH body:

| CLI input | JSON sent |
| :-- | :-- |
| flag omitted | field absent (current value kept) |
| `default` (case-insensitive) | `null` (reset to Default) |
| `unlimited` | `"unlimited"` |
| a value | the value |

```bash
# Set storage limit to 1 GB
homeservercli users quota-set <PUBKY> --storage-quota-mb 1024

# Remove storage limit
homeservercli users quota-set <PUBKY> --storage-quota-mb unlimited

# Reset the storage override back to the system default
homeservercli users quota-set <PUBKY> --storage-quota-mb default

# Set read rate to 5 MB/s
homeservercli users quota-set <PUBKY> --rate-read 5mb/s

# Restrict writes to specific paths (repeatable)
homeservercli users quota-set <PUBKY> \
  --allowed-write-paths /pub/tokens/ \
  --allowed-write-paths /pub/profile.json
```

After the last command, writes to any other path get `403 Write to this path is not allowed`.

<sub>Executed against a local 0.18.0 testnet (2026-11-12) on a freshly signed-up user. After each line, `overrides` was checked through the raw admin API: `default` removed the field, while `unlimited` and plain values were stored as given. Writes to `/pub/profile.json` and `/pub/tokens/a.json` succeeded, and a write to `/pub/other.txt` got 403.</sub>

### Value formats

- **Rate:** `<number><kb|mb|gb>/<s|m|h|d>` or `unlimited`, where the number is a `u32` greater than 0. Input is trimmed and lowercased (`100MB/S` becomes `100mb/s`). The CLI validates rates **before any HTTP call**. These all fail: `500b/s`, `100mb/w`, `100mbs`, `mb/s`, `100/s`, `""`, `0mb/s`, `0kb/d`. Error: `invalid rate '<input>': expected <number><kb|mb|gb>/<s|m|h|d> (e.g. 100mb/s) or 'unlimited'`.
- **Storage quota:** a `u64` (including `0`) or `unlimited`, case-insensitive. Only `quota-set` also accepts `default`.
- **Different from `[[drive.rate_limits]]`.** That homeserver `config.toml` setting limits request *counts* (`quota = "10r/m"`, `r/s|m` only), per IP or per user (`key = "ip" | "user"`); it explicitly doesn't support bandwidth. This CLI sets per-user bandwidth. When a user's quota is Default, the server-wide fallback is `rate_read`/`rate_write` in `[default_quotas]`. See [`homeserver.md` → config.toml](homeserver.md#configtoml).

### Burst flags

[`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml) defines the burst rules. With the CLI:

- **`generate`: always pass the rate together with its burst**, for example `--rate-read 5mb/s --rate-read-burst 5`. A burst without its rate gets a server 422 (`<label> requires the corresponding rate to be set to a value`), which the CLI shows only as `invalid quota format`.
- **`quota-set`:** the server checks that each burst has a rate on the *merged* quota. A burst flag on its own succeeds if the user already has an explicit rate override; otherwise it fails the same way.
- **Use a burst of 1 or more.** `0` passes CLI parsing (`u32`), but the server rejects it, as it does any value above `i32::MAX`. Both show only as `invalid quota format`.

### `allowed_write_paths` gap

Server rules (per `openapi-admin.yml`): `null` means unrestricted and `[]` means read-only. A path ending in `/` matches a directory prefix; any other path matches one exact file. The server rejects `/` (`allowed_write_paths[<i>] must not be '/'; use null for unrestricted access`) and duplicate paths.

`--allowed-write-paths` has no `default` value, and the CLI leaves an empty list out of the body. So **`homeservercli` can't reset a user to unrestricted (`null`) or make a user read-only (`[]`)**. For either, call `PATCH /users/{pubkey}/quota` directly.

## pubky-cli (legacy, archived)

On 2026-10-28, upstream marked [`pubky-cli`](https://github.com/pubky/pubky-cli) deprecated ("Development has moved to homeservercli") and archived the repo. crates.io has only `0.1.0-rc.1`, which is not yanked. **Don't start new work on it.**

Build facts: edition 2024 (**Rust 1.85+**; the README's "1.76" is wrong), `reqwest` 0.12 with `rustls-tls`, **`pubky = "0.6.0-rc.6"`**. Its user flows (signup, signin, session, CRUD) run on that old rc SDK, and nothing guarantees they work with 0.18.x homeservers. The README's `--singup-code` is a typo for `--signup-code`.

If you still need its admin commands, **always install with `--locked`**:

```bash
cargo install pubky-cli --version 0.1.0-rc.1 --locked
```

<sub>Executed (2026-11-12): installed `pubky-cli 0.1.0-rc.1` built against `pubky v0.6.0-rc.6`. `--locked` prints warnings about yanked `spin` 0.9.8 and 0.10.0; they are harmless. `--version` is required because no stable release exists.</sub>

**Why `--locked`:** pubky-cli builds admin paths from the key's `Display` form, not from `.z32()`. The homeserver rejects `pubky`-prefixed keys in admin user routes and in `DELETE /webdav/{*entry_path}`, and still does at HEAD. The locked `pubky 0.6.0-rc.6` displays raw z32, so `admin user` and `admin storage` work. Without `--locked`, `^0.6.0-rc.6` resolves to 0.6.0 stable, which displays `pubky<z32>`, and those commands break. Even with `--locked`, **pass raw z32 keys only**.

### Admin connection and commands

- `--admin-url` defaults to `http://127.0.0.1:6288`. **Always include `http://`.** An unparsable value such as `127.0.0.1:6288` is retried with `http://` prepended, but `localhost:6288` parses (as scheme `localhost`) and then fails.
- `--password` falls back to the **`PUBKY_ADMIN_PASSWORD`** env var (not homeservercli's `PUBKY_HOMESERVER_ADMIN_PASSWORD`), then to a hidden prompt.
- The connection flags belong to **each** admin subcommand. For `admin user` and `admin storage`, put them after `user`/`storage` and before `disable`/`enable`/`delete`.

| Command | Request |
| :-- | :-- |
| `pubky-cli admin info` | `GET /info` (5 counters only) |
| `pubky-cli admin generate-token` | `GET /generate_signup_token` (default limits only) |
| `pubky-cli admin user disable\|enable <pubky>` | `POST /users/<Display(pk)>/disable\|enable` |
| `pubky-cli admin storage delete <pubky> <path>` | `DELETE /webdav/<Display(pk)><path>` |

`storage delete` adds a leading `/` if it's missing. Before sending, it rejects any path that doesn't start with `/pub/` (`entry path must start with /pub/`). For everything else, use `homeservercli`.

## Upstream references

- [homeservercli README](https://github.com/pubky/pubky-homeserver/blob/main/homeservercli/README.md) and [source](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli)
- [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases); [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0) ships a prebuilt `homeservercli`
- [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml): the authoritative admin routes, schemas and quota semantics
- [`config.sample.toml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/config.sample.toml): `[admin]`, `[storage]`, `[default_quotas]`, `[[drive.rate_limits]]`
- [pubky-cli](https://github.com/pubky/pubky-cli) (archived) and its [crates.io page](https://crates.io/crates/pubky-cli)
- Canonical: [`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)
- Related: [`homeserver.md`](homeserver.md), [`signup-gating.md`](signup-gating.md), [`local-stack.md`](local-stack.md)
