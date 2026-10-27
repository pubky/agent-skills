# Testing and the local testnet

All app-dev testing uses the same `pubky-testnet` harness. Choose the entry point based on how your client connects:

| Surface | Use it for | Entry point |
| :-- | :-- | :-- |
| In-process Rust tests | `#[tokio::test]` against an isolated DHT and homeserver. Offline and parallel-safe. | `EphemeralTestnet` (lib) |
| Standalone local testnet | Browsers, JS/WASM, mobile, `pubky-cli` and manual debugging, over fixed ports | `cargo install pubky-testnet --version 0.16.2` then `pubky-testnet` (no checkout needed), or `cargo run -p pubky-testnet` / `npm run testnet` from a checkout |
| Shell scripting | Scripted signup, publish, get and delete | `pubky-cli user` + `tools` |

For a real persistent deployment (compose, homeserver config, admin API, signup tokens), see [Full self-hosted stack](#full-self-hosted-stack).

**Versions (2026-10-26):** the `pubky-homeserver` workspace is **0.16.2**. `pubky`, `pubky-common`, `pubky-homeserver` and `pubky-testnet` are all 0.16. On crates.io, `pubky-testnet` and `pubky` are 0.16.2 (released 2026-10-15). On npm, `@synonymdev/pubky` `latest` is 0.16.2. Ignore the `next` (0.6.0-rc.7) and `alpha` (0.10.0-alpha.0) dist-tags, because both are older than `latest`. Pubky is pre-1.0, so expect breaking changes.

> **MSRV depends on how you get the crate.**
> - From **crates.io** (`pubky-testnet`/`pubky` 0.16.2 as a dependency, or `cargo install pubky-testnet --version 0.16.2`): **Rust 1.89+**.
> - **Building from a `pubky-homeserver` checkout of `main`** (`cargo run -p pubky-testnet`, `npm run testnet`, the examples): **Rust 1.91+**. The MSRV was raised after the v0.16.2 release. Unless upstream lowers it again, the next release will need 1.91 too.

Upstream is authoritative and changes often:
[`pubky-testnet` README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md) ·
[docs.rs/pubky-testnet](https://docs.rs/pubky-testnet) ·
[`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md) (contributor guide).

## Rust in-process tests (`EphemeralTestnet`)

- **`EphemeralTestnet`** is for automated tests. It uses random ports and gives each instance its own DHT and homeserver, so tests can run in parallel.
- **`StaticTestnet`** is for interactive use, on fixed ports (see [Standalone local testnet](#standalone-local-testnet)).
- The crate re-exports `pubky`, `pubky_common` and `pubky_homeserver`, plus `drop_test_databases` and the `test` macro. For the full export list, see [docs.rs](https://docs.rs/pubky-testnet/0.16.2/pubky_testnet/).
- Cargo features: `default = []`. The `docker_postgres` module needs the `docker-postgres` feature, which pulls in testcontainers.

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

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/pubky-testnet/README.md#L65-L81). `client` and `homeserver` are unused placeholder bindings. Run as a test against pubky-testnet 0.12.0 with a local Postgres (passed, test DB cleaned up). Clippy-clean on 0.16.2.</sub>

**`EphemeralTestnetBuilder`** (`build() -> anyhow::Result<EphemeralTestnet>`):

| Method | Effect / default |
| :-- | :-- |
| `.config(ConfigToml)` | Defaults to `ConfigToml::minimal_test_config()`, which has **admin and metrics disabled**. Pass `ConfigToml::default_test_config()` if the test needs the admin server. |
| `.keypair(Keypair)` | Defaults to `Keypair::from_secret(&[0; 32])`, a deterministic keypair (`8pinx…`, see below). |
| `.postgres(ConnectionString)` | Uses this Postgres server. |
| `.with_http_relay()` | Starts an HTTP relay (**off** by default). |
| `.with_docker_postgres()` | Starts a dedicated Postgres container for this testnet (feature `docker-postgres`). |

`build()` **errors** (`Cannot use both docker postgres and a custom connection string`) if you set both `.postgres()` and `.with_docker_postgres()`.

**Signup tokens:** both test configs use `signup_mode = Open`, so **`EphemeralTestnet` and the default in-memory static testnet need no signup token**. This does **not** apply to a static testnet started with `persist` or `--homeserver-config` (see below). Blobs are stored in memory (`InMemory`), but metadata still goes to Postgres. Both test configs exist only under `cfg(test)` or the homeserver's `testing` feature.

**Accessor gotchas.** The full list is on [docs.rs (0.16.2)](https://docs.rs/pubky-testnet/0.16.2/pubky_testnet/struct.EphemeralTestnet.html).

- `client()` returns `Result<PubkyHttpClient, BuildError>` and `sdk()` returns `Result<Pubky, BuildError>`, both already wired to this testnet. Unwrap them or use `?`.
- `http_relay()` **panics** (`no http relay configured - use .with_http_relay() when building`) unless you built with `.with_http_relay()`.
- `EphemeralTestnet` has **no** `pkarr_relay()`. Only `StaticTestnet` has `pkarr_relay()`, `bootstrap_nodes()` and `is_persistent()`.
- For extra homeservers, use `create_random_homeserver()` or `create_random_homeserver_with_config(Option<ConfigToml>)`. These use `Keypair::random()`, not the `8pinx…` key.
- The testnet client uses **100 ms** DHT and relay request timeouts (`.dht_request_timeout` and `.relay_request_timeout`). These are for local tests only. Don't copy them into production client config.

> **Use the builders, not the deprecated constructors.** `EphemeralTestnet::start()` is **not** the same as `builder().build()`: it uses `default_test_config()` (admin enabled) and also starts an HTTP relay. The `embedded_postgres` names and the `embedded-postgres` feature are deprecated aliases for the `docker-postgres` ones. For the full deprecation list, see [docs.rs](https://docs.rs/pubky-testnet/0.16.2/pubky_testnet/).

The program below does an offline app roundtrip. Run it from `examples/rust` with `cargo run --bin testnet`. The examples crate enables `docker-postgres` by default, so this uses Docker Postgres. Add `-- --external-postgres` to use `TEST_PUBKY_CONNECTION_STRING` or the default server instead. In Rust, `signin` takes a `ClientId`:

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

<sub>Source: [`examples/rust/8-testnet/main.rs`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/examples/rust/8-testnet/main.rs#L1-L60). Run with `--external-postgres` against 0.12.0 (`Roundtrip succeeded: hi`). Clippy-clean on 0.16.2. Building it from a checkout needs Rust 1.91+. The program never calls `drop_test_databases()`, so on the external-Postgres path each run leaks one `pubky_test_{uuid}` database (see [Leaked databases](#postgresql-is-required)).</sub>

> **Upstream doc drift:** the `--external-postgres` doc comment above and the example README say the fallback is `postgres://postgres:postgres@…`. The code's real default is `postgres://localhost:5432/postgres`, **with no credentials**. If your Postgres needs a password, set `TEST_PUBKY_CONNECTION_STRING` explicitly.

The other Rust examples connect to a standalone testnet that is already running (for example `cargo run --bin signup -- --testnet`). See the [Rust examples README](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust).

## PostgreSQL is required

Every testnet needs a reachable **Postgres server**. For tests and the in-memory static testnet, the homeserver **always** creates a fresh `pubky_test_{uuid}` database on that server. It picks the server in this order:

1. An explicit URL: builder `.postgres(..)`, Docker Postgres, or `database_url` in the config.
2. The `TEST_PUBKY_CONNECTION_STRING` env var. An invalid value is an error (`Invalid TEST_PUBKY_CONNECTION_STRING`), not a fallback.
3. The default, `postgres://localhost:5432/postgres`.

- **`--homeserver-config` overrides the env var.** A custom config file is deep-merged over `config.default.toml`, which sets `database_url = postgres://localhost:5432/pubky_homeserver`. That counts as an explicit URL (step 1), so `TEST_PUBKY_CONNECTION_STRING` is **silently ignored** unless your config sets its own `database_url`.
- **Leave `?pubky-test=true` out of new connection strings.** It is no longer needed. Old URLs that include it still parse.

> **Leaked databases:** dropping the testnet only *registers* the test DB for cleanup. The DB is deleted only by `#[pubky_testnet::test]`, or by calling `pubky_testnet::drop_test_databases().await` **after** the testnet is dropped. If neither runs, `pubky_test_{uuid}` databases pile up on your Postgres server.

**(A) Your own Postgres:**

```bash
docker run --name pubky-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 \
  -d postgres:18

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo test -p pubky-homeserver --all-features
```

<sub>Source: [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/docs/TESTING.md#L5-L24). The upstream command tests the homeserver itself. For your own tests, use `cargo test -p <your-crate>`. Lint-checked only: the flags parse and the `cargo test` target compiles at 0.16.2, but the container was not started.</sub>

**(B) Docker-managed Postgres (testcontainers).** Add `pubky-testnet = { version = "0.16", features = ["docker-postgres"] }` to dev-dependencies. **Docker must be running.** Containers are removed when they are dropped, on Ctrl+C/SIGTERM (testcontainers watchdog), and, for the shared container, at normal process exit. **`kill -9` still orphans containers.**

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

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/pubky-testnet/README.md#L142-L176). Run against 0.12.0 with Docker (passed, no container left behind). Clippy-clean on 0.16.2.</sub>

- The upstream snippet above leaves out `#[pubky_testnet::test]`. **Add it.** Without it, test DBs pile up inside the shared container for the whole run.
- `DockerPostgres::shared()` **panics if Docker isn't running** (`Failed to start shared Docker postgres. Is Docker running?`). If you need to handle that error, use `DockerPostgres::start()`, which returns `anyhow::Result<Self>`. `connection_string()` returns `anyhow::Result<ConnectionString>`.
- **Volume leak in 0.9.0–0.16.2:** when the shared container is removed at exit, its anonymous Postgres volumes stay behind. Clean them up with `docker volume prune`. An unreleased fix on `main` (it runs `docker rm -f -v`) removes them.

## Standalone local testnet

`pubky-testnet` (installed, or via `cargo run -p pubky-testnet`) runs a `StaticTestnet` on fixed ports, so clients in other processes can connect. When ready it logs `Testnet running`, followed by the DHT bootstrap nodes, the pkarr relay, HTTP relay, ICANN HTTP and Pubky HTTPS URLs, and the admin URL. The metrics URL is logged **only if metrics are enabled** (off by default). **Wait for the `Testnet running` line before connecting.**

| Component | Port / value |
| :-- | :-- |
| DHT bootstrap | `6881` |
| Pkarr relay | `15411` |
| HTTP relay | `15412` |
| Homeserver ICANN HTTP | `6286` |
| Homeserver Pubky HTTPS | `6287` |
| Homeserver admin | `6288` (**forced on**) |
| Homeserver public key (z32) | `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` |

> **Security:** the ICANN, Pubky, admin and HTTP-relay listeners bind **`0.0.0.0`**, and so do the pkarr relay and the `6881` DHT bootstrap node. Admin is forced on at `6288` with the default password **`admin`**. Don't run the static testnet on an untrusted or shared network. If you must, firewall these ports (at minimum `6288`).

By default, every testnet derives the homeserver key from `Keypair::from_secret(&[0; 32])`, so it is the same `8pinx…` key on every run. Exceptions: `EphemeralTestnetBuilder::keypair()` overrides it, `create_random_homeserver()` uses a random key, and a `persist` data dir that already has a `secret` file keeps that key. The display form is `pubky8pinx…`. Use the right string format for each call; see [`concepts.md`: public-key string formats](concepts.md#public-key-string-formats).

```bash
TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- persist ./my-testnet-data

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- --homeserver-config my-config.toml persist ./my-testnet-data

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/pubky-testnet/README.md#L21-L44). In order: persistent state; a custom config seeded on first run; ephemeral. With an installed binary, replace `cargo run -p pubky-testnet --` with `pubky-testnet`. `--homeserver-config` must come **before** `persist`; the other order fails with `unexpected argument`. **The env-var prefix on the two `persist` commands has no effect** (see below), although upstream's README says it does. Argument parsing was checked at 0.16.2, but no testnet was started.</sub>

- **In-memory mode (default):** uses a `pubky_test_{uuid}` database, so `TEST_PUBKY_CONNECTION_STRING` applies. On Ctrl+C it drops the testnet and calls `drop_test_databases()`. With `--homeserver-config`, the file replaces `default_test_config()`, but the fixed ports, DHT and admin overrides are still applied on top. The file is merged over `config.default.toml`, so unless your file overrides them you get `database_url = …/pubky_homeserver` (which beats the env var) and `signup_mode = token_required`.
- **`persist <data_dir>`:** creates `config.toml`, `secret` and `data/files/` on the first run, and keeps the same identity across restarts. `--homeserver-config` seeds `config.toml`, and it errors if `config.toml` already exists. Persist mode uses **no** test DB and **ignores `TEST_PUBKY_CONNECTION_STRING`**. It connects directly to `[general].database_url` from `<data_dir>/config.toml` merged over `config.default.toml`, which resolves to `postgres://localhost:5432/pubky_homeserver` unless you change it. That URL has no credentials, so the usual failures are Postgres auth errors or a missing `pubky_homeserver` database. Set the URL with credentials and create the database first. Nothing is cleaned up on shutdown.
- **Persistent and custom-config testnets require signup tokens** (`signup_mode = token_required` from `config.default.toml`). The JS and `pubky-cli` signup flows below fail against them unless you pass a token or set `signup_mode` to open in the config. For how tokens work, see [`signup-gating.md`](../../pubky-infra/references/signup-gating.md).

**`npm run testnet`** in the JS SDK package (`pubky-sdk/bindings/js/pkg`) is just `"cargo run -p pubky-testnet"`, both in the repo and in the published 0.16.2 `package.json`. **It is not a JS server.** It needs a Rust toolchain (1.91+ on `main`), a `pubky-homeserver` checkout, and Postgres. **JS and mobile developers without a checkout** can run `cargo install pubky-testnet --version 0.16.2` and then `pubky-testnet`. That needs Rust 1.89+ and Postgres, but no checkout.

**Pointing clients at it:** `Pubky::testnet()` / `Pubky.testnet()` connect to `localhost` by default. Rust's `PubkyHttpClientBuilder::testnet_with_host(host)` sets the DHT bootstrap to `<host>:6881` (native only) and the pkarr relay to `http://<host>:15411`. On WASM the host is also used to rewrite URLs. For a testnet on another machine or in a container, pass the host: `testnet_with_host("192.168.1.50")` in Rust, or `Pubky.testnet("docker-host")` in JS. Those ports must be reachable. The JS client option `pkarr.requestTimeout` sets the **relay** request timeout (default 5000 ms), not the DHT timeout. For mainnet vs testnet facade construction, see [`sdk-js.md`](sdk-js.md) and [`sdk-rust.md`](sdk-rust.md).

**Docker image of the testnet**, built from the repo root:

```bash
docker build --build-arg BUILD_TARGET=testnet --build-arg BUILD_PROFILE=release -t pubky-testnet:release .
docker run --rm --network none pubky-testnet:release homeserver --help
```

<sub>Source: [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/docs/TESTING.md#L163-L189). The binary inside the image is named `homeserver`, not `pubky-testnet`. The image sets `CMD` with no `ENTRYPOINT`, so the arguments replace the command. Flags and Dockerfile args were checked, but the full image build was not run.</sub>

### JS against the local testnet

The JS examples are in [`examples/javascript`](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript). They need Node 20+ (`.nvmrc` pins 22.16.0) and use the local SDK via `file:../../pubky-sdk/bindings/js/pkg`.

1. `cd pubky-sdk/bindings/js/pkg && npm install && npm run build`. `npm run build` runs `cargo run --bin bundle_npm`, so this step also needs the Rust toolchain.
2. `cd examples/javascript && npm install`
3. From the repo root, start `cargo run -p pubky-testnet` and wait for `Testnet running`.
4. Run **`node 6-check-testnet.mjs` first**. Expected output: `Testnet is available, roundtrip succeeded.`

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

<sub>Adapted from [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/fd24bf0c8bbe8b89548ca16fe152a3c10c60c9b8/examples/javascript/6-check-testnet.mjs#L9-L44). The `try/catch` body is unwrapped, and `TESTNET_HOMESERVER` is inlined from `_testnet.mjs`. Type-checked (`tsc --strict`) and run against a local testnet with `@synonymdev/pubky` 0.12.0 and 0.16.2. The roundtrip returned `hi`, and a `putText` after `signout` returned `401`.</sub>

JS signatures that break older code:

- `signer.signup(homeserver: PublicKey, signupToken: string | null): Promise<void>`. It **returns no session**, so call `signin(clientId)` next. A missing or bad token throws a **`RequestError`** with `data.statusCode` **400** (`Token required`) or **401** (`Invalid token` / `Token already used`). Upstream's JSDoc says `AuthenticationError`, but that is doc drift. Branch on `RequestError` + `statusCode`.
- `signer.signin(clientId)` and `signinBlocking(clientId)` take a client ID and create a grant-backed session with root storage access (`/:rw`).
- `PublicKey.from(...)` also accepts the display form `pubky8pinx…`, but not `pubky://`. The CI-verified [knowledge-base snippet](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122464fef97ce8e0f7909d13d0ee350/snippets/js/src/developer-guide.ts#L16-L36) passes the display form, together with `signup(homeserver, null)`.
- **pubky-ai-kit's "Testing Strategies" is stale.** It does `const session = await signer.signup(homeserver, null)` and asserts on the return value, which is `void`. It also uses a placeholder homeserver key. Rewrite that code as signup, then `signin(clientId)`, against `8pinx…`. Its `Pubky.testnet()` and `session.storage.putJson/getJson/delete` calls are still current.
- For auth flows and capability approval, see [`auth.md`](auth.md) and [`sdk-js.md`](sdk-js.md).

**Troubleshooting:**

| Symptom | Cause |
| :-- | :-- |
| `ECONNREFUSED` / transport error | The testnet isn't running or is still starting. |
| `PkarrError: No HTTPS endpoints found` | The testnet isn't ready, or the key isn't resolvable yet. Run `6-check-testnet` first. |
| `401` | No valid session (for example, a write after `signout`). |
| `403` | The path is outside `/pub/` and `/priv/`, belongs to another user, or no capability covers it. |
| `RequestError` on signup, `statusCode` 400 `Token required` | You are on a `persist` or `--homeserver-config` testnet (`signup_mode = token_required`) and passed no token. |
| `RequestError` on signup, `statusCode` 401 `Invalid token` / `Token already used` | The token is wrong or was already consumed. |

Don't use `3-storage.mjs` (an addressed public read) as your first smoke test, because PKDNS publication can lag.

## Scripting with pubky-cli

`pubky-cli` is a separate repo and crate ([github.com/pubky/pubky-cli](https://github.com/pubky/pubky-cli), [crates.io](https://crates.io/crates/pubky-cli)). For app development, use `user` (signup, signin, session, signout, publish, get, delete, list) and `tools`. `admin` is for operators; see [Full self-hosted stack](#full-self-hosted-stack). For exact arguments and all env vars, read the [README](https://github.com/pubky/pubky-cli/blob/main/README.md).

> **Version skew: mention this whenever you recommend the CLI.** The only `pubky-cli` release is the pre-release `0.1.0-rc.1` (2025-10-23). Plain `cargo install pubky-cli` fails, so pin the version: `cargo install pubky-cli --version 0.1.0-rc.1`. It pins `pubky = "0.6.0-rc.6"` and `pubky-testnet = "0.6.0-rc.6exp"`, ten minor versions behind the 0.16 testnet. **The runtime findings below were observed against a 0.12 testnet and have not been re-checked against 0.16.** Verify them before you rely on them.

Mistakes that break scripts:

- **Signup can exit non-zero** (observed on 0.12). With only `--testnet`, `user signup` failed with `Publishing SignedPacket to Mainline failed` (exit 1), even though the account was created. Any `set -e` script stops there. **Fix:** `export PUBKY_PKARR_RELAYS=http://localhost:15411` to publish through the testnet's pkarr relay.
- **`PUBKY_PKARR_BOOTSTRAP` / `PUBKY_PKARR_RELAYS` make `--testnet` a no-op.** If they are set, the client is built from them (plus `PUBKY_PKARR_TIMEOUT_MS`). It falls back to `Pubky::testnet()` only when `--testnet` is set.
- **Without those env vars, pass `--testnet` on every command** that takes a recovery file, including `get` and `delete`. Upstream's README leaves the flag off those two commands.
- **Key format** (observed on 0.12): pass the homeserver as **bare z32** (`8pinx…`). The old CLI rejected the display form `pubky8pinx…`.
- The README writes `--singup-code`. That is a typo; the real flag is **`--signup-code`**.
- The CLI uses the old root-session API. Don't assume it behaves like the 0.16 SDK.
- **Secrets:** `tools generate-recovery` prints the passphrase to stdout, and `--passphrase` puts it in shell history and the process list. In CI, supply it through `PUBKY_CLI_RECOVERY_PASSPHRASE` from a secret and keep the output out of logs. Never do this with real keys.

```bash
cargo install pubky-cli --version 0.1.0-rc.1

pubky-cli tools generate-recovery ./alice.recovery --passphrase pass

# Publish via the testnet pkarr relay only (works around the DHT publish failure seen on 0.12).
export PUBKY_PKARR_RELAYS=http://localhost:15411
export PUBKY_CLI_RECOVERY_PASSPHRASE=pass

pubky-cli user signup 8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo ./alice.recovery --testnet
pubky-cli user signin ./alice.recovery --testnet
pubky-cli user publish "/pub/my-cool-app/hello.txt" test.txt ./alice.recovery --testnet
pubky-cli user get /pub/my-cool-app/hello.txt ./alice.recovery --testnet
pubky-cli user delete "/pub/my-cool-app/hello.txt" ./alice.recovery --testnet
```

<sub>Adapted from [`pubky-cli/README.md`](https://github.com/pubky/pubky-cli/blob/c041b2b1009267e45c1f974f34dc5c7676c00a25/README.md#L24-L81). Changes: the install is pinned, pkarr is relay-only, and `--testnet` is added to `get`/`delete`. Run end-to-end under `set -euo pipefail` against a local 0.12 testnet (all steps exited 0). Not yet run against 0.16. It needs a testnet that requires no token (the default in-memory mode); otherwise add `--signup-code <token>`.</sub>

## Writing correct tests

- **Storage paths:** write under `/pub/<your.app>/`. The `/pub` path layout is **not stabilized** (pre-1.0). Paths outside `/pub/` and `/priv/` return `403`. For addressing and access rules, see [`concepts.md`: storage roots and access](concepts.md#storage-roots-and-access).
- **`/priv` is ALPHA (v0.10.0+) and not for production.** It is access-controlled but *not* encrypted, so the operator can read it. Test it only with that caveat stated. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Don't test planned features**, such as encrypted/guarded data as a general primitive, homeserver mirroring, backup restore, cloud backup or two-way sync. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Contributors to `pubky-homeserver` itself** (not app developers): see [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md). It covers `cargo test -p pubky-testnet --features docker-postgres`, `cargo test -p e2e`, `cargo test --workspace --all-features`, and the storage-backend contract tests. Those tests run under `cargo nextest`. The GCS cases are `#[ignore]` and need cloud credentials.

## Full self-hosted stack

For a real, persistent deployment instead of a throwaway testnet, use the **`pubky-infra`** skill:

- [`local-stack.md`](../../pubky-infra/references/local-stack.md): the local compose stack.
- [`homeserver.md`](../../pubky-infra/references/homeserver.md): real homeserver config and admin API.
- [`signup-gating.md`](../../pubky-infra/references/signup-gating.md): signup tokens and invite gating.
- [`operator-cli.md`](../../pubky-infra/references/operator-cli.md): `pubky-cli admin` flows.
- [`dns-and-relays.md`](../../pubky-infra/references/dns-and-relays.md), [`http-relay.md`](../../pubky-infra/references/http-relay.md), [`nexus-operations.md`](../../pubky-infra/references/nexus-operations.md): relays and Nexus.
