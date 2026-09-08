# Pubky protocol concepts

> **CANONICAL.** Single source of truth for this material. The `pubky-mobile` and `pubky-infra` skills link here — never copy.

Pubky is an open protocol for **per-public-key backends** that make censorship-resistant web
apps possible. It pairs [PKARR](#pkarr-resolution) — a public-key-based, censorship-resistant
alternative to DNS — with ordinary web tech, so users own their identity and data while
developers get web-app availability without operating a central database.

Pubky includes the protocol and its implementations:

1. **The open protocol spec** — public-key auth, capability-based authorization, key/value
   storage semantics, homeserver discovery via PKARR, and a RESTful API.
2. **The Pubky Homeserver implementation** — hosts one user's data per public key, exposes the RESTful
   HTTP API, manages auth/sessions, publishes its own PKARR record, and stores files separately
   from its PostgreSQL-backed metadata.
3. **The Pubky SDKs** — Rust (native), JavaScript/WASM, and iOS/Android native bindings.

## The one mental model

Everything in Pubky hangs off this chain. Anchor on it:

```
User identity (public key)
  -> PKARR record (Mainline DHT)
    -> points to a homeserver
      -> stores the user's data (filesystem, under /pub)
        -> read/written by apps (via an SDK)
```

The key never moves; the homeserver can. Resolution always starts from the public key and
follows its PKARR record to wherever that user's homeserver currently lives.

## Identity: the Ed25519 keypair

A Pubky identity **is** an Ed25519 keypair the user fully controls — there is no account, no
password, and no server-side recovery path:

- The **private key** (a 12-word mnemonic / recovery seed) never leaves the user's device.
- The **public key** is the user's publicly addressable domain.
- Lose both the device and the mnemonic and that identity is gone for good — self-custody, like
  Bitcoin. Each pubky has its own mnemonic.

Mint a fresh identity with `Keypair::random()` (Rust) / `Keypair.random()` (JS).
`pubky.signer(keypair)` yields a `PubkySigner` (the key holder that signs); signing in or up
yields a `PubkySession` (the per-identity, stateful API driver). See
[`sdk-rust.md`](sdk-rust.md) / [`sdk-js.md`](sdk-js.md) for the full surface and
[docs.rs/pubky](https://docs.rs/pubky) for the authoritative (drift-prone) Rust API.

Keys are backed up as **passphrase-encrypted recovery files**. In `pubky-common` the helpers are
`create_recovery_file(&keypair, &passphrase)` and `decrypt_recovery_file`; each SDK exposes
equivalent bindings (React Native: `createRecoveryFile` / `decryptRecoveryFile`, returning
Base64). The full auth/recovery handshake lives in [`auth.md`](auth.md).

```rust
use pubky_common::crypto::Keypair;
use pubky_common::recovery_file::create_recovery_file;

// 1) Generate a fresh keypair
let keypair = Keypair::random();
println!("Public key: {}", keypair.public_key());

// 2) Encrypt and save the recovery file
let recovery_bytes = create_recovery_file(&keypair, &passphrase);
std::fs::write(&output_path, &recovery_bytes)?;
```

<sub>Source: [`pubky-homeserver/examples/rust/keygen.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/keygen.rs)</sub>

### Public-key string formats

Two renderings of the same key, used in different places — **do not mix them**:

| Method | Returns | Use for |
| :-- | :-- | :-- |
| `publicKey.toString()` | display form `pubky<z32>` | UI, logs, human-facing references |
| `publicKey.z32()` | raw z-base-32 string | hostnames, `_pubky.<z32>` DNS names, headers, query params, serde/JSON fields, DB keys |

The raw z-base-32 public key is **52 characters** (DNS-compatible).

## Addressing and the /pub tree

A user's public data is addressed by their public key plus a path under `/pub`. Three forms
appear, all naming the same resource:

| Form | Example | Where |
| :-- | :-- | :-- |
| Addressed (bare, no scheme) | `pubky<pk>/pub/app/file.json` | preferred public-storage address in SDK APIs |
| URL / deeplink | `pubky://<pk>/pub/app/file.json` | accepted by SDK parsers; used by CI-verified KB snippets |
| Session-relative | `/pub/app/file.json` | the *current* signed-in user's own storage |

`<pk>` is the z-base-32 public key (usually displayed with the `pubky` prefix). `/pub` is the
**only** protocol-required top-level directory; every segment after it is app-chosen.

**Own vs. other:** use the session-relative path with `session.storage` (JS) / `session.storage()`
(Rust) to read or write the **current** user's own data; use the addressed form with
`pubky.publicStorage` (JS) / `pubky.public_storage()` (Rust) to read **someone else's** public
data. This own-write vs. public-read distinction is the heart of the
[homeserver-write vs Nexus-read split](#homeserver-write-vs-nexus-read).

**Scopes.** By convention the first segment under `/pub` is a *scope*, and one app may touch
several. Two flavors: an **app-domain** scope for an app's own data (`pubky.app`, `mapky.app`,
`bitkit.to`), and a **protocol** scope for a cross-app shared standard (`paykit`). Real apps mix
them — Mapky writes `/pub/mapky.app/*` and reuses `/pub/pubky.app/*`; Bitkit writes
`/pub/bitkit.to/*` and uses `/pub/paykit/*`. The `pubky.app` social schema (profile, posts,
tags, follows…) is defined by **pubky-app-specs** — that on-wire data contract is canonical in
[`app-specs.md`](app-specs.md), not here.

**Path constraints** on the homeserver tenant API:

- Paths must start with `/pub/`. Anything outside `/pub/*` is not reachable today — a
  `/private/` prefix appears in the API docs only as a **planned (not shipped)** prefix.
- `GET`/`HEAD` are public (unauthenticated); `PUT`/`DELETE` require a session with a write
  capability.
- Max path length **1024 bytes**; allowed characters `a-z A-Z 0-9 - _ / .`.

> The `/pub` layout itself is **not stabilized** — treat the path conventions above as current
> practice, not a frozen contract.

```js
// Read another user's public data — addressed (pubky://) form
const text = await pubky.publicStorage.getText(
  `pubky://${userPk}/pub/myapp/profile` as Address,
);
```

```rust
// Read another user's public data — Rust takes a (&PublicKey, path) tuple
let user = PublicKey::try_from(user_public_key).unwrap();
let resp = pubky
    .public_storage()
    .get((&user, "/pub/myapp/profile"))
    .await?;
let text = resp.text().await?;
```

<sub>Sources: [`pubky-knowledge-base-v2/snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts), [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

## PKARR resolution

**PKARR** (Public-Key Addressable Resource Records) lets self-issued public keys act as
publicly addressable domains by bridging DNS and p2p overlay networks:

- **Publish:** create a small signed DNS packet (`<=1000` bytes) and store it on the **Mainline
  DHT** (directly or via an HTTP relay).
- **Resolve:** query the DHT (directly or via relay) for the key and verify the Ed25519
  signature yourself.
- Apps unaware of PKARR can still reach records via **DNS-over-HTTPS (DoH)** to PKARR/PKDNS
  servers. Clients and servers cache records heavily to spare the DHT.

**SignedPacket layout** — `public-key(32) + signature(64) + timestamp(8) + dns-packet(<=1000)`,
max **1104 bytes** total. Every packet is Ed25519-signed (authenticity + integrity), published
to the DHT as a **BEP44 mutable item**, and queried by the SHA1 hash of the public key.
Supported record types: A, AAAA, CNAME, TXT, and HTTPS/SVCB (RFC 9460).

> DHT (BEP44) storage is **ephemeral** — records degrade over hours to days and must be
> **republished** (~hourly). Homeservers and relays run republishers (`pkarr-republisher`) to
> keep user and server keys alive. The DHT is not a storage platform and is heavily cached, so
> updates are **not real-time**. Backed by Mainline's ~10M-node DHT (BitTorrent), it provides
> censorship and Sybil resistance (BEP42).

**Homeserver discovery uses two records.** Resolving a user chains through both:

1. The **user's** record publishes `_pubky` as an HTTPS/SVCB alias pointing at the homeserver's
   public key (signed by the user key, queried as `_pubky.<user-public-key>`).
2. The **homeserver's** record (signed by the homeserver key) advertises the real endpoints —
   typically both a direct PubkyTLS endpoint and an ICANN endpoint.

SDK clients resolve the full `_pubky.<user-public-key>` name so the alias chains to the
homeserver's endpoint records:

```text
# User packet, signed by the user key, queried as _pubky.<user-public-key>
_pubky HTTPS 0 <homeserver-public-key>

# Homeserver packet, signed by the homeserver key
. HTTPS 1 . port=6287
. A 203.0.113.10
. HTTPS 10 homeserver.example.com port=443
```

**Relays and clouds.** Browsers and any UDP-less / firewalled environment must publish and
resolve through an **HTTP relay** (the DHT runs over UDP). Relays are also needed in major
clouds (AWS/GCP/Azure) whose IP ranges DHT nodes commonly block — running pkarr/mainline
directly there often fails, and the fix is relays hosted in smaller providers. **PKDNS** is the
DNS-server bridge that resolves 52-char public-key domains from the DHT (with ICANN fallback)
and supports DoH.

**In practice the SDK resolves transparently** — hand it a Pubky URL/resource and it resolves
the record, picks a transport, and adds the `pubky-host` header. To resolve a user's homeserver
key explicitly use `pubky.get_homeserver_of(&user)` (Rust, returns `Option`).
`signin_blocking()` / `signinBlocking()` waits ~3–5s for PKDNS discoverability, whereas
`signin()` refreshes PKDNS in the background.

The PKARR spec, the full `SignedPacket` format, and the reference implementation live at
[github.com/pubky/pkarr](https://github.com/pubky/pkarr); see also
[pkdns](https://github.com/pubky/pkdns) and the [mainline](https://github.com/pubky/mainline)
DHT client ([docs.rs/mainline](https://docs.rs/mainline)).

## The homeserver model

A **homeserver** is a user's personal data store: it provides data availability and HTTP
endpoints, validates auth tokens, and manages exactly one user's data per public key. The
network deliberately allows **many independent homeservers** — that's what improves censorship
resistance and prevents walled gardens. A user can relocate at will by updating their PKARR
record. Anyone can run a homeserver on their own terms; the network is currently bootstrapped by
Synonym's first homeserver and needs more independent operators to fully decentralize. (Operating
one is the [`pubky-infra`] skill's domain.)

**The app-facing API is file storage only:** HTTP `PUT`/`GET`/`DELETE` (plus `LIST` with
pagination, `HEAD`/exists, and stats) against `pubky://<pk>/pub/...` paths. Each entry is an
**opaque byte blob with a MIME type** — typically JSON (pubky-app-specs records), but equally
images, audio, video, PDFs, ciphertext, anything; there is no protocol-level content-type
restriction. The default per-request payload limit is **10 MB** (`413` past that), independent
of operator-defined per-user quotas (Synonym's public homeserver: 1 GB/user, 10 MB/file).
`LIST` defaults to **100** entries (max **1000**). Homeservers may rate-limit — treat `429` as
normal and retry with backoff.

**Internally**, a homeserver uses **PostgreSQL for its own metadata only** — users (Ed25519
pubkey + quota), sessions (capability-scoped auth), entries (per-file path, Blake3 hash, length,
MIME, timestamps), events (the `PUT`/`DEL` stream consumed by Nexus, Pubky Backup, and other
subscribers), and signup codes. **User file content is stored separately in a filesystem under
`/pub/`.** Applications never connect to PostgreSQL — they only ever see the file API.
PostgreSQL-backed homeservers are a **shipped** feature.

**Two transports.** A homeserver exposes a **PubkyTLS direct endpoint** (TLS with Raw Public
Keys, RFC 7250 — the public key *is* the identity, no CA chain; verified directly against the
public key from PKARR) and an **ICANN endpoint** behind a reverse proxy with standard X.509 TLS.
Native SDK targets (Rust / native mobile, **not** browser/WASM) prefer the PubkyTLS endpoint and
auto-fall back to ICANN when the direct one is unreachable (NAT, tunnels); browsers/WASM use the
ICANN HTTPS path from the start. During ICANN fallback the request goes to the ICANN domain with
the user public key preserved in the **`pubky-host`** header. (PubkyTLS default port in examples:
`6287`.)

> **Public data only, today.** Current homeservers support only public, unencrypted data under
> `/pub`. Encrypted data and guarded (access-controlled) storage are **planned, not shipped** —
> never present `/priv`, encrypted, or guarded storage as available. A trusted operator can
> currently read, tamper with, or deny-serve all user data (no data signing yet); this is
> mitigated by **credible exit**, not by cryptography. See
> [`shipped-vs-planned.md`](shipped-vs-planned.md).

**Credible exit** is built into the architecture: identity follows the keys, not the server.
PKARR is the authoritative source of truth for identity resolution — the moment a user repoints
their PKARR record at a new homeserver, the old one **loses authority immediately** and cannot
impersonate them. Migration today means: sign up on a new homeserver, re-upload data (manual —
restore and homeserver mirroring are planned, not shipped), then update the PKARR record. **Pubky
Backup** keeps local one-way copies/snapshots of public `/pub` data to lower the cost of leaving
(no automatic restore, no tamper detection yet).

## Homeserver-write vs Nexus-read

This is the core architectural point of Pubky. **Writes and reads do not go to the same place.**

- **Writes** go directly to the **author's own homeserver** — authenticated `PUT`/`DELETE` on
  `/pub/...` via `session.storage`.
- **Reads** come in two flavors:
  - **Direct / canonical** — fetch a *known* user's public resource via
    `publicStorage` / `public_storage` (unauthenticated `GET` on `pubky://<pk>/pub/...`).
  - **Aggregated / social** — feeds across many users, followers, tags, notifications, search —
    via a separate indexer, **Pubky-Nexus**, over its hosted `/v0` REST API.

**Nexus never accepts writes.** You never "write to Nexus"; you write to your homeserver and
Nexus indexes it. The SDK encodes the split as two storage objects: **`SessionStorage`**
(authenticated, acts *as* the signed-in user — read + write own data) vs. **`PublicStorage`**
(reads any user's public data, unauthenticated). Rust: `session.storage()` vs.
`pubky.public_storage()`. JS: `session.storage` vs. `pubky.publicStorage`.

**Event streams are the glue** between homeservers and indexers/backups. On each `PUT` the
homeserver emits a `PUT` event carrying a cursor (`u64`) and a base64-encoded Blake3 content
hash (32 bytes); `DELETE` emits `DEL`. Subscribers (Nexus, Pubky Backup, watchers) consume the
stream from a persisted cursor — they do **not** poll or recursively list `/pub`. Two endpoints:
`GET /events-stream` (SSE; per-user + path filters, up to 50 users, `user=<z32>:<cursor>` resume
and `live=true` — the primary client API) and `GET /events/` (paginated feed of all users,
1000/batch — for indexers and aggregators).

**Pubky-Nexus** is the production-grade indexing/aggregation service that ingests homeserver
event streams into a high-performance social-graph API powering Pubky App's social features
(feeds, search, recommendations, notifications, web-of-trust). Components: `nexus-watcher` (event
aggregator subscribing to homeserver streams), `nexus-webapi` (REST API server, formerly
`nexus-service`), `nexus-common` (shared lib), `nexusd` (orchestration daemon); backing stores
Neo4j (the social graph) + Redis (caching); built in Rust on Axum. Clients may optionally verify
content authenticity directly with homeservers. The concrete `/v0` endpoint catalog is
drift-prone and lives in [`nexus-api.md`](nexus-api.md); the Swagger UI is the source of truth:
<https://nexus.pubky.app/swagger-ui/> (staging: <https://nexus.staging.pubky.app/swagger-ui/>).

> The Nexus `/v0` API is explicitly **unstable and breaking-change-prone** (the `/v0` prefix
> signals instability). Do not hardcode its shapes — link the Swagger and treat responses
> defensively.

**End-to-end social flow:**

1. The app validates and builds data with pubky-app-specs.
2. The app writes it to the user's homeserver via the SDK client.
3. The homeserver stores the file and emits a `PUT` event (cursor + content hash).
4. Nexus / Pubky Backup / other subscribers consume the event stream.
5. Nexus updates Neo4j + Redis.
6. Other users read feeds via the Nexus API **or** read public resources directly via
   `publicStorage`.

The write path, end to end (create client → signer from a random keypair → signup → write own
data):

```js
import { Pubky, Keypair } from "@synonymdev/pubky";

// Create client and signer
const pubky = new Pubky();
const signer = pubky.signer(Keypair.random());

// Sign up (pass a signup token for gated homeservers, null for open/testnet)
const session = await signer.signup(homeserverPk, null);

// Store data
await session.storage.putJson("/pub/myapp/profile", {
  name: "Alice",
  bio: "Decentralized and loving it!",
});

// Retrieve data
const profile = await session.storage.getJson("/pub/myapp/profile");
```

<sub>Source: [`pubky-knowledge-base-v2/snippets/js/src/quick-start-intro.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/quick-start-intro.ts)</sub>

**Clients.** Prefer **one shared `Pubky` facade** per app/process rather than a new client per
request. Construct mainnet with `new Pubky()` / `Pubky::new()`, testnet with
`Pubky.testnet(<relay-url>)` / `Pubky::testnet()`. Use testnet for development, mainnet for
production — see [`testing-and-testnet.md`](testing-and-testnet.md). docs.rs/pubky (v0.9.3)
confirms the surface: `Pubky::new()`, `testnet()`, `signer()`, `public_storage()`,
`get_homeserver_of()`, `start_auth_flow()`, `client()`; `PubkySigner::signup()`, `signin()`,
`approve_auth()`, `pkdns()`; `PubkySession::storage()`, `info()`.

## Authentication

Authentication uses **AuthTokens** — signed, time-limited, capability-scoped tokens proving
public-key ownership, valid for a **~3-minute window** (clock-drift / replay protection). The
`PUBKY:AUTH` namespace prevents cross-protocol replay. Capability format is `<path>:<rights>`,
e.g. `/pub/my-app/:rw`, `/pub/file.txt:r`, `/:rw` (avoid root). **Third-party apps should use the
SDK auth flows** (`start_auth_flow` produces a `pubkyauth://` URL for Pubky Ring) — never ask
users to paste keys or mnemonics. Mnemonic-fallback auth (entering a 12-word mnemonic directly
into a 3rd-party app) is a known security risk and should only happen on trusted infrastructure
(Ring or the user's own homeserver). The full auth flow and token wire layout live in
[`auth.md`](auth.md).

## Stability and known limits

- **Shipped vs. planned** is a hard guardrail: public `/pub` storage, capability-scoped sessions,
  PKARR identity/discovery, pubky-app-specs models, resumable `pubkyauth` flows, event streams,
  local Pubky Backup, and PostgreSQL-backed homeservers ship today; `/priv`, encrypted/guarded
  storage, homeserver mirroring, and backup *restore* do not. Never present a planned item as
  available — full canonical list: [`shipped-vs-planned.md`](shipped-vs-planned.md).
- **Pre-1.0 churn:** the `/pub` path layout is not stabilized, the Nexus `/v0` API is
  breaking-change-prone, and app-specs are v0.x. PKARR DHT records are ephemeral (republished)
  and DHT reads are heavily cached / not real-time.
- **Single session cookie** ([pubky-homeserver#122](https://github.com/pubky/pubky-homeserver/issues/122)):
  all sessions currently share one auth cookie, so signing into App B overwrites App A's session;
  a JWT-based session-management rework is in progress.

## Upstream references

- **Rust SDK API** (authoritative, drift-prone; currently v0.9.3): [docs.rs/pubky](https://docs.rs/pubky)
- **JS/WASM SDK:** [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) ·
  **React Native binding:** [`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky)
- **Pubky protocol docs** (protocol / homeserver / API): [Developer guide](https://pubky.org/explore/pubky-protocol/getting-started/) ·
  homeserver implementation + config: [Pubky Homeserver](https://github.com/pubky/pubky-homeserver/tree/main/pubky-homeserver)
- **PKARR / DHT:** [pkarr](https://github.com/pubky/pkarr) ·
  [pkdns](https://github.com/pubky/pkdns) · [mainline](https://github.com/pubky/mainline)
- **Nexus read API** (Swagger, source of truth): <https://nexus.pubky.app/swagger-ui/>

[`pubky-infra`]: ../../pubky-infra/SKILL.md
