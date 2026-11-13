# Authentication & sessions (`pubkyauth`)

How an app gets a homeserver session scoped by capabilities: the grant handshake, capabilities, `pubkyauth://` links, relays, recovery files, signup tokens and the session lifecycle.

These topics are covered in other files. Link to them rather than restating them here:
- Identity, keypairs, recovery-file format and the passphrase caveat, "sign up once, then sign in": [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair)
- `toString()` vs `z32()`: [`concepts.md#public-key-string-formats`](concepts.md#public-key-string-formats)
- Scope naming: [`concepts.md#scopes-and-data-layout`](concepts.md#scopes-and-data-layout)
- What counts as encrypted storage (it doesn't ship): [`shipped-vs-planned.md`](shipped-vs-planned.md)
- Issuing signup tokens (for operators): [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md)

## Versions

- **Current:** `pubky` **0.18.0** (crates.io) and `@synonymdev/pubky` **0.18.0** (npm `latest`), both released 2026-11-09. 0.17.1 shipped 2026-10-26. **There is no 0.17.0** on crates.io or npm. Grant auth shipped in **0.10.0**. Harnesses pinned to 0.9.x have no grant API. 0.12.x lacks approval formats, `e` and selective approval.
- **Snippet provenance:** every snippet below was executed (or, where its source line says so, type-checked or clippy-checked) against `pubky` =0.18.0 and `@synonymdev/pubky` 0.18.0 on a local testnet. The upstream example sources haven't changed since 0.16.2. Only the JS example tooling moved, to Vite 8 (Node `^20.19.0` or `>=22.12.0`).
- **Auth changes since 0.12:**
  - 0.15.0: browser tabs share one grant session. This is marked breaking: reload older tabs so they join the SDK locks. See [`grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md).
  - 0.16.0: capability action `e` (scoped encryption keys), signed approvals (`af=v1`) delivered with HPKE, and custom grant proofs. **Breaking:**
    - Build `SigninGrantParams` / `SignupGrantParams` with `new()`, not struct literals.
    - Grants that contain `e` need upgraded homeservers and signers.
    - Upgrade every app and tab on an origin together.
  - 0.16.1: selective approval on the signer. Relay response bodies are capped at 1 MiB.
  - 0.17.1:
    - Typed failures for grant refresh (`CredentialRefreshError` / Rust `Error::CredentialRefresh`).
    - Request error categories (`RequestErrorData.reason`).
    - The length of a legacy `AuthToken` is checked before its version byte is read.
    - Admin `GET /signup_tokens` shows quota overrides.
    - Static website serving (`websites` in `/info`).
    - **Breaking:** `HEAD` returns 405 on `/signup_tokens/{token}`, on admin `/generate_signup_token` and on both `/events-stream` endpoints.
  - 0.18.0:
    - Grant sign-in links can require an expected identity ([`spk`](#require-a-specific-identity-spk)).
    - Grant [`account()`](#account-usage-and-quota) (`GET /account`).
    - `TlsVerification` request errors.
    - The homeserver checks stored grant claims on session exchange (403 on a mismatch).
    - **Breaking:** grant requests and `revalidate()` [recover once from a rejected bearer](#401-recovery-and-revalidate).
- **Cookie auth sunset:** deprecated since 0.10.0. From 0.18.0 it gets only limited security maintenance, and **it will be removed in August 2027**. See [Deprecated: cookie auth](#deprecated-cookie-auth).
- **Unreleased on `main` (after 0.18.0, don't use yet):**
  - Parent/child grants and the `grant-delegation` feature in `/info` ([below](#unreleased-parent-and-child-grants)).
  - `kind` / `parentId` in `GrantManager.list()`.
  - Clearer errors for concurrent signups (#777).
  - `request_timeout` on WASM, with `BuildError::RequestTimeoutTooLong`.
  - Bounded reads for grant sessions, `revalidate` and grant listing (#725).
- **Don't write 0.9-era code.** These were renamed or deprecated:
  - `start_auth_flow` / `startAuthFlow` / `resume_auth_flow` (now the deprecated `*_cookie_*` names).
  - `signup` returning a session (it returns nothing now).
  - `signin()` without a client ID.
  - `export_secret` / `import_secret`.
  - `Capability::builder(scope)`.
- **Stale upstream sources:**
  - The auth sections of pubky-ai-kit still use the 0.9 API: AuthTokens, a sync `startAuthFlow(caps, kind, relay)`, `resumeAuthFlow`, a shared cookie, and `signer.signup` returning a session. **Don't copy its auth code.**
  - The "Relay & reliability" section of the Rust SDK README describes only the relay encryption for bare grants (see [Relays](#relays)).
  - React Native: [`../../pubky-mobile/references/react-native.md`](../../pubky-mobile/references/react-native.md).

## Pick the right path

| You are building | Use | Capabilities granted |
| :-- | :-- | :-- |
| A third-party app (web, server, CLI) | The grant auth flow, `start_grant_auth_flow` / `startGrantAuthFlow`. The user approves in an authenticator such as Pubky Ring | What you request, or less if the user narrows it |
| An authenticator, key manager or first-party tool that holds the `Keypair` | `PubkySigner`: `signup`, `signin(client_id)`, `approve_auth`, `approve_auth_with_capabilities` | `signin` always grants **root `/:rw`** and no keys |
| Anything new | **Not** cookie auth (`*_cookie*`: deprecated, insecure, removed in August 2027) | n/a |

- **Never hand-build `pubkyauth://` URLs or tokens.** Use `authorization_url()` (Rust) / `authorizationUrl` (JS) from the flow.
- **Never ask users to paste keys or mnemonics into a third-party app.** See [`concepts.md#authentication`](concepts.md#authentication).

## Grant auth model

1. The app starts a flow. The flow creates a fresh **PoP (proof-of-possession)** client keypair and a relay channel:
   - **Bare grant** (the default): a random 32-byte `secret`. The channel is `base64url(hash(secret))`.
   - **Signed approval** (`af=v1`): an ephemeral X25519 HPKE key `epk`, and no `secret`. See [Relays](#relays).
2. The app shows a `pubkyauth://signin_grant?...` URL as a QR code or a deep link.
3. The authenticator shows the capabilities and the client ID. If the user consents, it signs a **grant**: a `pubky-grant` JWS with `iss` (the user), `client_id`, `caps`, `cnf` (the client's PoP public key), `jti` (the grant ID), `iat` and `exp`. It encrypts the grant and posts it to the relay.
4. The app decrypts the grant and resolves the user's homeserver. It sends the grant and a `pubky-pop` proof to `POST /auth/grant/session` and gets back an opaque **bearer token**.
5. The SDK sends `Authorization: Bearer <token>`. Before the token expires, it mints a new one with a fresh PoP proof. No root key is needed.

**Grants vs cookies:** a grant is a credential for one client. Replaying it requires that client's private key, and each grant can be listed and revoked on its own.

**A grant ID must always carry the same claims (0.18.0+).** `POST /auth/grant/session` returns **403** ("Grant ID is already stored for another user or with different claims") when the grant ID is already stored for another user or with other claims. Capabilities are compared exactly. Never reuse a `jti` for a different grant.

**Client ID:** every grant session needs one. The homeserver stores it and shows it when the user lists sessions. Use a stable string that looks like a domain (`myapp.example`). Validation only checks that it is non-empty and at most 253 **bytes** (`s.len()`), although the upstream doc comment says "characters".

### Approval format: bare grant or signed approval

| Format | Rust | JS | URL | Carries keys |
| :-- | :-- | :-- | :-- | :-- |
| Bare grant (default) | `GrantApprovalFormat::BareGrant` | `"bareGrant"` | none | No |
| Signed approval | `GrantApprovalFormat::SignedApprovalV1` | `approvalFormat: "signedApprovalV1"` | `af=v1` | Yes, for approved `e` scopes (the bundle may be empty) |

- **Use the default unless you need `e`.** A bare-grant request that contains `e` is rejected ("encryption key permission requires af=v1").
- **There is no fallback.** An app that requests `af=v1` rejects a bare-grant response. Every `af=v1` request needs a signer that supports HPKE, even without `e`.
- **Pubky Ring:** `af=v1` support is on Ring `main` (fac51af, 2026-10-22) but **not** in the latest release, v2.0 (2026-10-05). v2.0 pins `@synonymdev/react-native-pubky` 0.14.1, while Ring `main` pins 0.15.0. Released Ring can't approve `af=v1` requests yet.
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

<sub>Source: [`examples/javascript/2-auth-flow/src/pubky-auth-widget.js`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/2-auth-flow/src/pubky-auth-widget.js), a runnable browser example. The run-ID guards and the QR rendering are removed here. `pubky` is `import * as pubky`, as upstream. Executed end to end against a local testnet with `@synonymdev/pubky` 0.18.0: a signer approved the flow, and the granted session wrote and read data. Upstream shows `_pubkyZ32` to people as "Public key". For display use `session.info.publicKey.toString()` (`pubky<z32>`), and keep `z32()` for hostnames and keys. In strict TypeScript, `session.grant` is `GrantSession | undefined` and needs narrowing.</sub>

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

<sub>Source: [`pubky-knowledge-base-v2/snippets/js/src/developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts), region `js_custom_auth_relay`, CI-verified against `@synonymdev/pubky` 0.14.0. Type-checked against the 0.18.0 `pubky.d.ts`. The flow was started, and the custom relay appears in `authorizationUrl`. Approval was not awaited, because the example relay host doesn't exist.</sub>

- **Signature:** `pubky.startGrantAuthFlow(capabilities: string, kind, { clientId, relay?, xCallback?, approvalFormat?, expectedSigner? })` is **async**, so always `await` it. `xCallback` is `{ xSource, xSuccess, xError, xCancel }`. `expectedSigner` needs 0.18.0+ (see [`spk`](#require-a-specific-identity-spk)).
- **`authorizationUrl` is a property**, not a method.
- **Waiting:** `flow.awaitApproval()` → `Session`. `flow.tryPollOnce()` → `Session | undefined`.
- **Poll from one place only.** Concurrent `awaitApproval()` / `tryPollOnce()` calls can throw `ClientStateError`, and so can any call after `awaitApproval()` has consumed the flow. Stop polling once you have a session.
- **Delegated vs local PoP key.** `startGrantAuthFlow` tries a **delegated** PoP key: a non-extractable WebCrypto Ed25519 key in IndexedDB. If delegation is unavailable or fails, it **silently falls back** to a local key. To choose explicitly:
  - `GrantAuthFlow.start(...)`: sync, uses a local key.
  - `await GrantAuthFlow.startDelegated(...)`: uses a delegated key. It rejects with `ClientStateError` on runtimes that don't support delegation.
  - `GrantAuthFlow.isDelegationAvailable` is a rough sync check. It doesn't check for Ed25519 support.

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

<sub>Source: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md), where it is doc-tested. The `use` lines are hidden upstream. `XCallbackParams` is **not** re-exported at the crate root. Clippy-clean (`-D warnings`) on `pubky` =0.18.0. `start()` was run and the x-callback parameters appear in the authorization URL. Approval was not awaited.</sub>

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

<sub>Source: [`examples/rust/2-auth_flow/client.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/client.rs), a runnable example, with elisions here. The full example also shows `--testnet`, a custom relay and the signup options. Clippy-clean on 0.18.0 and executed on a local testnet for a `signin_grant` flow. Every printed field is present.</sub>

- **Starting:** `Pubky::start_grant_auth_flow(&caps, kind, client_id) -> Result<PubkyGrantAuthFlow>` is **not async**.
  - For control over the relay, HTTP client, approval format, expected signer or x-callback, use `PubkyGrantAuthFlow::builder(&caps, kind, client_id)`. Its methods are `.relay(url)`, `.client(pubky.client().clone())`, `.approval_format(..)`, `.expected_signer(pk)` (0.18.0+) and `.x_callback(..)`. Then call `.start()`, which is sync.
  - See [docs.rs `PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html). The builder type `GrantAuthFlowBuilder` isn't re-exported, so docs.rs doesn't show its methods ([source](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/grant/builder.rs)).
- **Keep the flow alive.** Relay polling starts when the flow is created, and **dropping the flow cancels it**.
- **Waiting:** `await_approval()` → `PubkySession`. `try_poll_once()` → `Option<PubkySession>`. `await_credential()` / `try_poll_credential_once()` return a `GrantCredential` instead.
- `session_info().await` returns the info directly, not a `Result`. Timestamps are in Unix seconds.
- **x-callback URLs** bring the user back to your app. Put a unique nonce in them and check it when the user arrives. Mobile: [`../../pubky-mobile/references/ring-auth.md`](../../pubky-mobile/references/ring-auth.md).

### Require a specific identity (`spk`)

0.18.0+. A sign-in flow can name the key that must approve it. The link then gets `spk=<z32>`.

```js
const flow = await pubky.startGrantAuthFlow(caps, AuthFlowKind.signin(), {
  clientId: "my-cool-app.example",
  expectedSigner: session.info.publicKey.z32(),
});
```

<sub>Source: the 0.18.0 JS README, "Require the signed-in identity": [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#require-the-signed-in-identity). No upstream example uses it. Executed on a local testnet with 0.18.0 (testnet `relay` added): the URL carries `spk`, a different signer is refused ("this sign-in request is for a different key"), and the expected signer gets a session for that user.</sub>

- **It's a requirement, not a hint.** Send it only when the app already knows the user, for example when re-authorizing or asking for more capabilities. **Leave it out for a first sign-in.** To switch accounts, start a new flow without it.
- **JS:** `expectedSigner: string | null` accepts raw z32 or `pubky<z32>`. The SDK always writes canonical z32 into the link. Parsed links expose `SigninGrantDeepLink.expectedSigner: PublicKey | undefined`.
- **Rust:** `PubkyGrantAuthFlow::builder(..).expected_signer(public_key: PublicKey)` (`#[must_use]`). `SigninGrantParams` gains `pub expected_signer: Option<PublicKey>`, and `SigninGrantParams::new(..)` sets it to `None`.
- **Sign-in only.** On a sign-up flow, `.start()` fails with `Error::Authentication(AuthError::Validation("an expected signer applies to sign-in flows only"))`. JS sign-up flows reject `expectedSigner`.
- **The app enforces it.** An approval from any other key fails before the grant exchange, including after a flow restore, with `AuthError::Validation("approved grant was issued by a different key than the request expected")` (JS: `AuthenticationError`).
- **Authenticators older than `spk` ignore it.** They show their key picker, so the user can pick another key, which the app then rejects. **Released Pubky Ring (v2.0) ignores `spk`.** Only Ring `main` supports it (59f1163). Handle the mismatch error with a clear "sign in as X" message.
- **Privacy tradeoffs** (accepted upstream):
  - A pubky is public, so any app can name any pubky.
  - A multi-key authenticator opens the named key without asking.
  - An app that deep-links the authenticator can learn whether it holds a key. If it holds the key, it shows the approval screen and then sends `x-cancel` on deny or timeout. If it doesn't, it shows a local error and sends no callback.
  - Full rationale: [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md).

### Sign-up through the flow

For new users, pass `AuthFlowKind::signup(homeserver_pk, signup_token: Option<String>)` (Rust) / `AuthFlowKind.signup(homeserverPk, signupToken?)` (JS) instead of `signin()`. The flow produces a `signup_grant` link. The authenticator creates the account on that homeserver and then approves the grant.

### Resume after reload or restart

**You can't resume a grant flow from its URL alone.** Resuming needs the PoP private key. `resume_cookie_auth_flow` fails on a `signin_grant` / `signup_grant` URL.

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

<sub>Source: the JS README, "Resume an auth flow after page refresh": [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#resume-an-auth-flow-after-page-refresh). `AuthFlowKind` is added to the import here. Upstream leaves it out, so its version throws `ReferenceError` when pasted. This is browser-only: in Node without browser shims, `startDelegated` throws `ClientStateError`. Executed on a local testnet with 0.18.0 under shims for IndexedDB, a secure context and `sessionStorage`: the flow was saved, resumed and approved, and the saved state was cleared. For a local key use `GrantAuthFlow.start()`, `flow.saveLocal()` and `pubky.resumeGrantAuthFlow(saved)`.</sub>

- **JS: match the save call to the key kind.** `saveLocal()` on a delegated flow throws `ClientStateError`, and so does `saveDelegated()` on a local flow. Either start the flow explicitly (as above), or call `saveDelegated()` after `startGrantAuthFlow` and fall back to `saveLocal()` on `ClientStateError`. Remember which one you saved.
- **The saved state is secret.** It holds the relay secret or the HPKE private key, **and** the PoP private key. Store it briefly (for example in `sessionStorage`), and delete it when the flow completes or is abandoned. It becomes useless once the relay inbox drops the message (about 5 minutes).
- **A restored flow keeps its `spk` check:** an approval from another key is still rejected.
- **After an SDK upgrade,** you can't resume a pending signed-approval flow whose saved URL has a `secret` but no `epk`. Restart it.
- **Rust:** serde support for `GrantAuthFlowState` needs the `json` feature. `restore` checks that the saved key matches the `cpk` in the URL.

## Capabilities

**Format:** comma-separated `<scope>:<actions>` entries (`/pub/my-cool-app/:rw,/pub/foo.txt:r`). A scope starts with `/`. Root is `/:rw`. Actions:

| Action | Grants | Notes |
| :-- | :-- | :-- |
| `r` | GET | |
| `w` | PUT / POST / DELETE | |
| `e` | Scoped **encryption keys** for the scope (0.16.0+) | **No storage access.** Needs `af=v1`. `r` and `w` never deliver keys. See [Scoped encryption keys](#scoped-encryption-keys) |

- **The trailing slash matters (0.10+, `e` included).** `/pub/app/` covers that directory and everything below it, **not** `/pub/app` or `/pub/app-evil/foo`. `/pub/app` covers only that one file. End directory scopes with `/`.
- **Scopes must be canonical absolute paths.** Repeated `/`, `.` and `..` are **rejected**, not normalized. Percent sequences are taken literally.
- **The homeserver enforces capabilities on every request.** Request the narrowest scope that works. One exception to plan for: [`account()`](#account-usage-and-quota) needs read access on root `/`.
- **The signer may approve less than you asked for** (see [Selective approval](#selective-approval)). Read the granted capabilities from the session. Don't assume them.
- **Rust:**
  - `Capability::root()`.
  - `Capability::read|write|read_write|encryption_keys(scope)` and `"/pub/app/:rw".parse()` return `Result<Capability, CapabilityParseError>`.
  - `Capabilities::builder()` has the fallible `.read(s)?` / `.write(s)?` / `.read_write(s)?` / `.encryption_keys(s)?`, plus `.cap(c)`, `.extend(iter)` and `.finish()`.
  - `Capabilities::normalize()` merges duplicates and drops entries that another entry already covers.
  - See [docs.rs `Capabilities`](https://docs.rs/pubky/latest/pubky/struct.Capabilities.html).
- **JS:** check strings that users supply with `validateCapabilities` before you start a flow:

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

<sub>Source: [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). It is wrapped in `async function signInWithFormCaps` here, because upstream's version has a top-level `return` in an ES module, which is a `SyntaxError`. Executed on a local testnet with 0.18.0. Invalid input surfaced `InvalidInput`. Valid input (`:wr`) was normalized to `:rw` and approved. `validateCapabilities` returns the normalized string. On failure it throws `InvalidInput` naming the **first** bad entry, which is also in `error.data.invalidEntries`. In TypeScript the returned `string` needs a cast to `Capabilities`, and `error` (typed `unknown`) needs narrowing.</sub>

## Scoped encryption keys

Released in 0.16.0. The signer derives a symmetric key for each scope from the user's identity secret and delivers the keys in a signed approval. **The SDK does not encrypt anything.** Your app chooses the format and must use a fresh nonce for every encryption. This is cryptography your app does over public storage, not encrypted storage: see [`shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto`](shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto). Full design: [`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).

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

<sub>Source: the Rust README, where it is doc-tested `no_run`: [`pubky-sdk/README.md#request-encryption-keys`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#request-encryption-keys). Hidden imports: `use pubky::{AuthFlowKind, Capabilities, ClientId, PubkyGrantAuthFlow, StoragePath}; use pubky::deep_links::GrantApprovalFormat;`. Clippy-clean on 0.18.0, and executed on a local testnet with the testnet `.client()` / `.relay()` added. It derived a 32-byte key for `/pub/chat/message`. It doesn't compile on 0.12. The derived key is wiped on drop.</sub>

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

<sub>Source: the JS README, [`pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys). The `if (!keys)` guard is added here, because upstream leaves it out. Executed on a local testnet with 0.18.0. The AES-GCM round trip works after `keys.free()`, and a bare grant returns `encryptionKeys === undefined`. Reading `keys` after `free()` throws.</sub>

- **API:**
  - Rust: `grant.encryption_keys() -> Option<&ScopedEncryptionKeyBundle>` (on `session.as_grant()`), `keys.scopes()` and `keys.derive_for_path(&StoragePath)`.
  - JS: `session.grant.encryptionKeys` (each read returns a copy, so call `free()`), `keys.scopes: string[]`, `keys.deriveForPath(path): Uint8Array` and `await keys.deriveCryptoKeyForPath(path)`, which returns a non-extractable AES-GCM-256 `CryptoKey`.
- **Prefer `deriveCryptoKeyForPath()`.** `deriveForPath()` returns a copy of the raw key as a `Uint8Array` that the caller owns. Zero it (`bytes.fill(0)`) when you're done.
- **Derivation fails** for a directory, or for a path outside the approved scopes. Rust has the error variants `DirectoryPath` / `OutsideScope`. JS throws `InvalidInput` with a message and no named variants.
- **If the user declines `e` on an `af=v1` request,** the signer still returns a signed approval, with an empty key bundle. Check `scopes`.
- **The keys are permanent.** They come from the identity secret, and they are **not** revoked when the grant expires or is revoked. There is no key rotation and no forward secrecy.
- **Scope them narrowly.** A key for a directory covers everything below it, and `e` on `/` gives away every key the user will ever have. Renaming a file changes its key.
- **They don't hide much.** The keys are symmetric and don't prove who wrote the data. Filenames and metadata stay public, and everything under `/pub` stays readable by anyone.
- **Rollout order:** upgrade homeservers first, then signers, then apps. Older homeservers reject any grant that contains `e`, and the app can't remove `e`, because the grant is signed. Requests with only `r`/`w` stay compatible.
- **To add keys to an existing session:**
  1. Request a **new** signed approval with `e`, even with the same client ID. Add `expectedSigner` so the same user approves it.
  2. Save the new session and use its new record ID.
  3. Sign out the old session. Deleting the old record doesn't revoke it.
- **Offline recovery** needs no session or network, and works after the grant expires:
  - Rust: `GrantCredential::restore_encryption_keys(token: &str) -> pubky::Result<Option<(GrantClaims, ScopedEncryptionKeyBundle)>>`, or `GrantCredential::restore_encryption_keys_from_approval(grant_jws: &str, signed_approval: Option<&str>)`, which has the same return type. These were renamed from `restore_encryption_keys_with_claims` and `restore_delegated_encryption_keys(state, approval)`.
  - JS: `EncryptionKeys.fromLocalSecret(token)` → `{ publicKey, grantId, keys }`, or `undefined` for bare-grant tokens. **Check that the user and the grant ID** are the ones you expect: `publicKey` is a z32 string, so compare it to `expectedUser.z32()`. Then call `free()` on the keys.
  - Browser: `await pubky.browserSessionStore.restoreEncryptionKeys(storedId)` → `EncryptionKeys | undefined`. It checks the issuer and the grant itself.

## `pubkyauth://` deep links

The URL **host** is the intent. `pubkyring://` is a deprecated alias that still parses.

| Intent | Auth type | Parameters |
| :-- | :-- | :-- |
| `signin_grant` | grant | `caps`, `relay`, `cid` (client ID), `cpk` (client PoP public key, z32), and **either** `secret` (bare grant) **or** `epk` (HPKE). Optional: `af=v1`, and `spk` (expected signer, 0.18.0+) |
| `signup_grant` | grant | The `signin_grant` parameters (except `spk`, which it ignores), plus `hs` (homeserver z32) and an optional `st` (signup token) |
| `signin` | legacy cookie | `caps`, `relay`, `secret` |
| `signup` | legacy cookie | `caps`, `relay`, `secret`, `hs`, optional `st` |
| `direct_signup` | account creation only | `hs`, optional `st` |
| `secret_export` | key export (not auth) | `secret`: the user's 32-byte **identity (root) secret**, in base64url. **Highly sensitive:** never log it, and never generate it or show it as a QR code in a third-party app |

- In auth links, `secret` is 32 bytes, base64url, unpadded. `epk` is a 32-byte X25519 public key, base64url, unpadded. The SDK adds `epk` automatically for `af=v1`.
- **`spk`:** may appear at most once and must be exactly the key's canonical 52-character z32. Prefixed forms (`pubky…`, `pk:`), URL-shaped values and noncanonical encodings are rejected. Intents other than `signin_grant` ignore it, and such links still parse.
- **The parser rejects:**
  - `epk` and `secret` together ("secret must be omitted when epk is present").
  - `af=v1` without `epk` ("af=v1 requires one epk parameter").
  - A bare grant with neither (`MissingQueryParameter("secret")`).

  A link with `epk` uses HPKE whatever its approval format says.
- **x-callback parameters** (optional): `x-source` (an app name for people to read), `x-success`, `x-error` and `x-cancel` (for cancellation or timeout). Values are percent-encoded once and decoded exactly once. The legacy `callback` parameter is a fallback for `x-success`. Write `x-success` in new requests.
- **An empty host** (`pubkyauth:///?...`, as in AUTH.md) parses as a legacy `signin` link.
- **Rust `DeepLink`** (`pubky::deep_links::DeepLink`) has **6 variants**: `Signin`, `Signup`, `DirectSignup`, `SigninGrant`, `SignupGrant` and `SeedExport`. A 0.9 `match` without a catch-all arm won't compile. Read parameters with `.params()`.
- **Rust 0.16 breaking changes:**
  - `SigninGrantParams` / `SignupGrantParams` are `#[non_exhaustive]`.
  - The `secret` field became `relay_channel: GrantRelayChannel`, which is either `SharedSecret([u8; 32])` or `Hpke { ephemeral_public_key }`.
  - There is a new `approval_format` field, and 0.18.0 adds `expected_signer` on `SigninGrantParams`.
  - Build a bare grant with `SigninGrantParams::new(capabilities, relay, secret, client_id, client_pk)`.
  - Code that reads `params().secret` no longer compiles.

For recognizing a link only (a bare-grant link). **Always use the URL the flow gives you:**

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

<sub>Source: [`examples/rust/2-auth_flow/authenticator.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/authenticator.rs), a runnable example, condensed here with the testnet branch removed. Import `DeepLink` from `pubky::deep_links::DeepLink`. Clippy-clean on 0.18.0, and executed on a local testnet against real `signup_grant` and `signin_grant` URLs. Each client flow got a session that could write. The example approves everything requested. It uses neither selective approval nor `spk`.</sub>

- **`approve_auth`:** Rust `PubkySigner::approve_auth(&self, url) -> Result<()>`, JS `signer.approveAuthRequest(url)`.
  - It approves **all** requested capabilities.
  - It handles `signin`, `signup`, `signin_grant` and `signup_grant`, and rejects `direct_signup` and `secret_export`.
  - Approved grants last **2 years**.
- **`approve_auth` does not create the account.** For `signup` / `signup_grant`, call `signer.signup(homeserver, token)` first, as above.
- **`handle_deeplink(url)`** (Rust) / `handleDeepLink(url)` (JS) also handles `direct_signup`, by calling `signup(hs, st)`.
- **`spk` (0.18.0+):** `approve_auth`, `approve_auth_with_capabilities` and `handle_deeplink` refuse a `signin_grant` link whose `spk` names another key. They fail with `AuthError::Validation("this sign-in request is for a different key")` before anything is signed or sent. In a multi-key authenticator:
  - Open the named key, and offer no other.
  - **Show prominently that the app chose the identity:** the app, the account name and a short form of the key.
  - Ring `main` enforces `spk` but doesn't follow this: commit f2f8c2d (2026-11-11) removed its "the app chose this pubky" notice.
- **Show consent first:** before approving, display the requested capabilities (call out `e`) and the `client_id`.
- **Recovery files:**
  - `pubky` re-exports `pubky::recovery_file::{create_recovery_file, decrypt_recovery_file}`.
  - On non-WASM targets, `Pubky::signer_from_recovery_file(path, passphrase)` loads a signer directly.
  - JS APIs, the file format and the passphrase caveat: [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair).
  - Upstream examples try an **empty passphrase first**, because the sample key has none. Don't ship that fallback.
- **Pubky Ring:** [`../../pubky-mobile/references/ring-auth.md`](../../pubky-mobile/references/ring-auth.md).

### Selective approval

0.16.1+. Lets the user approve a smaller set of capabilities:

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

<sub>Sources (not doc-tested upstream): the [Rust README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) and the [JS README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). Both were executed on a local testnet with 0.18.0 against an `af=v1` request for `:rwe`. The session came back with only `/pub/example.app/:r`, and in JS the key bundle had no scopes.</sub>

- Works for grant links and for the legacy `signin` / `signup` links.
- Each approved scope and action must be covered by the request. Different requested capabilities can cover different actions. You may narrow scopes or drop actions, including `e`.
- To approve nothing, pass `Capabilities::default()` (Rust) / `""` (JS).
- A malformed approval, or one broader than the request, fails **before** it is sent to the relay. The client identity, relay channel and approval format are kept.

## Relays

- **Default:** `https://httprelay.pubky.app/inbox` (`DEFAULT_HTTP_RELAY_INBOX`, hosted by Synonym). `DEFAULT_HTTP_RELAY` (the `/link` URL) is deprecated.
- **Channel selection:** a relay path ending in `/link` or `/link/` uses the legacy synchronous link channel. Any other path uses the store-and-forward inbox. A trailing slash on the base URL is optional.
- **Inbox:** holds a message for about 5 minutes. The app long-polls with GET and acknowledges with DELETE. The producer can check `/ack` and `/await`. Anyone who knows an inbox ID can read, write or acknowledge it. What protects the flow is the channel ID and the payload encryption.
- **End-to-end encrypted.** The relay sees only ciphertext and can't use the credential.
  - **Bare grant and legacy links:** the channel is `base64url(hash(secret))`. The payload is encrypted with `secret`, which travels only inside the `pubkyauth://` URL.
  - **`af=v1`:** the signer encrypts the approval with HPKE to the app's ephemeral key `epk`. The channel is a hash of `epk`, so a relay that sees only the channel can't forge a response. Suite and derivation: [`docs/scoped-encryption-keys.md#approval-delivery`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md#approval-delivery).
- **Size limits** (signed approvals that carry keys can exceed them):
  - SDK clients accept relay responses up to **1 MiB**. Larger ones fail with an auth validation error, with no retry or downgrade.
  - `http-relay` 0.7 and `pubky-testnet` cap each request body at **2 KiB** by default.
  - An approval that is too large gets **HTTP 413 at the signer** (Rust `RequestError::Server`, JS `RequestError` with `statusCode` 413). **The app is never told**, and its flow waits until it expires.
  - On relays you run, raise the limit with `http-relay --max-body-size 16384` or `HttpRelay::builder().max_body_size(16 * 1024)`. Apps can't change the limit of a remote relay.
- **Retention:** `http-relay` keeps each body as received for `--inbox-cache-ttl` (default 300 s). It stores them in memory by default, or on disk (SQLite) with `--persist-db <PATH>`. Messages that aren't acknowledged expire after 5 minutes.
- **Run your own relay for production.** If the default relay is down, logins can't complete. Pass yours with `.relay(url)` / `{ relay }`.
  - Project: [pubky/http-relay](https://github.com/pubky/http-relay). The Rust README links to httprelay.io, which is not the Pubky project.
  - Operating guide: [`../../pubky-infra/references/http-relay.md`](../../pubky-infra/references/http-relay.md).
- **Testnet relay:** `http://localhost:15412/inbox`. See [`testing-and-testnet.md`](testing-and-testnet.md).

## Signup tokens

A homeserver in `TokenRequired` mode needs a token to create an account.

- **Passing a token:**
  - Rust: `signer.signup(&hs, Some("AAAA-BBBB-CCCC"))` (`Option<&str>`).
  - JS: `await signer.signup(hs, token)` (`string | null`).
  - Grant flow: `AuthFlowKind::signup(hs, Some(token))` adds `st` to the URL.
  - Direct link: `pubkyauth://direct_signup?hs=<z32>&st=<token>`.
  - Open and testnet homeservers accept `None` / `null`.
- **Format:** tokens are generated as upper-case, hyphenated Crockford base32 (`AAAA-BBBB-CCCC`). The validator only checks for 14 characters that decode as Crockford base32 once the hyphens are removed. A malformed token on signup gets 400 ("Invalid signup token format"). Pass tokens through unchanged.
- **Rules:** a token is **single use**. It is consumed in the same transaction that creates the account. Tokens don't expire. A token may carry a storage quota for the new user.
- **Errors** (the same for grant `/auth/grant/signup` and legacy `/signup`):

  | Case | HTTP | Message |
  | :-- | :-- | :-- |
  | Token missing | 400 | "Token required" |
  | Token unknown | 401 | "Invalid token" |
  | Token already used | 401 | "Token already used" |
  | Key already has an account | 409 | "User already exists" |

  - **JS:** these arrive as `RequestError` with `error.data.statusCode`, **not** as `AuthenticationError`, despite what the `signup` JSDoc says. Branch on `statusCode`.
  - **A 409 means: sign in instead.** The user already signed up on that homeserver.
  - Unreleased on `main` (#777): a token consumed by a concurrent signup reports "Token already used", and a concurrent signup for the same key reports 409.
- **Checking a token first:** `GET /signup_tokens/{token}` → `{ status: "valid" | "used", created_at }`, where `created_at` is an RFC 3339 string.
  - It returns 400 if tokens aren't required or the format is bad, and 404 if the token is unknown.
  - Use `GET`: since 0.17.1, `HEAD` returns 405.
  - The default config rate-limits it to **10 requests/minute per IP**, so don't poll it.
- **Issuing tokens:** [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md).

## First-party signer sign-in

Use this only when your code legitimately holds the user's `Keypair` (an authenticator or a first-party tool).

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

<sub>Source: the Rust README quick start, doc-tested `no_run`: [`pubky-sdk/README.md#quick-start`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#quick-start). `"o4dksf...uyy"` is a placeholder and panics at `unwrap()`, so pass a real homeserver key. Clippy-clean on 0.18.0. Executed on a local testnet with the testnet homeserver key substituted: signup without a token, signin, put, then get. The KB no longer has CI-verified Rust snippets.</sub>

```js
const homeserver = PublicKey.from(
  "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

await signer.signup(homeserver, null);

const session = await signer.signin("myapp.example");
```

<sub>Source: [`pubky-knowledge-base-v2/snippets/js/src/developer-guide.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts), regions `js_developer_guide_signup` and `js_developer_guide_signin`, CI-verified against `@synonymdev/pubky` 0.14.0. Executed on a local testnet with 0.18.0. `PublicKey.from` accepts the `pubky`-prefixed form, and the session records the client ID. The upstream identity region (`js_developer_guide_identity`) logs `signer.publicKey.z32()` as "Your pubky". For display, use `toString()`.</sub>

Auth-specific behavior (the rest of signup and signin is in `concepts.md`):
- **`signup(&hs, token) -> Result<()>`** uses the reserved client ID `pubky.signup` with a 5-minute grant, and publishes the `_pubky` record. It returns no session.
- **`signin(client_id)`** signs a **root `/:rw`** grant that is valid for 2 years. It uses a fresh PoP key and includes **no encryption keys**.
  - It resolves the homeserver first, so it **fails if the user has no `_pubky` record** (they never signed up, or the record wasn't published).
  - It republishes a stale PKDNS record in the background.
- **`signin_blocking(client_id)`** waits for that republish (about 3–5 s). Use it at first-time setup, when the identity must be discoverable immediately.

## Session lifecycle

Grant session info has these fields: `homeserver`, `pubky`, `client_id`, `capabilities`, `grant_id`, `token_expires_at`, `grant_expires_at` and `created_at`. All timestamps are in **Unix seconds**. Upstream: [`docs/grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md).

### Inspect, refresh, revalidate, sign out

- **`PubkySession` (Rust)** is cheap to clone and thread-safe.
  - `info()` → `public_key()`, `capabilities()`. Also `storage()`.
  - `as_grant()` → `Option<GrantSessionView>`, which has `session_info()`, `grant_id()`, `current_bearer()`, `export_local_secret()`, `encryption_keys()`, `signed_approval()`, `create_custom_pop()` and `account()` (0.18.0+).
  - `as_cookie()` is deprecated.
- **JS:** `session.info.publicKey`, `await session.grant.sessionInfo()`.
- **Lifetimes:** a bearer lasts until whichever comes first: **1 hour** from now, or the grant's `exp`. A grant lasts 2 years (from `signin` or `approve_auth`) unless revoked. The SDK mints a new bearer when the current one is within **300 s** of expiry, one refresh at a time.
- **One bearer per grant.** Each exchange at `POST /auth/grant/session` replaces the grant's current bearer. Copying a grant to another app or origin doesn't give you two independent sessions: they invalidate each other. Independent apps need separate grants.
- **`signout(self) -> Result<(), (Error, Self)>`** gives the session back on failure. With `?`, use `.map_err(|(e, _)| e)`.
  - For a grant session it sends `DELETE /auth/grant/session`, which **revokes that session's grant**. Calling it again is a no-op (200). Other apps' grants are unaffected.
  - A homeserver that lists the `grant-proof-logout` feature in `/info` accepts the grant plus a PoP proof at that route, so logout works even after the bearer or the grant has expired. Otherwise the SDK needs a valid bearer to revoke the grant on the server.
  - **A revoked grant can't be restored** (401).
- **Forcing re-authentication:** sign out, then start a new flow (a signer can just call `signin` again). To keep the same user, pass [`expectedSigner`](#require-a-specific-identity-spk).

### 401 recovery and revalidate

0.18.0+ (breaking). Applies to native requests that the session manages and to WASM Blob uploads with **local** grants. For browser tabs, see [Multiple browser tabs](#multiple-browser-tabs-0150).

- **On an unexpected 401,** the SDK refreshes the bearer, coordinating across clones of the credential. It then **retries the original request once**, if the request body can be replayed.
- **Not replayed:** bodies that can't be cloned, transport failures, other HTTP errors, and a second 401.
- **If the refresh is rejected,** the SDK returns `Error::CredentialRefresh` (JS `CredentialRefreshError`), with the HTTP status when there is one. A revoked grant can't get access back this way.
- **Reconcile writes yourself.** After an error on a write, you can't know whether it was applied. Read the data back before you retry your own work.
- **`revalidate() -> Result<Option<SessionInfo>>`** uses the same limited recovery and may refresh the bearer while it checks.
  - It returns `Ok(None)` **only** for a confirmed 401/404 from the refresh exchange or from the final session response. That means the session is gone: re-authenticate.
  - Transport, permission and service failures stay `Err`. **Don't treat an error as "signed out".**
  - A refresh that fails for any reason other than revocation returns `Err(Error::CredentialRefresh)`.

### Account usage and quota

0.18.0+, grant sessions only. `GET /account` returns the storage used, whether the account is disabled, and the quota.

```js
// With a grant session that has read permission on `/` (`/:r`, `/:rw`, ...):
// storage used and the quota that applies.
const account = await session.grant.account();
console.log(account.usedBytes, account.quota.effective.storageQuotaMb);
```

<sub>Source: the 0.18.0 JS README, [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). No upstream example uses it. Executed on a local testnet with 0.18.0, using a root `/:rw` session from `signinBlocking`. `usedBytes` is a number and `quota.effective` is present.</sub>

- **Rust:** `session.as_grant()` → `.account().await -> Result<AccountInfo>`.
- **JS:** `AccountInfo { pubky, usedBytes, disabled, createdAt, quota: { effective, overrides } }`. It is a wasm class, not a plain object, so call `free()` on it or use `using`. `createdAt` is ISO 8601 **without a UTC offset**.
- **It needs read access on root `/`** (`/:r`, `/:rw`, …). Sessions scoped to a path get **403**, and cookie sessions are rejected. Request root read only if you really need this.
- **Disabled users can still read it.** Use it to explain why their writes fail.
- The default homeserver config rate-limits it to **60 requests/minute per IP**. Responses are `no-store`.

### Persist and restore

- **Rust and Node:** `export_local_secret()` / `exportLocalSecret()` returns a grant credential string:
  - `pubky-grant-credential-v1…` for bare grants;
  - `pubky-grant-credential-v2…` for signed approvals, even with an empty key bundle.
- **The string is an unencrypted secret.** It holds the grant, its private PoP key and, for signed approvals, the encryption keys. Anyone who has it can act within the granted capabilities until the grant expires or is revoked, and can keep using the encryption keys after that. Store it securely and never log it.
- **Restore** with `pubky.restore_session(&secret)` / `pubky.restoreSession(secret)`, which mints a fresh bearer. Don't persist the 1-hour bearer itself. `restore_session` also accepts legacy cookie secrets.
- **Restoring replaces the old session.** Afterwards, `revalidate()` on the old in-memory session returns `None`. Stop using it.

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

<sub>Source: the Rust README, "Keypair and session persistence", doc-tested `no_run`, with its hidden `async fn` wrapper removed: [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#keypair-and-session-persistence). Clippy-clean on 0.18.0. Executed on a local testnet: the restored session belongs to the same user, and its writes can be read through the original session. The `.expect()` calls are README style. In library code, turn the `Option`s into errors instead of panicking. The deprecated `write_secret_file` is cookie-only and **panics** on grant sessions.</sub>

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

<sub>Source: the migration guide, [`docs/v0.10-migration/grant-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md), split in two here because the original declares `restored` twice. Both halves were executed on a local testnet with 0.18.0, the browser half under an IndexedDB shim. In each case the restored session is the same user and can write.</sub>

- **`browserSessionStore`** is backed by IndexedDB, per origin, supports several accounts, and works only in browsers.
  - Methods: `isAvailable()`, `save(session)`, `list()`, `restore(id)`, `remove(id)`, `clear()`, `clearAll()` (which also deletes the delegated keys of pending flows) and `restoreEncryptionKeys(id)`.
  - Fields and record layout: [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md).
- **`isAvailable()` is async** (`Promise<boolean>`). Write `if (await store.isAvailable())`. A bare `if (store.isAvailable())` is always truthy.
- **The units in `save()`'s result differ:** `grantExpiresAt` is in Unix **seconds**, but `createdAt` is in Unix **milliseconds**. `storageMode` is `'delegated'` or `'localSecret'`.
- **Stored as plaintext.** The store keeps everything needed to restore a session, encryption keys included, as plaintext in IndexedDB. Any script on the same origin, or anyone with a copy of the browser profile, can read it. Only delegated signing keys are non-extractable. `exportLocalSecret()` on a delegated session throws `ClientStateError`, so use the store instead.
- **Signed-approval records** (`pubky-session-v2`) can't be shared safely with older SDKs. **Upgrade every app and tab on an origin together.**
- **Removing isn't revoking.** `remove()`, `clear()` and `clearAll()` delete only local state. Revoke with `session.signout()` or `GrantManager.revoke(grantId)`.

### Multiple browser tabs (0.15.0+)

- **Call `browserSessionStore.save(session)` right after authentication, before making any requests.** When restoring, call `restore(id)`. Tabs on the same origin then share one bearer per stored grant through opening, closing, duplicating and reloading tabs.
- Each request holds a shared Web Lock until its response headers arrive. A refresh takes an exclusive lock, so a slow request can delay a refresh. A request that can be replayed and is rejected with 401 gets at most one recovery attempt. Transport failures and other HTTP errors don't replay writes.
- This needs IndexedDB, Web Locks and a secure context, which `await isAvailable()` checks. Coordination covers one origin in one browser profile only. Bearers copied by hand and older SDKs aren't coordinated.
- **Signing out revokes the grant for every tab.**
  - A failed signout stays pending and **blocks requests**. Retry the signout, or restore the saved record so the revocation can finish.
  - A successful signout removes the record and its delegated key.
- Listen for `pubky-session-changed` on `window`. It is forwarded to other tabs through `BroadcastChannel`. `event.detail` is `{ id, action }`, where `action` is `removed` or `cleared` (with `id` null).

### List and revoke grants

This needs a session with **root capabilities**. Other sessions get 403.

- **Rust:**
  - `GrantManager::new(&session)` returns `Self`, not a `Result`.
  - `.list().await` → `Vec<GrantInfo>`. The `capabilities` field is a single string joined with commas.
  - `.revoke(&GrantId::parse(s)?).await` revokes a grant and all its sessions.
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

<sub>Source: [`examples/rust/6-session_management/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/6-session_management/main.rs), a runnable example. Clippy-clean on 0.18.0 (`Result` = `anyhow::Result`). Executed on a local testnet: after the revoke, a write through the revoked session failed with "Credential refresh failed". JS version: [`examples/javascript/8-session-management.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs).</sub>

### Unreleased: parent and child grants

**Not in 0.18.0** (merged to `main` on 2026-11-11 in #792). Don't build on this yet. Design: [`docs/delegated-grants.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md).

- This is for integrators of Pubky Accounts, Ring and the SDK.
  - A parent grant has `typ: pubky-parent-grant`, capabilities limited to `/pub/:rwe` and `/priv/:rwe`, and a lifetime of at most 730 days. `/priv` is alpha and not for production: see [`shipped-vs-planned.md`](shipped-vs-planned.md).
  - The parent's `cnf` key can sign child grants (`typ: pubky-child-grant`, with `parent_jti`) for first-party apps, so each one doesn't need its own Ring approval.
  - Exchange: `POST /auth/grant/session` with `{ parent, grant, pop }`. There is also a new `POST /auth/grant/reconnect`.
  - Homeservers that support it list `grant-delegation` in `/info`.
- Both client IDs must be exact, canonical HTTPS callback URLs.
- There can be one active child per (user, parent, app callback).
- Revoking a parent revokes all its children. Revoking a child blocks that app under its parent until Accounts reconnects it.
- In the SDK on `main`:
  - `GrantManager.list()` entries gain `kind` (`direct` | `parent` | `child`) and `parent_id` / `parentId`.
  - `GrantKind` is re-exported at the crate root.
  - Older SDKs ignore these fields. Newer SDKs treat a missing `kind` as `direct`.
  - **The SDK has no API to create parent or child grants.**
- Separately, #725 (also unreleased) caps the Rust grant list client-side at 1 MiB, and bounds grant session and `revalidate` reads too.

## Custom grant proofs

0.16.0+. A grant session can sign any JSON with its client PoP key. Another service can then check **offline**, with no network call and no fresh bearer, that this user's grant signed the data. Upstream: [`docs/CUSTOM_POP.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md).

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

<sub>Source: [`docs/CUSTOM_POP.md#javascript`](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md#javascript). Executed on a local testnet with 0.18.0. `data` comes back intact, and the override verifies. `identity` is a bare z32 string with no `pubky` prefix. A tampered proof throws. In strict TypeScript, `session.grant` needs narrowing.</sub>

- **Rust:**
  - Create a proof with `session.as_grant()` → `.create_custom_pop(serde_json::json!({ ... })).await?`.
  - Verify it with `pubky::custom_pop::verify_custom_grant_pop(&credentials, DEFAULT_CUSTOM_POP_CLOCK_SKEW)` (30 s; Rust needs an explicit allowance). Then read `.identity()`, `.grant_claims()`, `.data()`, `.iat()` and `.nonce()`.
  - Upstream's fragment uses `session.as_grant()?`, which only compiles inside a function that returns `Option`. In a function that returns `Result`, use `.ok_or(..)?`.
- **The verifier checks only the signatures, the grant ID and the time bounds.** It doesn't contact the homeserver, check revocation, enforce a maximum proof age or keep replay state.
- **Your service must:**
  - Check the audience, the challenge and the freshness.
  - Consume challenges, or record nonces.
  - End any service session no later than the grant's `exp`.

  The grant's storage capabilities give no permissions on your service.
- **JS numbers beyond ±2^53 lose precision.** Encode them as strings in `data`.

## Errors

- **JS:** errors are `PubkyError`, with `name` one of `RequestError`, `CredentialRefreshError`, `InvalidInput`, `AuthenticationError`, `PkarrError`, `ClientStateError` or `InternalError`. This is the 0.18.0 `PubkyErrorName` union in `pubky.d.ts`. The README's `PubkyError` interface leaves out `ClientStateError`, but it exists. HTTP rejections from the homeserver surface as `RequestError`.
  - `ClientStateError` covers:
    - polling a flow concurrently or after it completed;
    - a save or export that doesn't match the key kind (delegated or local);
    - `startDelegated` on a runtime that doesn't support it;
    - a grant-only call on a session that isn't a grant session.
  - `AuthenticationError` includes an `spk` mismatch ("approved grant was issued by a different key than the request expected").
- **`CredentialRefreshError`** (0.17.1+): the refresh of the grant's bearer was rejected.
  - JS: `data: { statusCode }` when the refresh endpoint responded. There is no `data` on transport failures.
  - Rust: `Error::CredentialRefresh(pubky::CredentialRefreshError)`, re-exported at the crate root and `#[non_exhaustive]`. Its variant is `Request { status: Option<reqwest::StatusCode> }`, where `None` means a transport failure. Display and Debug redact URLs, bodies, grants, proofs and bearers.
  - Local auth, resolution, parsing and build failures keep their normal error names.
- **`RequestError` reasons:**

```js
import type { PubkyError, RequestErrorData } from "@synonymdev/pubky";

if (error.name === "RequestError") {
  const { reason, statusCode } = error.data as RequestErrorData;
}
```

<sub>Source: a TypeScript fragment from the JS README, "Errors": [`pubky-sdk/bindings/js/pkg/README.md#errors`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#errors). `error` comes from your `catch`. Type-checked against the 0.18.0 `pubky.d.ts`. At runtime on a testnet, a 404 gave `{ reason: "Http", statusCode: 404 }`.</sub>

  - `reason` (0.17.1+) is `Http` | `Timeout` | `Connection` | `TlsVerification` (0.18.0+) | `Body` | `Decode` | `InvalidRequest` | `Other`. `statusCode` is set for `Http`. Browser Fetch may report only `Other`.
  - **`TlsVerification` doesn't prove interception.** A stale pkarr cache after a legitimate key rotation looks the same.
  - **A reason doesn't tell you whether it is safe to retry a write.**
  - Rust: `errors::RequestError::kind() -> RequestErrorKind` (`#[non_exhaustive]`, for example `Http { status: u16 }`). Keep a catch-all arm.
- **Homeserver resolution:**
  - JS: `getHomeserverOf()` rejects with `PkarrError` on failure. Sign-in and the grant exchange can also surface it.
  - Rust: `get_homeserver_of` returns `Result<Option<PublicKey>>`. `pubky::Error` has **no** `is_retryable()`. Match the PKARR variant instead: `Err(Error::Pkarr(e)) if e.is_retryable()`.

## Deprecated: cookie auth

Cookie auth is still in 0.18, under explicit `*Cookie` / `_cookie` names, and has been deprecated since 0.10.0. **From 0.18.0 it gets only limited security maintenance, and it will be removed in August 2027. Migrate to grants now.**

It's insecure:
- The cookie belongs to the homeserver's domain, so site B can reuse site A's cookie and permissions ([issue #520](https://github.com/pubky/pubky-homeserver/issues/520)).
- The session cookie lives a long time (up to 1 year) and has no replay prevention.
- Sessions can't be listed or revoked.

Grant-only APIs such as `account()` reject cookie sessions.

| 0.9 name | 0.10+ name (deprecated) |
| :-- | :-- |
| `startAuthFlow` / `resumeAuthFlow` | `startCookieAuthFlow` / `resumeCookieAuthFlow` |
| `start_auth_flow` / `PubkyAuthFlow` | `start_cookie_auth_flow` / `PubkyCookieAuthFlow` |
| `signup` / `signin` (cookie) | `signup_cookie` / `signin_cookie` / `signin_cookie_blocking` |
| `session.export_secret()` | `session.as_cookie().and_then(\|c\| c.export_secret())` |

Also deprecated: Rust `import_secret`, `write_secret_file`, `session_from_file` and `CookieSessionRecord`; JS `session.cookie`, `session.export()` and `Session.restore`. Full mapping: [`docs/v0.10-migration/cookie-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md).

**Legacy `AuthToken`** is the signed payload for cookie flows and for legacy `signin` / `signup` links. It is an Ed25519-signed v0 token with a timestamp.
- The homeserver accepts the timestamp within ±3 minutes, and rejects a repeated `(timestamp, pubky)` pair.
- v0 has no delegation.
- Since 0.17.1, the token's length is checked before its version byte is read.
- Byte layout: [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md). Apart from its `spk` section (about grant sign-in links), AUTH.md describes **only** this legacy payload and its shared-secret relay handshake. It doesn't cover grants or HPKE.

## Wire reference (debugging only; use the SDK)

- **Routes:**
  - Under `/auth/grant/*`: grant signup (`POST /auth/grant/signup`), the exchange (`POST /auth/grant/session`), reading and revoking the current session (`GET` / `DELETE /auth/grant/session`), and the root-only list and revoke-by-ID routes.
  - Account info: `GET /account` (0.18.0+).
  - The deprecated cookie routes are `/signup` and `/session`.
  - Source of truth: [`auth/router.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/router.rs).
- **Session exchange 403 (0.18.0+):** the grant ID is already stored for another user or with different claims.
- **JWS:**
  - `alg: EdDSA`. `typ` is `pubky-grant`, `pubky-pop`, `pubky-grant-approval` (signed approvals) or `pubky-custom-pop-v1` (custom proofs).
  - PoP proofs bind `aud` to the homeserver key, so a proof can't be replayed against another homeserver.
  - `iat` must be within **±180 s** of server time, so client clock skew in either direction breaks the exchange.
  - Source: [`pop_verifier.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/grant/crypto/pop_verifier.rs).
- **Homeserver features** (`/info`, 0.18.0): `path-addressed-storage`, `grant-proof-logout` and `webdav-locks`, plus `websites` when website serving is enabled. Unreleased `main` adds `grant-delegation`. Check the list before you rely on a feature.

## Upstream

- **Guides:** [scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md) · [grant-session-lifecycle.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md) · [CUSTOM_POP.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md) · [delegated-grants.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md) (unreleased) · [0.10 migration](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md) ([grant-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md), [cookie-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md))
- **Releases:** [v0.15.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.15.0) · [v0.16.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0) · [v0.16.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.1) · [v0.17.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1) · [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0)
- **API:** [docs.rs/pubky](https://docs.rs/pubky/latest/pubky/) · [`PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html) · [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) · [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md)
- **Protocol:** [AUTH.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) (the legacy payload, plus `spk`)
- **Examples:** [rust/2-auth_flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/2-auth_flow) · [rust/6-session_management](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/6-session_management) · [javascript/2-auth-flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/2-auth-flow) · [javascript/5-browser-session-persistence](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/5-browser-session-persistence) · [javascript/8-session-management.mjs](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs). None of them use `spk`/`expectedSigner`, approval formats, HPKE or selective approval.
- **Relay:** [pubky/http-relay](https://github.com/pubky/http-relay)
- **Pubky Ring releases:** [pubky/pubky-ring](https://github.com/pubky/pubky-ring/releases)
