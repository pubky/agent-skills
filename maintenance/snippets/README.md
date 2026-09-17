# Snippet verification harness

Templates and the shared-testnet manager used by the **Snippet** stage of
`../sync-references.workflow.js`. The snippet-test agent copies a template into a unique
temp dir (`mktemp -d`) — it never mutates these files or the repo — and verifies each
snippet at the highest tier it can reach.

## Tiers

| Tier | Meaning | Applies to |
| --- | --- | --- |
| `executed` | Run end-to-end (signup→put→get…) against the **shared testnet** and asserted | JS, Rust |
| `compiled` | `tsc --noEmit` (JS/RN), `cargo clippy -D warnings` (Rust), `swift build`, `gradle compileDebugKotlin` against the pinned bindings | JS, RN, Rust, Swift, Kotlin |
| `surface` | method+path+response-schema validated against an OpenAPI doc (optional read-only `curl`) | Nexus / HTTP |
| `lint` | String-Contract + **mandatory Android `RustlsInit.initPlatformVerifier`** checks (a missing init compiles but panics at runtime) | RN, Swift, Kotlin |

Downgrading a snippet below its `expectedTier` is a pipeline failure, not a silent pass.

## Pinned versions (what users install)

`js/package.json` and `rust/Cargo.toml` pin the **latest published** packages
(`@synonymdev/pubky` 0.12.0, `pubky-app-specs` 0.7.0, crate `pubky` =0.12.0), recorded in
`../sources.lock.json`. A version-drift check flags when npm/crates latest moves past these.

## Shared testnet

The testnet binds fixed ports, so there is exactly **one** instance. `testnet.sh` starts it
before the workflow and stops it after; snippet agents **connect**, never start their own.

```bash
maintenance/snippets/testnet.sh start      # build (if needed) + run; waits for readiness
maintenance/snippets/testnet.sh endpoints  # JSON: pkarrRelay/httpRelay/homeserverPubky
maintenance/snippets/testnet.sh stop       # graceful SIGTERM; drops ephemeral DBs
```

Prereq: native **Postgres 18** at `localhost:5432` with a `CREATEDB` role
(`brew services start postgresql@18`). No Docker required — the testnet uses the
external-Postgres path (`?pubky-test=true` ephemeral DBs).
