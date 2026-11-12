# Pubky Ring integration

How a mobile app gets a capability-scoped **grant** from the **Pubky Ring** authenticator without
ever holding the user's key. This page covers Ring-specific behavior: deeplinks, x-callbacks, QR and
animated migrate-frame input, scoped encryption keys, the expected signer (`spk`) and revocation.
For shared protocol, follow these links:

- **Grant model, relays, `pubkyauth://` intent table, authenticator side:**
  [`auth.md` § Grant auth model](../../pubky/references/auth.md#grant-auth-model),
  [§ Relays](../../pubky/references/auth.md#relays),
  [§ deep links](../../pubky/references/auth.md#pubkyauth-deep-links),
  [§ Authenticator side](../../pubky/references/auth.md#authenticator-side-approving-requests).
  `auth.md` may lag the newest SDK. For `spk` (`pubky` 0.18.0), see
  [§ Require a specific identity](#require-a-specific-identity-spk) and upstream
  [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md). For `af`,
  `epk` and `e`, see upstream
  [`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).
- **Capability syntax, and why to avoid root `/:rw`:** [`auth.md` § Capabilities](../../pubky/references/auth.md#capabilities).
- **Identity, key string formats, homeserver model:** [`concepts.md`](../../pubky/references/concepts.md).
- **RN API surface, types, `Result`/`isErr()`, resumable-flow API table:** [`react-native.md`](./react-native.md)
  ([§ Session types](./react-native.md#session-types),
  [§ Resumable flows](./react-native.md#resumable-cancellable-and-signup-grant-flows)) and
  [`native-ffi.md`](./native-ffi.md).

**Upstream (source of truth):**
Ring [`docs/input-formats.md`](https://github.com/pubky/pubky-ring/blob/main/docs/input-formats.md)
(links, QR, clipboard, callbacks) ·
[`docs/security.md`](https://github.com/pubky/pubky-ring/blob/main/docs/security.md) ·
[`docs/development.md`](https://github.com/pubky/pubky-ring/blob/main/docs/development.md) ·
[`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts) ·
[`expectedSigner.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/expectedSigner.ts) ·
[`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky)
([README](https://github.com/pubky/react-native-pubky/blob/main/README.md),
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)) ·
[pubky-homeserver `docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) ·
[`docs/grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md) ·
[grant-auth migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md).

## Versions and drift

- **Checked against Pubky Ring main `f2f8c2d` (2026-11-11).** Native version: iOS
  `MARKETING_VERSION` **2.0.1**, Android `versionName "2.0"` (versionCode 29). `package.json` says
  0.0.32, so do not read the app version from it. A store release may lag `main`.
- Ring pins **`@synonymdev/react-native-pubky` 0.15.0** (still npm `latest`; no newer RN release).
  It wraps `pubky-core-ffi` `cecd67c`, which pins `pubky` **0.16.1**.
- crates.io `pubky` and npm `@synonymdev/pubky` are at **0.18.0** (2026-11-09). `spk` first ships
  there, so **RN apps do not have it yet** ([below](#require-a-specific-identity-spk)).
- **Snippet status:** `pubky-knowledge-base-v2` has no RN or Ring snippets, so nothing here is
  KB-CI-verified. The RN snippets **type-check under strict `tsc` against the published 0.15.0
  typings** and were **not run** (native bridge). The JS `spk` snippet was **executed against a
  local testnet**. Everything is pre-1.0. If this page disagrees with your installed typings, trust
  the typings.
- **Ring's README is user-facing only.** The integration reference is
  [`docs/input-formats.md`](https://github.com/pubky/pubky-ring/blob/main/docs/input-formats.md).
  Where that doc and Ring's code disagree, this page says so (`secret_export`, legacy direct signup,
  nested callbacks).
- **`docs/AUTH.md`** documents the x-callback params and `spk`. Otherwise it still describes only the
  legacy `pubkyauth:///?relay&caps&secret` URL and legacy `AuthToken`. It does not mention `cid`,
  `cpk`, `af` or `epk`.
- **Not released, do not use:** delegated (parent/child) grants
  ([`docs/delegated-grants.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md),
  homeserver `8612a64`) are on homeserver `main` only, in no release (not in v0.18.0), and Ring does
  not support them.
- **Removed:** Ring `9d1a888` (2026-09-22) deleted the `pubkyring://session?x-success=…` root-grant
  hand-off. Use the scoped grant flow.
- To check whether a release contains a commit, run `git merge-base --is-ancestor <commit> <tag>`
  against fetched tags, or check crates.io. A local clone may have only old tags.

## Two roles: pick the right one

| You are building… | Hold the user's key? | Use |
| :-- | :-- | :-- |
| **A normal app** (almost everyone) | **Never** | `startAuthFlow(caps, clientId)` then `awaitAuthApproval()`. For resumable flows, a custom relay, x-callbacks or encryption keys, use `startGrantAuthFlowWithConfig` + `pollGrantAuthFlow`. Show the URL as a QR code or open it as a deeplink. |
| **A key-holding authenticator like Ring** (rare) | Yes | `parseDeepLink(url)`, then `auth(url, secretKey)` or `authWithCapabilities(url, secretKey, approved)` ([RN § Authenticator side](./react-native.md#authenticator-side)) |

Do not ask for, import or store the user's secret key just to authenticate. The helpers that take a
secret key (`signIn`, `signUp`, `put`, `deleteFile`, `auth`) are for authenticators and key-owning
apps only.

**Authenticator only:** `authWithCapabilities` approves a subset of the request. Verbatim from the
0.15.0 README; type-checked strict against 0.15.0, not run.

```react-native
import { authWithCapabilities } from '@synonymdev/react-native-pubky';

const authRes = await authWithCapabilities(
  pubkyAuthUrl,
  secretKey,
  '/pub/example/:r'
);
```

- The approved string is comma-separated `scope:actions`. An empty string authenticates with no
  capabilities.
- The request must cover every approved scope and action. You may narrow scopes and drop actions,
  including `e`. Native validation rejects a malformed or excessive approval before anything reaches
  the relay.
- Client identity, relay channel and approval format stay as the link requested
  ([`scoped-encryption-keys.md` § Select capabilities](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md#select-capabilities-on-the-signing-device)).

## Request a scoped grant via Ring (primary path)

The react-native-pubky 0.15.0 README `startAuthFlow`/`awaitAuthApproval` example with the cookie
variants removed. Type-checked strict against 0.15.0 (inside an async function, because of the
top-level `return`); not run.

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
console.log(approvalRes.value);
// { homeserver, pubky, client_id, capabilities, grant_id,
//   token_expires_at, grant_expires_at, created_at, grant_secret }
```

Full signatures and types: [`react-native.md`](./react-native.md#session-types) and upstream
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx). The functions
a Ring integration uses: `startAuthFlow`/`awaitAuthApproval` (aliases of
`startGrantAuthFlow`/`awaitGrantAuthApproval`), `startGrantAuthFlowWithConfig`, `saveGrantAuthFlow`,
`restoreGrantAuthFlow`, `pollGrantAuthFlow`, `awaitGrantAuthFlow`, `cancelGrantAuthFlow`, `signOut`,
`listGrants`, `revokeGrant`, `grantEncryptionKeyScopes`, `deriveGrantEncryptionKey`; for
authenticators, `parseDeepLink`, `parseAuthUrl`, `auth`, `authWithCapabilities`.

Ring-relevant type facts (0.15.0):

- `SessionInfo` is `GrantSessionInfo`. Its `homeserver`, `client_id`, `grant_id`,
  `token_expires_at`, `grant_expires_at` and `created_at` fields were added in **0.14.1** (`91e0fcc`).
  `pubky` and `homeserver` are **bare z32**.
- `GrantInfo.capabilities` (from `listGrants`) is one comma-joined **string**, not an array.
- `GrantAuthFlowConfig` has **no** `expectedSigner` field. Setting `homeserver` selects signup.
  `approvalFormat` is `'bareGrant' | 'signedApprovalV1'`. `xSource`/`xSuccess`/`xError`/`xCancel`
  set the callbacks.
- `GrantAuthFlowState` is `{ authorizationUrl, clientKeySecret, approvalKeySecret? }`. Both secrets
  are sensitive.

Gotchas:

- **`clientId`:** see [`auth.md` § Grant auth model](../../pubky/references/auth.md#grant-auth-model).
  Ring **does not show it on the consent sheet**. It does show it in the Authorized Apps list, the
  grant detail screen and the revoke sheet, so keep it stable and human-readable.
- **The simple helper is fixed.** `startAuthFlow`/`startGrantAuthFlow` always use the SDK default
  relay, the `signin` kind and the bare-grant format. Use `startGrantAuthFlowWithConfig` to pick a
  relay, sign up through the flow (`homeserver`/`signupToken`), request `signedApprovalV1`, attach
  x-callbacks, or supply your own client secret or key.
- **One global flow slot.** `startAuthFlow`, `startGrantAuthFlowWithConfig` and
  `restoreGrantAuthFlow` share it, so starting or restoring a flow **silently replaces** any pending
  one. `awaitAuthApproval`/`awaitGrantAuthFlow` take the flow out of the slot. With nothing pending,
  they fail with `No auth flow in progress` (legacy await) or `No Grant auth flow is in progress`
  (new APIs).
- **Do not use the `*Cookie` variants** (`startCookieAuthFlow`, `signInCookie`, …). Cookie auth is
  deprecated and insecure ([pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)).

## Require a specific identity (`spk`)

`spk` on `pubkyauth://signin_grant` names the identity that must approve. The semantics are
canonical in [`docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md):

- The value must be exactly the canonical 52-char z-base-32 key (`publicKey.z32()`). Prefixed forms
  (`pubky…`, `pk:…`), URL-shaped values and noncanonical encodings are rejected. At most one `spk`.
- It is a **constraint, not a hint**. The authenticator uses that key or nothing. The app's flow
  rejects an approval whose `iss` differs, before the grant exchange and also after a restore. The
  user is still asked to approve.
- Authenticators that predate `spk` ignore it and show their picker. The app-side check then rejects
  an approval from any other key.
- **Accepted tradeoffs:** any app can name any pubky. An authenticator with several keys opens the
  named one without asking, so the user must notice which account was chosen. An app can **probe
  whether Ring holds a key**: a held key leads to the consent screen, then `x-cancel` on deny or
  timeout; a missing key leads to a local error and **no callback**.

**SDK support:** `pubky` 0.18.0 and `@synonymdev/pubky` 0.18.0 only. Rust:
`GrantAuthFlowBuilder::expected_signer(self, public_key: PublicKey) -> Self`. JS: the
`expectedSigner` option of `startGrantAuthFlow` (parsed links expose
`SigninGrantDeepLink.expectedSigner`). Sign-up flows reject it (`an expected signer applies to
sign-in flows only`). **Web/JS** form, verbatim from the
[JS SDK README § Require the signed-in identity](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md):

```js
const flow = await pubky.startGrantAuthFlow(caps, AuthFlowKind.signin(), {
  clientId: "my-cool-app.example",
  expectedSigner: session.info.publicKey.z32(),
});
```

Executed with `@synonymdev/pubky` 0.18.0 against a local testnet. The link carried the bare-z32
`spk`, approval by the expected key produced a session for that pubky, and approval by another key
was rejected (`this sign-in request is for a different key`). Needs **>= 0.18.0**. In TypeScript,
type `caps` as `Capabilities`, because a plain `string` fails with TS2345. On `Pubky.testnet()` the
flow still defaulted to the public relay `https://httprelay.pubky.app/inbox`, not the local one.

**React Native cannot use `spk` yet.** react-native-pubky 0.15.0 wraps `pubky` 0.16.1 and has no
`expectedSigner`. **Do not hand-append `&spk=` to an RN flow URL.** Ring would honor it, but the
0.16.1 flow would not reject an approval from another key, so the app-side guarantee is missing.
Instead, after approval compare `session.pubky` (bare z32) with the expected identity in **z32
form**, and on a mismatch discard the grant (`signOut` it).

**What Ring does with `spk`** (`59f1163`; code reading):

- Ring reads `spk` only on `signin_grant`. An empty, malformed (not `/^[z32]{51}[yo]$/`) or repeated
  `spk` makes the whole link **Unknown**.
- Ring reads `spk` from the still-encoded query, and it must equal the `spk` in the fully decoded URL
  that Ring signs. An `spk` hidden inside an encoded callback (`%26spk%3D`) invalidates the request.
- Ring opens that pubky directly, with no picker, even when it holds several. If Ring lacks it, the
  toast is "Pubky not in this Ring". If Ring holds it but cannot authorize with it, the toast is
  "Pubky not set up". **No fallback to another pubky and no x-callback** in either case, so set your
  own timeout.
- The per-pubky scanner, the picker and Auto Auth refuse to sign a request for another pubky ("This
  request is for {pubky}. Approve it with that pubky.").
- AUTH.md says the approval screen should show that the app chose the identity. Ring removed that
  notice (`f2f8c2d`). Its consent shows only the identity row (name plus key).
- For `signup_grant`, Ring never carries `spk` into the rebuilt `signin_grant`.

## Resumable flows (survive an app kill)

The OS may kill your app while the user is in Ring. Save the flow state and **poll instead of
awaiting**. API table and semantics:
[`react-native.md` § Resumable flows](./react-native.md#resumable-cancellable-and-signup-grant-flows);
Rust/JS: [`auth.md` § Resume](../../pubky/references/auth.md#resume-after-reload-or-restart).
What matters for Ring:

- **Save and cancel work only while you drive the flow with `pollGrantAuthFlow`.** A pending
  `awaitGrantAuthFlow` owns the native flow, so it can no longer be saved or cancelled. The README
  says: "Use polling when an application needs resumability or cancellation."
- `cancelGrantAuthFlow` only clears the local slot. `saveGrantAuthFlow` fails with `Grant flow does
  not use an exportable local signer` when the flow has no local key.
  `startGrantAuthFlowWithConfig` already returns the state.
- **`GrantAuthFlowState` holds secrets** (`clientKeySecret` = PoP key, `approvalKeySecret` = HPKE
  recipient key). Store it only in the Keychain or Keystore, delete it when the flow completes, fails
  or is cancelled, and never log it.
- `restoreGrantAuthFlow` checks that the saved key matches the URL's `cpk`. After an SDK upgrade, a
  saved signed-approval flow whose URL has `secret` but no `epk` cannot be resumed. Restart it.
- **Keep polling after an `x-cancel` or after no callback**
  ([Cancellation does not recall a grant](#cancellation-does-not-recall-a-grant)).

**AUTHORED** (no upstream source). Type-checked strict against 0.15.0; not run. `secureStore` is a
placeholder for Keychain/Keystore storage.

```react-native
import {
  startGrantAuthFlowWithConfig,
  restoreGrantAuthFlow,
  pollGrantAuthFlow,
  cancelGrantAuthFlow,
  type GrantAuthFlowState,
} from '@synonymdev/react-native-pubky';

// Start: persist the state BEFORE handing the URL to Ring.
const startRes = await startGrantAuthFlowWithConfig({
  capabilities: '/pub/my-app.example/:rw',
  clientId: 'my-app.example',
  xSource: 'My App',
  xSuccess: 'myapp://auth/done',
  xCancel: 'myapp://auth/cancel',
});
if (startRes.isErr()) return;
await secureStore.set('pendingFlow', JSON.stringify(startRes.value));
// Linking.openURL(startRes.value.authorizationUrl) or render it as a QR code

// On launch / foreground: restore if needed, then poll.
const saved = await secureStore.get('pendingFlow');
if (saved) {
  const restoreRes = await restoreGrantAuthFlow(JSON.parse(saved) as GrantAuthFlowState);
  if (restoreRes.isErr()) { await secureStore.delete('pendingFlow'); return; }
}
const pollRes = await pollGrantAuthFlow();
if (pollRes.isErr()) {
  // Retry transient (network) errors; on a terminal error or past your deadline:
  await cancelGrantAuthFlow();
  await secureStore.delete('pendingFlow');
} else if (pollRes.value) {
  await secureStore.set('grantSecret', pollRes.value.grant_secret);
  await secureStore.delete('pendingFlow');
}
// pollRes.value === null: still pending, poll again later.
```

Poll on a timer with your own deadline. When the deadline passes, call `cancelGrantAuthFlow()` and
delete `pendingFlow`, so stale PoP and HPKE secrets do not stay in storage.

## Scoped encryption keys (`e`, `pubky` 0.16+)

The model and its risks are canonical upstream in
[`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md)
and in [`auth.md` § Scoped encryption keys](../../pubky/references/auth.md#scoped-encryption-keys);
RN API: [`react-native.md`](./react-native.md#custom-grant-proofs-and-scoped-encryption-keys). For a
Ring integration:

- Request `e` on a scope (for example `/pub/chat/:rwe`) **and** set
  `approvalFormat: 'signedApprovalV1'`. Without it, `startGrantAuthFlowWithConfig` fails with
  `encryption key permission requires af=v1` and produces no link.
- After approval, `grantEncryptionKeyScopes(grant_secret)` returns `null` for a bare grant and `[]`
  for a signed approval with no keys. `deriveGrantEncryptionKey(grant_secret, path)` returns a
  32-byte base64 key for an approved **file** path, `null` for a bare grant, and fails with
  `OutsideScope` or `DirectoryPath` for an unapproved or directory path.
- **Ring has one "Allow access to encrypted data" switch for the whole request, default ON, and it
  renders only in the "Show Details" view** (setting `alwaysShowAuthDetails`, default off). A user
  who swipes from the default summary **approves the full request, including `e`, without seeing the
  switch**. Declining strips `e` from **every** scope, keeps `r`/`w`, and drops scopes left with no
  actions. **Handle `[]`.** The details-view warning ("Make sure you trust the service, browser, and
  device… Removing access later won’t take back shared encryption keys.") is not shown on the default
  summary.
- **Keys are permanent.** They derive from the identity secret. Revoking or expiring the grant does
  not take them back, and there is no rotation. A key for a directory covers every file below it, and
  `e` on `/` yields every key the user will ever have. Request the narrowest scope.
- **Roll out in this order: homeservers, then signers, then apps.** Older homeservers reject grants
  containing `e`. Older signers cannot open `af=v1` links, because they have no `secret`. The SDK does
  not fall back to a bare grant.
- **Silent hang:** if the approval exceeds the relay body limit, the relay returns HTTP 413 and the
  app is never notified. Poll with your own timeout. Do not use an unbounded await.
- Encrypting data with these keys is **your own crypto**. Encrypted storage is not a shipped
  primitive. See
  [`shipped-vs-planned.md` § App-side ciphertext](../../pubky/references/shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto).

## Store and revoke the `grant_secret`

- **`grant_secret` is a bearer credential** until the grant is revoked or expires. Store it only in
  the Keychain (iOS) or Keystore (Android). **Never** put it in AsyncStorage, Redux, logs or
  analytics.
- **If the grant carries `e`, the secret stays sensitive after revocation or expiry.** A
  signed-approval `grant_secret` embeds the permanent encryption keys, which
  `grantEncryptionKeyScopes`/`deriveGrantEncryptionKey` read offline. Delete it after `signOut` or
  expiry.
- `putWithSession`, `deleteWithSession`, the `session*` storage APIs, `signOut`,
  `revalidateSession`, `listGrants` and `revokeGrant` restore a session from the secret. They accept a
  `grant_secret` or a legacy cookie `session_secret`.
- **One grant, one client.** Restoring a session exchanges the grant for a fresh bearer, so two
  clients holding copies of one `grant_secret` invalidate each other's bearers. Run a separate flow
  for each app or device
  ([`grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md)).
- **To revoke your own grant,** call `signOut(grant_secret)`, then delete your stored copy.
- **Listing or revoking other grants** (`listGrants`, `revokeGrant`) needs a **root-capability**
  session. A non-root session gets `403`, so a normal scoped app cannot do it. Skip your own
  `grant_id`, or you revoke the management session. Typed snippet:
  [`react-native.md` § List and revoke grants](./react-native.md#list-and-revoke-grants). Shared
  semantics: [`auth.md` § List and revoke grants](../../pubky/references/auth.md#list-and-revoke-grants).
  The README's sample output shows a `/priv/example/:rw` capability. `/priv` is **alpha, not for
  production, and not encrypted from the operator**
  ([`shipped-vs-planned.md` § `/priv`](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha)).

How revocation reaches your app through Ring:

- **Users revoke your app in Ring's Authorized Apps list.** It lists third-party grants (`client_id`,
  issue date, expiry or "Never expires", permissions) and hides grants belonging to Ring's own stored
  sessions and its management session. **Expect your grant to disappear.**
- **Signing Ring out of a homeserver does not revoke your grant.** It revokes only Ring's own grants
  (through a temporary management grant, also revoked). The public mapping, server data and other
  apps' access stay. Switching homeservers in Ring does not move app data
  ([`development.md` § Homeserver setup behavior](https://github.com/pubky/pubky-ring/blob/main/docs/development.md#homeserver-setup-behavior)).
- **Exception:** grant management requires `signedUp && !sourceApp`. Pubkys adopted from Bitkit show
  no grant list.
- **Tell revoked apart from out-of-scope:**
  - `401`, or `revalidateSession` failing with `Session is no longer valid`: the grant was revoked or
    expired. Delete the stored secret and start a new flow. (Full `revalidateSession` error handling:
    [`react-native.md`](./react-native.md#grant-auth-via-ring-no-secret-key).)
  - `403`: your capability does not cover that path or action. **Keep the secret** and fix the
    request, or ask for a wider grant.
  - Keep a sign-out option in your own app as well.
- Legacy `AUTH.md` tokens have no delegation (the issuer is always the pubky). Delegated grants are
  unreleased ([Versions](#versions-and-drift)).

## Deeplink schemes and intents

Ring registers both `pubkyauth://` and `pubkyring://` on iOS and Android. The SDK marks `pubkyring`
deprecated but still parses it. **Emit `pubkyauth://` for auth and signup links.** `migrate`,
`invite` and Ring's `secret_export` use `pubkyring://`. Full link list:
[`input-formats.md` § Links](https://github.com/pubky/pubky-ring/blob/main/docs/input-formats.md#links).

The intent is the URL **host**. An empty host (`pubkyauth:///?…`) means `signin`. The canonical
intent and parameter table is in [`auth.md` § deep links](../../pubky/references/auth.md#pubkyauth-deep-links).
What Ring does with each intent:

| Intent (host) | Required params | What Ring `f2f8c2d` does |
| :-- | :-- | :-- |
| `signin_grant` | `caps`, `relay`, `cid`, `cpk`, plus **either** `secret` (bare grant) **or** `af=v1` + `epk` (signed approval); optional `spk` | Shows auth consent. With `spk`, see [above](#require-a-specific-identity-spk). |
| `signup_grant` | `signin_grant` params + `hs` [+`st`, per server policy]; no `spk` | Creates a key, signs up, then shows consent. |
| `signin` (legacy cookie; also `pubkyauth:///?`) | `caps`, `relay`, `secret` | Shows auth consent. |
| `signup` (legacy cookie) | `caps`, `relay`, `secret`, `hs` [+`st`] | Signs up, then shows consent. |
| `direct_signup` | `hs` [+`st`] | Creates an account with no app authorization. **Use this for account-only links.** |
| `secret_export` | `secret` | Routes to Import, which **fails** (code reading, not run). |

- **`secret` in an auth link is the relay transport secret, not the user's key.** Secret-export and
  migration links do carry identity recovery material.
- **`secret_export` conflicts with Ring's docs.** `input-formats.md` describes it as working. In code,
  Ring imports `details.secret` as-is: the FFI re-encodes it as base64url without padding, and Ring's
  key derivation hex-decodes
  ([`keypair.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c/src/keypair.rs#L7-L11)), so
  import fails with "Failed to get public key from secret key". Do not rely on it.
- **Legacy direct signup (`pubkyauth://signup?hs=..[&st=..]`):** `input-formats.md` says Ring treats
  it as direct signup, but `pubky` 0.16.1 (inside RN 0.15.0) requires `caps`, `relay` and `secret` on
  `signup`, so native parsing fails first. Ring's unit test mocks the parser. **Emit
  `direct_signup`.**

Relay-channel rules for grant links
([`query_params.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/query_params.rs),
[`grant_relay_channel.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/grant_relay_channel.rs)):

- `af` is optional; absent means bare grant, `af=v1` means `SignedApprovalV1`. Any other value, an
  empty value or a duplicate `af` is rejected.
- `epk` is a 32-byte X25519 HPKE public key, base64url without padding. With `epk`, omit `secret`.
  Both together are rejected, and so is `af=v1` without `epk`.
- `secret` is 32 bytes, base64url, no padding.
- **`hs`, `cpk` and `spk` must be the bare z-base-32 key (`publicKey.z32()`), not the `pubky<z32>`
  display string.**

Ring's own transport check is stricter. A grant link counts only if it has `relay` **and** either
`secret` **or** both `approval_format === 'signed_approval_v1'` and `ephemeral_public_key`. A link
that fails falls through: a signin-type link becomes **Unknown**; a signup-type link with `hs` is
**downgraded to DirectSignup**, so Ring creates the account but does no app authorization and your
flow never completes.

Example links from SDK unit tests, for recognition only. **Never build these by hand.** Use the URL
your flow returns, because `cpk` (and `epk`) must match keys the flow holds.

```text
pubkyauth://signin_grant?caps=/pub/pubky.app/:rw&relay=https://httprelay.pubky.app/inbox/&secret=kqnceEMgrNQM_xi06oQXjA3cJHX_RQmw1BY6JE1bse8&cid=franky.pubky.app&cpk={client_pk_z32}
pubkyauth://signin_grant?caps=/:rw&relay=http://localhost/inbox&cid=test.app&cpk={client_pk_z32}&af=v1&epk={base64url_32_bytes}
```

Parsing notes:

- In 0.15.0, `PubkyAuthDetails` and `PubkyDeepLinkDetails` have `approval_format`
  (`'bare_grant' | 'signed_approval_v1'`) and `ephemeral_public_key`, and `secret` is optional on
  both. Authenticators must not assume `secret` is present.
- Before parsing, Ring normalizes malformed input (stray `pubkyring://` prefixes, `pubkyauth///`,
  `pubkyring://signin|signup|direct_signup`). **Do not rely on this. Emit well-formed URLs.**

## x-callback return to your app

Set callbacks with the `xSource`/`xSuccess`/`xError`/`xCancel` fields of
`startGrantAuthFlowWithConfig`. The SDK encodes each value once and never emits the legacy `callback`
key. Parameter semantics:
[`AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md).

| Param | What Ring does with it |
| :-- | :-- |
| `x-source` | Parsed but **not displayed**. The consent title is always "Authorize". |
| `x-success` | Opened unchanged after success. |
| `x-error` | Opened with `errorCode` and `errorMessage` appended, for non-device-auth failures. |
| `x-cancel` | Opened unchanged after a deny, the 60 s consent timeout, or closing/back-navigating the sheet. |

**`x-error` can be followed by `x-cancel`.** After an `AUTH_FAILED`/`AUTH_ERROR` x-error, the consent
sheet stays open (the request is not marked finished), so the 60 s timer later also opens `x-cancel`
(code reading). Treat both as hints only.

**When Ring sends no callback at all:**

- The `spk` pubky is missing or not set up (toast only).
- The user cancels the device-auth prompt (silent). Other device-auth errors (unavailable, busy,
  failed) show a toast but do **not** open `x-error`. You may hear nothing until the 60 s timeout
  opens `x-cancel` (code reading, not run).
- Your scheme is not registered. `Linking.openURL` fails, Ring ignores the error, and the user stays
  in Ring.

Other rules:

- **Do not put nested queries containing `&` in callbacks on auth or signup links.** From code
  reading, not a run, and it **contradicts `input-formats.md`**, which says encoding the nested URL as
  one value makes it survive. Ring decodes the **whole** input with `decodeURIComponent` up to 3
  times, then the native parser splits the query on `&`. So
  `x-cancel=bitkit%3A%2F%2Fcb%3Fnonce%3Dabc%26reason%3Duser` is cut to `bitkit://cb?nonce=abc`. Only
  invite links use Ring's decode-once parser on the still-encoded query.
- `callback` is still parsed as a fallback for `x-success`. Emit `x-success`.
- Callbacks are **untrusted navigation hints**, not proof of approval. Put a nonce in them and check
  it. Only a session returned by `awaitAuthApproval`/`pollGrantAuthFlow` proves approval.
- Error codes Ring sends: `AUTH_FAILED`, `AUTH_ERROR`, `SIGNUP_FAILED`, `SIGNUP_ERROR`, `OFFLINE`,
  `INVITE_FAILED`, `INVITE_ERROR`.

### Cancellation does not recall a grant

From Ring's [`security.md`](https://github.com/pubky/pubky-ring/blob/main/docs/security.md): "A native
authorization already submitted to the SDK cannot currently be recalled. Cancellation suppresses
subsequent steps and UI/callback success, but does not undo a grant already issued by the server."
Ring aborts `performAuth` when it goes to the background (unless an OS prompt is active), and the
60 s timer or a sheet dismissal can open `x-cancel` while authorization is in flight. **Your app can
get `x-cancel`, or no callback, and still receive an approval over the relay.** Treat the relay result
as authoritative. Do not cancel the flow just because `x-cancel` arrived; keep polling until your own
deadline.

## What Ring does when a link arrives (predicting UX and timeouts)

Ring internals at `f2f8c2d`; they can change without notice.

- **Consent sheet (default summary).**
  - Without `spk`, a pubky must be selected in Ring. With `spk`, Ring opens that pubky.
  - The title is always "Authorize" ("Authorized" after success). `cid` and `x-source` are not shown.
    The identity row shows the pubky's name and key.
  - The summary reads "A service is requesting permission to {read|edit|read and edit|access} your
    <scope> data[, including encrypted data]." The scope label is the `/pub/<seg>/` or `/priv/<seg>/`
    path segment, so **name your scope folder meaningfully**. Other paths show raw. If any scope is
    `/`, the summary reads "all your data".
  - An identity-only request (no actions) reads "A service wants to verify your pubky identity."
  - **Approval is swipe-to-authorize** ("Swipe To Authorize"), not a tap.
- **"Show Details" view** (opt-in, or always when `alwaysShowAuthDetails` is on; default off). It
  lists each scope as Folder/Permissions, shows the identity-only card ("Identity verification",
  "Prove you control this pubky"), and holds the single encrypted-data switch. **The user can decline
  only `e`, and only here.** There is no UI to narrow `r`/`w` or drop scopes.
- **After 60 s with no action, Ring denies automatically** and opens `x-cancel`. The sheet shows a
  draining circular countdown. The timer is cleared only once authorization succeeds, so it keeps
  running while an authorization is in flight.
- **Device authentication (optional, off by default, including on upgrade).** When on, every
  authorization requires an OS user-presence check (iOS LocalAuthentication; Android BiometricPrompt
  with credential fallback). Cancellation, unavailability or lockout never approves. It also disables
  Auto Auth. See
  [`security.md` § Optional device authentication](https://github.com/pubky/pubky-ring/blob/main/docs/security.md#optional-device-authentication).
- **Auto Auth is development-only.** It requires `__DEV__`, device auth off and the setting on, so
  **release builds always show the consent sheet**. With Auto Auth active, Ring calls
  `auth(url, secretKey)` with no subset, approving the full request **including `e`**; failures send
  `AUTH_FAILED`.
- **Approval call.** If the request contains `e`, Ring calls `authWithCapabilities(url, secretKey,
  approved)` (with `e` stripped everywhere if declined). Otherwise it calls `auth(url, secretKey)`,
  which approves everything requested.
- **`performAuth` order:** device-auth challenge (if enabled); a **20 s** network deadline starting
  after that challenge; network check and key load; homeserver signup if the pubky is not signed up;
  then `auth` or `authWithCapabilities`. On failure it signs in again (a **new root session under
  Ring's client id**) and retries once. Afterwards it republishes the homeserver record in the
  background if signup did not already.
- **Ring's client id** is its bundle/application id: iOS `app.pubkyring`, Android `to.pubky.ring` on
  `main`. Ring also ships a legacy-sunset flow toward a replacement Play Store build with id
  `app.pubkyring`, so on Android the client id may be either.
- **Signup and direct signup.**
  - Without network, Ring returns `OFFLINE`.
  - Ring reuses a pubky already tied to the same `st`, and skips signup if that pubky is already
    signed up. Otherwise it generates a mnemonic and keypair and signs up.
  - If signup fails and other signed-up pubkys exist, Ring falls back to auth consent.
  - For `signup_grant`, Ring then rebuilds
    `pubkyauth://signin_grant?relay&[secret]&caps&cid&cpk[&af=v1][&epk]`. The x-callbacks travel
    separately, and `spk` is never carried.
  - `direct_signup` stops after the account is created.
- **Ring's own session storage is a pattern worth copying.** Redux holds only non-secret metadata
  (`{id, grant_id, capabilities, created_at}`, plus optional `homeserver`/`cleanupOnly`). The secrets
  live in the Keychain, keyed by a uuid v5 of `grant_secret`.
- **Ring ↔ Bitkit shared keys are not an integration surface.** They use a native store gated by
  signing key and team. Adopted pubkys can authorize, but Ring refuses homeserver signup for them,
  hides their grant management and skips them in migrate export.

## QR and clipboard input

Ring's general scanner and paste accept a deeplink, a 12-word BIP39 phrase, a secret key, an invite
(`XXXX-XXXX-XXXX` or `pubkyring://invite/XXXX-XXXX-XXXX`), and (QR only) animated migrate frames.
Parse order, per [`input-formats.md`](https://github.com/pubky/pubky-ring/blob/main/docs/input-formats.md)
and [`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts):

1. Trim and decode (the whole input, up to 3 `decodeURIComponent` passes).
2. Migration frames.
3. Native SDK parse of auth, signup, direct-signup, grant and secret-export links.
4. An invite in a URL path, then a standalone invite.
5. A recovery phrase or secret key, including a lowercased 12-word retry.
6. Unknown.

Screen-specific validation runs afterwards. Consequences:

- **Ring's Setup (homeserver invite) scanner and paste accept only direct-signup links, invites**
  and, for custom non-Synonym servers, opaque plain tokens. They reject Signup and Auth links. In
  Setup, a `direct_signup` link only fills a draft (server plus invite) for the current pubky.
  New-key onboarding happens when `direct_signup` arrives by deeplink or through the general scanner.
  App-authorization links must go through the general scanner or a deeplink.
- **Encrypted `.pkarr` recovery files** are imported through Ring's file-import flow with a
  passphrase. Do not paste them.

## Key migration: animated QR (`pubkyring://migrate`)

Ring shows one frame per key and cycles them with `AnimatedQR`. Byte copy of Ring `f2f8c2d`
[`MigrateQRCode.tsx`](https://github.com/pubky/pubky-ring/blob/main/src/screens/MigrateQRCode.tsx)
(unchanged frame format). Type-checked strict inside a component; generated frames round-tripped
through a replica of Ring's parser.

```react-native
const migrateFormattedData = useMemo(() => {
  return keyValues.map((value, index) => ({
    value: `pubkyring://migrate?index=${index}&total=${keyValues.length}&key=${encodeURIComponent(value)}`,
  }));
}, [keyValues]);

// <AnimatedQR data={isRevealed ? migrateFormattedData : placeholderData} startCycleInterval={200} cycleInterval={600} transitionDuration={60000} size={qrSize} />
```

- **Frames are plaintext secrets.** With backup preference `encryptedFile`, `key` is the **raw,
  unencrypted secret key** (the preference label encrypts nothing). Otherwise it is the mnemonic, or
  the secret key if there is no mnemonic. Anyone who captures the frames owns the identity.
- **Ring's precautions:** secrets load only on "Tap to reveal", after device auth if enabled. Key
  values are cleared when hidden, and unreadable keys are reported. A privacy cover hides the screen
  when the app goes inactive on iOS; Android uses `FLAG_SECURE`. Adopted pubkys are skipped. If you
  produce or consume these frames, take the same precautions and never log them.
- **What Ring accepts on receive:** `pubkyring://migrate?` (or `migrate/?`) with integer `index` and
  `total` and a non-empty `key`. The camera stays open across frames. Each key is tried as a
  lowercased mnemonic first, then as a secret key. Because Ring decodes the whole input first, a `key`
  containing `&` or `+` is cut or altered (`a&b+c` parses as `a`). Real mnemonics and hex secrets
  round-trip.
- **`AnimatedQR` props:** `data: {value}[]`; `cycleInterval` (default 600 ms); optional
  `startCycleInterval`, easing to `cycleInterval` over `transitionDuration` (default 5000 ms); `size`
  (default 250).

Backup *restore* and cloud backup are **not shipped**
([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)). Migrate moves keys between
devices. It is not a backup service.
