# Authentication & sessions (`pubkyauth`)

How an app gets a capability-scoped homeserver session for a user: the grant handshake, capabilities, `pubkyauth://` links, relays, recovery files, signup tokens and the session lifecycle.

Canonical elsewhere, so link rather than restate:
- Identity, keypairs, recovery-file format and passphrase caveat, "sign up once, then sign in": [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair)
- `toString()` vs `z32()`: [`concepts.md#public-key-string-formats`](concepts.md#public-key-string-formats)
- Scope naming: [`concepts.md#scopes`](concepts.md#scopes)
- Issuing signup tokens (operators): [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md)

## Versions

- **Current:** `pubky` **0.12.0** (crates.io, 2026-09-14) and `@synonymdev/pubky` **0.12.0** (npm `latest`). Grant auth shipped in **0.10.0** (2026-08-05); its public API is unchanged in 0.11 and 0.12. Harnesses pinned to 0.9.x have no grant API.
- Snippets marked "executed" below were run against a local testnet on 0.12.0. The KB's CI-verified snippets are pinned to 0.10.0.
- **Don't write 0.9-era code.** These were renamed or deprecated:
  - `start_auth_flow` / `startAuthFlow` / `resume_auth_flow` → deprecated `*_cookie_*` names.
  - `signup` returning a session (it now returns nothing).
  - `signin()` without a client ID.
  - `export_secret` / `import_secret` (deprecated cookie-only APIs).
  - `Capability::builder(scope)`.
- **Stale upstream sources:** pubky-ai-kit's auth sections still use the 0.9 API (AuthTokens, sync `startAuthFlow(caps, kind, relay)`, `resumeAuthFlow`). The KB's React Native auth snippet targets 0.13.0; for `@synonymdev/react-native-pubky` 0.14.0 (grant-backed `signUp` / `signIn` with `clientId`) see [`../../pubky-mobile/references/react-native.md`](../../pubky-mobile/references/react-native.md).

## Pick the right path

| You are building | Use | Capabilities granted |
| :-- | :-- | :-- |
| A third-party app (web, server, CLI) | Grant auth flow: `start_grant_auth_flow` / `startGrantAuthFlow`; user approves in an authenticator such as Pubky Ring | Exactly what you request |
| An authenticator, key manager or first-party tool that holds the `Keypair` | `PubkySigner`: `signup`, `signin(client_id)`, `approve_auth` | `signin` always grants **root `/:rw`** |
| Anything new | **Not** cookie auth (`*_cookie*`, deprecated and insecure) | n/a |

- **Never hand-build `pubkyauth://` URLs or tokens.** Use `authorization_url()` (Rust) / `authorizationUrl` (JS) from the flow.
- **Never ask users to paste keys or mnemonics into a third-party app.** See [`concepts.md#authentication`](concepts.md#authentication).

## Grant auth model

1. The app starts a flow, which generates a random 32-byte relay `secret` and a fresh **PoP (proof-of-possession)** client keypair, then subscribes to relay channel `base64url(hash(secret))`.
2. The app shows a `pubkyauth://signin_grant?...` URL as a QR code or deep link.
3. The authenticator shows capabilities and client ID; on consent it signs a **grant** (a `pubky-grant` JWS with `iss` user, `client_id`, `caps`, `cnf` = client PoP public key, `jti` = grant ID, `iat`/`exp`), encrypts it with `secret`, and posts it to the relay.
4. The app decrypts the grant, resolves the user's homeserver, and exchanges grant + `pubky-pop` proof at `POST /auth/grant/session` for an opaque **bearer token** valid 1 hour.
5. The SDK sends `Authorization: Bearer <token>` and mints a new one before expiry with a fresh PoP proof. No root key needed.

**Grants vs cookies:** per-client credentials; replaying a grant requires the client's private key; grants can be listed and revoked individually.

**Client ID:** required for every grant session; stored by the homeserver and shown when the user lists sessions. Use a stable domain-like string (`myapp.example`). Validation only checks non-empty and ≤253 bytes (UTF-8 length, not characters).

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

<sub>Source (v0.12 runnable browser example; run-ID guards and QR rendering removed; executed on 0.12.0 against a local testnet): [`examples/javascript/2-auth-flow/src/pubky-auth-widget.js`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/2-auth-flow/src/pubky-auth-widget.js). Upstream renders `_pubkyZ32` to people as "Public key"; for display use `session.info.publicKey.toString()` (`pubky<z32>`) and keep `z32()` for hostnames and keys. In strict TypeScript `session.grant` is `GrantSession | undefined` and needs narrowing.</sub>

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

<sub>Source (CI-verified on 0.10.0; type-checked and executed on 0.12.0 against a local testnet): [`pubky-knowledge-base-v2/snippets/js/src/getting-started.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/getting-started.ts)</sub>

- **Signature:** `startGrantAuthFlow(capabilities: string, kind, { clientId, relay?, xCallback? })` is **async**; always `await` it. `xCallback` is `{ xSource, xSuccess, xError, xCancel }`.
- **`authorizationUrl` is a property**, not a method.
- **Wait:** `flow.awaitApproval()` → `Session`; `flow.tryPollOnce()` → `Session | undefined`.
- **Poll from one place only.** Concurrent `awaitApproval()` / `tryPollOnce()` calls, or any call after `awaitApproval()` has consumed the flow, can throw `ClientStateError`. Stop polling once you have a session.
- **Delegated vs local PoP key.** In a browser with a secure context, IndexedDB and WebCrypto **Ed25519** support, the flow tries a **delegated** (non-extractable) PoP key and silently falls back to a local key if that start fails. Elsewhere it uses a local key. This decides which save API works (see [Resume after reload or restart](#resume-after-reload-or-restart)).

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

<sub>Source (doc-tested; executed on 0.12.0): [`pubky-sdk/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md). The `use` lines are hidden in upstream; `XCallbackParams` is **not** re-exported at the crate root.</sub>

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

<sub>Source (v0.12 runnable, with elisions; executed on 0.12.0 against a local testnet): [`examples/rust/2-auth_flow/client.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/client.rs), which also shows `--testnet`, custom relay and signup options.</sub>

- **Start:** `Pubky::start_grant_auth_flow(&caps, kind, client_id) -> Result<PubkyGrantAuthFlow>` is **not async**. For relay, HTTP client, client keypair/secret or x-callback control use `PubkyGrantAuthFlow::builder(..)…start()`; see [docs.rs `PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html).
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

- **JS: don't predict the kind.** `saveLocal()` on a delegated flow and `saveDelegated()` on a local flow throw `ClientStateError`. `GrantAuthFlow.isDelegationAvailable` is only a coarse check (it misses Ed25519 support and the silent fallback), so try `saveDelegated()` and fall back to `saveLocal()` on `ClientStateError`; remember which you saved.
- **Saved state is secret:** relay secret **and** PoP private key. Store briefly (e.g. `sessionStorage`), delete on completion or abandonment. It's useless once the relay inbox drops the message (~5 minutes).
- **Rust:** serde for `GrantAuthFlowState` needs the `json` feature; `restore` checks the saved key matches the URL's `cpk`.
- **Upstream doc bug:** the JS README's "Resume an auth flow after page refresh" example omits `await` on `startGrantAuthFlow` and calls nonexistent `flow.save()`. Don't copy it.

## Capabilities

**Format:** `<scope>:<actions>`, comma-separated (`/pub/my-cool-app/:rw,/pub/foo.txt:r`). `scope` starts with `/`; `actions` is `r` (GET), `w` (PUT/POST/DELETE) or `rw`. Root is `/:rw`.

- **Trailing slash matters (0.10+):** `/pub/app/` covers that directory and below, **not** `/pub/app` or `/pub/app-evil/foo`; `/pub/app` covers only that file. End directory scopes with `/`.
- **Scopes must be canonical absolute paths.** Repeated `/`, `.` and `..` are **rejected**, not normalized; percent sequences are literal.
- **The homeserver enforces capabilities on every request.** Request the narrowest scope that works.
- **Rust (0.10+):** `Capability::root()`; `Capability::read|write|read_write(scope)` and `"/pub/app/:rw".parse()` return `Result<Capability, CapabilityParseError>`. `Capabilities::builder()` with fallible `.read(s)?` / `.write(s)?` / `.read_write(s)?`, plus `.cap(c)`, `.extend(iter)`, `.finish()`. `Capabilities::normalize()` merges duplicates and drops covered entries. Both types are re-exported from `pubky`: [docs.rs `Capabilities`](https://docs.rs/pubky/latest/pubky/struct.Capabilities.html).
- **JS:** validate user-supplied strings with `validateCapabilities` before starting a flow:

```js
import { Pubky, validateCapabilities, AuthFlowKind } from "@synonymdev/pubky";

const pubky = new Pubky();

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
```

<sub>Source (executed on 0.12.0 against a local testnet): [`pubky-sdk/bindings/js/pkg/README.md`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md). `validateCapabilities` returns the normalized string; failure throws `InvalidInput` naming the **first** bad entry, which is in `error.data.invalidEntries`. In TypeScript the returned `string` needs a cast to `Capabilities`, and `error` (typed `unknown`) needs narrowing.</sub>

## `pubkyauth://` deep links

The intent is the URL **host**. `pubkyring://` is a deprecated alias that still parses.

| Intent | Auth type | Parameters |
| :-- | :-- | :-- |
| `signin_grant` | grant | `caps`, `relay`, `secret`, `cid` (client ID), `cpk` (client PoP public key, z32) |
| `signup_grant` | grant | `signin_grant` params + `hs` (homeserver z32), optional `st` (signup token) |
| `signin` | legacy cookie | `caps`, `relay`, `secret` |
| `signup` | legacy cookie | `caps`, `relay`, `secret`, `hs`, optional `st` |
| `direct_signup` | account creation only | `hs`, optional `st` |
| `secret_export` | key export (not auth) | |

- `secret`: 32 bytes, base64url, unpadded. Optional return params: `x-source`, `x-success`, `x-error`, `x-cancel`; legacy `callback` is a fallback for `x-success`.
- **Empty host** (`pubkyauth:///?...`, as in AUTH.md) parses as legacy `signin`.
- **Rust `DeepLink`** (`pubky::deep_links::DeepLink`) has **6 variants** in 0.10+: `Signin`, `Signup`, `DirectSignup`, `SigninGrant`, `SignupGrant`, `SeedExport` (0.9 had 3). A 0.9 `match` without a catch-all won't compile. Read parameters with `.params()`.

Recognition only. **Always use the URL the flow gives you:**

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

<sub>Source (v0.12 runnable; lines 65–90 condensed, testnet branch removed; executed on 0.12.0 against a local testnet with real `SigninGrant` and `SignupGrant` URLs): [`examples/rust/2-auth_flow/authenticator.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/2-auth_flow/authenticator.rs). Import `DeepLink` from `pubky::deep_links::DeepLink`.</sub>

- **`approve_auth`:** Rust `PubkySigner::approve_auth(&self, url) -> Result<()>`; JS `signer.approveAuthRequest(url)`. Handles `signin`, `signup`, `signin_grant`, `signup_grant`; rejects `direct_signup` and `secret_export`. Approved grants use the URL's capabilities and last **2 years**.
- **`approve_auth` does not create the account.** For `signup` / `signup_grant`, call `signer.signup(homeserver, token)` first, as above.
- **`handle_deeplink(url)`** (Rust) / `handleDeepLink(url)` (JS) also handles `direct_signup` by calling `signup(hs, st)`.
- **Show consent first:** display the requested capabilities and `client_id` before approving.
- **Recovery files:** `pubky` re-exports `pubky::recovery_file::{create_recovery_file, decrypt_recovery_file}`; on non-WASM targets `Pubky::signer_from_recovery_file(path, passphrase)` loads a signer directly. JS APIs, format and the passphrase caveat: [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair). Upstream examples try an **empty passphrase first** (the sample key has none); don't ship that fallback.
- **Pubky Ring** parses and approves `signin`, `signup`, `direct_signup`, `signin_grant` and `signup_grant`: [`../../pubky-mobile/references/ring-auth.md`](../../pubky-mobile/references/ring-auth.md).

## Relays

- **Default:** `https://httprelay.pubky.app/inbox` (hosted by Synonym). `DEFAULT_HTTP_RELAY` (the `/link` URL) is deprecated.
- **Channel selection:** a relay path ending in `/link` or `/link/` uses the legacy synchronous link channel; anything else uses the store-and-forward inbox. A trailing slash on the base URL is optional.
- **Inbox:** holds a message ~5 minutes; the app long-polls with GET and acknowledges with DELETE; the producer can check `/ack` and `/await`.
- **End-to-end encrypted** with the URL's `secret`, which travels only inside the `pubkyauth://` URL, so the relay sees only ciphertext and can't use the credential. (Cookie and grant flows both work this way.)
- **Run your own for production.** If the default relay is down, logins can't complete. Pass it via `.relay(url)` / `{ relay }`. Project: [pubky/http-relay](https://github.com/pubky/http-relay); operating guide: [`../../pubky-infra/references/http-relay.md`](../../pubky-infra/references/http-relay.md).
- **Testnet relay:** `http://localhost:15412/inbox`. See [`testing-and-testnet.md`](testing-and-testnet.md).

## Signup tokens

Homeservers in `TokenRequired` mode need a token to create an account.

- **Pass a token:**
  - Rust: `signer.signup(&hs, Some("AAAA-BBBB-CCCC"))` (`Option<&str>`).
  - JS: `await signer.signup(hs, token)` (`string | null`).
  - Grant flow: `AuthFlowKind::signup(hs, Some(token))` adds `st` to the URL.
  - Direct link: `pubkyauth://direct_signup?hs=<z32>&st=<token>`.
  - Open and testnet homeservers accept `None` / `null`.
- **Rules:** 14-character hyphenated Crockford base32 (`AAAA-BBBB-CCCC`). **Single use**, consumed in the same transaction that creates the account. Tokens don't expire. A token may carry a storage quota for the new user.
- **Errors:** missing → HTTP 400 ("Token required"); unknown or already used → HTTP 401 ("Invalid token" / "Token already used").
  - **JS:** these arrive as `RequestError` with `error.data.statusCode` 400 or 401, **not** `AuthenticationError` as the `signup` JSDoc claims. Branch on `statusCode`.
- **Pre-check:** `GET /signup_tokens/{token}` → `{ status: "valid" | "used", created_at }` (`created_at` is an ISO 8601 string); 400 if tokens aren't required or the format is bad, 404 if unknown.
- **Issuing tokens:** [`../../pubky-infra/references/signup-gating.md`](../../pubky-infra/references/signup-gating.md).

## First-party signer sign-in

Only when your code legitimately holds the user's `Keypair` (authenticator, first-party tool).

```rust
use pubky::{ClientId, Keypair, Pubky};

let pubky = Pubky::new()?;
let keypair = Keypair::random();

// Sign in (user already has an account on a homeserver)
let signer = pubky.signer(keypair);
let session = signer
    .signin(ClientId::new("myapp.example").unwrap())
    .await?;

// Write data (requires the "json" feature)
let profile = serde_json::json!({"name": "Alice", "bio": "Building on Pubky!"});
session
    .storage()
    .put_json("/pub/myapp/profile", &profile)
    .await?;

// Read data
let profile: serde_json::Value = session.storage().get_json("/pub/myapp/profile").await?;
```

<sub>Source (CI-verified on `pubky =0.10.0`; executed on 0.12.0 against a local testnet after signing the key up): [`pubky-knowledge-base-v2/snippets/rust/src/lib.rs`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/rust/src/lib.rs). **As written, `signin` fails at runtime:** `Keypair::random()` is a placeholder with no account. Load an existing key or call `signup` first. JS equivalent and the signup → signin sequence: [`concepts.md#identity-the-ed25519-keypair`](concepts.md#identity-the-ed25519-keypair).</sub>

Auth-specific behavior (the rest of signup/signin is in `concepts.md`):
- **`signup(&hs, token) -> Result<()>`** uses the reserved client ID `pubky.signup` with a 5-minute grant. It returns no session.
- **`signin(client_id)`** signs a **root `/:rw`** grant valid 2 years with a fresh PoP key. It resolves the homeserver first, so it **fails if the user has no `_pubky` record** (never signed up, or record not published).

## Session lifecycle

Grant session info: `homeserver`, `pubky`, `client_id`, `capabilities`, `grant_id`, `token_expires_at`, `grant_expires_at`, `created_at`. All timestamps are **Unix seconds**.

### Inspect, refresh, revalidate, sign out

- **`PubkySession` (Rust)** is cheap to clone and thread-safe. `info()` → `public_key()`, `capabilities()`; `storage()`. `as_grant()` → `Option<GrantSessionView>` with `session_info()`, `grant_id()`, `current_bearer()`, `export_local_secret()` (all async). `as_cookie()` is deprecated and holds cookie-only fields such as `created_at()`.
- **JS:** `session.info.publicKey`, `await session.grant.sessionInfo()`.
- **Automatic refresh:** the SDK mints a new bearer when the current one is within **300 s** of expiry, one refresh at a time. Bearer: 1 hour. Grant: 2 years (from `signin` or `approve_auth`) unless revoked.
- **`revalidate() -> Result<Option<SessionInfo>>`** returns `Ok(None)` when the session expired or was invalidated.
- **`signout(self) -> Result<(), (Error, Self)>`** returns the session on failure; use `.map_err(|(e, _)| e)` with `?`.
  - For grant sessions it sends `DELETE /auth/grant/session`, which **revokes that session's grant**. Repeat calls are a no-op (200). Other apps' grants are unaffected.
  - **A revoked grant can't be restored** (401).
- **Force re-authentication:** sign out, then start a new flow (a signer can just `signin` again).

### Persist and restore

- **Rust and Node:** `export_local_secret()` / `exportLocalSecret()` returns a `pubky-grant-credential-v1…` string embedding the homeserver key, the PoP secret and the grant JWS. **Treat it as a bearer credential** until the grant expires or is revoked.
  - Restore with `pubky.restore_session(&secret)` / `pubky.restoreSession(secret)`, which mints a fresh bearer. Don't persist the 1-hour bearer itself. `restore_session` also accepts legacy cookie secrets.
  - **Restoring replaces the old session:** the old in-memory session's `revalidate()` then returns `None`. Stop using it.

```rust
let signer = pubky.signer(Keypair::random());
signer.signup(&server.public_key(), None).await.unwrap();
let session = signer
    .signin(ClientId::new("restore-bearer.test").unwrap())
    .await
    .unwrap();

let original_bearer = session.as_grant().unwrap().current_bearer().await;
let secret_token = session
    .as_grant()
    .unwrap()
    .export_local_secret()
    .await
    .unwrap();

let restored = pubky.restore_session(&secret_token).await.unwrap();
```

<sub>Source (e2e test, v0.12; executed on 0.12.0 against a local testnet): [`e2e/src/tests/auth/grant.rs`](https://github.com/pubky/pubky-homeserver/blob/main/e2e/src/tests/auth/grant.rs). The `.unwrap()`s are test style; propagate errors in library code (`export_local_secret()` returns an `Option`).</sub>

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

<sub>Source (migration guide, split in two because the original declares `restored` twice; both executed on 0.12.0 against a local testnet, the browser block in Node with an IndexedDB polyfill): [`docs/v0.10-migration/grant-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md)</sub>

- **`browserSessionStore`** is IndexedDB-backed, per-origin, multi-account, and browser-only (`isAvailable()` is false in plain Node). Methods: `isAvailable()`, `save(session)`, `list()`, `restore(id)`, `remove(id)`, `clear()`, `clearAll()` (also deletes delegated keys of pending flows). Field list: [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md).
- **Units differ in `save()`'s result:** `grantExpiresAt` is Unix **seconds**, `createdAt` is Unix **milliseconds**. `storageMode` is `'delegated'` or `'localSecret'`.
- **Delegated sessions** keep the PoP key non-extractable; `exportLocalSecret()` on one throws `ClientStateError`, so use the store. `localSecret` sessions put bearer-equivalent material in IndexedDB.
- **Removing isn't revoking.** `remove()`, `clear()` and `clearAll()` delete local state only. Revoke with `session.signout()` or `GrantManager.revoke(grantId)`.
- **Upstream doc bug:** the Rust SDK README's `.sess` example calls `session.write_secret_file(...)` on a grant session. It's deprecated and **panics** on non-cookie sessions. Use `as_grant().export_local_secret()` + `restore_session`.

### List and revoke grants

Requires a **root-capability** session (non-root gets 403).

- **Rust:** `GrantManager::new(&session)`; `.list().await` → `Vec<GrantInfo>` (its `capabilities` field is a comma-joined string); `.revoke(&GrantId::parse(s)?).await` revokes a grant and all its sessions.
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

<sub>Source (v0.12 runnable; executed on 0.12.0 against a local testnet): [`examples/rust/6-session_management/main.rs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/rust/6-session_management/main.rs). JS: [`examples/javascript/8-session-management.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs).</sub>

## Errors

- **JS:** `PubkyError` with `name` ∈ `RequestError`, `InvalidInput`, `AuthenticationError`, `PkarrError`, `ClientStateError`, `InternalError`; `data` carries details such as `{ statusCode }`. HTTP rejections from the homeserver surface as `RequestError`, so branch on `data.statusCode`.
  - The README's error list omits `ClientStateError`, but the SDK throws it for: concurrent or post-completion flow polling, delegated/local save or export mismatch, or a grant-only call on a non-grant session.
- **Homeserver resolution (0.10+):** JS `getHomeserverOf()` rejects with `PkarrError` on failure; sign-in and grant exchange can surface it too. Rust `get_homeserver_of` returns `Result<Option<PublicKey>>`. `pubky::Error` has **no** `is_retryable()`; match the PKARR variant: `Err(Error::Pkarr(e)) if e.is_retryable()`.

## Deprecated: cookie auth

Still present in 0.12 under explicit `*Cookie` / `_cookie` names. **Migrate to grants.** It's insecure: the cookie belongs to the homeserver's domain, so site B can reuse site A's cookie and permissions ([issue #520](https://github.com/pubky/pubky-homeserver/issues/520)). The long-lived session cookie (up to 1 year) has no replay prevention, and there is no session listing or revocation.

| 0.9 name | 0.10+ name (deprecated) |
| :-- | :-- |
| `startAuthFlow` / `resumeAuthFlow` | `startCookieAuthFlow` / `resumeCookieAuthFlow` |
| `start_auth_flow` / `PubkyAuthFlow` | `start_cookie_auth_flow` / `PubkyCookieAuthFlow` |
| `signup` / `signin` (cookie) | `signup_cookie` / `signin_cookie` / `signin_cookie_blocking` |
| `session.export_secret()` | `session.as_cookie().and_then(\|c\| c.export_secret())` |

Also deprecated: Rust `import_secret`, `write_secret_file`, `session_from_file`, `CookieSessionRecord`; JS `session.cookie`, `session.export()`, `Session.restore`. Full mapping: [`docs/v0.10-migration/cookie-auth.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md).

**Legacy `AuthToken`** is the signed payload for cookie flows and legacy `signin` / `signup` links. The token exchange itself rejects replays: the homeserver accepts timestamps within ±3 minutes and rejects a repeated `(timestamp, pubky)` pair. [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) describes **only** this legacy payload; use it for the relay/encryption handshake, not for grant payloads.

## Wire reference (debugging only; use the SDK)

- **Routes:** grant exchange, signup (no bearer), current-session read/revoke, and root-only list/revoke-by-ID live under `/auth/grant/*`; deprecated cookie routes are `/signup` and `/session`. Source of truth: [`auth/router.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/router.rs).
- **JWS:** `alg: EdDSA`, `typ` `pubky-grant` or `pubky-pop`. PoP proofs bind `aud` to the homeserver key (no cross-homeserver replay), and `iat` must be within **±180 s** of server time, so client clock skew in either direction breaks the exchange. Source: [`pop_verifier.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/grant/crypto/pop_verifier.rs).

## Upstream

- **0.10 migration guide:** [README](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md) · [grant-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md) · [cookie-auth.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/cookie-auth.md)
- **API:** [docs.rs/pubky](https://docs.rs/pubky/latest/pubky/) · [`PubkyGrantAuthFlow`](https://docs.rs/pubky/latest/pubky/struct.PubkyGrantAuthFlow.html) · [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md) · [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md)
- **Protocol:** [AUTH.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) (legacy payload)
- **Examples:** [rust/2-auth_flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/2-auth_flow) · [rust/6-session_management](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/6-session_management) · [javascript/2-auth-flow](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/2-auth-flow) · [javascript/5-browser-session-persistence](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript/5-browser-session-persistence) · [javascript/8-session-management.mjs](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs)
- **Relay:** [pubky/http-relay](https://github.com/pubky/http-relay)
