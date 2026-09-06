# Testing and the local testnet

Pubky app-dev testing has **three surfaces, all backed by the same `pubky-testnet` harness**.
Pick by how your client connects:

| Surface | Use it for | Entry point |
| :-- | :-- | :-- |
| In-process Rust tests | `#[tokio::test]` against an ephemeral homeserver, fully offline | `EphemeralTestnet` (the `pubky-testnet` lib) |
| Standalone local testnet process | browser / JS-WASM / CLI clients that connect over the network | `cargo run -p pubky-testnet` (a.k.a. `npm run testnet`) |
| Shell scripting | scripted signup / put / get flows | the `pubky-cli` binary |

For operating the **full self-hosted backend stack** (homeserver + Nexus + DNS in Docker) — not
a throwaway test net — see [Full self-hosted stack](#full-self-hosted-stack) below.

Upstream (authoritative, drift-prone — link, don't memorize):
[`pubky-testnet` README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md) ·
[docs.rs/pubky-testnet](https://docs.rs/pubky-testnet).

## Surface 1: Rust in-process tests

The `pubky-testnet` crate (workspace version **0.9**) exposes three types:

- **`EphemeralTestnet`** (+ `EphemeralTestnetBuilder`) — one test DHT + homeserver per test;
  the canonical choice for `#[tokio::test]`.
- **`StaticTestnet`** — the hardcoded-wiring net behind the standalone binary (Surface 2).
- **`Testnet`** — the flexible base both build on.

It re-exports the core crates `pubky`, `pubky_common`, `pubky_homeserver`, plus
`drop_test_databases` and the `test` macro (`pubky_test_utils::test`). The `docker_postgres`
module is gated behind the `docker-postgres` feature.

```rust
use pubky_testnet::EphemeralTestnet;

#[tokio::test]
#[pubky_testnet::test] // Macro ensures ephemeral Postgres databases are cleaned up
async fn my_test() {
    // Run a new testnet. This creates a test DHT and homeserver.
    // By default, uses minimal_test_config() (admin/metrics disabled, no HTTP relay).
    let testnet = EphemeralTestnet::builder().build().await.unwrap();

    // Create a Pubky Http Client from the testnet.
    let client = testnet.client().unwrap();

    // Use the homeserver
    let homeserver = testnet.homeserver_app();
}
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md)</sub>

The `#[pubky_testnet::test]` macro drops the ephemeral Postgres database(s) when the test
finishes **or panics** — keep it on every test.

**`EphemeralTestnetBuilder` API** (signatures you'll actually call):

- `.config(ConfigToml)` — default is `minimal_test_config()` (admin + metrics disabled, no HTTP
  relay). Use `ConfigToml::default_test_config()` if your test needs the **admin server**.
- `.keypair(Keypair)` — fix the homeserver keypair.
- `.postgres(ConnectionString)` — point at an external Postgres.
- `.with_http_relay()` — start an HTTP relay (off by default); read it via `testnet.http_relay()`.
- `.with_docker_postgres()` — run Postgres in a Docker container (feature `docker-postgres`).
- `.postgres(...)` and `.with_docker_postgres()` are **mutually exclusive** — `build()` returns
  an error if both are set.

Accessors on the built testnet: `.client()` (`PubkyHttpClient`), `.sdk()` (the `Pubky` facade,
pre-wired to this net), `.homeserver_app()`, `.http_relay()`, `.pkarr_client_builder()`.
(`EphemeralTestnet` has **no** `.pkarr_relay()` — that accessor exists only on `StaticTestnet`.)

> `with_embedded_postgres()` / the `embedded-postgres` feature are **deprecated since 0.9.0** —
> use `with_docker_postgres()` / `docker-postgres`.

A complete runnable program (offline app test against an ephemeral homeserver). `cargo run --bin
testnet` uses Docker Postgres; `-- --external-postgres` uses an external DB. `testnet.sdk()`
yields a `Pubky` facade already pointed at this net:

```rust
use clap::Parser;
use pubky_testnet::{
    pubky::{ClientId, Keypair},
    EphemeralTestnet,
};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    external_postgres: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let mut builder = EphemeralTestnet::builder();
    #[cfg(feature = "docker-postgres")]
    let builder = if !args.external_postgres { builder.with_docker_postgres() } else { builder };

    let testnet = builder.build().await?;
    let homeserver = testnet.homeserver_app();
    let pubky = testnet.sdk()?;

    let signer = pubky.signer(Keypair::random());
    signer.signup(&homeserver.public_key(), None).await?;
    let session = signer.signin(ClientId::new("testnet.example")?).await?;

    session.storage().put("/pub/my-cool-app/hello.txt", "hi").await?;
    let txt = session.storage().get("/pub/my-cool-app/hello.txt").await?.text().await?;
    assert_eq!(txt, "hi");
    println!("Roundtrip succeeded: {txt}");
    Ok(())
}
```

<sub>Source: [`examples/rust/1-testnet/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/1-testnet/main.rs)</sub>

## PostgreSQL is required

The testnet **requires PostgreSQL** — it is no longer in-memory/embedded SQLite. Older docs or
snippets showing an SQLite testnet are stale. Two ways to supply Postgres:

**(A) Docker-managed (no DB install).** Enable the `docker-postgres` feature so testcontainers
runs Postgres in a container — **Docker must be running**. The container is auto-cleaned on drop
and on Ctrl+C/SIGTERM.

```rust
// Cargo.toml
// [dev-dependencies]
// pubky-testnet = { version = "0.9", features = ["docker-postgres"] }

use pubky_testnet::EphemeralTestnet;

#[tokio::main]
async fn main() {
    let testnet = EphemeralTestnet::builder()
        .with_docker_postgres()
        .build()
        .await
        .unwrap();
}
```

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md)</sub>

Each `.with_docker_postgres()` starts a **separate** container. For a test suite, start **one**
container with `DockerPostgres::shared()` (returns `&'static DockerPostgres`) and pass its
`.connection_string()` to `.postgres(...)`. Each testnet still gets its own ephemeral DB inside
the shared instance, so tests stay isolated:

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

<sub>Source: [`pubky-testnet/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md)</sub>

**(B) External Postgres.** Without `docker-postgres`, the testnet defaults to
`postgres://localhost:5432/postgres?pubky-test=true`. The `?pubky-test=true` query parameter
tells the homeserver (compiled with the `testing` feature) to create an **ephemeral test
database** that is dropped after the test. Override the connection via the
`TEST_PUBKY_CONNECTION_STRING` env var or `.postgres(ConnectionString::new(...))`.
[`docs/DEV_TESTING_GUIDES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEV_TESTING_GUIDES.md)
gives the canonical local-Postgres one-liner (auto-creates the `pubky_homeserver` DB):

```bash
docker run --name postgres \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pubky_homeserver \
  -p 127.0.0.1:5432:5432 -d postgres:18-alpine
```

> Docker Hub anonymous pulls are rate-limited (100 / 6h). Pre-pull `postgres` or `docker login`
> if you hit it.

## Surface 2: standalone local testnet

`cargo run -p pubky-testnet` runs a `StaticTestnet` with **hardcoded wiring** so out-of-process
clients (browsers, JS/WASM, `pubky-cli`) can connect. It logs `Testnet running` when ready and
tears everything down (including ephemeral databases via `drop_test_databases()`) on Ctrl+C.
Accepts an optional `--homeserver-config <path>`.

| Component | Port / value |
| :-- | :-- |
| DHT bootstrap node | `6881` |
| Pkarr relay | `15411` |
| HTTP relay | `15412` |
| Homeserver — ICANN HTTP | `6286` |
| Homeserver — Pubky HTTP | `6287` |
| Homeserver — admin server | `6288` (admin is **enabled** in the static testnet) |
| Homeserver keypair | derived from secret `[0u8; 32]` |
| Homeserver public key (z32) | `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` |
| Homeserver public key (display) | `pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo` |

The z32 vs `pubky`-prefixed display forms are the same key in different renderings — use the
right one for the right call (see [`concepts.md` — public-key string formats](concepts.md#public-key-string-formats)).
JS `PublicKey.from(...)` takes the display form; `pubky-cli signup <homeserver-pk>` takes the
bare z32 form.

**`npm run testnet`** is defined in the in-repo JS SDK package
([`pubky-sdk/bindings/js/pkg/package.json`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/package.json))
as exactly `"cargo run -p pubky-testnet"` — a thin alias for the Rust binary. It therefore
**requires the Rust toolchain** (and Postgres/Docker per the DB requirement above); it is not a
pure-JS server. Run it from the SDK package dir and wait for `Testnet running` before pointing
examples at it. (In-repo package is `@synonymdev/pubky` 0.9.0; the published npm package runs
ahead — the JS snippet below was verified against 0.9.3.)

**JS examples** live in
[`examples/javascript/*.mjs`](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript)
(Node 20+). Setup: build the local SDK (`cd pubky-sdk/bindings/js/pkg && npm install && npm run
build`), then `cd examples/javascript && npm install` (they depend on the local
`@synonymdev/pubky` via `file:../../pubky-sdk/bindings/js/pkg`). Scripts taking `--testnet`
expect a running local testnet in another terminal. Run **`0-check-testnet.mjs` first** — it does
an authenticated signup → signin → write → read roundtrip and does not depend on public PKDNS
resolution. Expected output: `Testnet is available, roundtrip succeeded.`

```js
import { Pubky, Keypair, PublicKey } from "@synonymdev/pubky";

// This is the default testnet homeserver. It comes from the secret `00000...` (bits).
const TESTNET_HOMESERVER =
  "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";

// 1) Build Pubky SDK facade for local testnet host
const pubky = Pubky.testnet();

// 2) Make a random keypair, bind it to a signer and sign up on the given homeserver
const keypair = Keypair.random();
const signer = pubky.signer(keypair);
const homeserver = PublicKey.from(TESTNET_HOMESERVER);
await signer.signup(homeserver);

// 3) Sign in to create a root-capability session for storage access
const session = await signer.signin();

// 4) Write then read a file under /pub/<your.app>/
const path = "/pub/my-cool-app/hello.txt";
await session.storage.putText(path, "hi");
const roundtrip = await session.storage.getText(path);
```

<sub>Source: [`examples/javascript/0-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/0-check-testnet.mjs)</sub>

> The upstream example calls `signer.signin("my-cool-app.example")`, but the published 0.9.x JS
> SDK declares `signin(): Promise<Session>` (zero args, returns a root-capability session). The
> argument is vestigial — plain JS ignores it, but TypeScript rejects it (`TS2554`). Omit it.
> (The Rust path differs: `signin(ClientId::new(...))` does take an arg.)

## Surface 3: scripting with pubky-cli

`pubky-cli` is a **separate crate/repo** ([github.com/pubky/pubky-cli](https://github.com/pubky/pubky-cli),
[crates.io](https://crates.io/crates/pubky-cli)). Install with `cargo install pubky-cli` (or
`cargo install --path .` from a clone). It reuses the `pubky` SDK and the `pubky-testnet` harness,
so you can script local testing or drive a real deployment. Top-level subcommands: `user`
(client API — app-dev flows), `admin` (homeserver admin API — operator flows), and `tools`
(recovery-file generation, shell completions).

**For app development, use `user` and `tools`.** The `admin` subcommands are operator territory —
see [Full self-hosted stack](#full-self-hosted-stack).

`pubky-cli user` verbs: `signup`, `signin`, `session`, `signout`, `publish`, `get`, `delete`,
`list`, plus a third-party auth-token hand-off. For exact positional order and per-command flags,
read the [pubky-cli README](https://github.com/pubky/pubky-cli/blob/main/README.md) (pinned to an
older `pubky`; see the version-skew caveat below) rather than memorizing them here. Two points
that bite:

- **`--testnet` is required on *every* command in a local-testnet flow**, not just signup. Each
  verb runs `signin()` first, which resolves the user's homeserver record over PKDNS; without
  `--testnet` the CLI builds a public-network facade and cannot find a record published only to
  the local testnet DHT — so even `get`/`delete` fail.
- The README quick-start has a typo `--singup-code`; the correct flag is **`--signup-code`**
  (source field `signup_code`).

App-dev onboarding against a local testnet. The recovery passphrase comes from
`PUBKY_CLI_RECOVERY_PASSPHRASE` (otherwise prompted interactively). `<homeserver-pk>` for the
static testnet is `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`:

```bash
# 1) Create a recovery file and note the printed public key
pubky-cli tools generate-recovery ./alice.recovery --passphrase pass

# 2) Sign up (replace <homeserver-pk> with your server's public key)
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user signup <homeserver-pk> ./alice.recovery --testnet

# 3) Sign in to establish a session
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user signin ./alice.recovery --testnet

# 4) Publish, read, then delete data under /pub/
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user publish "/pub/my-cool-app/hello.txt" test.txt ./alice.recovery --testnet
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user get /pub/my-cool-app/hello.txt ./alice.recovery --testnet
PUBKY_CLI_RECOVERY_PASSPHRASE=pass \
  pubky-cli user delete "/pub/my-cool-app/hello.txt" ./alice.recovery --testnet
```

<sub>Source: [`pubky-cli/README.md`](https://github.com/pubky/pubky-cli/blob/main/README.md)</sub>

App-dev `tools` subcommands: `generate-recovery <path> --passphrase <p>` writes a recovery file
and prints the public key; `completions <shell> --outfile <path>` emits shell completions. Set
**`PUBKY_CLI_RECOVERY_PASSPHRASE`** to auto-decrypt recovery files (used above; handy in CI). The
remaining env vars (PKARR bootstrap/relay/timeout overrides, admin password) are listed in the
[README](https://github.com/pubky/pubky-cli/blob/main/README.md).

> **Version skew — flag this when recommending pubky-cli.** `pubky-cli` is itself pre-release
> (`0.1.0-rc.1`) and pins `pubky = "0.6.0-rc.6"` / `pubky-testnet = "0.6.0-rc.6exp"` —
> markedly **older** than pubky-homeserver's current `0.9.0` SDK/testnet. Its SDK behavior and flags
> may lag the current `pubky` crate; do not assume parity with 0.9.x semantics.

## Writing correct tests

- **Only `/pub/*` is reachable.** `GET`/`HEAD` are public; `PUT`/`DELETE` require a session with
  a write capability; anything outside `/pub/` (e.g. `/priv/...`) returns **`403 Forbidden`**
  regardless of capability. A test that writes to a non-`/pub` path fails **by design, not by
  bug**. This is shared protocol behavior — see
  [`concepts.md` — addressing and the /pub tree](concepts.md#addressing-and-the-pub-tree).
- **Don't exercise unshipped features in tests.** No `/priv` private storage,
  encrypted/guarded data as a general primitive, homeserver mirroring, backup *restore*, cloud
  backup, or two-way sync. Full guardrail: [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Facade construction (testnet vs mainnet)** is documented canonically — mainnet `new Pubky()`
  / `Pubky::new()`, testnet `Pubky.testnet()` / `Pubky::testnet()` (localhost wiring), or wrap a
  custom client. See [`concepts.md` — clients](concepts.md#homeserver-write-vs-nexus-read); don't
  restate it here.

## Full self-hosted stack

For a real, persistent deployment (not a throwaway test net), switch to the **`pubky-infra`**
skill:

- [`local-stack.md`](../../pubky-infra/references/local-stack.md) — `pubky-docker` compose
  profiles, `.env` image tags, `pubky-docker-cli.sh`.
- [`homeserver.md`](../../pubky-infra/references/homeserver.md) — run a real homeserver
  (Docker/cargo), `config.toml`, admin API on `:6288`, signup tokens.
- [`operator-cli.md`](../../pubky-infra/references/operator-cli.md) — `pubky-cli admin` flows:
  invite/signup tokens, server stats, enable/disable users, WebDAV admin.

This reference covers only the developer/test-net slice and `pubky-cli user` / `tools`;
admin/operator usage of `pubky-cli` lives in `pubky-infra` to keep triggers disjoint.

## Upstream references

- `pubky-testnet`: [README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-testnet/README.md) ·
  [docs.rs](https://docs.rs/pubky-testnet)
- Examples: [JS](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript) ·
  [Rust](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust)
- Postgres / test-DB notes:
  [`docs/DEV_TESTING_GUIDES.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/DEV_TESTING_GUIDES.md)
- `pubky-cli`: [repo](https://github.com/pubky/pubky-cli) ·
  [crates.io](https://crates.io/crates/pubky-cli)
