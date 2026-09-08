# Authentication & sessions (`pubkyauth`)

How a third-party app gets a capability-scoped session for a user without ever touching their
keys. Covers the `pubkyauth` handshake, capabilities, `pubkyauth://` URLs, relays, recovery
files, signup tokens, and the session lifecycle.

Shared protocol concepts are **not restated here** — link out:
identity / keypairs / public-key string formats / recovery-file basics live in
[`./concepts.md#identity-the-ed25519-keypair`](./concepts.md#identity-the-ed25519-keypair);
the single-cookie limit and pre-1.0 caveats in
[`./concepts.md#stability-and-known-limits`](./concepts.md#stability-and-known-limits);
signup-token **issuance/admin** (operator side) in
[`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md).

> **Version anchor.** This page documents the **shipped 0.9.3** surface — `pubky` `=0.9.3`
> (Rust), `@synonymdev/pubky` `0.9.3` (JS), `@synonymdev/react-native-pubky` `0.13.0` (RN) —
> the CI-verified KB snippets. The `pubky-homeserver` `main` checkout is a **newer, unreleased**
> generation with a grant-based rework (`startGrantAuthFlow`, `GrantSession`/`CookieSession`
> split, `approveAuthRequest`) that marks the cookie flow `@deprecated`. That rework is the
> *planned* fix for the single-cookie bug (below) — **do not** treat its API as available. Use
> `start_auth_flow` / `startAuthFlow`, `resume_auth_flow` / `resumeAuthFlow`, and
> `Session` export/restore.

**Agents: never hand-build URLs or tokens, never ask the user to paste a key or mnemonic.** Call
`start_auth_flow` / `startAuthFlow` and read the URL off the returned flow. Mnemonic-entry into a
3rd-party app is a known security risk; signing belongs to the authenticator (Pubky Ring).

## The `pubkyauth` handshake

Five participants: the **Authenticator** (e.g. Pubky Ring, the key holder), the user's **pubky**
(public key), the **homeserver**, the **3rd-party app**, and an **HTTP relay**. The app and the
authenticator never connect directly — the relay carries one **encrypted** blob between them.

1. App generates a 32-byte `client_secret`.
2. App subscribes to the relay on `channel_id = base64url(hash(client_secret))`.
3. App builds a `pubkyauth://` URL (relay + caps + secret) and shows it as a QR code.
4. Authenticator scans it and shows a consent form listing the requested capabilities.
5. On approval, the authenticator signs an `AuthToken` with the user keypair and **encrypts it
   with `client_secret`**.
6. Authenticator POSTs the encrypted token to `relay + channel_id`.
7. Relay forwards it to the app and acks the authenticator.
8. App decrypts the token, reads the `pubky`, resolves that user's homeserver, and sends the
   token to it.
9. Homeserver verifies the token and stores the granted capabilities.
10. Homeserver returns a **session id**.
11. App uses the session for capability-checked resource access.

The `AuthToken` is a **bearer token**, which is exactly why the relay only ever sees an opaque
encrypted blob — a relay (or a network observer) cannot capture a usable token.

Full protocol writeup:
[`pubky-homeserver/docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md).

### Third-party app flow (Rust)

```rust
use pubky::{AuthFlowKind, Capabilities, Pubky};

let pubky = Pubky::new()?;
let caps = Capabilities::default();
let flow = pubky.start_auth_flow(&caps, AuthFlowKind::signin())?;

// Display flow.authorization_url() as QR code for Pubky Ring to scan
let session = flow.await_approval().await?;
```

<sub>CI-verified `pubky =0.9.3`. Source: [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

**Resume** a flow after a restart/refresh by persisting `authorization_url()` and reconnecting to
the same relay channel. The URL embeds the `client_secret`, so store it only briefly and only in
short-lived storage:

```rust
use pubky::{AuthFlowKind, Capabilities, Pubky};

let pubky = Pubky::new()?;
let caps = Capabilities::default();
let flow = pubky.start_auth_flow(&caps, AuthFlowKind::signin())?;

// Persist only for the short relay TTL; the URL contains a client secret.
let authorization_url = flow.authorization_url().to_string();

// After restart or refresh, reconnect to the same relay channel.
let resumed = pubky.resume_auth_flow(&authorization_url)?;
let session = resumed.await_approval().await?;
```

<sub>CI-verified `pubky =0.9.3`. Source: [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

### Third-party app flow (JS)

JS takes the capabilities as a **string**. `awaitApproval()` resolves to the session. Resume only
works while the relay channel is alive (~5 min TTL); delete the stored URL once approved or
abandoned:

```js
const flow = pubky.startAuthFlow("/pub/myapp/:rw", AuthFlowKind.signin());

// Store only for the short relay TTL; authorizationUrl contains a secret.
sessionStorage.setItem("pubky-auth-url", flow.authorizationUrl);

// After a refresh, reconnect to the same relay channel.
const saved = sessionStorage.getItem("pubky-auth-url");
const resumed = saved ? pubky.resumeAuthFlow(saved) : flow;

const session = await resumed.awaitApproval();
sessionStorage.removeItem("pubky-auth-url");
```

<sub>CI-verified `@synonymdev/pubky 0.9.3`. Source: [`snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts)</sub>

**Errors (JS).** Catch `PubkyError` and branch on `.name`. `ClientStateError` fires if you call
`awaitApproval()` / poll concurrently on one flow, or keep polling after it completed:

```js
const error = e as import("@synonymdev/pubky").PubkyError;
switch (error.name) {
  case "RequestError": /* network/server */ break;
  case "InvalidInput": /* bad caps/relay */ break;
  case "AuthenticationError": /* approval denied/invalid */ break;
  case "PkarrError": /* resolution failed */ break;
  case "ClientStateError": /* concurrent/after-completion flow use */ break;
  case "InternalError": break;
}
```

<sub>CI-verified `@synonymdev/pubky 0.9.3`. Source: [`snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts)</sub>

## Capabilities

A capability is `<scope>:<actions>`:

- **scope** — an absolute path starting with `/` (e.g. `/pub/pubky.app/`).
- **actions** — a non-empty combo of `r` (read) and/or `w` (write), order-normalized so
  `wr` → `rw`.
- **multiple** — comma-joined: `/pub/pubky.app/:rw,/pub/foo.bar/file:r`.

| Intent | Capability |
| :-- | :-- |
| Read+write everything (**avoid** — root grant) | `/:rw` |
| Read one file | `/pub/foo.txt:r` |
| Read-write a directory | `/pub/my-cool-app/:rw` |

`GET`/`HEAD` on `/pub` are **public** (no capability needed); `PUT`/`DELETE` require a session
holding a **write** capability that covers the path.

**Builder API** (`pubky_common::capabilities`; the `pubky` crate **re-exports** both types, so a
`pubky`-only dependency uses `use pubky::{Capability, Capabilities};` rather than the
`pubky_common` path):

- `Capability::root()` → `/:rw`
- `Capability::read(scope)` · `Capability::write(scope)` · `Capability::read_write(scope)`
- `Capability::builder(scope).read().write().finish()`
- parse: `Capability::try_from("/pub/my-cool-app/:rw")` / `FromStr`
- `Capabilities` is a newtype over `Vec<Capability>`; `Capabilities::default()` is **empty** (no
  scopes — allowed); parse a comma-separated string with `"...".try_into()`;
  `Capabilities::normalize()` collapses/dedups.
- `Action` enum: `Read` / `Write` / `Unknown(char)`.

Field reference (drift-prone):
[`pubky-common/src/capabilities.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-common/src/capabilities.rs).

## `pubkyauth://` URLs

Scheme is `pubkyauth` (legacy `pubkyring` is a deprecated alias still parsed). **Do not
hand-build this** — read it from `flow.authorization_url()` / `flow.authorizationUrl`.

Canonical query params (per `AUTH.md`):

| Param | Meaning |
| :-- | :-- |
| `relay` | HTTP relay base (no `channel_id`) |
| `caps` | capabilities string |
| `secret` | base64url of the 32-byte `client_secret` |

```text
pubkyauth:///?relay=https://httprelay.pubky.app/inbox&caps=/pub/pubky.app/:rw,/pub/example.com/nested:rw&secret=mAa8kGmlrynGzQLteDVW6-WeUGnfvHTpEmbNerbWfPI
```

The HEAD SDK additionally encodes signup-flow params (`hs` = homeserver z32, `st` = signup
token) and grant-flow params (`cid` = client_id, `cpk` = client public key z32) — these belong to
the unreleased generation; treat as drift-prone.

## Relays

The relay is an end-to-end-encrypted mailbox — it sees only ciphertext and cannot mint a valid
token.

- **Default endpoint:** `https://httprelay.pubky.app/inbox` (constant
  `DEFAULT_HTTP_RELAY_INBOX`). `/inbox` replaced `/link` in http-relay **v0.7.0**;
  `DEFAULT_HTTP_RELAY` (`…/link`) is **deprecated**.
- **Auto-dispatch:** a relay URL ending in `/link` uses the old synchronous pairing; anything
  else uses the `/inbox` long-poll path.
- **`/inbox` semantics:** server persists each encrypted message for ~5 min and deletes on
  retrieval. Flow: app long-poll `GET`, Ring `POST`s the encrypted blob, app `GET`s → decrypts →
  `DELETE`-acks (producer may verify via `/ack` / `/await`).
- **Custom/self-hosted relay:** pass any relay URL. Testnet relay used in SDK tests:
  `http://localhost:15412/inbox`.

Running your own relay is operator territory:
[`../../pubky-infra/references/http-relay.md`](../../pubky-infra/references/http-relay.md).

## Signup tokens

Signup tokens (a.k.a. signup codes) gate account creation on **closed** homeservers. The
homeserver runs in a `SignupMode`; when `SignupMode::TokenRequired`, `create_new_user` requires a
valid token. Errors: `SignupTokenRequired` ("Token required"), `InvalidSignupToken`
("Invalid token"), `SignupTokenAlreadyUsed` ("Token already used"). Tokens are **single-use** —
`validate_and_consume_signup_token` marks the code consumed by the signing public key. Open /
testnet homeservers accept signup with **no token** (`None` / `null`).

Client side, you just pass the token to signup:

- Rust: `signer.signup(&homeserver, signup_token.as_deref())` (`Option<String>` → `Option<&str>`)
- JS: `signer.signup(homeserverPk, signupToken)` (`string | null`)
- RN: third positional arg to `signUp(secretKey, homeserverUrl, token?)`

Token **issuance / distribution / `SignupMode` config** is operator-side — see
[`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md).

## Session lifecycle

`signup` or `signin` returns a **session** that acts *as* the signed-in user. Each keypair yields
an independent session/identity. `signin()` refreshes PKDNS in the background (fast);
`signin_blocking()` waits ~3–5s until the homeserver is discoverable.

**Signup (Rust):**

```rust
use pubky::{Keypair, Pubky, PublicKey};

let pubky = Pubky::new()?;
let keypair = Keypair::random();
let homeserver =
    PublicKey::try_from("8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo").unwrap();

let signer = pubky.signer(keypair);
let session = signer.signup(&homeserver, signup_token.as_deref()).await?;
```

<sub>CI-verified `pubky =0.9.3`. Source: [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

**Signin / info / signout (Rust).** `session.info()` → `SessionInfo` (`.public_key()`,
capabilities); `session.storage()` for own-data CRUD. `signout()` returns
`Result<(), (Error, Self)>` — on error you get the session **back**, so map with
`.map_err(|(e, _)| e)?`:

```rust
use pubky::{Keypair, Pubky};

let pubky = Pubky::new()?;
let signer = pubky.signer(Keypair::random());

// Sign in returns a session
let session = signer.signin().await?;

// Session info
println!("User: {}", session.info().public_key());

// Sign out invalidates the session
session.signout().await.map_err(|(e, _)| e)?;
```

<sub>CI-verified `pubky =0.9.3`. Source: [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

**Signup (JS):**

```js
const signer = pubky.signer(keypair);
const session = await signer.signup(homeserverPk, signupToken);
```

<sub>CI-verified `@synonymdev/pubky 0.9.3`. Source: [`snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts)</sub>

**React Native** passes the **hex secret key** and the homeserver as a `pubky://` URL string;
the third `signUp` arg is the signup token:

```react-native
import {
  signUp,
  signIn,
  signOut,
  revalidateSession,
  getHomeserver,
} from "@synonymdev/react-native-pubky";

// Standard signup
const signUpRes = await signUp(
  secretKey,
  "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

// Signup with token (for gated homeservers)
const signUpWithTokenRes = await signUp(
  secretKey,
  "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
  "your_signup_token",
);

// Sign in
const signInRes = await signIn(secretKey);

// Get homeserver
const homeserverRes = await getHomeserver(publicKey);
```

<sub>Verified against `@synonymdev/react-native-pubky 0.13.0` ([README](https://github.com/pubky/react-native-pubky/blob/main/README.md) · [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)).</sub>

### Persisting a session

A session is **persistable** so an app survives restart without re-authenticating. **What the
exported string contains — and how to store it — differs by SDK:**

- **Rust `export_secret()`** returns a **bearer secret**: treat it like a credential (encrypt at
  rest, never log it).
- **JS `session.export()` (0.9.3)** contains **no secrets** — it serializes only the public
  `SessionInfo`, and auth rides on the browser's HTTP-only session cookie, so the string is safe to
  keep in `localStorage`. (Dev-HEAD adds `session.exportSecret()`, which *does* return a bearer
  credential — that is **not** in 0.9.3.) Details: [`./sdk-js.md`](./sdk-js.md).

**Rust** — `export_secret()` → token string; `PubkySession::import_secret` restores it (async;
pass the existing client to reuse its connection pool):

```rust
// Export session as a portable string (e.g. save to disk before shutdown)
let token = session.export_secret();

// On restart, restore without re-authenticating.
// Pass the existing client to reuse its connection pool.
let restored = pubky::PubkySession::import_secret(&token, Some(pubky.client().clone())).await?;
```

<sub>CI-verified `pubky =0.9.3`. Source: [`snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs)</sub>

**JS** — `session.export()` → string; `Session.restore(exported)` (async):

```js
// Export session as a portable string (e.g. save to storage before shutdown)
const exported = session.export();

// On restart, restore without re-authenticating
const restored = await Session.restore(exported);
```

<sub>CI-verified `@synonymdev/pubky 0.9.3`. Source: [`snippets/js/src/sdk.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/sdk.ts)</sub>

## Recovery files

A recovery file is a **passphrase-encrypted keypair backup**. In the handshake, the authenticator
decrypts its recovery file to recover the keypair, then signs the `AuthToken`. Keypair and
recovery-file **basics** (and the `keygen.rs` example) are canonical in
[`./concepts.md#identity-the-ed25519-keypair`](./concepts.md#identity-the-ed25519-keypair) —
not restated here. Helpers (`pubky_common::recovery_file`):

- `create_recovery_file(keypair: &Keypair, passphrase: &str) -> Vec<u8>`
- `decrypt_recovery_file(recovery_file: &[u8], passphrase: &str) -> Result<Keypair, Error>`

At HEAD the `Pubky` facade also offers a convenience
`signer_from_recovery_file<P: AsRef<Path>>(path, passphrase) -> Result<PubkySigner>` (non-WASM
only) that reads + decrypts the file and returns a signer.

## Authenticator side (rare — Pubky Ring's job)

Most apps never implement this; it's the authenticator that scans the QR, shows consent, and
approves. The names below are from **`pubky-homeserver` examples at `d6c5afc`**, *not* the 0.9.3-pinned CI
snippets — drift-prone; verify against the published crate before shipping. The authenticator
parses the URL to a typed deep link (`SigninDeepLink` / `SignupDeepLink`), reads requested
capabilities for consent, decrypts its recovery file, builds a signer, then approves
(`approve_auth(&self, pubkyauth_url: impl AsRef<str>) -> Result<()>`, which rejects
seed-export deep links):

```rust
use pubky::{deep_links::SigninDeepLink, Pubky, PublicKey};

let deep_link = url
    .to_string()
    .parse::<SigninDeepLink>()
    .map_err(|e| anyhow::anyhow!("Failed to parse sign in deep link: {e}"))?;
let caps = &deep_link.params().capabilities;
if !caps.is_empty() {
    println!("\nRequested capabilities:\n  {}", caps);
}

// Consent: decrypt recovery file to recover the keypair
let keypair = pubky_common::recovery_file::decrypt_recovery_file(&recovery_file, &passphrase)?;
let signer = Pubky::new()?.signer(keypair);

signer.approve_auth(&url).await?;
```

<sub>Snapshot at `d6c5afc` (NOT 0.9.3-pinned — verify before use). Source: [`pubky-homeserver/examples/rust/3-auth_flow/authenticator.rs`](https://github.com/pubky/pubky-homeserver/blob/d6c5afc7ff0481ae7c343d1e2bd2be312ce8c811/examples/rust/3-auth_flow/authenticator.rs)</sub>

JS authenticator equivalent at that snapshot: `signer.approveAuthRequest(flow.authorizationUrl)`.

## AuthToken wire format

You won't normally serialize this by hand, but the homeserver verifies it and the layout pins the
~3-minute validity window. ABNF (after signature, everything is what the signature covers):

```text
auth_token = signature namespace version timestamp pubky capabilities

signature    = 64 OCTET            ; ed25519 over serialized_token[65..]
namespace    = 10 OCTET            ; ASCII "PUBKY:AUTH"
version      =  1 OCTET            ; CURRENT_VERSION = 0
timestamp    =  8 OCTET            ; big-endian UNIX microseconds
pubky        = 32 OCTET            ; ed25519 public key
capabilities = *( capability "," ) capability   ; "<scope>:<actions>", actions r/w
```

Confirmed in code
([`auth_token.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-common/src/auth/auth_token.rs)):

- `CURRENT_VERSION = 0` (`u8`); verification checks the version byte at **index 74** is
  `<= CURRENT_VERSION`.
- `TIMESTAMP_WINDOW = 180 * 1_000_000` — **3 minutes in microseconds** (the validity window).
- `PUBKY_AUTH` namespace is `[u8; 10]`. The `PUBKY:AUTH` namespace prevents cross-protocol
  replay.
- **Replay protection:** the homeserver treats `(timestamp, pubky) = serialized_token[75..115]`
  as a unique sortable ID, rejects duplicates, and evicts IDs older than the window.

## Known limitations

These are canonical in
[`./concepts.md#stability-and-known-limits`](./concepts.md#stability-and-known-limits) — summary
only:

- **Single auth cookie** ([pubky-homeserver#122](https://github.com/pubky/pubky-homeserver/issues/122)): all
  sessions currently share **one** authentication cookie, so signing into App B overwrites App
  A's session. A JWT / grant-based session rework is in progress (the HEAD grant API noted at the
  top is that fix — **not yet shipped**).
- **No key delegation:** the `AuthToken` must be signed by the user's **main key** — in v0 the
  issuer **is** the pubky.
- **Resume window:** `resume_auth_flow` / `resumeAuthFlow` only works while the relay channel is
  within its ~5-minute retention. The saved `authorizationUrl` contains the `client_secret` —
  keep it in short-lived storage (e.g. `sessionStorage`) and delete it once approved or
  abandoned.

Honor the shipped-vs-planned guardrail:
[`./shipped-vs-planned.md`](./shipped-vs-planned.md).
