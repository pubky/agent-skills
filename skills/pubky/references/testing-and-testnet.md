# Testing and the local testnet

App-dev testing uses the `pubky-testnet` harness in one of three ways. Pick the one that matches how your client connects:

| Surface | Use it for | Entry point |
| :-- | :-- | :-- |
| In-process Rust tests | `#[tokio::test]` against an isolated DHT and homeserver. Works offline and is safe to run in parallel. | `EphemeralTestnet` (library) |
| Standalone local testnet | Browsers, JS/WASM, mobile, example scripts and manual debugging, on fixed ports | `cargo install pubky-testnet --version 0.18.0`, then `pubky-testnet` (no checkout needed). From a checkout: `cargo run -p pubky-testnet` or `npm run testnet` |
| Shell or script-driven app flows | Scripted signup, put, get and session management | The upstream example programs ([below](#scripting-app-dev-flows)). `pubky-cli` is **deprecated**. |

For a real, persistent deployment (compose, homeserver config, admin API, signup tokens), see [Full self-hosted stack](#full-self-hosted-stack).

**Versions (checked 2026-11-12):**
- The `pubky-homeserver` workspace is **0.18.0**. `pubky`, `pubky-common`, `pubky-homeserver` and `pubky-testnet` are all pinned to 0.18.
- On crates.io, `pubky-testnet` and `pubky` are **0.18.0** (released 2026-11-09). The previous releases are 0.17.1 (2026-10-26) and 0.16.2. No 0.17.0 was published.
- On npm, `@synonymdev/pubky` `latest` is **0.18.0**. Ignore the `next` (0.6.0-rc.7) and `alpha` (0.10.0-alpha.0) dist-tags: both are older than `latest`.
- **MSRV: Rust 1.91+ everywhere.** That covers the crates.io dependency, `cargo install`, and building from a checkout (`cargo run -p pubky-testnet`, `npm run testnet`, the examples). The old split between 1.89 on crates.io and 1.91 in a checkout no longer applies.
- Pubky is pre-1.0, so expect breaking changes.

Upstream is authoritative and changes often:
[`pubky-testnet` README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md) ·
[docs.rs/pubky-testnet 0.18.0](https://docs.rs/pubky-testnet/0.18.0/pubky_testnet/) ·
[`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md) (contributor guide).

## Rust in-process tests (`EphemeralTestnet`)

- **`EphemeralTestnet`** is for automated tests. It uses random ports and gives each instance its own DHT and homeserver, so tests can run in parallel. It starts **no pkarr relay**.
- **`StaticTestnet`** is for interactive use on fixed ports. See [Standalone local testnet](#standalone-local-testnet).
- **Re-exports:** `pubky`, `pubky_common`, `pubky_homeserver`, plus `drop_test_databases` and the `test` macro (both from `pubky_test_utils`), and `EphemeralTestnet`, `StaticTestnet`, `Testnet` and their builders. Default features are `[]`. The `docker_postgres` module needs the `docker-postgres` feature, which pulls in testcontainers. The full list is on [docs.rs](https://docs.rs/pubky-testnet/0.18.0/pubky_testnet/).

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

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/pubky-testnet/README.md#L65-L81). Compiled and passed with `cargo test` on `pubky-testnet` 0.18.0 against a local Postgres. The cleanup macro dropped the test database. `client` and `homeserver` are unused placeholder bindings. It needs a reachable Postgres server (see [PostgreSQL is required](#postgresql-is-required)).</sub>

**`EphemeralTestnetBuilder`**: `build()` returns `anyhow::Result<EphemeralTestnet>`.

| Method | Effect / default |
| :-- | :-- |
| `.config(ConfigToml)` | Defaults to `ConfigToml::minimal_test_config()`, which has **admin and metrics disabled**. |
| `.keypair(Keypair)` | Defaults to `Keypair::from_secret(&[0; 32])`, a deterministic keypair (`8pinx…`). |
| `.postgres(ConnectionString)` | Uses this Postgres server. |
| `.with_http_relay()` | Starts an HTTP relay. **Off** by default. |
| `.with_docker_postgres()` | Starts a dedicated Postgres container for this testnet. Needs the `docker-postgres` feature. |

If you set both `.postgres()` and `.with_docker_postgres()`, `build()` **errors** with `Cannot use both docker postgres and a custom connection string…`.

**Signup tokens:** `minimal_test_config()` and `default_test_config()` both set `signup_mode = Open`, so **`EphemeralTestnet` and the default in-memory static testnet need no signup token**. A static testnet started with `persist` or `--homeserver-config` *does* need one; see [below](#standalone-local-testnet).

**Accessor gotchas** ([docs.rs](https://docs.rs/pubky-testnet/0.18.0/pubky_testnet/struct.EphemeralTestnet.html)):

- `client()` returns `Result<PubkyHttpClient, BuildError>` and `sdk()` returns `Result<Pubky, BuildError>`. Both are already wired to this testnet. Unwrap them or use `?`.
- `homeserver_app()` returns `&HomeserverApp`.
- `http_relay()` **panics** with `no http relay configured - use .with_http_relay() when building` unless you built with `.with_http_relay()`.
- Only `StaticTestnet` has `pkarr_relay()`, `bootstrap_nodes()` and `is_persistent()`. `EphemeralTestnet` has none of them.
- For extra homeservers, use `create_random_homeserver()` or `create_random_homeserver_with_config(Option<ConfigToml>)`. These use `Keypair::random()`, not the `8pinx…` key.
- The testnet client disables the default pkarr network, uses only the local bootstrap, and sets **100 ms** `dht_request_timeout` and `relay_request_timeout`. These settings are for tests only. **Don't copy them into production client config.**

> **Use the builders, not the deprecated constructors.** `EphemeralTestnet::start()` (deprecated since 0.5.0) is **not** the same as `builder().build()`: it uses `default_test_config()`, which has admin enabled, and it also starts an HTTP relay. These are also deprecated:
> - `start_with_custom_postgres` and `start_minimal*`
> - `StaticTestnet::start_with_homeserver_config` (since 0.9.0)
> - `with_embedded_postgres`, the `embedded_postgres` module and the `embedded-postgres` feature, which are aliases for the `docker-postgres` equivalents (since 0.9.0)

The program below does an offline app roundtrip. Run it from `examples/rust` with `cargo run --bin testnet`. The examples crate enables `docker-postgres` by default, so Docker must be running. To use `TEST_PUBKY_CONNECTION_STRING` or the default server instead, add `-- --external-postgres`. Rust's `signin` takes a `ClientId`.

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

<sub>Source: [`examples/rust/8-testnet/main.rs`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/examples/rust/8-testnet/main.rs) (verbatim). Ran on 0.18.0 with Docker Postgres and printed `Roundtrip succeeded: hi`, leaving no container or volume behind. It starts its own `EphemeralTestnet`, so it needs no running testnet. Building it from a checkout needs Rust 1.91+. The program never calls `drop_test_databases()`, so each run on the external-Postgres path leaks one `pubky_test_{uuid}` database.</sub>

> **Upstream doc drift:** two upstream docs describe the Postgres fallback wrongly.
> - The `--external-postgres` doc comment above and the example's README say the fallback is `postgres://postgres:postgres@…`.
> - The `EphemeralTestnetBuilder` rustdoc says it falls back to an "in-memory" database, but no in-memory database exists.
>
> The real default in the code is `postgres://localhost:5432/postgres`, **with no credentials**. If your Postgres needs a password, set `TEST_PUBKY_CONNECTION_STRING` explicitly.

## PostgreSQL is required

Every testnet needs a reachable **Postgres server**. For tests and for the in-memory static testnet, the homeserver **always** creates a fresh `pubky_test_{uuid}` database on that server. It picks the server in this order:

1. An explicit URL: builder `.postgres(..)`, Docker Postgres, or `database_url` in the config.
2. The `TEST_PUBKY_CONNECTION_STRING` env var. An invalid value is an error (`Invalid TEST_PUBKY_CONNECTION_STRING: …`), not a fallback.
3. The default, `postgres://localhost:5432/postgres` (no credentials).

> **Leaked databases:** dropping a testnet only *registers* its test DB for cleanup. The DB is deleted only by `#[pubky_testnet::test]`, or by calling `pubky_testnet::drop_test_databases().await` **after** the testnet is dropped. If neither runs, `pubky_test_{uuid}` databases pile up on your Postgres server.

**(A) Your own Postgres:**

```bash
docker run --name pubky-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 \
  -d postgres:18

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo test -p my-crate
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/pubky-testnet/README.md#L11-L90). Flags, image tag and cargo invocation were checked; the container was not started. Replace `my-crate` with your crate.</sub>

**(B) Docker-managed Postgres (testcontainers):**
- Add `pubky-testnet = { version = "0.18", features = ["docker-postgres"] }` to your dev-dependencies. **Docker must be running.**
- Containers are removed when they are dropped, on SIGINT/SIGTERM (the testcontainers watchdog), and, for the shared container, at normal process exit. **`kill -9` still leaves containers behind.**
- Each `.with_docker_postgres()` starts its **own** container, which is slow across a whole test suite. Share one container instead. Each testnet still gets its own isolated database inside it.

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

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/pubky-testnet/README.md#L142-L176). Compiled and passed with `cargo test` on 0.18.0 with Docker running. No containers or volumes were left behind.</sub>

- The upstream snippet above leaves out `#[pubky_testnet::test]`. **Add it.** Without it, test databases pile up inside the shared container for the whole run.
- `DockerPostgres::shared()` returns `&'static DockerPostgres` and **panics if Docker isn't running** (`Failed to start shared Docker postgres. Is Docker running?`). To handle that error instead, use `DockerPostgres::start()`, which returns `anyhow::Result<Self>`.
- `connection_string()` returns `anyhow::Result<ConnectionString>`, in the form `postgres://postgres:postgres@host:port/postgres`.
- **Volume leak in 0.9.0–0.16.2 only:** in those versions, removing the shared container at exit leaves its anonymous Postgres volumes behind. Clean them up with `docker volume prune`. The fix (`docker rm -f -v`, #710) shipped in 0.17.1 and 0.18.0, so upgrade.

## Standalone local testnet

`pubky-testnet` runs a `StaticTestnet` on fixed ports, so clients in other processes can connect. Start it with the installed binary or with `cargo run -p pubky-testnet`.

- **CLI:** `pubky-testnet [--homeserver-config <PATH>] [persist <data_dir>]`. `--homeserver-config` is a top-level flag, so it must come **before** `persist`.
- **Readiness:** it logs `Testnet running`, followed by the DHT bootstrap nodes, the pkarr relay, the HTTP relay, the ICANN HTTP and Pubky HTTPS URLs, and the admin URL. It logs the metrics URL **only if metrics are enabled**. **Wait for `Testnet running` before you connect.**

| Component | Port / value |
| :-- | :-- |
| DHT bootstrap | `6881` |
| Pkarr relay | `15411` |
| HTTP relay | `15412` |
| Homeserver ICANN HTTP | `6286` |
| Homeserver Pubky HTTPS | `6287` |
| Homeserver admin | `6288` (**forced on**) |
| Homeserver public key (z32) | `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` |

> **Security:** the ICANN, Pubky, admin, HTTP-relay and pkarr-relay listeners all bind to **`0.0.0.0`**. Admin is forced on at port `6288`, and the default password is **`admin`**. Don't run the static testnet on an untrusted or shared network. If you must, firewall these ports (at minimum `6288`).

The homeserver key comes from `Keypair::from_secret(&[0; 32])`, so it is the same `8pinx…` key on every run. The exceptions:
- `EphemeralTestnetBuilder::keypair()` overrides it.
- `create_random_homeserver()` uses a random key.
- A `persist` data dir that already has a `secret` file keeps that key.

The display form of the key is `pubky8pinx…`. Use the right string format for each call; see [`concepts.md`: public-key string formats](concepts.md#public-key-string-formats).

```bash
TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- persist ./my-testnet-data

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet -- --homeserver-config my-config.toml persist ./my-testnet-data

TEST_PUBKY_CONNECTION_STRING='postgres://postgres:postgres@localhost:5432/postgres' \
  cargo run -p pubky-testnet
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/pubky-testnet/README.md#L23-L44). All three invocations parse with the 0.18.0 CLI (the reversed flag order is rejected). They were not started here. In order, they start: a persistent testnet; a persistent testnet with a custom config seeded on the first run; an in-memory testnet. With an installed binary, replace `cargo run -p pubky-testnet --` with `pubky-testnet`. **The env-var prefix has an effect only on the third (in-memory) command.** See below.</sub>

**In-memory mode (the default):**
- The config is the `--homeserver-config` file, deep-merged over `config.default.toml`. Without the flag, it is `default_test_config()`. Either way, the fixed ports, DHT and admin overrides are applied on top.
- The homeserver uses a `pubky_test_{uuid}` database, chosen through the [resolution order above](#postgresql-is-required).
- On Ctrl+C it drops the testnet and calls `drop_test_databases()`.
- **With `--homeserver-config`,** the merge with `config.default.toml` gives you `database_url = postgres://localhost:5432/pubky_homeserver` and `signup_mode = "token_required"`, unless your file overrides them. That `database_url` counts as an explicit URL, so `TEST_PUBKY_CONNECTION_STRING` is **silently ignored**.

**`persist <data_dir>`:**
- **First run:** creates `config.toml`, `secret` and `data/files/` in the data dir. If there is no `secret` file, it seeds the deterministic `8pinx…` keypair. An existing `secret` is kept.
- **`--homeserver-config`** seeds `config.toml`. If `config.toml` already exists, it errors with `Remove --homeserver-config to use the existing config, or delete the file to replace it.`
- **Database:** persist mode uses **no** test database and **ignores `TEST_PUBKY_CONNECTION_STRING`**, although upstream's README says the env var overrides the on-disk `database_url`. It connects directly to `database_url` from `<data_dir>/config.toml` merged over `config.default.toml`. Unless you change it, that is `postgres://localhost:5432/pubky_homeserver`. The URL has no credentials, so the usual failures are Postgres auth errors or a missing `pubky_homeserver` database. Put credentials in `database_url` and create the database first.
- **Shutdown:** nothing is cleaned up.

**Persistent and custom-config testnets require signup tokens** because `config.default.toml` sets `signup_mode = "token_required"`. Signup fails unless you pass a token or set `signup_mode` to open in your config. The errors are `400 Token required` (no token), `401 Invalid token` and `401 Token already used`. To mint a token, run `homeservercli` against the testnet admin endpoint (password `admin`):

```bash
PUBKY_HOMESERVER_ADMIN_PASSWORD=admin \
PUBKY_HOMESERVER_ADMIN_ENDPOINT=http://localhost:6288 \
  homeservercli signup-tokens generate
```

<sub>Derived from [`homeservercli/src/config.rs`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/homeservercli/src/config.rs). Ran against a local static testnet (0.18.0); it prints one token such as `KYQ9-7E9J-WVD0`, and a wrong password gives `Error: missing or invalid admin password`. `homeservercli` is **not on crates.io**, so don't suggest `cargo install homeservercli`. Install it from a `pubky-homeserver` checkout with `cargo install --path homeservercli`, or run it with `cargo run -p homeservercli -- …`. Pass the password and endpoint as flags or env vars as shown: when no `config.toml` exists in its data dir (default `~/.pubky`), it errors with `Missing admin password…`. For operator usage, see [`operator-cli.md`](../../pubky-infra/references/operator-cli.md#homeservercli).</sub>

### `npm run testnet` and installing without a checkout

- **`npm run testnet`** in the JS SDK package (`pubky-sdk/bindings/js/pkg`) is literally `cargo run -p pubky-testnet`. The same script is in the repo and in the published 0.18.0 `package.json`. **It is not a JS server.** It needs Rust 1.91+, a `pubky-homeserver` checkout and Postgres. Run it from `pubky-sdk/bindings/js/pkg`.
- **Without a checkout** (for example, JS or mobile developers): run `cargo install pubky-testnet --version 0.18.0`, then `pubky-testnet`. You still need Rust 1.91+ and Postgres.

### Pointing clients at it

- **Defaults:** Rust `PubkyHttpClient::testnet()` / `Pubky::testnet()` and JS `Pubky.testnet()` / `Client.testnet()` connect to `localhost`.
- **Another host:** `testnet_with_host(host)` sets the pkarr bootstrap to `<host>:6881` (native only) and the relay to `http://<host>:15411`. On `wasm32`, it also stores the host to rewrite URLs.
- **Testnet on another machine or in a container:** pass its host, for example `testnet_with_host("192.168.1.50")` in Rust or `Pubky.testnet("docker-host")` in JS. Those ports must be reachable from the client.

For facade construction and client options, see [`sdk-js.md`](sdk-js.md) and [`sdk-rust.md`](sdk-rust.md).

### Docker image

To build a testnet image from the repo root:

```bash
docker build --build-arg BUILD_TARGET=testnet --build-arg BUILD_PROFILE=release -t pubky-testnet:release .
docker run --rm --network none pubky-testnet:release homeserver --help
```

<sub>Source: [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/docs/TESTING.md#L163-L189). Flags and build args were checked against the Dockerfile; the release image was not built here. The binary inside the image is named `homeserver`, not `pubky-testnet`. The image sets `CMD ["homeserver"]` with no `ENTRYPOINT`, so any arguments you pass replace the command. It declares `EXPOSE 6287` only, so publish the other ports yourself.</sub>

Release CI also publishes a prebuilt image, [`synonymsoft/homeserver-testnet`](https://hub.docker.com/r/synonymsoft/homeserver-testnet/tags) (tags `v0.18.0`, `v0.17.1`, `latest` and commit SHAs; amd64 and arm64), built with `BUILD_TARGET=testnet`. It is not documented for app developers upstream, so pin a version tag and still provide Postgres.

### JS against the local testnet

The JS examples are in [`examples/javascript`](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript). They need Node 20+ (`.nvmrc` is `24`). The Vite examples (`2-auth-flow`, `5-browser-session-persistence`) need Node `^20.19.0 || >=22.12.0`.

1. Build the SDK: `cd pubky-sdk/bindings/js/pkg && npm install && npm run build`. `build` runs `cargo run --bin bundle_npm`, so this step also needs Rust.
2. `cd examples/javascript && npm install`
3. From the repo root, run `cargo run -p pubky-testnet` and wait for `Testnet running`.
4. Run **`node 6-check-testnet.mjs` first**. The expected output is `Testnet is available, roundtrip succeeded.`

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

<sub>Adapted from [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/8612a646b2fc0dd26cbecaf3f62366d04d381b03/examples/javascript/6-check-testnet.mjs). The `try/catch` body is unwrapped, and `TESTNET_HOMESERVER` is inlined from `_testnet.mjs`. Type-checked (`tsc --noEmit`, strict) and run end to end with `@synonymdev/pubky` 0.18.0 against a local in-memory static testnet; `roundtrip` was `"hi"`. It needs a testnet with open signup (the default in-memory mode).</sub>

**JS signatures that break older code** (`@synonymdev/pubky` 0.18.0 `pubky.d.ts`):

- `signer.signup(homeserver: PublicKey, signup_token?: string | null): Promise<void>`. The token is optional, and the call **returns no session**, so call `signin(clientId)` next.
- **Signup token failures:** the server returns 400 `Token required`, or 401 `Invalid token` / `Token already used`. The `signup` JSDoc still says `AuthenticationError`. For how to branch on the error, follow [`auth.md`: signup tokens](auth.md#signup-tokens) and [`sdk-js.md`: error handling](sdk-js.md#error-handling).
- `signer.signin(client_id: string): Promise<Session>` and `signinBlocking(client_id: string): Promise<Session>` both take a client ID.
- `Pubky.testnet(host?: string | null): Pubky`.
- `PublicKey.from(...)` also accepts the display form `pubky8pinx…`. The CI-verified [knowledge-base snippet](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f2775946130500a390b7b2bc81a52/snippets/js/src/developer-guide.ts#L16-L36) passes the display form with `signup(homeserver, null)` and then calls `signin("myapp.example")`.
- **pubky-ai-kit's "Testing Strategies" is stale.** It does `const session = await signer.signup(homeserver, null)` and asserts on the return value, which is `void`. It also uses a placeholder homeserver key. Rewrite it as signup, then `signin(clientId)`, against `8pinx…`. Its `Pubky.testnet()` and `session.storage.putJson/getJson/delete` calls are still current.

**Troubleshooting:**

| Symptom | Cause |
| :-- | :-- |
| `ECONNREFUSED` | The testnet isn't running or is still starting. |
| `PkarrError: No HTTPS endpoints found` | The testnet isn't ready, or the key isn't resolvable yet. Run `6-check-testnet` first. |
| `401` on storage | No valid session, for example a write after `signout`. On 0.18.0 that write throws an error named `CredentialRefreshError` (`statusCode` 401). |
| `403` | The path is outside `/pub/` and `/priv/`, belongs to another user, or no capability covers it. |
| Signup 400 `Token required` | You are on a `persist` or `--homeserver-config` testnet (`token_required`) and passed no token. |
| Signup 401 `Invalid token` / `Token already used` | The token is wrong or was already consumed. |

Don't use `3-storage.mjs` (an addressed public read) as your first smoke test, because PKDNS publication can lag.

## Scripting app-dev flows

> **`pubky-cli` is deprecated, and its GitHub repo is archived.** Its README says development moved to `homeservercli`. The only release is still `0.1.0-rc.1` (2025-10-23), which pins `pubky 0.6.0-rc.6` and `pubky-testnet 0.6.0-rc.6exp`, far behind 0.18. **Don't recommend it for app-dev scripting.** `homeservercli` does **not** replace it either: it is admin-only (`info`, `signup-tokens generate`, `users enable|disable|quota-get|quota-set`) and has no user signup, put or get commands. For legacy operator notes, see [`operator-cli.md`: pubky-cli (legacy)](../../pubky-infra/references/operator-cli.md#pubky-cli-legacy-archived).

To script app flows against a running standalone testnet, use the upstream example programs. They track the current SDK.

- **JS** (from `examples/javascript`):
  - `node 1-signup.mjs [homeserver_pubky] [--recovery-file <path>] [--signup-code <code>] [--testnet]`
  - `node 3-storage.mjs <pubky>/<abs-path> [--testnet]`
  - `node 4-request.mjs <METHOD> <URL> [--testnet]`
  - `node 8-session-management.mjs --testnet list|create|delete <grant-id>`
- **Rust** (from `examples/rust`): the example binaries take `--testnet`, for example `cargo run --bin signup -- --testnet`. This includes signup, storage, request, sessions, authenticator, auth_client and events_stream.
  - The default recovery file is `examples/sample_recovery.key` (empty passphrase), resolved from the crate directory, so it works from any cwd. It is **testnet only**: without `--testnet`, the examples panic and require `--recovery-file`.
  - `signup` accepts `--signup-code`.
  - Examples 7 and 8 start their own `EphemeralTestnet` and need no running testnet.

For exact arguments, see the [Rust examples README](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust) and the [JS examples README](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/README.md). For anything more involved, write a short program with the SDK; see [`sdk-js.md`](sdk-js.md) or [`sdk-rust.md`](sdk-rust.md).

## Writing correct tests

- **Storage paths:** write under `/pub/<your.app>/`. The `/pub` path layout is **not stabilized** (pre-1.0). Paths outside `/pub/` and `/priv/` return `403`. See [`concepts.md`: storage roots and access](concepts.md#storage-roots-and-access).
- **`/priv` is ALPHA (v0.10.0+) and not for production.** It is access-controlled but *not* encrypted, so the operator can read it. Test it only with that caveat stated. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Don't test planned features:** encrypted/guarded data as a general primitive, homeserver mirroring, backup restore, cloud backup or two-way sync. See [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Contributors to `pubky-homeserver` itself** (not app developers): see [`docs/TESTING.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/TESTING.md). It covers:
  - `cargo test -p pubky-homeserver --all-features`, `cargo test -p pubky-testnet --features docker-postgres`, `cargo test -p e2e` and `cargo test --workspace --all-features`.
  - The storage-backend contract tests (`memory::`, `file_system::`, `gcs::`), which run under `cargo nextest`. The GCS tests are `#[ignore]` and need `GOOGLE_APPLICATION_CREDENTIALS` and `GCS_BUCKET`.

## Full self-hosted stack

For a real, persistent deployment instead of a throwaway testnet, use the **`pubky-infra`** skill:

- [`local-stack.md`](../../pubky-infra/references/local-stack.md): the local compose stack.
- [`homeserver.md`](../../pubky-infra/references/homeserver.md): real homeserver config and the admin API.
- [`signup-gating.md`](../../pubky-infra/references/signup-gating.md): signup tokens and invite gating.
- [`operator-cli.md`](../../pubky-infra/references/operator-cli.md): `homeservercli` (the default) and legacy `pubky-cli`.
- [`dns-and-relays.md`](../../pubky-infra/references/dns-and-relays.md), [`http-relay.md`](../../pubky-infra/references/http-relay.md), [`nexus-operations.md`](../../pubky-infra/references/nexus-operations.md): relays and Nexus.
