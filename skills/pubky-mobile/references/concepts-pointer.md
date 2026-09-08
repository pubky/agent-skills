# Core concepts to mobile methods

Thin map from each shared Pubky protocol concept to the mobile call that implements it. Theory
is **not** repeated here — identity, the `pubkyauth` handshake, and the on-wire data contract
live in the canonical `pubky`-skill references (linked below).

Two SDKs sit over the same protocol spine:

- **React Native** — `@synonymdev/react-native-pubky` (v0.13.0; sole runtime dep
  `@synonymdev/result`), a thin JS wrapper over the native bindings, so its function names mirror
  the FFI exports.
- **UniFFI bindings** — `pubky-core-ffi` (crate `pubkycore` v0.3.1, wrapping `pubky` 0.9.3;
  "Pubky mobile SDK", emits Swift / Kotlin / Python).

Functions are declared in Rust `snake_case` (`sign_up`, `delete_file`, `start_auth_flow`);
UniFFI renders them **lowerCamelCase** (`signUp`, `deleteFile`, `startAuthFlow`) in Swift/Kotlin
(Swift call sites add named labels, e.g. `signUp(secretKey:homeserver:signupToken:)`), and
React Native exports those same lowerCamelCase JS names — so the single method column below
covers both bindings. Only the **call/response wrapper differs**:

- **RN** returns `Promise<Result<T>>` (`@synonymdev/result`) — check `isErr()`, read `.value` on
  success / `.error` on failure.
- **FFI** returns a two-element `Vec<String>` `[error, data]` where `error` is the **string**
  `"true"`/`"false"` (`"true"` = failure and `data` is the message; `"false"` = success and
  `data` is the result, often JSON).

Per-method signatures and response shapes: [`./react-native.md`](./react-native.md) (RN) and
[`./native-ffi.md`](./native-ffi.md) (FFI); the auth flow is detailed in
[`./ring-auth.md`](./ring-auth.md).

## Canonical references (read these for the theory)

- Core model — homeserver-write vs Nexus-read split, own-vs-other, PKARR, `/pub` addressing:
  [`../../pubky/references/concepts.md`](../../pubky/references/concepts.md)
- `pubkyauth` handshake — capabilities, relay + secret, session lifecycle:
  [`../../pubky/references/auth.md`](../../pubky/references/auth.md)
- On-wire data contract — pubky-app-specs models, paths, IDs:
  [`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md)

## Concept-to-method map

| Pubky concept (canonical source) | Mobile method(s) | Signature / gotchas |
| :-- | :-- | :-- |
| Ed25519 identity & keygen ([concepts.md → Identity](../../pubky/references/concepts.md)) | `generateSecretKey`, `getPublicKeyFromSecretKey`, `generateMnemonicPhrase`, `mnemonicPhraseToKeypair`, `generateMnemonicPhraseAndKeypair`, `validateMnemonicPhrase` | Secret keys are 32-byte ed25519, hex-encoded; public keys come back as bare z32. |
| Passphrase-encrypted recovery files ([concepts.md](../../pubky/references/concepts.md)) | `createRecoveryFile(secretKey, passphrase)`, `decryptRecoveryFile(recoveryFile, passphrase)` | `createRecoveryFile` returns a Base64 string; the shipped local-backup primitive. |
| Homeserver signup / signin / session lifecycle ([concepts.md → homeserver](../../pubky/references/concepts.md), [auth.md](../../pubky/references/auth.md)) | `signUp(secretKey, homeserver, signupToken?)`, `signIn(secretKey)`, `signOut(sessionSecret)`, `revalidateSession(sessionSecret)`, `getSignupToken(homeserverPubky, adminPassword)`, `republishHomeserver(secretKey, homeserver)` | `homeserver` is a `pubky://<pk>` URL. `signupToken` is optional — omit/`null` for open/testnet homeservers, pass the string for gated ones. |
| Write/read **own** `/pub` data with the identity key ([concepts.md → homeserver-write](../../pubky/references/concepts.md)) | `put(url, content, secretKey)`, `get(url)`, `list(url)`, `deleteFile(url, secretKey)` | Delete is `deleteFile`, **not** `delete` (FFI `delete_file`). `put`/`deleteFile` (and the `*WithSession` variants) hard-error `"Invalid URL: must contain /pub/"` when the URL lacks `/pub/`; `get`/`list` route the URL straight to `public_storage` with no `/pub/` check and only succeed on `/pub/` paths — other paths fail with a `"Request failed"`-style error, not the `/pub/` message. |
| Act as the **signed-in user** via a session (after a Ring auth flow) | `putWithSession(url, content, sessionSecret)`, `deleteWithSession(url, sessionSecret)` | Preferred after a Ring flow; take the `<z32>:<cookie>` session secret, not a raw secret key. |
| Public read of **another** user's `/pub` data ([concepts.md → public read](../../pubky/references/concepts.md)) | `get(url)` / `list(url)` called unauthenticated on a `pubky://<pk>/pub/…` URL | No separate `publicStorage` object on mobile — `get`/`list` always route through `public_storage`, so an unauthenticated call *is* the public read. |
| PKARR resolution & homeserver discovery ([concepts.md → PKARR](../../pubky/references/concepts.md)) | `resolve(publicKey)`, `resolveHttps(publicKey)`, `getHomeserver(pubky)`, `republishHomeserver(secretKey, homeserver)`, `publish(recordName, recordContent, secretKey)`, `publishHttps(recordName, target, secretKey)` | `publish` = TXT (TTL 30s); `publishHttps` = HTTPS/SVCB (TTL 3600s); resolvers take a bare z32 key. |
| `pubkyauth` — **requesting app** side ([auth.md](../../pubky/references/auth.md), [ring-auth.md](./ring-auth.md)) | `startAuthFlow(capabilities)` → `pubkyauth://` URL to show the user; `awaitAuthApproval()` blocks until approval | Returns a `session_secret` — feed it to the `*WithSession` calls above. One flow at a time (process-global). |
| `pubkyauth` — **authenticator / Ring** side (holds the key, approves) ([ring-auth.md](./ring-auth.md)) | `auth(pubkyauthUrl, secretKey)` approves a third-party request; `parseAuthUrl(url)` decodes a `pubkyauth://` URL | — |
| Homeserver event streams ([concepts.md → event streams](../../pubky/references/concepts.md)) | `setEventListener`, `removeEventListener` | **Not a real subscription.** The FFI callback is a demo/placeholder that emits a fixed string every 2s — it is **not** a homeserver PUT/DEL feed. The actual event stream (`/events-stream` SSE, `/events/`) is **server-side** (see [`./native-ffi.md`](./native-ffi.md) and the `pubky-infra` skill), not a mobile method. |
| Testnet vs mainnet selection ([concepts.md → Clients](../../pubky/references/concepts.md)) | `switchNetwork(useTestnet)` | **FFI only**, synchronous (swaps the client, no I/O). React Native v0.13.0 does **not** export `switchNetwork` — do not call it from RN. |

> The react-native-pubky README's "Implemented Methods" list is stale: it names `delete` and
> `session`, but the actual exports in `src/index.tsx` are `deleteFile` and `revalidateSession`.
> Use the names in this table; trust `src/index.tsx` + `example/src/App.tsx` over the README.

## Not on the mobile surface

- **No Nexus client.** Neither SDK ships one. The mobile surface only does homeserver writes
  (`put` / `deleteFile` / `*WithSession`), direct public reads (`get` / `list`), PKARR
  (`resolve` / `publish` / `getHomeserver`), and the auth flow. Aggregated/social reads (feeds,
  tags, follows, search) must be fetched over plain HTTP against the hosted Nexus `/v0` REST API
  — see [`../../pubky/references/nexus-api.md`](../../pubky/references/nexus-api.md), not a mobile
  method. (`/v0` is unstable and breaking-change-prone.)
- **No pubky-app-specs binding.** There is no model/validation object on mobile (`react-native-pubky`
  has no `pubky-app-specs` dependency). Construct and validate the JSON yourself per
  [`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md) (v0.x; `/pub` layout
  not stabilized), then write it with `put` to e.g. `pubky://<pk>/pub/pubky.app/profile.json`.
