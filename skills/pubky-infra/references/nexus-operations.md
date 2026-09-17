# Operate the Nexus indexer

Nexus is the read-side indexer for the Pubky social graph. It ingests homeserver event streams
into Neo4j and Redis and serves a read-only `/v0` REST API; it never accepts content writes. The
write-to-homeserver / read-from-Nexus split and the `/events/` / `/events-stream` contract are
canonical in [`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read).
This file covers operations only. To **consume** `/v0`, see
[`nexus-api.md`](../../pubky/references/nexus-api.md).

> **Pre-1.0 and drift-prone.** `/v0` is unstable and breaks without notice, the `/pub` path layout
> the watcher parses is not stabilized, and app-specs is v0.x. Guardrail:
> [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md). Source of truth:
> [`pubky-nexus`](https://github.com/pubky/pubky-nexus).

## Versions: what you are actually running

- **No release matches this surface.** The latest tag, `v0.3.1` (2025-02-20), predates the
  `nexusd` CLI. Crates on `main` are `0.4.1`. This file is pinned to `main` @ `794a6e1`.
- **Production and staging** report `0.4.1` @ `9e20cbf` (2026-09-03), 21 commits behind the pin.
  Check any deployment with `GET /v0/info` (`version`, `commit_hash`, `last_index_snapshot`,
  `base_file_url`).
- **Build the image yourself from a pinned commit** with the repo `Dockerfile` (see
  [Deploying](#deploying)). **Do not pull `synonymsoft/pubky-nexus` from Docker Hub for this
  surface.** Its images are stale: `latest` = `716b64f` (2026-05, 87 commits before `9e20cbf`),
  and the only other SHA tag is older still. `716b64f` has no `jobs`, no `db clear --yes`, no
  `db migration check`, and no `[stack.net]` (`testnet` is still under `[watcher]`, so a current
  config's `[stack.net] testnet = true` is silently ignored). How those images are built is not
  documented (`docker.yml` publishes only on `v*.*.*` tags).

**(main-only)** below means **not** in the deployed `9e20cbf`:

- `--config-dir` as a global flag (#1053). At `9e20cbf` it is honored only before a bare / `run` /
  `db` command; `api`, `watcher` and `jobs run` take their own per-subcommand `-c`. The migration
  config path also ignores it there.
- the `hot-tags-cache-*` (#1069) and `influencers-cache-*` (#1052) jobs
- `[stack.media]` and the `nexus.media` meter / `media.subprocess.timeout` (#999);
  `[stack.net].pubky_http_request_timeout_secs` (#1043)
- ordering external homeservers by hosted trust (#1065)
- the `watcher.external_hs.*` gauges (#1068)
- every hs-resolver instrument except `total` / `failed`: `resolutions`, `marked_stale`,
  `mapped_users`, `stale_users`, `heartbeat_timestamp` (#1063)
- `http.server.requests`, `http.server.request.duration`, `neo4j.query.requests` and the neo4j
  label restructuring (#1033)
- the moderated-post safe-delete gate (#971). `9e20cbf` calls `post::sync_del` unconditionally.
- the Prometheus alerts file mount (#1064)
- the `CollectedEdgesBackfill1789344000` migration (#1067)

Already deployed at `9e20cbf`: `jobs`, `trust-recompute`, `db clear --yes`, `db migration check`,
`[stack.net]` `testnet` / `external_hs_pk_blacklist`, `[watcher.retry]`.

## Architecture

| Crate | Role |
| :-- | :-- |
| `nexus-webapi` | REST API server |
| `nexus-watcher` | ingests homeserver events into the graph |
| `nexus-common` | shared DB connectors, models, queries, config |
| `nexusd` | runs the components, DB migrations, reindexing |

Stores: **Neo4j** (graph, complex queries) and **Redis** (cache, RediSearch indexes). Treat
**both** as durable (see [Redis is state](#redis-is-state-not-just-cache)).

## nexusd CLI

Binary `nexusd` (clap name `pubky-nexus`). `-c/--config-dir` is **global** (main-only, see
above): place it before or after any subcommand. Default `$HOME/.pubky-nexus`; a leading `~` is
expanded; the directory need not exist, but a path to a file is rejected.

| Command | Does |
| :-- | :-- |
| _(none)_ / hidden `run` | API + watcher + scheduled jobs. Validates every `[jobs.*]` schedule first (bad cron or unknown job fails fast), then runs all three via `try_join!` on one shutdown channel (Ctrl-C). Exits when one errors or all stop. |
| `api` | API only |
| `watcher` | watcher only |
| `jobs list` / `jobs run <name>` | list registered jobs / run one now |
| `db clear --yes` | **Destructive.** `FLUSHDB`s the configured Redis DB and deletes **every** Neo4j node. Without `--yes` it exits `1`. **Before #974 (2026-09-03), incl. Docker Hub `latest`, bare `db clear` wipes immediately with no prompt and uses `FLUSHALL`, wiping every logical DB on the Redis server.** |
| `db mock [--mock-type redis\|graph]` | **Destructive, no `--yes` gate.** `DETACH DELETE`s every Neo4j node and `FLUSHDB`s Redis, then loads `docker/test-graph/mocks` (both stores when the flag is omitted). **Never run it with a `--config-dir` that points at real data.** |
| `db migration new <NAME>` / `run` / `check` | see [Migration Manager](#migration-manager) |

```bash
# API + watcher + scheduled jobs; config from $HOME/.pubky-nexus/config.toml
cargo run -p nexusd
# Custom config directory
cargo run -p nexusd -- --config-dir="custom/config/folder"
# Run services individually, e.g. clear the DBs (destructive) before starting the watcher
# cargo run -p nexusd -- db clear --yes
cargo run -p nexusd -- watcher
cargo run -p nexusd -- api
```

`db mock` then runs `$CONTAINER_RUNTIME exec neo4j bash /test-graph/run-queries.sh`
(`CONTAINER_RUNTIME` defaults to `docker`). It needs a running container named exactly `neo4j`
with `./test-graph` mounted; the dev compose provides one.

## config.toml

Nexus reads only `<config-dir>/config.toml`. If missing, nexusd creates the directory and writes
the embedded
[`nexus-common/default.config.toml`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexus-common/default.config.toml)
as shipped. **Read that file for the full annotated key list**; it is not mirrored here.

- **Required:** `[stack]` with `log_level`, `files_path`, `[stack.db].redis`, and
  `[stack.db.neo4j]` `uri` + `password`.
- **Optional (defaulted):** `[api]`, `[watcher]`, `[jobs]`, `[trust_rank]`, `[stack.otlp]`,
  `[stack.net]`, `[stack.media]`.
- **Unknown keys are silently ignored** except in `[jobs.<name>]` and `[trust_rank]`
  (`deny_unknown_fields`). A typo or moved key raises no error.

### Change before production

| Key | Shipped value | Why |
| :-- | :-- | :-- |
| `[api].public_ip` | `127.0.0.1` | Advertised in the API's pkarr packet. Set the real public IP. |
| `[api].public_addr` / `pubky_listen_socket` | `127.0.0.1:8080` / `:8081` | Plain-HTTP bind (behind a reverse proxy) / HTTPS with Pkarr raw-public-key TLS. Loopback is unreachable from outside a container. |
| `[watcher].homeserver` | `8um71us3…d1dty` ("Synonym homeserver") | Primary HS. The in-code `HOMESERVER_PUBKY` (`8pinxxgq…35ewo`, testnet) applies only when `[watcher]` is absent. Always set it. |
| `[watcher].moderation_id` | `uo7jgkyk…n85ko` | A **test key**. Set your own moderator. |
| `[stack.db.neo4j].password` | `12345678` | Dev default |
| `[stack.otlp].endpoint` | commented out | Export off (see [Observability](#observability)) |

Both pubkeys are raw z-base-32, no `pubky` prefix; use that form. See
[public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

> **The API keypair is a secret.** `<config-dir>/secret` is the Nexus API identity, randomly
> generated if missing. By default the API publishes a pkarr packet (HTTPS/SVCB record on
> `public_ip` + TLS port, plus an A record) at startup and hourly. Back it up and restrict its
> permissions; losing it changes the Nexus pubky identity.

### [api]

- In a present `[api]` table only `public_ip`, `public_addr`, `pubky_listen_socket` are required.
- `request_timeout_secs` (default `30`) returns 408. Clamped with `.max(1)`: `0` means a 1 s
  timeout, **not** disabled.
- `max_body_size_bytes` defaults to 1 MiB.
- `[api.rate_limit]` is **off** by default. When on, `tower_governor` token buckets keyed by TCP
  peer IP: `default_bucket` (300/min, burst 50) for standard `/v0`, static and Swagger routes;
  `expensive_bucket` (20/min, burst 5) for high-cost routes. Refill period
  `max(60000/rate, 1)` ms; a bucket with `rate` or `burst` = `0` is skipped. Rejection: 429 +
  `Retry-After`.
  - **Enable `trust_proxy_headers` only behind a trusted proxy that overwrites
    `X-Forwarded-For` / `X-Real-IP`**, or clients can spoof their bucket key.

### [watcher]

- **Required in a present `[watcher]`:** `homeserver`, `events_limit` (1..=1000),
  `monitored_homeservers_limit`, `primary_hs_monitoring_interval_ms` (alias `watcher_sleep`),
  `moderation_id`, `moderated_tags`. With the table absent, `DEFAULT_EVENTS_LIMIT = 1000`; the
  shipped file sets `50`.
- **Defaulted:** `key_based_events_limit` 50 (1..=100); `external_hs_monitoring_interval_ms`
  5000; `hs_resolver_interval_ms` 10000 (alias `hs_resolver_sleep`); `hs_resolver_ttl` 3600000 ms;
  `initial_backoff_secs` / `max_backoff_secs` 60 / 3600; `retry_processor_interval_ms` 10000;
  `max_file_size`; all of `[watcher.retry]`.
- Any `*_interval_ms = 0` is a parse error.
- **Never set `initial_backoff_secs > max_backoff_secs`**: `HomeserverBackoff::new` panics.
- **`max_file_size` defaults to 100 MiB** (104857600, pubky-app-specs 0.7.0
  `max_blob_size_bytes`), **not** the 50 MiB older docs state. Oversized files are permanent
  failures, never retried. `[stack.net].pubky_http_request_timeout_secs` (default 300, nonzero,
  main-only) must be long enough to download a file that size.
- **`testnet` / `testnet_host` moved to `[stack.net]`** (#985). `testnet = true` under
  `[watcher]` still parses but is silently ignored on current binaries.
- `[stack.net].external_hs_pk_blacklist` blocks indexing and ingestion of users on the listed
  homeservers.

### [stack.db] and [stack.media]

- `[stack.db.neo4j].user` defaults to `neo4j`; Community Edition needs only the password.
- `slow_query_logging_threshold_ms`: unset = off, `0` = warn on every query, shipped `100`.
  `slow_query_logging_include_cypher` defaults to `false`.
- `ft_search_timeout_ms` (default 50) caps RediSearch `FT.SEARCH`, which returns **partial
  results** on timeout.
- **`[stack.media]` (main-only):** `max_concurrency` caps ImageMagick/ffmpeg subprocesses
  (default CPU count, min 4; config comments suggest cores/2); `process_timeout_secs` default 180.
  Both reject `0`. Keep `process_timeout_secs` below `request_timeout_secs` (else callers get a
  408) and below the 1 h temp-file sweep.

## Scheduled jobs

Registered: `trust-recompute`; `influencers-cache-{today,this-week,this-month}` (main-only);
`hot-tags-cache-{today,this-week,this-month,all-time}` (main-only). `nexusd jobs list` prints them.

- Configure as `[jobs.<name>]` with `cron` as the **only** key. `cron` is **seconds-first**:
  `sec min hour dom month dow [year]`, e.g. `"0 0 3 * * *"`.
- No `cron` = unscheduled, still runnable via `jobs run <name>`. Every cache job ships commented
  out.
- A `[jobs.<name>]` matching no registered job fails startup (`UnknownJobConfig`). **Before
  rolling back to an older binary, comment out newer job sections** (e.g. `9e20cbf` rejects
  `[jobs.hot-tags-cache-today]`).
- A Redis run lock (`LOCK_TTL_SECS` = 3600 + 60 s lease) serializes each job across processes, so
  multiple scheduled nexusd instances don't double-run it. The lease expires if a process crashes.

**`trust-recompute`** runs seeded personalized PageRank via the **Neo4j Graph Data Science (GDS)**
plugin. Before it works:

- **Set `[trust_rank].seed`.** It ships empty and the job refuses to run without it.
- **Install GDS.** Stock `neo4j:5.26` Community lacks it. Production Neo4j needs what the dev image
  has: the GDS jar (dev pins 2.13.10), `NEO4J_PLUGINS='["graph-data-science"]'`,
  `dbms.security.procedures.unrestricted=gds.*`, and a procedure allowlist.

Users' `trust` scores also order external-homeserver polling (main-only).

## Watcher: event ingestion

At startup the watcher calls `Homeserver::persist_if_unknown(homeserver)`, then runs four
independent periodic tasks, each on its own tokio interval with `MissedTickBehavior::Skip`:

| Task | Interval key | Does |
| :-- | :-- | :-- |
| primary-homeserver | `primary_hs_monitoring_interval_ms` | cursor-paged `/events/` from `[watcher].homeserver` |
| external-homeservers | `external_hs_monitoring_interval_ms` | per-user event streams from other homeservers |
| user-hs-resolver | `hs_resolver_interval_ms` | maps users to their homeserver |
| retry-processor | `retry_processor_interval_ms` | replays failed events |

A task error is logged and the loop continues. A task **panic** cancels its siblings after their
current iteration.

### Primary homeserver

```http
GET https://<homeserver>/events/?cursor=<cursor>&limit=<events_limit>
```

(`<homeserver>` is the homeserver's z-base-32 pubky. Verified against a local testnet homeserver:
newline-separated `PUT|DEL pubky://…` lines ending in `cursor: N`.)

- Body capped at 5 MiB, split into lines. `cursor: ` lines are extracted (position irrelevant,
  last one wins).
- The cursor is validated **before** any handler runs and persisted to Redis **only after the
  whole batch succeeds**. A shutdown mid-batch replays the batch on restart.
- A rejected cursor skips the batch and keeps the stored cursor. Alert on any sustained non-zero
  rate:
  - `watcher.primary_hs.cursor.invalid{hs_id}`: unparseable, would rewind, or advances on an empty
    batch.
  - `watcher.primary_hs.cursor.stalled{hs_id}`: events present but cursor doesn't advance, or no
    cursor line.
- A Redis infrastructure error fails the run rather than skipping the batch.
- Only events from users with no `HOSTED_BY` edge, or a non-stale `HOSTED_BY` to this homeserver,
  are indexed; others are skipped with a warning.
- **No per-HS backoff** for the primary homeserver.

### External homeservers

- **Targets** (from Neo4j): homeservers with non-deleted users on non-stale `HOSTED_BY` edges,
  ordered by summed user `trust` (main-only) then active user count, excluding the primary and
  blacklisted homeservers, truncated to `monitored_homeservers_limit`.
- **Fetch:** per user, one non-live SDK
  `event_stream_for(hs).add_users([(user, cursor)]).limit(key_based_events_limit).path("/pub/")`
  call, resuming from a per-user Redis cursor (`UserHsCursor`).
- **Timeouts:** 8 min per HS run; processor default 3600 s.
- **Safety checks:**
  - Any event cursor at or below the floor rejects the **whole** per-user batch
    (`EventCursorOutOfOrder`, `watcher.external_hs.cursor.out_of_order{hs_id}`).
  - An event owned by a different user is rejected (`UserIdMismatch`); the cursor doesn't advance.
- **Failures:** 429 is retried after 1, 2, 3 s, then fails `HsEventsStreamRateLimitExhausted`. A
  404 makes that user skip 1, 2, … up to 10 runs. A failed HS run applies per-HS backoff
  `min(initial_backoff_secs * 2^n, max_backoff_secs)`.

### User homeserver resolver

- Each tick selects non-deleted users with no `HOSTED_BY` edge or one older than `hs_resolver_ttl`.
- Resolves each user's published HS via PKDNS/DHT **sequentially** (parallel DHT resolution proved
  unreliable). PKARR itself: [`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution).
- New user → `(:User)-[:HOSTED_BY]->(:Homeserver)`. Match → clears `stale`. Changed or missing HS →
  mapping marked **stale**. **Switching homeservers is not implemented**: a user's bound homeserver
  never changes.

### Event dispatch

- **PUT:** blob fetched (capped at 2 MiB), validated with `PubkyAppObject::from_resource` (see
  [`app-specs.md`](../../pubky/references/app-specs.md)), routed to the user, post, follow,
  bookmark, tag or file handler. Tags pass a moderation check first.
- **DEL:** routed to the matching delete handler.
- **Mute PUT and DEL are ignored**; Nexus no longer handles mutes.
- **Moderation:** when `moderation_id` tags content with a label in `moderated_tags`, the target is
  de-indexed: a tag, user or file is removed; a post is hard-deleted if it has no edges and
  tombstoned otherwise (main-only, #971; `9e20cbf` calls `post::sync_del`).

### Retry queue

Redis prefix `RetryManagerV2` (sorted set `events` + JSON `state`).

- **Dropped, never enqueued or retried:** `InvalidEventLine`, `SkipIndexing`, `SpecValidation`,
  `HsBlacklisted`, `HsEventsStreamRateLimitExhausted`, `FetchSizeExceeded`, `UserIdMismatch`,
  `EventCursorOutOfOrder`; client 404, auth, build and parse errors.
- **Retried** with backoff `min(initial * 2^n, max)`, up to 100 ready events per tick:
  - `MissingDependency` from `initial_missing_dep_backoff_secs`, up to `max_dependency_retries`.
  - Other errors from `initial_backoff_secs`, up to `max_retries`.
- **Exhausted budget = dropped.** The entry is deleted from Redis (`store.remove`). There is **no
  dead-letter store** to inspect or replay.
- **Rescheduled without spending budget** (and the batch stops): Neo4j/Redis outages and
  `HsEventsStreamTransportFailed`.

### Redis is state, not just cache

The primary HS cursor lives **only in Redis**. If Redis loses the `Homeserver` key while Neo4j
keeps the node, `persist_if_unknown` re-seeds cursor `0` and the watcher **re-indexes that
homeserver from the start**. Restoring a lagging snapshot resumes from that snapshot's cursor.
**Run Redis with persistence** (the dev compose mounts `.database/redis/data`).

## Migration Manager

Phased data migrations across Neo4j and Redis. Status per migration is a
`(:Migration {id, phase, created_at, updated_at})` node. Phases:
`DualWrite → Backfill → Cutover → Cleanup → Done`.

| Phase | Meaning |
| :-- | :-- |
| DualWrite | Data layer calls `MigrationManager::dual_write::<T>(data)`. No handler runs. Waits until the id is added to `backfill_ready`. |
| Backfill | Copy old → new; afterwards new must be consistent with old. |
| Cutover | Reads switch to new. Redis: usually `RENAME` new key → old key. Graph: app-code change + removing `dual_write` calls. |
| Cleanup | Delete old keys / nodes. |

**`db migration run`:**

1. Sets **every** stored migration whose id is in `backfill_ready` to `Backfill`, whatever its
   current phase (DualWrite, Cutover, Cleanup or Done).
2. For each registered migration:
   - **Unstored:** MERGE at its initial phase. Multi-staged starts at `dual_write` and is skipped
     this run; single-staged starts at `backfill` and runs now.
   - **`Done`:** skip.
   - **Otherwise:** run the current phase's handler, then advance: multi-staged one step,
     single-staged straight to `Done`.

A multi-staged migration advances one phase per invocation **only after its id is removed from
`backfill_ready`**. Every migration registered at the pin is single-staged.

> **Bug (upstream #967): remove ids from `backfill_ready` as soon as their backfill finishes.**
> Step 1 resets a listed migration in **any** phase. A single-staged one re-runs its backfill on
> every `run`. A multi-staged one loops Backfill → Cutover forever and never reaches its cutover
> handler; `check` keeps reporting it pending while `run` makes no progress. For a listed `Done`
> migration, `check` says nothing is pending but `run` still re-runs it.

**`db migration check` is a deploy gate:** prints `<id> (<phase>)` per pending migration (`new` if
never stored) and exits `10`; with nothing pending prints `No pending migrations` and exits `0`;
config/DB errors exit `1`.

```bash
nexusd --config-dir /etc/pubky-nexus db migration check
case $? in
  0)  echo "no pending migrations" ;;
  10) echo "pending migrations: run 'nexusd --config-dir /etc/pubky-nexus db migration run'"; exit 1 ;;
  *)  echo "migration check failed (config/DB error)"; exit 1 ;;
esac
```

### Migration config (separate file)

- Path: `<config-dir>/migrations/config.toml` (default `~/.pubky-nexus/migrations/config.toml`).
  **At `9e20cbf` it is always `$HOME/.pubky-nexus/migrations/config.toml`; `--config-dir` is
  ignored.**
- Auto-created from the embedded `nexusd/src/migrations/default.config.toml`. The README points at
  that template; **edit the runtime copy**.
- Holds `backfill_ready = [ids]` plus a **full, independent `[stack]`** (`log_level = "debug"`,
  otlp name `nexusd.migration`, its own `[stack.db]`). **Point its Redis and Neo4j at the same
  databases as `config.toml`.**
- The loader **panics** on a parse error.

### Adding a migration

```bash
cargo run -p nexusd -- db migration new TagCountsReset

cargo run -p nexusd -- db migration run
```

1. **Scaffold** from the **repo root** (`MIGRATION_PATH` is relative; no DB or config needed).
   Writes `nexusd/src/migrations/migrations_list/<snake_name>_<unix_ts>.rs` and appends
   `pub mod …;` to `migrations_list/mod.rs`.
2. **Register** `Box::new(YourStruct)` in the vec in `import_migrations`
   (`nexusd/src/migrations/mod.rs`). Unregistered migrations never run.
3. **Implement** the `Migration` trait (`#[async_trait]`): `id() -> &'static str`,
   `is_multi_staged() -> bool` (`false` = only backfill runs), associated
   `dual_write(data: Box<dyn Any + Send + 'static>)` (`where Self: Sized`), and `backfill`,
   `cutover`, `cleanup`, all returning `Result<(), DynError>`. Definition and phase docs:
   [`manager.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexusd/src/migrations/manager.rs).
   The README's `/examples/migration.rs` does not exist; copy a real file instead, e.g. the
   single-stage
   [`users_by_pk_reindex_1751635096.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexusd/src/migrations/migrations_list/users_by_pk_reindex_1751635096.rs)
   (no-op `dual_write` / `cutover` / `cleanup`; `backfill` does the work).

## Observability

- **Export:** setting `[stack.otlp].endpoint` (e.g. `"http://localhost:4317"`) enables OTLP/gRPC
  export of **traces, logs and metrics** (exporter timeout 3 s, metrics every 30 s).
  `service.name` = `[stack.otlp].name` (wins over conflicts); optional
  `[stack.otlp.resource_attributes]` are added.
- **Without an endpoint:** logs go to stdout (compact); metrics are disabled.
- **Log filtering (both modes):** `RUST_LOG` (an `EnvFilter`) overrides `log_level`. Noisy crates
  are capped; pkarr/pubky/mainline are capped unless `log_level = "trace"`.

**Local stack** (`docker/docker-compose.observability.yml`, separate from the DB compose):
otel-collector (4317 gRPC / 4318 HTTP) → Tempo (traces), Prometheus (`:9090`, 24 h retention,
remote-write), Loki (`:3100`); Grafana on `:3000`. SigNoz also works: point `endpoint` at its OTLP
port (dashboard `http://localhost:3301`).

> **Grafana runs anonymous Admin with no login form.** Localhost only; **never expose this compose
> file as-is.**

```bash
docker compose -f docker/docker-compose.observability.yml up -d

curl -X POST http://localhost:9090/-/reload

docker run --rm -v "$PWD/docker/otel:/rules:ro" --entrypoint promtool prom/prometheus:v2.55.1 check rules /rules/alerts.yaml
```

Run from the repo root (the promtool mount needs a path Docker Desktop shares).

- Alert rules: `docker/otel/alerts.yaml`; override with `PROMETHEUS_ALERTS_FILE` in `docker/.env`
  (relative to `docker/`; mount is main-only). Shipped: `NexusNeo4jQueryErrors`
  (`sum(rate(neo4j_query_errors_total[5m])) > 0` for 5m) and `NexusWatcherCursorStalled`
  (`increase(watcher_primary_hs_cursor_stalled_total[15m]) > 0`).
- Prometheus remote-write turns dotted OTLP names into underscores, appends `_total` to counters,
  and maps `service.name` to the `service_name` label.

**Metrics worth alerting on.** Instrument names are unstable and drift between builds; confirm
against the source (`global::meter` call sites, e.g.
[`user_hs_resolver.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexus-watcher/src/service/user_hs_resolver.rs),
[`graph/instrumented.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexus-common/src/db/graph/instrumented.rs))
for the binary you run.

| Meter | Instruments (at the pin) |
| :-- | :-- |
| `nexus.watcher` | `watcher.primary_hs.cursor.{invalid,stalled}{hs_id}`, `watcher.external_hs.cursor.out_of_order{hs_id}`, `watcher.fetch.rejected{reason}`; gauges `watcher.external_hs.{monitored_limit,indexed}` (main-only; indexed/limit = 1 means the cap binds) |
| `hs-resolver-meter` | `nexus.task.hs-resolver.{total,failed}`; main-only: `.resolutions{outcome,mapping}`, `.marked_stale{reason}`, gauges `mapped_users`, `stale_users`, `heartbeat_timestamp` |
| `neo4j` | `neo4j.query.{duration,execute_duration,rows,errors,slow}`; `neo4j.query.requests` main-only |
| `nexus` | `http.rate_limit.rejected.total{bucket}`; main-only: `http.server.requests`, `http.server.request.duration` |
| `nexus.jobs` / `nexus.trust` / `nexus.media` | `jobs.run.{attempts,completed,skipped}`, `jobs.scheduler.stopped`, `jobs.lock.{operations,duration}`, `trust.recompute.max_iterations_reached`; `media.subprocess.timeout` main-only |

Watcher trace spans: `event_processor.run`, `events.poll`, `event_batch.process`, `event.process`
(attrs `event.uri`, `event.type`, `event.user_id`, `otel.status_code`;
`otel.status_message = SKIPPED` marks filtered events), `dx.users.resolve`,
`dx.user_events.process`, `moderation.apply`.

## Deploying

**Production image** (repo `Dockerfile`): builds on `rust:1.91.0-alpine3.22` with static OpenSSL
(`cargo build --release --bin nexusd`, stripped); runtime `alpine:3.22` with `ca-certificates` and
imagemagick + webp/heic/svg/jpeg/tiff/raw plugins (needed for media transcoding).

- **No `ENTRYPOINT`.** It sets `WORKDIR /usr/local/bin` and `CMD ["nexusd"]` (API + watcher +
  jobs). Overriding the command replaces `nexusd`, so name it explicitly:
  `docker run IMAGE nexusd --config-dir=/config db migration check` (pubky-docker uses
  `command: nexusd --config-dir=/config`).
- **Without `--config-dir`** the config dir is `$HOME/.pubky-nexus` = `/root/.pubky-nexus`.
- **Only `8080` is `EXPOSE`d.** Publish `pubky_listen_socket` (8081) yourself to serve Pkarr TLS.
- **In a container,** bind `public_addr` / `pubky_listen_socket` to a non-loopback address and
  mount `<config-dir>` (holds `config.toml`, `secret`, `migrations/`).

**Dev dependencies** (`docker/docker-compose.yml`) are databases only; **`nexusd` is not
included.** Neo4j `pubky-nexus/neo4j:5.26.27-gds2.13.10` (built locally from `docker/neo4j` on
first `up`, so slow; 7474 browser, 7687 bolt; pagecache 1G, heap 2G), `redis:8.0.6-alpine` (6379),
RedisInsight (5540). Postgres 18 (5432) only with `--profile tests`. All ports bind `127.0.0.1`.

```bash
cd docker
cp .env-sample .env

# Lean stack: Neo4j + Redis + Redis Insight
docker compose up -d

# With Postgres (for watcher tests)
docker compose --profile tests up -d
```

> **Neo4j Community Edition:** DB name and username must both be `neo4j`; `.env-sample` password
> is `12345678`. Changing `NEO4J_AUTH` after data exists has no effect. The compose comment says to
> reset with `docker compose down -v`, but data is **bind-mounted** under
> `docker/.database/neo4j/{conf,data,logs}` and `down -v` doesn't delete bind mounts, so a real
> reset probably also requires deleting those directories (not confirmed upstream).

**Local UIs:** Swagger `http://localhost:8080/swagger-ui` (OpenAPI at
`/api-docs/v0/openapi.json`); RedisInsight `http://localhost:5540/0/browser` (accept TOS on first
run); Neo4j Browser `http://localhost:7474/browser/`.

For Nexus with a homeserver, relays and the app as one stack, see
[`local-stack.md`](local-stack.md) (pubky-docker).

**Example binaries:** `cargo run --bin api_example [-- --config=<dir>]` and `watcher_example` read
`api-config.toml` / `watcher-config.toml`, a **flattened** layout (top-level keys + `[rate_limit]`
/ `[retry]`), not daemon `[api]` / `[watcher]` tables. A missing or unparseable file silently falls
back to `<dir>/config.toml`. Don't copy `NexusWatcher::start_from_path(path)` /
`builder().run()` from `nexus-watcher/README.md`; the real signatures are
`start_from_path(config_dir, shutdown_rx)` and `NexusWatcherBuilder::start(shutdown_rx)`.

## Tests

> **`db mock` wipes the configured Neo4j graph and `FLUSHDB`s Redis first.** Run it only against the
> local dev compose databases.

```bash
cargo run -p nexusd -- db mock
cargo nextest run -p nexus-common --no-fail-fast
cargo nextest run -p nexus-webapi --no-fail-fast
cargo nextest run -p nexusd --no-fail-fast
TEST_PUBKY_CONNECTION_STRING='postgres://test_user:test_pass@localhost:5432/postgres?pubky-test=true' \
  cargo nextest run -p nexus-watcher --no-fail-fast
cargo bench -p nexus-webapi
```

Commands match upstream CI; the suites were not executed here. `nexus-watcher` tests need Postgres
(`docker compose --profile tests up -d`); `nexusd` trust-rank tests need the Neo4j image with GDS.

## Upstream references

- [pubky-nexus README](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/README.md) (pinned) ·
  [releases](https://github.com/pubky/pubky-nexus/releases)
- [`default.config.toml`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexus-common/default.config.toml): every config key, annotated
- [`nexusd/src/cli.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexusd/src/cli.rs) ·
  [`migrations/manager.rs`](https://github.com/pubky/pubky-nexus/blob/794a6e103b46/nexusd/src/migrations/manager.rs) ·
  [`migrations_list/`](https://github.com/pubky/pubky-nexus/tree/794a6e103b46/nexusd/src/migrations/migrations_list)
- [`9e20cbf...794a6e1` compare](https://github.com/pubky/pubky-nexus/compare/9e20cbff89f6...794a6e103b46): what main-only means
- Hosted Swagger (`/v0`, unstable): [production](https://nexus.pubky.app/swagger-ui/) ·
  [staging](https://nexus.staging.pubky.app/swagger-ui/)
- Canonical (don't restate): [`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) ·
  [`app-specs.md`](../../pubky/references/app-specs.md) ·
  [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md) ·
  [`nexus-api.md`](../../pubky/references/nexus-api.md)
