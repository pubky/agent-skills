# Authentication & sessions (`pubkyauth`)

How an app gets a capability-scoped homeserver session for a user: the grant handshake, capabilities, `pubkyauth://` links, relays, recovery files, signup tokens and the session lifecycle.

Canonical elsewhere; link, don't restate:
- Identity, keypairs, recovery-file format and passphrase caveat, "sign up once, then sign in": [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair)
- `toString()` vs `z32()`: [`concepts.md#public-key-string-formats`](concepts.md#public-key-string-formats)
- Scope naming: [`concepts.md#scopes`](concepts.md#scopes-and-data-layout)
- What counts as encrypted storage (it doesn't ship): [`shipped-vs-planned.md`](shipped-vs-planned.md)
- Issuing signup tokens (operators): [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md)

## Versions

- **Current:** `pubky` **0.16.2** (crates.io) and `@synonymdev/pubky` **0.16.2** (npm `latest`), both 2026-10-15. Grant auth shipped in **0.10.0**. Harnesses pinned to 0.9.x have no grant API; 0.12.x lacks approval formats, `e` and selective approval.
- **Auth changes since 0.12:**
  - 0.15.0: browser tabs share one grant session (marked breaking; reload older tabs so they join the SDK locks; see [`grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md)).
  - 0.16.0: capability action `e` (scoped encryption keys), signed approvals (`af=v1`) delivered with HPKE, custom grant proofs. **Breaking:** build `SigninGrantParams` / `SignupGrantParams` with `new()`, not struct literals; grants containing `e` need upgraded homeservers and signers; upgrade every app and tab on an origin together.
  - 0.16.1: selective approval on the signer; relay response bodies capped at 1 MiB.
- **Unreleased on `main` (not in 0.16.2; don't use yet):** typed `CredentialRefreshError`, a stricter legacy `AuthToken` length check, quota overrides in admin `GET /signup_tokens`, `HEAD` → 405 on `/signup_tokens/{token}`, and a `websites` feature in `/info`.
- **Don't write 0.9-era code.** Renamed or deprecated: `start_auth_flow` / `startAuthFlow` / `resume_auth_flow` (now deprecated `*_cookie_*`); `signup` returning a session (returns nothing now); `signin()` without a client ID; `export_secret` / `import_secret`; `Capability::builder(scope)`.
- **Stale upstream sources:**
  - pubky-ai-kit's auth sections still use the 0.9 API (AuthTokens, sync `startAuthFlow(caps, kind, relay)`, `resumeAuthFlow`, a shared cookie, `signer.signup` returning a session). **Don't lift its auth code.**
  - The Rust SDK README's "Relay & reliability" section describes only bare-grant relay encryption (see [Relays](#relays)).
  - React Native: [`../../pubky-mobile/references/react-native.md`](../../pubky-mobile/references/react-native.md).

## Pick the right path

| You are building | Use | Capabilities granted |
| :-- | :-- | :-- |
| A third-party app (web, server, CLI) | Grant auth flow: `start_grant_auth_flow` / `startGrantAuthFlow`; user approves in an authenticator such as Pubky Ring | What you request, or less if the user narrows it |
| An authenticator, key manager or first-party tool that holds the `Keypair` | `PubkySigner`: `signup`, `signin(client_id)`, `approve_auth`, `approve_auth_with_capabilities` | `signin` always grants **root `/:rw`**, no keys |
| Anything new | **Not** cookie auth (`*_cookie*`, deprecated and insecure) | n/a |

- **Never hand-build `pubkyauth://` URLs or tokens.** Use `authorization_url()` (Rust) / `authorizationUrl` (JS) from the flow.
- **Never ask users to paste keys or mnemonics into a third-party app.** See [`concepts.md#authentication`](concepts.md#authentication).

## Grant auth model

1. The app starts a flow. It creates a fresh **PoP (proof-of-possession)** client keypair and a relay channel:
   - **Bare grant** (default): a random 32-byte `secret`; channel `base64url(hash(secret))`.
   - **Signed approval** (`af=v1`): an ephemeral X25519 HPKE key `epk`, with no `secret`; see [Relays](#relays).
2. The app shows a `pubkyauth://signin_grant?...` URL as a QR code or deep link.
3. The authenticator shows the capabilities and client ID. On consent it signs a **grant**: a `pubky-grant` JWS with `iss` (user), `client_id`, `caps`, `cnf` (client PoP public key), `jti` (grant ID), `iat`, `exp`. It encrypts the result and posts it to the relay.
4. The app decrypts it, resolves the user's homeserver, and exchanges grant + `pubky-pop` proof at `POST /auth/grant/session` for an opaque **bearer token**.
5. The SDK sends `Authorization: Bearer <token>` and mints a new one before expiry with a fresh PoP proof. No root key needed.

**Grants vs cookies:** per-client credentials; replaying a grant requires the client's private key; grants can be listed and revoked individually.

**Client ID:** required for every grant session; stored by the homeserver and shown when the user lists sessions. Use a stable domain-like string (`myapp.example`). Validation only checks non-empty and ≤253 **bytes** (`s.len()`; upstream's doc comment says "characters").

### Approval format: bare grant or signed approval

| Format | Rust | JS | URL | Carries keys |
| :-- | :-- | :-- | :-- | :-- |
| Bare grant (default) | `GrantApprovalFormat::BareGrant` | `"bareGrant"` | none | No |
| Signed approval | `GrantApprovalFormat::SignedApprovalV1` | `approvalFormat: "signedApprovalV1"` | `af=v1` | Yes, for approved `e` scopes (bundle may be empty) |

- **Use the default unless you need `e`.** A bare-grant request containing `e` is rejected ("encryption key permission requires af=v1").
- **No fallback.** An app that requests `af=v1` rejects a bare-grant response, and every `af=v1` request needs an HPKE-capable signer, even without `e`.
- **Pubky Ring:** `af=v1` support is on Ring `main` (fac51af, 2026-10-22) but **not** in the latest release, v2.0 (2026-10-05), which pins `@synonymdev/react-native-pubky` 0.14.1. Released Ring can't approve `af=v1` requests yet.
- Rust path: `pubky::deep_links::GrantApprovalFormat` (not re-exported at the crate root).

## Third-party app: grant auth flow

### JavaScript

```js
const options = { clientId: CLIENT_ID };
if (this.testnet) options.relay = TESTNET_RELAY;

const flow = await this._sdk.startGrantAuthFlow(
  this.caps,
  pubky.AuthFlowKind.signin(),
  options,
);

this._authUrl = flow.authorizationUrl;

const session = await flow.awaitApproval();

const grantInfo = await session.grant.sessionInfo();

this._pubkyZ32 = session.info.publicKey.z32();
this._grantClientId = grantInfo.clientId;
this._grantId = grantInfo.grantId;
this._grantCapabilities = grantInfo.capabilities;
```

<sub>Source (runnable browser example, unchanged since 0.12; run-ID guards and QR rendering removed): [`examples/javascript/2-auth-flow/src/pubky-auth-widget.js`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/2-auth-flow/src/pubky-auth-widget.js). Executed end to end against a local testnet with `@synonymdev/pubky` 0.16.2 (`pubky` is `import * as pubky`, as upstream). Upstream renders `_pubkyZ32` to people as "Public key"; for display use `session.info.publicKey.toString()` (`pubky<z32>`) and keep `z32()` for hostnames and keys. In strict TypeScript `session.grant` is `GrantSession | undefined` and needs narrowing.</sub>

Custom relay:

```js
import { AuthFlowKind } from "@synonymdev/pubky";

const relay = "https://httprelay.example.com/inbox/";
const flow = await pubky.startGrantAuthFlow(
  "/pub/myapp/:rw",
  AuthFlowKind.signin(),
  {
    clientId: "myapp.example",
    relay,
  },
);
```

<sub>Source (CI-verified against `@synonymdev/pubky` 0.14.0): [`pubky-knowledge-base-v2/snippets/js/src/developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts) (region `js_custom_auth_relay`). Also type-checked on 0.16.2; started on a local testnet, and the custom relay appears in `authorizationUrl` (approval not awaited, since the example relay doesn't exist).</sub>

- **Signature:** `pubky.startGrantAuthFlow(capabilities: string, kind, { clientId, relay?, xCallback?, approvalFormat? })` is **async**; always `await` it. `xCallback` is `{ xSource, xSuccess, xError, xCancel }`.
- **`authorizationUrl` is a property**, not a method.
- **Wait:** `flow.awaitApproval()` → `Session`; `flow.tryPollOnce()` → `Session | undefined`.
- **Poll from one place only.** Concurrent `awaitApproval()` / `tryPollOnce()` calls, or any call after `awaitApproval()` has consumed the flow, can throw `ClientStateError`. Stop polling once you have a session.
- **Delegated vs local PoP key.** `startGrantAuthFlow` tries a **delegated** PoP key (non-extractable WebCrypto Ed25519 key in IndexedDB) and **silently falls back** to a local key when delegation is unavailable or fails. To choose explicitly:
  - `GrantAuthFlow.start(...)`: sync, local key.
  - `await GrantAuthFlow.startDelegated(...)`: delegated; rejects with `ClientStateError` on unsupported runtimes.
  - `GrantAuthFlow.isDelegationAvailable` is a coarse sync check that misses Ed25519 support.

  The key kind decides which save API works (see [Resume after reload or restart](#resume-after-reload-or-restart)).

### Rust

```rust
use pubky::{AuthFlowKind, Capabilities, ClientId, PubkyGrantAuthFlow};
use pubky::deep_links::XCallbackParams;

let caps = Capabilities::builder()
    .read_write("/pub/example.com/")
    .expect("static scope is canonical")
    .finish();
let callbacks = XCallbackParams {
    x_source: Some("Example App".into()),
    x_success: Some("example://auth/success?nonce=unique".into()),
    x_error: Some("example://auth/error?nonce=unique".into()),
    x_cancel: Some("example://auth/cancel?nonce=unique".into()),
};

let flow = PubkyGrantAuthFlow::builder(
    &caps,
    AuthFlowKind::signin(),
    ClientId::new("example.com").expect("static client id is valid"),
)
.x_callback(callbacks)
.start()?;
```

<sub>Source (doc-tested in the 0.16.2 README): [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md). The `use` lines are hidden upstream; `XCallbackParams` is **not** re-exported at the crate root. Clippy-clean (`-D warnings`) on 0.16.2; not executed, since `start()` polls the production relay.</sub>

```rust
    let flow = start_flow(&cli)?;

    println!("Pubky Auth URL:\n{}", flow.authorization_url());
    ...
    let session = flow.await_approval().await?;
    ...
    let info = session
        .as_grant()
        .ok_or_else(|| anyhow::anyhow!("expected a grant-backed session"))?
        .session_info()
        .await;

    println!("  pubky: {}", info.pubky);
    println!("  client_id: {}", info.client_id);
    println!("  grant_id: {}", info.grant_id);
    println!("  token_expires_at: {}", info.token_expires_at);
    println!("  grant_expires_at: {}", info.grant_expires_at);
```

<sub>Source (runnable example with elisions, unchanged since 0.12): [`examples/rust/2-auth_flow/client.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/client.rs), which also shows `--testnet`, custom relay and signup options. Executed on a local testnet with 0.16.2 for both `signin_grant` and `signup_grant`.</sub>

- **Start:** `Pubky::start_grant_auth_flow(&caps, kind, client_id) -> Result<PubkyGrantAuthFlow>` is **not async**. For relay, HTTP client, approval format or x-callback control use `PubkyGrantAuthFlow::builder(&caps, kind, client_id)` with `.relay(url)`, `.client(pubky.client().clone())`, `.approval_format(..)`, `.x_callback(..)`, then `.start()` (sync). See [docs.rs `PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html).
- **Keep the flow alive.** Relay polling starts at creation and **dropping the flow cancels it**.
- **Wait:** `await_approval()` → `PubkySession`; `try_poll_once()` → `Option<PubkySession>`; `await_credential()` / `try_poll_credential_once()` yield a `GrantCredential` instead.
- `session_info().await` returns the info directly (not a `Result`); timestamps are Unix seconds.
- **x-callback URLs** return the user to your app. Put a unique nonce in them and check it on arrival. Mobile: [`../../pubky-mobile/references/ring-auth.md`](../../pubky-mobile/references/ring-auth.md).

### Sign-up through the flow

For new users pass `AuthFlowKind::signup(homeserver_pk, signup_token: Option<String>)` (Rust) / `AuthFlowKind.signup(homeserverPk, signupToken?)` (JS) instead of `signin()`. The flow produces a `signup_grant` link; the authenticator creates the account on that homeserver, then approves the grant.

### Resume after reload or restart

**A grant flow can't be resumed from its URL alone**; resuming needs the PoP private key. `resume_cookie_auth_flow` on a `signin_grant` / `signup_grant` URL fails.

| Flow | Save | Resume |
| :-- | :-- | :-- |
| Rust | `flow.save_local() -> Option<GrantAuthFlowState>` | `PubkyGrantAuthFlow::restore(state, client)` (sync) |
| JS, local PoP key | `flow.saveLocal()` | `pubky.resumeGrantAuthFlow(saved)` (sync) |
| JS, delegated PoP key | `flow.saveDelegated()` | `await pubky.resumeDelegatedGrantAuthFlow(saved)` |

```js
import { GrantAuthFlow, AuthFlowKind } from "@synonymdev/pubky";

// Before refreshing:
const flow = await GrantAuthFlow.startDelegated(caps, AuthFlowKind.signin(), {
  clientId: "my-cool-app.example",
  relay,
});
sessionStorage.setItem("pubky-grant-auth", flow.saveDelegated());

// After reloading:
const saved = sessionStorage.getItem("pubky-grant-auth");
if (saved) {
  try {
    const resumed = await pubky.resumeDelegatedGrantAuthFlow(saved);
    const session = await resumed.awaitApproval();
  } finally {
    sessionStorage.removeItem("pubky-grant-auth");
  }
}
```

<sub>Source (0.16.2 JS README, "Resume an auth flow after page refresh"): [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#resume-an-auth-flow-after-page-refresh). `AuthFlowKind` is added to the import here; upstream omits it, so its version throws `ReferenceError` when pasted. Executed on a local testnet (0.16.2, IndexedDB polyfill). For a local key use `GrantAuthFlow.start()`, `flow.saveLocal()` and `pubky.resumeGrantAuthFlow(saved)`.</sub>

- **JS: match save to key kind.** `saveLocal()` on a delegated flow and `saveDelegated()` on a local flow throw `ClientStateError`. Either start explicitly (as above), or after `startGrantAuthFlow` try `saveDelegated()` and fall back to `saveLocal()` on `ClientStateError`; remember which you saved.
- **Saved state is secret:** the relay secret or HPKE private key, **and** the PoP private key. Store briefly (e.g. `sessionStorage`), delete on completion or abandonment. It's useless once the relay inbox drops the message (~5 minutes).
- **After an SDK upgrade,** a pending signed-approval flow whose saved URL has `secret` but no `epk` can't be resumed. Restart it.
- **Rust:** serde for `GrantAuthFlowState` needs the `json` feature; `restore` checks the saved key matches the URL's `cpk`.

## Capabilities

**Format:** `<scope>:<actions>`, comma-separated (`/pub/my-cool-app/:rw,/pub/foo.txt:r`). `scope` starts with `/`. Root is `/:rw`. Actions:

| Action | Grants | Notes |
| :-- | :-- | :-- |
| `r` | GET | |
| `w` | PUT / POST / DELETE | |
| `e` | Scoped **encryption keys** for the scope (0.16.0+) | **No storage access.** Needs `af=v1`. `r`/`w` never deliver keys. See [Scoped encryption keys](#scoped-encryption-keys) |

- **Trailing slash matters (0.10+, also for `e`):** `/pub/app/` covers that directory and below, **not** `/pub/app` or `/pub/app-evil/foo`; `/pub/app` covers only that file. End directory scopes with `/`.
- **Scopes must be canonical absolute paths.** Repeated `/`, `.` and `..` are **rejected**, not normalized; percent sequences are literal.
- **The homeserver enforces capabilities on every request.** Request the narrowest scope that works.
- **The signer may approve less than you asked for** (see [Selective approval](#selective-approval)). Read the granted capabilities from the session; don't assume.
- **Rust:** `Capability::root()`; `Capability::read|write|read_write|encryption_keys(scope)` and `"/pub/app/:rw".parse()` return `Result<Capability, CapabilityParseError>`. `Capabilities::builder()` with fallible `.read(s)?` / `.write(s)?` / `.read_write(s)?` / `.encryption_keys(s)?`, plus `.cap(c)`, `.extend(iter)`, `.finish()`. `Capabilities::normalize()` merges duplicates and drops covered entries. See [docs.rs `Capabilities`](https://docs.rs/pubky/latest/pubky/struct.Capabilities.html).
- **JS:** validate user-supplied strings with `validateCapabilities` before starting a flow:

```js
import { Pubky, validateCapabilities, AuthFlowKind } from "@synonymdev/pubky";

const pubky = new Pubky();

async function signInWithFormCaps(formData) {
  const rawCaps = formData.get("caps");

  try {
    const caps = validateCapabilities(rawCaps ?? "");
    const flow = await pubky.startGrantAuthFlow(caps, AuthFlowKind.signin(), {
      clientId: "my-cool-app.example",
    });
    renderQr(flow.authorizationUrl);
    const session = await flow.awaitApproval();
    // ...
  } catch (error) {
    if (error.name === "InvalidInput") {
      surfaceValidationError(error.message);
      return;
    }
    throw error;
  }
}
```

<sub>Source: [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). Wrapped in `async function signInWithFormCaps` here: upstream's version has a top-level `return` in an ES module, which is a `SyntaxError`. Executed on a local testnet (0.16.2) with valid and invalid input. `validateCapabilities` returns the normalized string; failure throws `InvalidInput` naming the **first** bad entry, which is in `error.data.invalidEntries`. In TypeScript the returned `string` needs a cast to `Capabilities`, and `error` (typed `unknown`) needs narrowing.</sub>

## Scoped encryption keys

Released in 0.16.0. The signer derives per-scope symmetric keys from the user's identity secret and delivers them in a signed approval. **The SDK does not encrypt anything.** Your app picks the format and uses a fresh nonce for every encryption. This is app-side cryptography over public storage, not encrypted storage: [`shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto`](shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto). Full design: [`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).

```rust
let caps = Capabilities::builder()
    .read_write("/pub/chat/")?
    .encryption_keys("/pub/chat/")?
    .finish();
let flow = PubkyGrantAuthFlow::builder(
    &caps,
    AuthFlowKind::signin(),
    ClientId::new("chat.example").expect("static client id is valid"),
)
.approval_format(GrantApprovalFormat::SignedApprovalV1)
.start()?;

let session = flow.await_approval().await?;
let grant = session.as_grant().expect("grant flows create grant sessions");
if let Some(keys) = grant.encryption_keys() {
    let key = keys.derive_for_path(&StoragePath::new("/pub/chat/message")?)?;
}
```

<sub>Source (doc-tested `no_run` in the Rust README): [`pubky-sdk/README.md#request-encryption-keys`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#request-encryption-keys). Hidden imports: `use pubky::{AuthFlowKind, Capabilities, ClientId, PubkyGrantAuthFlow, StoragePath}; use pubky::deep_links::GrantApprovalFormat;`. Executed on a local testnet with 0.16.2 (testnet `.client()` / `.relay()` added); doesn't compile on 0.12. The derived 32-byte key is wiped on drop.</sub>

```js
const flow = await pubky.startGrantAuthFlow("/pub/chat/:rwe", AuthFlowKind.signin(), {
  clientId: "chat.example",
  approvalFormat: "signedApprovalV1",
});
renderQr(flow.authorizationUrl);
const session = await flow.awaitApproval();

const keys = session.grant.encryptionKeys; // undefined for bare grants
if (!keys) throw new Error("The signer returned no encryption keys.");
let key;
try {
  // The signer may narrow scopes or decline `e`.
  if (!keys.scopes.includes("/pub/chat/")) {
    throw new Error("The signer didn't approve chat keys.");
  }
  key = await keys.deriveCryptoKeyForPath("/pub/chat/message");
} finally {
  keys.free(); // The CryptoKey stays usable.
}

const iv = crypto.getRandomValues(new Uint8Array(12)); // Fresh IV every time.
const ciphertext = await crypto.subtle.encrypt(
  { name: "AES-GCM", iv }, key, new TextEncoder().encode("Hello"),
);
```

<sub>Source (JS README): [`pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys). The `if (!keys)` guard is added here; upstream omits it. Executed on a local testnet with 0.16.2 (encrypt/decrypt round trip); reading `keys` after `free()` throws.</sub>

- **API:** Rust `grant.encryption_keys() -> Option<&ScopedEncryptionKeyBundle>` (on `session.as_grant()`), `keys.scopes()`, `keys.derive_for_path(&StoragePath)`. JS `session.grant.encryptionKeys` (each read is a copy; call `free()`), `keys.scopes: string[]`, `keys.deriveForPath(path): Uint8Array`, `await keys.deriveCryptoKeyForPath(path)` (non-extractable AES-GCM-256 `CryptoKey`).
- **Prefer `deriveCryptoKeyForPath()`.** `deriveForPath()` returns a caller-owned `Uint8Array` copy of the raw key; zero it (`bytes.fill(0)`) when done.
- **Derivation fails** for a directory or a path outside the approved scopes. Rust: `DirectoryPath` / `OutsideScope` error variants. JS: `InvalidInput` with a message (no named variants).
- **Declining `e` on `af=v1`** still returns a signed approval, with an empty key bundle. Check `scopes`.
- **Keys are permanent.** They come from the identity secret and are **not** revoked when the grant expires or is revoked. There is no rotation and no forward secrecy.
- **Scope them narrowly.** A directory key covers everything below it; `e` on `/` gives every key the user will ever have. Renaming a file changes its key.
- **They don't hide much.** Keys are symmetric and don't authenticate writers. Filenames and metadata stay public, and everything under `/pub` stays world-readable.
- **Rollout order:** homeservers, then signers, then apps. Older homeservers reject any grant containing `e`, and the app can't strip `e` (the grant is signed). Requests with only `r`/`w` stay compatible.
- **Adding keys to an existing session:** request a **new** signed approval with `e` (even with the same client ID), save the new session and use its new record ID, then sign out the old session. Deleting the old record doesn't revoke it.
- **Offline recovery** (no session or network; works after grant expiry):
  - Rust: `GrantCredential::restore_encryption_keys(token: &str) -> pubky::Result<Option<(GrantClaims, ScopedEncryptionKeyBundle)>>`, or `GrantCredential::restore_encryption_keys_from_approval(grant_jws: &str, signed_approval: Option<&str>)` with the same return type. Renamed from `restore_encryption_keys_with_claims` and `restore_delegated_encryption_keys(state, approval)`.
  - JS: `EncryptionKeys.fromLocalSecret(token)` → `{ publicKey, grantId, keys }`, or `undefined` for bare-grant tokens. **Check the user and grant ID** match what you expect (`publicKey` is a z32 string; compare to `expectedUser.z32()`), and `free()` the keys.
  - Browser: `await pubky.browserSessionStore.restoreEncryptionKeys(storedId)` → `EncryptionKeys | undefined`; it checks issuer and grant itself.

## `pubkyauth://` deep links

The intent is the URL **host**. `pubkyring://` is a deprecated alias that still parses.

| Intent | Auth type | Parameters |
| :-- | :-- | :-- |
| `signin_grant` | grant | `caps`, `relay`, `cid` (client ID), `cpk` (client PoP public key, z32), plus **either** `secret` (bare grant) **or** `epk` (HPKE), optional `af=v1` |
| `signup_grant` | grant | `signin_grant` params + `hs` (homeserver z32), optional `st` (signup token) |
| `signin` | legacy cookie | `caps`, `relay`, `secret` |
| `signup` | legacy cookie | `caps`, `relay`, `secret`, `hs`, optional `st` |
| `direct_signup` | account creation only | `hs`, optional `st` |
| `secret_export` | key export (not auth) | `secret`: the user's 32-byte **identity (root) secret**, base64url. **Highly sensitive:** never log it, never generate or render it as a QR code in a third-party app |

- `secret` (auth links): 32 bytes, base64url, unpadded. `epk`: 32-byte X25519 public key, base64url, unpadded. The SDK adds `epk` automatically for `af=v1`.
- **Parser rejects:** `epk` and `secret` together ("secret must be omitted when epk is present"); `af=v1` without `epk` ("af=v1 requires one epk parameter"); a bare grant with neither (`MissingQueryParameter("secret")`). A link with `epk` uses HPKE whatever its approval format.
- **x-callback params** (optional): `x-source` (human-readable app name), `x-success`, `x-error`, `x-cancel` (cancellation or timeout). Values are percent-encoded once and decoded exactly once. Legacy `callback` is a fallback for `x-success`; emit `x-success` in new requests.
- **Empty host** (`pubkyauth:///?...`, as in AUTH.md) parses as legacy `signin`.
- **Rust `DeepLink`** (`pubky::deep_links::DeepLink`) has **6 variants**: `Signin`, `Signup`, `DirectSignup`, `SigninGrant`, `SignupGrant`, `SeedExport`. A 0.9 `match` without a catch-all won't compile. Read parameters with `.params()`.
- **Rust 0.16 breaking:** `SigninGrantParams` / `SignupGrantParams` are `#[non_exhaustive]`. The `secret` field became `relay_channel: GrantRelayChannel` (`SharedSecret([u8; 32])` | `Hpke { ephemeral_public_key }`), plus a new `approval_format` field. Build with `SigninGrantParams::new(capabilities, relay, secret, client_id, client_pk)` (bare grant); code reading `params().secret` no longer compiles.

Recognition only (a bare-grant link). **Always use the URL the flow gives you:**

```text
pubkyauth://signin_grant?caps=/pub/pubky.app/:rw&secret=kqnceEMgrNQM_xi06oQXjA3cJHX_RQmw1BY6JE1bse8&relay=https://httprelay.pubky.app/inbox&cid=franky.pubky.app&cpk=5jsjx1o6fzu6aeeo697r3i5rx15zq41kikcye8wtwdqm4nb4tryo
```

## Authenticator side (approving requests)

```rust
let deep_link = url
    .to_string()
    .parse::<DeepLink>()
    .map_err(|e| anyhow::anyhow!("Failed to parse Pubky Auth deep link: {e}"))?;

let (caps, client_id, signup) = match &deep_link {
    DeepLink::Signin(deep_link) => (&deep_link.params().capabilities, None, None),
    DeepLink::SigninGrant(deep_link) => (
        &deep_link.params().capabilities,
        Some(deep_link.params().client_id.to_string()),
        None,
    ),
    DeepLink::Signup(deep_link) => (
        &deep_link.params().capabilities,
        None,
        Some((
            &deep_link.params().homeserver,
            deep_link.params().signup_token.as_deref(),
        )),
    ),
    DeepLink::SignupGrant(deep_link) => (
        &deep_link.params().capabilities,
        Some(deep_link.params().client_id.to_string()),
        Some((
            &deep_link.params().homeserver,
            deep_link.params().signup_token.as_deref(),
        )),
    ),
    _ => anyhow::bail!("Expected a signin or signup Pubky Auth deep link"),
};

// ... consent form, recovery-file decryption -> keypair, signer = Pubky::new()?.signer(keypair) ...

if let Some((homeserver, signup_token)) = signup {
    println!("Signing up to homeserver: {homeserver}");
    signer.signup(homeserver, signup_token).await?;
    println!("Successfully signed up and published the homeserver record.");
}

signer.approve_auth(&url).await?;
```

<sub>Source (runnable example, condensed, testnet branch removed; unchanged since 0.12): [`examples/rust/2-auth_flow/authenticator.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/authenticator.rs). Import `DeepLink` from `pubky::deep_links::DeepLink`. Executed on a local testnet with 0.16.2 against real `signup_grant` and `signin_grant` URLs. It approves everything requested; it doesn't use selective approval.</sub>

- **`approve_auth`:** Rust `PubkySigner::approve_auth(&self, url) -> Result<()>`; JS `signer.approveAuthRequest(url)`. Approves **all** requested capabilities. Handles `signin`, `signup`, `signin_grant`, `signup_grant`; rejects `direct_signup` and `secret_export`. Approved grants last **2 years**.
- **`approve_auth` does not create the account.** For `signup` / `signup_grant`, call `signer.signup(homeserver, token)` first, as above.
- **`handle_deeplink(url)`** (Rust) / `handleDeepLink(url)` (JS) also handles `direct_signup` by calling `signup(hs, st)`.
- **Show consent first:** display the requested capabilities (call out `e`) and `client_id` before approving.
- **Recovery files:** `pubky` re-exports `pubky::recovery_file::{create_recovery_file, decrypt_recovery_file}`; on non-WASM targets `Pubky::signer_from_recovery_file(path, passphrase)` loads a signer directly. JS APIs, format and the passphrase caveat: [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair). Upstream examples try an **empty passphrase first** (the sample key has none); don't ship that fallback.
- **Pubky Ring:** [`../../pubky-mobile/references/ring-auth.md`](../../pubky-mobile/references/ring-auth.md).

### Selective approval

0.16.1+. Let the user approve a reduced set:

```rust
// The request includes `/pub/example.app/:rwe`; the user approves only read.
let approved = Capabilities::builder().read("/pub/example.app/")?.finish();
signer
    .approve_auth_with_capabilities(authorization_url, &approved)
    .await?;
```

```js
// The request includes `/pub/example.app/:rwe`; the user approves only read.
await signer.approveAuthWithCapabilities(authUrl, "/pub/example.app/:r");
```

<sub>Sources (not doc-tested upstream): [Rust README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md), [JS README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). Both executed on a local testnet with 0.16.2 against an `af=v1` `:rwe` request; the session came back read-only and a write was rejected.</sub>

- Works for grant and legacy `signin` / `signup` links.
- Each approved scope and action must be covered by the request; separate requested capabilities can cover different actions. You may narrow scopes or drop actions, including `e`.
- Approve nothing: `Capabilities::default()` (Rust) / `""` (JS).
- Malformed or over-broad approvals fail **before** relay delivery. Client identity, relay channel and approval format are preserved.

## Relays

- **Default:** `https://httprelay.pubky.app/inbox` (`DEFAULT_HTTP_RELAY_INBOX`, hosted by Synonym). `DEFAULT_HTTP_RELAY` (the `/link` URL) is deprecated.
- **Channel selection:** a relay path ending in `/link` or `/link/` uses the legacy synchronous link channel; anything else uses the store-and-forward inbox. A trailing slash on the base URL is optional.
- **Inbox:** holds a message ~5 minutes; the app long-polls with GET and acknowledges with DELETE; the producer can check `/ack` and `/await`. Anyone who knows an inbox ID can read, write or ACK it; the channel ID and payload encryption are what protect the flow.
- **End-to-end encrypted;** the relay sees only ciphertext and can't use the credential.
  - **Bare grant and legacy links:** channel `base64url(hash(secret))`; the payload is encrypted with `secret`, which travels only inside the `pubkyauth://` URL.
  - **`af=v1`:** the signer HPKE-encrypts the approval to the app's ephemeral key `epk`; the channel is a hash of `epk`, so a relay that sees only the channel can't forge a response. Suite and derivation: [`docs/scoped-encryption-keys.md#approval-delivery`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md#approval-delivery).
- **Size limits (signed approvals with keys can exceed them):**
  - SDK clients accept relay responses up to **1 MiB**; larger fail with an auth validation error, with no retry or downgrade.
  - `http-relay` 0.7 and `pubky-testnet` cap each request body at **2 KiB** by default.
  - An oversized approval gets **HTTP 413 at the signer** (Rust `RequestError::Server`, JS `RequestError` with `statusCode` 413). **The app is never notified** and its flow waits until expiry.
  - Raise it on relays you run: `http-relay --max-body-size 16384` or `HttpRelay::builder().max_body_size(16 * 1024)`. Apps can't change a remote relay's limit.
- **Retention:** `http-relay` keeps each body as received for `--inbox-cache-ttl` (default 300 s), in memory by default or on disk (SQLite) with `--persist-db <PATH>`; unacknowledged messages expire after 5 minutes.
- **Run your own for production.** If the default relay is down, logins can't complete. Pass it via `.relay(url)` / `{ relay }`. Project: [pubky/http-relay](https://github.com/pubky/http-relay) (the Rust README's link to httprelay.io is not the Pubky project); operating guide: [`../../pubky-infra/references/http-relay.md`](../../pubky-infra/references/http-relay.md).
- **Testnet relay:** `http://localhost:15412/inbox`. See [`testing-and-testnet.md`](testing-and-testnet.md).

## Signup tokens

Homeservers in `TokenRequired` mode need a token to create an account.

- **Pass a token:**
  - Rust: `signer.signup(&hs, Some("AAAA-BBBB-CCCC"))` (`Option<&str>`).
  - JS: `await signer.signup(hs, token)` (`string | null`).
  - Grant flow: `AuthFlowKind::signup(hs, Some(token))` adds `st` to the URL.
  - Direct link: `pubkyauth://direct_signup?hs=<z32>&st=<token>`.
  - Open and testnet homeservers accept `None` / `null`.
- **Format:** generated as upper-case hyphenated Crockford base32 (`AAAA-BBBB-CCCC`). The validator only checks 14 characters that decode as Crockford base32 once hyphens are removed; a malformed token on signup gives 400 ("Invalid signup token format"). Pass tokens through unchanged.
- **Rules:** **single use**, consumed in the same transaction that creates the account. Tokens don't expire. A token may carry a storage quota for the new user.
- **Errors** (same for grant `/auth/grant/signup` and legacy `/signup`): missing → HTTP 400 ("Token required"); unknown → 401 ("Invalid token"); used → 401 ("Token already used").
  - **JS:** these arrive as `RequestError` with `error.data.statusCode` 400 or 401, **not** `AuthenticationError` as the `signup` JSDoc claims. Branch on `statusCode`.
- **Pre-check:** `GET /signup_tokens/{token}` → `{ status: "valid" | "used", created_at }` (`created_at` is an RFC 3339 string); 400 if tokens aren't required or the format is bad, 404 if unknown. Use `GET`: unreleased `main` returns 405 for `HEAD`.
- **Issuing tokens:** [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md).

## First-party signer sign-in

Only when your code legitimately holds the user's `Keypair` (authenticator, first-party tool).

```rust
use pubky::prelude::*;
use pubky::ClientId;

let pubky = Pubky::new()?; // or Pubky::testnet() for local testnet.

// 1) Create a new random key user and bound to a Signer
let keypair = Keypair::random();
let signer = pubky.signer(keypair);

// 2) Sign up on a homeserver (identified by its public key)
let homeserver = PublicKey::try_from("o4dksf...uyy").unwrap();
signer.signup(&homeserver, None).await?;
let session = signer.signin(ClientId::new("my-cool-app").unwrap()).await?;

// 3) Read/Write as the signed-in user
session.storage().put("/pub/my-cool-app/hello.txt", "hello").await?;
let body = session.storage().get("/pub/my-cool-app/hello.txt").await?.text().await?;
assert_eq!(&body, "hello");
```

<sub>Source (doc-tested `no_run`, Rust README quick start): [`pubky-sdk/README.md#quick-start`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#quick-start). `"o4dksf...uyy"` is a placeholder that panics at `unwrap()`: pass a real homeserver key. Clippy-clean on 0.16.2 and executed on a local testnet with the testnet homeserver key substituted. The KB no longer has CI-verified Rust snippets.</sub>

```js
const homeserver = PublicKey.from(
  "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

await signer.signup(homeserver, null);

const session = await signer.signin("myapp.example");
```

<sub>Source (CI-verified against `@synonymdev/pubky` 0.14.0): [`pubky-knowledge-base-v2/snippets/js/src/developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts) (regions `js_developer_guide_signup`, `js_developer_guide_signin`). Executed on a local testnet with 0.16.2; `PublicKey.from` accepts the `pubky`-prefixed form. Upstream then logs `signer.publicKey.z32()` as "Your pubky"; for display use `toString()`.</sub>

Auth-specific behavior (the rest of signup/signin is in `concepts.md`):
- **`signup(&hs, token) -> Result<()>`** uses the reserved client ID `pubky.signup` with a 5-minute grant and publishes the `_pubky` record. It returns no session.
- **`signin(client_id)`** signs a **root `/:rw`** grant valid 2 years with a fresh PoP key and **no encryption keys**. It resolves the homeserver first, so it **fails if the user has no `_pubky` record** (never signed up, or record not published). It republishes a stale PKDNS record in the background.
- **`signin_blocking(client_id)`** waits for that republish (~3–5 s). Use it at first-time setup when the identity must be discoverable immediately.

## Session lifecycle

Grant session info: `homeserver`, `pubky`, `client_id`, `capabilities`, `grant_id`, `token_expires_at`, `grant_expires_at`, `created_at`. All timestamps are **Unix seconds**. Upstream: [`docs/grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md).

### Inspect, refresh, revalidate, sign out

- **`PubkySession` (Rust)** is cheap to clone and thread-safe. `info()` → `public_key()`, `capabilities()`; `storage()`. `as_grant()` → `Option<GrantSessionView>` with `session_info()`, `grant_id()`, `current_bearer()`, `export_local_secret()`, `encryption_keys()`, `signed_approval()`, `create_custom_pop()`. `as_cookie()` is deprecated.
- **JS:** `session.info.publicKey`, `await session.grant.sessionInfo()`.
- **Lifetimes:** bearer = min(now + **1 hour**, grant `exp`). Grant: 2 years (from `signin` or `approve_auth`) unless revoked. The SDK mints a new bearer when the current one is within **300 s** of expiry, one refresh at a time.
- **One bearer per grant.** Each exchange at `POST /auth/grant/session` replaces the grant's current bearer. Copying a grant to another app or origin doesn't give independent sessions; they invalidate each other. Independent apps need separate grants.
- **`revalidate() -> Result<Option<SessionInfo>>`** returns `Ok(None)` when the session expired or was invalidated.
- **`signout(self) -> Result<(), (Error, Self)>`** returns the session on failure; use `.map_err(|(e, _)| e)` with `?`.
  - For grant sessions it sends `DELETE /auth/grant/session`, which **revokes that session's grant**. Repeat calls are a no-op (200). Other apps' grants are unaffected.
  - Homeservers advertising the `grant-proof-logout` feature (in `/info`) accept grant + PoP at that route, so logout works even after the bearer or grant expired. Otherwise the SDK needs a valid bearer to revoke remotely.
  - **A revoked grant can't be restored** (401).
- **Force re-authentication:** sign out, then start a new flow (a signer can just `signin` again).

### Persist and restore

- **Rust and Node:** `export_local_secret()` / `exportLocalSecret()` returns a grant credential string:
  - `pubky-grant-credential-v1…` for bare grants;
  - `pubky-grant-credential-v2…` for signed approvals (even with an empty key bundle).
- **It is an unencrypted secret.** It holds the grant, its private PoP key and, for signed approvals, the encryption keys. Anyone holding it can act within the granted capabilities until the grant expires or is revoked, and the keys stay usable after that. Store it securely; never log it.
- **Restore** with `pubky.restore_session(&secret)` / `pubky.restoreSession(secret)`, which mints a fresh bearer. Don't persist the 1-hour bearer itself. `restore_session` also accepts legacy cookie secrets.
- **Restoring replaces the old session:** the old in-memory session's `revalidate()` then returns `None`. Stop using it.

```rust
use pubky::{ClientId, Pubky};

let pubky = Pubky::new()?;
let signer = pubky.signer_from_recovery_file("/path/to/alice.pkarr", "passphrase")?;
let session = signer
    .signin(ClientId::new("my-cool-app").unwrap())
    .await?;
let grant = session
    .as_grant()
    .expect("signin creates a grant-backed session");
let secret = grant
    .export_local_secret()
    .await
    .expect("signin creates an exportable local PoP key");

// Store `secret` securely, then load it when the application restarts.
let restored = pubky.restore_session(&secret).await?;
```

<sub>Source (doc-tested `no_run`, Rust README "Keypair and session persistence"; hidden `async fn` wrapper removed): [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#keypair-and-session-persistence). Executed on a local testnet with 0.16.2. The `.expect()`s are README style; in library code map the `Option`s to errors instead of panicking. The deprecated `write_secret_file` is cookie-only and **panics** on grant sessions.</sub>

JS in browsers, via `pubky.browserSessionStore`:

```js
const store = pubky.browserSessionStore;
const saved = await store.save(session);
const restored = await store.restore(saved.id);
```

JS outside browsers:

```js
const secret = await session.exportLocalSecret();
const restored = await pubky.restoreSession(secret);
```

<sub>Source (migration guide, split in two because the original declares `restored` twice): [`docs/v0.10-migration/grant-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md). Both executed on a local testnet with 0.16.2 (browser half with an IndexedDB polyfill).</sub>

- **`browserSessionStore`** is IndexedDB-backed, per-origin, multi-account, and browser-only. Methods: `isAvailable()`, `save(session)`, `list()`, `restore(id)`, `remove(id)`, `clear()`, `clearAll()` (also deletes delegated keys of pending flows), `restoreEncryptionKeys(id)`. Fields and record layout: [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md).
- **`isAvailable()` is async** (`Promise<boolean>`): write `if (await store.isAvailable())`. A bare `if (store.isAvailable())` is always truthy.
- **Units differ in `save()`'s result:** `grantExpiresAt` is Unix **seconds**, `createdAt` is Unix **milliseconds**. `storageMode` is `'delegated'` or `'localSecret'`.
- **Plaintext at rest.** The store keeps restore material, including encryption keys, as plaintext in IndexedDB; any same-origin script or a copy of the profile can read it. Only delegated signing keys are non-extractable. `exportLocalSecret()` on a delegated session throws `ClientStateError`, so use the store.
- **Signed-approval records** (`pubky-session-v2`) can't be safely shared with older SDKs: **upgrade every app and tab on an origin together.**
- **Removing isn't revoking.** `remove()`, `clear()` and `clearAll()` delete local state only. Revoke with `session.signout()` or `GrantManager.revoke(grantId)`.

### Multiple browser tabs (0.15.0+)

- **Call `browserSessionStore.save(session)` right after authentication, before making requests;** call `restore(id)` when restoring. Same-origin tabs then share one bearer per stored grant across open, close, duplicate and reload.
- Requests hold a shared Web Lock until response headers arrive; refresh takes an exclusive lock, so a slow request can delay refresh. A replayable request rejected with 401 gets at most one recovery attempt; transport failures and other HTTP errors don't replay writes.
- Needs IndexedDB, Web Locks and a secure context (`await isAvailable()` checks these). Coordination covers one origin and browser profile only; manually copied bearers and older SDKs are outside it.
- **Signout revokes the grant for every tab.** A failed signout stays pending and **blocks requests**: retry signout, or restore the saved record to finish revocation. A successful signout removes the record and its delegated key.
- Listen for `pubky-session-changed` on `window` (forwarded to other tabs via `BroadcastChannel`): `event.detail = { id, action }`, `action` is `removed` or `cleared` (`id` null).

### List and revoke grants

Requires a **root-capability** session (non-root gets 403).

- **Rust:** `GrantManager::new(&session)` (returns `Self`, not a `Result`); `.list().await` → `Vec<GrantInfo>` (its `capabilities` field is a comma-joined string); `.revoke(&GrantId::parse(s)?).await` revokes a grant and all its sessions.
- **JS:** `new GrantManager(session)`, then `.list()` / `.revoke(grantId)`.

```rust
async fn delete_session(session: PubkySession, grant_id: &str) -> Result<()> {
    let grant_id = GrantId::parse(grant_id)?;
    GrantManager::new(&session).revoke(&grant_id).await?;
    signout(session).await;
    println!("Deleted session with grant id {grant_id}.");

    Ok(())
}

async fn signout(session: PubkySession) {
    if let Err((err, _session)) = session.signout().await {
        eprintln!("Warning: failed to sign out management session: {err}");
    }
}
```

<sub>Source (runnable example, unchanged since 0.12): [`examples/rust/6-session_management/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/6-session_management/main.rs). Executed on a local testnet with 0.16.2; the revoked session's `revalidate()` then returns `None`. JS: [`examples/javascript/8-session-management.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs).</sub>

## Custom grant proofs

0.16.0+. A grant session signs arbitrary JSON with its client PoP key, so another service can verify "this user's grant signed this" **offline**, with no network call or fresh bearer. Upstream: [`docs/CUSTOM_POP.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md).

```js
import { verifyCustomGrantPop } from "@synonymdev/pubky";

const credentials = await session.grant.createCustomPop({
  audience: "my-service",
  challenge,
});

// On the recipient; works in Node.js and browsers:
const { identity, grantClaims, iat, nonce, data } = verifyCustomGrantPop(credentials);

// Optional override, in whole seconds (zero disables the allowance):
const verified = verifyCustomGrantPop(credentials, { clockSkewSeconds: 60 });
```

<sub>Source: [`docs/CUSTOM_POP.md#javascript`](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md#javascript). Executed on a local testnet with 0.16.2; a tampered proof throws. `identity` is a z32 string. In strict TypeScript `session.grant` needs narrowing.</sub>

- **Rust:** `session.as_grant()` → `.create_custom_pop(serde_json::json!({ ... })).await?`; verify with `pubky::custom_pop::verify_custom_grant_pop(&credentials, DEFAULT_CUSTOM_POP_CLOCK_SKEW)` (30 s; Rust needs an explicit allowance), then `.identity()`, `.grant_claims()`, `.data()`, `.iat()`, `.nonce()`. Upstream's fragment uses `session.as_grant()?`, which only compiles in a function returning `Option`; in a `Result` function use `.ok_or(..)?`.
- **The verifier checks only signatures, grant ID and time bounds.** It doesn't contact the homeserver, check revocation, enforce a maximum proof age or store replay state.
- **Your service must:** check the audience, challenge and freshness; consume challenges or record nonces; bound any service session by the grant's `exp`. Storage capabilities in the grant confer no permissions on your service.
- **JS numbers beyond ±2^53 lose precision;** encode them as strings in `data`.

## Errors

- **JS:** `PubkyError` with `name` ∈ `RequestError`, `InvalidInput`, `AuthenticationError`, `PkarrError`, `ClientStateError`, `InternalError` (the 0.16.2 `PubkyErrorName` union); `data` carries details such as `{ statusCode }`. HTTP rejections from the homeserver surface as `RequestError`, so branch on `data.statusCode`.
  - `ClientStateError` covers: concurrent or post-completion flow polling, delegated/local save or export mismatch, `startDelegated` on an unsupported runtime, or a grant-only call on a non-grant session.
  - `CredentialRefreshError` (Rust `Error::CredentialRefresh`) is **unreleased** (on `main` only). The JS README on `main` documents it, but 0.16.2 doesn't have it; don't branch on it yet.
- **Homeserver resolution:** JS `getHomeserverOf()` rejects with `PkarrError` on failure; sign-in and grant exchange can surface it too. Rust `get_homeserver_of` returns `Result<Option<PublicKey>>`. `pubky::Error` has **no** `is_retryable()`; match the PKARR variant: `Err(Error::Pkarr(e)) if e.is_retryable()`.

## Deprecated: cookie auth

Still present in 0.16 under explicit `*Cookie` / `_cookie` names. **Migrate to grants.** It's insecure: the cookie belongs to the homeserver's domain, so site B can reuse site A's cookie and permissions ([issue #520](https://github.com/pubky/pubky-homeserver/issues/520)). The long-lived session cookie (up to 1 year) has no replay prevention, and there is no session listing or revocation.

| 0.9 name | 0.10+ name (deprecated) |
| :-- | :-- |
| `startAuthFlow` / `resumeAuthFlow` | `startCookieAuthFlow` / `resumeCookieAuthFlow` |
| `start_auth_flow` / `PubkyAuthFlow` | `start_cookie_auth_flow` / `PubkyCookieAuthFlow` |
| `signup` / `signin` (cookie) | `signup_cookie` / `signin_cookie` / `signin_cookie_blocking` |
| `session.export_secret()` | `session.as_cookie().and_then(\|c\| c.export_secret())` |

Also deprecated: Rust `import_secret`, `write_secret_file`, `session_from_file`, `CookieSessionRecord`; JS `session.cookie`, `session.export()`, `Session.restore`. Full mapping: [`docs/v0.10-migration/cookie-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md).

**Legacy `AuthToken`** is the signed payload for cookie flows and legacy `signin` / `signup` links: an Ed25519-signed v0 token with a timestamp the homeserver accepts within ±3 minutes, rejecting a repeated `(timestamp, pubky)` pair; v0 has no delegation. Byte layout: [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md), which describes **only** this legacy payload and its shared-secret relay handshake, not grants or HPKE.

## Wire reference (debugging only; use the SDK)

- **Routes:** grant signup (`POST /auth/grant/signup`) and exchange (`POST /auth/grant/session`), current-session read/revoke (`GET`/`DELETE /auth/grant/session`), and root-only list/revoke-by-ID live under `/auth/grant/*`; deprecated cookie routes are `/signup` and `/session`. Source of truth: [`auth/router.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/router.rs).
- **JWS:** `alg: EdDSA`; `typ` is `pubky-grant`, `pubky-pop`, `pubky-grant-approval` (signed approvals) or `pubky-custom-pop-v1` (custom proofs). PoP proofs bind `aud` to the homeserver key (no cross-homeserver replay), and `iat` must be within **±180 s** of server time, so client clock skew in either direction breaks the exchange. Source: [`pop_verifier.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/grant/crypto/pop_verifier.rs).
- **Homeserver features** (`/info`, 0.16.2): `path-addressed-storage`, `grant-proof-logout`, `webdav-locks`.

## Upstream

- **Guides:** [scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md) · [grant-session-lifecycle.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md) · [CUSTOM_POP.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md) · [0.10 migration](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md) ([grant-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md), [cookie-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md))
- **Releases:** [v0.15.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.15.0) · [v0.16.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0) · [v0.16.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.1)
- **API:** [docs.rs/pubky](https://docs.rs/pubky/latest/pubky/) · [`PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html) · [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) · [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md)
- **Protocol:** [AUTH.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) (legacy payload)
- **Examples:** [rust/2-auth_flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/2-auth_flow) · [rust/6-session_management](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/6-session_management) · [javascript/2-auth-flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/2-auth-flow) · [javascript/5-browser-session-persistence](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/5-browser-session-persistence) · [javascript/8-session-management.mjs](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs). None use approval formats, HPKE or selective approval yet.
- **Relay:** [pubky/http-relay](https://github.com/pubky/http-relay)
