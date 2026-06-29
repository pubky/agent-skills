# Pubky Ring integration

How a third-party mobile app gets a capability-scoped session through the **Pubky Ring**
authenticator — without ever holding the user's key — and how Ring itself parses the
deeplinks, QR frames, and migrate payloads.

This file owns the **Ring-specific** surface: the `pubkyauth://` / `pubkyring://` deeplink
schemes, the React Native calls that drive a Ring auth flow, x-callback inter-app return,
animated-QR key migration, and session revoke. The **protocol** underneath is shared and
documented canonically elsewhere — do not expect it restated here:

- **The `pubkyauth` handshake** — relay subscribe + `channel_id` derivation, `AuthToken`
  encoding/verification, the ~3-minute validity window, why the token is encrypted:
  [`../../pubky/references/auth.md`](../../pubky/references/auth.md) (canonical).
- **Capability-scoped sessions, the single-shared-cookie caveat, write-vs-Nexus-read split:**
  [`../../pubky/references/concepts.md`](../../pubky/references/concepts.md). Its
  [Stability and known limits](../../pubky/references/concepts.md#stability-and-known-limits)
  section covers the single cookie ([pubky-core#122](https://github.com/pubky/pubky-core/issues/122))
  and the ~3-minute token window, and itself defers the full flow to `auth.md`.
- **Method surface, `Result` handling, the `<z32>:<cookie>` session-secret format:**
  [`./react-native.md`](./react-native.md), [`./native-ffi.md`](./native-ffi.md).

**Upstream (summarize, don't mirror):**
[pubky-ring README](https://github.com/pubky/pubky-ring/blob/main/README.md) ·
[`pubky-ring/src/utils/inputParser.ts`](https://github.com/pubky/pubky-ring/blob/main/src/utils/inputParser.ts) ·
[`@synonymdev/react-native-pubky`](https://www.npmjs.com/package/@synonymdev/react-native-pubky)
([README](https://github.com/pubky/react-native-pubky), [`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)) ·
[pubky-core `docs/AUTH.md`](https://github.com/pubky/pubky-core/blob/main/docs/AUTH.md).

> **Drift warning.** Versions pinned at research time: `@synonymdev/react-native-pubky`
> **0.13.0** (git `84ec77af`), pubky-ring git `ce0e083145b0`, pubky-core docs `ba6d69c1`. All
> are pre-1.0 / v0.x — deeplink param names and flow change. Trust your installed typings and
> the linked sources over any table here.

## Two roles — pick the right one

**Integrating app (almost everyone).** You request capabilities and receive a session; you
**never see the user's secret key**. Use `startAuthFlow` + `awaitAuthApproval`. Present the
returned `pubkyauth://` URL as a QR code, or open `pubkyring://…` to hand off to Ring.

**Authenticator (rare — only if you are building a key-holding wallet like Ring).** You hold
the secret key, parse the inbound `pubkyauth://` URL, and sign + encrypt the `AuthToken`. Use
`parseAuthUrl` + `auth(url, secretKey)`. A normal app must **not** do this.

## Request a session via Ring (primary path)

```react-native
import { startAuthFlow, awaitAuthApproval } from '@synonymdev/react-native-pubky';

// 1. Request capabilities; get an auth URL to show the user (QR / deeplink).
const startRes = await startAuthFlow('/pub/att.app/:rw');
if (startRes.isErr()) {
  console.log(startRes.error.message);
  return;
}
const authUrl = startRes.value; // present as QR or open pubkyring://...

// 2. Wait for the user to approve in Pubky Ring.
const approvalRes = await awaitAuthApproval();
if (approvalRes.isErr()) {
  console.log(approvalRes.error.message);
  return;
}
console.log(approvalRes.value); // { pubky, capabilities, session_secret }
```

Signatures (react-native-pubky 0.13.0). Every function returns a `@synonymdev/result`
`Result` — check `.isErr()`, then read `.value` / `.error.message`:

```react-native
export async function startAuthFlow(capabilities: string): Promise<Result<string>>;
export async function awaitAuthApproval(): Promise<Result<SessionInfo>>;

export interface SessionInfo {
  pubky: string;
  capabilities: string[];
  session_secret: string;
}
```

`SessionInfo.session_secret` is a `<z32>:<cookie>` **bearer credential** (format in
[`./native-ffi.md`](./native-ffi.md)) — treat it like a password. It is what you pass to
`putWithSession` / `deleteWithSession` / `signOut`.

## Deeplink schemes and the single parser

Ring registers two custom URL schemes: **`pubkyring://`** and **`pubkyauth://`**. Every input
— deeplink, QR scan, clipboard paste — flows through one entry point,
`parseInput(rawInput, source)` in `src/utils/inputParser.ts`. A `pubkyring://` URL may also
**wrap** a `pubkyauth` URL (e.g. `pubkyring://pubkyauth:///?…`); the parser strips the
`pubkyring://` wrapper first.

**Parse priority — first match wins:**

| # | Form | Example shape |
| :-- | :-- | :-- |
| 1 | Migrate | `pubkyring://migrate?index={n}&total={total}&key={key}` |
| 2 | Signup | `pubkyring://signup?hs=…&st=…&relay=…&secret=…&caps=…` (or `pubkyauth://signup?…`) |
| 3 | Session | `pubkyring://session?x-success=…&x-error=…&x-cancel=…&x-source=…` |
| 4 | Sign-in | `pubkyring://signin?caps=…&secret=…&relay=…` |
| 5 | Auth | `pubkyauth:///?relay=…&secret=…&caps=…` |
| 6 | Invite code in URL | `…/invite/XXXX-XXXX-XXXX` |
| 7 | Standalone invite code | `XXXX-XXXX-XXXX` |
| 8 | Recovery phrase | 12 BIP39 words |
| 9 | Encrypted secret key | (opaque string) |
| 10 | Unknown | fallback |

**Auth** — `pubkyauth:///?relay={url}&secret={secret}&caps={caps}`. `relay` = HTTP relay base
URL; `secret` = the 3rd-party app's client secret (`base64url` of 32 random bytes); `caps` =
comma-separated capabilities. Example from pubky-core `AUTH.md`:

```text
pubkyauth:///?relay=https://httprelay.pubky.app/inbox&caps=/pub/pubky.app/:rw,/pub/example.com/nested:rw&secret=mAa8kGmlrynGzQLteDVW6-WeUGnfvHTpEmbNerbWfPI
```

**Sign In** — `pubkyring://signin?caps=…&secret=…&relay=…` (same params as Auth). The parser
rewrites it to `pubkyauth:///?{query}` internally before parsing; a trailing-slash `signin/?`
is normalized to `signin?`.

**Signup** — `pubkyring://signup?hs={homeserver}&st={signup_token}&relay=…&secret=…&caps=…`
(also accepted as `pubkyauth://signup?…`). `hs` = homeserver public key; `st` = invite/signup
token and is **OPTIONAL** (homeservers without invite requirements omit it). Routed to the
Signup action **only if `hs` is present** — a signup link missing `hs` falls through to auth
parsing. The handler creates a new keypair, signs up to the homeserver, then forwards into the
auth/consent flow.

**Session** — lets an external app (e.g. Bitkit) ask Ring to sign in and hand a session back.
Modern form above; legacy form documented in the README is
`pubkyring://session?callback={callback_url}` (`callback` maps to `x-success` as a fallback).
The session action **REQUIRES** an `x-success` (or legacy `callback`) URL containing `://` or
it is rejected. On success Ring opens the `x-success` URL with `pubky`, `session_secret`, and
`capabilities` (comma-joined) appended as query params.

**Migrate** — `pubkyring://migrate?index={n}&total={total}&key={key}`. Bulk key transfer
between Ring installs; checked **first** (before protocol stripping); `migrate/?` is normalized
to `migrate?`. See [Key migration](#key-migration-animated-qr) below.

## Capabilities (Ring view)

Format is `scope:actions` (e.g. `/pub/pubky.app/:rw`), comma-separated. The full model —
grammar, trailing-slash significance, no string-prefix matching, the typed builders — lives in
[auth.md → Capabilities](../../pubky/references/auth.md#capabilities); don't restate it. Ring
renders each capability as a path row with **Read / Write** labels in its consent UI. The
native `parseAuthUrl` returns capabilities as `{ path, permission }` objects; Ring flattens
them back to `` `${path}:${permission}` `` strings.

## relay + secret (summary)

The 3rd-party app generates a 32-byte `client_secret`, subscribes to the relay channel
`channel_id = base64url(hash(client_secret))`, and embeds `relay` (the base URL, **without**
`channel_id`) + `secret=base64url(client_secret)` in the `pubkyauth` URL. Ring signs +
**encrypts** the `AuthToken` with that secret and POSTs it to `relay + channel_id`; the app
decrypts with its `client_secret`. Encryption is **required** because the `AuthToken` is a
bearer token — the relay must never be able to use it. Full handshake:
[auth.md](../../pubky/references/auth.md). When you call `startAuthFlow`, the SDK does all of
this for you — you only handle the returned URL and the resulting `SessionInfo`.

## x-callback return (inter-app)

For an external app to regain control after Ring finishes (x-callback-url convention):

- **`x-source`** — calling app name; rendered in the consent title as "Authorize {app}".
- **`x-success`** — opened on approval (session-flow extras appended).
- **`x-error`** — opened on failure, with `errorCode` + `errorMessage` appended.
- **`x-cancel`** — opened on user deny / timeout.
- legacy **`callback`** — accepted as a fallback for `x-success`.

Ring opens these via React Native `Linking.openURL`; errors from unregistered schemes are
swallowed.

> **GOTCHA — never multi-decode callback URLs.** `parseInput` URL-decodes input up to **3
> passes** to survive double-encoding, but it snapshots the **original still-encoded** query
> string (`rawEncodedQuery`) for x-callback extraction. This is deliberate: a callback URL
> whose inner `?` / `=` / `&` are percent-encoded (`%3F` / `%3D` / `%26`) must round-trip
> byte-for-byte after **exactly one** decode, because callers like Bitkit verify a nonce in the
> callback URL they originally supplied. If you build the return URL, encode it once and expect
> exactly one decode.

## Consent flow and timeouts

On a manual (non auto-auth) request Ring shows a `ConfirmAuth` sheet: the requested
capabilities (path + Read/Write), the selected pubky, and a trust warning. The title is
"Authorize {x-source}" when `x-source` is present (i18n key `authorizeForApp`).

- **Auto-deny timeout: 60000 ms** (`CONFIRM_AUTH_TIMEOUT_MS`) — on timeout or Cancel it calls
  `openXCancel`.
- **`performAuth` network timeout: 20000 ms** (`TIMEOUT_MS`).
- **Auto-auth** (a user setting) skips the sheet entirely.

## Signup deeplinks and homeserver keys

The `hs` param is a **bare z-base32** homeserver public key — i.e. `publicKey.z32()`, **not**
the `pubky<z32>` display string from `.toString()`. Ring's built-in homeservers:

| Constant | Bare z-base32 key |
| :-- | :-- |
| `PRODUCTION_HOMESERVER` (default) | `8um71us3fyw6h8wbcxb5ar3rwusy1a6u49956ikzojg3gcwd1dty` |
| `STAGING_HOMESERVER` | `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` |

## Authenticator side (only if building a wallet)

If you are building a key-holding authenticator (not a normal app), you parse and approve
inbound requests yourself.

```react-native
export type Capability = { path: string; permission: string };

export type PubkyAuthDetails = {
  relay: string;
  capabilities: Capability[];
  secret: string;
  kind?: 'signin' | 'signup';
  homeserver?: string;   // bare z-base32 from `hs`
  signup_token?: string; // from `st`
};

export async function parseAuthUrl(url: string): Promise<Result<PubkyAuthDetails>>;
export async function auth(url: string, secretKey: string): Promise<Result<string[]>>;
```

> **GOTCHA — `PubkyAuthDetails.kind`.** A legacy `pubkyauth:///?…` URL parses as
> `kind='signin'`. Well-formed signup links (those carrying `hs`) are routed to the **Signup**
> action *before* reaching this parse — so seeing `kind='signup'` from `parseAuthUrl` means a
> **malformed** signup link that was missing its homeserver, not a normal signup. `kind` is
> absent only against a pre-0.9.1 native binary.

`auth(url, secretKey)` parses the `pubkyauth` URL, signs an `AuthToken` with the user's key,
encrypts it with the embedded client secret, POSTs it to the relay channel, and returns the
granted capability strings:

```react-native
import { auth } from '@synonymdev/react-native-pubky';

const authRes = await auth(
  'pubkyauth:///?caps=/pub/pubky.app/:rw,/pub/foo.bar/file:r&secret=U55XnoH6vsMCpx1pxHtt8fReVg4Brvu9C0gUBuw-Jkw&relay=http://167.86.102.121:4173/',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
);
if (authRes.isErr()) {
  console.log(authRes.error.message);
  return;
}
console.log(authRes.value);
```

## Sessions: revoke and re-auth

`signOut(sessionSecret: string): Promise<Result<string>>` revokes a session at the homeserver.
Ring's `signOutOfHomeserver(pubky, sessionSecret, dispatch)` calls it, then drops the session
from local state. The `sessionSecret` is the `session_secret` from `SessionInfo` (returned by
`signIn` / `signUp` / `awaitAuthApproval`), in `<z32>:<cookie>` format — a bearer credential.

```react-native
import { signUp, signIn, signOut, getHomeserver } from '@synonymdev/react-native-pubky';

// Standard signup
const signUpRes = await signUp(secretKey, 'pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo');
// Signup with token (gated homeservers)
const signUpWithTokenRes = await signUp(secretKey, 'pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo', 'your_signup_token');
// Sign in
const signInRes = await signIn(secretKey);
// Resolve a pubky's homeserver
const homeserverRes = await getHomeserver(publicKey);
```

`signUp(secretKey, homeserver, signupToken?)`'s third arg is the gated-homeserver invite token
— pass it or omit it. (Signup-token issuance is the homeserver operator's domain;
[auth.md → Signup tokens](../../pubky/references/auth.md#signup-tokens) links it.)

> **Single shared cookie** ([pubky-core#122](https://github.com/pubky/pubky-core/issues/122)):
> signing into App B currently overwrites App A's session — plan re-auth UX around this until
> the JWT/grant rework lands. Canonical:
> [concepts.md → Stability and known limits](../../pubky/references/concepts.md#stability-and-known-limits).

## Key migration (animated QR)

Ring transfers keys between installs as one `pubkyring://migrate?…` frame **per key**, rendered
as an **animated multi-frame QR** when there is more than one key. Frame params: `index` =
0-based frame index, `total` = frame count, `key` = a BIP39 mnemonic phrase **or** an
(encrypted) secret key, URL-encoded. The bounds (`total > 0`, `0 <= index < total`) are
enforced in the migrate **action handler** (`migrateAction.ts`), not the parser — `parseInput`
itself only requires `index`/`total` to be numbers and `key` non-empty.

**Generating frames** (`MigrateModal`):

```react-native
const migrateFormattedData = useMemo(() => {
  return keyValues.map((value, index) => ({
    value: `pubkyring://migrate?index=${index}&total=${keyValues.length}&key=${encodeURIComponent(value)}`,
  }));
}, [keyValues]);

// rendered as an animated multi-frame QR:
// <AnimatedQR data={migrateFormattedData} startCycleInterval={200} cycleInterval={600} transitionDuration={60000} />
```

**`AnimatedQR` component.** Defaults: `cycleInterval` 600 ms, `transitionDuration` 5000 ms;
`startCycleInterval` is optional (fast initial cycling that linearly eases to `cycleInterval`).
`MigrateModal` uses `startCycleInterval=200`, `cycleInterval=600`, `transitionDuration=60000`.
Tapping the QR pauses cycling and reveals prev/next chevrons. A single frame (`data.length <= 1`)
does not animate.

**Receiver accumulation.** `total === 1` imports the single key immediately and shows success
UI. For multi-key, frames are accumulated by `index` into a `Set`; each newly-seen frame fires
an import immediately in parallel (fire-and-forget with progress tracking); when
`importedIndices.size === expectedTotal`, all imports are awaited and a summary toast is shown.
Duplicate frames are ignored; closing the scanner early shows a partial-import summary.

## Clipboard / QR input formats

Paste accepts: a 12-word BIP39 recovery phrase, an encrypted secret-key string, an invite code
(`XXXX-XXXX-XXXX`), an invite URL (`…/invite/XXXX-XXXX-XXXX`), or any deeplink. Pasted input is
normalized — hyphens, underscores, and plus signs become spaces (for recovery phrases), and
`pubkyring://` / `pubkyauth://` prefixes are stripped before validation. QR scanning accepts
all the same formats plus animated multi-frame migrate QRs.
