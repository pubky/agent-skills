# Operator & admin CLIs

Two Rust CLIs wrap the homeserver **admin API** (default `127.0.0.1:6288`, header `X-Admin-Password`):

- **`homeservercli`**: first-party, in the [`pubky/pubky-homeserver`](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli) workspace. **Use this by default.**
- **`pubky-cli`**: legacy, [`pubky/pubky-cli`](https://github.com/pubky/pubky-cli), pinned to an old SDK. Use it only for what `homeservercli` lacks.

Routes, request/response schemas, quota semantics and exposure rules are not repeated here. See [`homeserver.md` → Admin API](homeserver.md#admin-api-6288), [Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas), [Security guardrails](homeserver.md#security-guardrails) and upstream [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml).

> **Pre-1.0, unstable.** Both CLIs and the admin API can change. Snapshot: `homeservercli` 0.12.0 (`pubky-homeserver` `main` @ `28f4bf3`, no `homeservercli` changes since tag `v0.12.0`) and `pubky-cli` 0.1.0-rc.1 (`main` @ `c041b2b`). Snippets marked "executed" were run against a local 0.12.0 testnet.

## Which CLI

| Task | Use |
| :-- | :-- |
| Server stats, homeserver public key, version | `homeservercli info` |
| Signup token, default or custom limits | `homeservercli signup-tokens generate` |
| Enable or disable a user | `homeservercli users enable\|disable` |
| Read or set per-user quotas | `homeservercli users quota-get\|quota-set` |
| Delete one `/pub` WebDAV entry as admin | `pubky-cli admin storage delete` (install with `--locked`) |
| User-side signup, session or CRUD from a shell | `pubky-cli user ...` (install with `--locked`; old SDK, see [caveat](#pubky-cli-legacy)) |
| List signup tokens (`GET /signup_tokens`), stream events, reset `allowed_write_paths` to unrestricted or read-only, full `/dav` WebDAV (Basic auth) | **Neither.** Call the admin API directly. |

## homeservercli

### Install

- **Prebuilt (preferred):** every `pubky-homeserver` [GitHub release](https://github.com/pubky/pubky-homeserver/releases) tarball ships **both** `pubky-homeserver` and `homeservercli` for linux-amd64, linux-arm64, osx-amd64, osx-arm64 and windows-amd64 (e.g. `pubky-homeserver-v0.12.0-osx-arm64.tar.gz`). `homeservercli --version` prints `homeservercli 0.12.0`. Match the CLI release to your homeserver.
- **Not on crates.io.** `cargo install homeservercli` does not work.
- **From source:** the repo root is a virtual workspace. Upstream README's `cargo install --path .` works only from inside `homeservercli/`; from the root it fails with `found a virtual manifest ... instead of a package manifest`. Needs Rust 1.89+.

```bash
# from the root of a pubky-homeserver clone (executed: installs homeservercli v0.12.0)
cargo install --path homeservercli --locked
```

### Connection and auth

Each setting resolves **flag → env var → `config.toml`**.

| Setting | Flag | Env | `config.toml` |
| :-- | :-- | :-- | :-- |
| Admin password | `--admin-password` | `PUBKY_HOMESERVER_ADMIN_PASSWORD` | `[admin].admin_password` |
| Admin endpoint | `--admin-endpoint` | `PUBKY_HOMESERVER_ADMIN_ENDPOINT` | `[admin].listen_socket` |
| Config dir | `-d`, `--data-dir` | `PUBKY_HOMESERVER_DATA_DIR` | default `~/.pubky` (reads `<dir>/config.toml`) |

**Endpoint value formats differ by source.** The flag and env var are parsed as a URL and **need a scheme** (`http://127.0.0.1:6288`). A bare `127.0.0.1:6288` fails with `relative URL without a base` (exit 2), and `localhost:6288` parses `localhost:` as the scheme and fails with `invalid path: info`. Only `config.toml` `listen_socket` accepts a bare `host:port` (http assumed); it also takes a full URL such as `https://…` for a TLS-fronted admin API.

The config file format is the homeserver's own `config.toml`, so `--data-dir` can point at the homeserver's data dir.

```toml
[admin]
admin_password = "your-admin-password"
listen_socket = "127.0.0.1:6288"
```

```bash
# executed (with a real password and http://localhost:6288): prints the /info JSON, exit 0
export PUBKY_HOMESERVER_ADMIN_PASSWORD="your-admin-password"
export PUBKY_HOMESERVER_ADMIN_ENDPOINT="https://your-homeserver.example.com"
export PUBKY_HOMESERVER_DATA_DIR="/path/to/config/dir"   # a nonexistent dir is skipped, not an error

homeservercli info
```

Gotchas:

- **Silent defaults.** If `<data-dir>/config.toml` **exists** but lacks `[admin]` or one of its keys, the CLI quietly uses `admin_password = "admin"` and `listen_socket = "localhost:6288"` (a config with only `[general]` connected and succeeded against a local homeserver). Missing-value errors happen only when the file is **absent**; an unparseable file is also an error. Always set both values explicitly.
- **Missing-value errors (exit 1).** The password resolves first, so it errors first: `Missing admin password. Provide it via '--admin-password', the PUBKY_HOMESERVER_ADMIN_PASSWORD environment variable, or in the config file.` Then: `Missing admin endpoint. Provide it via '--admin-endpoint' or in the config file.` (that message omits the env var, but `PUBKY_HOMESERVER_ADMIN_ENDPOINT` works).
- **Flag placement.** `--admin-password`, `--admin-endpoint`, `-v` and `-q` are global (before or after the subcommand). **`-d`/`--data-dir` is not global: put it before the subcommand.** `homeservercli info --data-dir X` fails with `unexpected argument '--data-dir'` (exit 2); write `homeservercli --data-dir X info`.
- **Don't pass `--admin-password` on the command line.** It leaks into shell history and the process list. Use the env var or config file. (The CLI's `Debug` output redacts it.)
- **HTTP behavior.** Blocking client, 30 s timeout, **no redirect following**. Sends `User-Agent: homeservercli/<version>` and `X-Admin-Password` on every request. An endpoint path prefix gets a trailing slash added, so `http://host/admin` hits `/admin/info` (the warning shows only with `-v`). Any non-2xx is exit 1.
- **Errors hide the server body.** `401` always prints `missing or invalid admin password`. `users` commands: `404` → `user not found`, `400` → `invalid pubkey format`, `422` → `invalid quota format`. `signup-tokens`: `422` → `invalid quota format`. Other statuses print `<url> returned <status> <body>`. **To see a 422 validation message, call the admin API directly.**
- **Logging.** `-v`/`-q` are repeatable. Warnings are hidden at the default level.

### Command tree

No storage/WebDAV delete, token listing or event stream.

```text
homeservercli info                                   # GET   /info
homeservercli signup-tokens generate [QUOTA FLAGS]   # POST  /generate_signup_token  (JSON)
homeservercli users enable  <PUBKY>                  # POST  /users/<z32>/enable
homeservercli users disable <PUBKY>                  # POST  /users/<z32>/disable
homeservercli users quota-get <PUBKY>                # GET   /users/<z32>/quota
homeservercli users quota-set <PUBKY> <QUOTA FLAGS>  # PATCH /users/<z32>/quota      (JSON)
```

Quota flags: `--storage-quota-mb`, `--rate-read`, `--rate-write`, `--rate-read-burst`, `--rate-write-burst`, `--allowed-write-paths` (repeatable). `homeservercli <cmd> --help` lists all options.

### `<PUBKY>` argument

Display vs z32 is defined once in [`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats). For this CLI:

- Parsed as `pubky::PublicKey` (0.12): accepts **raw z32 or `pubky<z32>`**. The route always uses `.z32()`, so `users disable pubky<z32>` sends `POST /users/<z32>/disable`.
- Bad input fails before any HTTP call (exit 2): `invalid value 'notakey' for '<PUBKY>': Invalid PublicKey length, expected 32 bytes but got: 4`.

### `info`

Prints the full `/info` JSON (fields: [`homeserver.md` → Admin API](homeserver.md#admin-api-6288)), **including** `public_key` (raw z32) and `version`, which `pubky-cli admin info` drops.

### `signup-tokens generate`

- Always `POST`. Omitted flags are omitted from the JSON body, which means the **system default from the homeserver config** (`[default_quotas]` for `rate_read`/`rate_write`, `[storage].default_quota_mb` for storage). No flags → body `{}` → default limits.
- Prints the plain-text token (`XXXX-XXXX-XXXX`) to stdout.
- A burst flag needs its rate flag in the same call (see [Burst flags](#burst-flags)).
- On a homeserver with open signup, the token is not consumed on signup (`used_at` stays `null`) and its custom limits are **not applied** to the new user. Token limits only matter under token-gated signup. For production gating see [`signup-gating.md`](signup-gating.md).

```bash
# executed: both mint a token (exit 0)

# Unlimited storage, default rates
homeservercli signup-tokens generate --storage-quota-mb unlimited

# 500 MB storage, 10 MB/s read, 1 MB/s write
homeservercli signup-tokens generate \
  --storage-quota-mb 500 \
  --rate-read 10mb/s \
  --rate-write 1mb/s
```

### `users enable | disable`

`POST` with no body. Prints the response text (`Ok`).

### `users quota-get`

Prints only `{"effective": {storage_quota_mb, rate_read, rate_write, rate_read_burst, rate_write_burst, allowed_write_paths}}`. **The server's `overrides` object is dropped**, so you can't tell per-user overrides from system defaults. For that, call `GET /users/{pubkey}/quota` directly.

### `users quota-set`

Requires at least one quota flag (else exit 2). Success prints an empty line (server returns 200 with no body). CLI input maps to the PATCH body per scalar field; for what the server does with each, see [`homeserver.md` → Signup tokens and quotas](homeserver.md#signup-tokens-and-quotas).

| CLI input | JSON sent |
| :-- | :-- |
| flag omitted | field absent |
| `default` | `null` |
| `unlimited` | `"unlimited"` |
| a value | the value |

Example: `--storage-quota-mb default --rate-read unlimited --rate-read-burst default` sends `{"storage_quota_mb":null,"rate_read":"unlimited","rate_read_burst":null}`.

```bash
# executed: each line exit 0, change confirmed with users quota-get

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

### Value formats

- **Rate:** `<number><kb|mb|gb>/<s|m|h|d>` or `unlimited`. Number is a `u32` > 0. Trimmed, case-insensitive (`100MB/S` → `100mb/s`). Validated **before any HTTP call**; rejects `b` units (`500b/s`), a `w` period, `0`, and a missing number, unit or slash (e.g. `5MB`). Error (exit 2): `invalid rate '500b/s': expected <number><kb|mb|gb>/<s|m|h|d> (e.g. 100mb/s) or 'unlimited'`.
- **Storage quota:** `u64` or `unlimited` (case-insensitive); `quota-set` also accepts `default`.
- **Not `[[drive.rate_limits]]`.** That homeserver `config.toml` setting limits request counts (`<n>r/<s|m>`) and rejects bandwidth units. Per-user bandwidth is what this CLI sets. See [`homeserver.md` → config.toml](homeserver.md#configtoml).

### Burst flags

Burst rules (unit, default, merge-time validation) are in [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml). CLI-visible behavior:

- **`generate`: pass the rate with its burst** (`--rate-read 5mb/s --rate-read-burst 5`). A burst alone gets a server 422 (`rate_read_burst requires the corresponding rate to be set to a value`), which the CLI prints only as `invalid quota format` (exit 1).
- **`quota-set`:** the server validates the merged quota, so a burst alone succeeds if the user already has an explicit rate override, and fails the same way otherwise.
- **`0` passes CLI parsing but the server rejects it**, again shown as `invalid quota format`. Use 1 or more.

### `allowed_write_paths` gap

Server semantics (`null` = unrestricted, `[]` = read-only, directory vs exact match, what counts as a write) are in [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml). CLI limits:

- `--allowed-write-paths` is a plain list: no `default`, and an empty list is omitted from the body. So homeservercli **cannot** reset a user to unrestricted (`null`) or make a user read-only (`[]`). Use `PATCH /users/{pubkey}/quota` directly for both.
- `--allowed-write-paths ""` sends `[""]`, not `[]`.

## pubky-cli (legacy)

[`pubky-cli`](https://github.com/pubky/pubky-cli) `0.1.0-rc.1` is the only version on crates.io (no stable release). Edition 2024 (Rust 1.85+), `reqwest` + `rustls-tls`, **`pubky = "0.6.0-rc.6"`**. `Changes.md` records only `v0.0.1 Initial Release`.

- **User flows:** signup, signin, session, signout, list, publish/get/delete, auth-token hand-off.
- **Admin flows:** info, generate-token, user enable/disable, storage delete.
- **Tools:** `generate-recovery`; `completions` for bash, zsh, fish, powershell, elvish.

**Always install with `--locked`:**

```bash
cargo install pubky-cli --version 0.1.0-rc.1 --locked
```

Admin routes are built from the key's `Display`, not `.z32()`. The locked SDK (0.6.0-rc.6) displays raw z32. Without `--locked`, cargo resolves `pubky` 0.6.0, whose `Display` is `pubky<z32>`; the homeserver rejects that route (400), so `admin user` and `admin storage` break. Even when locked, **pass raw z32 only**: a `pubky<z32>` argument fails with `Invalid PublicKey length, expected 32 bytes but got: 35` (exit 1).

**User flows run an old 0.6 rc SDK; compatibility with newer homeservers is not guaranteed.** Against a local 0.12.0 testnet, `user signin`, `session`, `publish`, `get` and `delete` worked. `user signup ... --testnet` created the user but failed with `Failed to publish record to the DHT` until `PUBKY_PKARR_RELAYS=http://localhost:15411` pointed it at the local relay.

### Admin connection

- `--admin-url` defaults to `http://127.0.0.1:6288`.
- `--password` falls back to **`PUBKY_ADMIN_PASSWORD`**, then a hidden prompt. Not homeservercli's `PUBKY_HOMESERVER_ADMIN_PASSWORD`.
- Other env vars: `PUBKY_CLI_RECOVERY_PASSPHRASE`, `PUBKY_PKARR_BOOTSTRAP` / `_RELAYS` / `_TIMEOUT_MS`.
- **Flag placement:** for `admin user` and `admin storage`, connection flags belong to the **parent** subcommand: after `user`/`storage`, before `disable`/`enable`/`delete`. Using `PUBKY_ADMIN_PASSWORD` with the default URL sidesteps this.

### Admin commands

```text
pubky-cli admin info                            # GET    /info  (5 counters only)
pubky-cli admin generate-token                  # GET    /generate_signup_token  (default limits only)
pubky-cli admin user disable|enable <pubky>     # POST   /users/<Display(pk)>/disable|enable
pubky-cli admin storage delete <pubky> <path>   # DELETE /webdav/<Display(pk)><path>
```

- `info` drops `public_key` and `version`; use `homeservercli info`.
- `storage delete` prepends a missing leading `/`, then rejects any path not starting with `/pub/` before sending: `entry path must start with /pub/`.

```bash
# executed (--locked build): disable/enable toggled num_disabled_users 0 -> 1 -> 0
# Use the user's raw z32 public key printed during signup
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user disable <user-pubkey>

# Re-enable the same user
PUBKY_ADMIN_PASSWORD=admin pubky-cli admin user enable <user-pubkey>
```

`admin` is the local/testnet example password only.

### README errors

- Recommends Rust 1.76; edition 2024 needs **1.85+**.
- Quick Start misspells `--singup-code`; the real flag is **`--signup-code`**.

## Upstream references

- [homeservercli README](https://github.com/pubky/pubky-homeserver/blob/main/homeservercli/README.md) and [source](https://github.com/pubky/pubky-homeserver/tree/main/homeservercli)
- [pubky-homeserver releases](https://github.com/pubky/pubky-homeserver/releases): prebuilt `homeservercli`
- [`openapi-admin.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-admin.yml): authoritative admin routes, schemas and quota semantics
- [pubky-cli README](https://github.com/pubky/pubky-cli/blob/main/README.md) and [crates.io](https://crates.io/crates/pubky-cli)
- Canonical: [`concepts.md` → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)
- Related: [`homeserver.md`](homeserver.md), [`signup-gating.md`](signup-gating.md), [`local-stack.md`](local-stack.md)
