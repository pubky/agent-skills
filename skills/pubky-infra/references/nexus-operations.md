# Operate the Nexus indexer

Nexus is the read-side indexer for the Pubky social graph. It ingests homeserver event streams
into Neo4j and Redis and serves a read-only `/v0` REST API. It never accepts content writes. The
write-to-homeserver / read-from-Nexus split and the `/events/` / `/events-stream` contract are
canonical in [`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).
This file covers operations only. To **consume** `/v0`, see
[`nexus-api.md`](../../pubky/references/nexus-api.md).

> **Pre-1.0 and drift-prone.** `/v0` is unstable and breaks without notice. The `/pub` path layout
> the watcher parses is not stabilized. App-specs is v0.x (Cargo.lock: `pubky-app-specs` 0.7.0,
> `pubky` SDK 0.9.3, `neo4rs` 0.8.0). Config keys, job names and instrument names drift between
> builds, and no release covers this surface. Guardrail:
> [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md). Source of truth:
> [`pubky-nexus`](https://github.com/pubky/pubky-nexus).

## Versions: what you are actually running

- **No release matches this surface.** The latest tag is still `v0.3.1`. All workspace crates
  (`nexusd`, `nexus-common`, `nexus-watcher`, `nexus-webapi`) are `0.4.1`. This file is pinned to
  `main` @ [`b043426`](https://github.com/pubky/pubky-nexus/tree/b0434269cbdd) (2026-11-10, #1225).
- **Production and staging** (checked 2026-11-12) report `0.4.1` @ `fc03062` (#1194, 2026-11-03),
  3 commits behind the pin. Check any deployment with `GET /v0/info`. It returns `name`,
  `description`, `homepage`, `license`, `repository`, `version`, `commit_hash`,
  `last_index_snapshot` and `base_file_url` (prod `/home/pubky/static/files`, staging
  `/home/pubky-stag/static/files`).
- **Build the image yourself from a pinned commit** with the repo `Dockerfile` (see
  [Deploying](#deploying)). **Do not pull `synonymsoft/pubky-nexus` from Docker Hub.** It has only
  three stale commit builds, not releases: `716b64fc561a…` (#863, 2026-05-15), `latest` (pushed
  with it, 2026-05-29) and `ca5ea639…` (#625, 2025-11-24). They did not come from
  [`docker.yml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/.github/workflows/docker.yml),
  which runs only on `v*.*.*` tag pushes and tags the image with the git tag name.

**(main-only)** below means the change is **not** in the deployed `fc03062`
([compare](https://github.com/pubky/pubky-nexus/compare/fc03062118e1...b0434269cbdd)). Only three
changes are main-only:

- #1222: watcher event lines split at the first space only
- #1225: the resolver judges a record against the one on the edge (`NoRecord` / `IgnoredOlder`
  outcomes, `ignored_older_record` counter); a missing record no longer marks a mapping stale
- #1226: dependency bump (redis, tokio, const_format, toml)

**Already deployed at `fc03062`** (documented below without a tag):

- config: global `--config-dir`, `[stack.media]`, `[stack.net]`, `[features]` (#1117),
  typed `ConfigError` (#1157), API Pubky client (#1177)
- jobs: `hot-tags-cache-*`, `influencers-cache-*`, `most-followed-cache` (#1151 / #1152)
- watcher: backoff vs limit (#1100), external 5xx backoff (#1111), unbound-user backoff (#1112),
  non-2xx primary poll fails (#1119), no hard processor timeout and the 8-min external run budget
  (#1133), `UnsupportedTarget` (#1134 / #1158 / #1167), takedowns (#1139), shared
  `HomeserverClient` (#1141), `HOSTED_BY` record (#1176), post index recovery (#1194)
- graph and build: `postLockIndex` (#1207), `rust-toolchain.toml` (#1132), migrations up to
  `UserCountsKeysRetire1792418266`

## Architecture

| Crate | Role |
| :-- | :-- |
| `nexus-webapi` | REST API server (`/v0`, unstable) |
| `nexus-watcher` | ingests homeserver events into the graph |
| `nexus-common` | shared DB connectors, models, queries, config |
| `nexusd` | runs the components, DB migrations, reindexing |

Stores: **Neo4j** (graph, complex queries) and **Redis** (cache, RediSearch indexes). Treat
**both** as durable (see [Redis is state](#redis-is-state-not-just-cache)).

Neo4j constraints and indexes are created idempotently (`IF NOT EXISTS`) at startup by
[`setup_graph`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-common/src/db/graph/setup.rs#L13).
A new index needs no migration: for example, #1207 adds `postLockIndex` on `(:Post).lock`
([line 36](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-common/src/db/graph/setup.rs#L36)).
The `locked` stream filter it supports is API surface; see
[`nexus-api.md`](../../pubky/references/nexus-api.md).

## nexusd CLI

The binary is `nexusd` (clap name `pubky-nexus`). `-c/--config-dir` is **global**: put it before or
after any subcommand (a test checks both). The default is `$HOME/.pubky-nexus`. A leading `~` is
expanded. The directory need not exist, but a path to an existing file is rejected.

| Command | Does |
| :-- | :-- |
| _(none)_ / hidden `run` | Runs the API, the watcher and the job scheduler. Reads `config.toml` and validates every `[jobs.*]` section first, then runs all three via `try_join!` on one shutdown channel (Ctrl-C). Returns when one errors or all have shut down. |
| `api` | API only (same `config.toml`) |
| `watcher` | watcher only (same `config.toml`) |
| `jobs list` / `jobs run <name>` | list registered jobs / run one now |
| `db clear --yes` | **Destructive.** `FLUSHDB`s the configured Redis logical DB and deletes **every** Neo4j node (`MATCH (n) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS`). Without `--yes` it prints a warning and exits `1`. |
| `db mock [--mock-type redis\|graph]` | **Destructive, no `--yes` gate.** Default: wipes Neo4j, runs `$CONTAINER_RUNTIME exec neo4j bash /test-graph/run-queries.sh` (`CONTAINER_RUNTIME` defaults to `docker`), then `FLUSHDB`s Redis and reindexes it from the graph. `graph`: only wipes Neo4j and runs the script. `redis`: only `FLUSHDB`s and rebuilds Redis from the graph (no container needed). The script needs a running container named exactly `neo4j` with `./test-graph` mounted (the dev compose provides one). It also stores `hide_unranked_authors = true` in Redis whatever the config says, until the watcher next starts. The mock graph (`docker/test-graph/mocks/posts.cypher`) is test data and includes posts with a `lock` property. **Never run it against real data.** |
| `db migration new <NAME>` / `run` / `check` | see [Migration Manager](#migration-manager) |

> **A wrong `--config-dir` wipes localhost.** `db clear --yes` and `db mock` load the config with
> `read_or_create_config_file`. If `<config-dir>/config.toml` is missing (for example, a typo in the
> path), they first write the default config (`redis://127.0.0.1:6379`, `bolt://localhost:7687`) and
> then wipe whatever databases are running on localhost. Check the config path before you run
> either command.

```bash
# Run with defaults values. The config file will default from $HOME/.pubky-nexus/config.toml
cargo run -p nexusd
# Run from config file
cargo run -p nexusd -- --config-dir="custom/config/folder"
# There is also an option to run services individually
# Useful to run a database clear command before start running the watcher
# cargo run -p nexusd -- db clear --yes
cargo run -p nexusd -- watcher
cargo run -p nexusd -- api
```

Upstream README text, word for word. `nexusd` built at `b043426` accepted each command line
(checked with `--help`; an unknown flag exits `2`). The daemons were not started. Keep the `--`
before `--config-dir`, because cargo has its own `--config`.

## config.toml

nexusd reads only `<config-dir>/config.toml`. If that file is missing, nexusd creates the directory
and writes the embedded
[`nexusd/default.config.toml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/default.config.toml)
unchanged. A file that exists but is invalid causes an error and is never overwritten. **Read that
file for the full annotated key list**; it is not copied here.

> **Moved (#1102):** the daemon default is `nexusd/default.config.toml`;
> `nexus-common/default.config.toml` no longer exists. `nexus-webapi/default.api-config.toml` and
> `nexus-watcher/default.watcher-config.toml` are a flattened layout used only by the library
> `start_from_path` and the [example binaries](#example-binaries), not by `nexusd`.

- **Required:** `[stack]` with `log_level`, `files_path`, `[stack.db].redis`, and
  `[stack.db.neo4j]` `uri` + `password`.
- **Defaulted:** `[api]`, `[watcher]`, `[jobs.<name>]`, `[trust_rank]`, `[features]`,
  `[stack.otlp]`, `[stack.net]` and `[stack.media]` can be left out. A `[stack.otlp]` table you
  write must include `name`.
- **Unknown keys are silently ignored**, except in `[jobs.<name>]`, `[trust_rank]` and
  `[features]` (`deny_unknown_fields`). A mistyped or moved key raises no error.
- There is one shared `[stack]`. The API and watcher config accessors replace any per-section
  stack with the top-level `[stack]`, and the watcher also receives the top-level `[features]`.
- **Load failures** (#1157) are a typed `ConfigError` (`Read`, `Parse`, `WriteDefault`), exported
  from `nexus_common::file` alongside `ConfigLoader`. nexusd still logs
  `Failed to load config file: {e}`; the message now includes the config path and the underlying
  I/O or TOML error. Keys and `default.config.toml` did not change.

### Change before production

| Key | Shipped value | Why |
| :-- | :-- | :-- |
| `[api].public_ip` | `127.0.0.1` | Advertised in the API's pkarr packet. Set the real public IP. |
| `[api].public_addr` / `pubky_listen_socket` | `127.0.0.1:8080` / `127.0.0.1:8081` | Plain HTTP (for a reverse proxy) / HTTPS with Pkarr TLS. Loopback is unreachable from outside a container. |
| `[watcher].homeserver` | `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` ("Synonym homeserver") | Primary homeserver. The in-code `HOMESERVER_PUBKY` (`8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`, testnet) applies only when `[watcher]` is absent. Always set it. |
| `[watcher].moderation_id` | `uo7jgkykft4885n8cruizwy6khw71mnu5pq3ay9i8pw1ymcn85ko` | The config comment calls it a "test user key". Set your own moderator. |
| `[stack.db.neo4j].password` | `12345678` | Dev default |
| `[stack.otlp].endpoint` | commented out | Export off (see [Observability](#observability)) |
| `[stack].files_path`, `[trust_rank].report_dir` | `~/.pubky-nexus/...` | These do **not** follow `--config-dir` (see below) |

All pubkeys in config are raw z-base-32 (`PubkyId`) with **no `pubky` prefix**. See
[public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

> **Paths that ignore `--config-dir`.** `[stack].files_path` ships as
> `~/.pubky-nexus/static/files`, and the in-code default trust `report_dir` is
> `$HOME/.pubky-nexus/trust-reports`. Under Docker without `--config-dir`, that is
> `/root/.pubky-nexus`. When you move the config dir, set both paths explicitly and mount them.

> **The API keypair is a secret.** `<config-dir>/secret` (under `--config-dir`, not `$HOME`) is the
> Nexus API identity. nexusd reads it, or generates a random one if it is missing. With the key
> republisher on (the default), the API publishes a pkarr `SignedPacket` at startup and then every
> hour: an HTTPS/SVCB record on `.` with the `pubky_listen_socket` port and an ipv4/ipv6 hint of
> `public_ip`, plus an A/AAAA record pointing to `public_ip`, TTL 3 h. **Back the file up and
> restrict its permissions. Losing it changes the Nexus pubky identity.** For PKARR itself, see
> [`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution).

### [api]

- In a present `[api]` table, only `public_ip`, `public_addr` and `pubky_listen_socket` are
  required.
- `request_timeout_secs` (default `30`): longer requests get a 408. Values below 1 are clamped to
  1, so `0` means a 1 s timeout, **not** disabled.
- `max_body_size_bytes` defaults to `1048576`.
- `[api.rate_limit]` is **off** by default (`enabled = false`). Buckets: `default_bucket` 300/min
  burst 50, `expensive_bucket` 20/min burst 5.
  - **Keep `trust_proxy_headers = false` unless you are behind a known reverse proxy.** Otherwise
    clients can spoof `X-Forwarded-For` / `X-Real-IP`.

### [watcher]

- **Required in a present `[watcher]` table:** `homeserver`, `events_limit` (1..=1000),
  `monitored_homeservers_limit`, `primary_hs_monitoring_interval_ms` (alias `watcher_sleep`),
  `moderation_id` and `moderated_tags`. With the table absent, the in-code defaults apply
  (`DEFAULT_EVENTS_LIMIT = 1000`). The shipped file sets `events_limit = 50`.
- **Defaulted:** `key_based_events_limit` 50 (1..=100); `external_hs_monitoring_interval_ms`
  5000; `hs_resolver_interval_ms` 10000 (alias `hs_resolver_sleep`); `hs_resolver_ttl` 3600000 ms;
  `initial_backoff_secs` 60 / `max_backoff_secs` 3600; `retry_processor_interval_ms` 10000;
  `max_file_size` = 100 MiB (`104857600`, app-specs 0.7.0 `max_blob_size_bytes`).
- **`[watcher.retry]` defaults:** `max_retries` 10, `max_dependency_retries` 50,
  `initial_backoff_secs` 10, `max_backoff_secs` 3600, `initial_missing_dep_backoff_secs` 60,
  `max_missing_dep_backoff_secs` 3600.
- Any `*_interval_ms = 0` is a parse error.
- **Never set `initial_backoff_secs > max_backoff_secs`.** The config parses, but
  `HomeserverBackoff::new` **panics** (`Invalid config: initial_backoff_secs > max_backoff_secs`)
  when the watcher starts.

### [stack.net]

- `testnet` (default `false`); `testnet_host` (default `"localhost"`, used only when
  `testnet = true`).
- **`testnet` / `testnet_host` belong under `[stack.net]`.** Under `[watcher]` they are silently
  ignored.
- `pubky_http_request_timeout_secs` (default 300; `0` is rejected): the total deadline for every
  Pubky-client HTTP request, including reading the body. Keep it long enough to download a file of
  `max_file_size`.
- `external_hs_pk_blacklist = []` (`PubkyId`s): homeservers whose users are not indexed.
- **The API also uses `[stack.net]`** (#1177). `nexusd api` initializes the Pubky client with
  `testnet_host` and `pubky_http_request_timeout_secs`, because the ingest route looks users up on
  PKDNS. If the client cannot be built, the API logs
  `Pubky client not initialised; ingest will fail` and keeps serving reads. **Alert on that
  warning**: ingest is broken while reads look healthy.

### [stack.db]

- `redis` is a URL string. `ft_search_timeout_ms` (default 50) caps RediSearch `FT.SEARCH`. On
  timeout, the search returns **partial results** (`ON_TIMEOUT RETURN`).
- `[stack.db.neo4j]`: `uri`; `password`; `user` (default `neo4j`; Community Edition needs only the
  password); `slow_query_logging_threshold_ms` (unset = off, `0` = warn on every query; shipped
  `100`); `slow_query_logging_include_cypher` (default `false`).
- Since #1099, connection strings are logged with credentials redacted (`***`).

### [stack.media]

Used by the API's media variant pipeline (ImageMagick; the image has no ffmpeg).

- `max_concurrency`: defaults to the CPU core count, minimum 4 (the config comment suggests
  cores/2 as a starting point). `process_timeout_secs`: default 180. Both reject `0`.
- Keep `process_timeout_secs` **above** ImageMagick's own 30 s time limit
  (`docker/imagemagick/policy.xml`) and below the 1 h `.tmp` sweep.
- **Trade-off with `[api].request_timeout_secs`:** set it below `request_timeout_secs` if callers
  should get the result rather than a 408. The shipped defaults (180 vs 30) do **not**, and the
  30 s ImageMagick limit leaves no value that meets both bounds at the default request timeout. By
  default, a caller of a slow conversion gets a 408 while the variant still publishes.
- The Docker image sets ImageMagick caps (6000x6000, list-length 300, memory/map/disk 1GiB,
  time 30) via `MAGICK_CONFIGURE_PATH=/etc/nexus/imagemagick`.

### [features]

- `hide_unranked_authors` (default `false`, #1117): hides posts by authors outside the trust
  ranking from the shared global and per-tag streams. It has no effect without a ranking, and a
  ranking needs `trust-recompute` and `[trust_rank].seed`.
- **Only the watcher reads `[features]`.** At startup it stores the switch in Redis, and the API and
  jobs follow the stored value. In a split deployment, set it in the watcher's config.
- To apply a change, restart the watcher (or `nexusd run`). **Wiping Redis turns the feature off**
  until the watcher next starts. **`db mock` turns it on** until the watcher next starts.
- `deny_unknown_fields`. Builds before #1117 (for example `adc9811`) silently ignore the whole
  table.

## Scheduled jobs

Registered at the pin (`nexusd jobs list`): `influencers-cache-{today,this-week,this-month,all-time}`,
`hot-tags-cache-{today,this-week,this-month,all-time}`, `most-followed-cache`, `trust-recompute`.

- Configure each job as `[jobs.<name>]`, with `cron` as the **only** key (`deny_unknown_fields`).
  `cron` is **seconds-first, in UTC**: `sec min hour dom month dow [year]`. For example,
  `cron = "0 0 3 * * *"` runs every day at 03:00 UTC.
- **Scheduling rule:**

  | Config | Result |
  | :-- | :-- |
  | no `[jobs.<name>]` section | built-in `default_cron`, if the job has one; else unscheduled |
  | section with `cron` | that schedule |
  | section **without** `cron` | unscheduled; still runnable with `jobs run <name>` |

- Only two jobs have built-in crons: `influencers-cache-all-time` (`0 4 2 * * *`, 02:04 UTC) and
  `most-followed-cache` (`0 6 4 * * *`, 04:06 UTC). The shipped config comment that calls
  `influencers-cache-all-time` "the one exception" is out of date. Each job is the **only writer**
  of its ranking: `Sorted:Users:Influencers` (the default `source=influencers` user stream) and
  `Sorted:Users:MostFollowed` (`source=most_followed`). **An empty section turns the job off, and
  its ranking stops changing.**
- All other cache jobs ship commented out. `[jobs.trust-recompute]` ships present with `cron`
  commented out, so it runs only on demand.

> **Scheduled jobs run only under `nexusd run`** (the Docker image's default `CMD`). A deployment
> that runs `nexusd api` and `nexusd watcher` separately gets **no scheduled jobs**, so the AllTime
> influencers and most-followed rankings never refresh. Switch to a single `nexusd run`, or call
> `nexusd jobs run <name>` from an external cron.

- **Validation:** only `nexusd run` and `jobs run` validate `[jobs.*]`; `api` and `watcher` never
  read it. A section that names no registered job fails with `UnknownJobConfig`, and a malformed
  cron fails with `InvalidCron`. **Before you roll back `nexusd run` to an older binary, comment out
  any job sections it does not know.** For example, `adc9811` (before #1151 / #1152) has no
  `influencers-cache-all-time` or `most-followed-cache`, so its `nexusd run` and `jobs run` refuse
  to start while those sections are active. Split `api`/`watcher` processes still start.
- **Run lock:** a cross-process Redis lock serializes each job's runs. `MAX_RUN` is 3600 s, and a
  run is abandoned at that deadline. The lease adds a 60 s margin (`LOCK_TTL_SECS` = 3660), so it
  frees itself after a crash. Lock I/O is capped at 5 s. An on-demand `jobs run` takes the same lock
  and **errors** (it does not skip) if the lock is held.
- **Abandoning a run only drops the `run()` future.** Work spawned onto its own task keeps going,
  and so do server-side GDS calls.

### trust-recompute

Runs a seeded personalized PageRank over the follow graph through the **Neo4j Graph Data Science
(GDS)** plugin (`gds.pageRank.mutate`) and writes the result to `u.trust`.

`[trust_rank]` (`deny_unknown_fields`):

| Key | Default |
| :-- | :-- |
| `seed` | `[]`. **The job refuses to run until it is set, or when none of the seeds exists as a User in the graph.** Duplicates are removed. |
| `alpha` | `0.35`, range (0,1]; GDS `dampingFactor = 1 - alpha` |
| `max_iterations` / `tolerance` | `200` (>=1) / `1e-7` |
| `report_enabled` / `report_dir` / `report_limit` | `false` / `~/.pubky-nexus/trust-reports` (CSV `trust-report-<UTC>.csv`) / `10000` |
| `max_projection_bytes` | optional; caps the GDS projection estimate |

`trust.recompute.max_iterations_reached` counts runs that did not converge.

**Neo4j requirements.** Stock `neo4j:5.26` Community Edition does not include GDS, and GDS 2.13 is
the only series that supports Neo4j 5.26. Production Neo4j needs the settings that the dev image
**plus** the dev compose file provide. **Building only the image gives you none of the procedure,
heap or timeout settings.**

- Image
  ([`docker/neo4j/Dockerfile`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/docker/neo4j/Dockerfile),
  on `neo4j:5.26.27-community`): only bakes `neo4j-graph-data-science-2.13.10.jar` into
  `/var/lib/neo4j/products/` (sha256
  `d3d842653fede3f83d6c7e2a6fafb73ac5b7dce98e2e234c18e755852e432e14`).
- Compose environment
  ([`docker/docker-compose.yml#L29-L49`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/docker/docker-compose.yml#L29-L49);
  in production, `neo4j.conf` or the equivalent env vars):
  - `NEO4J_PLUGINS='["graph-data-science"]'`
  - `dbms.security.procedures.unrestricted=gds.*`, and an allowlist of `gds.graph.project`,
    `gds.graph.project.estimate`, `gds.graph.drop`, `gds.graph.list`, `gds.pageRank.mutate`,
    `gds.graph.nodeProperty.stream`
  - heap for GDS projections (dev: heap 2G, pagecache 1G)
  - **`db.transaction.timeout` set on the server** (dev: 15m). It is the only bound on GDS calls
    abandoned at `MAX_RUN`, because `neo4rs` 0.8 has no per-query transaction timeout.

Trust scores also order external-homeserver polling: by `sum(coalesce(u.trust,0))` DESC, then
active user count DESC. With an empty seed every sum is 0, so the order falls back to user count.

## Watcher: event ingestion

`NexusWatcher::start` first calls `Homeserver::persist_if_unknown([watcher].homeserver)`. It then
runs four periodic tasks, each on its own tokio interval with `MissedTickBehavior::Skip`, sharing
one `HomeserverClient` (#1141), one event handler and one retry scheduler. At startup the builder
also stores the `[features]` switches and initializes `PubkyConnector` with `testnet_host` and
`pubky_http_request_timeout_secs`.

| Task | Interval key | Does |
| :-- | :-- | :-- |
| primary-homeserver | `primary_hs_monitoring_interval_ms` | cursor-paged `/events/` from `[watcher].homeserver` |
| external-homeservers | `external_hs_monitoring_interval_ms` | per-user `/events-stream` from other homeservers |
| user-hs-resolver | `hs_resolver_interval_ms` | maps users to their homeserver |
| retry-processor | `retry_processor_interval_ms` | replays failed events |

- A task error is logged and the loop continues. A task **panic** cancels the other tasks after
  their current iteration.
- **No hard run timeout (#1133).** Each processor run is spawned and awaited. A run longer than
  `SLOW_RUN_THRESHOLD` (3600 s; for external homeservers, the budget + 900 s) is only logged as
  slow, and logged again after each further threshold. **A run that never returns blocks its loop
  permanently.** The thresholds are compile-time constants. Older docs that mention a "processor
  default 3600 s timeout" are out of date.

### Primary homeserver

Polls `GET https://<homeserver z32>/events/?cursor=<cursor>&limit=<events_limit>`.

- **A non-2xx response fails the poll** (#1119; error body capped at 4 KiB) instead of being parsed
  as events.
- The body is capped at 5 MiB (`TooLarge`, plus `watcher.fetch.rejected{reason=size_exceeded}`).
  `cursor: ` lines are extracted wherever they appear, and the last one wins.
- Each event line is split at the **first** space only (main-only, #1222): `<PUT|DEL> <uri>`.
  Homeservers write stored file names unencoded, so a URI can contain spaces. On the deployed
  `fc03062` and earlier, such a line is rejected as `InvalidEventLine`. A line with no space
  (`PUT`, an empty line) is always `InvalidEventLine`.
- The cursor is validated **before** any handler runs, and persisted to Redis **only after the
  whole batch succeeds**. A shutdown mid-batch replays the batch.
- A rejected cursor skips the whole batch and keeps the stored cursor. Alert on any sustained
  non-zero rate of:
  - `watcher.primary_hs.cursor.invalid{hs_id}`: the cursor is unparseable, would rewind, or comes
    from an idle response and differs from the stored one.
  - `watcher.primary_hs.cursor.stalled{hs_id}`: events are present but the cursor does not advance,
    or there is no cursor line.
- A Redis infrastructure error fails the run.
- Events are indexed only from users with no `HOSTED_BY` edge, or with a non-stale `HOSTED_BY` to
  this homeserver. Events from other users are skipped.
- The primary homeserver has **no per-HS backoff**.

### External homeservers

- **Targets** (from Neo4j): homeservers with non-deleted users on non-stale `HOSTED_BY` edges,
  ordered by hosted trust, then user count. The primary and blacklisted homeservers are excluded.
  Homeservers in backoff are skipped **before** the list is truncated to
  `monitored_homeservers_limit`, so they do not count toward it (#1100).
- **Fetch:** for each user, a non-live
  `/events-stream?user=<pk>:<cursor>&limit=<key_based_events_limit>&path=/pub/`, resuming from the
  per-user Redis cursor (`UserHsCursor`). Events beyond the limit are dropped and logged.
- **Run budget:** `KEY_BASED_RUN_BUDGET` is 8 min per homeserver run, checked after each user and
  each event (not a hard timeout). When it is spent, the run keeps the cursors it reached and
  records a resume point, so the next run starts at the next user. The run ends with `BudgetSpent`
  and backs the homeserver off as it would for a failure.
- **Safety checks:**
  - Any event cursor at or below the floor (the stored cursor, or an earlier event in the batch)
    rejects the **whole** per-user batch with `EventCursorOutOfOrder` and increments
    `watcher.external_hs.cursor.out_of_order{hs_id}`. This aborts the homeserver run and triggers
    per-HS backoff.
  - An event owned by a different user is rejected (`UserIdMismatch`), and the cursor does not
    advance.
- **Failures on `/events-stream`:**

  | Response | Effect |
  | :-- | :-- |
  | 429 | retried after 1, 2, 3 s, then `HsEventsStreamRateLimitExhausted`; aborts the HS run |
  | 5xx (#1111) | `HsEventsStreamServerError`; aborts the HS run and backs it off. A 5xx on a resource or blob fetch stays per-event. |
  | transport failure / timeout | aborts the HS run |
  | 404 | that user skips 1, 2, … up to 10 subsequent runs (in memory) |

- **Per-HS backoff:** `min(initial_backoff_secs * 2^n, max_backoff_secs)`, held in memory and reset
  by an `Ok` run.

### User homeserver resolver

- Each tick selects non-deleted users that have no `HOSTED_BY` edge, or whose `resolved_at` is
  older than `hs_resolver_ttl`. Unbound users whose lookup returned nothing are backed off in
  memory (60 s, doubling up to the TTL; #1112).
- Resolves via PKDNS/DHT **one user at a time**, in bisection order of the sorted keys. Parallel
  resolution proved unreliable as of `pubky` 0.7.0. For PKARR itself, see
  [`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution).
- **Outcomes** (main-only, #1225;
  [`Resolution`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/service/user_hs_resolver.rs#L402-L427)).
  On the deployed `fc03062` and earlier, a changed **or missing** homeserver marks the mapping
  stale.

  | Resolution | When | Graph effect |
  | :-- | :-- | :-- |
  | `Unbound` | no edge; nothing published, or the record names no homeserver | untouched; unbound backoff applies |
  | `Bound` | no edge; the record names a homeserver | creates `(:User)-[:HOSTED_BY]->(:Homeserver)` |
  | `Confirmed` | the record names the stored homeserver | clears `stale` |
  | `Diverged` | the signed record names no homeserver, or a different one | sets `stale` |
  | `NoRecord` | bound, and no record found (on `pubky` 0.9.3, a DHT or relay outage looks the same) | flag and record stand; only `resolved_at` moves |
  | `IgnoredOlder` | the record is older than the edge's `record_ts` (a replay or lagging answer) | flag and record stand; only `resolved_at` moves |
  | `LookupFailed` | transport error (`pubky` 0.10+), or an answer signed by another key | untouched |

- **At the pin, only a signed record that names no homeserver, or a different one, marks a
  mapping stale** (main-only). A missing record no longer does, so a PKDNS outage does not pause
  indexing. On the deployed build it still does.
- **The edge keeps the record it was applied from** (#1176;
  [`put.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-common/src/db/graph/queries/put.rs#L465-L531)).
  `r.record` is the signed PKARR packet, lowercase hex (`StoredRecord::verify` can check it).
  `r.record_ts` is the packet timestamp in **microseconds**, readable from Cypher. Both are written
  with `coalesce`, so a write with no record keeps the old values. `r.resolved_at` is refreshed
  with `timestamp()` on every write.
- **Switching homeservers is not implemented.** A user's bound homeserver never changes, and stale
  users stop being indexed.

### Event dispatch

- **PUT:** checks takedowns first, then fetches the resource (capped at 2 MiB) and validates it with
  `PubkyAppObject::from_resource`. A validation failure is `SpecValidation` and is never retried.
  For the data contract, see [`app-specs.md`](../../pubky/references/app-specs.md). The event then
  goes to the user, post, follow, bookmark, tag (pubky.app or universal-tag) or file handler. File
  blobs are capped at `max_file_size`: `Content-Length` is checked first, then the stream is
  counted.
- **DEL:** goes to the matching delete handler.
- **Post index recovery** (#1194): when a post write commits but indexing fails, the retry runs
  `recover_post_index_state`. It re-sends the mention, reply and repost notifications before
  `PostDetails` is indexed. These use `ZADD NX`, so a replayed event neither duplicates a
  notification nor moves it to the top. A tombstone notifies nobody.
- **Mute PUT and DEL are ignored.**
- Every handled event line is also appended to the Redis `Events` list.

**Moderation.** When `moderation_id` tags content with a label in `moderated_tags` (shipped:
`hatespeech`, `harassement` (sic), `terrorism`, `violence`, `illegal_activities`,
`il_adult_nu_sex_act`), the target is removed. A post is hard-deleted if it has no edges, and
tombstoned otherwise. Since #1139:

- A **user profile** target is deleted but not remembered, so the user can come back with a new
  profile.
- A **post, tag or file** target is recorded as a permanent `:Takedown {uri, tag_uri}` node. Any
  later or replayed PUT for that URI is dropped (`watcher.events.taken_down`) and checked again
  after writing.
- **Lifting a takedown is not implemented**, not even by deleting the moderator's tag.

### Retry queue

Redis prefix `RetryManagerV2` (sorted set `events` + JSON `state`), keyed by hash(URI) with a
per-entry nonce, so a newer event for the same URI replaces an in-flight retry. The exact
classification of each error is in
[`should_enqueue_related_event`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/events/retry/scheduler.rs#L52)
and
[`should_not_retry_now`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/errors.rs#L218).
The variants change between builds.

- **Never retried:** malformed or invalid input: `SpecValidation`, `UnsupportedTarget`,
  `FetchSizeExceeded`, `UserIdMismatch`, `EventCursorOutOfOrder`, blacklisted homeservers, and
  client 404 / auth / parse failures. Fix these at the source; replaying does not help.
- **`UnsupportedTarget`** covers tags whose target is neither Post nor User (#1134), and since
  #1158 / #1167 also:
  - tags and moderator tags whose target is not a parseable pubky.app URI (another scheme,
    another app, a bad user id)
  - bookmarks whose URI does not parse or does not point to a Post
  - files whose `src` does not parse

  Before #1158 / #1167 (for example `adc9811`), these are `Generic`: retried up to the cap, then
  dropped. A rejected moderator-tag target logs at `warn`.
- **Retried:** 429, 5xx, request and pkarr failures, and other transient errors. Up to 100 ready
  events are processed per batch, with backoff `min(initial * 2^n, max)`:
  - `MissingDependency`: from `initial_missing_dep_backoff_secs`, up to `max_dependency_retries`.
  - Others: from `initial_backoff_secs`, up to `max_retries`.
- **Exhausted budget = dropped.** The entry is removed from Redis. There is **no dead-letter
  store** to inspect or replay.
- **Rescheduled without spending budget, and the batch stops:** `should_not_retry_now` errors
  (Neo4j/Redis outages, `/events-stream` transport/5xx/429).

### Redis is state, not just cache

- The primary HS cursor lives **only in Redis**. If Redis lacks the `Homeserver` key while Neo4j
  has the node, `persist_if_unknown` re-seeds cursor `0`, and the watcher **re-indexes that
  homeserver from the start**. Restoring a snapshot that is behind resumes from that snapshot's
  cursor.
- `Homeserver::get_by_id` has no graph fallback. A Redis miss fails the HS run rather than writing
  cursor 0.
- The per-user external cursors (`UserHsCursor`), the retry queue and the `[features]` switch are
  also stored only in Redis.
- **Run Redis with persistence** (the dev compose mounts `.database/redis/data`).

## Migration Manager

Runs phased data migrations across Neo4j and Redis. Each migration's status is stored in a
`(:Migration {id, phase, created_at, updated_at})` node. Phases:
`dual_write → backfill → cutover → cleanup → done`. Definition and phase docs:
[`manager.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/migrations/manager.rs).

| Phase | Meaning |
| :-- | :-- |
| DualWrite | The data layer calls `MigrationManager::dual_write::<T>(data)`. No handler runs. Waits until the id is listed in `backfill_ready`. |
| Backfill | Copy old → new; afterwards new must be consistent with old. |
| Cutover | Reads switch to new. Redis: usually `RENAME` new key → old key. Graph: an app-code change plus removing the `dual_write` calls. |
| Cleanup | Delete old keys / nodes. |

**`db migration run`:**

1. Sets **every** stored migration whose id is in `backfill_ready` to `Backfill`, whatever its
   current phase.
2. For each registered migration, **in registration order**:
   - **Not yet stored:** MERGE it at its initial phase. A multi-staged migration starts at
     `dual_write` and is skipped this run. A single-staged one starts at `backfill` and runs now.
   - **`Done`:** skip.
   - **Otherwise:** run the current phase's handler, then advance. Multi-staged migrations move one
     step; single-staged ones go straight to `Done`.

All 15 migrations registered at the pin are single-staged. Registration order matters (for example,
`UserDeletedFlag` must come before `UsersByTagsIndexBackfill`).

> **Bugs reported in upstream #967 (now closed) and still present at the pin:**
>
> - **Remove ids from `backfill_ready` as soon as their backfill finishes.** Step 1 resets a listed
>   migration in **any** phase, including `Done`. A single-staged migration then re-runs its
>   backfill on every `run`, and a multi-staged one loops Backfill → Cutover and never reaches
>   cleanup. `check` treats `Done` as terminal, so it reports nothing pending while `run` still
>   re-runs a listed `Done` migration.
> - **Never run `db migration run` from parallel deploy replicas.** `store_new_migration` MERGEs on
>   `{id, phase, created_at: timestamp(), updated_at: 0}`, so two concurrent first-time runs can
>   create duplicate `:Migration` nodes.

**Use `db migration check` as a deploy gate.**

| Outcome | Output | Exit |
| :-- | :-- | :-- |
| pending | `<id> (<phase>)` per migration (`new` if never stored), then `N pending migration(s)` | `10` |
| nothing pending | `No pending migrations` | `0` |
| config / DB error | error | non-zero: `1` for an `Err` from `main`; `101` on a panic, such as a malformed or unreadable `migrations/config.toml` |

Pending means one of: never stored; in `DualWrite` and listed in `backfill_ready`; or in Backfill,
Cutover or Cleanup.

> **`check` can silently check localhost.** If `<config-dir>/migrations/config.toml` is missing,
> `check` creates it from the embedded default, which points at localhost Redis and Neo4j. On a
> fresh container it then checks localhost, not your production databases. Mount the migrations
> config before you gate on it.

```bash
nexusd --config-dir /etc/pubky-nexus db migration check
case $? in
  0)  echo "no pending migrations" ;;
  10) echo "pending migrations: run 'nexusd --config-dir /etc/pubky-nexus db migration run'"; exit 1 ;;
  *)  echo "migration check failed (config/DB error)"; exit 1 ;;
esac
```

Executed against throwaway `neo4j:5.26.27` and `redis:8.0.6-alpine` containers (with the config
dir pointed at them), not production: a fresh DB exited `10` (15 pending), then `0` after
`db migration run`; a malformed `migrations/config.toml` exited `101`; an unreadable
`/etc/pubky-nexus` exited `1`. Each code took the expected branch.

### Migration config (separate file)

- Path: `<config-dir>/migrations/config.toml`. It honors `--config-dir`.
- Auto-created from the embedded
  [`nexusd/src/migrations/default.config.toml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/migrations/default.config.toml),
  which the README points to. **Edit the runtime copy.**
- It holds `backfill_ready = [ids]` plus a **full, independent `[stack]`**: `log_level = "debug"`,
  `files_path = "./static/files"`, otlp name `nexusd.migration`, and its own `[stack.db]` with
  `redis://localhost:6379` and `bolt://localhost:7687` / `12345678`. **Point its Redis and Neo4j at
  the same databases as `config.toml`.**
- The loader **panics** on a parse error (`Error with migration config file`), which exits 101.

### Adding a migration

```bash
cargo run -p nexusd -- db migration new TagCountsReset

cargo run -p nexusd -- db migration run
```

From the upstream README. `db migration new` was run in a throwaway copy of the repo and wrote
`nexusd/src/migrations/catalog/tag_counts_reset_<unix_ts>.rs`. `db migration run` was run only
against throwaway databases via `--config-dir`; as written (no `--config-dir`) it uses
`~/.pubky-nexus/migrations/config.toml`, which defaults to localhost.

1. **Scaffold** from the **repo root**: `MIGRATION_PATH` (`nexusd/src/migrations/catalog/`) is
   relative. No DB or config is needed. The command writes `catalog/<snake_name>_<unix_ts>.rs` and
   appends `pub mod …;` to `catalog/mod.rs`. (The directory used to be `migrations_list/`.)
2. **Register** `Box::new(YourStruct)` in `import_migrations` in
   [`nexusd/src/migrations/catalog/mod.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/migrations/catalog/mod.rs)
   (no longer `migrations/mod.rs`). **Unregistered migrations never run.**
3. **Implement** the `#[async_trait]` `Migration` trait: `id() -> &'static str`,
   `is_multi_staged() -> bool` (`false` = only backfill runs), the associated function
   `dual_write(data: Box<dyn Any + Send + 'static>)` (`where Self: Sized`), and
   `backfill` / `cutover` / `cleanup(&self)`, all returning `Result<(), DynError>`. The
   `/examples/migration.rs` that the README mentions does not exist. Copy a real single-stage file
   instead, such as
   [`catalog/users_by_pk_reindex_1751635096.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/migrations/catalog/users_by_pk_reindex_1751635096.rs).

## Observability

- **Export:** setting `[stack.otlp].endpoint` (for example `endpoint = "http://localhost:4317"` with
  `name = "nexusd"`) turns on OTLP/gRPC (tonic) export of **traces, logs and metrics** (exporter
  timeout 3 s, metrics every 30 s).
- `service.name` is `[stack.otlp].name`. It overrides any `service.name` in
  `[stack.otlp.resource_attributes]`; the other attributes are added. Shipped names: `nexusd`
  (daemon) and `nexusd.migration` (migrations). The in-code default is `nexus`.
- **Logs always go to stdout as well** (compact format). Without an endpoint, metrics are disabled.
- **Log filtering:** `RUST_LOG` (`EnvFilter`) overrides `log_level`. HTTP/TLS crates are always
  capped. `mainline` / `pkarr` / `pubky` are capped at info / warn / warn unless
  `log_level = "trace"`.
- Each process gets one stack config. `StackManager::setup` errors if a second, different
  `StackConfig` is set up in the same process.

**Local stack** (`docker/docker-compose.observability.yml`, separate from the DB compose):
otel-collector-contrib 0.115.1 (`127.0.0.1:4317` gRPC / `4318` HTTP) feeds Tempo 2.6.1 (traces),
Prometheus v2.55.1 (`127.0.0.1:9090`, 24 h retention, remote-write receiver,
`--web.enable-lifecycle`) and Loki 3.3.0 (`127.0.0.1:3100`). Grafana 11.4.0 runs on
`127.0.0.1:3000`. SigNoz is still supported: point `endpoint` at its OTLP port (dashboard
`http://localhost:3301`).

> **Grafana runs with anonymous Admin access and no login form** (`GF_AUTH_ANONYMOUS_ENABLED=true`,
> `GF_AUTH_ANONYMOUS_ORG_ROLE=Admin`, `GF_AUTH_DISABLE_LOGIN_FORM=true`). The ports bind to
> `127.0.0.1`. **Never expose this compose file as-is.**

```bash
docker compose -f docker/docker-compose.observability.yml up -d

curl -X POST http://localhost:9090/-/reload

docker run --rm -v "$PWD/docker/otel:/rules:ro" --entrypoint promtool prom/prometheus:v2.55.1 check rules /rules/alerts.yaml
```

Run from the repo root (upstream README commands). The `promtool` check was run and found 2 rules.
The compose file passed `docker compose config` and `up --dry-run`; the full stack was not brought
up. `POST /-/reload` returned HTTP 200 against a standalone `prom/prometheus:v2.55.1` started with
`--web.enable-lifecycle`. On Docker Desktop for macOS, the rules bind mount is empty for
directories under `/private/tmp` or `/var/folders`, so run the check from a clone under `/Users`.

- **Alert rules** are mounted from `${PROMETHEUS_ALERTS_FILE:-./otel/alerts.yaml}` (relative to
  `docker/`). Shipped rules: `NexusNeo4jQueryErrors` (`sum(rate(neo4j_query_errors_total[5m])) > 0`
  for 5m) and `NexusWatcherCursorStalled` (`increase(watcher_primary_hs_cursor_stalled_total[15m]) > 0`).
- Prometheus remote-write turns dots into underscores, appends `_total` to counters, and maps
  `service.name` to the `service_name` label.

**Instruments at the pin.** The names are unstable. Confirm them against the `global::meter` call
sites (for example
[`user_hs_resolver.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/service/user_hs_resolver.rs#L685-L726))
for the binary you run.

| Meter | Instruments |
| :-- | :-- |
| `nexus.watcher` | counters `watcher.primary_hs.cursor.{invalid,stalled}{hs_id}`, `watcher.external_hs.cursor.out_of_order{hs_id}`, `watcher.fetch.rejected{reason}`, `watcher.events.taken_down`; gauges `watcher.external_hs.{monitored_limit,indexed}` |
| `hs-resolver-meter` | histograms `nexus.task.hs-resolver.{total,failed}`; counters `.resolutions{outcome=resolved\|unresolved\|error, mapping=unbound\|active\|stale\|unknown}`, `.marked_stale{reason=unresolved\|hs_changed}` (active-to-stale transitions only; at the pin, `unresolved` = the signed record names no homeserver), `.ignored_older_record` (main-only, #1225); gauges `.mapped_users`, `.stale_users`, `.heartbeat_timestamp` (s) |
| `neo4j` | `neo4j.query.{duration,execute_duration}` (f64 hist), `.rows` (hist), `.errors`, `.slow`, `.requests` |
| `nexus` | `http.rate_limit.rejected.total{bucket}`, `http.server.requests`, `http.server.request.duration` |
| `nexus.jobs` | `jobs.run.{attempts,completed,skipped}`, `jobs.scheduler.stopped`, `jobs.lock.{operations,duration}` |
| `nexus.trust` / `nexus.media` | `trust.recompute.max_iterations_reached` / `media.subprocess.timeout` |
| other | `wot.post_stream.*`, `search.posts.by_content.reach.authors` |

**Watcher trace spans.** The top-level span is `event_processor.run` (`service`, `homeserver`). Per
event, `event.process` carries `event.uri`, `event.type`, `event.user_id` and `otel.status_code`;
`SKIPPED` marks events filtered out by `HOSTED_BY`. Span names change between builds; take the
rest from the `instrument(name = …)` call sites, starting at
[`nexus-watcher/src/service/indexer/mod.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/service/indexer/mod.rs).

## Deploying

**Production image** (repo
[`Dockerfile`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/Dockerfile)): the builder is
`rust:1.99.0-alpine3.22` (`rust:1.91.0-alpine3.22` at `adc9811`); `rust-toolchain.toml` (#1132)
pins 1.99.0. The build uses static OpenSSL and `cargo build --release --bin nexusd`, and strips the
binary. The runtime is `alpine:3.22` with `ca-certificates`, imagemagick plus
webp/heic/svg/jpeg/tiff/raw plugins, and the ImageMagick policy at `/etc/nexus/imagemagick`. **There
is no ffmpeg**, and the video processor is marked unused.

- **No `ENTRYPOINT`.** `WORKDIR /usr/local/bin`, `CMD ["nexusd"]` (API + watcher + jobs).
  A command override replaces `nexusd`, so include the binary name:
  `docker run IMAGE nexusd --config-dir=/config db migration check`.
- **Without `--config-dir`**, the config dir is `/root/.pubky-nexus`.
- **Only `8080` is `EXPOSE`d.** To serve Pkarr TLS, publish `pubky_listen_socket` (8081)
  yourself.
- **In a container,** bind `public_addr` / `pubky_listen_socket` to a non-loopback address. Mount
  `<config-dir>` (`config.toml`, `secret`, `migrations/`) **and `files_path`**.

**Dev dependencies** (`docker/docker-compose.yml`) are **databases only; `nexusd` is not
included.** All ports bind to `127.0.0.1`.

| Service | Details |
| :-- | :-- |
| Neo4j | `pubky-nexus/neo4j:5.26.27-gds2.13.10`, built locally from `docker/neo4j` on first `up`; 7474 browser, 7687 bolt; pagecache 1G, heap 2G; `db.transaction.timeout` 15m; telemetry off; data/conf/logs bind-mounted under `docker/.database/neo4j/` |
| Redis | `redis:8.0.6-alpine`, 6379, `/data` bind-mounted at `.database/redis/data` |
| RedisInsight | `redis/redisinsight:3.0.3`, 5540 |
| Postgres | `postgres:18-alpine`, 5432, only with `--profile tests` or `COMPOSE_PROFILES=tests` |

```bash
cd docker
cp .env-sample .env

# Lean stack: Neo4j + Redis + Redis Insight
docker compose up -d

# With Postgres (for watcher tests)
docker compose --profile tests up -d
```

Both variants passed `docker compose config` (lean: neo4j, redis, redisinsight; tests profile adds
postgres) and `up --dry-run`. The stack was not brought up.

> **Neo4j Community Edition:** the DB name and the username must both be `neo4j`; `.env-sample`
> sets `NEO4J_PASSWORD=12345678`. The compose comment says that changing auth has no effect once
> the config files exist, and suggests `docker compose down -v`. However, data is **bind-mounted**
> under `docker/.database/neo4j/{conf,data,logs}`, and `down -v` does not delete bind mounts. A real
> reset probably also requires deleting those directories (not confirmed upstream).

**Local UIs:** Swagger at `http://localhost:8080/swagger-ui` (OpenAPI at
`/api-docs/v0/openapi.json` and `/api-docs/static/openapi.json`). RedisInsight at
`http://localhost:5540/0/browser`; on first run, dismiss an error popup and a TOS popup. Neo4j
Browser at `http://localhost:7474/browser/`. Hosted Swagger (`/v0`, unstable):
[production](https://nexus.pubky.app/swagger-ui/) ·
[staging](https://nexus.staging.pubky.app/swagger-ui/).

To run Nexus with a homeserver, relays and the app as one stack, see
[`local-stack.md`](local-stack.md) (pubky-docker).

### Example binaries

- `cargo run --bin api_example [-- --config=<dir>]` and `watcher_example` read
  `<dir>/api-config.toml` / `<dir>/watcher-config.toml`. These use a **flattened** layout (top-level
  keys plus `[rate_limit]` / `[retry]`), **not** the daemon's `[api]` / `[watcher]` tables.
- If the file is missing, the default is written there first. **An invalid file is an error**, with
  no fallback to `config.toml`. Without `--config`, the examples run with built-in defaults.
- The API example serves on `127.0.0.1:8081` (Pubky TLS on 8082).
- Library signatures: `NexusWatcher::start_from_path(config_dir: PathBuf, shutdown_rx:
  Option<Receiver<bool>>)`, and the tuple struct `NexusWatcherBuilder(pub WatcherConfig)` with
  `.start(shutdown_rx)`. `NexusWatcher::builder()` exists (it returns
  `NexusWatcherBuilder::default()`) but has **no `.run()`**, so call `.start(None)`. The one-arg
  `start_from_path(path)` in `nexus-watcher/README.md` does not exist.

## Tests

> **`db mock` first wipes the configured Neo4j graph and `FLUSHDB`s Redis**, and it leaves
> `hide_unranked_authors = true` in Redis. Run it only against the local dev compose databases.

```bash
cargo run -p nexusd -- db mock
cargo nextest run -p nexus-common --no-fail-fast
cargo nextest run -p nexus-webapi --no-fail-fast
TEST_PUBKY_CONNECTION_STRING='postgres://test_user:test_pass@localhost:5432/postgres?pubky-test=true' \
  cargo nextest run -p nexus-watcher --no-fail-fast
cargo nextest run -p nexusd --no-fail-fast
cargo bench -p nexus-webapi
```

The `nextest` commands match upstream CI (`.github/workflows/test.yml`), which supplies
`TEST_PUBKY_CONNECTION_STRING` through its environment rather than inline (the value matches
`docker/.env-sample`). `cargo bench` comes from the README's Benchmarking section; CI does not run
it. Packages, flags and bench targets were checked with cargo and cargo-nextest, but the suites
were not run here. The `nexus-watcher` tests need Postgres (`--profile tests`) and
`TEST_PUBKY_CONNECTION_STRING`, and the `nexusd` trust-rank tests need the GDS Neo4j image. Running
cargo in the clone auto-installs toolchain 1.99.0 (from `rust-toolchain.toml`).

## Upstream references

- [pubky-nexus README](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/README.md) (pinned) ·
  [releases](https://github.com/pubky/pubky-nexus/releases)
- [`nexusd/default.config.toml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/default.config.toml): every daemon config key, annotated
- [`nexusd/src/cli.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/cli.rs) ·
  [`migrations/manager.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/migrations/manager.rs) ·
  [`migrations/catalog/`](https://github.com/pubky/pubky-nexus/tree/b0434269cbdd/nexusd/src/migrations/catalog) ·
  [`jobs/registry.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexusd/src/jobs/registry.rs) ·
  [`events/retry/scheduler.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/events/retry/scheduler.rs)
- [`fc03062...b043426` compare](https://github.com/pubky/pubky-nexus/compare/fc03062118e1...b0434269cbdd): what main-only means ·
  [`bf809b0...b043426`](https://github.com/pubky/pubky-nexus/compare/bf809b07f766...b0434269cbdd): changes since the previous pin
- [`user_hs_resolver.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/service/user_hs_resolver.rs) ·
  [`graph/setup.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-common/src/db/graph/setup.rs) ·
  [`events/event.rs`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/nexus-watcher/src/events/event.rs)
- [`docker-compose.yml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/docker/docker-compose.yml) ·
  [`docker-compose.observability.yml`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/docker/docker-compose.observability.yml) ·
  [`docker/neo4j/Dockerfile`](https://github.com/pubky/pubky-nexus/blob/b0434269cbdd/docker/neo4j/Dockerfile)
- [Issue #967](https://github.com/pubky/pubky-nexus/issues/967) (closed; its migration findings are still present at the pin)
- Canonical (don't restate): [`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) ·
  [`app-specs.md`](../../pubky/references/app-specs.md) ·
  [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md) ·
  [`nexus-api.md`](../../pubky/references/nexus-api.md)
