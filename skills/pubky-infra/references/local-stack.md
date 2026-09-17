# Full local stack (pubky-docker)

[`pubky-docker`](https://github.com/pubky/pubky-docker) is a Docker Compose setup for a **local** Pubky Social stack. It runs **Homeserver** ([pubky-homeserver](https://github.com/pubky/pubky-homeserver)), **Nexus** ([pubky-nexus](https://github.com/pubky/pubky-nexus)), **Homegate** ([homegate](https://github.com/pubky/homegate)) and **Pubky App** ([pubky-app](https://github.com/pubky/pubky-app)). Postgres, Neo4j, Redis, Redis Insight and WireMock are pulled from their public registries.

The [README](https://github.com/pubky/pubky-docker/blob/main/Readme.md) is the maintained source for commands, profiles and tags. This file covers only the compose and ops side. For the protocol model the stack runs, link to [`concepts.md`](../../pubky/references/concepts.md): the [homeserver model](../../pubky/references/concepts.md#the-homeserver-model), [PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution) and the [homeserver-write vs Nexus-read split](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).

## Local development only

> **Not production hosting.** The README says: *"This project is intended for local development and experimentation only. It is not production hosting infrastructure. Do not use it to run public, production, or mission-critical Pubky services; production deployments require infrastructure that is hardened, monitored, maintained, and operated for that purpose."* The guardrails in [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md) also apply.

- **Don't run this just to build an app.** Use the client libraries instead: JS [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) or Rust [`pubky`](https://crates.io/crates/pubky), through the **`pubky`** skill (web/server) or the **`pubky-mobile`** skill (native). For a lighter testnet, see [`testing-and-testnet.md`](../../pubky/references/testing-and-testnet.md#standalone-local-testnet).
- Run the full stack only when you need all of it, especially the Nexus indexer and the social frontend.
- **Every port is exposed to the network by default.** Each `ports:` entry uses short syntax (`5432:5432`), which [publishes on all host interfaces](https://docs.docker.com/engine/network/port-publishing/). On Linux, Docker's iptables rules also bypass ufw and firewalld. As a result, the homeserver admin API (password `admin`), Postgres, Neo4j, Redis (no `requirepass`) and Redis Insight (no auth) can be reached by anyone who can reach the host. All credentials are hardcoded (see [Credentials](#credentials-and-signups)). Run the stack on a firewalled workstation, or bind the ports to loopback with an override.

Bind a service to loopback. `docker-compose.override.yml` is loaded automatically when you run `docker compose` without `-f`. You need `!override`, because a plain `ports:` list is **merged** with the base list and the `0.0.0.0` bindings stay. Repeat this for every service in [Ports](#ports-and-topology):

```yaml
# docker-compose.override.yml — checked with `docker compose config` (Compose 5.3.1), not a full stack run
services:
  nexus-redis:
    ports: !override
      - "127.0.0.1:6379:6379"
```

`pubky-docker-cli.sh` passes `--file docker-compose.yml` explicitly, so it **does not** load this override.

## Quick start (public images)

You don't need a clone or a build, only the compose files and a `.env`.

```bash
cp .env-sample .env

# Full stack
docker compose up -d --no-build

# Backend only
docker compose --profile backend up -d --no-build
```

Images come from [Docker Hub `synonymsoft`](https://hub.docker.com/u/synonymsoft), tag `latest` by default.

> **`latest` can lag the compose config.** On Hub, `synonymsoft/pubky-nexus:latest` currently has the same digest as a 2026-05-15 build (`716b64fc561a`). That build is older than pubky-nexus moving network settings to `[stack.net]`, and pubky-docker's testnet config already uses `[stack.net]`. nexusd may therefore fail to parse `/config/config.toml` (`missing field testnet`). This was inferred from the source and not seen at runtime. If nexusd exits on startup, pin a newer `PUBKY_NEXUS_TAG` or build from source.

## Compose profiles

There are two profiles, and every service belongs to one of them:

| Profile | Services |
| :-- | :-- |
| `backend` | postgres, homeserver, nexusd, nexus-neo4j, nexus-redis, nexus-redisinsight, homegate-db-init, homegate-prelude, homegate |
| `pubky-app` | pubky-app (frontend only) |

`.env-sample` sets:

```bash
# Full stack on `docker compose up`; use `docker compose --profile backend up` for backend only
COMPOSE_PROFILES=backend,pubky-app

# mainnet or testnet network
NETWORK=testnet # mainnet
```

- **With no active profile, `docker compose up` starts nothing.** A bare `up` gives you the full stack only because `.env` sets `COMPOSE_PROFILES`. If `.env` is missing or leaves that variable out, no containers start.
- **The `--profile` flag replaces `COMPOSE_PROFILES`. The two are not merged** ([Compose profiles docs](https://docs.docker.com/compose/how-tos/profiles/)). Even with the `.env` above, `docker compose --profile backend config --services` in pubky-docker lists the 9 backend services and leaves out pubky-app.
- To run your own frontend, start with `--profile backend` and point the frontend at the [host ports](#ports-and-topology).

## Image tags, registry and NETWORK

| `.env` variable | Default | Image |
| :-- | :-- | :-- |
| `REGISTRY` | `synonymsoft` | all Pubky images |
| `HOMESERVER_TAG` | `latest` | `${REGISTRY}/homeserver-${HOMESERVER_ENV:-testnet}` |
| `PUBKY_NEXUS_TAG` | `latest` | `${REGISTRY}/pubky-nexus` |
| `PUBKY_APP_TAG` | `latest` | `${REGISTRY}/pubky-app` |
| `HOMEGATE_TAG` | `latest` | `${REGISTRY}/homegate` |

- Only the homeserver image name has a suffix, set by `HOMESERVER_ENV` (default `testnet`). Neither `.env-sample` nor the README mentions it.
- **Use `pubky-app`, not `pubky-app-testnet`.** The suffixed image on Hub stopped updating on 2026-05-29.
- To pin a known-good build, set a tag in place of `latest`. The [registry](https://hub.docker.com/u/synonymsoft) lists the available tags.

`NETWORK` (`testnet` by default, or `mainnet`) does two things:

1. It selects the Nexus config mount `./pubky-nexus-config-${NETWORK:-testnet}.toml`.
2. It controls `homeserver.entrypoint.sh`. With `mainnet`, the entrypoint runs `exec homeserver` with no config. Otherwise it runs `exec homeserver --homeserver-config=/config.toml`.

> **Treat `NETWORK=mainnet` as unsupported locally.** Only `pubky-nexus-config-testnet.toml` exists, and no mainnet version has ever been in git history, so nexusd would mount a file that doesn't exist. `NETWORK` also leaves `HOMESERVER_ENV` (still `testnet`) and the testnet `PUBKY_RUNTIME_*` values unchanged.

### pubky-app runtime config

The frontend reads runtime `PUBKY_RUNTIME_*` variables. The old `NEXT_PUBLIC_*` variables are gone, except `NEXT_PUBLIC_DB_VERSION`, `NEXT_PUBLIC_DB_NAME` and `NEXT_PUBLIC_DEBUG_MODE`, which are still build args. The testnet block in `.env-sample` includes:

- `PUBKY_RUNTIME_HOMESERVER=8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` (the local homeserver key)
- `PUBKY_RUNTIME_HOMESERVER_URL=http://localhost:6286`, `PUBKY_RUNTIME_NEXUS_URL=http://localhost:8080`, `PUBKY_RUNTIME_HOMEGATE_URL=http://localhost:6300`
- `PUBKY_RUNTIME_TESTNET=true`, `PUBKY_RUNTIME_DEFAULT_HTTP_RELAY=http://localhost:15412/link/`
- `PUBKY_RUNTIME_PKARR_RELAYS`, which is ignored on testnet
- `PUBKY_RUNTIME_PLAUSIBLE=false`, which probably does nothing, because compose reads `PUBKY_RUNTIME_ENABLE_PLAUSIBLE`

`.env-sample` also has commented-out Mainnet and mainnet-Staging blocks. Staging uses homeserver `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` and `https://nexus.staging.pubky.app`. Compose supplies defaults for any variable left unset, for example `PUBKY_RUNTIME_ENV=staging`, `PUBKY_RUNTIME_CDN_URL=http://localhost:8080/static`, and an HTTP relay of `.../inbox/` that `.env-sample` overrides to `/link/`. The full list of about 30 variables changes often, so read it from [`docker-compose.yml`](https://github.com/pubky/pubky-docker/blob/main/docker-compose.yml).

## Build from source

> **Caveat for both source-build paths (inferred from source, not run).** The compose `homeserver` `build:` passes no build args. The pubky-homeserver Dockerfile defaults to `ARG BUILD_TARGET=homeserver`, which builds the plain binary. Only the published `homeserver-testnet` image is built with `BUILD_TARGET=testnet`. The plain binary has no `--homeserver-config` flag, no static `8pinxx…` testnet key and no relays on 15411/15412. A locally built `homeserver-testnet` image will therefore probably fail under `homeserver.entrypoint.sh`, or start with a different key. One likely workaround, also unverified, is `docker compose build --build-arg BUILD_TARGET=testnet homeserver`. The CLI can't pass this arg. If you only change Nexus, Homegate or pubky-app, keep the Hub homeserver image.

### pubky-docker-cli.sh

Use it when you need specific commits or are changing service code.

```bash
./pubky-docker-cli.sh                 # clone refs, build from source, start full stack
./pubky-docker-cli.sh --backend-only  # skip the pubky-app frontend service
./pubky-docker-cli.sh --help          # also -h
```

It has no other options. Anything else fails with `Unknown option`.

Flow:

1. It checks for `git`, `docker` and `docker compose version` (Compose v2 required).
2. It copies `.env-sample` to `.env` **only if `.env` is missing**.
3. If `.build-state` shows a completed build for the selected services, it prints their commits and asks `[s] Start stack now  [c] Choose refs`. Any answer other than `c` or `choose`, including Enter, starts the stack.
4. Otherwise it checks GitHub access (`git ls-remote https://github.com/pubky/pubky-homeserver.git HEAD`), then prompts for each repo in this order: nexus, homeserver, homegate, app. The prompt is `Commit, tag, or branch for <name> [<default-branch>]`. Enter uses the remote default branch, or `main`. It clones or updates `../<name>`, runs `fetch --tags`, then `checkout --detach` to `origin/<ref>` for a remote branch, or to `<ref>` otherwise.
5. It rebuilds only services whose HEAD differs from `.build-state`: pubky-homeserver→`homeserver`, pubky-nexus→`nexusd`, homegate→`homegate`, pubky-app→`pubky-app`.
6. It runs `docker compose --project-directory <dir> --file <dir>/docker-compose.yml --profile backend [--profile pubky-app] up` **in the foreground, with no `-d`**.

The sibling clones `../pubky-homeserver`, `../pubky-nexus`, `../homegate` and `../pubky-app` match the compose `build:` contexts. The project directory can have any name.

CLI gotchas:

- **A dirty clone aborts the run:** `<dir> has local changes. Commit, stash, or clean them before changing refs.` It also aborts if a target directory exists but is not a git repo.
- **`.build-state` tracks commits only.** Each line is `<service> <full-commit>`, written after a successful build. Changing `.env` or build args does not trigger a rebuild, so run `docker compose build <service>` yourself. `.build-state` is not gitignored.
- **CLI-built images use the Hub names** (`synonymsoft/...:latest`). A later `docker compose pull` silently replaces them, `.build-state` doesn't notice, and the CLI skips the rebuild.

### Manual build (siblings already checked out)

Leave out `--no-build` so Compose builds from the `build:` contexts. The source-build caveat above applies.

```bash
cp .env-sample .env
docker compose build

# Full stack
docker compose up -d

# Backend only
docker compose --profile backend up -d
```

## Ports and topology

All services share the bridge network `pubky` (`172.18.0.0/16`, IPv6 disabled), each with a fixed IPv4 address. Every host port below is published on all interfaces (see [Local development only](#local-development-only)).

| Service | Host ports |
| :-- | :-- |
| postgres | 5432 |
| homeserver | 6286 (ICANN HTTP, `PUBKY_RUNTIME_HOMESERVER_URL`), 6287 (Pubky HTTPS), 6288 (admin), 15411 (pkarr relay), 15412 (HTTP relay, `/link/`) |
| nexusd | 8080 (API), 8081 (pubky listen socket) |
| nexus-neo4j | 7474, 7687 |
| nexus-redis | 6379 |
| nexus-redisinsight | 5540 |
| pubky-app | 3000 |
| homegate | 6300 |

The homeserver port roles come from [`pubky-testnet/src/static_testnet.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/src/static_testnet.rs). pubky-docker itself does not label them. `homegate-prelude` (WireMock) and `homegate-db-init` publish no host ports. For operations, see [`homeserver.md`](homeserver.md), [`dns-and-relays.md`](dns-and-relays.md) and [`http-relay.md`](http-relay.md).

- **One `postgres:17-alpine` serves both the homeserver and Homegate.** The homeserver DSN is `postgres://test_user:test_pass@172.18.0.9:5432/pubky_homeserver?pubky_test=true`. The one-shot `homegate-db-init` waits for `pg_isready`, then creates `pubky_homegate` if it is missing. `homegate` starts after `homeserver` has started, `homegate-db-init` has completed successfully and `homegate-prelude` has started.
- **Nexus testnet config** (`pubky-nexus-config-testnet.toml`): it watches homeserver `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` with `monitored_homeservers_limit = 0`, `moderation_id = xw4fdy5kpc9aoowabmhqmd7wnuz3pqg7z1usse877tawtu8x7zdy`, `[stack.net] testnet = true`, `testnet_host = "homeserver"`, `redis://nexus-redis:6379` and `bolt://nexus-neo4j:7687`. See [`nexus-operations.md`](nexus-operations.md) for what these mean.

Check component versions on a running stack:

```bash
./list-component-versions.sh
```

The script covers every service in every profile except `homegate-db-init`. For each running container it reads the version (homeserver admin `/info` with `X-Admin-Password`, nexusd `/v0/info` (Nexus `/v0` is unstable), redisinsight `/api/info`) and the image build date. It then lists containers that aren't running. Its only option is `--help`. **Gotcha:** if Compose can't find a service's container, the script falls back to matching by label or bare name (`name=^/postgres$`), so it can report versions from another project's same-named container.

## Credentials and signups

These are hardcoded dev values. Never reuse them.

| Where | Credential |
| :-- | :-- |
| postgres | `test_user` / `test_pass` (`.env-sample`) |
| homeserver admin API | `admin_password = "admin"`, listening in the container on `0.0.0.0:6288` |
| Neo4j | `NEO4J_AUTH=neo4j/12345678` (the Nexus config uses the same password) |
| Redis / Redis Insight | none (no `requirepass`; Redis Insight has no auth) |
| Homegate → homeserver admin | `admin_password = "admin"` in `homegate.config.toml [homeserver]`, used to call `http://homeserver:6288` |

- **Signup is open.** `homeserver.config.toml` sets `signup_mode = "open"`. Its comment `Default: "token_required"` describes the homeserver's own default, not this stack's setting. For token-gated signup, see [`signup-gating.md`](signup-gating.md) and [`operator-cli.md`](operator-cli.md).
- **Homegate SMS is faked by WireMock** (`homegate-prelude`). Only **`+12345678912`** creates a verification (other numbers get `blocked` / `in_block_list`), and only code **`123456`** passes the check.
- **Lightning verification is not configured locally.** When it is configured, Homegate opens a PhoenixD websocket on startup, so a fake URL would make it exit.

## Data, persistence and reset

- Data lives in **bind mounts under `./.storage/`**: `postgres/data`, `neo4j/{conf,data,logs}`, `redis/data`, `homegate` and `static` (nexusd `/static`). `.gitignore` excludes `.env`, `storage` and `.storage`.
- nexus-neo4j also bind-mounts `./pubky-nexus/docker/db-graph`. That path is inside the pubky-docker directory, not the sibling `../pubky-nexus`. Docker creates it as an empty directory, and it is not gitignored.
- The declared `backend_storage` named volume is not used by any service.
- **`docker compose down -v` does not wipe data.** It [removes named and anonymous volumes, not bind mounts](https://docs.docker.com/reference/cli/docker/compose/down/). `neo4j.env` says to run `down -v` after changing Neo4j auth, but the old config stays in `./.storage/neo4j`. To reset, stop the stack and delete `./.storage`. This destroys all local homeserver, Nexus and Homegate data. On Linux the files are often root-owned, so deleting them may need `sudo`.

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

Upstream: [pubky-docker README](https://github.com/pubky/pubky-docker/blob/main/Readme.md) · [docker-compose.yml](https://github.com/pubky/pubky-docker/blob/main/docker-compose.yml) · [.env-sample](https://github.com/pubky/pubky-docker/blob/main/.env-sample) · [pubky-docker-cli.sh](https://github.com/pubky/pubky-docker/blob/main/pubky-docker-cli.sh) · [synonymsoft registry](https://hub.docker.com/u/synonymsoft)
