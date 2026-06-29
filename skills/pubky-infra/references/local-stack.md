# Full local stack (pubky-docker)

[`pubky-docker`](https://github.com/pubky/pubky-docker) is a one-command Docker Compose
orchestration for a **local** Pubky Social stack. It builds/runs the Pubky services —
**Homeserver** ([pubky-core](https://github.com/pubky/pubky-core)), **Nexus**
([pubky-nexus](https://github.com/pubky/pubky-nexus)), **Homegate**
([homegate](https://github.com/pubky/homegate)), and **Pubky App**
([pubky-app](https://github.com/pubky/pubky-app), the `pubky-app` Compose service) — and pulls
third-party infra (Postgres, Neo4j, Redis, Redis Insight, WireMock) from public registries.

The README ([Readme.md](https://github.com/pubky/pubky-docker/blob/main/Readme.md)) is the
maintained source for commands, profiles, and tags.

## Local development only

> **Not production hosting.** Verbatim from the README: *"This project is intended for local
> development and experimentation only. It is not production hosting infrastructure. Do not use
> it to run public, production, or mission-critical Pubky services; production deployments
> require infrastructure that is hardened, monitored, maintained, and operated for that
> purpose."* This is a hard guardrail — the same not-production posture as the canonical
> [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

**Don't run the full stack just to *build an app* on Pubky.** For app development use the client
libraries — JS [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) or Rust
[`pubky`](https://crates.io/crates/pubky) — via the **`pubky`** (web/server) or **`pubky-mobile`**
(native) skill. Run this orchestration only when experimenting with the *complete* stack (Nexus
indexer + social frontend). For the protocol model it instantiates (per-public-key homeserver,
PKARR resolution, write-to-homeserver vs read-from-Nexus split, event streams), see
[`concepts.md`](../../pubky/references/concepts.md) — this file covers only the compose/ops surface.

## Quick start (public images)

Recommended path: pull prebuilt images, no clone or build. Needs only the project's compose
files plus a configured `.env`.

```bash
# Copy .env-sample to .env for default testnet config
cp .env-sample .env

# Full stack (uses COMPOSE_PROFILES=backend,pubky-app from .env)
docker compose up -d --no-build

# Backend only
docker compose --profile backend up -d --no-build
```

By default Compose uses the `latest` tag from the public **Synonymsoft** registry
([hub.docker.com/u/synonymsoft](https://hub.docker.com/u/synonymsoft)).

## Compose profiles

There are exactly two profiles: **`backend`** and **`pubky-app`**. *Every* service in
`docker-compose.yml` is profile-gated — `backend` covers postgres, homeserver, nexusd,
nexus-neo4j, nexus-redis, nexus-redisinsight, the homegate-db-init/prelude/homegate trio;
`pubky-app` covers only the `pubky-app` frontend.

> **Gotcha:** because every service carries a `profiles:` key, a bare `docker compose up` with
> **no active profile starts zero containers**. The shipped `.env` sets
> `COMPOSE_PROFILES=backend,pubky-app`, which is the only reason `docker compose up` brings up
> the full stack. If `.env` is missing or `COMPOSE_PROFILES` is unset, nothing starts.

```bash
# Full stack on `docker compose up`; use `docker compose --profile backend up` for backend only
COMPOSE_PROFILES=backend,pubky-app

# mainnet or testnet network
NETWORK=testnet # mainnet
```

## Image tags, registry, and network

All image references are overridable in `.env`. Defaults: `REGISTRY=synonymsoft`,
`HOMESERVER_TAG=latest`, `PUBKY_NEXUS_TAG=latest`, `PUBKY_APP_TAG=latest`, `HOMEGATE_TAG=latest`.

| Service | Image reference | Build context |
| :-- | :-- | :-- |
| homeserver | `${REGISTRY:-synonymsoft}/homeserver-${HOMESERVER_ENV:-testnet}:${HOMESERVER_TAG:-latest}` | `../pubky-core` |
| nexusd | `${REGISTRY:-synonymsoft}/pubky-nexus:${PUBKY_NEXUS_TAG:-latest}` | `../pubky-nexus` |
| pubky-app | `${REGISTRY:-synonymsoft}/pubky-app-${NETWORK:-testnet}:${PUBKY_APP_TAG:-latest}` | `../pubky-app` |
| homegate | `${REGISTRY:-synonymsoft}/homegate:${HOMEGATE_TAG:-latest}` | `../homegate` |

> **Nuance:** the homeserver image is suffixed by `${HOMESERVER_ENV:-testnet}` and pubky-app by
> `${NETWORK:-testnet}`, but **nexusd and homegate image names are not network-suffixed**.

**`NETWORK`** selects `testnet` (default) or `mainnet` and does three things: it (a) selects the
Nexus config mounted into nexusd (`./pubky-nexus-config-${NETWORK:-testnet}.toml`), (b) feeds the
pubky-app image suffix, and (c) branches the homeserver entrypoint — `NETWORK=mainnet` runs
`exec homeserver` (image defaults, no local config), otherwise
`exec homeserver --homeserver-config=/config.toml` (the bundled testnet config). `.env-sample`
defaults to `testnet` and carries commented mainnet/staging `NEXT_PUBLIC_*` blocks.

## Build from source (the CLI)

Use **`pubky-docker-cli.sh`** when you need specific commits, are working on service code, or
cannot rely on the registry. It clones the service repos, checks out the refs you pick, builds
Pubky images from source, and starts the stack.

```bash
# Clone refs, build from source, start full stack
./pubky-docker-cli.sh

# Backend only (skip pubky-app frontend)
./pubky-docker-cli.sh --backend-only
```

Workflow: it verifies `git`/`docker`/`docker compose`; copies `.env-sample` to `.env` if absent;
if `.build-state` already has a complete record for the selected services it offers
`[s] Start stack now` (straight to compose up) or `[c] Choose refs`. On the choose-refs path it
checks GitHub read access, prompts a commit/tag/branch per service (Enter = head of the default
branch), clones or updates repos **beside** the project dir, rebuilds local images only for
services whose checked-out commit changed, then runs
`docker compose --profile backend [--profile pubky-app] up`.

- **`.build-state`** records the last built `service commit` per Compose service, so unchanged
  services skip rebuilds. Service→repo build map: homeserver←`pubky-core`, nexusd←`pubky-nexus`,
  homegate←`homegate`, pubky-app←`pubky-app`.
- For existing repos the script **refuses to change refs when the working tree is dirty**
  (`git status --porcelain` non-empty) — commit, stash, or clean first.

Repos are cloned as siblings of the (arbitrarily-named) project dir, matching the `../pubky-*`
build contexts:

```text
your_working_directory/
├── pubky-docker/
├── pubky-core/
├── pubky-nexus/
├── homegate/
└── pubky-app/
```

If you have already cloned and checked out the repos yourself, you can skip the CLI and build
manually (omit `--no-build` so Compose builds from the `build:` contexts):

```bash
cp .env-sample .env
docker compose build

# Full stack
docker compose up -d

# Backend only (run your own frontend separately)
docker compose --profile backend up -d
```

## Ports and components

The stack runs on a bridge network `pubky` (subnet `172.18.0.0/16`, IPv6 disabled) with a fixed
IPv4 per service. Host port mappings:

| Service | Host ports |
| :-- | :-- |
| postgres | 5432 |
| homeserver | 6287 (PubkyTLS direct), 6286 (ICANN HTTP), 6288 (admin API), 15411 (PKARR relay), 15412 (HTTP relay; /link + /inbox) |
| nexusd | 8080 (public read API), 8081 (pubky listen socket) |
| nexus-neo4j | 7474 (browser), 7687 (bolt) |
| nexus-redis | 6379 |
| nexus-redisinsight | 5540 |
| pubky-app | 3000 |
| homegate | 6300 |

Default local CDN/static is `http://localhost:8080/static`. A single `postgres:17-alpine` is
**shared** by the homeserver (database `pubky_homeserver`) and Homegate (a one-shot
`homegate-db-init` creates `pubky_homegate` if absent) — the local realization of the
"homeserver uses PostgreSQL for its own metadata only" model in
[`concepts.md`](../../pubky/references/concepts.md#the-homeserver-model).

With the stack up, probe versions across containers:

```bash
./list-component-versions.sh
```

It inspects each Compose service and runs a best-effort version probe inside each running
container (homeserver admin `/info`, nexusd `/v0/info`, neo4j/redis/postgres/redisinsight/
homegate/pubky-app), printing version + image build date.

## Local dev credentials and signups

The bundled config uses **hardcoded, insecure dev credentials** — never reuse them and never
expose these ports publicly:

| Where | Credential |
| :-- | :-- |
| postgres | `test_user` / `test_pass` |
| homeserver admin API | `admin_password = "admin"` on `0.0.0.0:6288` |
| Neo4j | `NEO4J_AUTH=neo4j/12345678` |
| Homegate → homeserver admin API | `admin_password = "admin"` (`homegate.config.toml [homeserver]`) — Homegate's credential for calling homeserver:6288, not a separate Homegate admin login (Homegate exposes only 6300) |

- **Signups are gated by default.** `homeserver.config.toml` sets `signup_mode = "token_required"`
  (other option: `"open"`). Signup-token / invite mechanics live in
  [`operator-cli.md`](operator-cli.md), [`homeserver.md`](homeserver.md), and
  [`signup-gating.md`](signup-gating.md).
- **Local/testnet homeserver pubkey:** `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` —
  the homeserver clients sign up to on this stack (set as `NEXT_PUBLIC_HOMESERVER` in `.env`, the
  Nexus watcher's `homeserver`, and the pubky-app default).
- **Homegate SMS is faked.** A WireMock `homegate-prelude` stub backs verification: use the
  whitelisted number **`+12345678912`** and code **`123456`** (the only pair the mappings match).
  Lightning verification is intentionally disabled locally (Homegate eagerly opens a PhoenixD
  websocket on startup; a fake URL would make it exit). Deep route detail:
  [`signup-gating.md`](signup-gating.md).

## Data, persistence, and reset

Persistent data lives in bind mounts under **`./.storage/`** (postgres, neo4j, redis, homegate,
nexus static files). `.gitignore` excludes `.env`, `storage`, and `.storage`, so your `.env` and
all stack data stay out of git.

```bash
# Full reset (wipes volumes) — needed e.g. after changing Neo4j auth,
# which won't re-take once the config files already exist
docker compose down -v
```

## Where to go next

For per-component depth, read the sibling references rather than duplicating here:

| Topic | Read |
| :-- | :-- |
| Homeserver config / admin API | [`homeserver.md`](homeserver.md) |
| Nexus api/watcher, Neo4j + Redis | [`nexus-operations.md`](nexus-operations.md) |
| Homegate SMS/Lightning/IP gating | [`signup-gating.md`](signup-gating.md) |
| pkdns / pkarr-relay | [`dns-and-relays.md`](dns-and-relays.md) |
| http-relay | [`http-relay.md`](http-relay.md) |
| Signup/invite tokens via pubky-cli | [`operator-cli.md`](operator-cli.md) |

Upstream sources: [pubky-docker README](https://github.com/pubky/pubky-docker/blob/main/Readme.md) ·
[synonymsoft registry](https://hub.docker.com/u/synonymsoft) ·
[pubky-core](https://github.com/pubky/pubky-core) ·
[pubky-nexus](https://github.com/pubky/pubky-nexus) ·
[homegate](https://github.com/pubky/homegate) ·
[pubky-app](https://github.com/pubky/pubky-app).
