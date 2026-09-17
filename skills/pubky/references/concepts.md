# Pubky protocol concepts

> **CANONICAL.** This file is the single source of truth for identity, addressing, PKARR, the homeserver model,
> and the write/read split. `pubky-mobile`, `pubky-infra`, and the other `pubky` references link here. Link to
> a section; don't restate it.

Pubky is an open protocol for **per-public-key backends**: PKARR (public-key DNS on the Mainline DHT) plus
ordinary HTTP. Resolution always starts from the key:

```
Ed25519 public key (the identity)
  -> PKARR record on the Mainline DHT (`_pubky.<z32>`)
    -> points at the user's homeserver (chosen by the user, changeable)
      -> stores the user's files under /pub
         (/priv exists but is ALPHA: not for production, not encrypted from the operator)
        -> read/written by apps through an SDK
```

SDKs: Rust [`pubky`](https://docs.rs/pubky), JS/WASM [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky),
React Native `@synonymdev/react-native-pubky` (see the `pubky-mobile` skill). Current release: **0.12.0** for
both (2026-09-14). Knowledge-base snippets are CI-checked against **0.10.0**; the snippets below were
re-verified on **0.12.0**. Check signatures against docs.rs / TypeDoc for the version you pin.

## Identity: the Ed25519 keypair

An identity **is** an Ed25519 keypair. No accounts, no passwords, no server-side recovery.

- **Apps should not hold user keys.** With Pubky Ring (the reference key manager) and the SDK grant auth flows
  ([`auth.md`](auth.md)), the private key never leaves Ring; apps get **session tokens** from the homeserver.
  The SDK builds a signer from any raw `Keypair` (the snippets below do), but by this skill's guidance only a
  key manager or first-party tool should.
- **Nothing can be recovered.** Lose the device and the 12-word mnemonic and the identity is gone. Each pubky
  has its own mnemonic.
- **A leaked mnemonic is permanent compromise.** The only mitigation is a new pubky.
- **Never ask users to enter a mnemonic in your app.** Mnemonic fallback is a known exfiltration
  vulnerability; mnemonics go only into Ring or the user's own homeserver.
- **JS `Keypair`:** `Keypair.random()`, `Keypair.fromSecret(u8[32])`, `keypair.secret()` (raw 32-byte
  secret: never log, transmit, or store unencrypted), `keypair.publicKey`,
  `keypair.createRecoveryFile(passphrase)`, `Keypair.fromRecoveryFile(bytes, passphrase)`.
  `fromSecret` on a wrong length throws a **plain string**, not a `PubkyError`; don't branch on `error.name`.

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

<sub>Source: [`pubky-homeserver/examples/rust/keygen.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/keygen.rs) (deps: `anyhow`, `clap` derive, `rpassword`, `pubky-common`). Executed on 0.12.0: clippy-clean, and the file decrypts back to the same key. `rpassword::read_password` needs a TTY; piped stdin fails.</sub>

> **Recovery-file caveat (observed in code, not an upstream statement).** Format: spec line
> `pubky.org/recovery` (decrypt also accepts legacy `pkarr.org/recovery`), newline, then the 32-byte secret
> encrypted with XSalsa20Poly1305 (random nonce). The key is derived with `Argon2::default()` (argon2id) and a
> **fixed salt `"recovery"`**: no per-file salt, so the passphrase is the only protection. The example above
> has two flaws to fix in your code:
> - It accepts an empty passphrase with only a warning. **Reject empty or weak passphrases.**
> - `std::fs::write` creates the file with default permissions (0644, world-readable), so any local user can
>   copy it and brute-force the passphrase offline. **Write recovery files owner-only (0600)**, e.g.
>   `OpenOptions` + `std::os::unix::fs::OpenOptionsExt::mode(0o600)`.
>
> Never publish or share recovery files.
> ([`recovery_file.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-common/src/recovery_file.rs))

**Sign up once, then sign in.** Rust `PubkySigner::signup(&self, homeserver: &PublicKey, signup_token:
Option<&str>) -> Result<()>` registers with the homeserver and force-publishes the `_pubky` record. It returns
**no session**. Then call `signin(client_id: ClientId) -> Result<PubkySession>`, which refreshes the PKDNS
record in the background. `signin_blocking` waits (~3–5 s) for that refresh, which publishes only if the record
is stale; use it on first setup when others must find the user immediately. `signup_cookie` / `signin_cookie` /
`signin_cookie_blocking` are deprecated.

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
```

<sub>Source (CI type-checked, 0.10.0): [`snippets/js/src/getting-started.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/getting-started.ts). Executed on 0.12.0 against a local testnet. Adapted: upstream logs `signer.publicKey.z32()` as "Your pubky"; anything a person reads uses `toString()` (`pubky<z32>`), per [public-key string formats](#public-key-string-formats). Rust: [docs.rs `PubkySigner`](https://docs.rs/pubky/latest/pubky/struct.PubkySigner.html).</sub>

### Public-key string formats

A `PublicKey` has two string forms. **Don't mix them up.**

| Call (Rust / JS) | Returns | Use for |
| :-- | :-- | :-- |
| `Display` / `.to_string()` · `publicKey.toString()` | `pubky<z32>` | UI, logs, human-facing IDs, addressed paths (`pubky<z32>/pub/...`) |
| `.z32()` · `publicKey.z32()` | raw z-base-32, **52 chars**, DNS-safe | Hostnames (`_pubky.<z32>`), `/storage/<z32>/...` segments, legacy `pubky-host` header, query params, serde/JSON, DB keys, cache keys |

- **Parsing:** Rust `PublicKey` implements `FromStr` and `TryFrom<&str | &String | String>`; JS
  `PublicKey.from` accepts raw z32 or `pubky<z32>`.
- **Gotcha:** JS `PublicKey.from("pubky://…")` **throws** `InvalidInput`. Strip the scheme and path first.
- **Gotcha:** `/storage/{user}` only matches `^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$`, so a `pubky`-prefixed
  key there won't route. Likewise a `pubky<z32>` in a hostname, header, or DB key won't resolve or match.

## Addressing and the /pub tree

A resource is a public key plus an **absolute path**. SDK storage APIs take two shapes:

| Form | Example | Pass it to |
| :-- | :-- | :-- |
| Absolute path | `/pub/my-app/file.json` | **Session storage** (signed-in user's own data) |
| Address (preferred) | `pubky<z32>/pub/my-app/file.json` | **Public storage** (anyone's public data) |
| URL | `pubky://<z32>/pub/my-app/file.json` | **Public storage** (also accepted) |

JS types: `` Path = `/pub/${string}` | `/priv/${string}` `` (session; `/priv` is **alpha**, see
[storage roots](#storage-roots-and-access)) and
`` Address = `pubky${string}/pub/${string}` | `pubky://${string}/pub/${string}` `` (public, **always `/pub`**).
`"data.json"` and `"/myapp/data.json"` are type errors. `@synonymdev/pubky` 0.9.3 and earlier type `/pub` only.

### Own data vs. another user's data

| You want to… | Rust | JS | Auth |
| :-- | :-- | :-- | :-- |
| Read/write **your own** data | `session.storage()` + path | `session.storage` + path | Session with matching capability |
| Read **anyone's** public data | `pubky.public_storage()` + address | `pubky.publicStorage` + address | None |

```rust
let pubky = Pubky::new()?;
let session = pubky
    .signer(keypair)
    .signin(ClientId::new("my-cool-app").unwrap())
    .await?;

let storage = session.storage();
storage.put("/pub/my-cool-app/data.txt", "hi").await?;
let text = storage.get("/pub/my-cool-app/data.txt").await?.text().await?;

// Public (read-only)
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

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#storage-api-session--public), two `no_run` doctests merged here, so their imports are dropped. Add `use pubky::{ClientId, Keypair, Pubky, PublicKey};` (`ClientId` is **not** in `pubky::prelude`). `keypair: Keypair` and `user_id: PublicKey` are doctest params; `format!("{user_id}")` uses `Display` (`pubky<z32>`), the accepted addressed form. Executed on 0.12.0 against a local testnet (with `Pubky::testnet()` and a prior `signup`). With the `json` feature, session storage also has `put_json` / `get_json`.</sub>

```js
const pubky = new Pubky();
const keypair = Keypair.random();

// Sign in (user already has an account on a homeserver)
const signer = pubky.signer(keypair);
const session = await signer.signin("myapp.example");

// Write data
await session.storage.putJson("/pub/myapp/profile", {
  name: "Alice",
  bio: "Building on Pubky!",
});

// Read data
const profile = await session.storage.getJson("/pub/myapp/profile");
```

<sub>Source (CI type-checked, 0.10.0): [`snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts). Type-checked on 0.12.0. **As written, `signin` fails at runtime** (`PkarrError`: no DHT record) because a fresh `Keypair.random()` has no account. Load an existing key (e.g. `Keypair.fromRecoveryFile`) or call `signer.signup(homeserver, null)` first; with signup, `putJson`/`getJson` round-trip on a testnet.</sub>

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = a.testnet ? Pubky.testnet() : new Pubky();

// PublicStorage reads from addressed `pubky<pk>/<abs-path>` or `pubky://<pk>/<abs-path>` values
const exists = await pubky.publicStorage.exists(resource);
const stats = await pubky.publicStorage.stats(resource);
const bytes = await pubky.publicStorage.getText(resource);
```

<sub>Source: [`examples/javascript/3-storage.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/3-storage.mjs). Executed on 0.12.0 against a local testnet with both address forms. `a` is parsed CLI args; `resource` must be typed `Address` for TypeScript. `getText` returns a string despite the variable name `bytes`.</sub>

### Path rules

Validated by [`StoragePath`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-common/src/storage_path.rs):

- **Absolute.** Max **255 bytes** per segment, **972 bytes** total (decoded UTF-8; this leaves room for the
  52-byte tenant key in a 1024-byte object key).
- UTF-8 and spaces are allowed (`/pub/My File/über`). `%` is literal: URL-decode **before** constructing a path.
- **Rejected:** Unicode control characters, backslashes, trailing Unicode whitespace.
- **HTTP/WebDAV paths are normalized:** empty and `.` segments collapse, `..` resolves
  (`priv//my-app/./data/` -> `/priv/my-app/data/`); traversal above root (`/../../priv/`) is an error.
  `StoragePath::new` accepts only already-canonical input.
- **A path can't be both file and folder:** if `/pub/app/foo` exists, `PUT /pub/app/foo/bar.json` -> **409**;
  if anything exists under `/pub/app/foo/`, `PUT /pub/app/foo` -> **409**.
- **`PUT` or `DELETE` on a path ending in `/` -> 400** ("Target path must be a file"). `GET` on a trailing `/`
  is a LIST.

### Scopes

By convention the first segment under `/pub` is a **scope**. An app may touch several:

- **App-domain scopes:** `pubky.app`, `mapky.app`, `bitkit.to`. **Protocol scopes:** `paykit`.
- Mapky writes `/pub/mapky.app/*` and reuses `/pub/pubky.app/*` for profiles; Bitkit writes `/pub/bitkit.to/*`
  and uses `/pub/paykit/*`.
- For new app data, use a domain-like folder such as `/pub/my-new-app/`. The `pubky.app` schema is in
  [`app-specs.md`](app-specs.md).

> The `/pub` layout is **not stabilized**. These scope conventions describe current practice only.

### Storage roots and access

| Root | Anonymous read | Read with session | Write (`PUT`/`DELETE`) |
| :-- | :-- | :-- | :-- |
| `/pub/` | Allowed | Allowed | Session for **this tenant** with write capability |
| `/priv/` (**ALPHA**) | **401** | Session for this tenant with read capability (else **403**) | Session for this tenant with write capability |
| Anything else | **403** | **403** | **403** "Writing to directories other than '/pub/' and '/priv/' is forbidden" |

> **`/priv` is alpha: not for production, not encrypted from the operator.** It shipped in `pubky-homeserver`
> **v0.10.0** (2026-08-05), whose release notes say it "should NOT be used in any production environment" and
> that its APIs may change or disappear. It is **access control only**: the admin API can read and write all
> tenant data, including `/priv`. It is a separate namespace; existing `/pub` data is not moved. Never put
> secrets there unencrypted. Guardrail: [`shipped-vs-planned.md`](shipped-vs-planned.md). Details:
> [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md).

## PKARR resolution

PKARR makes a self-issued public key a publicly addressable domain: signed DNS records on the Mainline DHT,
with no registrar or CA.

- **Publish:** sign a small DNS packet (≤1000 bytes) and put it on the DHT, directly or through an **HTTP relay**.
- **Resolve:** query the DHT or a relay and **verify the signature yourself**. PKARR-unaware apps can use
  DNS-over-HTTPS against PKARR servers ([pkdns](https://github.com/pubky/pkdns)).
- **SignedPacket:** `public-key(32) + signature(64) + timestamp(8) + dns-packet(≤1000)`, max **1104 bytes**;
  an Ed25519-signed BEP44 mutable item looked up by SHA1 of the public key. Record builders and caches:
  [`SignedPacketBuilder`](https://docs.rs/pkarr/latest/pkarr/types/struct.SignedPacketBuilder.html).

> **Operational limits that change your code**
> - **Records are ephemeral.** The DHT drops them after hours (to days), so republish (`pkarr-republisher`;
>   hourly is recommended). PKARR is **not storage**: never put app data in it.
> - **Not real-time.** Caching is heavy, an uncached DHT lookup can take seconds, rate limiting is harsh, and
>   updates may need proof-of-work. **Cache resolved homeservers.**
> - **No UDP means no DHT.** Browsers and firewalled environments **must use HTTP relays**. DHT nodes often
>   block AWS/GCP/Azure ranges, so use relays hosted with smaller providers.
> - **Outages:** if temporary, new resolutions fail but cached locations still work; if prolonged, use relays;
>   for regional blocking, use relays in multiple regions.

**Finding a homeserver takes two records:**

| Packet | Signed by | Content |
| :-- | :-- | :-- |
| User, at `_pubky.<user-z32>` | User key | `_pubky HTTPS 0 <homeserver-public-key>` (HTTPS/SVCB alias to the homeserver key) |
| Homeserver | Homeserver key | e.g. `. HTTPS 1 . port=6287`, `. A 203.0.113.10` (direct) and `. HTTPS 10 homeserver.example.com port=443` (ICANN) |

SDKs resolve `_pubky.<user-z32>` and follow the alias for you. When you need it directly:

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

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#pkdns-pkarr) (`no_run`; `other` and `new_homeserver_id` are doctest params). Executed on 0.12.0 against a local testnet. API: [docs.rs `Pkdns`](https://docs.rs/pubky/latest/pubky/struct.Pkdns.html).</sub>

- **`publish_homeserver_if_stale(None)` on a key with no record returns `Ok` but publishes nothing.** Pass an
  explicit homeserver, or run `signup` / `publish_homeserver_force` first.
- **Rust `get_homeserver_of` -> `Result<Option<PublicKey>>`** (CacheFirst). `Ok(None)` means no record or no
  `_pubky` target; `Err(Error::Pkarr(..))` means resolution failed or the target isn't a public key. The
  `Result` return is a **v0.10.0 breaking change**: code expecting `Option` won't compile. Variants:
  [docs.rs `Pkdns`](https://docs.rs/pubky/latest/pubky/struct.Pkdns.html).
- **Staleness:** `DEFAULT_STALE_AFTER` = **1 hour**. `set_stale_after` is builder-style (`#[must_use]`), not
  an in-place setter: `let pkdns = pkdns.set_stale_after(d);`.
- **JS `pubky.getHomeserverOf(user: PublicKey): Promise<PublicKey | undefined>`**: `undefined` if there is no
  record; **throws** on resolution failure or a malformed target.

```ts
const homeserverCache = new Map<string, PublicKey>();

async function getCachedHomeserver(
  pubky: Pubky,
  userPublicKey: string,
): Promise<PublicKey | undefined> {
  const cached = homeserverCache.get(userPublicKey);
  if (cached) return cached;

  const user = PublicKey.from(userPublicKey);
  const homeserver = await pubky.getHomeserverOf(user);

  if (homeserver) {
    homeserverCache.set(userPublicKey, homeserver);
  }

  return homeserver;
}
```

<sub>Source (CI type-checked, 0.10.0): [`snippets/js/src/troubleshooting.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/troubleshooting.ts). Executed on 0.12.0 against a local testnet. **Harden before use:** it keys by the raw input string, so `<z32>` and `pubky<z32>` for one user become separate entries. Key by `PublicKey.from(x).z32()`. It also never expires, so after a [migration](#trust-model-and-credible-exit) it keeps pointing at the old homeserver. Expire entries (e.g. after the 1 h staleness window) and invalidate on request failure.</sub>

Route PKARR through specific relays (browsers need relays):

```ts
const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

Republish your own record. **JS `pkdns.publishHomeserverForce` / `publishHomeserverIfStale` consume their
`PublicKey` argument** (moved into WASM). After the first call the JS object is a null handle: reusing it
throws `null pointer passed to rust`, and passing it to `IfStale` silently sends `None`, which does nothing if
no record exists. Keep the z32 string and build a fresh `PublicKey` per call:

```ts
// publish* consumes its PublicKey argument (moved into WASM), so keep the z32
// string and build a fresh PublicKey for every call.
const homeserverZ32 = homeserverPk.z32();

// publish
await signer.pkdns.publishHomeserverForce(PublicKey.from(homeserverZ32));

// Periodically check whether the record is stale before republishing
setInterval(
  async () => {
    await signer.pkdns.publishHomeserverIfStale(PublicKey.from(homeserverZ32));
  },
  2 * 60 * 60 * 1000,
); // Every 2 hours
```

<sub>Adapted from [`snippets/js/src/troubleshooting.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/troubleshooting.ts). The upstream version passes `homeserverPk` directly and breaks after the first call. The relay block is type-checked on 0.12.0 but was not run against mainnet. The publish block is fixed and executed on 0.12.0 against a local testnet. `signer` and `homeserverPk` are declared elsewhere; `signer` must come from the `pubky` whose relays you want.</sub>

**Who republishes:** the homeserver republishes its users' keys every 4 h by default
(`user_keys_republisher_interval = 14400`, via `dht_relay_nodes = ["https://pkarr.pubky.app",
"https://pkarr.pubky.org"]`). Configured relays are used for republishing since v0.12.0, and migrated users
are skipped since v0.10.0. That is slower than the 1 h SDK staleness default, so don't assume hourly
server-side refresh. Operating this: [`pubky-infra`](../../pubky-infra/SKILL.md).

## The homeserver model

A **homeserver** stores and serves user data, one tenant per public key. Users pick it and can leave at any
time. It provides public-key signup/signin, third-party app authorization, WebDAV-like storage
(`PUT`/`GET`/`DELETE`/`HEAD`/LIST), PKARR publishing for discovery, and admin and metrics endpoints for
operators.

Processes: main API server (PubkyTLS + ICANN HTTP), admin server, Prometheus metrics server (off by default),
and user/server key republishers. Default ports: **6287** pubky (TLS), **6286** ICANN, **6288** admin, **6289**
metrics. Running one: [`pubky-infra`](../../pubky-infra/SKILL.md).

**What apps see** (authoritative status codes and schemas: [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml)):

- **Entries are opaque byte blobs with a MIME type**: JSON, images, ciphertext, anything.
- **`PUT`** creates or overwrites (201). Handle **409** (file/folder collision) and **507** (quota exceeded);
  if `Content-Length` is sent, quota is checked before streaming. **`DELETE`** returns 404 if the entry is
  missing. File `GET` supports conditional requests (`ETag` / `Last-Modified`).
- **LIST** is a `GET` on a trailing `/`. It returns `text/plain`, one `pubky://` URL per line, with params
  `limit`, `cursor` (bare path or `pubky://` URL), `shallow`, `reverse`.
  - `limit` defaults to **100** and is **clamped to 1000** in code; the OpenAPI max of 65535 is not honored.
  - `reverse` means reverse **lexicographic path order** (`COLLATE "C"`), **not** time order.
- **429 is normal.** Retry with backoff. Since v0.12.0, responses carry `Retry-After` (CORS-exposed); prefer
  it over a fixed delay.
- **No hard per-request body cap to rely on (observed in code, not an upstream statement or runtime test).**
  Tenant routes declare 100 MiB, but the streaming `PUT` handler appears to bypass that limit; quotas (507) and
  operator proxies govern. Claims of a 10 MB / 413 default don't match current code.

```ts
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

<sub>Source (CI type-checked, 0.10.0): [`snippets/js/src/troubleshooting.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/troubleshooting.ts). Executed on 0.12.0 against a local testnet (the 429 branch was not triggered). `statusCodeOf` is not an SDK export: it reads `error.data.statusCode` and is defined upstream and in [`sdk-js.md`](sdk-js.md). This snippet uses a linear delay and **ignores `Retry-After`**; honor the header when present.</sub>

**Internals apps never touch:** PostgreSQL holds metadata only: users (pubkey + quota), sessions and grant
sessions, entries (path, Blake3 hash, length, MIME, timestamps), events (PUT/DEL stream), and signup codes.
**Apps never connect to PostgreSQL.**

### Transport and wire addressing

**Let the SDK build requests.** Choose endpoints or set `pubky-host` only when you deliberately use raw HTTP.

- **PubkyTLS (direct):** TLS with Raw Public Keys (RFC 7250). The server's Ed25519 key is verified directly,
  with no CA chain. **ICANN:** reverse proxy with X.509.
- **Native SDKs** (Rust and native mobile bindings, not WASM) prefer PubkyTLS and fall back to ICANN when the
  direct endpoint is unreachable (NAT, tunnel) and ICANN is advertised. **Browsers/WASM use ICANN only.**
- **Path addressing (current):** `GET /storage/{user-z32}/pub/...`. The owner in the path is authoritative and
  `pubky-host` is ignored. The homeserver has served it since v0.11.0; SDK 0.12.0 uses it by default, including
  over ICANN fallback, and sends **no** `pubky-host` header. The `/info` feature flag the SDK checks first
  arrived only in homeserver v0.12.0, so against a v0.11.x homeserver the SDK still uses legacy addressing.
- **Legacy addressing (deprecated, still served):** `GET /pub/...`, used by older SDKs or against homeservers
  without the feature. The owner comes from the `pubky-host` header, then `Host`, then `?pubky-host=`.
- **Feature detection:** `GET /info` -> `{"features":["path-addressed-storage"]}`; ignore unknown identifiers.
  High-level Rust storage APIs and JS `Client.fetch` fall back to legacy automatically. **Raw HTTP clients should
  send `/storage/{owner}/...` only to homeservers advertising the feature**, always with **z32**.
- **Auth:** `Authorization: Bearer` (grant-based, current) beats cookie auth (deprecated); a resolved bearer
  session takes precedence.
- **Deprecation clock:** legacy addressing, `pubky-host`, and cookie auth are removed only ≥1 year after the
  first stable SDK that uses `/storage` by default, plus explicit review. The
  [migration doc](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md)
  still marks that milestone "Not released", but 0.12.0 closes it, so the table looks stale. Either way,
  removal is not scheduled; keep the fallback.

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

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#resolve-identifiers-into-transport-urls) (`no_run`). Executed on 0.12.0: the assert holds, and a GET against a local testnet returns 200. The `pubky<z32>` input becomes raw z32 in both the hostname and the `/storage/` segment. `use reqwest::Method` needs a direct `reqwest` dependency matching pubky's version; `pubky::Method` (re-exported) avoids that. `request_async` resolves the transport and falls back to legacy addressing when needed; it does not exist before 0.12.0.</sub>

### Trust model and credible exit

> **The operator is trusted.** Today an operator can read all user data (public and `/priv`), tamper with it
> undetected (no data signing), deny service, and log access patterns. Data signing (optional, planned 2026),
> encrypted data, and homeserver mirroring are **planned, not shipped**; see
> [`shipped-vs-planned.md`](shipped-vs-planned.md). **For apps:** request minimal capabilities, don't store
> sensitive data unencrypted, and handle revoked sessions and auth failures gracefully.

- **PKARR is the source of truth for where an identity lives.** Once the user's record points at a new
  homeserver, the old one loses authority and can't impersonate them. **In practice, authority moves only as
  clients re-resolve:** DHT, relay, and app caches (including the `homeserverCache` snippet above) keep
  hitting the old server until they expire.
- **Migrating today:** sign up on the new homeserver -> re-upload data **manually** -> update the record
  (`publish_homeserver_force` / `publishHomeserverForce`).
- **Pubky Backup** (desktop) keeps local snapshots of published `/pub` data. Re-upload is manual; seamless
  restore and mirroring are planned.
- Credible exit may not be fully practical while few homeserver providers and migration tools exist. Users can
  self-host.

## Homeserver-write vs Nexus-read

**Writes and reads go to different places.** Design your data flow around this.

| Operation | Goes to | API |
| :-- | :-- | :-- |
| **Write** your own data | Author's **own homeserver** | `session.storage()` / `session.storage` (authenticated) |
| **Direct read** of a known resource | **That user's homeserver** | `pubky.public_storage()` / `pubky.publicStorage` (no auth) |
| **Aggregated social read** (feeds, followers, tags, search) | An **indexer**, e.g. Pubky Nexus | Nexus REST `/v0`: [`nexus-api.md`](nexus-api.md) |

**SDK actors** ([README mental model](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#mental-model)):

- `Pubky`: facade and starting point; owns transport. **Share one instance** (clone / `OnceCell`); don't
  build one per request.
- `PubkySigner`: local key holder for signup, signin, approving QR auth, and publishing PKDNS.
- `PubkySession`: authenticated handle with session-scoped storage.
- `PublicStorage`: unauthenticated reads of others' public data.
- `Pkdns`: resolve/publish `_pubky`.
- `GrantManager`: list/revoke grants using an authenticated root session.
- `PubkyHttpClient`: transport. `EventStreamBuilder` via `pubky.event_stream_for_user(...)` /
  `event_stream_for(&homeserver)`.

**Event streams (what indexers consume):** `GET /events-stream` is SSE of `PUT`/`DEL` events, each with a
`pubky://<user>/pub/...` URL, a `cursor`, and a blake3 `content_hash` on `PUT`. It filters by user(s) (z32,
optional cursor) and path prefixes (default `/pub/`), and supports `live` (history then real-time) and
`reverse`. **Slow live clients are disconnected.** `/priv` filters are **alpha** (see
[storage roots](#storage-roots-and-access)) and need exactly one user plus a session with read capability.
`GET /events/` pages public events for all users (limit clamps at 1000). Parameters and message format:
[`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml).

**Nexus** (nexus-watcher, nexus-webapi, nexus-common, nexusd) ingests these streams into **Neo4j + Redis** and
serves REST, e.g. `https://nexus.pubky.app/v0/stream/posts` (the global post feed).

**Social write flow:** build the object per [`app-specs.md`](app-specs.md) -> `PUT` to your homeserver -> the
homeserver emits an event -> Nexus indexes it -> others read via Nexus (or directly via public storage).

> **Nexus `/v0` is unstable.** Expect breaking changes and don't hardcode response shapes. Swagger is
> authoritative: <https://nexus.pubky.app/swagger-ui/>. Running Nexus: [`pubky-infra`](../../pubky-infra/SKILL.md).
> For read-only Cypher over the graph, use the `nexus-scout` skill.

## Authentication

Apps authenticate users through the SDK **grant auth flows** (Bearer sessions); cookie auth is deprecated.
Never collect mnemonics (see [identity](#identity-the-ed25519-keypair)). Capabilities, `pubkyauth` URLs,
relays, signup tokens, and session lifecycle: [`auth.md`](auth.md).

## Stability and known limits

- **Shipped vs. planned is a hard rule:** [`shipped-vs-planned.md`](shipped-vs-planned.md) decides what apps
  may depend on (`/priv` alpha, encryption, mirroring, backup restore).
- **Pre-1.0 everywhere:** the `/pub` layout is not stabilized, Nexus `/v0` is unstable, app-specs are v0.x.
- **Pin SDK versions.** Current: `pubky` / `@synonymdev/pubky` **0.12.0**. KB CI snippets are pinned to
  **0.10.0**. Minor releases break APIs: `get_homeserver_of` -> `Result` in 0.10.0; `signin(clientId)`,
  `ClientId`, and `request_async` are absent from 0.9.3; `/storage/` addressing arrived in 0.12.0. Verify
  against [docs.rs](https://docs.rs/pubky) / [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/)
  for your pinned version.
- **Storage addressing is migrating** (`pubky-host` -> `/storage/{z32}/...`); let the SDK choose.
- **JS `pkdns.publish*` consumes its `PublicKey` argument**, so build a fresh one per call
  ([PKARR resolution](#pkarr-resolution)).
- **LIST limit clamps at 1000**, and there is **no reliable body-size cap**; see
  [the homeserver model](#the-homeserver-model).

## Upstream references

- **Rust SDK:** [docs.rs/pubky](https://docs.rs/pubky) · [SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md)
- **JS/WASM SDK:** [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/) · [npm](https://www.npmjs.com/package/@synonymdev/pubky)
- **Homeserver client API:** [`openapi-client.yml`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/openapi-client.yml) ·
  [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md) ·
  [`STORAGE_ADDRESSING_MIGRATION.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md) ·
  [releases](https://github.com/pubky/pubky-homeserver/releases)
- **PKARR:** [pkarr](https://github.com/pubky/pkarr) · [pkdns](https://github.com/pubky/pkdns) ·
  [`SignedPacketBuilder`](https://docs.rs/pkarr/latest/pkarr/types/struct.SignedPacketBuilder.html)
- **Security model:** [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/explore/pubky-protocol/security-model.md)
- **Nexus:** [Swagger](https://nexus.pubky.app/swagger-ui/)
