# Core concepts to mobile methods

Maps each Pubky protocol concept to the mobile method that implements it. The theory is in the `pubky` skill, linked in the left column. For signatures, response shapes, and platform setup, see [`react-native.md`](./react-native.md), [`native-ffi.md`](./native-ffi.md), and [`ring-auth.md`](./ring-auth.md).

## SDKs and conventions

| SDK | Pin | Wraps |
| :-- | :-- | :-- |
| React Native: [`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky) | `0.14.0` | the FFI below |
| UniFFI Swift/Kotlin: [`pubky-core-ffi`](https://github.com/pubky/pubky-core-ffi) (crate `pubkycore` 0.4.0) | Pin a commit SHA. The crate is not on crates.io and the repo has no tags. | `pubky` 0.10.0 |

- **Use the `pubky` 0.10 API** when you compare against web/Rust docs, not the latest [`pubky` crate](https://crates.io/crates/pubky).
- **Method names are the same across bindings.** Rust FFI uses `snake_case` (`delete_file`). Swift, Kotlin, and RN JS use `lowerCamelCase` (`deleteFile`). Swift adds argument labels, for example `signUp(secretKey:homeserver:signupToken:clientId:)`.
- **The response wrapper differs by SDK:**
  - **RN** returns `Promise<Result<T>>` and never throws. Check `isErr()` before you read `.value` ([react-native.md → The Result envelope](./react-native.md#the-result-envelope)).
  - **FFI** returns `[error, data]` strings, and `error` is the **string** `"true"` or `"false"`. The calls block, so keep them off the UI thread ([native-ffi.md → the `[error, data]` convention](./native-ffi.md#the-error-data-convention)).
- **Key formats:**
  - Outputs are **bare z32** with no `pubky` prefix, and `uri` fields use `pk:<z32>`.
  - Public-key *parameters* accept bare or prefixed keys.
  - Keys inside URLs must be raw z32 (`pubky://<z32>/…`). `pubky` 0.10 rejects `pubky://pubky<z32>/…`.
  - See [native-ffi.md → String Contracts](./native-ffi.md#string-contracts) and [concepts.md → Public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).
- **Android:** initialize rustls once, before any TLS call, or the first handshake panics ([native-ffi.md → MANDATORY: Android rustls init](./native-ffi.md#mandatory-android-rustls-init)). iOS needs no equivalent step.

## Concept-to-method map

| Concept (canonical theory) | Mobile method(s) | Gotcha |
| :-- | :-- | :-- |
| Ed25519 identity ([concepts.md](../../pubky/references/concepts.md#identity-the-ed25519-keypair)) | `generateSecretKey`, `getPublicKeyFromSecretKey`, `generateMnemonicPhrase`, `mnemonicPhraseToKeypair`, `generateMnemonicPhraseAndKeypair`, `validateMnemonicPhrase` | These are for authenticator-type apps only. Third-party apps must never ask for a mnemonic or secret key; use Ring ([concepts.md → Authentication](../../pubky/references/concepts.md#authentication)). |
| Recovery files ([auth.md](../../pubky/references/concepts.md#identity-the-ed25519-keypair)) | `createRecoveryFile(secretKey, passphrase)`, `decryptRecoveryFile(recoveryFile, passphrase)` | These only create and decrypt a local Base64 backup. Backup *restore* and cloud backup are planned, not shipped ([shipped-vs-planned.md](../../pubky/references/shipped-vs-planned.md#backup-restore-and-mirroring)). |
| `pubkyauth`, **requesting app** ([auth.md](../../pubky/references/auth.md#grant-auth-model), [capabilities](../../pubky/references/auth.md#capabilities)) | `startAuthFlow(capabilities, clientId)` returns a `pubkyauth://` URL. `awaitAuthApproval()` returns `{pubky, capabilities, grant_secret}`. | This is the primary path for third-party apps. Only one pending **grant** flow exists per process, so a new `startAuthFlow` replaces the old one. `awaitAuthApproval` consumes the flow: a second await without a new start returns an error. See [ring-auth.md](./ring-auth.md#two-roles-pick-the-right-one). |
| `pubkyauth`, **authenticator / Ring** ([auth.md](../../pubky/references/auth.md#authenticator-side-approving-requests)) | `auth(url, secretKey)`, `parseAuthUrl(url)`, `parseDeepLink(url)` | This is Ring's job; your app rarely needs it ([ring-auth.md → Deeplink schemes](./ring-auth.md#deeplink-schemes-and-intents)). |
| Homeserver signup/signin ([concepts.md](../../pubky/references/concepts.md#the-homeserver-model), [auth.md](../../pubky/references/auth.md#session-lifecycle)) | `signUp(secretKey, homeserver, signupToken, clientId)`, `signIn(secretKey, clientId)`. These are aliases of `signUpGrant`/`signInGrant`. | `homeserver` is a **public key**, not a `pubky://` URL. `clientId` is required. In Swift, `signupToken: String?` has no default, so pass `nil` explicitly. |
| Session lifecycle ([auth.md](../../pubky/references/auth.md#session-lifecycle), [persisting](../../pubky/references/auth.md#persist-and-restore)) | `revalidateSession(sessionSecret)`, `signOut(sessionSecret)` | These accept a grant's `grant_secret` or a legacy cookie `session_secret`. Both are bearer secrets: store them in Keychain/Keystore and never log them ([ring-auth.md](./ring-auth.md#store-and-revoke-the-grant_secret)). |
| Legacy cookie auth (deprecated in `pubky` 0.10) | `signUpCookie`, `signInCookie`, `startCookieAuthFlow`, `awaitCookieAuthApproval` | Don't use these in new code; use the grant methods above ([native-ffi.md](./native-ffi.md#auth-strategies-and-session-secrets)). |
| Signup tokens ([auth.md](../../pubky/references/auth.md#signup-tokens)) | `getSignupToken(homeserverPubky, adminPassword)` | **Don't rely on it** ([native-ffi.md](./native-ffi.md#homeserver-and-session-blocking)). It targets a route and host the current homeserver doesn't serve, and it doesn't check the HTTP status. It is operator/admin only: never ship the admin password in an end-user app. For the operator side, see [signup-gating.md](../../pubky-infra/references/signup-gating.md). |
| Write **own** `/pub` data ([concepts.md](../../pubky/references/concepts.md#own-data-vs-another-users-data), [addressing](../../pubky/references/concepts.md#addressing-and-the-pub-tree)) | Prefer `putWithSession(url, content, sessionSecret)` and `deleteWithSession(url, sessionSecret)`. Key-based: `put(url, content, secretKey, clientId)`, `deleteFile(url, secretKey, clientId)`. | The method is `deleteFile`, **not** `delete`. Writes always go to the *session's own* storage, and only the URL's `/pub/…` path counts: a URL with another user's key still writes your own `/pub`. Key-based calls sign in again on every call. RN `put` and `putWithSession` encode content differently ([react-native.md](./react-native.md#secret-key-path-and-data-operations)). You can't write `/priv` from mobile. |
| Public read of **anyone's** data ([concepts.md](../../pubky/references/concepts.md#own-data-vs-another-users-data)) | `get(url)`, `list(url)` | Both are always unauthenticated. `get` returns text, or `base64:<…>` for non-UTF-8 bytes. `list` returns `pubky://` URLs. |
| PKARR / discovery ([concepts.md](../../pubky/references/concepts.md#pkarr-resolution)) | `resolve`, `resolveHttps`, `getHomeserver(pubky)`, `republishHomeserver(secretKey, homeserver)`, `publish` (TXT), `publishHttps` (HTTPS/SVCB) | `getHomeserver` returns a bare z32 key, not a URL. **`publish` and `publishHttps` replace the whole signed packet**, so under a user's identity key they wipe the `_pubky` homeserver record ([native-ffi.md](./native-ffi.md#pkarr--dns-blocking)). |
| Testnet vs mainnet | `switchNetwork(useTestnet)` | **FFI only.** RN 0.14.0 doesn't expose it. |
| Homeserver event streams ([concepts.md](../../pubky/references/concepts.md#homeserver-write-vs-nexus-read)) | *(none)* | `setEventListener` and `removeEventListener` (FFI and the RN wrapper) are a placeholder timer, **not** an event stream ([native-ffi.md](./native-ffi.md#eventlistener-is-a-placeholder)). No mobile method exposes `/events-stream`. |

## Not on the mobile surface

- **No Nexus client.** Call Nexus `/v0` over plain HTTP ([nexus-api.md](../../pubky/references/nexus-api.md)). `/v0` is unstable and breaking-change-prone.
- **No pubky-app-specs binding.** Build and validate JSON yourself per [app-specs.md](../../pubky/references/app-specs.md#models), then write it with `putWithSession`. The specs are v0.x, the `/pub` layout is not stabilized, and `PubkyId` must be [raw z32](../../pubky/references/app-specs.md#pubkyid-raw-z32-only).

## Ground truth

The READMEs are stale: the RN README lists `delete`, and the FFI README examples omit `clientId`. Trust these sources, pinned to the reviewed commits:

- RN exports: [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/bf0b7925314031023db3ae47cdba12e23389c25e/src/index.tsx), [`example/src/App.tsx`](https://github.com/pubky/react-native-pubky/blob/bf0b7925314031023db3ae47cdba12e23389c25e/example/src/App.tsx)
- FFI exports: [`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd331c3c0a1e60fc02978d0588c396/src/lib.rs), [String Contracts](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd331c3c0a1e60fc02978d0588c396/README.md#string-contracts)
- README discrepancies: [react-native.md](./react-native.md#readme-drift)
