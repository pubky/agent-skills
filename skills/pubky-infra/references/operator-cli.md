# Operator & admin CLIs

Two Rust CLIs wrap the homeserver **admin API**. Its default config is `[admin] listen_socket = "127.0.0.1:6288"`, and every request carries an `X-Admin-Password` header.

- **`homeservercli`**: the first-party CLI, in the [`pubky/pubky-homeserver`](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli) workspace. **Use it by default.**
- **`pubky-cli`**: legacy, [`pubky/pubky-cli`](https://github.com/pubky/pubky-cli), pinned to an old SDK. Use it only for what `homeservercli` can't do.

This file does not repeat routes, request/response schemas, quota semantics or exposure rules. For those, see [`homeserver.md` → Admin API](homeserver.md#admin-api-6288), [Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas), [Security guardrails](homeserver.md#security-guardrails) and upstream [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml).

> **Pre-1.0 and unstable.** Both CLIs and the admin API can change.
>
> **Snapshot:** `homeservercli` 0.16.2. Its source is the same in the v0.16.2 release and on `pubky-homeserver` `main` @ `fd24bf0`. That commit is **unreleased** and 25 commits ahead of v0.16.2. Apart from the version and `pubky` dependency bumps, the CLI source has not changed since v0.12.0. `pubky-cli` is at 0.1.0-rc.1 (`main` @ `c041b2b`).
>
> **Verification:** every snippet below was run on 2026-10-26 against a local testnet built from `fd24bf0`, which reports version 0.16.2. No CI-verified snippets exist for either CLI in `pubky-knowledge-base-v2` or `pubky-homeserver/examples`.

## Which CLI

| Task | Use |
| :-- | :-- |
| Server stats, homeserver public key, version | `homeservercli info` |
| Signup token with default or custom limits | `homeservercli signup-tokens generate` |
| Enable or disable a user | `homeservercli users enable\|disable` |
| Read or set per-user quotas | `homeservercli users quota-get\|quota-set` |
| Delete one `/pub` WebDAV entry as admin | `pubky-cli admin storage delete` (install with `--locked`) |
| User-side signup, session or CRUD from a shell | `pubky-cli user ...` (install with `--locked`; old SDK, see [pubky-cli](#pubky-cli-legacy)) |
| List signup tokens (`GET /signup_tokens`), stream events (`GET /events-stream`), reset `allowed_write_paths` to unrestricted or read-only, full `/dav` WebDAV | **Neither.** Call the admin API directly. `GET /signup_tokens` returns quota overrides only on `main` (unreleased, #732). The v0.16.2 release does not return them. |

## homeservercli

### Install

- **Prebuilt (preferred):** every `pubky-homeserver` [GitHub release](https://github.com/pubky/pubky-homeserver/releases) tarball contains **both** `pubky-homeserver` and `homeservercli`. Targets are linux-amd64, linux-arm64, osx-amd64, osx-arm64 and windows-amd64, for example `pubky-homeserver-v0.16.2-osx-arm64.tar.gz`. The latest release is v0.16.2 (2026-10-15). Releases v0.13.0 through v0.16.2 came out within 22 days, so **use the CLI from the same release as your homeserver**.
- **Not on crates.io.** `cargo install homeservercli` fails.
- **From source:** the minimum Rust version (workspace `rust-version`) is **1.89+ for the v0.16.2 tag** and **1.91+ for `main`**. The repo root is a virtual workspace. The upstream README's `cargo install --path .` works only when run from inside `homeservercli/`. From the repo root, use `--path homeservercli`.

```bash
# From the root of a pubky-homeserver clone (check out the tag that matches your homeserver)
# Run against a local testnet: installs homeservercli 0.16.2 from fd24bf0
cargo install --path homeservercli --locked
```

### Connection and auth

Each setting resolves in this order: **flag → env var → `config.toml`**.

| Setting | Flag | Env | `config.toml` |
| :-- | :-- | :-- | :-- |
| Admin password | `--admin-password` (global) | `PUBKY_HOMESERVER_ADMIN_PASSWORD` | `[admin].admin_password` |
| Admin endpoint | `--admin-endpoint` (global) | `PUBKY_HOMESERVER_ADMIN_ENDPOINT` | `[admin].listen_socket` |
| Config dir | `-d`, `--data-dir` (**not** global) | `PUBKY_HOMESERVER_DATA_DIR` | default `~/.pubky`; the CLI reads `<dir>/config.toml` |

The CLI reads the homeserver's own `config.toml` format, so you can point `--data-dir` at the homeserver's data dir.

**The endpoint format depends on the source:**

- The flag and the env var are parsed as a URL and **must include a scheme**, for example `http://127.0.0.1:6288`.
  - A bare `127.0.0.1:6288` fails with `relative URL without a base`.
  - `localhost:6288` is parsed with `localhost` as the scheme, so it is wrong too.
- `config.toml` `listen_socket` is the only source that accepts a bare `host:port`. If the value has no `://`, the CLI prepends `http://`.
- A full URL such as `https://homeserver.example.com` is used unchanged, which suits an admin API behind TLS.

```bash
# Run against a local testnet (testnet password "admin")
export PUBKY_HOMESERVER_ADMIN_PASSWORD="your-admin-password"
export PUBKY_HOMESERVER_ADMIN_ENDPOINT="http://127.0.0.1:6288"   # scheme required here
export PUBKY_HOMESERVER_DATA_DIR="/path/to/config/dir"            # optional

homeservercli info
```

Gotchas:

- **Silent defaults. Always set both values explicitly.**
  - If `<data-dir>/config.toml` **exists** but has no `[admin]` table, or lacks one of its keys, the CLI silently uses `admin_password = "admin"` and `listen_socket = "localhost:6288"`.
  - The missing-value errors appear only when the file is **absent**.
  - A file that can't be read or parsed is a hard error.
  - The default dir is `~/.pubky`, even though a source comment says `~/.config`.
- **`--data-dir`:**
  - A path to an existing *file* fails with `Given path is not a directory: <path>`.
  - A nonexistent path is accepted, and the CLI skips loading config.
- **Missing-value errors.** The password is resolved first, so its error appears first:
  - Password: `Missing admin password. Provide it via '--admin-password', the PUBKY_HOMESERVER_ADMIN_PASSWORD environment variable, or in the config file.`
  - Endpoint: `Missing admin endpoint. Provide it via '--admin-endpoint' or in the config file.` The message doesn't mention the env var, but `PUBKY_HOMESERVER_ADMIN_ENDPOINT` works.
  - An unparsable `listen_socket` also gives the endpoint error.
- **Flag placement.** `--admin-password` and `--admin-endpoint` are global. **`-d`/`--data-dir` is not global, so put it before the subcommand:** `homeservercli --data-dir X info`.
- **Don't pass `--admin-password` on the command line.** It ends up in shell history and the process list. Use the env var or the config file instead. (The CLI's `Debug` output redacts it as `AdminPassword(***)`.)
- **HTTP behavior:**
  - The CLI uses a blocking `reqwest` client with a 30 s timeout and **does not follow redirects**.
  - It sends `User-Agent: homeservercli/<version>`.
  - If the base URL has no trailing slash, the CLI adds one. The warning it logs shows only with `-v`.
  - Paths are joined relative to the base, so a path prefix is kept: `http://host/admin` requests `/admin/info`.
  - Any non-2xx status is an error.
- **Errors hide the server's response body:**
  - Every command maps `401` to `missing or invalid admin password`.
  - The `users` commands also map `404` to `user not found`, `400` to `invalid pubkey format` and `422` to `invalid quota format`.
  - `signup-tokens` maps `422` to `invalid quota format`.
  - Any other status prints `<url> returned <status> <body>`.
  - **To see a 422 validation message, call the admin API directly.**

### Command tree

| Command | Request |
| :-- | :-- |
| `homeservercli info` | `GET /info` |
| `homeservercli signup-tokens generate [QUOTA FLAGS]` | `POST /generate_signup_token` (JSON) |
| `homeservercli users enable <PUBKY>` | `POST /users/<z32>/enable` |
| `homeservercli users disable <PUBKY>` | `POST /users/<z32>/disable` |
| `homeservercli users quota-get <PUBKY>` | `GET /users/<z32>/quota` |
| `homeservercli users quota-set <PUBKY> <QUOTA FLAGS>` | `PATCH /users/<z32>/quota` (JSON) |

There are no commands for listing tokens, listing users, the event stream or WebDAV. (Admin `GET /users` and `GET /users/{pubkey}` exist only on unreleased `main`, #735.)

Quota flags: `--storage-quota-mb`, `--rate-read`, `--rate-write`, `--rate-read-burst`, `--rate-write-burst` and `--allowed-write-paths` (repeatable). For the full option list, run `homeservercli <cmd> --help`.

### `<PUBKY>` argument

[`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats) defines the display form and the z32 form. For this CLI:

- The argument is parsed as `pubky::PublicKey` (pubky-common 0.16.2), which accepts **raw z32 or `pubky<z32>`**.
- Routes always use `.z32()`. The server's path extractor rejects a prefixed key (`unexpected `pubky` prefix; expected raw z32`). So `users disable pubky<z32>` is safe through the CLI, but **with `curl` you must send raw z32**.
- An invalid key fails during argument parsing, before any HTTP call.

### `info`

The CLI parses `/info` into a fixed struct and pretty-prints 9 fields:

- `num_users`, `num_disabled_users`, `total_disk_used_mb`, `num_signup_codes`, `num_unused_signup_codes`
- `public_key` (raw z32)
- `pkarr_pubky_address` and `pkarr_icann_domain` (both optional)
- `version`

These match the server today, but **the CLI drops any field the server adds later**. For the raw JSON, call `GET /info` directly. `pubky-cli admin info` prints only the 5 counters.

### `signup-tokens generate`

- Sends a `POST` with a JSON body. Flags you omit are left out of the body, so running it with no flags sends `{}`. A missing field means Default, which the server takes from its system config when it enforces the quota (see [`homeserver.md` → Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas)).
- **Does not accept `default`.** Pass `unlimited` or a value.
- Prints the token (format `XXXX-XXXX-XXXX`) as plain text on stdout.
- The server validates the quota. A 422 shows only as `invalid quota format`.
- **Token limits apply only when signup requires a token** (`signup_mode = "token_required"`). With open signup, the server neither checks nor uses up the token, and the new user gets the default quota. For production gating, see [`signup-gating.md`](signup-gating.md).

```bash
# Run against a local testnet; the server stored exactly these quotas
# Unlimited storage, default rates
homeservercli signup-tokens generate --storage-quota-mb unlimited

# 500 MB storage, 10 MB/s read, 1 MB/s write
homeservercli signup-tokens generate \
  --storage-quota-mb 500 \
  --rate-read 10mb/s \
  --rate-write 1mb/s
```

### `users enable | disable`

Sends a `POST` with no body and prints the response text (`Ok`). The server returns `400` for a malformed key and `404` for an unknown user. A disabled user's writes get `403 User is disabled`.

### `users quota-get`

Prints only `effective`, the merged quota with every field filled in. **It drops the server's `overrides` object**, so you can't tell a per-user override from a system default. To see both, call `GET /users/{pubkey}/quota` directly.

### `users quota-set`

- Requires at least one quota flag. Without one, clap reports a usage error.
- On success it prints an empty line, because the server returns 200 with no body.
- For what the server does with each value, see [`homeserver.md` → Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas).

Each scalar flag becomes a field in the PATCH body:

| CLI input | JSON sent |
| :-- | :-- |
| flag omitted | field absent (current value kept) |
| `default` (case-insensitive) | `null` (resets to Default) |
| `unlimited` | `"unlimited"` |
| a value | the value |

```bash
# Run against a local testnet with a freshly signed-up user's raw z32 as <PUBKY>.
# Each change was confirmed through the server's overrides object.
# Set storage limit to 1 GB
homeservercli users quota-set <PUBKY> --storage-quota-mb 1024

# Remove storage limit
homeservercli users quota-set <PUBKY> --storage-quota-mb unlimited

# Reset the storage override back to the system default
homeservercli users quota-set <PUBKY> --storage-quota-mb default

# Set read rate to 5 MB/s
homeservercli users quota-set <PUBKY> --rate-read 5mb/s

# Restrict writes to specific paths (repeatable)
# Writes to other paths then get 403 "Write to this path is not allowed"
homeservercli users quota-set <PUBKY> \
  --allowed-write-paths /pub/tokens/ \
  --allowed-write-paths /pub/profile.json
```

### Value formats

- **Rate:** `<number><kb|mb|gb>/<s|m|h|d>` or `unlimited`.
  - The number is a `u32` greater than 0.
  - Input is trimmed and lowercased, so `100MB/S` becomes `100mb/s`.
  - The CLI validates rates **before any HTTP call**. These all fail: `500b/s`, `100mb/w`, `100mbs`, `mb/s`, `100/s`, an empty string and `0mb/s`. The error is `invalid rate '<input>': expected <number><kb|mb|gb>/<s|m|h|d> (e.g. 100mb/s) or 'unlimited'`.
- **Storage quota:** a `u64` or `unlimited` (case-insensitive). `0` is accepted. Only `quota-set` also accepts `default`.
- **Not the same as `[[drive.rate_limits]]`.** That homeserver `config.toml` setting limits request *counts* per IP, for example `quota = "10r/m"` on `GET /signup_tokens/*`. This CLI sets per-user *bandwidth*. See [`homeserver.md` → config.toml](homeserver.md#configtoml).

### Burst flags

The burst rules are defined in [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml). What this means for the CLI:

- **`generate`: always pass the rate with its burst**, for example `--rate-read 5mb/s --rate-read-burst 5`. A burst without its rate gets a server 422 (`<label> requires the corresponding rate to be set to a value`), which the CLI shows only as `invalid quota format`.
- **`quota-set`:** the server checks that a burst has a rate on the *merged* quota. A burst flag on its own succeeds if the user already has an explicit rate override. Otherwise it fails the same way.
- **Use a burst of 1 or more.** `0` passes CLI parsing (`u32`), but the server rejects it (`NonZeroU32`). Values above `i32::MAX` are also rejected. Both show only as `invalid quota format`.

### `allowed_write_paths` gap

The server rules, per [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml):

- `null` means unrestricted, and `[]` means read-only.
- A trailing `/` matches a directory prefix. A path without one matches one exact file.
- `/` is rejected (`must not be '/'; use null for unrestricted access`), and so are duplicate entries.

`--allowed-write-paths` is a plain list with no `default` value, and the CLI leaves an empty list out of the body. So **homeservercli cannot reset a user to unrestricted (`null`) or make a user read-only (`[]`)**. For either, call `PATCH /users/{pubkey}/quota` directly.

## pubky-cli (legacy)

[`pubky-cli`](https://github.com/pubky/pubky-cli) `0.1.0-rc.1` is the only version on crates.io. There is no stable release, and `Changes.md` lists only `v0.0.1 Initial Release`. Upstream `main` hasn't changed since 2026-09-07.

Build facts:

- Edition 2024, so it needs **Rust 1.85+**.
- Uses `reqwest` 0.12 with `rustls-tls`.
- Depends on **`pubky = "0.6.0-rc.6"`**.

What it can do:

- **User flows:** signup, signin, session inspection, signout, `publish`/`get`/`delete`, directory listing, and handing off a third-party auth token.
- **Admin flows:** info, generate-token, user enable/disable, and storage (WebDAV) delete.
- **Tools:** `generate-recovery`, plus `completions` for bash, zsh, fish, powershell and elvish.

**Always install with `--locked`:**

```bash
# Run against a local testnet: resolves pubky v0.6.0-rc.6
cargo install pubky-cli --version 0.1.0-rc.1 --locked
```

**Why `--locked` matters:**

- pubky-cli builds admin routes with `format!("...{}", public_key)`, which uses the key's `Display` form instead of `.z32()`.
- The homeserver rejects `pubky`-prefixed keys in admin paths, both in the user routes and in the WebDAV entry path.
- The locked `pubky 0.6.0-rc.6` displays keys as raw z32, so `admin user` and `admin storage` work.
- Without `--locked`, the `^0.6.0-rc.6` requirement resolves to 0.6.0 stable, which displays `pubky<z32>`, and those commands break.
- Even with `--locked`, **pass raw z32 keys only**.

**The user flows run an old 0.6 rc SDK.** They aren't guaranteed to work with current homeservers (0.16.x).

### Admin connection

These connection flags are added to **each** admin subcommand (`info`, `generate-token`, `user`, `storage`):

- **`--admin-url`** defaults to `http://127.0.0.1:6288`. **Always include `http://`.** A value that fails to parse as a URL, such as `127.0.0.1:6288`, is retried with `http://` prepended. `localhost:6288` does parse (with `localhost` as the scheme), so it isn't retried and the request fails.
- **`--password`** falls back to the **`PUBKY_ADMIN_PASSWORD`** env var, then to a hidden prompt. This is a different variable from homeservercli's `PUBKY_HOMESERVER_ADMIN_PASSWORD`.
- **Other env vars:** `PUBKY_CLI_RECOVERY_PASSPHRASE`, `PUBKY_PKARR_BOOTSTRAP`, `PUBKY_PKARR_RELAYS` and `PUBKY_PKARR_TIMEOUT_MS`.
- **Flag placement:** for `admin user` and `admin storage`, the connection flags belong to `user` or `storage`. Put them after that word and before `disable`, `enable` or `delete`. With `PUBKY_ADMIN_PASSWORD` set and the default URL, you need no flags.

### Admin commands

| Command | Request |
| :-- | :-- |
| `pubky-cli admin info` | `GET /info` (5 counters only) |
| `pubky-cli admin generate-token` | `GET /generate_signup_token` (default limits only; the server still accepts GET) |
| `pubky-cli admin user disable\|enable <pubky>` | `POST /users/<Display(pk)>/disable\|enable` |
| `pubky-cli admin storage delete <pubky> <path>` | `DELETE /webdav/<Display(pk)><path>` |

- `storage delete` adds a leading `/` if the path has none. Before sending anything, it rejects any path that doesn't start with `/pub/` (`entry path must start with /pub/`).
- For the homeserver public key, the version, or tokens with custom limits, use `homeservercli`.

```bash
# Run against a local testnet (0.16.2): num_disabled_users went 0 -> 1 -> 0,
# and the disabled user's writes got 403 "User is disabled".
# Use the user's raw z32 public key printed during signup
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user disable <user-pubkey>

# Re-enable the same user
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user enable <user-pubkey>
```

`admin` is the default password on a local or testnet homeserver only.

### README errors

- The README recommends Rust 1.76, but edition 2024 needs **1.85+**.
- The Quick Start misspells the flag as `--singup-code`. The real flag is **`--signup-code`**.

## Upstream references

- [homeservercli README](https://github.com/pubky/pubky-homeserver/blob/main/homeservercli/README.md) and [source](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli)
- [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases) (v0.16.2 ships prebuilt `homeservercli`)
- [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml): the authoritative admin routes, schemas and quota semantics
- [pubky-cli README](https://github.com/pubky/pubky-cli/blob/main/README.md) and [crates.io](https://crates.io/crates/pubky-cli)
- Canonical: [`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)
- Related: [`homeserver.md`](homeserver.md), [`signup-gating.md`](signup-gating.md), [`local-stack.md`](local-stack.md)
