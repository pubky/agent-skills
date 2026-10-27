# React Native client (`@synonymdev/react-native-pubky`)

`@synonymdev/react-native-pubky` is the React Native bridge to [`pubky-core-ffi`](./native-ffi.md). This page covers its JS method surface and the RN-specific pitfalls: auth and Ring, the homeserver lifecycle, keys, `pubky://` data operations, PKARR, event streams, storage locks, and `Result` / `PubkyError` handling. Shared material lives in other files:

- Identity, `pubky://` addressing, the `/pub` tree, PKARR: [`concepts.md`](../../pubky/references/concepts.md) ([key formats](../../pubky/references/concepts.md#public-key-string-formats), [addressing](../../pubky/references/concepts.md#addressing-and-the-pub-tree), [PKARR](../../pubky/references/concepts.md#pkarr-resolution)).
- The `pubkyauth` handshake, capability grammar, resumable flows, grant management: [`auth.md`](../../pubky/references/auth.md).
- On-wire data shapes (profile, posts, tags, paths, IDs): [`app-specs.md`](../../pubky/references/app-specs.md).
- Grant vs cookie secrets, the native `[error, data]` contract, Android rustls init: [`native-ffi.md`](./native-ffi.md).
- Ring deeplinks, QR transport, x-callback, storing a `grant_secret`: [`ring-auth.md`](./ring-auth.md).

**Upstream sources of truth:** [npm](https://www.npmjs.com/package/@synonymdev/react-native-pubky) · [repo](https://github.com/pubky/react-native-pubky) · [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c/src/index.tsx) (typings) · [README](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c/README.md) · [`pubky-core-ffi` `src/`](https://github.com/pubky/pubky-core-ffi/tree/cecd67c/src). This page was checked against **0.15.0** (release commit [`e85e344`](https://github.com/pubky/react-native-pubky/tree/e85e34453a1c)). Where this page and your installed typings disagree, trust the typings.

**Snippet status:** every snippet below type-checks (`tsc --noEmit`, strict) against the published 0.15.0 package. **None were run**, because the native bridge (`NativeModules.Pubky`) cannot run under Node. Upstream deleted the `pubky-knowledge-base-v2` RN snippets (KB commit [`1999172`](https://github.com/pubky/pubky-knowledge-base-v2/commit/19991727750f807ac829ea261fec8e77c45cf78c)), so no CI-verified RN snippet exists upstream any more.

## Version

- Latest: **0.15.0** (2026-10-21, "expose Pubky 0.16 React Native APIs"). Earlier releases: 0.14.1 (2026-10-01, `listGrants` / `revokeGrant`, Android 16 KB-page native libs) and 0.14.0 (2026-08-31). Pre-1.0.
- Runtime dependency: `@synonymdev/result` `^0.0.2`. Peer dependencies: `react` and `react-native` (`*`).
- Native bindings come from `pubky-core-ffi` `main` (`cecd67c`, built on the `pubky` crate 0.16.1). The `setup-remote-*-bindings.js` scripts pull **FFI `main`, not a tag**, so a local rebuild can pick up newer bindings than the npm package shipped.
- **Breaking vs 0.14.0 (changed in 0.14.1, [`91e0fcc`](https://github.com/pubky/react-native-pubky/commit/91e0fcc), PR #43):** `GrantSessionInfo` grew from 3 fields to 9 (see [Session types](#session-types)). Code that only destructures `{ pubky, capabilities, grant_secret }` still compiles. Code that builds a `GrantSessionInfo` literal does not. If you are on 0.14.1, you already have the 9-field type.
- Tests: `src/__tests__/index.test.tsx` contains real Jest tests, but they cover only the **0.15 wrapper layer, with a mocked `NativeModules`**. Native behaviour and the legacy functions are untested. The example app (`example/src/App.tsx`) exercises none of the 0.15 APIs.

## Install and linking

```bash
npm install @synonymdev/react-native-pubky
cd ios && pod install
```

- This is a native module, so rebuild the app after installing. **It does not work in Expo Go.** Use a dev client or the bare workflow.
- If the module is not linked, `NativeModules.Pubky` is a Proxy that throws `LINKING_ERROR` ("doesn't seem to be linked… pod install… rebuilt… not using Expo Go"). Inside a wrapper call this becomes `err(...)`. **Importing the package can still throw**, because `new NativeEventEmitter(Pubky)` runs at module load, outside any `try`.
- **Android rustls init is automatic.** The `PubkyModule` constructor calls the idempotent `RustlsInit.ensure(...)`, so don't call it yourself. The init stays required until pkarr#262 lands ([mechanism](./native-ffi.md#mandatory-android-rustls-init)). iOS needs no init.

## `Result` and errors

Every function export is `async` and returns `Promise<Result<T>>` from `@synonymdev/result` 0.0.2: either `Ok<T> { value }` or `Err<T> { error: Error }`. `isOk()` and `isErr()` are TypeScript type guards, so **check one before you read `.value`**. Wrappers never throw into the caller, except for the import-time linking error above.

The error style depends on the API generation:

| API group | `result.error` on failure |
| :-- | :-- |
| **Legacy** (auth, `signUp`, `signIn`, `put`, `get`, `list`, `deleteFile`, `*WithSession`, `publish*`, `resolve*`, keys, mnemonics, `startAuthFlow`, `awaitAuthApproval`, `listGrants`, `revokeGrant`, `revalidateSession`, …) | A plain `Error` with only a `message`. The native call returns `['true' \| 'false', payload]`, and `'true'` maps to `err(payload)` ([contract](./native-ffi.md#the-error-data-convention-legacy-family)). |
| **New in 0.15** (`configureClient`, `switchNetwork`, `public*` / `session*`, Grant-flow config/poll/save/restore/cancel, custom proofs, encryption-key helpers, `*Blocking`, event streams, storage locks) | A `PubkyError`, decoded from the JSON the native side rejects with |

`PubkyError extends Error` and adds these fields:

| Field | Set when |
| :-- | :-- |
| `kind` | Always. One of `'transport' \| 'server' \| 'validation' \| 'decodeJson' \| 'pkarr' \| 'parse' \| 'authentication' \| 'build' \| 'state' \| 'unknown'`. Argument and JSON errors raised by the bridge itself map to `'validation'`. |
| `status` | `kind === 'server'` (the HTTP status) |
| `retryable` | `kind === 'pkarr'` |
| `expired` | `kind === 'authentication'`, but it is true **only** for a request expiry (cookie or relay timeout). **An expired grant has `expired === false`.** |
| `nativeCode` | `PUBKY_<UPPER_SNAKE_KIND>`, for example `PUBKY_SERVER` or `PUBKY_DECODE_JSON` |
| `operation` | Optional |

- Branch with `result.error instanceof PubkyError`. For legacy calls, fall back to `result.error.message`.
- **Gotcha:** when `__DEV__` is true (outside Jest), the `Err` constructor `console.log`s every error, so dev logs show every failure message. Keep secrets out of anything that can end up in an error.

### Runtime values vs TypeScript types

| Function | Typed | Actual `.value` |
| :-- | :-- | :-- |
| `put` | `string[]` | One string: the trimmed URL that was written |
| `deleteFile` | `string[]` | `'Deleted successfully'` |
| `publish` / `publishHttps` | `string[]` | One string: the signer's z32 public key |
| `auth` | `string[]` | `'Authorization success'` |
| `switchNetwork` | `string[]` | The raw native array, for example `['false', 'Switched to testnet network']`. The type matches, but the wrapper never inspects the legacy envelope, so a `'true'` error flag still comes back as `ok`. |

- `putWithSession` and `deleteWithSession` are typed `string` and return the written URL and `'Deleted successfully'`, so their types match.
- `list` is the only legacy `string[]` function that returns a real, JSON-parsed array.

## Pick an auth path

| You are building… | Holds the user's secret key? | Use |
| :-- | :-- | :-- |
| A normal third-party app (almost everyone) | **Never** | `startAuthFlow(caps, clientId)` → `awaitAuthApproval()`, or [`startGrantAuthFlowWithConfig`](#resumable-cancellable-and-signup-grant-flows) when you need signup, resumability or cancellation |
| A key-owning app (it created the identity) | Yes | `signUp` / `signIn` → `grant_secret` |
| An authenticator such as Pubky Ring (rare) | Yes | `parseDeepLink(url)` → `auth` / `authWithCapabilities` ([authenticator side](#authenticator-side)) |

- **Grant auth is the default.** `signUp`, `signIn`, `startAuthFlow` and `awaitAuthApproval` are aliases for `signUpGrant`, `signInGrant`, `startGrantAuthFlow` and `awaitGrantAuthApproval`. The `*Cookie` variants (`signUpCookie`, `signInCookie`, `startCookieAuthFlow`, `awaitCookieAuthApproval`, `signInCookieBlocking`) only mirror upstream, where cookie auth is **deprecated**. Don't use them in new code.
- `clientId` is validated natively by `ClientId::new` (pubky-common 0.16.1). It must be non-empty and at most 253 characters, and invalid input returns `err('Invalid client_id: …')`. Use a domain such as `my-app.example`.
- **`grant_secret` is a bearer credential.** It is stored unencrypted. It contains the grant and its proof-of-possession private key, and for signed approvals it also contains the approval with its encryption keys. Keep it only in the Keychain or Keystore, and never log it ([persist and restore](../../pubky/references/auth.md#persist-and-restore), [ring-auth](./ring-auth.md#store-and-revoke-the-grant_secret)). The README and the example app `console.log` session values. Don't carry that into production code.

## Grant auth via Ring (no secret key)

Adapted from the README examples for `startAuthFlow`, `awaitAuthApproval`, `putWithSession` and `signOut`. Type-checked against 0.15.0, not run.

```react-native
import {
  startAuthFlow,
  awaitAuthApproval,
  putWithSession,
  revalidateSession,
  signOut,
} from "@synonymdev/react-native-pubky";

const CLIENT_ID = "my-app.example"; // usually a domain

const startRes = await startAuthFlow("/pub/my-app.example/:rw", CLIENT_ID);
if (startRes.isErr()) throw startRes.error;
const authUrl: string = startRes.value; // present as QR / deeplink for Ring

const approvalRes = await awaitAuthApproval(); // resolves once the user approves
if (approvalRes.isErr()) throw approvalRes.error;
const { pubky, grant_secret, grant_id, grant_expires_at } = approvalRes.value;
// pubky is bare z32. Store grant_secret in Keychain/Keystore; never log it.

// putWithSession takes an ALREADY-stringified string; URL must contain /pub/
const putRes = await putWithSession(
  `pubky://${pubky}/pub/my-app.example/settings.json`,
  JSON.stringify({ theme: "dark" }),
  grant_secret,
);
if (putRes.isErr()) throw putRes.error;

// On app start: check the stored grant is still valid
const checkRes = await revalidateSession(grant_secret);
if (checkRes.isErr()) {
  // Re-auth on "Session is no longer valid (expired or invalidated)" AND on a
  // "Failed to import session: …" whose message says the grant has expired or is
  // unauthorized (401/403). Only transport/network failures are non-conclusive.
}

// Revoke this grant server-side, then delete your stored copy
const outRes = await signOut(grant_secret);
if (outRes.isErr()) throw outRes.error;
```

- `startAuthFlow` and `startGrantAuthFlow` build a **sign-in** Grant flow and return the authorization URL. For signup, use [`startGrantAuthFlowWithConfig`](#resumable-cancellable-and-signup-grant-flows) with `homeserver` set.
- A pending flow lives in **one process-global slot**, which `startGrantAuthFlowWithConfig` and `restoreGrantAuthFlow` also use. Any new start or restore **overwrites** the pending flow.
- `awaitAuthApproval()` takes the flow out of the slot. If there is no flow (it was never started, or was already awaited), it returns `err('No auth flow in progress')`.
- A bad capability string returns `err('Invalid capabilities: …')`. For the grammar, see [auth.md](../../pubky/references/auth.md#capabilities).
- **`revalidateSession` works on both iOS and Android** (0.14.0 lacked the iOS bridge). It returns the session shape that matches the secret you pass. For a grant, it first imports the stored credential, which rejects an expired grant locally and then exchanges the grant with the homeserver. It then checks the session. Handle its errors like this:
  - `'Session is no longer valid (expired or invalidated)'`: re-authenticate.
  - `'Failed to import session: … stored grant credential has expired'`: re-authenticate. **This is the usual error for an expired grant.**
  - `'Failed to import session: …'` carrying a server auth error (401/403): re-authenticate. A revoked grant most likely fails here (inferred from source).
  - Transport or network failures, including those wrapped as `'Failed to revalidate session: …'`: these are **not** proof that the grant is dead. Retry later.
- `signOut`, `revalidateSession`, `putWithSession` and `deleteWithSession` accept either a `grant_secret` or a legacy cookie `session_secret`. The format is opaque, so don't parse it ([auth strategies](./native-ffi.md#auth-strategies-and-session-secrets)).

## Resumable, cancellable and signup Grant flows

New in 0.15. `startGrantAuthFlowWithConfig(config)` returns `GrantAuthFlowState { authorizationUrl, clientKeySecret, approvalKeySecret? }`. Both secrets are base64 and **sensitive**.

| `GrantAuthFlowConfig` field | Meaning |
| :-- | :-- |
| `capabilities`, `clientId` | Required, as for `startAuthFlow` |
| `homeserver?`, `signupToken?` | **Setting `homeserver` selects signup.** Leaving it out selects sign-in. This is the only RN path to a signup Grant flow ([sign-up through the flow](../../pubky/references/auth.md#sign-up-through-the-flow)). |
| `relay?` | A custom HTTP relay |
| `clientSecret?` / `clientKeySecret?` | Exactly 32 bytes, as base64 |
| `approvalFormat?` | `'bareGrant'` or `'signedApprovalV1'`. [Scoped encryption keys](#custom-grant-proofs-and-scoped-encryption-keys) need `'signedApprovalV1'`. |
| `xSource` / `xSuccess` / `xError` / `xCancel` | x-callback URLs ([ring-auth](./ring-auth.md)) |

| Function | Returns (`.value`) |
| :-- | :-- |
| `saveGrantAuthFlow()` | `GrantAuthFlowState` |
| `restoreGrantAuthFlow(state)` | `authorizationUrl`. The restored flow goes into the global slot. |
| `pollGrantAuthFlow()` | `GrantSessionInfo \| null`. `null` means not approved yet. After `null` or an error, the flow goes back into the slot. On approval, the flow is consumed. |
| `awaitGrantAuthFlow()` | `GrantSessionInfo` |
| `cancelGrantAuthFlow()` | `void` |

**Gotcha:** while `awaitGrantAuthFlow()` is pending, the flow is out of the slot. You **cannot save or cancel it**, and `cancelGrantAuthFlow()` does not abort it. If you need save or cancel, poll instead. Saved state is useful only while the relay still holds the message ([resume](../../pubky/references/auth.md#resume-after-reload-or-restart)).

Written from the `src/index.tsx` signatures and the README guidance. Type-checked against 0.15.0, not run.

```react-native
import {
  startGrantAuthFlowWithConfig,
  saveGrantAuthFlow,
  restoreGrantAuthFlow,
  pollGrantAuthFlow,
  cancelGrantAuthFlow,
  type GrantAuthFlowState,
  type GrantSessionInfo,
} from "@synonymdev/react-native-pubky";

const started = await startGrantAuthFlowWithConfig({
  capabilities: "/pub/my-app.example/:rw",
  clientId: "my-app.example",
  // homeserver: "<z32>", signupToken: "...",  // presence of homeserver selects signup
});
if (started.isErr()) throw started.error;
const { authorizationUrl } = started.value; // show as QR / deeplink

// Persist the state (SENSITIVE: contains clientKeySecret) so the flow survives an app kill
const saved = await saveGrantAuthFlow();
if (saved.isErr()) throw saved.error;
const state: GrantAuthFlowState = saved.value; // store in Keychain/Keystore, not AsyncStorage

// ...after relaunch:
const restored = await restoreGrantAuthFlow(state);
if (restored.isErr()) throw restored.error;

// Poll instead of awaitGrantAuthFlow when you need save/cancel
async function pollUntilApproved(): Promise<GrantSessionInfo | undefined> {
  for (let i = 0; i < 60; i++) {
    const res = await pollGrantAuthFlow();
    if (res.isErr()) throw res.error;
    if (res.value) return res.value; // approved: contains grant_secret
    await new Promise((r) => setTimeout(r, 2000));
  }
  await cancelGrantAuthFlow(); // user gave up
  return undefined;
}
```

## List and revoke grants

`listGrants(sessionSecret)` returns `GrantInfo[]`. `revokeGrant(sessionSecret, grantId)` returns `'Grant revoked'`. Both exist since 0.14.1. `listGrants` needs a session with the **root capability**. Leave your own `grant_id` out of what you revoke, or you revoke the session you are managing with ([list and revoke](../../pubky/references/auth.md#list-and-revoke-grants)).

The README example (README.md:461-488) with a type annotation added. Type-checked against 0.15.0, not run.

```react-native
import { listGrants, revokeGrant, type GrantSessionInfo } from "@synonymdev/react-native-pubky";

async function revokeAnotherGrant(managementSession: GrantSessionInfo) {
  const grantsRes = await listGrants(managementSession.grant_secret);
  if (grantsRes.isErr()) {
    console.log(grantsRes.error.message);
    return;
  }

  const grantToRevoke = grantsRes.value.find(
    (grant) => grant.grant_id !== managementSession.grant_id
  );

  if (!grantToRevoke) {
    return;
  }

  const revokeRes = await revokeGrant(
    managementSession.grant_secret,
    grantToRevoke.grant_id
  );
  if (revokeRes.isErr()) {
    console.log(revokeRes.error.message);
    return;
  }
  console.log(revokeRes.value);
}
```

## Session types

The full definitions are in [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c/src/index.tsx). Field names as of 0.15.0:

| Type | Fields |
| :-- | :-- |
| `GrantSessionInfo` (`SessionInfo` is an alias) | `homeserver`, `pubky`, `client_id`, `capabilities: string[]`, `grant_id`, `token_expires_at`, `grant_expires_at`, `created_at`, `grant_secret` |
| `CookieSessionInfo` (legacy) | `pubky`, `capabilities: string[]`, `session_secret` |
| `GrantInfo` (from `listGrants`) | `grant_id`, `client_id`, `capabilities: string`, `issued_at`, `expires_at` |

- `homeserver` and `pubky` are **bare z32**. Timestamps are JSON **numbers**.
- `GrantInfo.capabilities` is a **string**, but `GrantSessionInfo.capabilities` is a `string[]`.

## Homeserver and session methods

| Signature | Returns (`.value`) | Notes |
| :-- | :-- | :-- |
| `signUp(secretKey, homeserver, signupToken: string \| undefined, clientId)` | `SessionInfo` | `signupToken` is a **required positional argument**: pass `undefined` (`''` is mapped to `undefined`). `homeserver` accepts bare z32, `pubky<z32>` or `pubky://<z32>`. An invalid key returns `err('Invalid homeserver public key: …')`. The call signs up and then signs in. If you get `err('signup succeeded but sign in failed: …')`, **the account exists**, so retry `signIn`, not `signUp`. |
| `signIn(secretKey, clientId)` | `SessionInfo` | — |
| `signInGrantBlocking(secretKey, clientId)` | `GrantSessionInfo` | Waits until the homeserver PKDNS (`_pubky`) record is fully published before returning, which adds about 3–5 s. Use it when the identity must be discoverable immediately, such as first-time setup. For interactive apps, prefer `signIn` ([`signin_blocking`](https://docs.rs/pubky/0.16.1/pubky/struct.PubkySigner.html#method.signin_blocking)). |
| `signOut(sessionSecret)` | `'Sign out success'` | Pass a session secret, never the account secret key |
| `revalidateSession(sessionSecret)` | `SessionInfo \| CookieSessionInfo` | For the error handling, see [above](#grant-auth-via-ring-no-secret-key) |
| `republishHomeserver(secretKey, homeserver)` | `string` | Republishes the user's homeserver record |
| `getHomeserver(pubky)` | `string` | The homeserver's **bare z32 public key, not a URL**. With no record, it returns `err('No homeserver found for this public key')`. |
| `getSignupToken(homeserverPubky, adminPassword)` | `string` | **Don't use it.** It is probably non-functional (not verified at runtime). It sends a plain, non-PKARR `GET https://{homeserverPubky}/admin/generate_signup_token`, but a z32 host doesn't resolve through DNS, and current homeservers serve admin endpoints on a separate listener. **Never ship an admin password in a mobile app.** Operators use the [admin API](../../pubky-infra/references/homeserver.md#admin-api-6288). |

## Client configuration

New in 0.15. `configureClient(config: PubkyClientConfig)` rebuilds the shared native client. Its fields are `useTestnet?` (the wrapper defaults it to `false`), `testnetHost?` (takes precedence over `useTestnet`), `requestTimeoutMs?`, `readTimeoutMs?`, `poolMaxIdlePerHost?`, `maxErrorBodyBytes?` and `userAgentExtra?`.

- **Each call starts from a fresh client builder.** Any field you leave out (network, timeouts, user agent) resets to its default. For example, `configureClient({ requestTimeoutMs })` on its own switches a testnet client back to mainnet. Pass the full config on every call.
- `switchNetwork(useTestnet)` also rebuilds the client, but it returns the raw native array without checking it (see [runtime values](#runtime-values-vs-typescript-types)). Prefer `configureClient`.

Written for this page. Type-checked against 0.15.0, not run.

```react-native
import { configureClient } from "@synonymdev/react-native-pubky";

// Call before other Pubky calls; it rebuilds the shared native client.
const cfg = await configureClient({ useTestnet: true, testnetHost: "localhost", requestTimeoutMs: 10_000 });
if (cfg.isErr()) throw cfg.error;
```

On a device or emulator, `localhost` is the device itself, not your dev machine. Use a host the device can reach.

## Key management

From the former KB snippet [`key-management.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/react-native/src/key-management.ts). CI type-checked it there against 0.14.0 before it was deleted. Re-type-checked against 0.15.0, not run.

```react-native
import {
  generateSecretKey,
  getPublicKeyFromSecretKey,
  createRecoveryFile,
  decryptRecoveryFile,
} from "@synonymdev/react-native-pubky";

// Generate new key pair
const keyRes = await generateSecretKey();
if (keyRes.isErr()) throw keyRes.error;
const secretKey = keyRes.value.secret_key;

// Derive public key
const pubKeyRes = await getPublicKeyFromSecretKey(secretKey);
if (pubKeyRes.isErr()) throw pubKeyRes.error;
const publicKey = pubKeyRes.value.public_key;

// Create encrypted recovery file
const recoveryRes = await createRecoveryFile(secretKey, "passphrase");
if (recoveryRes.isErr()) throw recoveryRes.error;
const recoveryFile = recoveryRes.value; // Base64 encoded

// Decrypt recovery file
const decryptRes = await decryptRecoveryFile(recoveryFile, "passphrase");
if (decryptRes.isErr()) throw decryptRes.error;
const recoveredKey = decryptRes.value;
```

- Return values: `generateSecretKey()` → `{ secret_key, public_key, uri }`; `getPublicKeyFromSecretKey(sk)` → `{ public_key, uri }`; `createRecoveryFile(sk, passphrase)` → a base64 string; `decryptRecoveryFile(file, passphrase)` → the secret key string.
- `public_key` is **bare z-base-32**. The FFI uses `.z32()` because `PublicKey::to_string()` prepends `pubky`, which `pubky://` URLs reject. RN receives plain strings, with **no** `.toString()` / `.z32()` methods ([formats](../../pubky/references/concepts.md#public-key-string-formats)).
- BIP39 helpers (exported but missing from the README list): `generateMnemonicPhrase()` → `string`; `mnemonicPhraseToKeypair(phrase)` → `IGenerateSecretKey`; `generateMnemonicPhraseAndKeypair()` → `IMnemonicKeypair` (adds `.mnemonic`); `validateMnemonicPhrase(phrase)` → `boolean`.
- Every `generateSecretKey()` call also starts another placeholder event loop that never ends (see [Legacy event listener](#legacy-event-listener-is-a-placeholder)).
- Recovery files are a **local** backup primitive only. There is no restore-from-cloud, cloud backup or backup sync ([backup guardrail](../../pubky/references/shipped-vs-planned.md#backup-restore-and-mirroring)).

## Data operations

### Legacy string ops (`/pub` only)

Adapted from the README examples for `signUp`, `put`, `get`, `list` and `deleteFile`. Type-checked against 0.15.0, not run.

```react-native
import {
  generateSecretKey,
  signUp,
  put,
  get,
  list,
  deleteFile,
} from "@synonymdev/react-native-pubky";

const CLIENT_ID = "my-app.example";
const HOMESERVER = "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo";

const keyRes = await generateSecretKey();
if (keyRes.isErr()) throw keyRes.error;
const { secret_key, public_key } = keyRes.value; // public_key is bare z32

// signupToken is positional: pass undefined when the homeserver is not gated
const signUpRes = await signUp(secret_key, HOMESERVER, undefined, CLIENT_ID);
if (signUpRes.isErr()) throw signUpRes.error;

const url = `pubky://${public_key}/pub/my-app.example/profile.json`;

// put: pass a JS object; the wrapper JSON.stringifies it (do NOT pre-stringify)
const putRes = await put(url, { name: "Alice" }, secret_key, CLIENT_ID);
if (putRes.isErr()) throw putRes.error;

// get: raw native string, not parsed
const getRes = await get(url);
if (getRes.isErr()) throw getRes.error;
const raw = getRes.value;
const data = raw.startsWith("base64:")
  ? null // binary: base64-decode raw.slice("base64:".length) yourself
  : JSON.parse(raw);

// list: directory listing, array of pubky:// URLs
const listRes = await list(`pubky://${public_key}/pub/my-app.example/`);
if (listRes.isErr()) throw listRes.error;
const urls: string[] = listRes.value;

const delRes = await deleteFile(url, secret_key, CLIENT_ID);
if (delRes.isErr()) throw delRes.error;
```

| Method | Content / args | Gotcha |
| :-- | :-- | :-- |
| `put(url, content: Object, secretKey, clientId)` | An object, which the wrapper stringifies | **Every call runs a full `signin(clientId)` and creates a new grant.** For repeated writes, sign in once and then use `putWithSession` or `sessionPutBytes`. |
| `putWithSession(url, content: string, sessionSecret)` | A **pre-stringified** string, passed through unchanged | Passing an object here, or a pre-stringified string to `put`, breaks or double-encodes the data |
| `deleteFile(url, secretKey, clientId)` | — | The export is `deleteFile`, **not** `delete`. Like `put`, it signs in on every call. |
| `deleteWithSession(url, sessionSecret)` | — | — |
| `get(url)` | — | An unauthenticated public read. Returns UTF-8 text, or `'base64:<std base64>'` for bytes that aren't valid UTF-8. The result is **not** JSON-parsed. |
| `list(url)` | — | An unauthenticated public listing. Appends a trailing `/`. Takes no pagination options. |

- **Write and delete URLs must contain `/pub/`**, or the call returns `err('Invalid URL: must contain /pub/')`. A trailing `/` is stripped, and everything from `/pub/` onwards becomes the path.
- **`putWithSession` and `deleteWithSession` don't check which pubky the URL names** (inferred from source). The write lands in the **session owner's** `/pub` path even if the URL names another user. Build the URL from the session's own `pubky`, or use `sessionPutBytes` / `sessionDelete`, which reject a mismatch with a `validation` error (`'addressed resource belongs to a different Pubky'`).
- For `pubky.app` data, take paths and shapes from [`app-specs.md`](../../pubky/references/app-specs.md). The `/pub` layout is not stabilized.

### Binary storage APIs (0.15)

| Function | Returns (`.value`) |
| :-- | :-- |
| `publicGetBytes(address)` | `Base64Data` |
| `publicExists(address)` | `boolean` |
| `publicStats(address)` | `StorageResourceStats \| null`: `{ contentLength?, contentType?, lastModifiedMs?, etag? }` |
| `publicList(address, { reverse?, shallow?, limit?, cursor? })` | `{ entries: string[], nextCursor? }` |
| `sessionGetBytes` / `sessionExists` / `sessionStats` / `sessionList(pathOrAddress, sessionSecret, options)` | Same as the `public*` versions, but authenticated |
| `sessionPutBytes(pathOrAddress, content: Base64Data, sessionSecret)` | `void` |
| `sessionDelete(pathOrAddress, sessionSecret)` | `void` |

- `public*` functions need no auth. `session*` functions take a grant or cookie secret.
- `pathOrAddress` is either an absolute path starting with `/`, resolved against the session owner, **or** a `pubky://` address, which must belong to the session owner.
- **Bridge encodings:** binary values are standard **padded base64** strings (`type Base64Data = string`). Unsigned 64-bit values (`contentLength`, `lastModifiedMs`, the event `cursor`, the lock `timeoutSeconds`, custom-proof timestamps) are **decimal strings** (`UInt64String`). Compare or convert them with `BigInt`, not `Number`. RN has no `Buffer` by default, so do the base64 encoding and decoding yourself.
- **Pagination gotchas:**
  - The FFI sets `nextCursor` to the last entry of **every non-empty page**, even when there is no more data. Never loop on `nextCursor` alone.
  - The homeserver caps each page at `min(limit, 1000)` by default, but the bridge accepts any UInt16 `limit` up to 65535 (non-integers are rejected). **Keep `limit` ≤ 1000** and stop when `entries.length < limit`. If `limit` might exceed the server's cap, stop only on an empty page.

Written for this page. Type-checked against 0.15.0 (re-checked after widening the re-auth branches), not run. The mapping of a 404 to `kind 'server', status 404` is an assumption that was not verified at runtime.

```react-native
import {
  sessionPutBytes,
  publicGetBytes,
  publicList,
  PubkyError,
  type Base64Data,
} from "@synonymdev/react-native-pubky";

declare const grantSecret: string;
declare const userZ32: string;

const content: Base64Data = "SGVsbG8="; // "Hello", standard padded base64
const put = await sessionPutBytes("/pub/my-app.example/hello.txt", content, grantSecret);
if (put.isErr()) throw put.error;

const read = await publicGetBytes(`pubky://${userZ32}/pub/my-app.example/hello.txt`);
if (read.isErr()) {
  const e = read.error;
  if (e instanceof PubkyError) {
    if (e.kind === "server" && e.status === 404) { /* not found */ }
    // Re-auth on ANY authentication error: an expired grant has expired === false
    if (e.kind === "authentication") { /* re-auth */ }
    if (e.kind === "server" && (e.status === 401 || e.status === 403)) { /* re-auth */ }
    if (e.kind === "pkarr" && e.retryable) { /* retry later */ }
  }
} else {
  const b64: Base64Data = read.value; // decode base64 yourself
}

// Paginate a listing. Keep limit <= 1000 (default homeserver cap).
const LIMIT = 100;
let cursor: string | undefined;
for (;;) {
  const page = await publicList(`pubky://${userZ32}/pub/my-app.example/`, { limit: LIMIT, cursor });
  if (page.isErr()) throw page.error;
  const { entries, nextCursor } = page.value; // entries are pubky:// URLs
  if (entries.length < LIMIT || !nextCursor) break;
  cursor = nextCursor;
}
```

### `/priv` (alpha; code-presence only)

The `session*` byte APIs, storage locks and `startEventStream` (when given a `sessionSecret`) accept `/priv/...` paths. The package's tests use `/priv` only in Grant-flow capability scopes and the encryption-key APIs, not in `session*`, lock or event-stream calls. Of the data APIs, only the legacy `put`, `putWithSession`, `deleteFile` and `deleteWithSession` are `/pub`-only. Accepting a path is not a support claim. **`/priv` is alpha (pubky-homeserver v0.10.0+) and not for production. It is access-controlled but not encrypted, so the operator can read it, and there is no backup tool.** Read [`/priv` private storage (alpha)](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha) before you use it.

## Storage locks (0.15)

WebDAV locks, authenticated with a session secret:

| Function | Returns (`.value`) |
| :-- | :-- |
| `acquireStorageLock(pathOrAddress, sessionSecret, timeoutSeconds)` | `StorageLockInfo { id, path, token, timeoutSeconds }` (`timeoutSeconds` is a decimal string) |
| `refreshStorageLock(lockId, timeoutSeconds)` | `StorageLockInfo` (the refreshed lock) |
| `putWithStorageLock(lockId, content: Base64Data)` | — |
| `deleteWithStorageLock(lockId)` | — |
| `releaseStorageLock(lockId)` | — |

- **Releasing consumes the local handle even if the server-side unlock fails.** You can't retry with that `lockId`, and the server lock can stay active until it times out. Keep `timeoutSeconds` short.
- Lock handles live in native bridge memory and are **destroyed when the bridge is invalidated** (a JS reload).

Written for this page. Type-checked against 0.15.0, not run.

```react-native
import {
  acquireStorageLock,
  putWithStorageLock,
  releaseStorageLock,
} from "@synonymdev/react-native-pubky";

declare const grantSecret: string;

const lock = await acquireStorageLock("/pub/my-app.example/doc.json", grantSecret, 30);
if (lock.isErr()) throw lock.error;
try {
  const w = await putWithStorageLock(lock.value.id, "e30="); // "{}"
  if (w.isErr()) throw w.error;
} finally {
  await releaseStorageLock(lock.value.id); // handle is consumed even if unlock fails
}
```

## Homeserver event streams (0.15)

`startEventStream(config, { onEvent, onError?, onComplete? })` returns `EventStreamSubscription { id, remove(): Promise<Result<boolean>> }`.

- **Config:** `users: { publicKey, cursor? }[]` (at least one), plus `homeserver?`, `paths?`, `limit?`, `maxEventBytes?`, `live?`, `reverse?` and `sessionSecret?`. `sessionSecret` is required for any `/priv` path (see [the `/priv` guardrail](#priv-alpha-code-presence-only)).
- The wrapper defaults to `paths: []`, `live: false` and `reverse: false`. **Without `live: true`, the stream replays history and then calls `onComplete`.**
- **Each event** is `{ eventType: 'PUT' | 'DEL', resource /* pubky:// URL */, cursor /* decimal string */, contentHash /* hex or null */ }`. Persist `cursor`, then pass it back in `users[].cursor` to resume.
- **`onError` always receives a `PubkyError` with `kind: 'transport'` and `operation: 'startEventStream'`**, built from a message alone. It has no `status`, `expired` or `retryable`, so don't branch on those inside `onError`.
- After an error or on completion, the JS listeners are removed and the native stream stops automatically. Streams also stop when the bridge is invalidated (a JS reload).
- `stopEventStream(id)` returns a `boolean`. `stopAllEventStreams()` returns the count of stopped streams as a decimal string.

Written for this page. Type-checked against 0.15.0, not run.

```react-native
import { startEventStream, stopAllEventStreams } from "@synonymdev/react-native-pubky";

declare const userZ32: string;

const sub = await startEventStream(
  { users: [{ publicKey: userZ32 }], paths: ["/pub/my-app.example/"], live: true },
  {
    onEvent: (ev) => console.log(ev.eventType, ev.resource, ev.cursor), // cursor is a decimal string
    onError: (err) => console.warn(err.message),
    onComplete: () => {},
  },
);
if (sub.isErr()) throw sub.error;
// later, e.g. on unmount:
await sub.value.remove();
await stopAllEventStreams();
```

### Legacy event listener is a placeholder

`setEventListener` and `removeEventListener` (event name `'PubkyEvent'`) do **not** deliver homeserver events. Don't build on them.

- The native loop only emits `'Internal event triggered'` every 2 seconds, and every `generateSecretKey()` call starts another loop that never ends.
- Since 0.14.0, `removeEventListener` also calls the native `removeEventListener`, which turns the loop's notifications into no-ops. The loops themselves keep running.
- Details: [native-ffi](./native-ffi.md#event-streams-typed). For real events, use `startEventStream`.

## Custom grant proofs and scoped encryption keys

New in 0.15 (the Grant features of pubky 0.16):

| Function | Returns (`.value`) |
| :-- | :-- |
| `createCustomGrantProof(sessionSecret, data: JsonValue)` | `{ grant, proof }`. Made locally with the grant's proof-of-possession key, with no homeserver call. |
| `verifyCustomGrantProof(proof, clockSkewSeconds = 30)` | `{ identity, clientId, clientPublicKey, grantId, capabilities, grantIssuedAt, grantExpiresAt, proofIssuedAt, nonce, data }` (timestamps are decimal strings). Verification is **offline**. |
| `grantEncryptionKeyScopes(sessionSecret)` | `string[] \| null`. `null` means a legacy bare grant. `[]` means a signed approval with no keys. |
| `deriveGrantEncryptionKey(sessionSecret, path)` | A 32-byte key as base64. Returns `null` for a legacy bare grant, and a `validation` error for a path outside the approved scopes. |
| `grantSignedApproval(sessionSecret)` | `string \| null`. A confidential signed approval, so treat it as a secret. |

- **`verifyCustomGrantProof` does not check freshness or replay.** Upstream says: "The caller remains responsible for application-level freshness and replay checks." Check `nonce` and `proofIssuedAt` yourself.
- To receive encryption keys, call `startGrantAuthFlowWithConfig` with `approvalFormat: 'signedApprovalV1'` and request the `e` action (for example `/pub/chat/:rwe`). Upstream warns that **keys are permanent**: revoking or expiring the grant doesn't take them back, and there is no key rotation. It also warns that **older homeservers reject grants that contain `e`**. Details: [scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).
- **These APIs only deliver keys.** Pubky has no encrypted storage primitive, so the app must do its own encryption with a vetted library ([app-side ciphertext](../../pubky/references/shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto)).

## Authenticator side

For a Ring-like app that holds the user's key ([authenticator side](../../pubky/references/auth.md#authenticator-side-approving-requests)):

| Function | Returns (`.value`) / notes |
| :-- | :-- |
| `parseDeepLink(url)` | `PubkyDeepLinkDetails`, with scheme `'pubkyauth' \| 'pubkyring'` and kind `'signin' \| 'signup' \| 'direct_signup' \| 'signin_grant' \| 'signup_grant' \| 'secret_export'` ([deeplinks](./ring-auth.md#deeplink-schemes-and-intents)) |
| `parseAuthUrl(url)` | `PubkyAuthDetails`, which now includes `approval_format` (`'bare_grant' \| 'signed_approval_v1'`) and `ephemeral_public_key` (`epk`). `secret` is **optional**, because signed-approval links carry an HPKE public key instead. |
| `auth(url, secretKey)` | Approves **all** requested capabilities. Returns `'Authorization success'` (typed `string[]`). |
| `authWithCapabilities(url, secretKey, approvedCapabilities)` | Approves a subset, given as comma-separated `scope:actions`. `''` approves with no capabilities. The native side rejects any selection outside the request. |

Show the user what they are approving, and prefer `authWithCapabilities` so they can narrow it.

## PKARR publish and resolve

| Signature | Returns (`.value`) |
| :-- | :-- |
| `publish(recordName, recordContent, secretKey)` | The signer's z32 key (one string). Publishes a TXT record with TTL 30. |
| `publishHttps(recordName, target, secretKey)` | The signer's z32 key (one string). Publishes an HTTPS record. |
| `resolve(publicKey)` | `IDNSPacket { signed_packet, public_key, signature, timestamp, last_seen, dns_packet, records: ITxt[] }`, resolved with the `CacheFirst` policy |
| `resolveHttps(publicKey)` | `{ public_key, https_records: { name, class, ttl, priority, target, port?, alpn? }[] }` |

**Footgun (inferred from source):** `publish` and `publishHttps` sign a **new packet that holds only that one record**. Under a user's identity key, this replaces their whole PKARR packet, including the `_pubky` homeserver record, and **breaks homeserver discovery** until `republishHomeserver` runs. Publish custom records under a separate keypair, or republish the homeserver afterwards ([pkarr caveats](./native-ffi.md#pkarr--dns-vector)).

From the former KB snippet [`resolve.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/bb7232d5e8ebebc61c55945bedc87d83d2d6bc26/snippets/react-native/src/resolve.ts), since deleted. The first comment is reworded, because the call returns records, not a URL. Re-type-checked against 0.15.0, not run. The key is a placeholder.

```react-native
import { resolveHttps } from "@synonymdev/react-native-pubky";

// Resolve a public key to its HTTPS records
const resolveRes = await resolveHttps(
  "z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty",
);

if (resolveRes.isOk()) {
  console.log(`HTTPS records: ${JSON.stringify(resolveRes.value)}`);
}
```

## README drift (0.15.0)

Trust `src/index.tsx` and the bridge files (`ios/Pubky.mm`, `android/.../PubkyModule.kt`) over the README:

- The method list names `delete` (the export is `deleteFile`) and `create_recovery_file` / `decrypt_recovery_file` (the exports are camelCase). It also describes `getHomeserver` as "Get homeserver URL", but it returns z32.
- The `awaitAuthApproval` heading says "Ring auth flow". It is a Grant flow.
- The method list omits `parseDeepLink`, the BIP39 helpers, `revalidateSession` and `setEventListener`.
- The `parseAuthUrl` example uses `capabilities=`, while the `auth` example uses `caps=`.
- The README byte example uses `'pubky://user/...'` as a placeholder. Substitute a z32 key.
- The "Local Installation" and example-homeserver steps refer to a stale `rust/pubky` layout.

## Shipped vs planned

Shipped, pre-1.0: `/pub` reads and writes, capability-scoped grant sessions, grant listing and revocation, resumable `pubkyauth` flows, PKARR publish and resolve, homeserver event streams, and local recovery files.

- **`/priv`** is reachable through the `session*`, lock and event-stream APIs, but it is **alpha, not for production, and not encrypted from the operator** ([guardrail](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha)).
- **Scoped encryption keys** are key delivery only, not encrypted storage.
- **There is no backup restore, cloud backup, two-way sync or homeserver mirroring.** Don't invent any of these.
- The `/pub` path layout is **not stabilized**, and app-specs are **v0.x**. See [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
