# Full local stack (pubky-docker)

[`pubky-docker`](https://github.com/pubky/pubky-docker) is a Docker Compose setup for a **local** Pubky Social stack: **Homeserver** ([pubky-homeserver](https://github.com/pubky/pubky-homeserver)), **Nexus** ([pubky-nexus](https://github.com/pubky/pubky-nexus)), **Homegate** ([homegate](https://github.com/pubky/homegate)) and **Pubky App** (`pubky-app` service, [pubky-app](https://github.com/pubky/pubky-app)). Postgres, Neo4j, Redis, Redis Insight and WireMock come from public registries.

The [README](https://github.com/pubky/pubky-docker/blob/main/Readme.md) is the maintained source for commands, profiles and tags. This file covers only compose/ops gotchas, checked against pubky-docker `main` at `bb01419` (2026-10-13). For the protocol model, see [`concepts.md`](../../pubky/references/concepts.md): [homeserver model](../../pubky/references/concepts.md#the-homeserver-model), [PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution), [homeserver-write vs Nexus-read](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).

## Local development only

> **Not production hosting.** README: *"This project is intended for local development and experimentation only. It is not production hosting infrastructure. Do not use it to run public, production, or mission-critical Pubky services; production deployments require infrastructure that is hardened, monitored, maintained, and operated for that purpose."* The guardrails in [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md) also apply.

- **Don't run this just to build an app.** The README calls it overkill for app development. Use JS [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) or Rust [`pubky`](https://crates.io/crates/pubky) via the **`pubky`** skill (web/server) or **`pubky-mobile`** skill (native), and the lighter [standalone testnet](../../pubky/references/testing-and-testnet.md#standalone-local-testnet). Run the full stack only to exercise the Nexus indexer and social frontend together.
- **Every port is published on all host interfaces.** Each `ports:` entry uses short syntax (`5432:5432`), which [binds to all interfaces](https://docs.docker.com/engine/network/port-publishing/). The homeserver admin API (password `admin`), Postgres, Neo4j, Redis (no `requirepass`) and Redis Insight (no auth) are reachable by anyone who can reach the host, and all credentials are hardcoded (see [Credentials](#credentials-and-signups)). Use a firewalled workstation, or bind to loopback with an override.
- **`container_name` is hardcoded.** A second checkout (or another project) collides with an existing stack's containers.

To bind to loopback, create `docker-compose.override.yml` (auto-loaded when `docker compose` runs without `-f`). Use `!override`: a plain `ports:` list is **merged** with the base list, so the all-interfaces binding stays and a `127.0.0.1` one is added. Repeat for every service in [Ports](#ports-and-topology).

```bash
# Checked with `docker compose config` (Compose 5.3.1) in an isolated copy; not a full stack run
cat > docker-compose.override.yml <<'EOF'
services:
  nexus-redis:
    ports: !override
      - "127.0.0.1:6379:6379"
EOF
docker compose config nexus-redis   # ports should show only 127.0.0.1
```

`pubky-docker-cli.sh` and `list-component-versions.sh` pass `--file <dir>/docker-compose.yml` explicitly, so **neither loads the override**. A CLI-started stack is still published on all interfaces.

## Quick start (public images)

No clone or build needed, only the compose files and a configured `.env`.

```bash
# Flags and service plan checked with `docker compose --dry-run`; not a real `up`
cp .env-sample .env

# Full stack
docker compose up -d --no-build

# Backend only
docker compose --profile backend up -d --no-build
```

Images come from [Docker Hub `synonymsoft`](https://hub.docker.com/u/synonymsoft), tag `latest` by default.

> **`synonymsoft/pubky-nexus:latest` probably can't parse the bundled config (inferred from source, not run).** On 2026-10-26, `latest` (digest `sha256:720dceb2e9a5…`) equals tag `716b64fc561a06dc3394a12eabe8c57ec6d6b074`, a pubky-nexus commit from 2026-05-15, before network settings moved to `[stack.net]` (`a795745`). At that commit `[watcher]` requires `testnet` and `testnet_host` with no serde default, but pubky-docker's testnet config puts them under `[stack.net]`, so nexusd will very likely exit with a `missing field testnet` parse error. **No newer image exists to pin**: Hub has only `latest`, `716b64fc…` and the older `ca5ea639…` (2025-11-27). If it fails, build nexusd from source with `../pubky-nexus` at or after `a795745` (see [Build from source](#build-from-source)).

## Compose profiles

Each service has exactly one profile:

| Profile | Services |
| :-- | :-- |
| `backend` | postgres, homeserver, nexusd, nexus-neo4j, nexus-redis, nexus-redisinsight, homegate-db-init, homegate-prelude, homegate (9 services) |
| `pubky-app` | pubky-app (frontend only) |

`.env-sample` (lines 5–9):

```bash
# Full stack on `docker compose up`; use `docker compose --profile backend up` for backend only
COMPOSE_PROFILES=backend,pubky-app

# mainnet or testnet network
NETWORK=testnet # mainnet
```

Rules (checked with Compose 5.3.1):

- **With no active profile, `docker compose up` starts nothing.** A bare `up` gets the full stack only because `.env` sets `COMPOSE_PROFILES`. If it is blank or missing, `docker compose config --services` prints nothing.
- **`--profile` replaces `COMPOSE_PROFILES`; they are not merged.** Even with the `.env` above, `--profile backend` selects only the 9 backend services, and `--profile pubky-app` only pubky-app.
- To run your own frontend, use `--profile backend` and point it at the [host ports](#ports-and-topology).

```bash
# Run as written (Compose 5.3.1)
docker compose --profile backend config --services   # 9 backend services, no pubky-app
docker compose --profile '*' config --services       # every service
```

## Image tags, registry and NETWORK

| `.env` variable | Default | Image reference in compose |
| :-- | :-- | :-- |
| `REGISTRY` | `synonymsoft` | all Pubky images |
| `HOMESERVER_TAG` | `latest` | `${REGISTRY}/homeserver-${HOMESERVER_ENV:-testnet}` |
| `PUBKY_NEXUS_TAG` | `latest` | `${REGISTRY}/pubky-nexus` |
| `PUBKY_APP_TAG` | `latest` | `${REGISTRY}/pubky-app` |
| `HOMEGATE_TAG` | `latest` | `${REGISTRY}/homegate` |

- **`HOMESERVER_ENV` (default `testnet`) is undocumented** (not in the README or `.env-sample`). It sets both the homeserver image suffix and the build `BUILD_TARGET`.
- **Leave `HOMESERVER_ENV=testnet`.** `HOMESERVER_ENV=homeserver` resolves to `synonymsoft/homeserver-homeserver:latest`, which doesn't exist (the plain image is `synonymsoft/homeserver`). The plain binary also has no `--homeserver-config` flag, so it fails under the entrypoint unless `NETWORK=mainnet`.
- **Use `pubky-app`, not `pubky-app-testnet`.** `pubky-app-testnet:latest` is `v1.4.0`, last updated 2026-05-29.
- **Pin tags instead of `latest`.** Every image has full-commit-SHA tags. `homeserver`, `homeserver-testnet`, `pubky-app` and `homegate` also have version tags; **`pubky-nexus` has SHA tags only.** On 2026-10-26, `latest` was: `homeserver-testnet` and `homeserver` `v0.16.2`, `pubky-app` `v1.12.0`, `homegate` `v0.2.0`. Re-check the [registry](https://hub.docker.com/u/synonymsoft).

`NETWORK` (`testnet` default, or `mainnet`) does two things:

1. Selects the Nexus config mount `./pubky-nexus-config-${NETWORK:-testnet}.toml` → `/config/config.toml` (run as `nexusd --config-dir=/config`).
2. Drives `homeserver.entrypoint.sh`: `mainnet` → `exec homeserver` with no config; otherwise `exec homeserver --homeserver-config=/config.toml`.

> **Treat `NETWORK=mainnet` as unsupported locally.** Only `pubky-nexus-config-testnet.toml` exists. With `mainnet`, Docker's short-syntax bind of the missing `./pubky-nexus-config-mainnet.toml` creates an **empty host directory** of that name and mounts it at `/config/config.toml`, so nexusd can't load a config. The homeserver image is still the testnet binary (`HOMESERVER_ENV` is unchanged), now running on its built-in default test config, not a mainnet homeserver. The testnet `PUBKY_RUNTIME_*` values also stay.

### pubky-app runtime config

The frontend reads runtime `PUBKY_RUNTIME_*` variables; `NEXT_PUBLIC_DB_VERSION=2`, `NEXT_PUBLIC_DB_NAME=franky` and `NEXT_PUBLIC_DEBUG_MODE=false` are build args. The `.env-sample` testnet block sets:

- `PUBKY_RUNTIME_HOMESERVER=8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` (local homeserver key, hardcoded in the testnet binary)
- `PUBKY_RUNTIME_HOMESERVER_URL=http://localhost:6286`, `PUBKY_RUNTIME_NEXUS_URL=http://localhost:8080`, `PUBKY_RUNTIME_HOMEGATE_URL=http://localhost:6300`
- `PUBKY_RUNTIME_TESTNET=true`, `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY=http://localhost:15412/link/`
- `PUBKY_RUNTIME_PKARR_RELAYS` (the sample's comment says it is ignored on testnet)
- `PUBKY_RUNTIME_PLAUSIBLE=false`: **a no-op.** pubky-app v1.12.0 reads neither `PUBKY_RUNTIME_PLAUSIBLE` nor compose's `PUBKY_RUNTIME_ENABLE_PLAUSIBLE`. Plausible is configured by `PUBKY_RUNTIME_PLAUSIBLE_DOMAIN` / `PUBKY_RUNTIME_PLAUSIBLE_SCRIPT_URL` and stays off while they are unset.

`.env-sample` also has commented-out Mainnet and Staging blocks (Staging: homeserver `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`, `https://nexus.staging.pubky.app`).

Compose defaults for unset variables include:

- `PUBKY_RUNTIME_ENV=staging`
- `PUBKY_RUNTIME_CDN_URL=http://localhost:8080/static`
- `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY=http://localhost:15412/inbox/` (`.env-sample` overrides it to `/link/`)
- `PUBKY_RUNTIME_MODERATION_ID` empty, `PUBKY_RUNTIME_MODERATED_TAGS=["nudity"]`, `PUBKY_RUNTIME_MAX_STREAM_TAGS=5`
- `PUBKY_RUNTIME_SHOP_URL=https://staging.pubky.app/shop-embed/marketplace` (pubky-docker #43): **a no-op for pubky-app ≥ v1.12.0**, which no longer reads it (pubky-app ADR 0025, #2821). Don't bother setting it.

The full list changes often, so read it from [`docker-compose.yml`](https://github.com/pubky/pubky-docker/blob/main/docker-compose.yml).

## Build from source

The compose `homeserver` build passes `BUILD_TARGET: ${HOMESERVER_ENV:-testnet}` (pubky-docker #42, `f0b49c7`), so `docker compose build` and `pubky-docker-cli.sh` both build the **testnet** target by default. You don't need `--build-arg BUILD_TARGET=testnet`.

- The pubky-homeserver [Dockerfile](https://github.com/pubky/pubky-homeserver/blob/main/Dockerfile) defaults to `ARG BUILD_TARGET=homeserver` (`homeserver` | `testnet`), builds `--bin pubky-$BUILD_TARGET` and installs it as `/usr/local/bin/homeserver`. CI publishes `homeserver-testnet` (`testnet`) and `homeserver` (`homeserver`).
- The testnet binary accepts `--homeserver-config <path>` and runs `StaticTestnet` with the fixed key `8pinxx…` and fixed ports (see [Ports](#ports-and-topology)). That is why it matches `homeserver.entrypoint.sh`, `.env-sample` and the Nexus config.
- `ARG BUILD_PROFILE=release` (`debug` | `release`) exists; compose doesn't pass it.

### pubky-docker-cli.sh

Use it to pin specific commits or when changing service code.

```bash
# Only --help/-h run as written; the other forms were checked via the script's parse_args
# (they clone four repos, build from source and run a foreground `up`)
./pubky-docker-cli.sh                 # clone refs, build from source, start full stack
./pubky-docker-cli.sh --backend-only  # skip the pubky-app frontend service
./pubky-docker-cli.sh --help          # also -h
```

No other options; anything else fails with `Unknown option: <arg>`.

Flow:

1. Checks `git`, `docker` and `docker compose version` (Compose v2 required).
2. Copies `.env-sample` to `.env` **only if `.env` is missing**.
3. If `.build-state` has a commit for every selected service, prints them and asks `[s] Start stack now  [c] Choose refs`. Any answer except `c`/`choose` (case-insensitive), including Enter, starts the stack.
4. Otherwise checks GitHub access (`git ls-remote https://github.com/pubky/pubky-homeserver.git HEAD`) and prompts `Commit, tag, or branch for <name> [<default-branch>]` for pubky-nexus, pubky-homeserver, homegate, then pubky-app (skipped with `--backend-only`). The default branch comes from `git ls-remote --symref`, falling back to `main`.
5. Clones or updates `../<name>`, runs `fetch --tags origin`, then `checkout --detach origin/<ref>` if that remote branch exists, else `checkout --detach <ref>`.
6. Rebuilds only the services (`nexusd`, `homeserver`, `homegate`, `pubky-app`) whose HEAD differs from `.build-state`. If at least one was built and the build succeeded, it records the commits of **all** selected services.
7. Runs `docker compose --project-directory <dir> --file <dir>/docker-compose.yml --profile backend [--profile pubky-app] up` **in the foreground, no `-d`**.

The sibling clones `../pubky-homeserver`, `../pubky-nexus`, `../homegate` and `../pubky-app` match the compose `build:` contexts.

CLI gotchas:

- **A dirty clone aborts the run** (`<dir> has local changes. Commit, stash, or clean them before changing refs.`), as does a target directory that isn't a git repo.
- **`.build-state` tracks commits only** (`<service> <full-commit>` per line). Changing `.env` or build args, including `HOMESERVER_ENV`/`BUILD_TARGET`, doesn't trigger a rebuild. Run `docker compose build <service>` yourself. `.build-state` isn't in `.gitignore`.
- **CLI-built images reuse the Hub image names.** A later `docker compose pull` silently replaces them, and the CLI won't notice or rebuild.

### Manual build (siblings already checked out)

Requires `../pubky-homeserver`, `../pubky-nexus`, `../homegate` and `../pubky-app`. Omit `--no-build` so Compose uses the `build:` contexts.

```bash
# Build stanzas checked with `docker compose config`; no real build was run
cp .env-sample .env
docker compose build

# Full stack
docker compose up -d

# Backend only (run your own frontend separately)
docker compose --profile backend up -d
```

## Ports and topology

All services share the bridge network `pubky` (`172.18.0.0/16`, `enable_ipv6: false`) with fixed IPv4 addresses. Every host port below is published on all interfaces (see [Local development only](#local-development-only)).

| Service | Host ports |
| :-- | :-- |
| postgres | 5432 |
| homeserver | 6286 (ICANN HTTP, `PUBKY_RUNTIME_HOMESERVER_URL`), 6287 (Pubky HTTPS), 6288 (admin), 15411 (pkarr relay), 15412 (HTTP relay) |
| nexusd | 8080 (API, `public_addr`), 8081 (`pubky_listen_socket`) |
| nexus-neo4j | 7474, 7687 |
| nexus-redis | 6379 |
| nexus-redisinsight | 5540 |
| pubky-app | 3000 |
| homegate | 6300 |

Homeserver port roles come from [`pubky-testnet/src/static_testnet.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/src/static_testnet.rs), not pubky-docker. For operations, see [`homeserver.md`](homeserver.md), [`dns-and-relays.md`](dns-and-relays.md) and [`http-relay.md`](http-relay.md).

- **Homeserver config** (`homeserver.config.toml`): DSN `postgres://test_user:test_pass@172.18.0.9:5432/pubky_homeserver?pubky_test=true`, `[pkdns] icann_domain = localhost`, `public_ip = 172.18.0.4`, `[derive] testnet_host = homeserver`, `[admin]` enabled.
- **Homegate startup order:** after `homeserver` has started, `homegate-db-init` has completed successfully, and `homegate-prelude` has started.
- **Nexus testnet config** (`pubky-nexus-config-testnet.toml`): `[watcher]` homeserver `8pinxx…`, `monitored_homeservers_limit = 0`, `moderation_id = xw4fdy5kpc9aoowabmhqmd7wnuz3pqg7z1usse877tawtu8x7zdy`. `[stack.net]` sets `testnet = true`, `testnet_host = "homeserver"`. Connects to `redis://nexus-redis:6379` and `bolt://nexus-neo4j:7687`. See [`nexus-operations.md`](nexus-operations.md).

Check component versions on a running stack:

```bash
# Run with `docker exec` blocked by a shim, so in-container probes were not exercised
./list-component-versions.sh
```

- Lists services via `docker compose --profile '*' config --services`, skipping `homegate-db-init`. Reads versions from inside each container: homeserver admin `/info` (with `X-Admin-Password` from `/config.toml`), nexusd `/v0/info` (Nexus `/v0` is unstable), redisinsight `/api/info`. Also prints each image's build date.
- Only option: `--help` (or `-h`). Any other argument fails.
- **Gotcha:** if Compose can't find a service's container, it falls back to the label `com.docker.compose.service=<svc>`, then the name `^/<svc>$`. Either can match another project's container and report the wrong version (observed in testing).

## Credentials and signups

Hardcoded dev values. Never reuse them.

| Where | Credential |
| :-- | :-- |
| postgres | `test_user` / `test_pass` (`.env-sample`) |
| homeserver admin API | `admin_password = "admin"`, on `0.0.0.0:6288` |
| Neo4j | `NEO4J_AUTH=neo4j/12345678` (`neo4j.env`; the Nexus config uses the same password) |
| Redis / Redis Insight | none (no `requirepass`; Redis Insight has no auth) |
| Homegate → homeserver admin | `admin_password = "admin"` in `homegate.config.toml`, calling `http://homeserver:6288` |

- **Signup is open:** `homeserver.config.toml` sets `signup_mode = "open"`. Its comment `Default: "token_required"` describes the homeserver's own default, not this stack. For token-gated signup, see [`signup-gating.md`](signup-gating.md) and [`operator-cli.md`](operator-cli.md).
- **WireMock fakes Homegate's SMS provider.** `homegate-prelude` (`wiremock/wiremock:latest`, `--global-response-templating`) stands in for Prelude. `limit_whitelist = ["+12345678912"]`; the config comment says to use the fixed code **`123456`**.
- **Lightning verification is disabled.** Homegate opens a PhoenixD websocket at startup, so a fake PhoenixD URL would make it exit.

## Data, persistence and reset

- Bind mounts under **`./.storage/`**: `postgres/data`, `neo4j/{conf,data,logs}`, `redis/data`, `homegate`, `static`. `.gitignore` has only `.env`, `storage` and `.storage`.
- nexus-neo4j also mounts `./pubky-nexus/docker/db-graph`, a path inside pubky-docker, not the sibling `../pubky-nexus`.
- The `backend_storage` named volume is declared but unused.

> **Homeserver state does not survive a restart (inferred from pubky-homeserver source at v0.16.2 `f60e502` and `fd24bf0`, not run).** The entrypoint runs the testnet binary without `persist`, so `StaticTestnet` runs an in-memory homeserver (`MockDataDir`). Its database mode is always `EphemeralTest`: a fresh `pubky_test_<uuid>` Postgres database on every start (the `?pubky_test=true` DSN parameter doesn't decide this), with files in a temp dir. Every restart starts with **no users or data**.
> - The ephemeral DB is dropped only on SIGINT. `docker compose stop`/`down` sends SIGTERM, so old `pubky_test_*` databases very likely pile up in `./.storage/postgres`.
> - Nexus (Neo4j/Redis) and Homegate (`pubky_homegate` DB) **do** persist. After a restart they keep users the homeserver no longer has. Reset them too for a consistent stack.

- **`docker compose down -v` does not wipe data.** It [removes named and anonymous volumes, not bind mounts](https://docs.docker.com/reference/cli/docker/compose/down/). `neo4j.env` says to run `down -v` after changing Neo4j auth, but the old state stays in `./.storage/neo4j`.
- **To reset:** stop the stack and delete `./.storage`. This destroys all Nexus, Homegate and Postgres data, including leaked `pubky_test_*` databases. Homeserver state is already lost on every restart.

## Where to go next

| Topic | Read |
| :-- | :-- |
| Homeserver config / admin API | [`homeserver.md`](homeserver.md) |
| Nexus API/watcher, Neo4j + Redis | [`nexus-operations.md`](nexus-operations.md) |
| Homegate SMS/Lightning/IP gating | [`signup-gating.md`](signup-gating.md) |
| pkdns / pkarr-relay | [`dns-and-relays.md`](dns-and-relays.md) |
| http-relay | [`http-relay.md`](http-relay.md) |
| Signup/invite tokens via pubky-cli | [`operator-cli.md`](operator-cli.md) |
| Other self-hosting paths | [`testing-and-testnet.md`](../../pubky/references/testing-and-testnet.md#full-self-hosted-stack) |

Upstream: [pubky-docker README](https://github.com/pubky/pubky-docker/blob/main/Readme.md) · [docker-compose.yml](https://github.com/pubky/pubky-docker/blob/main/docker-compose.yml) · [.env-sample](https://github.com/pubky/pubky-docker/blob/main/.env-sample) · [pubky-docker-cli.sh](https://github.com/pubky/pubky-docker/blob/main/pubky-docker-cli.sh) · [pubky-homeserver Dockerfile](https://github.com/pubky/pubky-homeserver/blob/main/Dockerfile) · [synonymsoft registry](https://hub.docker.com/u/synonymsoft)
