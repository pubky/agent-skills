# Pubky Ring integration

How a mobile app gets a capability-scoped **grant** through the **Pubky Ring** authenticator
without holding the user's key. Also covers Ring's deeplink, QR and animated-migrate-frame
parsing, and grant revocation. Ring-specific only; shared protocol is linked:

- **Relay + secret handshake, relays:** [`auth.md` § handshake](../../pubky/references/auth.md#grant-auth-model),
  [§ Relays](../../pubky/references/auth.md#relays). In grant flows the signer sends an
  encrypted, signed `pubky-grant` JWS instead of the legacy `AuthToken`.
- **Capability syntax** (and why to avoid root `/:rw`): [`auth.md` § Capabilities](../../pubky/references/auth.md#capabilities).
- **Identity, key string formats, homeserver model:** [`concepts.md`](../../pubky/references/concepts.md).
- **Full RN / FFI API surface, `Result`/`isErr()`:** [`react-native.md`](./react-native.md), [`native-ffi.md`](./native-ffi.md).

**Upstream (source of truth):**
[pubky-ring README](https://github.com/pubky/pubky-ring/blob/main/README.md) ·
[`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts) ·
[`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky)
([README](https://github.com/pubky/react-native-pubky/blob/main/README.md),
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)) ·
[pubky-homeserver `docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) ·
[grant-auth migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md).

> **Drift warning: grant auth replaced cookie auth.** Checked against Pubky Ring `f142436`
> (app 0.0.32), which pins `@synonymdev/react-native-pubky` **0.14.0** (npm `latest`). 0.14.0
> is built on **grant auth**, which shipped in the `pubky` crate **0.10.0** (crates.io is now at
> 0.12.0). Code written for 0.13.0 does not compile against 0.14.0:
> - `startAuthFlow`, `signIn` and `signUp` **require a `clientId`**.
> - `SessionInfo` carries **`grant_secret`**, not `session_secret`.
> - The old `<z32>:<cookie>` secret format is gone.
>
> The `pubky-knowledge-base-v2` react-native snippets still pin 0.13.0, so nothing here is
> KB-CI-verified. The auth snippets below were type-checked (`tsc`) against the published
> 0.14.0 typings but not run, because the package is a native bridge. Everything here is
> pre-1.0: if this file disagrees with your installed typings, trust the typings.
> `docs/AUTH.md` still describes only the legacy URL and does not cover `cid`/`cpk`.

## Two roles: pick the right one

| You are building… | Hold the user's key? | Use |
| :-- | :-- | :-- |
| **A normal app** (almost everyone) | **Never** | `startAuthFlow(caps, clientId)`, then `awaitAuthApproval()`. Show the URL as a QR code or open it as a deeplink. |
| **A key-holding authenticator like Ring** (rare) | Yes | `parseDeepLink(url)`, then `auth(url, secretKey)` ([README `auth` example](https://github.com/pubky/react-native-pubky/blob/main/README.md#auth)) |

Do not ask for, import or store the user's secret key just to authenticate. Helpers that take a
secret key (`signIn`, `signUp`, `put`, `deleteFile`) are for authenticators and key-owning apps
only.

## Request a scoped grant via Ring (primary path)

Adapted from the `startAuthFlow` and `awaitAuthApproval` examples in the react-native-pubky
0.14.0 README (cookie variants removed). Type-checked against 0.14.0, not run.

```react-native
import { startAuthFlow, awaitAuthApproval } from '@synonymdev/react-native-pubky';

const startRes = await startAuthFlow('/pub/att.app/:rw', 'my-app.example');
if (startRes.isErr()) {
  console.log(startRes.error.message);
  return;
}
console.log(startRes.value); // Auth URL to present to user

const approvalRes = await awaitAuthApproval();
if (approvalRes.isErr()) {
  console.log(approvalRes.error.message);
  return;
}
console.log(approvalRes.value); // { pubky, capabilities, grant_secret }
```

These are the 0.14.0 signatures that matter for Ring. Each one was checked for exact type
equality against the published typings. This is a signature listing, not compilable TS;
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx) is authoritative.

```react-native
// Grant auth. The unprefixed names are aliases of the *Grant functions.
export async function startAuthFlow(capabilities: string, clientId: string): Promise<Result<string>>;
export async function awaitAuthApproval(): Promise<Result<SessionInfo>>;
export async function signUp(secretKey: string, homeserver: string, signupToken: string | undefined, clientId: string): Promise<Result<SessionInfo>>;
export async function signIn(secretKey: string, clientId: string): Promise<Result<SessionInfo>>;
export async function signOut(sessionSecret: string): Promise<Result<string>>;
export async function revalidateSession(sessionSecret: string): Promise<Result<SessionInfo | CookieSessionInfo>>;
// Deeplinks
export async function parseDeepLink(url: string): Promise<Result<PubkyDeepLinkDetails>>;
export async function parseAuthUrl(url: string): Promise<Result<PubkyAuthDetails>>;
export async function auth(url: string, secretKey: string): Promise<Result<string[]>>; // authenticator only

export interface GrantSessionInfo { pubky: string; capabilities: string[]; grant_secret: string; }
export type SessionInfo = GrantSessionInfo;
```

Gotchas:

- **`clientId`** is a non-empty, domain-like string of at most 253 characters that identifies
  your app (for example `pubkyapp.synonym.to` or `example-app`). The homeserver stores it with
  the grant and shows it when grants are listed. Recommendation (not an upstream rule): keep it
  stable across releases.
- **`signUp`, `signIn`, `startAuthFlow` and `awaitAuthApproval` are grant aliases.** Use the
  explicit `*Grant` names when the distinction matters. **Do not use the `*Cookie` variants**
  (`startCookieAuthFlow`, `signInCookie`, …). Cookie auth is deprecated, insecure (every app
  shares one homeserver-domain cookie,
  [pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)) and scheduled
  for removal.
- **The binding tracks only one pending flow.** `startAuthFlow` silently replaces any flow in
  progress. `awaitAuthApproval` takes the flow once and returns `No auth flow in progress` if
  there is none. Start one flow, then await it.
- **Pending flows do not survive an app kill.** The RN binding has no save/resume for grant
  flows, and the URL alone cannot resume one: the client's proof-of-possession key must also be
  kept. If the OS kills your app while the user is in Ring, start a new flow. Resumable
  `pubkyauth` flows exist in the Rust/JS SDKs, but this binding does not expose them.
- **You cannot choose a relay from RN.** The flow uses the SDK's default relay with `signin`
  kind.
- **Grant model:** the SDK exchanges the grant plus a short-lived proof-of-possession for an
  opaque bearer token valid for one hour, and refreshes it automatically. Each app/client key
  gets its own grant, which can be listed and revoked on its own
  ([grant-auth guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md)).

## Store and revoke the `grant_secret`

- **`grant_secret` is bearer-equivalent**
  ([grant-auth guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md)).
  It holds the grant plus the proof-of-possession key material, and it works until the grant is
  revoked. Store it only in the Keychain (iOS) or Keystore (Android). **Never** put it in
  AsyncStorage, Redux, logs or analytics.
- **`signOut`, `revalidateSession`, `putWithSession` and `deleteWithSession`** restore the
  session from the secret. They accept either a `grant_secret` or a legacy cookie
  `session_secret` (see the String Contracts in the
  [pubky-core-ffi README](https://github.com/pubky/pubky-core-ffi/blob/main/README.md)).
- **Revoke your own grant:** call `signOut(grant_secret)`, which sends `DELETE` to the grant
  session endpoint. Then delete your stored copy.
- **Listing or revoking other grants** needs `GrantManager` and a session with the **root**
  capability (non-root sessions get `403 Forbidden`). **react-native-pubky 0.14.0 does not
  expose it.** In JS: `new GrantManager(session).revoke(id)`. See the upstream
  [JS example](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/8-session-management.mjs)
  and [Rust example](https://github.com/pubky/pubky-homeserver/tree/main/examples/rust/6-session_management).
- **Do not tell users they can revoke your app's access from inside Ring.** The Ring README says
  "view and control active sessions", but no Ring screen calls sign-out: `c6e73d0` deleted the
  session item UI, and Ring shows only a session count. Ring tracks only its **own** sessions
  (from `signIn`/`signUp`). Grants it approves for third-party apps through `auth()` are not
  stored or listed. Put a sign-out option inside your own app.
- Legacy `AUTH.md` tokens have no delegation: the issuer is always the pubky itself.

## Deeplink schemes and intents

Ring registers both `pubkyauth` and `pubkyring` (iOS `CFBundleURLSchemes`, Android
intent-filter). The SDK marks `pubkyring` as deprecated but still parses it. **Emit
`pubkyauth://` for auth and signup links.** `session` and `migrate` exist only as `pubkyring://`.

The SDK chooses the intent from the URL **host**
([`deep_link.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/deep_link.rs)).
An empty host (`pubkyauth:///?…`) means `signin`. Any other host returns `InvalidIntent`.

| Intent (host) | Required params | What Ring `f142436` does |
| :-- | :-- | :-- |
| `signin_grant` | `caps`, `relay`, `secret`, `cid`, `cpk` | Shows auth consent. |
| `signup_grant` | `caps`, `relay`, `secret`, `cid`, `cpk`, `hs` [+`st`] | Creates a key and signs up. **Consent is broken:** Ring rebuilds the consent URL as `signin_grant` without `cid`/`cpk`, so `parseDeepLink` fails and the user sees an error toast instead of consent. |
| `signin` (legacy cookie; also `pubkyauth:///?`) | `caps`, `relay`, `secret` | Shows auth consent. |
| `signup` (legacy cookie) | `caps`, `relay`, `secret`, `hs` [+`st`] (**all required**) | Signs up, then shows consent. |
| `direct_signup` | `hs` [+`st`] | Creates an account with no app authorization. **Use this for account-only links.** |
| `secret_export` | `secret` | Intended to import a key. **Apparently non-functional** (from reading the code, not a runtime test): the FFI returns `secret` as base64url, but Ring's import path hex-decodes it. |

Param rules
([`query_params.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/query_params.rs)):

- `secret`: base64url, no padding, decodes to exactly **32 bytes**.
- `relay`: a URL.
- `cid`: the grant ClientId.
- `cpk`: the client public key in z-base32, bound by the grant's `cnf` claim.
- `st`: optional signup token.
- **`hs` must be the bare z-base32 key (`publicKey.z32()`), not the `pubky<z32>` display
  string.** The SDK parses it with `PublicKey::try_from_z32`. Ring's built-in values are
  production `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` and staging
  `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` (staging is used in `__DEV__`).

Example `signin_grant` URL from an SDK unit test. **Never build this by hand:** use the URL
`startAuthFlow` returns, because `cpk` must match the key your flow holds.
`pubkyauth://signin_grant?caps=/pub/pubky.app/:rw&relay=https://httprelay.pubky.app/inbox/&secret=kqnceEMgrNQM_xi06oQXjA3cJHX_RQmw1BY6JE1bse8&cid=franky.pubky.app&cpk=<client_pk_z32>`

Parsing notes:

- `parseDeepLink` handles every intent. `parseAuthUrl` accepts only
  `signin`/`signup`/`signin_grant`/`signup_grant` and returns `Invalid auth URL intent '<intent>'`
  for anything else.
- `kind` can be missing only from `parseAuthUrl` (`PubkyAuthDetails`), and only against a native
  binary older than 0.9.1. In `parseDeepLink` (`PubkyDeepLinkDetails`), `kind` is always present.
- `auth()` accepts the legacy and grant signin/signup intents, and rejects `direct_signup` and
  `secret_export`.
- Before parsing, Ring normalizes input: it strips a `pubkyring://` wrapper around
  `pubkyauth://…`, fixes `pubkyauth///` to `pubkyauth:///`, rewrites
  `pubkyring://signin|signup|direct_signup?` to `pubkyauth://…`, and collapses `…/?` to `…?`.
  **Do not rely on this. Emit well-formed URLs.**
- The Ring README's deeplink table is stale. It leaves out `signin_grant`, `signup_grant` and
  `secret_export`. Its "Legacy Direct Signup" row (`pubkyauth://signup?hs=..[&st=..]`) fails the
  native parser, which requires `caps`/`relay`/`secret`, so Ring treats it as Unknown. Emit
  `direct_signup` instead.

## x-callback return to your app

Ring reads x-callback-url metadata from the link
([`AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md),
[`xCallback.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/xCallback.ts)):

| Param | Meaning | What Ring opens |
| :-- | :-- | :-- |
| `x-source` | Human-readable name of your app | Shown in the consent title ("Authorize {{appName}}") |
| `x-success` | Where to go after success | Auth: the URL unchanged. Session: the URL with params appended. |
| `x-error` | Where to go after an error | The URL with `errorCode` and `errorMessage` appended |
| `x-cancel` | Where to go after cancel or timeout | The URL unchanged |

- **Encode each value exactly once** with `encodeURIComponent` (spaces become `%20`, not `+`).
  Do not double-encode or form-encode.
- **Decoding depends on the link type (Ring `f142436`):**
  - `session` and invite links: Ring reads values from the original, still-encoded query and
    decodes once, so nested `%3F`/`%3D`/`%26` survive byte-for-byte (Bitkit relies on this to
    check a nonce).
  - `pubkyauth` auth/signup links: Ring runs `decodeURIComponent` up to 3 times over the
    **whole** input before `parseDeepLink`, and the SDK splits the query on `&`. A callback like
    `bitkit%3A%2F%2Fcb%3Fnonce%3Dabc%26reason%3Duser` is cut to `bitkit://cb?nonce=abc`. **Do
    not put a nested query containing `&` (or other percent-escapes you need preserved) in
    callbacks on auth/signup links.**
- `callback` is still parsed as a fallback for `x-success`. Emit `x-success` in new links.
- Callbacks are **untrusted navigation hints**, not proof of approval. Authentication completes
  over the encrypted relay, and only `awaitAuthApproval()` proves it.
- If your scheme is not registered, `Linking.openURL` fails and Ring ignores the error, so the
  user stays in Ring.
- Error codes Ring sends: `AUTH_FAILED`, `AUTH_ERROR`, `SESSION_FAILED`, `SESSION_ERROR`,
  `SIGNUP_FAILED`, `SIGNUP_ERROR`, `INVITE_FAILED`, `INVITE_ERROR`, `OFFLINE`.

## `pubkyring://session`: root grant (avoid for third-party apps)

`pubkyring://session?x-success={url}[&x-error=…&x-cancel=…&x-source=…]`

- Needs a pubky selected in Ring.
- `x-success`, and `x-error`/`x-cancel` if present, must match `^[A-Za-z][A-Za-z0-9+.-]*://`.
- Ring shows a ConfirmSession sheet with the requesting app and `scheme://host`. Deny opens
  `x-cancel`. Allow signs in and opens `x-success` with `pubky`, `grant_secret` and
  `capabilities` (comma-joined) appended.
- **Security:** this hands your app a **root** homeserver grant (read/write on everything),
  created under **Ring's** client id (iOS `app.pubkyring`, Android `to.pubky.ring`), not a scoped
  grant under yours. Ring's own warning says to allow it only for trusted apps. **Use the scoped
  `startAuthFlow` path instead.**

## What Ring does when a link arrives (predicting UX and timeouts)

Ring-internal behaviour at `f142436`. These details can change without notice.

- **Auth consent.**
  - Needs a pubky selected in Ring. Ring re-parses the raw URL with `parseDeepLink`.
  - The sheet lists each path with Read/Write, based on whether the permission string contains
    `r` or `w`.
  - **If the user does nothing for 60 s, Ring denies automatically** and opens `x-cancel`.
  - With auto-auth turned on, Ring skips the sheet.
  - After approval, the network step has a **20 s timeout**.
- **Approval (`performAuth`).** Ring loads the key from the Keychain, signs up to the homeserver
  if needed, and calls `auth(url, secretKey)`. If that fails, Ring signs in again (which creates
  and stores a **new root session under Ring's client id**) and retries once. It then
  republishes the homeserver record in the background.
- **Signup / direct signup.**
  - Returns `OFFLINE` if there is no network.
  - Reuses an existing pubky already tied to the same `st`.
  - Otherwise generates a mnemonic and keypair, then calls
    `signUp(secretKey, hs, st, appApplicationId)`.
  - If signup fails, the link has auth params and signed-up pubkys exist, Ring falls back to
    auth consent. That fallback uses the newly generated (failed) pubky as context, not an
    existing signed-up one.
  - A legacy `signup` link continues to consent. A `signup_grant` link errors at consent (see the
    intent table). A `direct_signup` link stops after creating the account.
- **Ring's own session storage, a pattern worth copying:** secrets live in the Keychain, keyed by
  a uuid v5 of `grant_secret`. Redux holds only `{id, capabilities, created_at}`. If the Keychain
  save fails, Ring revokes the new session immediately. A store migration revoked and removed
  all legacy cookie sessions.

## QR and clipboard input

Ring accepts any of these by scan or paste: a deeplink, a 12-word BIP39 phrase, a secret key, an
invite code `XXXX-XXXX-XXXX` or `…/invite/XXXX-XXXX-XXXX`, and (QR only) animated multi-frame
migrate codes.

Check order in
[`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts)
(differs from the README):

0. Decode with `decodeURIComponent` up to 3 times, keeping the still-encoded query.
1. `pubkyring://migrate?`
2. Native `parseDeepLink`: DirectSignup, Signup, Auth (built only for `signin`/`signin_grant`) or Import (`secret_export`).
3. `session?`, which requires `x-success` or `callback`.
4. An invite URL.
5. A standalone invite code.
6. An import: tried as a mnemonic first, then as a secret key.
7. Retry as a lowercased 12-word phrase.
8. Unknown.

When importing, Ring strips `pubkyring://`/`pubkyauth://` and turns runs of `-`, `_` and `+`
into spaces.

## Key migration: animated QR (`pubkyring://migrate`)

Ring shows one frame per key, cycled with `AnimatedQR`. This is a byte copy of Ring `f142436`
[`MigrateQRCode.tsx`](https://github.com/pubky/pubky-ring/blob/main/src/screens/MigrateQRCode.tsx).
It was lint- and type-checked, and its frames were round-tripped through Ring's migrate parser:

```react-native
const migrateFormattedData = useMemo(() => {
  return keyValues.map((value, index) => ({
    value: `pubkyring://migrate?index=${index}&total=${keyValues.length}&key=${encodeURIComponent(value)}`,
  }));
}, [keyValues]);

// <AnimatedQR data={isRevealed ? migrateFormattedData : placeholderData} startCycleInterval={200} cycleInterval={600} transitionDuration={60000} size={qrSize} />
```

- **Frames are plaintext secrets.** How `key` is chosen:
  - If the pubky's backup preference is `encryptedFile`, `key` is the **raw, unencrypted secret
    key**, even when a mnemonic exists. (`encryptedFile` is only a preference label; nothing is
    encrypted.)
  - Otherwise `key` is the recovery **mnemonic** if there is one, falling back to the raw secret
    key.

  Anyone who captures the frames owns the identity. Ring's precautions: the QR stays blurred
  until "Tap to reveal", Android sets `FLAG_SECURE` (iOS has no equivalent), brightness goes to
  max, and the code hides when the app goes to the background. If you produce or consume these
  frames, apply the same precautions and never log them.
- **What Ring accepts when receiving:**
  - `index` and `total` are numbers, `key` is non-empty, `total > 0`, and `0 ≤ index < total`.
  - `total === 1` imports right away.
  - With more than one key, Ring collects frames by index. A different `total` resets the
    collection, and duplicate frames are ignored. Each new frame starts importing in parallel.
  - Ring shows a summary once all indices have arrived. Closing the scanner early shows a
    partial summary only if at least one import has already succeeded.
  - Each key is tried as a lowercased mnemonic first, then as a secret key.
- **`AnimatedQR` props:**
  - `data: {value}[]`
  - `cycleInterval`: default 600 ms
  - `startCycleInterval`: optional; eases linearly to `cycleInterval` over
    `transitionDuration` (default 5000 ms)
  - `size`: default 250

  It does not cycle with a single frame or while paused. Tapping pauses it and shows prev/next
  controls.

Backup *restore* and cloud backup are **not shipped**
([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)). Migrate moves keys
from one device to another. It is not a backup service.
