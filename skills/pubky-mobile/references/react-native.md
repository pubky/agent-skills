# React Native client (`@synonymdev/react-native-pubky`)

`@synonymdev/react-native-pubky` is the React Native bridge to [`pubky-core-ffi`](./native-ffi.md). This page covers the JS method surface (auth and Ring, the homeserver lifecycle, keys, `pubky://` data ops, PKARR) and the RN-specific pitfalls. Shared material is linked, not repeated:

- Identity, `pubky://` addressing, the `/pub` tree, PKARR, the homeserver model: [`concepts.md`](../../pubky/references/concepts.md) ([key formats](../../pubky/references/concepts.md#public-key-string-formats), [PKARR](../../pubky/references/concepts.md#pkarr-resolution)).
- The `pubkyauth` handshake, capability grammar, relays, signup tokens, recovery files: [`auth.md`](../../pubky/references/auth.md).
- On-wire data shapes (profile, posts, tags, paths, IDs): [`app-specs.md`](../../pubky/references/app-specs.md).
- Grant vs cookie secret formats, the native `[error, data]` contract, Android rustls init: [`native-ffi.md`](./native-ffi.md) ([auth strategies](./native-ffi.md#auth-strategies-and-session-secrets)).
- Ring deeplinks, QR transport, x-callback, storing and revoking a `grant_secret`: [`ring-auth.md`](./ring-auth.md).

**Upstream sources of truth:** [npm](https://www.npmjs.com/package/@synonymdev/react-native-pubky) · [repo](https://github.com/pubky/react-native-pubky) · [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx) (typings) · [`example/src/App.tsx`](https://github.com/pubky/react-native-pubky/blob/main/example/src/App.tsx) · [README](https://github.com/pubky/react-native-pubky/blob/main/README.md). Checked against commit [`bf0b792`](https://github.com/pubky/react-native-pubky/tree/bf0b79253140) (0.14.0). If this page and your installed typings disagree, trust the typings.

**Snippet status:** every RN snippet below type-checks (`tsc --noEmit`, strict) against the published 0.14.0 package. **None were run**, because the native bridge (`NativeModules.Pubky`) cannot run under Node or against a local testnet.

## Version and breaking changes

- Latest published version: **0.14.0** (2026-08-31, "upgrade pubky native bindings to 0.10"). The previous version was 0.13.0. Runtime dependency: `@synonymdev/result` `^0.0.2`. Peer dependencies: `react` and `react-native` (`*`). The package is pre-1.0.
- **0.14.0 made grant auth the default. Code written for 0.13 does not compile against it:**
  - **`clientId` is required** on `signUp`, `signIn`, `put`, `deleteFile` and `startAuthFlow`.
  - In `signUp(secretKey, homeserver, signupToken, clientId)`, `signupToken` is a **required positional** parameter typed `string | undefined`. Pass `undefined` when you have no token.
  - `SessionInfo` is now `GrantSessionInfo` = `{ pubky, capabilities, grant_secret }`, with **no `session_secret`**.
- **Don't copy the `pubky-knowledge-base-v2` react-native snippets for auth or writes.** They are pinned to 0.13.0: `auth.ts`, `basic-usage.ts`, `data-ops.ts` and `social-profile.ts` leave out `clientId`. Only `key-management.ts` and `resolve.ts` still type-check against 0.14.0.
- The package has **no real JS tests**: `src/__tests__/index.test.tsx` contains only `it.todo`. What confidence there is comes from the example app and the `pubky-core-ffi` tests.

## Install and linking

```bash
npm install @synonymdev/react-native-pubky
```

- This is a **native module**: a legacy `NativeModules.Pubky` module, not a TurboModule, which also works through the New Architecture interop layer. It is not pure JS. npm 7+ also installs the `react` / `react-native` peer dependencies. On iOS, run `pod install`, then rebuild the app. **It does not work in Expo Go**, so use a dev client or the bare workflow.
- If the module is not linked, accessing it throws `LINKING_ERROR` ("doesn't seem to be linked… pod install… rebuilt… not using Expo Go"):
  - Inside a wrapper call, the `try/catch` turns the error into `err(message)`.
  - **Importing the package can still throw**, because `new NativeEventEmitter(Pubky)` runs at module load, outside any `try`.
- **Android rustls init runs automatically.** The `PubkyModule` constructor calls the idempotent `RustlsInit.ensure(...)`, so don't call it yourself. `Expect rustls-platform-verifier to be initialized` means the native module was never constructed ([mechanism](./native-ffi.md#mandatory-android-rustls-init)). iOS needs no init.

## The Result envelope

Every export is `async` and returns `Promise<Result<T>>` from `@synonymdev/result`.

- Wrappers **don't throw into the caller**. Native failures and JS exceptions both come back as `err(message)`.
- Check `res.isErr()` or `res.isOk()` **before** reading `res.value`. On an error, read `res.error.message`.
- A native call returns `[isError, payload]`. The wrapper returns `ok(payload)`, or `ok(JSON.parse(payload))` for JSON results ([contract](./native-ffi.md#the-error-data-convention)).
- Some TS return types are wrong. See [Runtime return values vs TypeScript types](#runtime-return-values-vs-typescript-types).

## Pick an auth path

| You are building… | Holds the user's secret key? | Use |
| :-- | :-- | :-- |
| A normal third-party app (almost everyone) | **Never** | `startAuthFlow(caps, clientId)`, then `awaitAuthApproval()`. Write with `putWithSession` / `deleteWithSession` using the `grant_secret`. |
| A key-owning app (it created the identity itself) | Yes | `signUp` / `signIn` return a `grant_secret`. Then use the `*WithSession` writes, or `put` / `deleteFile`. |
| An authenticator like Pubky Ring (rare) | Yes | `parseDeepLink(url)`, then `auth(url, secretKey)` |

- `signUp`, `signIn`, `startAuthFlow` and `awaitAuthApproval` are aliases for the `*Grant` functions. The `*Cookie` variants only mirror upstream, where cookie auth is **deprecated**. Don't use them in new code.
- `clientId` is validated natively. It must be non-empty and at most 253 characters, usually a domain such as `my-app.example`. Invalid input returns `err('Invalid client_id: …')`.
- **`grant_secret` is a bearer credential**, and it also contains the client's proof-of-possession private key.
  - Store it only in the Keychain or Keystore ([persisting a session](../../pubky/references/auth.md#persist-and-restore), [ring-auth](./ring-auth.md#store-and-revoke-the-grant_secret)).
  - The README and the example app `console.log` session values. **Don't copy that into production code.**

## Grant auth via Ring (no secret key)

Adapted from the 0.14.0 README examples for `startAuthFlow` / `awaitAuthApproval` / `putWithSession` and from the example app's `signOut` pattern. Type-checked, not run.

```react-native
import {
  startAuthFlow,
  awaitAuthApproval,
  putWithSession,
  revalidateSession,
  signOut,
} from "@synonymdev/react-native-pubky";

const CLIENT_ID = "my-app.example"; // non-empty, <= 253 chars, usually a domain

const startRes = await startAuthFlow("/pub/my-app.example/:rw", CLIENT_ID);
if (startRes.isErr()) throw startRes.error;
const authUrl = startRes.value; // present as QR / deeplink, see ring-auth.md

const approvalRes = await awaitAuthApproval(); // resolves once the user approves in Ring
if (approvalRes.isErr()) throw approvalRes.error;
const { pubky, grant_secret } = approvalRes.value; // pubky is bare z32; store grant_secret in Keychain/Keystore, never log it

// putWithSession takes an ALREADY-stringified string
const putRes = await putWithSession(
  `pubky://${pubky}/pub/my-app.example/settings.json`,
  JSON.stringify({ theme: "dark" }),
  grant_secret,
);
if (putRes.isErr()) throw putRes.error;

// Later, e.g. on app start. ANDROID ONLY in 0.14.0: not bridged on iOS (see below)
const checkRes = await revalidateSession(grant_secret);
if (checkRes.isErr()) {
  // Re-run the auth flow only if the message is
  // "Session is no longer valid (expired or invalidated)".
  // Other errors (network, or "...is not a function" on iOS) do NOT mean the grant is dead.
}

// Revoke this grant, then delete your stored copy
const outRes = await signOut(grant_secret);
if (outRes.isErr()) throw outRes.error;
```

- `startAuthFlow` / `startGrantAuthFlow` build a **sign-in** flow only. No signup flow is exposed.
- The pending flow lives in a **process-global slot**, so a second `startAuthFlow` overwrites the first.
- `awaitAuthApproval()` consumes the flow. Calling it with no flow started, or calling it twice, returns `err('No auth flow in progress')`.
- A bad capability string returns `err('Invalid capabilities: …')`. The grammar is in [auth.md](../../pubky/references/auth.md#capabilities).
- `signOut`, `revalidateSession`, `putWithSession` and `deleteWithSession` accept **either** a `grant_secret` or a legacy cookie `session_secret`. `revalidateSession` returns the session shape that matches the secret you pass. The secret format is opaque, so don't parse it ([native-ffi](./native-ffi.md#auth-strategies-and-session-secrets)).
- **`revalidateSession` is Android-only as shipped in 0.14.0.** `ios/Pubky.swift` implements it, but `ios/Pubky.mm` has no `RCT_EXTERN_METHOD` for it. On iOS the call therefore returns `err('…is not a function')` (inferred from the source, not verified at runtime). Never treat every `err` from it as an expired session, or iOS users will have to re-authenticate on every launch.

## Secret-key path and data operations

Adapted from the 0.14.0 README examples for `signUp` / `put` / `get` / `list` / `deleteFile`, using a generated key instead of hardcoded hex. Type-checked, not run.

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
| `put(url, content: Object, secretKey, clientId)` | An object, stringified for you | **Runs a full grant sign-in on every call**, so each write creates a new grant session. For repeated writes, sign in once and use `putWithSession`. |
| `putWithSession(url, content: string, sessionSecret)` | A **pre-stringified** string, passed as-is | Passing an object here, or a pre-stringified string to `put`, breaks or double-encodes the data |
| `deleteFile(url, secretKey, clientId)` | — | The export is `deleteFile`, **not** `delete`. Like `put`, it signs in on every call. |
| `deleteWithSession(url, sessionSecret)` | — | — |
| `get(url)` | — | Unauthenticated public read. Returns UTF-8 text or `base64:`-prefixed binary. It is **not** JSON-parsed. |
| `list(url)` | — | Unauthenticated public read. Appends a trailing `/`. The only op that JSON-parses into a real `string[]`. |

- **Write and delete URLs must contain `/pub/`.** Anything else returns `err('Invalid URL: must contain /pub/')`. Everything from `/pub/` onward becomes the path, with any trailing `/` trimmed.
- There are no `/priv` methods. See [Shipped vs planned](#shipped-vs-planned).
- For `pubky.app` data, take the paths and object shapes from [`app-specs.md`](../../pubky/references/app-specs.md). The `/pub` layout is not stabilized.

## Key management

**CI-verified in the KB** ([`key-management.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/snippets/react-native/src/key-management.ts), harness pinned to 0.13.0). The signatures are unchanged in 0.14.0, where it also type-checks.

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

- `generateSecretKey()` returns `{ secret_key, public_key, uri }`. `getPublicKeyFromSecretKey(sk)` returns `{ public_key, uri }`.
- `public_key` is **bare z-base-32**. The FFI uses `z32()` because `PublicKey::to_string()` prepends `pubky`, which `pubky://` URLs reject. RN only gets strings, with **no** `.toString()` / `.z32()` methods ([formats](../../pubky/references/concepts.md#public-key-string-formats)).
- These BIP39 helpers are exported but missing from the README's method list:
  - `generateMnemonicPhrase()` → `string`
  - `mnemonicPhraseToKeypair(phrase)` → `IGenerateSecretKey`
  - `generateMnemonicPhraseAndKeypair()` → the same, plus `.mnemonic`
  - `validateMnemonicPhrase(phrase)` → `boolean`
- Recovery files are only a **local** backup primitive. There is no restore-from-cloud or backup sync.

## Homeserver and session methods

| Signature | Returns (`.value`) | Notes |
| :-- | :-- | :-- |
| `signUp(secretKey, homeserver, signupToken \| undefined, clientId)` | `SessionInfo` | `homeserver` can be bare z32, `pubky<z32>` or `pubky://<z32>` |
| `signIn(secretKey, clientId)` | `SessionInfo` | — |
| `signOut(sessionSecret)` | `string` | Pass a grant or cookie **session secret**, never the account secret key |
| `revalidateSession(sessionSecret)` | `SessionInfo \| CookieSessionInfo` | The shape matches the secret you pass. **Android only in 0.14.0.** It is not bridged in `ios/Pubky.mm`, so on iOS it returns `err`. |
| `republishHomeserver(secretKey, homeserver)` | `string` | Republishes the homeserver record to the DHT |
| `getHomeserver(pubky)` | `string` | Returns the homeserver's **bare z32 public key, not a URL**. Returns `err('No homeserver found for this public key')` when there is none. |
| `getSignupToken(homeserverPubky, adminPassword)` | `string` | **Probably non-functional against current homeservers** (not verified at runtime). The FFI sends a plain, non-PKARR `GET https://{homeserverPubky}/admin/generate_signup_token`. A z32 host doesn't resolve through DNS, and current `pubky-homeserver` serves `/generate_signup_token` on its separate admin listener (default `127.0.0.1:6288`). Operators should use the [homeserver admin API](../../pubky-infra/references/homeserver.md#admin-api-6288) instead. |
| `parseAuthUrl(url)` / `parseDeepLink(url)` | `PubkyAuthDetails` / `PubkyDeepLinkDetails` | `parseDeepLink` also handles `pubkyring://` and the kinds `signin_grant`, `signup_grant`, `direct_signup` and `secret_export` ([ring-auth](./ring-auth.md#deeplink-schemes-and-intents)) |
| `auth(url, secretKey)` | `string` | Authenticator side: approves an incoming `pubkyauth` URL. Failure returns `err('Authorization failure: …')`. |

Session types in 0.14.0 (verbatim from `src/index.tsx`, type-checked):

```react-native
export interface GrantSessionInfo { pubky: string; capabilities: string[]; grant_secret: string; }
export interface CookieSessionInfo { pubky: string; capabilities: string[]; session_secret: string; }
export type SessionInfo = GrantSessionInfo;
```

In 0.14.0, `PubkyAuthDetails.kind` can also be `'signin_grant' | 'signup_grant'`. The type also gained `client_id` (`cid`), `client_public_key` (`cpk`) and `x_source` / `x_success` / `x_error` / `x_cancel`. `kind` is absent only with pre-0.9.1 native binaries. For the full shapes, see the [typings](https://github.com/pubky/react-native-pubky/blob/bf0b79253140/src/index.tsx#L92-L146).

## PKARR publish and resolve

| Signature | Returns (`.value`) |
| :-- | :-- |
| `publish(recordName, recordContent, secretKey)` | The signer's z32 public key as a string, despite the `string[]` type. Publishes a TXT record. |
| `publishHttps(recordName, target, secretKey)` | The signer's z32 public key as a string. Publishes an HTTPS record. |
| `resolve(publicKey)` | `IDNSPacket`: `{ signed_packet, public_key, signature, timestamp, last_seen, dns_packet, records: ITxt[] }`, resolved with the `CacheFirst` policy |
| `resolveHttps(publicKey)` | `IHttpsResolveResult`: `{ public_key, https_records: { name, class, ttl, priority, target, port?, alpn? }[] }` |

- `resolve` accepts bare z32 or a `pubky`-prefixed key.
- **A publish replaces the whole signed packet**, because the new packet contains only the one record. Read the [pkarr caveats](./native-ffi.md#pkarr--dns-blocking) before publishing under a user's identity key.

**CI-verified in the KB** ([`resolve.ts`](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/snippets/react-native/src/resolve.ts)) and type-checked against 0.14.0. The key is a placeholder.

```react-native
import { resolveHttps } from "@synonymdev/react-native-pubky";

// Resolve public key to HTTPS URL
const resolveRes = await resolveHttps(
  "z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty",
);

if (resolveRes.isOk()) {
  console.log(`HTTPS records: ${JSON.stringify(resolveRes.value)}`);
}
```

## Runtime return values vs TypeScript types

These functions are typed `Result<string[]>`, but the wrapper returns `ok(res[1])`, which is **a single string**. Treat `.value` as a string:

| Function | Actual `.value` |
| :-- | :-- |
| `put` | The trimmed URL that was written |
| `deleteFile` | `'Deleted successfully'` |
| `publish` / `publishHttps` | The signer's z32 public key |
| `auth` | `'Authorization success'` |

`list` is the only `string[]` function that returns a real, JSON-parsed array.

## Things that are not what they look like

- **`setEventListener` is not a homeserver event stream. Don't build on it.**
  - The native side only emits the placeholder `'Internal event triggered'` every 2 seconds.
  - `generateSecretKey()` starts that loop, and every call starts **another** loop that never stops.
  - `removeEventListener` only calls `removeAllListeners('PubkyEvent')`, because its native call is commented out.
  - Details: [native-ffi](./native-ffi.md#eventlistener-is-a-placeholder). RN exposes no homeserver event stream API.
- **You can't switch to testnet.** `switchNetwork` exists in the generated FFI bindings but is not exported from `src/index.tsx` or the bridge.
- **There is no `session` method.** `session:` was removed from the iOS bridge in 0.14.0. Use `getHomeserver` to look up a homeserver. For a session check, `revalidateSession` works **only on Android** in 0.14.0. On iOS nothing is bridged for this, because `ios/Pubky.mm` is missing `revalidateSession`.

## README drift

At 0.14.0 the README examples include `clientId` and pass session secrets to `signOut`. Remaining gaps:

- The "Implemented Methods" list says `delete` (the export is `deleteFile`), writes `create_recovery_file` / `decrypt_recovery_file` in snake_case, and describes `getHomeserver` as "Get homeserver URL", although it returns a bare z32 key.
- The list omits `parseDeepLink`, the BIP39 helpers, `revalidateSession` and `setEventListener` / `removeEventListener`.
- The `parseAuthUrl` example uses a `capabilities=` query parameter, while the `auth` example and the example app use `caps=`.

When the README and the code disagree, trust `src/index.tsx`, `example/src/App.tsx` and the platform bridge files (`ios/Pubky.mm`, `android/.../PubkyModule.kt`).

## Shipped vs planned

What RN exposes is shipped but pre-1.0:

- `/pub` reads and writes
- capability-scoped grant sessions
- PKARR publish/resolve
- resumable `pubkyauth` (`startAuthFlow` / `awaitAuthApproval`)
- local recovery files (create and decrypt)

What RN does **not** expose:

- **No `/priv` methods.** Writes require `/pub/`. Upstream, `/priv` exists only as an alpha feature (pubky-homeserver v0.10.0+): **not for production and not encrypted from the operator**.
- **No homeserver event stream.** `setEventListener` is a placeholder.
- **No backup restore, cloud backup or mirroring.** Don't invent any of these.

The `/pub` path layout is **not stabilized**, and app-specs are **v0.x**. See [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
