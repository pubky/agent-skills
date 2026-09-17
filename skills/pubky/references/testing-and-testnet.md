# Testing and the local testnet

All app-dev testing uses the same `pubky-testnet` harness. Choose the entry point based on how your client connects:

| Surface | Use it for | Entry point |
| :-- | :-- | :-- |
| In-process Rust tests | `#[tokio::test]` against an isolated DHT and homeserver. Offline and parallel-safe. | `EphemeralTestnet` (lib) |
| Standalone local testnet | Browsers, JS/WASM, mobile, `pubky-cli` and manual debugging, over fixed ports | `cargo run -p pubky-testnet` (same as `npm run testnet`) |
| Shell scripting | Scripted signup, publish, get and delete | `pubky-cli user` + `tools` |

For a real persistent deployment (compose, homeserver config, admin API, signup tokens), see [Full self-hosted stack](#full-self-hosted-stack).

**Versions:** the `pubky-homeserver` workspace is **0.12.0** (rust-version 1.89). `pubky`, `pubky-common`, `pubky-homeserver` and `pubky-testnet` are all 0.12. `@synonymdev/pubky` `latest` on npm is 0.12.0. Pubky is pre-1.0, so expect breaking changes.

Upstream is authoritative and changes often:
[`pubky-testnet` README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md) ·
[docs.rs/pubky-testnet](https://docs.rs/pubky-testnet) ·
[`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md)
(contributor guide; it replaced `docs/DEV_TESTING_GUIDES.md`, which no longer exists).

## Rust in-process tests (`EphemeralTestnet`)

- **`EphemeralTestnet`** is for automated tests. It uses random ports and gives each instance its own DHT and homeserver, so tests can run in parallel.
- **`StaticTestnet`** is for interactive use, on fixed ports (see [Standalone local testnet](#standalone-local-testnet)).
- The crate re-exports `pubky`, `pubky_common`, `pubky_homeserver`, `drop_test_databases` and the `test` macro. The `docker_postgres` module needs the `docker-postgres` feature.

```rust
use pubky_testnet::EphemeralTestnet;

#[tokio::test]
#[pubky_testnet::test] // Cleans up ephemeral Postgres databases after the test
async fn my_test() {
    // Note: both attributes are required — #[tokio::test] provides the async
    // runtime, #[pubky_testnet::test] registers a cleanup hook for test DBs.
    let testnet = EphemeralTestnet::builder().build().await.unwrap();

    // Create a Pubky Http Client from the testnet.
    let client = testnet.client().unwrap();

    // Use the homeserver
    let homeserver = testnet.homeserver_app();
}
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/pubky-testnet/README.md#L65-L81). Compiled against `pubky-testnet` 0.12.0, not executed. `client` and `homeserver` are unused placeholder bindings.</sub>

**`EphemeralTestnetBuilder`** (`build() -> anyhow::Result<EphemeralTestnet>`):

| Method | Effect / default |
| :-- | :-- |
| `.config(ConfigToml)` | Defaults to `ConfigToml::minimal_test_config()`, which has **admin and metrics disabled**. Pass `ConfigToml::default_test_config()` if the test needs the admin server. |
| `.keypair(Keypair)` | Defaults to a deterministic keypair from secret `[0; 32]` (`8pinx…`, see below). |
| `.postgres(ConnectionString)` | Uses this Postgres server (`pubky_testnet::pubky_homeserver::ConnectionString::new("postgres://…")`). |
| `.with_http_relay()` | Starts an HTTP relay (**off** by default). |
| `.with_docker_postgres()` | Starts a dedicated Postgres container for this testnet (feature `docker-postgres`). |

`build()` **errors if you set both `.postgres()` and `.with_docker_postgres()`**.

**Signup tokens:** both test configs use `signup_mode = Open`, so **`EphemeralTestnet` and the default in-memory static testnet need no signup token**. This does **not** apply to a static testnet started with `persist` or `--homeserver-config` (see below). Blobs are stored in memory (`InMemory`), but metadata still goes to Postgres.

**Accessor gotchas.** The full list is on [docs.rs](https://docs.rs/pubky-testnet).

- `client()` returns `Result<PubkyHttpClient, BuildError>` and `sdk()` returns `Result<Pubky, BuildError>`, already wired to this testnet. Unwrap them or use `?`.
- `http_relay()` **panics** (`no http relay configured - use .with_http_relay() when building`) unless you built with `.with_http_relay()`.
- `EphemeralTestnet` has **no** `pkarr_relay()`. Only `StaticTestnet` has `pkarr_relay()`, `bootstrap_nodes()` and `is_persistent()`.

> **Deprecated APIs: use the builders.** `EphemeralTestnet::start()` is **not** the same as `builder().build()`. It uses `default_test_config()`, so admin is enabled and an HTTP relay starts. The other `start_*` constructors are deprecated too. Since 0.9.0, `with_embedded_postgres()`, the `embedded_postgres` module and `EmbeddedPostgres` are deprecated in favour of the `docker-postgres` equivalents. The `embedded-postgres` feature is kept only as a deprecated alias. For `StaticTestnet::start_with_homeserver_config`, use `StaticTestnet::builder().homeserver_config(path).build()` instead. See docs.rs for the full list.

The following runnable program does an offline app roundtrip. Run it from `examples/rust` with `cargo run --bin testnet`. That uses Docker Postgres, because the examples crate enables `docker-postgres` by default. Add `-- --external-postgres` to use your own Postgres. In Rust, `signin` takes a `ClientId`:

```rust
use clap::Parser;
use pubky_testnet::{
    pubky::{ClientId, Keypair},
    EphemeralTestnet,
};

#[derive(Parser)]
struct Args {
    /// Use an external PostgreSQL instance instead of the Docker-managed one.
    /// Connects to TEST_PUBKY_CONNECTION_STRING env var if set,
    /// otherwise defaults to postgres://postgres:postgres@localhost:5432/postgres
    #[arg(long)]
    external_postgres: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    #[allow(unused_variables)]
    let args = Args::parse();

    // Spin up ephemeral DHT + homeserver with minimal config
    #[allow(unused_mut)]
    let mut builder = EphemeralTestnet::builder();

    #[cfg(feature = "docker-postgres")]
    let builder = if !args.external_postgres {
        builder.with_docker_postgres()
    } else {
        builder
    };

    let testnet = builder.build().await?;
    let homeserver = testnet.homeserver_app();

    // Intantiate a Pubky SDK wrapper that uses this testnet's preconfigured client for transport
    let pubky = testnet.sdk()?;

    // Create a random signer and sign up
    let signer = pubky.signer(Keypair::random());
    signer.signup(&homeserver.public_key(), None).await?;
    let session = signer.signin(ClientId::new("testnet.example")?).await?;

    // Write a file
    session
        .storage()
        .put("/pub/my-cool-app/hello.txt", "hi")
        .await?;

    // Read it back
    let txt = session
        .storage()
        .get("/pub/my-cool-app/hello.txt")
        .await?
        .text()
        .await?;
    assert_eq!(txt, "hi");

    println!("Roundtrip succeeded: {txt}");
    Ok(())
}
```

<sub>Source: [`examples/rust/8-testnet/main.rs`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/examples/rust/8-testnet/main.rs). Clippy-clean against 0.12.0 with and without `docker-postgres`. Not executed; the same roundtrip was run in JS against a local testnet.</sub>

The other Rust examples connect to a standalone testnet that is already running (for example `cargo run --bin signup -- --testnet`). Examples 7 (logging) and 8 (testnet) start their own. See the [Rust examples README](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust).

## PostgreSQL is required

Every testnet needs a reachable **Postgres server**. For tests and the in-memory static testnet, the homeserver **always** creates a fresh `pubky_test_{uuid}` database on that server. It picks the server in this order:

1. An explicit URL: builder `.postgres(..)`, Docker Postgres, or `database_url` in the config.
2. The `TEST_PUBKY_CONNECTION_STRING` env var. An invalid value is an error, not a fallback.
3. The default, `postgres://localhost:5432/postgres`.

- **`--homeserver-config` overrides the env var.** A custom config file is merged over `config.default.toml`, which sets `database_url = postgres://localhost:5432/pubky_homeserver`. That counts as an explicit URL (step 1), so `TEST_PUBKY_CONNECTION_STRING` is **silently ignored** unless your config sets its own `database_url`.
- **`?pubky-test=true` is no longer needed.** The homeserver ignores the parameter, so old URLs still work. Leave it out of new connection strings.

> **Leaked databases:** dropping the testnet only *registers* the test DB for cleanup. The DB is actually deleted only by `#[pubky_testnet::test]`, or by calling `pubky_testnet::drop_test_databases().await` **after** the testnet is dropped. If neither happens, `pubky_test_{uuid}` databases pile up on your Postgres server.

**(A) Your own Postgres** (current upstream command):

```bash
docker run --name pubky-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 \
  -d postgres:18

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo test -p my-crate
```

<sub>Source: [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/docs/TESTING.md#L5-L24) (upstream uses `-p pubky-homeserver --all-features`; `my-crate` is a placeholder). The flags were checked by the docker and cargo parsers, and the `postgres:18` tag exists.</sub>

**(B) Docker-managed Postgres (testcontainers).** Add `pubky-testnet = { version = "0.12", features = ["docker-postgres"] }` to dev-dependencies. **Docker must be running.** Containers are removed when they are dropped, on Ctrl+C/SIGTERM (testcontainers watchdog), and, for the shared container, when the process exits normally.

Each `.with_docker_postgres()` starts its **own** container, which is slow across a whole suite. Share one container instead. Each testnet still gets its own isolated DB inside it:

```rust
use pubky_testnet::EphemeralTestnet;
use pubky_testnet::docker_postgres::DockerPostgres;

#[tokio::test]
async fn test_one() {
    let pg = DockerPostgres::shared().await;
    let testnet = EphemeralTestnet::builder()
        .postgres(pg.connection_string().unwrap())
        .build()
        .await
        .unwrap();
    // ... test code
}
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/pubky-testnet/README.md#L142-L175)</sub>

- The upstream snippet above leaves out `#[pubky_testnet::test]`. **Add it**, or the test DBs leak.
- `DockerPostgres::shared()` **panics if Docker isn't running**. Use `DockerPostgres::start()`, which returns `anyhow::Result`, when you need to handle that error. For the other methods, see [docs.rs](https://docs.rs/pubky-testnet).

## Standalone local testnet

`cargo run -p pubky-testnet` runs a `StaticTestnet` on fixed ports so that clients in other processes can connect. When ready it logs `Testnet running`, followed by the bootstrap, relay and homeserver URLs. The admin URL is also logged because admin is enabled here, and the metrics URL is logged **only if metrics are enabled** (they are off by default). **Wait for the `Testnet running` line before connecting.**

| Component | Port / value |
| :-- | :-- |
| DHT bootstrap | `6881` |
| Pkarr relay | `15411` |
| HTTP relay | `15412` |
| Homeserver ICANN HTTP | `6286` |
| Homeserver Pubky HTTPS | `6287` |
| Homeserver admin | `6288` (**enabled**) |
| Homeserver public key (z32) | `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` |

> **Security:** all listeners bind **`0.0.0.0`**, and the admin API on `6288` uses the default password **`admin`** from `config.default.toml`. Don't run the static testnet on an untrusted or shared network. Otherwise, firewall these ports (at minimum `6288`).

The homeserver key comes from `Keypair::from_secret(&[0; 32])`, so it is the same on every run and in both static and ephemeral testnets. Its display form is `pubky8pinx…`. Use the correct string format for each call; see [`concepts.md`: public-key string formats](concepts.md#public-key-string-formats).

```bash
# Persistent state
TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- persist ./my-testnet-data

# Seed a custom homeserver config on first run (errors if config.toml already exists)
TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- --homeserver-config my-config.toml persist ./my-testnet-data

# Ephemeral: DB auto-created on startup, cleaned up on shutdown
TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/pubky-testnet/README.md#L21-L44). Argument order was checked with the real CLI parser: `--homeserver-config` must come **before** `persist`. **The env-var prefix on the two `persist` commands has no effect** (see below). Upstream's claim that it overrides `database_url` is stale.</sub>

- **In-memory mode (default):** uses a `pubky_test_{uuid}` database, so `TEST_PUBKY_CONNECTION_STRING` applies. On Ctrl+C it drops the testnet and calls `drop_test_databases()`. `--homeserver-config` replaces the default config, but the fixed ports, DHT and admin settings are still applied on top. The file is merged over `config.default.toml`, so unless your file overrides them you get `database_url = …/pubky_homeserver` (which beats the env var) and `signup_mode = token_required`.
- **`persist <data_dir>`:** creates `config.toml`, `secret` and `data/files/` on the first run, and keeps the same `8pinx…` identity across restarts. It uses **no** test DB and **ignores `TEST_PUBKY_CONNECTION_STRING`**. It connects directly to `[general].database_url` in `<data_dir>/config.toml`. Without that URL it fails with `Persistent testnet requires an explicit database URL`. The generated config points at `postgres://localhost:5432/pubky_homeserver` with no credentials, so edit it (for example `postgres://postgres:postgres@localhost:5432/pubky_homeserver`) and make sure the database exists. Nothing is cleaned up on shutdown.
- **Persistent and custom-config testnets require signup tokens** (`signup_mode = token_required` from `config.default.toml`). The JS and `pubky-cli` signup flows below fail against them unless you pass a token or set `signup_mode` to open in the config. For how tokens work, see [`signup-gating.md`](../../pubky-infra/references/signup-gating.md).

**`npm run testnet`** in the JS SDK package (`pubky-sdk/bindings/js/pkg`) is just `"cargo run -p pubky-testnet"`, both in the repo and in the published 0.12.0 `package.json`. It is not a pure-JS server: it needs a Rust toolchain, a `pubky-homeserver` checkout and Postgres.

**Pointing clients at it:** `Pubky::testnet()` / `Pubky.testnet()` is the same as `testnet_with_host("localhost")`. That sets the DHT bootstrap to `<host>:6881` (native only) and the pkarr relay to `http://<host>:15411`. On WASM the host is also used to rewrite URLs. For a testnet on another machine or in a container, pass the host: `PubkyHttpClientBuilder::testnet_with_host("192.168.1.50")` in Rust, or `Pubky.testnet("host.docker.internal")` in JS. Those ports must be reachable. For mainnet vs testnet facade construction, see [`sdk-js.md`](sdk-js.md) and [`sdk-rust.md`](sdk-rust.md).

A Docker image of the testnet exists. Build it with `--build-arg BUILD_TARGET=testnet`; the binary inside is named `homeserver`. See [`docs/TESTING.md#docker-build-options`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md#docker-build-options).

### JS against the local testnet

The JS examples are in [`examples/javascript`](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript) (Node 20+) and use the local SDK via `file:../../pubky-sdk/bindings/js/pkg`.

1. `cd pubky-sdk/bindings/js/pkg && npm install && npm run build`
2. `cd examples/javascript && npm install`
3. From the repo root, start `cargo run -p pubky-testnet` and wait for `Testnet running`.
4. Run **`node 6-check-testnet.mjs` first** (it was renamed from `0-check-testnet.mjs`). The expected output is `Testnet is available, roundtrip succeeded.`

```js
import { Pubky, Keypair, PublicKey } from "@synonymdev/pubky";

const TESTNET_HOMESERVER =
  "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";

// 1) Build Pubky SDK facade for local testnet host
const pubky = Pubky.testnet();

// 2) Make a random keypair, bind it to a signer and sign up on the given homeserver
const keypair = Keypair.random();
const signer = pubky.signer(keypair);
const homeserver = PublicKey.from(TESTNET_HOMESERVER);
await signer.signup(homeserver);

// 3) Sign in to create a grant-backed session for storage access
const session = await signer.signin("my-cool-app.example");

// 4) Write then read a file under /pub/<your.app>/
const path = "/pub/my-cool-app/hello.txt";
await session.storage.putText(path, "hi");

const roundtrip = await session.storage.getText(path);
await session.signout();
```

<sub>Adapted from [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/28f4bf389198be7a067bdae6e57df13c4402f480/examples/javascript/6-check-testnet.mjs#L9-L44): the `try/catch` body is unwrapped and `TESTNET_HOMESERVER` is inlined from `_testnet.mjs`. Executed with `@synonymdev/pubky` 0.12.0 against a local testnet (`tsc --noEmit` strict passes). The roundtrip returns `"hi"`, and a write after `signout` returns `401`.</sub>

JS signatures in 0.12.0 that break older code:

- `signer.signup(homeserver: PublicKey, signup_token?: string | null): Promise<void>`. It **returns no session**, so call `signin` afterwards.
- `signer.signin(client_id: string): Promise<Session>`. The **`client_id` is required** in 0.12, and leaving it out is a TypeScript error; the 0.9.x "omit it" advice is wrong now. `signinBlocking(client_id)` works the same way.
- `PublicKey.from(value)` accepts raw z32 or `pubky<z32>`. It **rejects `pubky://…`** with `InvalidInput`.
- Rewrite older snippets that do `const session = await signer.signup(...)` (for example from pubky-ai-kit) as signup followed by `signin(clientId)`.

**Troubleshooting:**

| Symptom | Cause |
| :-- | :-- |
| `ECONNREFUSED` / transport error | The testnet isn't running or is still starting. |
| `PkarrError: No HTTPS endpoints found` | The testnet isn't ready, or the key isn't published or resolvable yet. Run `6-check-testnet` first. |
| `401` | Write without a valid session (for example after `signout`), or as the wrong user. |
| `403` | The path is outside `/pub/` and `/priv/`, belongs to another user, or no capability covers it. |
| Signup rejected (token) | You are on a `persist` or `--homeserver-config` testnet (`signup_mode = token_required`). |

Don't use `3-storage.mjs` (an addressed public read) as your first smoke test, because PKDNS publication can lag.

## Scripting with pubky-cli

`pubky-cli` is a separate repo and crate ([github.com/pubky/pubky-cli](https://github.com/pubky/pubky-cli), [crates.io](https://crates.io/crates/pubky-cli)). For app development, use `user` (signup, signin, session, signout, publish, get, delete, list) and `tools`. `admin` is for operators; see [Full self-hosted stack](#full-self-hosted-stack). For exact arguments, the `tools` subcommands and all env vars (`PUBKY_PKARR_BOOTSTRAP`, `PUBKY_PKARR_RELAYS`, `PUBKY_PKARR_TIMEOUT_MS`, …), read the [README](https://github.com/pubky/pubky-cli/blob/main/README.md).

> **Version skew: mention this whenever you recommend it.** `pubky-cli` exists only as the pre-release `0.1.0-rc.1` (last published 2025-10-23; there is no stable release). Plain `cargo install pubky-cli` therefore **fails** (`could not find pubky-cli … with version *`), so pin the version: `cargo install pubky-cli --version 0.1.0-rc.1`. It pins `pubky = "0.6.0-rc.6"` and `pubky-testnet = "0.6.0-rc.6exp"`, far behind 0.12. It uses the old root-session API (Rust `signin()` takes no `ClientId`). Don't assume it behaves like 0.12.

Mistakes that break scripts:

- **Signup can exit non-zero against a 0.12 testnet.** With only `--testnet`, `user signup` failed with `Failed to publish record to the DHT: Publishing SignedPacket to Mainline failed` (exit 1), even though the account was created. The old pkarr could not publish to the testnet's local DHT. This reproduced 4/4, but only in one environment, so it may depend on the setup. Any `set -e` script stops there. **Fix:** `export PUBKY_PKARR_RELAYS=http://localhost:15411` to publish through the testnet's pkarr relay only (verified: the whole flow below passes).
- **`PUBKY_PKARR_BOOTSTRAP` / `PUBKY_PKARR_RELAYS` make `--testnet` a no-op.** When either is set, the client is built from those env vars and `--testnet` is ignored.
- **Without those env vars, pass `--testnet` on *every* command** that takes a recovery file, including `get` and `delete`. Those commands load the recovery file and sign in first, and they use `Pubky::testnet()` only when `--testnet` is set. Upstream's README leaves the flag off `get`/`delete`, and they fail without it (`pkarr could not resolve host`). `user list` is different: it takes a URL and does not sign in.
- **Key format:** pass the homeserver as **bare z32** (`8pinx…`) or `pubky.<z32>`. The 0.12 display form `pubky8pinx…` (no dot) is **rejected** by this old CLI.
- The README quick-start writes `--singup-code`. That is a typo; the real flag is **`--signup-code`**.
- **Secrets:** `tools generate-recovery` **prints the passphrase to stdout** (`Keep this passphrase safe: …`), and `--passphrase` puts it in shell history and the process list. In CI, supply it only through `PUBKY_CLI_RECOVERY_PASSPHRASE` from a secret, and keep that output out of logs. Never do this with real keys.

```bash
cargo install pubky-cli --version 0.1.0-rc.1

pubky-cli tools generate-recovery ./alice.recovery --passphrase pass

# pubky-cli 0.1.0-rc.1 (pkarr from pubky 0.6.0-rc.6) cannot publish to the 0.12
# testnet's local DHT, so signup exits non-zero. Publish via the testnet pkarr relay only.
export PUBKY_PKARR_RELAYS=http://localhost:15411
export PUBKY_CLI_RECOVERY_PASSPHRASE=pass

pubky-cli user signup <homeserver-pk> ./alice.recovery --testnet
pubky-cli user signin ./alice.recovery --testnet
pubky-cli user publish "/pub/my-cool-app/hello.txt" test.txt ./alice.recovery --testnet
pubky-cli user get /pub/my-cool-app/hello.txt ./alice.recovery --testnet
pubky-cli user delete "/pub/my-cool-app/hello.txt" ./alice.recovery --testnet
```

<sub>Adapted from [`pubky-cli/README.md`](https://github.com/pubky/pubky-cli/blob/c041b2b1009267e45c1f974f34dc5c7676c00a25/README.md#L44-L81): pinned install, relay-only pkarr, and `--testnet` added to `get`/`delete` (a no-op here because `PUBKY_PKARR_RELAYS` is set, but required if you drop the env var). Executed under `set -euo pipefail` against a 0.12 static testnet, with `<homeserver-pk>` = `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`. Needs a no-token testnet (default in-memory mode); add `--signup-code <token>` otherwise.</sub>

## Writing correct tests

- **Storage paths:** write under `/pub/<your.app>/`. The `/pub` path layout is **not stabilized** (pre-1.0). Paths outside `/pub/` and `/priv/` return `403`. For addressing and access rules, see [`concepts.md`: storage roots and access](concepts.md#storage-roots-and-access).
- **`/priv` is ALPHA (v0.10.0+) and not for production.** It is access-controlled, *not* encrypted, so the operator can read it. Test it only with that caveat stated. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Don't test planned features** such as encrypted/guarded data as a general primitive, homeserver mirroring, backup restore, cloud backup or two-way sync. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Contributors to `pubky-homeserver` itself:** `cargo test -p pubky-testnet --features docker-postgres` tests the testnet crate, and `TEST_PUBKY_CONNECTION_STRING=… cargo test -p e2e` runs the cross-crate e2e tests. See [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md).

## Full self-hosted stack

For a real, persistent deployment instead of a throwaway testnet, use the **`pubky-infra`** skill:

- [`local-stack.md`](../../pubky-infra/references/local-stack.md): the `pubky-docker` compose stack.
- [`homeserver.md`](../../pubky-infra/references/homeserver.md): real homeserver config and admin API.
- [`signup-gating.md`](../../pubky-infra/references/signup-gating.md): signup tokens and invite gating.
- [`operator-cli.md`](../../pubky-infra/references/operator-cli.md): `pubky-cli admin` flows (`PUBKY_ADMIN_PASSWORD`).
