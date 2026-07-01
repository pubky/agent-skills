# Operate the Nexus indexer

Nexus is the **read aggregator / indexer** for the Pubky social graph: it ingests homeserver
event streams into a Neo4j graph + Redis cache and serves a read-only `/v0` REST API. It
**never accepts content writes** — clients write to their homeserver, then read aggregated data
from Nexus. The protocol model behind this split is canonical in
[`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) — read it
first; this file is operations only. To **consume** the hosted `/v0` API, see
[`nexus-api.md`](../../pubky/references/nexus-api.md).

> **Pre-1.0, drift-prone.** The `/v0` REST API is unstable and breaking-change-prone, and the
> `/pub` path layout the watcher parses is not stabilized. Rate limiting (below) is part of that
> unstable `/v0` stack. Treat any version-pinned or API-shape claim here as drift-prone and
> confirm against the linked upstream. Canonical guardrail:
> [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).

Versions/identifiers below are from one pinned commit of
[`pubky-nexus`](https://github.com/pubky/pubky-nexus); confirm against upstream before relying
on them.

## Architecture

Four crates:

| Crate | Role |
| :-- | :-- |
| `nexus-webapi` | the REST API server (README also calls it "nexus-service") |
| `nexus-watcher` | event aggregator — ingests homeserver events into the social graph |
| `nexus-common` | shared lib: DB connectors, models, queries, config |
| `nexusd` | orchestrator binary — runs the components and performs DB migrations/reindexing |

Backing stores: **Neo4j** (the social graph) + **Redis** (cache, with RediSearch FT indexes).
The graph/cache split and the homeserver → Nexus indexing model are canonical in
[`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) — don't
restate.

## Run it

The daemon is the `nexusd` crate; its CLI is named `pubky-nexus`. A global `--config-dir` / `-c`
flag (default `$HOME/.pubky-nexus`) names the directory that must contain `config.toml`. Run
from source with `cargo run -p nexusd`; the built binary is `nexusd`.

```bash
# Run both API + Watcher (default — no subcommand)
cargo run -p nexusd

# Run components individually
cargo run -p nexusd -- watcher
cargo run -p nexusd -- api

# Custom config directory
cargo run -p nexusd -- --config-dir="custom/config/folder"

# Wipe the databases before a fresh watcher run
cargo run -p nexusd -- db clear
```

Subcommands (each also accepts its own `--config-dir`):

| Command | Does |
| :-- | :-- |
| _(none)_ | hidden default `run` — starts **both** API and Watcher concurrently via `try_join!` sharing one shutdown channel, blocking until one errors or Ctrl-C |
| `api` | run the REST API service only |
| `watcher` | run the event watcher only |
| `db` | database operations (see below) |

Two standalone **example binaries** run the API and watcher individually against an existing
Neo4j/Redis: `cargo run --bin api_example` and `cargo run --bin watcher_example`, each taking an
optional `--config=<dir>` (expecting `api-config.toml` / `watcher-config.toml`; a default
`config.toml` is created if absent). The api example serves on `localhost:8081`.

> **Example config has a different shape from the daemon.** The example `api-config.toml` is
> *flattened* — top-level `public_ip` / `public_addr` / … and a bare `[rate_limit]` table, **not**
> `[api]` / `[api.rate_limit]`. Don't reuse a daemon `config.toml` for the example binaries.

### db subcommands

| Command | Does |
| :-- | :-- |
| `db clear` | wipe the databases (`MockDb::clear_database`) |
| `db mock [--mock-type redis\|graph]` | load mock test data (default `both` when `--mock-type` omitted; the flag itself accepts only `redis` or `graph`) |
| `db migration new <NAME>` | scaffold a new migration (NAME required) |
| `db migration run` | run all pending migrations, advancing phases |

## config.toml

`config.toml` is read from the `--config-dir` directory (default `$HOME/.pubky-nexus/`). On
startup nexusd **creates the directory and writes a default `config.toml`** from the embedded
template (`include_str!` of `nexus-common/default.config.toml`) if absent, then parses it. Three
top-level tables: `[api]` and `[watcher]` are omittable; `[stack]` (with `[stack.otlp]`,
`[stack.db]`, `[stack.db.neo4j]`) is required.

The shipped default — the verbatim file an operator edits (note OTLP `endpoint` is commented
out, so observability is **off by default**, and `[api.rate_limit]` ships disabled):

```toml
[api]
public_ip = "127.0.0.1"
public_addr = "127.0.0.1:8080"
pubky_listen_socket = "127.0.0.1:8081"
request_timeout_secs = 30
max_body_size_bytes = 1048576

[api.rate_limit]
# Enable rate limiting (disabled by default for permissiveness behind NATs)
enabled = false
# Trust forwarded-IP headers (X-Forwarded-For / X-Real-IP) for real-IP extraction.
# Only enable behind a known reverse proxy — clients can spoof these headers otherwise.
# trust_proxy_headers = false
# Default bucket for standard endpoints (300 req/min, burst 50)
[api.rate_limit.default_bucket]
rate = 300
burst = 50
# Expensive bucket for high-cost endpoints (20 req/min, burst 5)
[api.rate_limit.expensive_bucket]
rate = 20
burst = 5

[watcher]
testnet = false
testnet_host = "localhost"
homeserver = "8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty"
events_limit = 50
monitored_homeservers_limit = 50
watcher_sleep = 5000
initial_backoff_secs = 60
max_backoff_secs = 3600
max_file_size = 52428800
moderation_id = "uo7jgkykft4885n8cruizwy6khw71mnu5pq3ay9i8pw1ymcn85ko"
moderated_tags = [
    "hatespeech",
    "harassement",
    "terrorism",
    "violence",
    "illegal_activities",
    "il_adult_nu_sex_act",
]

[stack]
log_level = "info"
files_path = "~/.pubky-nexus/static/files"

[stack.otlp]
name = "nexusd"
#endpoint = "http://localhost:4317"

[stack.db]
redis = "redis://127.0.0.1:6379"
#ft_search_timeout_ms = 50

[stack.db.neo4j]
uri = "bolt://localhost:7687"
#user = "neo4j"
password = "12345678"
slow_query_logging_threshold_ms = 100
#slow_query_logging_include_cypher = false
```

Field semantics that change behavior (the full field list is the verbatim default above):

**`[api]`** — `public_ip` (IP advertised outward, default `127.0.0.1`); `public_addr` (ICANN/HTTP
bind socket for a reverse proxy / DNS-TLS, default `127.0.0.1:8080`); `pubky_listen_socket`
(HTTPS PubkyTLS bind socket, default `127.0.0.1:8081`); `request_timeout_secs` (default `30`) —
`0` is clamped up to a 1 s timeout via `.max(1)`, so the effective minimum is 1 s and `0` does
**not** disable the API (the `api.rs` doc comment about "taking the API offline" is the rationale
*for* the clamp, not current behavior); `max_body_size_bytes` (default `1048576` = 1 MiB);
`[api.rate_limit]` (optional, whole table omittable; off by default) — see
[API rate limiting](#api-rate-limiting). Within a *present* `[api]` table only `public_ip`,
`public_addr`, `pubky_listen_socket` are required — the rest carry field defaults.

**`[watcher]`** — `events_limit` (max events fetched per run per homeserver);
`monitored_homeservers_limit` (default `50`; set to **`1` to monitor only the default
homeserver**); `watcher_sleep` (ms between full runs, default `5000`); `initial_backoff_secs`
(`60`) / `max_backoff_secs` (`3600`); `max_file_size` (bytes, default `52428800` = 50 MiB —
**oversized files are permanent failures, not retried**); `moderation_id` + `moderated_tags`
(see [Content moderation](#content-moderation)).

**`[stack]`** — `log_level` (`error|warn|info|debug|trace`, default `info`); `files_path`
(where ingested static files are stored).

- `[stack.otlp]` — `name` (OpenTelemetry service name; `"nexusd"` in the shipped config) and
  optional `endpoint` (unset = export off; point at an OTLP collector e.g.
  `http://localhost:4317` to enable). See [Observability](#observability-opentelemetry-and-signoz).
- `[stack.db]` — `redis` (URL, default `redis://127.0.0.1:6379`); `ft_search_timeout_ms`
  (default `50`) caps RediSearch `FT.SEARCH` execution time, returning **partial results**.
- `[stack.db.neo4j]` — `uri` (default `bolt://localhost:7687`); `user` (default `neo4j`; **not
  needed in Community Edition**); `password`; `slow_query_logging_threshold_ms`
  (`Option<u64>`, default `None` = disabled; the shipped config sets `100`; the migration config
  leaves it commented, disabled for CLI commands); `slow_query_logging_include_cypher` (default
  `false`).

> **Two `events_limit` defaults.** The shipped `config.toml` sets `events_limit = 50`, but the
> code constant `DEFAULT_EVENTS_LIMIT = 1000` applies only when the **whole `[watcher]` section
> is absent** (the field has no `#[serde(default)]`; a present `[watcher]` missing just this line
> fails to parse rather than falling back to `1000`). Only `initial_backoff_secs`,
> `max_backoff_secs`, `max_file_size`, and `stack` carry field defaults — the other `[watcher]`
> fields are required when the table is present. A fresh install gets the full default file
> written verbatim, so **50 is the effective shipped default** — but be aware of both.

> **Don't hardcode the default homeserver pubky.** The shipped config's `homeserver`
> (`8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty`, "Synonym homeserver") differs from the
> in-code `HOMESERVER_PUBKY` default (`8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`,
> "Testnet homeserver", used only by `WatcherConfig::Default` when `[watcher]` is absent). The
> disk value wins for a fresh install. Treat neither as a stable identity to hardcode — set it
> for your deployment.

## API rate limiting

`nexus-webapi` ships an optional [`tower_governor`](https://docs.rs/tower_governor) token-bucket
rate limiter, wired into the **live router** (not just a config struct): the builder passes
`api_config.rate_limit` into `app_routes()`, which applies a `GovernorLayer` to two route groups
via `apply_rate_limit_default` / `apply_rate_limit_expensive`. It is **off by default**
(`enabled = false`) — permissive so deployments behind NATs / shared IPs don't throttle
legitimate clients. It is part of the unstable `/v0` stack
([guardrail](../../pubky/references/shipped-vs-planned.md)).

**Two buckets** (each its own `GovernorLayer`; the two routers are merged):

| Bucket | Default | Covers |
| :-- | :-- | :-- |
| `default_bucket` | 300 req/min, burst 50 | standard `/v0` routes + static-file routes + Swagger/OpenAPI docs |
| `expensive_bucket` | 20 req/min, burst 5 | high-cost `/v0` + static endpoints |

Token bucket: refill period = `60_000 / rate` ms (min 1 ms), burst size = `burst`. A background
task calls `retain_recent()` every 60 s to evict idle keys.

**No-op conditions.** When `enabled = false` *both* apply functions return the router unchanged
(a true no-op, zero overhead). A bucket with `rate == 0` or `burst == 0` is also skipped.

**Keying (security-sensitive).**

- `trust_proxy_headers = false` (default) → key on the real **TCP peer IP**
  (`PeerIpKeyExtractor`).
- `trust_proxy_headers = true` → key on forwarded headers `X-Forwarded-For` / `X-Real-IP`
  (`SmartIpKeyExtractor`).

> **Only enable `trust_proxy_headers` behind a known reverse proxy.** Direct-to-internet clients
> can forge `X-Forwarded-For` / `X-Real-IP` to dodge their own limit or pin it on another IP.
> Enable it only when a trusted proxy that overwrites those headers sits in front of the API.

**On limit exceeded:** HTTP `429 Too Many Requests` with a `Retry-After` header (seconds), plus
a metric increment — meter `nexus`, `u64` counter `http.rate_limit.rejected.total`, tagged
`bucket = "default" | "expensive"`. See [Observability](#observability-opentelemetry-and-signoz).

## Dev dependencies (Neo4j and Redis)

The repo's `docker/docker-compose.yml` provisions **dev dependencies only — not `nexusd`
itself**: `neo4j:5.26.27-community` (7474 browser + 7687 bolt), `redis:8.0.6-alpine` (6379),
`redis/redisinsight:3.0.3` (5540), and `postgres:18-alpine` (5432) — an **active** service (with
a `pg_isready` healthcheck), only needed for tests that involve homeservers (the sole
commented-out service is `jaeger`). All ports bind to `127.0.0.1`. Run `nexusd` separately
(cargo, or its own container).

```bash
cd docker
cp .env-sample .env
docker compose up -d
```

> **Neo4j Community Edition gotchas.** The database name and username must both be `neo4j` (the
> `.env` defaults) — Community Edition allows no custom name/user. **Changing `NEO4J_AUTH` after
> the config/data volumes already exist has no effect** — you must `docker compose down -v` to
> reset. The `.env-sample` default password is `12345678`. Memory is preset (pagecache 1G, heap
> 2G) and telemetry disabled.

The Postgres credentials in `.env-sample` (`POSTGRES_USER=test_user`,
`POSTGRES_PASSWORD=test_pass`, `POSTGRES_DB=postgres`, port `5432`, and
`TEST_PUBKY_CONNECTION_STRING=postgres://test_user:test_pass@localhost:5432/postgres?pubky-test=true`)
exist solely for the `nexus-watcher` test suite.

Local UIs when running against the dev stack:

| UI | URL | Note |
| :-- | :-- | :-- |
| Swagger (nexus API) | `http://localhost:8080/swagger-ui` | the `/v0` surface |
| Redis Insight | `http://localhost:5540/0/browser` | accept the TOS popup on first run |
| Neo4j Browser | `http://localhost:7474/browser/` | |
| Signoz | `http://localhost:3301` | only if observability is enabled |

Hosted Swagger UIs are the source of truth for the unstable `/v0` surface:
[staging](https://nexus.staging.pubky.app/swagger-ui/) ·
[production](https://nexus.pubky.app/swagger-ui/). For running `nexusd` alongside a homeserver,
relays, and DNS as one orchestrated deployment, use the
[`pubky-docker`](https://github.com/pubky/pubky-docker) stack — see
[`local-stack.md`](local-stack.md) — since this repo's compose file only provisions Nexus's
databases.

## Production image

The repo `Dockerfile` is a multi-stage build on `rust:1.90.0-alpine3.22` with static OpenSSL
(`OPENSSL_STATIC=yes`, `cargo build --release --bin nexusd`, then stripped). The runtime stage is
`alpine:3.22` with `ca-certificates` plus **imagemagick and codec plugins** (webp, heic, svg,
jpeg, tiff, raw) — required to transcode ingested image files. The binary lands at
`/usr/local/bin/nexusd`. `EXPOSE 8080`, `CMD ["nexusd"]` (i.e. runs both API + Watcher by
default).

## The watcher: event ingestion

The watcher polls each homeserver's events endpoint with a persisted cursor and the configured
`events_limit`; the response body is trimmed and split into newline-separated lines, and a line
beginning `cursor: ` updates the stored cursor for the next request.

```http
GET https://<homeserver-pubky>/events/?cursor=<cursor>&limit=<events_limit>
```

The **homeserver event-stream contract itself** (paginated `GET /events/`, cursor + Blake3 hash,
the `GET /events-stream` SSE variant) is canonical in
[`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) — link, don't
restate.

**Ingestion flow.** The main loop ticks every `watcher_sleep` ms (a tokio interval) and runs
`run_all` over all monitored homeservers. For each homeserver it polls `/events/`, then per line:

- a `cursor: ` line **persists the new cursor** (`Homeserver::try_from_cursor(...).put_to_index()`);
- a **PUT** event fetches the resource blob from the author's homeserver, validates it with
  pubky-app-specs, and dispatches to a per-type handler (user / post / follow / bookmark / tag /
  file) that writes to **Neo4j + Redis**;
- a **DEL** event removes the corresponding node;
- **mute events are no longer handled** — `events/mod.rs` logs "Mute events are no longer handled
  by nexus" and silently skips both PUT and DEL `Mute` resources (no mute handler exists; the
  `RemoveMuted1771718400` migration tears down legacy muted data);
- tag PUTs are checked against moderation before indexing.

**Multi-homeserver.** On startup the watcher calls `Homeserver::persist_if_unknown` for its
configured `homeserver`, then each run `homeservers_by_priority()` reads all homeservers from the
graph and moves the configured default to index 0 so it is processed first. The list is then
truncated to `monitored_homeservers_limit` (set `1` to watch only the default). Backoff state is
updated per homeserver after each run.

**Per-homeserver exponential backoff.** On failure a homeserver is **Skipped** for
`min(initial_backoff_secs * 2^failures, max_backoff_secs)` — with defaults 60 s, 120 s, 240 s, …
capped at 3600 s. A successful run clears the state (next failure restarts at initial). Backoff is
tracked independently per homeserver. `HomeserverBackoff::new` **panics if
`initial_backoff_secs > max_backoff_secs`** — that's the config-validation guard, so don't invert
them. There is also a hard per-homeserver processing timeout: `PROCESSING_TIMEOUT_SECS = 3_600`
(each processor run is wrapped in `tokio::time::timeout`, surfacing `Timeout` in run stats
alongside `Ok` / `Error` / `Panic` / `Skipped`).

**Fetch size caps and retry classification.** Caps: events-response body `MAX_EVENTS_BODY` =
5 MiB; per-resource (user/post/tag/file-meta) `MAX_RESOURCE_SIZE` = 2 MiB; error-body truncation
`MAX_ERROR_BODY` = 4 KiB; file content = `max_file_size` config (50 MiB default). `fetch_capped`
enforces caps first by a Content-Length precheck, then by streaming via `read_stream_capped` with
a running byte count (catching a lying/missing Content-Length), returning `FetchSizeExceeded` on
violation. Error classification matters:

- **`FetchSizeExceeded`, `SpecValidation`, `InvalidEventLine`** are **PERMANENT** failures —
  returned as `None`, **not enqueued** (they would re-fail identically and poison the retry
  queue). `FetchSizeExceeded` also increments the `watcher.fetch.rejected` counter.
- All other errors are enqueued to a Redis retry index keyed `{event_type}:{compressed-index}`.

### Content moderation

The watcher trusts **one** moderator pubky (`moderation_id`). When that user (`tagger_id == id`)
places a tag whose label is in `moderated_tags`, the watcher **de-indexes** the target
(`Moderation::apply_moderation`) instead of indexing the tag — a tag-storage URI does `tag::del`,
otherwise the parsed URI deletes the `Post` / `Tag` / `User` / `File`. Default `moderated_tags`:
`hatespeech`, `harassement`, `terrorism`, `violence`, `illegal_activities`, `il_adult_nu_sex_act`.
Both the moderator key and the tag list are operator-configurable in `[watcher]`.

> **The shipped `moderation_id` is a test key.** The default
> `uo7jgkykft4885n8cruizwy6khw71mnu5pq3ay9i8pw1ymcn85ko` (`DEFAULT_MODERATION_ID`) is a test
> identity — set your own moderator pubky for any real deployment, or moderation is effectively
> inert.

## The Migration Manager

The Migration Manager coordinates **phased data migrations across Neo4j + Redis** during
breaking data-source changes, with minimal app disruption. It tracks each migration's status as
a `Migration` node in Neo4j (`id`, `phase`, `created_at`, `updated_at` — the timestamps use Neo4j
`timestamp()`) via `MERGE` Cypher and advances phases automatically on each `db migration run`.

**Phases** (`enum MigrationPhase`, serde `snake_case`, ordered): `DualWrite → Backfill → Cutover
→ Cleanup → Done`. `next()` advances one step (`Done → None`).

1. **Dual Write** — mirror all writes old → new source for consistency during normal operation;
   the data layer calls `MigrationManager::dual_write`. Mark ready to advance via the
   `backfill_ready` list in the migration config.
2. **Backfill** — copy missing/historical data old → new (the most important phase; new must be
   consistent with old afterward).
3. **Cutover** — the app starts reading from the new source — for Redis often a `RENAME` of the
   new key to the old key name; for the graph, change app-layer code and remove `dual_write`
   calls.
4. **Cleanup** — delete old Redis keys / Neo4j nodes no longer needed.

**Single- vs multi-stage** (`is_multi_staged()`): returning `true` runs the full
`DualWrite → … → Done` sequence (initial stored phase `DualWrite`, advancing via `phase.next()`);
returning `false` is a single-stage migration that runs **only** `Backfill` then jumps straight
to `Done` (initial stored phase `Backfill`). On `db migration run`: migrations listed in
`backfill_ready` are first advanced from `DualWrite` to `Backfill`; new migrations are stored;
migrations already at `Done` are skipped; the handler for the current phase runs, then advances.

Each migration file implements the `Migration` trait:

```rust
#[async_trait]
pub trait Migration {
    fn id(&self) -> &'static str;
    /* multi-staged -> full phase sequence; false -> backfill-only */
    fn is_multi_staged(&self) -> bool;
    /* write data to the new source (called from the app data layer) */
    async fn dual_write(data: Box<dyn Any + Send + 'static>) -> Result<(), DynError>
    where
        Self: Sized;
    /* copy data old -> new; new must be consistent with old after this */
    async fn backfill(&self) -> Result<(), DynError>;
    /* app starts reading from new source (e.g. Redis RENAME new->old) */
    async fn cutover(&self) -> Result<(), DynError>;
    /* delete old nodes/keys no longer needed */
    async fn cleanup(&self) -> Result<(), DynError>;
}
```

### Migration config (its own file)

The Migration Manager uses its **own** config, separate from nexusd's: at runtime it
loads/creates **`~/.pubky-nexus/migrations/config.toml`** (`MIGRATIONS_CONFIG_DIR =
".pubky-nexus/migrations"`), auto-created from the embedded
`nexusd/src/migrations/default.config.toml` if absent. It holds `backfill_ready = [ ... ]`
(migration ids to advance to `Backfill`) plus a `[stack]` block (`log_level = "debug"`,
`files_path = "./static/files"`, `[stack.otlp]` name `nexusd.migration`, `[stack.db]`,
`[stack.db.neo4j]` with slow-query logging commented out).

> **Edit the home-dir copy, not the source tree.** The README's parenthetical naming
> `nexusd/src/migrations/config.toml` points at the in-repo **template**
> (`default.config.toml`). At runtime the loader uses `~/.pubky-nexus/migrations/config.toml` —
> editing `backfill_ready` means editing that home-dir file, not a file inside the source tree.

### Adding a migration

```bash
# Scaffold a new migration (creates the file + appends the module declaration)
cargo run -p nexusd -- db migration new TagCountsReset

# Run all pending migrations, advancing phases as needed
cargo run -p nexusd -- db migration run
```

1. `db migration new <Name>` scaffolds
   `nexusd/src/migrations/migrations_list/<snake_name>_<unix_ts>.rs` and appends
   `pub mod <file>;` to `migrations_list/mod.rs`.
2. **Register it** in `import_migrations` in `nexusd/src/migrations/mod.rs` — every migration
   must be added to this vec to run:

```rust
pub fn import_migrations(migration_manager: &mut MigrationManager) {
    let migrations: Vec<Box<dyn Migration>> = vec![
        // Note: Add your migrations here to be picked up by the manager
        Box::new(UsersByPkReindex1751635096),
        Box::new(RemoveMuted1771718400),
        Box::new(ResourceNodeSetup1774000000),
        Box::new(PostContentIndexSetup1780444800),
        Box::new(PostContentIndexAuthorSetup1780531200),
    ];
    for migration in migrations {
        migration_manager.register(migration);
    }
}
```

3. Implement the `dual_write` / `backfill` / `cutover` / `cleanup` phases in the generated file.

A real single-stage migration (`UsersByPkReindex1751635096`) is the canonical template —
`is_multi_staged` returns `false`, `dual_write`/`cutover`/`cleanup` are no-ops, and the real work
lives in `backfill`. (The README's reference to `/examples/migration.rs` is **stale** — that file
does not exist; `examples/` holds only `api/`, `watcher/`, `Cargo.toml`, `README.md`. Copy a real
file under `migrations_list/` instead.)

```rust
pub struct UsersByPkReindex1751635096;

#[async_trait]
impl Migration for UsersByPkReindex1751635096 {
    fn id(&self) -> &'static str {
        "UsersByPkReindex1751635096"
    }

    fn is_multi_staged(&self) -> bool {
        false
    }

    async fn dual_write(_data: Box<dyn std::any::Any + Send + 'static>) -> Result<(), DynError> {
        Ok(())
    }

    async fn backfill(&self) -> Result<(), DynError> {
        let mut users_details = vec![];
        for user_id in get_all_user_ids().await? {
            match UserDetails::get_by_id(&user_id).await {
                Ok(Some(details)) => users_details.push(details),
                Ok(None) => tracing::warn!("No UserDetails for {user_id}"),
                Err(e) => tracing::warn!("Failed to reindex UserDetails for {user_id}: {e}"),
            }
        }
        let users_details_refs = users_details.iter().collect::<Vec<&UserDetails>>();
        UserSearch::put_to_index(&users_details_refs).await.map_err(Into::into)
    }

    async fn cutover(&self) -> Result<(), DynError> { Ok(()) }
    async fn cleanup(&self) -> Result<(), DynError> { Ok(()) }
}
```

## Observability (OpenTelemetry and Signoz)

Setting `[stack.otlp].endpoint` to an OTLP collector enables export of **traces, logs, and
metrics** (export is off when `endpoint` is `None`). The recommended local target is
**Signoz**: install it locally (see the [Signoz install guide](https://signoz.io/docs/install)),
point `[stack.otlp].endpoint` at it, run `nexusd`, then view the dashboard at
`http://localhost:3301`.

- **Watcher** — meter `nexus.watcher` with counter `watcher.fetch.rejected`
  (`reason = "size_exceeded"`); tracing spans `events.poll`, `event_batch.process`,
  `event.process`, each recording `otel.status_code` (OK/ERROR) + `otel.status_message`.
- **API server** — a *separate* meter `nexus` with `u64` counter `http.rate_limit.rejected.total`
  (tagged `bucket = "default" | "expensive"`), emitted when a request is throttled. See
  [API rate limiting](#api-rate-limiting).

## Mock data and tests

```bash
# Load mock data (docker/test-graph/mocks) into Neo4j + Redis
cargo run -p nexusd -- db mock        # set CONTAINER_RUNTIME=podman for podman

# Wipe the databases
cargo run -p nexusd -- db clear
```

Tests run with cargo-nextest per crate:
`cargo nextest run -p nexus-common|nexus-webapi|nexus-watcher --no-fail-fast`. The
`nexus-watcher` tests additionally require `TEST_PUBKY_CONNECTION_STRING` (a Postgres URL, see
[Dev dependencies](#dev-dependencies-neo4j-and-redis)). Benchmarks: `cargo bench -p nexus-webapi`.

## Upstream references

- **Repo (source of truth):** [pubky-nexus](https://github.com/pubky/pubky-nexus) — README,
  `nexus-common/default.config.toml`, `nexusd/src/cli.rs`, `nexus-watcher/`,
  `nexus-webapi/src/routes/middlewares/rate_limit.rs`, `nexusd/src/migrations/`.
- **Hosted Swagger / `/v0` (unstable):**
  [production](https://nexus.pubky.app/swagger-ui/) ·
  [staging](https://nexus.staging.pubky.app/swagger-ui/).
- **Consuming the `/v0` API:** [`nexus-api.md`](../../pubky/references/nexus-api.md).
- **Canonical concepts (never restate):**
  [`concepts.md`](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read) (write/read
  split, event-stream contract, Neo4j+Redis model).
- **Guardrail:** [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
- **Full orchestrated local stack:** [`local-stack.md`](local-stack.md) ·
  [pubky-docker](https://github.com/pubky/pubky-docker).
