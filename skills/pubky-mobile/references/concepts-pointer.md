# Core concepts to mobile methods

Thin map from each shared Pubky protocol concept to the mobile call that implements it, and
the sibling file documenting its signature/response shape. Theory is **not** repeated here —
identity, the `pubkyauth` handshake, and the on-wire data contract live in the canonical
`pubky`-skill references (linked below).

Two SDKs sit over the same protocol spine:

- **React Native** — `@synonymdev/react-native-pubky` (v0.13.0), a thin JS wrapper over the
  native bindings, so its function names mirror the FFI exports.
- **UniFFI bindings** — `pubky-core-ffi` ("Pubky Core Mobile SDK", Swift / Kotlin / Python).

Functions are declared in Rust `snake_case` (`sign_up`, `delete_file`, `start_auth_flow`);
UniFFI renders them **lowerCamelCase** (`signUp`, `deleteFile`, `startAuthFlow`) in
Swift/Kotlin, and React Native exports those same lowerCamelCase JS names — so the single
method column below covers both bindings. Only the **call/response wrapper differs**: RN
returns `Result<T>` (check `isErr()`, read `.value`); FFI returns `Vec<String>` as
`[error, data]` where `error` is the string `"true"`/`"false"`. Detail in
[`./react-native.md`](./react-native.md) and [`./native-ffi.md`](./native-ffi.md).

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
| Ed25519 identity & keygen ([concepts.md → Identity](../../pubky/references/concepts.md)) | `generateSecretKey`, `getPublicKeyFromSecretKey`, `generateMnemonicPhrase`, `mnemonicPhraseToKeypair`, `generateMnemonicPhraseAndKeypair`, `validateMnemonicPhrase` | [`./native-ffi.md`](./native-ffi.md), [`./react-native.md`](./react-native.md) |
| Passphrase-encrypted recovery files ([concepts.md](../../pubky/references/concepts.md)) | `createRecoveryFile(secretKey, passphrase)`, `decryptRecoveryFile(recoveryFile, passphrase)` | [`./native-ffi.md`](./native-ffi.md), [`./react-native.md`](./react-native.md) |
| Homeserver signup / signin / session lifecycle ([concepts.md → homeserver](../../pubky/references/concepts.md), [auth.md](../../pubky/references/auth.md)) | `signUp(secretKey, homeserver, signupToken?)`, `signIn(secretKey)`, `signOut(sessionSecret)`, `revalidateSession(sessionSecret)`, `getSignupToken(homeserverPubky, adminPassword)`, `republishHomeserver(secretKey, homeserver)` | `signUp`'s `signupToken` is optional (`null` for open/testnet homeservers). [`./native-ffi.md`](./native-ffi.md) |
| Write/read **own** `/pub` data with the identity key ([concepts.md → homeserver-write](../../pubky/references/concepts.md)) | `put(url, content, secretKey)`, `get(url)`, `list(url)`, `deleteFile(url, secretKey)` | Delete is `deleteFile`, **not** `delete` (FFI `delete_file`). [`./native-ffi.md`](./native-ffi.md), [`./react-native.md`](./react-native.md) |
| Act as the **signed-in user** via a session (after a Ring auth flow) | `putWithSession(url, content, sessionSecret)`, `deleteWithSession(url, sessionSecret)` | Take the `<z32>:<cookie>` session secret from the auth flow, not a raw secret key. [`./ring-auth.md`](./ring-auth.md), [`./native-ffi.md`](./native-ffi.md) |
| Public read of **another** user's `/pub` data ([concepts.md → public read](../../pubky/references/concepts.md)) | `get(url)` called unauthenticated on a `pubky://<pk>/pub/…` URL | No separate `publicStorage` object on mobile — an unauthenticated `get` *is* the public GET. |
| PKARR resolution & homeserver discovery ([concepts.md → PKARR](../../pubky/references/concepts.md)) | `resolve(publicKey)`, `getHomeserver(pubky)`, `republishHomeserver(secretKey, homeserver)`, `publish(recordName, recordContent, secretKey)`, `publishHttps(recordName, target, secretKey)`, `resolveHttps(publicKey)` | [`./native-ffi.md`](./native-ffi.md), [`./react-native.md`](./react-native.md) |
| `pubkyauth` — **requesting app** side ([auth.md](../../pubky/references/auth.md), [ring-auth.md](./ring-auth.md)) | `startAuthFlow(capabilities)` → `pubkyauth://` URL to show the user; `awaitAuthApproval()` blocks until approval | Returns a `session_secret` — feed it to the `*WithSession` calls above. [`./ring-auth.md`](./ring-auth.md) |
| `pubkyauth` — **authenticator / Ring** side (holds the key, approves) | `auth(pubkyauthUrl, secretKey)` sends the AuthToken to the relay; `parseAuthUrl(url)` decodes a `pubkyauth://` URL | [`./ring-auth.md`](./ring-auth.md) |
| Homeserver event streams ([concepts.md → event streams](../../pubky/references/concepts.md)) | `setEventListener`, `removeEventListener` | [`./native-ffi.md`](./native-ffi.md) |
| Testnet vs mainnet selection ([concepts.md → Clients](../../pubky/references/concepts.md)) | `switchNetwork(useTestnet)` | **FFI only.** React Native v0.13.0 does **not** export `switchNetwork` — do not call it from RN. |

> The react-native-pubky README's "Implemented Methods" list is stale: it shows `delete` and
> `session`, but the actual exports in `src/index.tsx` are `deleteFile` and
> `revalidateSession`. Use the names in this table.

## Not on the mobile surface

- **No Nexus client.** Neither SDK ships one. The mobile surface only does homeserver writes
  (`put` / `deleteFile` / `*WithSession`), direct public reads (`get`), PKARR
  (`resolve` / `publish` / `getHomeserver`), and the auth flow. Aggregated/social reads
  (feeds, tags, follows, search) must be fetched over plain HTTP against the hosted Nexus
  `/v0` REST API — see [`../../pubky/references/nexus-api.md`](../../pubky/references/nexus-api.md),
  not a mobile method.
- **No pubky-app-specs binding.** There is no model/validation object on mobile. Construct
  and validate the JSON yourself per
  [`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md), then write it
  with `put` to e.g. `pubky://<pk>/pub/pubky.app/profile.json`. `react-native-pubky` has no
  `pubky-app-specs` dependency.
