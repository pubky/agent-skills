# Pubky protocol concepts

> **CANONICAL.** This file is the single source of truth for identity, `pubky://` addressing, PKARR, the
> homeserver model, and the write/read split. `pubky-mobile`, `pubky-infra`, and the other `pubky` references
> **link** to a section here. Do not restate it elsewhere.

Pubky gives each public key its own backend, built from PKARR (signed DNS records on the Mainline DHT) plus ordinary HTTP.
Resolution always starts from the key:

```
Ed25519 public key (the identity)
  -> PKARR record `_pubky` on the Mainline DHT (signed by the user)
    -> points at the user's homeserver (chosen by the user, changeable)
      -> stores the user's files under /pub
         (/priv exists but is ALPHA: not for production, not encrypted from the operator)
        -> read/written by apps through an SDK; aggregated reads go through indexers (Nexus)
```

## Versions and sources

- **Current release: 0.16.2** (2026-10-15) for Rust [`pubky`](https://docs.rs/pubky/0.16.2/pubky/), JS/WASM
  [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky), and the homeserver. Releases since 0.12.0:
  0.13.0, 0.14.0, 0.15.0, 0.16.0, 0.16.1, 0.16.2. React Native and UniFFI are covered by the `pubky-mobile` skill.
- **KB snippets are CI-checked against 0.14.0** (`@synonymdev/pubky` 0.14.0 on `main`; Rust `pubky =0.14.0` only at
  permalink `bb7232d`, since `main` no longer has Rust snippets). The KB removed most snippet files on 2026-10-02.
  Snippets lifted from those files link to the **permalink**
  [`bb7232d`](https://github.com/pubky/pubky-knowledge-base-v2/tree/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/js/src),
  because their `blob/main` URLs now return 404. Only `snippets/js/src/developer-guide.ts` remains on `main`.
- **KB docs are flat:** `https://pubky.org/<page>/`, for example [security-model](https://pubky.org/security-model/)
  and [pkarr](https://pubky.org/pkarr/). Old `explore/...` paths are gone.
- **Pin exact versions** and check signatures against docs.rs or the JS README for that version. Minor releases break
  APIs, for example v0.16.0's `feat(sdk)!: add scoped encryption keys` (#668); see the
  [release notes](https://github.com/pubky/pubky-homeserver/releases).
- Unless noted otherwise, every snippet below was **executed against a local testnet** on both 0.12.0 and 0.16.2.

## Identity: the Ed25519 keypair

An identity **is** an Ed25519 keypair. Its z-base-32 public key is the permanent identity (a "pubky"). There are no
accounts, no passwords, and no server-side recovery.

- **Whoever holds the private key is the identity.** If every copy of the key is lost, the identity cannot be recovered. A leaked key
  is a permanent compromise: changing homeservers or revoking app sessions does **not** make it safe again.
- **Apps should not hold user keys.** Get access through an authenticator (Pubky Ring), which issues a **grant** for the access
  the user approves. The app never receives the private key. See [`auth.md`](auth.md).
  - `signer.signin()` on a raw keypair creates a **root session** (`/:rw`, no encryption keys), which carries account-level
    privileges. Only key managers and trusted first-party account tools should do that.
  - **Signup is not the app's job in real flows.** Assume the user already has an account, and send them to separate onboarding if not.
- **JS `Keypair`:** `Keypair.random()`, `Keypair.fromSecret(Uint8Array(32))`, `keypair.secret()` (the raw 32-byte secret; never
  log, transmit, or store it unencrypted), `keypair.publicKey` (a getter), `keypair.createRecoveryFile(passphrase)` (returns a
  `Uint8Array`), and `Keypair.fromRecoveryFile(bytes, passphrase)`.
  - **Gotcha:** `fromSecret` with the wrong length throws a **plain string** (`"Expected secret to be 32 bytes, got N"`), not a
    `PubkyError`. Don't branch on `error.name`.

Generate a key and write a passphrase-encrypted recovery file:

```rust
use anyhow::Result;
use clap::Parser;
use pubky_common::crypto::Keypair;
use pubky_common::recovery_file::create_recovery_file;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Generate a keypair and save a passphrase-encrypted recovery file"
)]
struct Cli {
    /// Path to write the recovery file
    #[arg(short, long, default_value = "recovery.key")]
    output: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // 1) Generate a fresh keypair
    let keypair = Keypair::random();
    println!("Generated new keypair");
    println!("Public key: {}", keypair.public_key());

    // 2) Encrypt and save the recovery file
    println!("Enter a passphrase to encrypt the recovery file:");
    let passphrase = rpassword::read_password()?;

    println!("Confirm passphrase:");
    let confirm = rpassword::read_password()?;

    if passphrase != confirm {
        anyhow::bail!("Passphrases do not match");
    }

    if passphrase.is_empty() {
        println!("Warning: You entered an empty passphrase. This is not recommended for a production environment.");
    }

    let recovery_bytes = create_recovery_file(&keypair, &passphrase);
    std::fs::write(&cli.output, &recovery_bytes)?;
    println!("Recovery file written to {}", cli.output.display());

    Ok(())
}
```

<sub>Source: [`examples/rust/keygen.rs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/examples/rust/keygen.rs), unchanged since v0.12.0. Executed (clippy-clean) and round-tripped through `decrypt_recovery_file` on 0.12.0 and 0.16.2. Dependencies: `anyhow`, `clap` (derive), `pubky-common`, `rpassword = "7"`. `rpassword::read_password` needs a TTY: piped stdin fails with `Device not configured (os error 6)`.</sub>

> **Recovery-file caveat (from reading the code, not stated upstream).** The format is the spec line `pubky.org/recovery`
> (decrypt also accepts the legacy `pkarr.org/recovery`), a newline, then the encrypted 32-byte secret. Encryption is
> `pubky_common::crypto::encrypt` (XSalsa20Poly1305, random nonce). The key comes from `Argon2::default()` (argon2id) with a
> **fixed salt `"recovery"`**. With no per-file salt, the passphrase is the only protection. Fix two flaws when you adapt the example:
> - It accepts an empty passphrase with only a warning. **Reject empty or weak passphrases.**
> - `std::fs::write` uses default permissions (observed `-rw-r--r--`), so any local user can copy the file and brute-force the
>   passphrase offline. **Create it owner-only:** `OpenOptions::new().write(true).create_new(true)` plus
>   `std::os::unix::fs::OpenOptionsExt::mode(0o600)`. `mode` applies only when the file is created, so an existing 0644 file
>   keeps its permissions unless you use `create_new` or call `set_permissions`.
>
> Never publish or share recovery files.
> Source: [`recovery_file.rs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-common/src/recovery_file.rs).

**Sign up once, then sign in.** Rust `PubkySigner` methods ([docs.rs](https://docs.rs/pubky/0.16.2/pubky/struct.PubkySigner.html)):

| Method | Returns | PKDNS side effect |
| :-- | :-- | :-- |
| `signup(&self, homeserver: &PublicKey, signup_token: Option<&str>)` | `Result<()>` (**no session**) | Force-publishes `_pubky` pointing at `homeserver` |
| `signin(&self, client_id: ClientId)` | `Result<PubkySession>` | Background `publish_homeserver_if_stale(None)` |
| `signin_blocking(&self, client_id: ClientId)` | `Result<PubkySession>` | Awaits that if-stale publish. Use it when others must find the user right away. |

`signup_cookie`, `signin_cookie`, and `signin_cookie_blocking` are `#[deprecated]`.

Sign up on a testnet, sign in, then write and read one file:

```js
const pubky = Pubky.testnet();

const keypair = Keypair.random();
const signer = pubky.signer(keypair);
console.log("Your pubky:", signer.publicKey.toString());

const homeserver = PublicKey.from(
  "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

await signer.signup(homeserver, null);

const session = await signer.signin("myapp.example");

const path = "/pub/hello-world/data.json";
await session.storage.putJson(path, { message: "Hello Pubkyverse!" });

const data = await session.storage.getJson(path);
```

<sub>Source (KB CI type-checked, 0.14.0): [`snippets/js/src/developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122464fef97ce8e0f7909d13d0ee350/snippets/js/src/developer-guide.ts), with the DOM rendering trimmed. Executed against a local testnet (imports added; asserted the read-back equals the write). **Adapted:** upstream logs `signer.publicKey.z32()` as "Your pubky"; anything a person reads must use `toString()` (`pubky<z32>`), see [Public-key string formats](#public-key-string-formats). The testnet homeserver key is always `8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`. On first signup, a console **404** for `http://localhost:15411/<user-key>` is expected: the SDK checks for an existing PKARR record before publishing one. Testnet setup: [`testing-and-testnet.md`](testing-and-testnet.md).</sub>

### Public-key string formats

A `PublicKey` has two string forms. **Don't mix them up.**

| Call (Rust / JS) | Returns | Use for |
| :-- | :-- | :-- |
| `Display` / `.to_string()` · `publicKey.toString()` | `pubky<z32>` | UI, logs, human-facing IDs, addressed paths (`pubky<z32>/pub/...`) |
| `.z32()` · `publicKey.z32()` | raw z-base-32 (**52 characters**) | Hostnames (`_pubky.<z32>`), `/storage/<z32>/...` segments, the legacy `pubky-host` header, query params, serde/JSON, DB keys, cache keys |

- **Gotcha:** JS `PublicKey.from(value)` accepts raw z32 or `pubky<z32>` and strips the `pubky` prefix. It **throws** `InvalidInput`
  ("pubky:// is not supported") for `pubky://…` input, so strip the scheme and path first.
- **Gotcha:** the `/storage/{user_z32}` segment must match `^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$`, so a `pubky`-prefixed key there
  is rejected. A `pubky<z32>` value in a hostname, header, or DB key likewise won't resolve or match.

## Addressing and the /pub tree

A resource is a public key plus an **absolute path**. SDK storage APIs take these shapes:

| Form | Example | Pass it to |
| :-- | :-- | :-- |
| Absolute path | `/pub/my-app/file.json` | **Session storage** (the signed-in user's own data) |
| Address (preferred) | `pubky<z32>/pub/my-app/file.json` | **Public storage** (anyone's public data) |
| URL | `pubky://<z32>/pub/my-app/file.json` | **Public storage** (also accepted) |

JS types: `` Path = `/pub/${string}` | `/priv/${string}` `` for session storage (`/priv` is **alpha**), and
`` Address = `pubky${string}/pub/${string}` | `pubky://${string}/pub/${string}` `` for public storage, which is **always `/pub`**.
`"data.json"` and `"/myapp/data.json"` are type errors.

### Own data vs. another user's data

| You want to… | Rust | JS | Auth |
| :-- | :-- | :-- | :-- |
| Read or write **your own** data | `session.storage()` + path | `session.storage` + path | Session with a matching capability |
| Read **anyone's** public data | `pubky.public_storage()` + address | `pubky.publicStorage` + address | None |

```rust
use pubky::{ClientId, Keypair, Pubky};

let pubky = Pubky::new()?;
let session = pubky
    .signer(keypair)
    .signin(ClientId::new("my-cool-app").unwrap())
    .await?;

let storage = session.storage();
storage.put("/pub/my-cool-app/data.txt", "hi").await?;
let text = storage.get("/pub/my-cool-app/data.txt").await?.text().await?;
```

```rust
use pubky::{Pubky, PublicKey};

let pubky = Pubky::new()?;
let public = pubky.public_storage();

let file = public
    .get(format!("{user_id}/pub/example.com/file.bin"))
    .await?
    .bytes()
    .await?;

let entries = public
    .list(format!("{user_id}/pub/example.com/"))?
    .limit(10)
    .send()
    .await?;
for entry in entries {
    println!("{}", entry.to_pubky_url());
}
```

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md#storage-api-session--public), two separate `no_run` doctests. `keypair: Keypair` and `user_id: PublicKey` are doctest parameters. Both were executed against a local testnet with `Pubky::testnet()` in place of `Pubky::new()` and a previously signed-up user. `format!("{user_id}")` uses `Display` (`pubky<z32>`), the accepted addressed form.</sub>

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = a.testnet ? Pubky.testnet() : new Pubky();

// PublicStorage reads from addressed `pubky<pk>/<abs-path>` or `pubky://<pk>/<abs-path>` values
const exists = await pubky.publicStorage.exists(resource);
const stats = await pubky.publicStorage.stats(resource);
const bytes = await pubky.publicStorage.getText(resource);
```

<sub>Source: [`examples/javascript/3-storage.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/examples/javascript/3-storage.mjs). Executed against a local testnet in both address forms. `a` holds the parsed CLI args. In TypeScript, `resource` must be typed `Address`: a plain `string` from `toString()` fails with TS2322. `getText` returns a string, despite the variable name `bytes`.</sub>

JS storage surface at 0.16.2 (full reference: [JS README](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/bindings/js/pkg/README.md#storage) and [`sdk-js.md`](sdk-js.md)):
- `PublicStorage` has `get`, `getJson`, `getText`, `getBytes`, `exists`, `stats`, and `list(addr, cursor=null, reverse=false, limit?, shallow=false)`.
  - `stats` returns a `ResourceStats` with **camelCase, optional** fields, or **`undefined`** when the entry is missing. See
    [`stats.rs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/bindings/js/src/actors/storage/stats.rs). The
    JS README comment that shows snake_case fields and `null` is stale.
  - A `list` address **must end with `/`**.
- `SessionStorage` adds `putJson`, `putText`, `putBytes`, and `delete`, plus the [lock helpers](#storage-locks).

### Path rules

Paths are validated by [`StoragePath`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-common/src/storage_path.rs):

- **Absolute.** At most **255 bytes** per segment and **972 bytes** in total, measured as decoded UTF-8. This leaves room for the 52-byte
  tenant key in a 1024-byte object key.
- `%` is literal, so URL-decode **before** you construct a path.
- **Rejected:** control characters, backslashes, trailing Unicode whitespace, and `..` that climbs above the root (`TraversalAboveRoot`).
- **Scope coverage (`covers_path`, 0.16.0+):** a directory scope covers itself and its descendants; a file scope covers only itself.
  `/pub/app/` covers `/pub/app/file` but **not** `/pub/app` and **not** `/pub/app-evil/file`. Always end directory scopes with `/`.
- **A path can't be both a file and a folder.** If `/pub/app/foo` exists, writing `/pub/app/foo/bar.json` returns **409**. If anything
  exists under `/pub/app/foo/`, writing `/pub/app/foo` returns **409**.
- **`PUT` or `DELETE` on a path ending in `/` returns 400** ("Target path must be a file"). A `GET` on a path ending in `/` is a LIST.

### Scopes and data layout

- By convention, the first segment under `/pub` is a **scope**: an app domain (`pubky.app`, `mapky.app`, `bitkit.to`) or a protocol
  (`paykit`). One app may use several. Mapky writes `/pub/mapky.app/*` and reuses `/pub/pubky.app/*` for profiles. Bitkit writes
  `/pub/bitkit.to/*` and uses `/pub/paykit/*`.
- For new app data, use a domain-like folder such as `/pub/my-new-app/`. The `pubky.app` schema is in [`app-specs.md`](app-specs.md).
- **Store each independently edited record in its own file**, for example `/pub/myapp/posts/001.json` and `002.json`. A write replaces
  the whole file, so this keeps updates small, lets you load records on demand via LIST, and reduces write conflicts. Keep fields in
  one file when they are read and updated as a unit.

> The `/pub` layout is **not stabilized**. These scope conventions describe current practice only.

### Storage roots and access

| Root | Read | Write (`PUT`/`DELETE`) |
| :-- | :-- | :-- |
| `/pub/` | Public | A session for **this owner** with write capability |
| `/priv/` (**ALPHA**) | A session for this owner with read capability | A session for this owner with write capability |
| Anything else | **Forbidden** ("Reading from directories other than … is forbidden") | **403** "Writing to directories other than '/pub/' and '/priv/' is forbidden" |

> **`/priv` is alpha: not for production, not encrypted from the operator.** It shipped in homeserver v0.10.0 and is
> **access control only**: operators and the admin API can read and write all tenant data, including `/priv`. For
> confidentiality, encrypt client-side and manage the keys yourself. `/priv` does not provide sharing with other identities,
> and choosing `/priv` does not retract copies already published under `/pub`. See the guardrail in
> [`shipped-vs-planned.md`](shipped-vs-planned.md), the upstream
> [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/PRIVATE_STORAGE.md), and
> [KB private storage](https://pubky.org/private-storage/).

## PKARR resolution

PKARR associates a public key with **signed discovery records** distributed through the Mainline DHT. Posts and profiles stay on
the homeserver, never in the DHT. A record's signature proves **who authorized the discovery record**. It does **not** authenticate
the files that host serves. Upstream: [KB pkarr](https://pubky.org/pkarr/) and
[pkarr introduction](https://github.com/pubky/pkarr/blob/main/docs/introduction.md#the-trade-offs).

- **SignedPacket layout:** `public-key(32) + signature(64) + timestamp(8, big-endian µs) + compressed DNS packet (≤1000)`, at most
  **1104 bytes**. The signature is Ed25519 over the bencoded seq/timestamp and the DNS packet (BEP44). Clients accept a packet only
  when its timestamp is newer than the cached one, its signature is valid, and its DNS packet parses. See the
  [design doc](https://github.com/pubky/pkarr/blob/main/design/base.md).

> **Operational limits that change your code**
> - **Records are ephemeral.** DHT nodes drop unrefreshed records after a few hours, so republish them (see
>   [Republishing](#republishing)). PKARR is discovery, **not storage**: never put app data in it.
> - **Lookups are slow and cached.** An uncached DHT traversal can take several seconds, and client, relay, and DHT caches can
>   delay hosting changes. **Cache resolved homeservers** and invalidate them deliberately.
> - **Browsers cannot open UDP sockets, so they must use HTTP relays.** The defaults are `https://pkarr.pubky.app` and
>   `https://pkarr.pubky.org`. Relays also help native services with limited DHT reachability. These PKARR relays are separate
>   from the HTTP Relay used in auth.
> - **Cloud reachability varies.** Direct DHT access has shown low reachability on some AWS and GCP deployments, with no single
>   established cause. A relay helps only if the relay itself has working DHT connectivity, and relay clients can still time out on
>   uncached lookups ([pkarr#240](https://github.com/pubky/pkarr/issues/240)). See
>   [KB mainline-dht](https://pubky.org/mainline-dht/#cloud-network-reachability).
> - **Timeouts (0.15.0+):** DHT and relay timeouts are configured separately. DHT peer requests default to **2 s**, relay HTTP requests to **5 s**.
> - DNS TTLs guide caching, not DHT retention. The PKARR churn study's republish schedules are experimental, not guaranteed
>   retention periods or SDK defaults.

### Finding a homeserver

Finding a user's homeserver takes two records. The SDK publishes the user record, the homeserver publishes its own, and the
SDK resolves the alias for you:

| Packet | Signed and published by | Content (all TTL 3600) |
| :-- | :-- | :-- |
| User, name `_pubky` | User key, via the SDK | `HTTPS` record `SVCB(0, <homeserver z32>)`: an alias to the homeserver key. The SDK **preserves** the user's other (non-`_pubky`) records when it rebuilds the packet. |
| Homeserver, at root | Homeserver key, via its key republisher (hourly) | `HTTPS`/SVCB priority 1 with the PubkyTLS port; an optional priority-10 SVCB targeting the ICANN domain (with an HTTP port param only when the domain is `localhost`); an `A` record for the public IP. |

```rust
use pubky::{Pubky, PublicKey, Keypair};

let pubky = Pubky::new()?;

// read-only homeserver resolver
let host: Option<PublicKey> = pubky.get_homeserver_of(&other).await?;

// publish with your key
let signer = pubky.signer(Keypair::random());
signer.pkdns().publish_homeserver_if_stale(None).await?;
// or force republish (e.g. homeserver migration)
signer.pkdns().publish_homeserver_force(Some(&new_homeserver_id)).await?;
// resolve your own homeserver
signer.pkdns().get_homeserver().await?;
```

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md#pkdns-pkarr) (`no_run`; `other` and `new_homeserver_id` are doctest parameters). Executed against a local testnet: `get_homeserver_of(&other)` and, after the force publish, `get_homeserver()` both resolved to the testnet homeserver. API reference: [docs.rs `Pkdns`](https://docs.rs/pubky/0.16.2/pubky/struct.Pkdns.html).</sub>

- **Rust `get_homeserver_of(&PublicKey) -> Result<Option<PublicKey>>`** (and `get_homeserver()` for your own key) uses `CacheFirst`.
  `Ok(None)` means no record or no `_pubky` target. Errors: `Pkarr` (resolution failed) and `PkarrError::InvalidRecord` (the existing
  target is malformed). Publishing without a keypair returns `Authentication`.
- **Publishing with `None` and no existing host does nothing.** Both `publish_homeserver_force(None)` and
  `publish_homeserver_if_stale(None)` log "No existing host found; skipping publish" and return `Ok(())`. Pass an explicit homeserver,
  or run `signup` first.
- **Staleness:** `DEFAULT_STALE_AFTER` is **1 hour**. `set_stale_after` is a builder-style `#[must_use] const fn`, not a setter, so assign
  the result: `let pkdns = pkdns.set_stale_after(d);`.
- **JS:** `pubky.getHomeserverOf(user: PublicKey): Promise<PublicKey | undefined>` returns `undefined` when no record resolves and
  **throws** if PKARR fails or the `_pubky` target is malformed. For your own key: `signer.pkdns.getHomeserver()`,
  `publishHomeserverForce(overrideHost?)`, and `publishHomeserverIfStale(overrideHost?)`.

A homeserver-lookup cache that keys by z32, expires entries, and never hands out a cached handle:

```ts
const HOMESERVER_TTL_MS = 60 * 60 * 1000; // match the SDK's 1 h staleness window
const homeserverCache = new Map<string, { z32: string; expires: number }>();

async function getCachedHomeserver(
  pubky: Pubky,
  userPublicKey: string,
): Promise<PublicKey | undefined> {
  const user = PublicKey.from(userPublicKey);
  const key = user.z32();
  const hit = homeserverCache.get(key);
  if (hit && hit.expires > Date.now()) return PublicKey.from(hit.z32);

  const homeserver = await pubky.getHomeserverOf(user);
  if (!homeserver) {
    homeserverCache.delete(key);
    return undefined;
  }
  homeserverCache.set(key, {
    z32: homeserver.z32(),
    expires: Date.now() + HOMESERVER_TTL_MS,
  });
  return homeserver;
}

// Call on request failure or after a known migration.
function invalidateHomeserver(userPublicKey: string): void {
  homeserverCache.delete(PublicKey.from(userPublicKey).z32());
}
```

<sub>Adapted from the KB snippet (CI type-checked, 0.14.0) [`troubleshooting.ts#L112-L131`](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/js/src/troubleshooting.ts#L112-L131) (permalink; the file has since been deleted). Executed against a local testnet: miss, hit, invalidation, and an unknown user returning `undefined`. Upstream keys the cache by the raw input string, so `<z32>` and `pubky<z32>` for the same user become two entries. Its entries also never expire, so after a [migration](#trust-model-and-credible-exit) they keep pointing at the old homeserver. This version stores the z32 string and builds a fresh `PublicKey` per hit, because some JS calls consume their `PublicKey` argument (see [Republishing](#republishing)).</sub>

Route PKARR through specific relays (browsers require relays):

```ts
const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

<sub>Source (KB CI type-checked, 0.14.0): [`developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122464fef97ce8e0f7909d13d0ee350/snippets/js/src/developer-guide.ts). Type-checked and constructed only; it was not run against the mainnet relays. **Gotcha:** `pkarr.relays` **replaces** the default relays rather than appending to them, so list every relay you want. Config shape: `{ maxErrorBodyBytes?: number, pkarr?: { relays?: string[], requestTimeout?: number } }`, where `requestTimeout` is the relay HTTP timeout in ms.</sub>

### Republishing

**JS `pkdns.publishHomeserverForce` and `publishHomeserverIfStale` consume a `PublicKey` argument** by moving it into WASM. After
the first call, that JS object is a null handle: reusing it throws `null pointer passed to rust`. Build a fresh `PublicKey` for every
explicit call.

**Pass an explicit host only for the initial or migration publish.** An explicit host on a periodic `IfStale` tick re-asserts that
host whenever the record is over 1 h old. A long-running process then silently reverts a migration the user made from another
device. For periodic refresh, call `publishHomeserverIfStale()` with **no argument**: it reuses the host already in the record, as the
SDK's own post-signin publish does.

```ts
// Initial or migration publish: explicit host. publish* consumes its
// PublicKey argument, so pass a freshly built one.
await signer.pkdns.publishHomeserverForce(PublicKey.from(homeserverPk.z32()));

// Periodic refresh: NO host. IfStale reuses the host already in the record,
// so this loop never reverts a migration made elsewhere.
setInterval(
  async () => {
    try {
      await signer.pkdns.publishHomeserverIfStale();
    } catch (error) {
      console.error("PKDNS republish failed", error);
    }
  },
  60 * 60 * 1000,
); // Hourly; IfStale publishes only once the 1 h staleness window has passed
```

<sub>Adapted from [`troubleshooting.ts#L17-L33`](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/js/src/troubleshooting.ts#L17-L33) (KB, 0.14.0, permalink). Upstream reuses `homeserverPk` on every call, which breaks after the first. It also uses a 2 h interval with no error handling. `signer` and `homeserverPk` are declared elsewhere. The force publish and handle consumption were executed against a local testnet. That run used an explicit-host tick; the no-argument tick follows the optional `overrideHost?` signature and was not run.</sub>

**Who republishes user records.** By default the homeserver republishes its users' keys every **4 h**
(`[pkdns] user_keys_republisher_interval = 14400`). It publishes over the DHT, plus the relays in
`dht_relay_nodes = ["https://pkarr.pubky.app", "https://pkarr.pubky.org"]`. It republishes a packet only when that packet's `_pubky`
target is the homeserver itself. Users who point elsewhere are skipped, and their data is not removed. Publishing directly from cache
is disabled. A 4 h interval is slower than both the 1 h SDK staleness default and the "few hours" retention, so don't rely on
server-side refresh alone. Operating a homeserver: [`pubky-infra`](../../pubky-infra/SKILL.md) and
[`REPUBLISHING.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/REPUBLISHING.md).

## The homeserver model

A **homeserver** stores and serves user data, with one tenant per public key. Users choose their homeserver and can move at any time.
It provides public-key signup and signin, third-party app authorization, WebDAV-like file storage (`PUT`/`GET`/`DELETE` plus listing),
PKARR/PKDNS publishing, event streams, and admin and metrics endpoints for operators. It serves files while the user's device is
offline. It does **not** decide feeds or ranking; apps and indexers do. Upstream:
[homeserver README](https://github.com/pubky/pubky-homeserver/blob/main/README.md#what-is-a-homeserver) and
[KB homeserver](https://pubky.org/homeserver/).

- **Default listen sockets:** PubkyTLS `127.0.0.1:6287`, ICANN HTTP `127.0.0.1:6286` (clear-text; the browser and localhost fallback),
  admin `127.0.0.1:6288` (enabled), and metrics `127.0.0.1:6289` (disabled). The testnet runs a PKARR relay on **15411** and an HTTP relay
  on **15412**. **The admin interface is privileged, so keep it private.** Apps use the client API through the SDK. Running one:
  [`pubky-infra`](../../pubky-infra/SKILL.md).
- **Internals apps never touch:** user files live in a file store (local disk by default, or an object store), and PostgreSQL holds the
  metadata (users, quotas, sessions, events). **Apps never connect to PostgreSQL.**

**What apps see.** Status codes and schemas are authoritative in
[`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-homeserver/openapi-client.yml):

- **Entries are opaque byte blobs with a MIME type:** JSON, images, ciphertext, or anything else.
- **`PUT`** creates or overwrites an entry and returns **201**. Handle these errors:

  | Code | Meaning | Do |
  | :-- | :-- | :-- |
  | 400 | Invalid owner or path | Fix the input |
  | 401 / 403 | No session; or wrong user, missing write capability, path outside `/pub` and `/priv`, or a disabled account | Re-auth or request the capability |
  | 409 | A file/folder collision, **or** "the file changed since the write was prepared" (an object-store backend's conditional publish) | For a change conflict, **read again and retry** |
  | 412 / 423 | The `If` header names a non-live lock token / the path is locked and no token was sent | See [Storage locks](#storage-locks) |
  | 429 | Rate limited | Back off; honor `Retry-After` |
  | 507 | Quota exceeded | Surface it to the user. If you send `Content-Length`, the quota is checked before streaming starts. |

- **`DELETE`** returns 204, 404 if the entry is missing, and 412/423 for lock conflicts.
- **LIST** is a `GET` on a path ending in `/`. It returns newline-separated `pubky://` URLs and takes `limit`, `cursor` (a bare entry path
  or a `pubky://` URL), `shallow`, and `reverse`.
  - `limit` defaults to **100** and is **clamped to 1000** in code; the OpenAPI `maximum: 65535` is not honored.
  - Ordering is **lexicographic by path** (`COLLATE "C"`), **not** by time. `reverse` reverses it.
- **429 is normal.** Rate-limiter responses carry `Retry-After: <seconds>`, and the header is CORS-exposed. Since v0.15.0 the server also
  returns 429 when its storage backend rate-limits a request, with `Retry-After: 1` (the object store's per-object mutation limit). Still
  fall back to backoff when the header is absent.
- **There is no hard per-request body cap to rely on** (from reading the code, not stated upstream). Tenant routes declare a
  `DefaultBodyLimit` of 100 MiB, but the streaming `PUT` handler reads the raw body, which that limit does not cover. Quotas (507) and
  operator policy or proxies are what actually limit uploads. Claims of a 10 MB / 413 default do not match the code.

```ts
function statusCodeOf(error: unknown): number | undefined {
  const data = (error as PubkyError).data;
  if (typeof data !== "object" || data === null || !("statusCode" in data)) {
    return undefined;
  }

  return (data as { statusCode?: number }).statusCode;
}

async function putWithRetry(
  session: Session,
  path: Path,
  data: string,
  retries = 3,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      return await session.storage.putText(path, data);
    } catch (error) {
      if (statusCodeOf(error) === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error("PUT failed after retrying rate limits");
}
```

<sub>Source (KB CI type-checked, 0.14.0): [`troubleshooting.ts#L68-L98`](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/js/src/troubleshooting.ts#L68-L98) (permalink). Executed against a local testnet: the happy path, plus `statusCodeOf` extracting 404 from a real `RequestError`. The 429 branch was not exercised because the testnet does not rate-limit. `statusCodeOf` is not an SDK export; see [`sdk-js.md`](sdk-js.md#error-handling). The snippet uses a linear delay and **ignores `Retry-After`**; honor the header when it is present.</sub>

### Storage locks

Storage locks are **new since 0.12.0**: homeserver v0.13.0 added WebDAV `LOCK`/`UNLOCK`, the Rust SDK added `StorageLock`, and JS SDK
v0.15.0 added the JS helpers. A homeserver that supports locks advertises the `/info` feature `webdav-locks`. Locks are **opt-in**:
ordinary operations never lock.

- A lock is an exclusive write lock on a **file path only**; a directory or shared lock returns 400. The timeout defaults to 30 s and is
  **capped at 60 s** (`Infinite` also means 60 s). The response carries `Lock-Token: opaquelocktoken:...`. **The token is a bearer secret.**
- While a lock is live, `PUT`/`DELETE` must send `If: (<token>)`. Without it the server returns **423**; with a non-live token, **412**.
  `UNLOCK` with an unknown token returns 409, a `lockinfo` body over 16 KiB returns 413, and a homeserver without lock support returns 405.
- A write that presents the token keeps the lock alive until the write ends. **An unlocked write holds nothing:** a `LOCK` taken while
  the write is still streaming does not stop it.
- **JS:** `session.storage.lock`, `putTextLocked`, `putBytesLocked`, `deleteLocked`, `refreshLock`, and `unlock`. There is **no
  `putJsonLocked`**. If `lock()` rejects without a status code, the lock may still be held until it times out, and the path answers 423
  meanwhile. The KB [sdk.md](https://pubky.org/sdk/#storage-locking) still says JS lacks these helpers; that is stale since 0.15.0.

```rust
let storage = session.storage();
let lock = storage.lock("/pub/my.app/state.json", Duration::from_secs(30)).await?;
let state = storage.get(lock.path()).await?.bytes().await?;
// ... modify `state` ...
storage.put_locked(&lock, state).await?;
storage.unlock(&lock).await?;
```

<sub>Source: rustdoc example for [`StorageLock`](https://docs.rs/pubky/0.16.2/pubky/struct.StorageLock.html#example) (`no_run`). **Requires `pubky >= 0.13.0`**: it fails to compile on 0.12.0 (`no method named lock`). Executed (clippy-clean) on 0.16.2 against a local testnet. `session` is a `PubkySession`; add `use std::time::Duration;`.</sub>

### Transport and wire addressing

**Let the SDK build requests.** Choose endpoints or set headers yourself only for deliberate raw HTTP.

- **PubkyTLS** is TLS with Raw Public Keys (RFC 7250): the server's Ed25519 key is verified directly, with no X.509 CA chain. **ICANN**
  endpoints use standard HTTPS. Transport encryption protects the connection, **not** your data from the homeserver that handles it.
- **How native clients choose a transport (Rust and native bindings, not WASM):** the client resolves the HTTPS endpoints in `_pubky.<pk>`.
  - No ICANN endpoint: PubkyTLS. Only an ICANN endpoint: ICANN.
  - Both: it TCP-probes the direct addresses (1500 ms timeout) and falls back to ICANN if they are unreachable.
  - The decision is cached per host for 60 s. **The fallback is based on TCP reachability only:** a later TLS or request failure does not trigger it.
  - Native clients behind HTTPS proxies have reported discovery and routing problems
    ([pubky-homeserver#657](https://github.com/pubky/pubky-homeserver/issues/657)). Since v0.15.0 you can add extra CA roots for ICANN HTTPS.
- **Browsers and WASM** reach public homeservers over ICANN HTTPS with standard CA validation.
- **Path addressing (current):** `/storage/{user_z32}/{path}`. The owner in the path is authoritative; any `pubky-host` header or query
  param is accepted but ignored.
- **Legacy owner-relative routes (deprecated, still served):** the owner comes from `pubky-host`, then `Host`, then `?pubky-host=`.
- **Feature detection:** `GET /info` returns `{"features":[...]}`: stable, opaque identifiers. Clients **must ignore unknown values**. At
  0.16.2 the list is `path-addressed-storage`, `grant-proof-logout`, and `webdav-locks`. The SDK reads `/info` with a 16 KiB body cap.
  High-level Rust storage APIs and JS `Client.fetch` fall back to legacy addressing automatically. **Raw HTTP clients should send
  `/storage/{owner}/...` only to homeservers that advertise `path-addressed-storage`**, always with the owner as **z32**.
- **Deprecation clock:** the first stable SDK release with path addressing was v0.12.0 (2026-09-14). Legacy removal comes up for review no
  earlier than **2027-09-14**, and still requires an explicit review. Keep the fallback until then. See
  [`STORAGE_ADDRESSING_MIGRATION.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md).
- **SDK client limits (0.13.0+):** HTTP error bodies are captured up to **4096 bytes** by default. Change this with Rust
  `PubkyHttpClient::builder().max_error_body_bytes(n)` or JS `new Client({ maxErrorBodyBytes })`; `0` skips the body and uses the status
  reason. Event streams default to effectively **unbounded** per-event size, so set Rust `.max_event_bytes(n)` or JS `.maxEventBytes(n)`
  for untrusted streams. Details: [SDK README](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md#error-body-limits).

```rust
use pubky::{PubkyHttpClient, resolve_pubky};
use reqwest::Method;

let client = PubkyHttpClient::new()?;
let url = resolve_pubky("pubkyoperrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/pub/pubky.app/posts/0033X02JAN0SG")?;
assert_eq!(
    url.as_str(),
    "https://_pubky.operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/storage/operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo/pub/pubky.app/posts/0033X02JAN0SG"
);

let response = client.request_async(Method::GET, url).await?.send().await?;
```

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md#resolve-identifiers-into-transport-urls) (`no_run`). Executed: the assert holds, the read-only mainnet `GET` returned 200, and a testnet variant fetched a local testnet user's file. The `pubky<z32>` input becomes raw z32 in both the hostname and the `/storage/` segment. `use reqwest::Method` needs a direct `reqwest` dependency matching pubky's (0.13). In JS, `resolvePubky(identifier)` returns the same URL string, and `pubky<pk>/…` and `pubky://<pk>/…` resolve identically ([`sdk-js.md`](sdk-js.md#raw-fetch-resolvepubky)).</sub>

### Trust model and credible exit

> **The operator is trusted.** A signed discovery record does **not** prove stored content is authentic. Design for an operator
> that alters, withholds, or deletes data, or observes access patterns. Client-side encryption hides contents, but access patterns
> and sizes stay visible. Independent copies help availability but do not detect tampering. Encrypted or guarded data as a general
> primitive, and homeserver mirroring, are **planned, not shipped**; see [`shipped-vs-planned.md`](shipped-vs-planned.md) and the
> [KB security model](https://pubky.org/security-model/).
> **For apps:** users review requested scopes and can revoke grants ([KB authentication](https://pubky.org/authentication/)), so
> request only the capabilities you need and handle revoked sessions.

- **PKARR decides where an identity lives,** but only as clients re-resolve it. Records expire, lookups fail, and caches (DHT, relay,
  and app caches such as `homeserverCache` above) delay hosting changes. A new discovery record does **not** recover missing files.
- **Migrating today:** sign up on the new homeserver, re-upload the data **manually**, then update the record with
  `publish_homeserver_force` / `publishHomeserverForce`.
- **Pubky Backup** (desktop) keeps local snapshots of published homeserver data. Re-upload is manual. Seamless restore and mirroring
  are **planned**.
- Identity separation makes credible exit possible, but with few providers and migration tools it may not yet be fully practical
  ([KB credible exit](https://pubky.org/credible-exit/)).

## Homeserver-write vs Nexus-read

**Writes always go to the author's homeserver, whichever read approach you use.** Choose the read path per screen.

| Operation | Goes to | API |
| :-- | :-- | :-- |
| **Write** your own data | The author's **own homeserver** | `session.storage()` / `session.storage` (authenticated) |
| **Direct read** of known users or paths | **That user's homeserver** | `pubky.public_storage()` / `pubky.publicStorage` (no auth) |
| Search or feeds across many users | Your **own backend** that indexes event streams | `/events/`, `/events-stream` |
| **Aggregated social read** (feeds, followers, tags) | A shared indexer such as **Pubky Nexus** | Nexus REST `/v0`: [`nexus-api.md`](nexus-api.md) |

- **An index is a derived view,** limited by its coverage and policies, and it lags. A missing Nexus result can mean that instance
  hasn't indexed the record yet, not that the record doesn't exist. Right after a user publishes, read it back from their homeserver.
- **Nexus** indexes public social data (per [`app-specs.md`](app-specs.md)) from homeserver event feeds and serves an API. It does not
  write users' posts or replace homeserver storage. Components: nexus-webapi, nexus-watcher, nexus-common, and nexusd, backed by Neo4j
  and Redis. Its watcher consumes `GET /events/?cursor=&limit=` and per-user `GET /events-stream?user=<pk>:<cursor>&limit=&path=/pub/`.

```js
const response = await fetch(
  "https://nexus.pubky.app/v0/stream/posts?limit=10",
);
const posts = await response.json();
```

<sub>Source (KB CI type-checked, 0.14.0): [`developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122464fef97ce8e0f7909d13d0ee350/snippets/js/src/developer-guide.ts). Executed as a read-only `GET` against live Nexus on 2026-10-26: HTTP 200 with an array body, matching the OpenAPI `PostStreamDetailed` schema.</sub>

> **Nexus `/v0` is unstable.** Expect breaking changes, and don't hardcode response shapes. Swagger is authoritative:
> <https://nexus.pubky.app/swagger-ui/>. To run Nexus, see [`pubky-infra`](../../pubky-infra/SKILL.md). For read-only Cypher over the
> graph, use the `nexus-scout` skill.

**Event streams (what indexers consume).** Parameters are authoritative in
[`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-homeserver/openapi-client.yml):
- `GET /events/` covers public `/pub` events only: `text/plain` lines of `PUT|DEL pubky://...`, then `cursor: N`.
- `GET /events-stream` is SSE, per user (`user=<z32>[:cursor]`, repeatable), with optional `path` filters and a `live` mode. Each message
  is `event: PUT|DEL` with the URL, `cursor:`, and a base64 `content_hash:`.
  - **`/priv/` filters are alpha.** They need exactly one user and a session with read capability, and fail with 401/403 otherwise.
  - **Slow live clients are disconnected.**

**SDK actors** (see the [README mental model](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md#mental-model)):
- `Pubky`: the facade and starting point; it owns the transport. **Reuse one shared instance.**
- `PubkySigner`: the local key holder. It signs up, signs in, approves QR auth, and publishes PKDNS.
- `PubkySession`: the authenticated handle with session-scoped storage.
- `GrantManager`: lists and revokes grants using an authenticated root session.
- `PublicStorage`: unauthenticated reads.
- `Pkdns`: resolves and publishes `_pubky`.
- `PubkyHttpClient`: the transport.

The JS package initializes WASM before it exposes any API, and it needs Node 20+.

**Social write flow:** build the object per [`app-specs.md`](app-specs.md), `PUT` it to your homeserver, and the homeserver emits an
event. Indexers pick it up; others read it via Nexus or directly via public storage.

## Authentication

- **Bearer sessions are current.** `Authorization: Bearer <token>` comes from `POST /auth/grant/session`. Session cookies from
  `POST /signup` and `POST /session` are **deprecated**, and a resolved bearer session takes precedence over a cookie.
- **Capabilities** have the form `<scope>:<actions>`; `/:rw` covers both roots.
- **The `e` action (0.16.0+)** lets the signer deliver scoped content keys with the grant. It grants **no** HTTP storage access: it is
  client-side key delivery, **not** encrypted storage on the homeserver. The keys are **permanent**: revoking or expiring the grant does
  not take them back, and they cannot be rotated. Requesting `e` on `/` hands over every key the user will ever have, and older
  homeservers reject grants containing `e`.

Never collect a user's secret key or recovery material in an app (see [Identity](#identity-the-ed25519-keypair)). Grant flows,
capabilities, `pubkyauth` URLs, signup tokens, session lifecycle, and scoped encryption keys are in [`auth.md`](auth.md).

## Stability and known limits

- **The shipped-vs-planned guardrail is a hard rule.** [`shipped-vs-planned.md`](shipped-vs-planned.md) decides what apps may depend
  on: `/priv` is alpha, and encryption, mirroring, and backup restore are planned.
- **Everything is pre-1.0:** the `/pub` layout is not stabilized, Nexus `/v0` is unstable, and app-specs are v0.x. Pin `pubky` /
  `@synonymdev/pubky` to an exact version (current: **0.16.2**).
- **Unreleased on `main` after v0.16.2. Do not document these as available:**
  - static website serving from `/pub/website/` (the `/info` feature `websites`)
  - client IP from the TCP peer or PROXY protocol
  - rejection of `HEAD` on token and SSE endpoints
- **Stale sources to avoid.** The [pubky-ai-kit](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md)
  core-architecture section is out of date: it says `/priv` is not formalized, claims a 10 MB / 413 payload default, says all sessions
  share one cookie, uses `startAuthFlow()` (now `startCookieAuthFlow`; the grant flow is `startGrantAuthFlow`), and describes 3-minute
  AuthTokens. Still valid there: its scope conventions, the shared-facade advice, blobs carrying a MIME type, PostgreSQL holding only
  metadata, and 429 being normal.
- Gotchas in brief:
  - JS `pkdns.publish*` consumes its `PublicKey` argument, and an explicit host on a periodic `IfStale` can revert migrations ([Republishing](#republishing)).
  - `pkarr.relays` replaces the default relays.
  - LIST clamps `limit` at 1000 and orders by path.
  - There is no reliable body-size cap.
  - A 409 can mean "read again and retry" ([the homeserver model](#the-homeserver-model)).

## Upstream references

- **Rust SDK:** [docs.rs/pubky 0.16.2](https://docs.rs/pubky/0.16.2/pubky/) · [SDK README](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/README.md)
- **JS/WASM SDK:** [JS README](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/bindings/js/pkg/README.md) · [npm](https://www.npmjs.com/package/@synonymdev/pubky)
- **Homeserver client API:** [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-homeserver/openapi-client.yml) ·
  [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/PRIVATE_STORAGE.md) ·
  [`STORAGE_ADDRESSING_MIGRATION.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md) ·
  [`REPUBLISHING.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/REPUBLISHING.md) ·
  [`scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/scoped-encryption-keys.md) ·
  [releases](https://github.com/pubky/pubky-homeserver/releases)
- **PKARR:** [pkarr introduction](https://github.com/pubky/pkarr/blob/main/docs/introduction.md) · [design](https://github.com/pubky/pkarr/blob/main/design/base.md)
- **Knowledge base:** [architecture](https://pubky.org/architecture/) · [security model](https://pubky.org/security-model/) ·
  [authentication](https://pubky.org/authentication/) · [pkarr](https://pubky.org/pkarr/) · [mainline-dht](https://pubky.org/mainline-dht/) ·
  [app architectures](https://pubky.org/app-architectures/) · [developer guide](https://pubky.org/developer-guide/)
- **Nexus:** [repo](https://github.com/pubky/pubky-nexus) · [Swagger](https://nexus.pubky.app/swagger-ui/)
