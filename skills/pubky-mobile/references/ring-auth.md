# Pubky Ring integration

How a mobile app gets a capability-scoped **grant** through the **Pubky Ring** authenticator
without ever holding the user's key. This page also covers Ring's deeplinks, QR and animated
migrate-frame input, scoped encryption keys, and grant revocation. It covers Ring only. For shared
protocol, follow these links:

- **Grant model, relays, the `pubkyauth://` intent table, the authenticator side:**
  [`auth.md` § Grant auth model](../../pubky/references/auth.md#grant-auth-model),
  [§ Relays](../../pubky/references/auth.md#relays),
  [§ deep links](../../pubky/references/auth.md#pubkyauth-deep-links),
  [§ Authenticator side](../../pubky/references/auth.md#authenticator-side-approving-requests).
  `auth.md` is pinned to `pubky` 0.12.0, so it has no `af`, no `epk`, no `e` action and no
  approve-with-capabilities. For those, read upstream
  [`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).
- **Capability syntax, and why to avoid root `/:rw`:** [`auth.md` § Capabilities](../../pubky/references/auth.md#capabilities).
- **Identity, key string formats, the homeserver model:** [`concepts.md`](../../pubky/references/concepts.md).
- **RN / FFI API surface, `Result`/`isErr()`:** [`react-native.md`](./react-native.md) and
  [`native-ffi.md`](./native-ffi.md). `react-native.md` is pinned to **0.14.0**. It has no
  resumable flows, no `listGrants`/`revokeGrant` and no encryption-key APIs. For 0.15.0, use the
  signatures on this page and your installed typings.

**Upstream (source of truth):**
[`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts) ·
[`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky)
([README](https://github.com/pubky/react-native-pubky/blob/main/README.md),
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)) ·
[pubky-homeserver `docs/AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md) ·
[`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md) ·
[`docs/grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md) ·
[grant-auth migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md).

## Versions and drift

- **Checked against Pubky Ring main `fac51af` (2026-10-22).** The native app version is **2.0**
  (Android `versionName "2.0"`, versionCode 29; iOS `MARKETING_VERSION = 2.0`). `package.json`
  still says 0.0.32. Do not read the app version from it.
- Ring pins **`@synonymdev/react-native-pubky` 0.15.0** (npm `latest`, 2026-10-21). That version
  wraps `pubky-core-ffi`, which depends on `pubky` **0.16.1**. crates.io `pubky` is at **0.16.2**.
  `pubky` 0.16.0 is the first release with scoped encryption keys and HPKE signed approvals.
- **Snippet status:** `pubky-knowledge-base-v2` has no React Native or Ring snippets, so nothing
  here is KB-CI-verified. Every RN snippet below **type-checks under strict `tsc` against the
  published 0.15.0 typings**. **None was run**, because the package is a native bridge. Everything
  is pre-1.0. If this page disagrees with your installed typings, trust the typings.
- **The Ring README is stale.** Its deeplink table leaves out `signin_grant`, `signup_grant`, `af`,
  `epk` and `secret_export`, and its "Input Priority Order" does not match the code. Treat
  `inputParser.ts` as authoritative.
- **`docs/AUTH.md`** documents the x-callback params. It still describes only the legacy
  `pubkyauth:///?relay&caps&secret` URL and the legacy `AuthToken`, and has no `cid`, `cpk`, `af`
  or `epk`.
- **Removed:** Ring `9d1a888` (2026-09-22) deleted the `pubkyring://session?x-success=…`
  root-grant hand-off. Ring no longer recognises `session` links. Use the scoped grant flow.
- To check whether a homeserver or SDK release contains a commit, use `git ls-remote --tags` or
  crates.io. A local clone may only have old tags.

## Two roles: pick the right one

| You are building… | Hold the user's key? | Use |
| :-- | :-- | :-- |
| **A normal app** (almost everyone) | **Never** | `startAuthFlow(caps, clientId)` then `awaitAuthApproval()`. For resumable flows, a custom relay, x-callbacks or encryption keys, use `startGrantAuthFlowWithConfig` + `pollGrantAuthFlow`. Show the URL as a QR code or open it as a deeplink. |
| **A key-holding authenticator like Ring** (rare) | Yes | `parseDeepLink(url)`, then `auth(url, secretKey)` or `authWithCapabilities(url, secretKey, approved)` |

Do not ask for, import or store the user's secret key just to authenticate. The helpers that take a
secret key (`signIn`, `signUp`, `put`, `deleteFile`, `auth`) are for authenticators and key-owning
apps only.

**Authenticator only:** `authWithCapabilities` approves a subset of the request. Copied verbatim
from the 0.15.0 README.

```react-native
import { authWithCapabilities } from '@synonymdev/react-native-pubky';

const authRes = await authWithCapabilities(
  pubkyAuthUrl,
  secretKey,
  '/pub/example/:r'
);
```

- The approved string uses the comma-separated `scope:actions` format. An empty string
  authenticates with no capabilities.
- Every approved scope and action must be covered by the request. You may narrow scopes and drop
  actions, including `e`. Native validation rejects a malformed or excessive approval before
  anything reaches the relay.
- Client identity, relay channel and approval format stay as the link requested. It works on grant
  links and on legacy `signin`/`signup` links
  ([`scoped-encryption-keys.md` § Select capabilities](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md#select-capabilities-on-the-signing-device)).

## Request a scoped grant via Ring (primary path)

This is the react-native-pubky 0.15.0 README `startAuthFlow`/`awaitAuthApproval` example with the
cookie variants removed. Type-checked against 0.15.0, not run.

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

The 0.15.0 signatures that matter for Ring, copied from
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx). This is a
signature listing, not compilable TS. Each line matches the published typings exactly.

```react-native
export async function startAuthFlow(capabilities: string, clientId: string): Promise<Result<string>>; // alias of startGrantAuthFlow
export async function awaitAuthApproval(): Promise<Result<SessionInfo>>; // alias of awaitGrantAuthApproval
export async function startGrantAuthFlowWithConfig(config: GrantAuthFlowConfig): Promise<Result<GrantAuthFlowState>>;
export async function saveGrantAuthFlow(): Promise<Result<GrantAuthFlowState>>;
export async function restoreGrantAuthFlow(state: GrantAuthFlowState): Promise<Result<string>>;
export async function pollGrantAuthFlow(): Promise<Result<GrantSessionInfo | null>>;
export async function awaitGrantAuthFlow(): Promise<Result<GrantSessionInfo>>;
export async function cancelGrantAuthFlow(): Promise<Result<void>>;
export async function signOut(sessionSecret: string): Promise<Result<string>>;
export async function listGrants(sessionSecret: string): Promise<Result<GrantInfo[]>>;
export async function revokeGrant(sessionSecret: string, grantId: string): Promise<Result<string>>;
export async function parseDeepLink(url: string): Promise<Result<PubkyDeepLinkDetails>>;
export async function parseAuthUrl(url: string): Promise<Result<PubkyAuthDetails>>;
export async function auth(url: string, secretKey: string): Promise<Result<string[]>>; // authenticator only
export async function authWithCapabilities(url: string, secretKey: string, approvedCapabilities: string): Promise<Result<string>>; // authenticator only
export async function grantEncryptionKeyScopes(sessionSecret: string): Promise<Result<string[] | null>>;
export async function deriveGrantEncryptionKey(sessionSecret: string, path: string): Promise<Result<Base64Data | null>>;
```

The key types, which match 0.15.0 field for field. `SessionInfo` is `GrantSessionInfo`. Version
note: `GrantSessionInfo` gained `homeserver`, `client_id`, `grant_id`, `token_expires_at`,
`grant_expires_at` and `created_at` in **0.14.1** (`91e0fcc`). 0.14.0 had only `pubky`,
`capabilities` and `grant_secret`. `GrantInfo.capabilities` is one comma-joined string, not an
array.

```react-native
export interface GrantSessionInfo {
  homeserver: string;
  pubky: string;
  client_id: string;
  capabilities: string[];
  grant_id: string;
  token_expires_at: number;
  grant_expires_at: number;
  created_at: number;
  grant_secret: string;
}

export interface GrantInfo {
  grant_id: string;
  client_id: string;
  capabilities: string;
  issued_at: number;
  expires_at: number;
}

export interface GrantAuthFlowConfig {
  capabilities: string;
  clientId: string;
  /** Presence selects signup; absence selects signin. */
  homeserver?: string;
  signupToken?: string;
  relay?: string;
  /** Exactly 32 bytes encoded as base64. */
  clientSecret?: Base64Data;
  /** Exactly 32 bytes encoded as base64. */
  clientKeySecret?: Base64Data;
  /** Use signed approvals when requesting scoped encryption keys. */
  approvalFormat?: 'bareGrant' | 'signedApprovalV1';
  xSource?: string;
  xSuccess?: string;
  xError?: string;
  xCancel?: string;
}

export interface GrantAuthFlowState {
  authorizationUrl: string;
  /** Sensitive proof-of-possession key material encoded as base64. */
  clientKeySecret: Base64Data;
  /** Sensitive temporary HPKE recipient key encoded as base64. */
  approvalKeySecret?: Base64Data;
}
```

Gotchas:

- **`clientId`:** see [`auth.md` § Grant auth model](../../pubky/references/auth.md#grant-auth-model).
  Ring shows it as the consent title and in its grant list, so keep it stable and readable.
- **The simple helper is fixed.** `startAuthFlow`/`startGrantAuthFlow` always use the SDK default
  relay, the `signin` kind and the bare-grant format. Use `startGrantAuthFlowWithConfig` to pick a
  relay, sign up through the flow (`homeserver`/`signupToken`), request `signedApprovalV1`, attach
  x-callbacks, or supply your own client secret or key.
- **There is one global flow slot.** `startAuthFlow`, `startGrantAuthFlowWithConfig` and
  `restoreGrantAuthFlow` share it, so starting or restoring a flow **silently replaces** any
  pending one. `awaitAuthApproval`/`awaitGrantAuthFlow` take the flow out of the slot. With nothing
  pending, they fail with `No auth flow in progress` (legacy await) or
  `No Grant auth flow is in progress` (new APIs).
- **Do not use the `*Cookie` variants** (`startCookieAuthFlow`, `signInCookie`, …). Cookie auth is
  deprecated and insecure ([pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)).

## Resumable flows (survive an app kill)

New in 0.15.0. The OS may kill your app while the user is in Ring. To be able to resume, save the
flow state and poll instead of awaiting.

- **Persistence and cancellation work only while you drive the flow with `pollGrantAuthFlow`.**
  Once `awaitGrantAuthFlow` is waiting, the pending call owns the native flow, and the flow can no
  longer be saved or cancelled. In the README's words: "Use polling when an application needs
  resumability or cancellation."
- `pollGrantAuthFlow` returns `null` while the flow is pending and the session once it is approved.
  After a pending result or an error, it puts the flow back in the slot.
- `cancelGrantAuthFlow` only clears the local slot.
- `saveGrantAuthFlow` fails with `Grant flow does not use an exportable local signer` when the flow
  has no local key. `startGrantAuthFlowWithConfig` already returns the state, so you rarely need it.
- **`GrantAuthFlowState` holds secrets.** `clientKeySecret` is the PoP key and `approvalKeySecret`
  is the HPKE recipient key. Store the state only in the Keychain or Keystore. Delete it when the
  flow completes, fails or is cancelled, and never log it.
- `restoreGrantAuthFlow` checks that the saved key matches the URL's `cpk`. After an SDK upgrade, a
  saved signed-approval flow whose URL has `secret` but no `epk` cannot be resumed. Restart it.
- Rust/JS resume semantics: [`auth.md` § Resume](../../pubky/references/auth.md#resume-after-reload-or-restart).

**AUTHORED** (not from an upstream source). Type-checked under strict `tsc` against the 0.15.0
typings; not run. `secureStore` is a placeholder for Keychain/Keystore storage.

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

Poll on a timer and set your own deadline. When the deadline passes, call `cancelGrantAuthFlow()`
and delete `pendingFlow`, so that stale PoP and HPKE secrets do not stay in storage.

## Scoped encryption keys (`e`, `pubky` 0.16+)

The model and its risks are canonical upstream in
[`docs/scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).
What it means for a Ring integration:

- Request the `e` action on a scope (for example `/pub/chat/:rwe`) **and** set
  `approvalFormat: 'signedApprovalV1'` in `startGrantAuthFlowWithConfig`. If you request `e`
  without it, `startGrantAuthFlowWithConfig` itself fails with
  `encryption key permission requires af=v1` and no link is produced. Signers also reject such links
  at parse time.
- On approval, the signer derives one symmetric key for each approved scope and delivers the keys
  inside an HPKE-encrypted signed approval. `e` grants no storage access, and `r`/`w` deliver no
  keys.
- After approval, `grantEncryptionKeyScopes(grant_secret)` returns `null` for a bare grant and `[]`
  for a signed approval with no keys (the user declined `e`).
  `deriveGrantEncryptionKey(grant_secret, path)` returns a 32-byte base64 key for an approved
  **file** path. It returns `null` for a bare grant, and fails with `OutsideScope` or
  `DirectoryPath` for an unapproved path or a directory path.
- **Ring (`fac51af`) supports `af=v1`/`epk` links and `e`.** On the manual consent sheet it shows a
  per-scope switch and a key warning, and sends the reduced set. **Handle `[]`**, because the user
  may approve `r`/`w` and decline `e`. **With auto-auth on, Ring approves the full request,
  including `e`,** with no switch and no warning. Do not assume a human saw your `e` request.
- **Keys are permanent.** They derive from the identity secret. Revoking or expiring the grant does
  not take them back, and there is no rotation. A key for a directory covers every file below it,
  and `e` on `/` yields every key the user will ever have. Request the narrowest scope.
- **Roll out in this order: homeservers, then signers, then apps.** Older homeservers reject grants
  that contain `e`. Older signers cannot open `af=v1` links, because those links have no `secret`.
  The SDK does not fall back to a bare grant, so an older Ring install cannot complete the flow.
- **Silent hang:** if the approval exceeds the relay body limit, the relay returns HTTP 413 and the
  app is never notified. Poll with your own timeout. Do not use an unbounded await.
- Encrypting data with these keys is **your own crypto**. The homeserver stores ciphertext like any
  other bytes, and encrypted storage is not a shipped primitive. See
  [`shipped-vs-planned.md` § App-side ciphertext](../../pubky/references/shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto).

## Store and revoke the `grant_secret`

- **`grant_secret` is a bearer credential.** It grants access until the grant is revoked or
  expires. Store it only in the Keychain (iOS) or Keystore (Android). **Never** put it in
  AsyncStorage, Redux, logs or analytics.
- **If the grant carries `e`, the secret stays sensitive after revocation or expiry.** For a signed
  approval, `grant_secret` is a v2 credential that embeds the signed approval, including the
  permanent encryption keys. `grantEncryptionKeyScopes`/`deriveGrantEncryptionKey` read the keys
  from it offline. After `signOut` or expiry, delete it. Never log or leak it.
- `putWithSession`, `deleteWithSession`, the `session*` storage APIs, `signOut`,
  `revalidateSession`, `listGrants` and `revokeGrant` restore a session from the secret. They accept
  a `grant_secret` or a legacy cookie `session_secret`.
- **One grant, one client.** A grant has one current bearer, and each exchange replaces it.
  Restoring a session exchanges the grant for a fresh bearer, so two clients holding copies of one
  `grant_secret` invalidate each other's bearers. Do not copy a `grant_secret` between apps or
  devices. Run a separate flow for each app or device
  ([`grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md)).
- **To revoke your own grant,** call `signOut(grant_secret)`, then delete your stored copy.
- **Listing or revoking other grants** (`listGrants`, `revokeGrant`, available in RN since 0.14.1)
  needs a **root-capability** session. A non-root session gets `403`, so a normal scoped app cannot
  do this. Skip your own `grant_id`, or you revoke the management session. Shared semantics:
  [`auth.md` § List and revoke grants](../../pubky/references/auth.md#list-and-revoke-grants).
  The snippet below is the 0.15.0 README example with `managementSession` typed. The README's
  untyped JS version fails strict TS (TS7006). This version type-checks strict against 0.15.0; not
  run. The README's sample output shows a `/priv/example/:rw` capability. `/priv` is **alpha, not
  for production, and not encrypted from the operator** (a homeserver admin can read and write it).
  See [`shipped-vs-planned.md` § `/priv`](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha).

```react-native
import { listGrants, revokeGrant, type GrantSessionInfo } from '@synonymdev/react-native-pubky';

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

- **Users can revoke your app's access inside Ring** (Ring `b3d74d8`, #369). For each signed-up
  pubky, Ring lists third-party grants using its root session and hides the grants of its own
  sessions. Each grant shows `client_id`, issue date, expiry ("Never expires" when
  `expires_at <= 0`) and permissions, and the user can revoke it. **Expect your grant to
  disappear.**
- **Tell revoked apart from out-of-scope:**
  - A `401`, or `revalidateSession` failing with `Session is no longer valid`, means the grant was
    revoked or expired. Delete the stored secret and start a new flow.
  - A `403` means your capability does not cover that path or action (for example an `e`-only scope
    or a write outside scope). **Keep the secret** and fix the request or ask for a wider grant.
  - Keep a sign-out option in your own app as well.
- **Exception:** grant management appears only for pubkys that are signed up and not adopted from
  another app (`signedUp && !sourceApp`). Pubkys adopted from Bitkit show no grant list.
- Legacy `AUTH.md` tokens have no delegation (the issuer is always the pubky), and that spec leaves
  session expiry out of scope.

## Deeplink schemes and intents

Ring registers both `pubkyauth` and `pubkyring` (iOS `CFBundleURLSchemes`, Android
intent-filter). The SDK marks `pubkyring` as deprecated but still parses it. **Emit `pubkyauth://`
for auth and signup links.** `migrate` exists only as `pubkyring://`.

The intent is the URL **host**: `signin`, `signup`, `direct_signup`, `signin_grant`,
`signup_grant` or `secret_export`. An empty host (`pubkyauth:///?…`) means `signin`. The canonical
intent table is in [`auth.md` § deep links](../../pubky/references/auth.md#pubkyauth-deep-links).
The table below adds the 0.16 relay params and what Ring does:

| Intent (host) | Required params | What Ring `fac51af` does |
| :-- | :-- | :-- |
| `signin_grant` | `caps`, `relay`, `cid`, `cpk`, plus **either** `secret` (bare grant) **or** `af=v1` + `epk` (signed approval) | Shows auth consent. |
| `signup_grant` | the `signin_grant` params + `hs` [+`st`] | Creates a key, signs up, then shows consent (fixed since `f142436`). |
| `signin` (legacy cookie; also `pubkyauth:///?`) | `caps`, `relay`, `secret` | Shows auth consent. |
| `signup` (legacy cookie) | `caps`, `relay`, `secret`, `hs` [+`st`] (**all required**) | Signs up, then shows consent. |
| `direct_signup` | `hs` [+`st`] | Creates an account with no app authorization. **Use this for account-only links.** |
| `secret_export` | `secret` | Routes to Import, which **fails** (code reading, not run). The FFI returns `secret` as base64url, and Ring passes it to `getPublicKeyFromSecretKey`, which hex-decodes it ([`keypair.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c/src/keypair.rs#L7-L11)). Ring shows "failed to get public key". |

Relay-channel rules for grant links
([`query_params.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/query_params.rs),
[`grant_relay_channel.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/grant_relay_channel.rs)):

- `af` is optional. When it is absent, the format is a bare grant. `af=v1` means
  `SignedApprovalV1`. Any other value, an empty value or a duplicate `af` is rejected
  (`InvalidQueryParameter("af")`).
- `epk` is a 32-byte X25519 HPKE public key, base64url without padding. With `epk`, leave `secret`
  out. Both together are rejected (`InvalidQueryParameter("secret")`), and so is `af=v1` without
  `epk` (`InvalidQueryParameter("epk")`).
- `secret` is 32 bytes, base64url, no padding. The HPKE channel id is derived from `epk` and hides
  `epk` from the relay. The legacy channel id is derived from `secret`.
- SDK-built links always take one of two shapes: `secret` (bare grant) or `epk` + `af=v1` (signed).
  The parser also accepts a bare grant with only `epk`, but the SDK never emits one, and **Ring
  rejects it** (see below).
- **`hs` and `cpk` must be the bare z-base-32 key (`publicKey.z32()`), not the `pubky<z32>` display
  string.** The SDK parses them with `PublicKey::try_from_z32`, which does not strip a `pubky`
  prefix. `cid` goes through `ClientId::new`, `relay` must be a URL, `caps` is required, and `st` is
  optional.

Ring's own check is stricter. A grant link counts as relay transport only if it has `relay` **and**
either `secret` **or** both `approval_format === 'signed_approval_v1'` and `ephemeral_public_key`.
A link that fails this check falls through:

- a signin-type link becomes **Unknown**;
- a signup-type link with `hs` is **downgraded to DirectSignup**. Ring creates the account but does
  no app authorization, so your flow never completes.

Example links from SDK unit tests, for recognition only. **Never build these by hand.** Use the URL
your flow returns, because `cpk` (and `epk`) must match keys that the flow holds.

```text
pubkyauth://signin_grant?caps=/pub/pubky.app/:rw&relay=https://httprelay.pubky.app/inbox/&secret=kqnceEMgrNQM_xi06oQXjA3cJHX_RQmw1BY6JE1bse8&cid=franky.pubky.app&cpk={client_pk_z32}
pubkyauth://signin_grant?caps=/:rw&relay=http://localhost/inbox&cid=test.app&cpk={client_pk_z32}&af=v1&epk={base64url_32_bytes}
```

Parsing notes:

- In 0.15.0, `PubkyAuthDetails` and `PubkyDeepLinkDetails` gained `approval_format`
  (`'bare_grant' | 'signed_approval_v1'`) and `ephemeral_public_key`. 0.15.0 also made `secret`
  **optional on `PubkyAuthDetails`** (it was already optional on `PubkyDeepLinkDetails`), because
  signed approvals carry `epk` instead. Authenticators must not assume `secret` is present.
  `x_source`/`x_success`/`x_error`/`x_cancel` were already on both types in 0.14.x.
  `PubkyDeepLinkDetails` has `scheme: 'pubkyauth' | 'pubkyring'` and a required `kind`. On
  `PubkyAuthDetails`, `kind` is missing only when the native binary is older than 0.9.1.
- The Ring README's "Legacy Direct Signup" row (`pubkyauth://signup?hs=..[&st=..]`) fails native
  parsing, because legacy `signup` also requires `caps`, `relay` and `secret`. Ring treats it as
  Unknown. Emit `direct_signup` instead.
- Before parsing, Ring normalizes the input. It strips a `pubkyring://` prefix in front of
  `pubkyauth://`, fixes `pubkyauth///` to `pubkyauth:///`, rewrites
  `pubkyring://signin|signup|direct_signup[/]?` to `pubkyauth://…`, and collapses
  `pubkyauth://<intent>/?` to `…?`. **Do not rely on this. Emit well-formed URLs.**

## x-callback return to your app

Set the callbacks with the `xSource`/`xSuccess`/`xError`/`xCancel` fields of
`startGrantAuthFlowWithConfig`. The SDK encodes each value once (spaces become `%20`, never `+`) and
never emits the legacy `callback` key. Parameter semantics:
[`AUTH.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/AUTH.md).

| Param | What Ring does with it |
| :-- | :-- |
| `x-source` | Consent title "Authorize {x-source}", **only if the link has no `cid`**. `cid` wins. |
| `x-success` | Opened unchanged after success. |
| `x-error` | Opened with `errorCode` and `errorMessage` appended (with `&` if the URL already has `?`). |
| `x-cancel` | Opened unchanged after a deny or the 60 s consent timeout. **Never opened on the auto-auth path.** |

- **Do not put nested queries containing `&` in callbacks on auth or signup links.** This comes
  from code reading, not a run. Ring decodes the **whole** input with `decodeURIComponent` up to 3
  times, then passes it to `parseDeepLink`, whose native parser splits the query on `&`. So
  `x-cancel=bitkit%3A%2F%2Fcb%3Fnonce%3Dabc%26reason%3Duser` is cut to `bitkit://cb?nonce=abc`, and
  percent-escapes you need to keep are lost too. Ring's unit tests that appear to cover this mock
  `parseDeepLink`, so they prove nothing. Invite links do round-trip, because they go through
  Ring's own decode-once parser on the still-encoded query.
- `callback` is still parsed as a fallback for `x-success`. Emit `x-success`.
- Callbacks are **untrusted navigation hints**, not proof of approval. Authentication completes over
  the encrypted relay. Only a session returned by `awaitAuthApproval`/`pollGrantAuthFlow` proves
  it.
- If your scheme is not registered, `Linking.openURL` fails, Ring ignores the error, and the user
  stays in Ring.
- Error codes Ring sends: `AUTH_FAILED` (also from the auto-auth path), `AUTH_ERROR`,
  `SIGNUP_FAILED`, `SIGNUP_ERROR`, `OFFLINE`, `INVITE_FAILED`, `INVITE_ERROR`.
  `SESSION_FAILED`/`SESSION_ERROR` were removed along with the session hand-off.

## What Ring does when a link arrives (predicting UX and timeouts)

This describes Ring internals at `fac51af`, which can change without notice.

- **Consent sheet (manual path).**
  - Requires a pubky to be selected in Ring. The title is "Authorize {cid}", else
    "Authorize {x-source}", else "Authorize". After success the title is "Authorized {app}", or a
    generic success title when the link has no `cid` or `x-source`.
  - Each scope is listed as Read and/or Write, depending on whether its permission contains `r` or
    `w`. A scope with `e` also gets a key row and a per-scope switch.
  - **The user can decline only `e`.** Ring has no UI to narrow `r`/`w` or drop scopes. The user
    either accepts your `r`/`w` request in full or denies it.
  - If no requested capability has any action, Ring shows an "Identity verification" consent
    ("Prove you control this pubky"; no data access) in place of a permission list.
  - **If the user does nothing for 60 s, Ring denies automatically** and opens `x-cancel`.
- **Auto-auth (user setting).** Ring skips the sheet and calls `auth(url, secretKey)` with no
  approved subset. That **approves the full request, including `e`**, with no per-scope switch, no
  key warning, no 60 s auto-deny and no `x-cancel`.
- **Approval (manual path).** If any requested capability contains `e`, Ring strips `e` from the
  declined scopes, keeps `r`/`w`, drops scopes left with no actions, and calls
  `authWithCapabilities(url, secretKey, approved)`. Otherwise it calls `auth(url, secretKey)`,
  which approves everything requested.
- **`performAuth`** races a **20 s timeout**. It checks the network, loads the key, and signs up to
  the homeserver first if the pubky is not yet signed up. Then it calls `auth` or
  `authWithCapabilities`. On failure it signs in again (which creates a **new root session under
  Ring's client id**) and retries once. Finally it republishes the homeserver record in the
  background, but only if signup did not already republish and a homeserver is known.
- **Ring's client id** is its bundle/application id: iOS `app.pubkyring`, Android `to.pubky.ring`.
  Ring uses it for its own `signUp`/`signIn` root sessions.
- **Signup and direct signup.**
  - Without network, Ring returns `OFFLINE`.
  - Ring reuses a pubky already tied to the same `st`, and skips signup if that pubky is already
    signed up. Otherwise it generates a mnemonic and keypair and calls
    `signUp(secretKey, hs, st, appApplicationId)`.
  - If signup fails and other signed-up pubkys exist, Ring falls back to auth consent, with the
    newly generated pubky as context.
  - For `signup_grant`, Ring rebuilds a `signin_grant` link that keeps `cid` and `cpk`, plus `af=v1`
    and `epk` for signed approvals. The x-callback params travel separately.
  - `direct_signup` stops after the account is created.
- **Ring's own session storage is a pattern worth copying.** `PubkySession` in Redux holds only
  `{id, grant_id, capabilities, created_at}`. The secrets live in the Keychain, keyed by a uuid v5
  of `grant_secret`. Ring discards a stored session when `revalidateSession` reports
  `Session is no longer valid` or `Failed to import session`.
- **Ring ↔ Bitkit shared keys are not an integration surface.** Ring and Bitkit share pubky keys
  through a native SharedPubky store: a signature-permission ContentProvider on Android and a
  keychain access group on iOS. Access is gated by the signing key and team, so third-party apps
  cannot use it. Adopted pubkys can authorize, but Ring refuses homeserver signup for them, hides
  their grant management and skips them in migrate export.

## QR and clipboard input

Ring accepts any of these, scanned or pasted: a deeplink, a 12-word BIP39 phrase, a secret key, an
invite code `XXXX-XXXX-XXXX` or `…/invite/XXXX-XXXX-XXXX`, and (QR only) animated multi-frame
migrate codes.

Check order in
[`inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts),
which differs from the README:

0. Trim, snapshot the still-encoded query, then run `decodeURIComponent` on the whole input up to 3 times.
1. `pubkyring://migrate?` (also `migrate/?`).
2. Native `parseDeepLink` after normalization. The result is DirectSignup, Signup (`signup`/`signup_grant` with `hs` and relay transport), Auth (`signin`/`signin_grant` with relay transport) or Import (`secret_export`).
3. Strip `pubkyring://`.
4. An invite URL, `/invite/XXXX-XXXX-XXXX`.
5. A standalone invite code.
6. An import: tried as a mnemonic first, then as a secret key.
7. A retry as a lowercased 12-word phrase.
8. Unknown.

There is no `session?` step any more. On import, Ring decodes input that contains `://` or `%20`,
strips `pubkyring://`/`pubkyauth://`, and turns runs of `-`, `_` and `+` into spaces.

## Key migration: animated QR (`pubkyring://migrate`)

Ring shows one frame per key and cycles them with `AnimatedQR`. Byte copy of Ring `fac51af`
[`MigrateQRCode.tsx`](https://github.com/pubky/pubky-ring/blob/main/src/screens/MigrateQRCode.tsx);
type-checked, and the frames round-trip through a replica of Ring's migrate parser. The format has
not changed since `f142436`, except that pubkys adopted from another app (such as Bitkit) are now
skipped.

```react-native
const migrateFormattedData = useMemo(() => {
  return keyValues.map((value, index) => ({
    value: `pubkyring://migrate?index=${index}&total=${keyValues.length}&key=${encodeURIComponent(value)}`,
  }));
}, [keyValues]);

// <AnimatedQR data={isRevealed ? migrateFormattedData : placeholderData} startCycleInterval={200} cycleInterval={600} transitionDuration={60000} size={qrSize} />
```

- **Frames are plaintext secrets.** How Ring chooses `key`:
  - Backup preference `recoveryPhrase` with a mnemonic present: the mnemonic.
  - Backup preference `encryptedFile`: the **raw, unencrypted secret key**. (`encryptedFile` is
    only a preference label. Nothing is encrypted.)
  - Otherwise: the mnemonic if there is one, else the raw secret key.

  Anyone who captures the frames owns the identity. Ring's precautions: the QR stays blurred until
  "Tap to reveal", Android sets `FLAG_SECURE` (iOS has no equivalent), brightness goes to maximum,
  and the code hides when the app changes state (and on `blur` on Android). If you produce or
  consume these frames, take the same precautions and never log them.
- **What Ring accepts on receive:** `pubkyring://migrate?` (or `migrate/?`) with integer `index`
  and `total` and a non-empty `key`, which is decoded again after `URLSearchParams`. Migrate is
  checked before native deeplink parsing, and the camera stays open across frames. Each key is tried
  as a lowercased mnemonic first, then as a secret key. Because Ring decodes the whole input first,
  a `key` containing `&` or `+` would be cut or altered. Real mnemonics and hex secrets round-trip.
- **`AnimatedQR` props:** `data: {value}[]`; `cycleInterval` (default 600 ms); optional
  `startCycleInterval`, which eases to `cycleInterval` over `transitionDuration` (default 5000 ms);
  `size` (default 250).

Backup *restore* and cloud backup are **not shipped**
([`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)). Migrate moves keys from
one device to another. It is not a backup service.
