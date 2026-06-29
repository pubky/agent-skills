# React Native client

`@synonymdev/react-native-pubky` is the React Native binding for Pubky: auth/Ring, homeserver
lifecycle, key management, `pubky://` data ops, and PKARR publish/resolve over a native bridge
module. This page is the method surface plus mobile gotchas; protocol theory is linked, not
restated:

- Identity, `pubky://` addressing, the `/pub` tree, public-key string formats, PKARR /
  Mainline-DHT, the homeserver model, and the write-vs-Nexus-read split →
  [`../../pubky/references/concepts.md`](../../pubky/references/concepts.md) (formats:
  [`#public-key-string-formats`](../../pubky/references/concepts.md#public-key-string-formats)).
- The `pubkyauth` handshake, capability grammar (e.g. `/pub/pubky.app/:rw`), relays, recovery
  files, signup tokens, session lifecycle → [`../../pubky/references/auth.md`](../../pubky/references/auth.md).
- The `pubky-app-specs` on-wire data shapes (profile/posts/tags/follows, paths, IDs) →
  [`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md).
- The underlying native `[error, data]` String Contract, the `<z32>:<cookie>` session-secret
  format, and the **mandatory Android `rustls` TLS init at startup** →
  [`native-ffi.md`](./native-ffi.md).
- Pubky Ring deeplink mechanics (`pubkyauth://` / `pubkyring://`, QR / animated frames,
  relay+secret transport, session revoke) → [`ring-auth.md`](./ring-auth.md).

**Upstream (authoritative — summarize, don't mirror):** the package README and the
`src/index.tsx` typings ([npm](https://www.npmjs.com/package/@synonymdev/react-native-pubky) ·
[repo](https://github.com/pubky/react-native-pubky) ·
[`src/index.tsx`](https://github.com/pubky/react-native-pubky/blob/main/src/index.tsx)). When the
[README](https://github.com/pubky/react-native-pubky/blob/main/README.md) and `src/index.tsx`
disagree, **trust `src/index.tsx` + `example/src/App.tsx`** — the README ships several stale
examples (see [README discrepancies](#readme-discrepancies-trust-src-over-readme)).

> **Version:** latest published is **0.13.0**. Sole runtime dependency `@synonymdev/result`
> (`^0.0.2`); peer deps `react` / `react-native` (`*`). Pubky is pre-1.0 — treat the surface as
> unstable.

## Install and linking

```bash
npm install @synonymdev/react-native-pubky
```

- This is a **native (old-architecture bridge) module** backed by `NativeModules.Pubky` —
  **not** a pure-JS package. On iOS run `pod install` and **rebuild the app** after installing.
- **Does not work in Expo Go** — it needs a custom dev client / bare workflow. If the native
  module is unlinked, every call throws `LINKING_ERROR`.
- **Only `/pub` operations are exposed.** There are no `/priv` / private-storage methods — do
  not invent them (see [Shipped vs planned](#shipped-vs-planned)).

## The Result envelope

**Every** exported function returns `Promise<Result<T>>` from `@synonymdev/result`. Functions
**never throw into the caller** — internal errors are caught and wrapped with `err(...)`. Always
check `res.isErr()` (or `res.isOk()`) before reading `res.value`; on the error arm read
`res.error.message`. This JS wrapper sits on top of the native `[isError, payload]`
two-element-array contract — see [`native-ffi.md`](./native-ffi.md) for the underlying
`[error, data]` convention.

```react-native
import {
  signUp,
  signIn,
  put,
  get,
  list,
  deleteFile,
  generateSecretKey,
  getPublicKeyFromSecretKey,
} from "@synonymdev/react-native-pubky";

// All methods return Result type
const result = await signUp(secretKey, homeserverUrl);
if (result.isErr()) {
  console.error(result.error.message);
} else {
  console.log(result.value); // Success value
}
```

## Two ways to get write access

Do not conflate these:

1. **Secret-key path** — your code holds the account secret key. Call `signUp` / `signIn`
   directly and write with `put(url, content, secretKey)` / `deleteFile(url, secretKey)`.
2. **Session / Ring path** — your code never holds the user's secret key. `startAuthFlow(caps)`
   → `awaitAuthApproval()` yields `SessionInfo.session_secret`; writes go through
   `putWithSession(url, content, sessionSecret)` / `deleteWithSession(url, sessionSecret)`.

`auth(url, secretKey)` is the **inverse (authenticator) side**: it approves an incoming
`pubkyauth://` URL on behalf of a held key (what a Pubky Ring-style app does).

## Key management

All return `Promise<Result<…>>`:

- `generateSecretKey() → Result<IGenerateSecretKey>` — read `.value.secret_key`.
- `getPublicKeyFromSecretKey(secretKey) → Result<IPublicKeyInfo>` — read `.value.public_key`.
- `createRecoveryFile(secretKey, passphrase) → Result<string>` — base64 recovery file.
- `decryptRecoveryFile(recoveryFile, passphrase) → Result<string>` — recovered secret key.
- `getHomeserver(pubky) → Result<string>`.
- **BIP39 helpers** (exported + exercised in the example app, absent from the README):
  `generateMnemonicPhrase() → Result<string>`,
  `mnemonicPhraseToKeypair(phrase) → Result<IGenerateSecretKey>`,
  `generateMnemonicPhraseAndKeypair() → Result<IMnemonicKeypair>`,
  `validateMnemonicPhrase(phrase) → Result<boolean>`.

RN passes **bare z-base-32** public-key strings (e.g. `z4e8s17c…`) in URLs and returns
`{ public_key, uri }` objects. There are **no** `.toString()` / `.z32()` key methods here —
those belong to the WASM SDK. (Formats:
[`concepts.md#public-key-string-formats`](../../pubky/references/concepts.md#public-key-string-formats).)

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

## Homeserver lifecycle

- `signUp(secretKey, homeserver, signupToken?) → Result<SessionInfo>` — `homeserver` is the
  **`pubky://<z32>` URI** form; `signupToken` is optional, for gated homeservers.
- `signIn(secretKey) → Result<SessionInfo>`.
- `signOut(sessionSecret) → Result<string>` — pass the **session secret**, not the account
  secret key (see [README discrepancies](#readme-discrepancies-trust-src-over-readme)).
- `revalidateSession(sessionSecret) → Result<SessionInfo>` — the exported session check.
  `session(...)` from the README is **not** exported; use `revalidateSession` + `getHomeserver`.
- `republishHomeserver(secretKey, homeserver) → Result<string>`.
- `getSignupToken(homeserverPubky, adminPassword) → Result<string>` — `homeserverPubky` is
  **bare z32** (no scheme). This is the homeserver **admin** path; for operating that side, see
  the `pubky-infra` skill.

```react-native
import {
  signUp,
  signIn,
  signOut,
  revalidateSession,
  getHomeserver,
} from "@synonymdev/react-native-pubky";

// Standard signup
const signUpRes = await signUp(
  secretKey,
  "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

// Signup with token (for gated homeservers)
const signUpWithTokenRes = await signUp(
  secretKey,
  "pubky://8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
  "your_signup_token",
);

// Sign in
const signInRes = await signIn(secretKey);

// Get homeserver
const homeserverRes = await getHomeserver(publicKey);
```

## Data operations

- `put(url, content, secretKey) → Result<string[]>` — `content` is a **JS object** that the
  wrapper `JSON.stringify`s for you (do **not** pre-stringify). The 3rd arg is **required**.
- `get(url) → Result<string>` — returns the raw native string (see
  [Decoding get output](#decoding-get-output)).
- `list(url) → Result<string[]>` — array of `pubky://` URLs.
- `deleteFile(url, secretKey) → Result<string[]>` — the exported name is **`deleteFile`**, not
  `delete`.

Session-authenticated variants (Ring path):

- `putWithSession(url, content, sessionSecret) → Result<string>` — `content` MUST be an
  **already-stringified string**.
- `deleteWithSession(url, sessionSecret) → Result<string>`.

```react-native
import { put, get, list, deleteFile } from "@synonymdev/react-native-pubky";

// Write data
const putRes = await put(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/profile.json",
  { name: "Alice", bio: "Builder" },
  secretKey,
);

// Read data
const getRes = await get(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/profile.json",
);

// List directory
const listRes = await list(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/posts/",
);

// Delete file
const deleteRes = await deleteFile(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/old-post",
  secretKey,
);
```

### put vs putWithSession content

Content-encoding asymmetry that silently breaks writes if confused: `put` stringifies for you,
`putWithSession` does not.

```react-native
// put: pass a JS object — the wrapper JSON.stringifies it internally
await put(url, { name: "Alice" }, secretKey);

// putWithSession: pass an ALREADY-stringified string
await putWithSession(url, JSON.stringify({ name: "Alice" }), sessionSecret);
```

### Decoding get output

`get` returns the raw native string directly: either plain UTF-8 text, or a string prefixed with
`base64:` for binary content. The wrapper does **not** JSON.parse or base64-decode for you — the
caller must detect the prefix. For JSON written with `put`, `JSON.parse` it yourself.

```react-native
const res = await get(url);
if (res.isErr()) throw res.error;
const raw = res.value; // native string
if (raw.startsWith("base64:")) {
  const b64 = raw.slice("base64:".length); // decode with your own base64 decoder
} else {
  const profile = JSON.parse(raw); // JSON written via put
}
```

## Pubky Ring auth flow

App side: `startAuthFlow(caps)` → present the returned URL to the user via Pubky Ring →
`awaitAuthApproval()` resolves with `SessionInfo`. Then write with `putWithSession` /
`deleteWithSession` using `session_secret`.

- `startAuthFlow(capabilities: string) → Result<string>` — begin the Ring flow; returns an auth
  URL to present to the user.
- `awaitAuthApproval() → Result<SessionInfo>` — resolves once the user approves.
- `parseAuthUrl(url: string) → Result<PubkyAuthDetails>` — decode a `pubkyauth://` URL.
- `auth(url: string, secretKey: string) → Result<string[]>` — authenticator side: approve an
  incoming `pubkyauth://` URL with a held key.

```react-native
import { startAuthFlow, awaitAuthApproval, putWithSession } from '@synonymdev/react-native-pubky';

const startRes = await startAuthFlow('/pub/att.app/:rw');
if (startRes.isErr()) { console.log(startRes.error.message); return; }
const authUrl = startRes.value; // present to user (Pubky Ring)

const approvalRes = await awaitAuthApproval();
if (approvalRes.isErr()) { console.log(approvalRes.error.message); return; }
const { pubky, capabilities, session_secret } = approvalRes.value;

const putRes = await putWithSession(
  `pubky://${pubky}/pub/app/profile.json`,
  JSON.stringify({ name: 'Alice' }),
  session_secret,
);
```

How you actually present and transport that URL (deeplink, QR, animated frames, relay+secret)
lives in [`ring-auth.md`](./ring-auth.md); the capability grammar and `pubkyauth` handshake live
in [`../../pubky/references/auth.md`](../../pubky/references/auth.md). Do not restate them here.

## PKARR publish and resolve

- `publish(recordName, recordContent, secretKey) → Result<string[]>` /
  `resolve(publicKey) → Result<IDNSPacket>` — raw signed DNS packets (TXT records).
- `publishHttps(recordName, target, secretKey) → Result<string[]>` /
  `resolveHttps(publicKey) → Result<IHttpsResolveResult>` — HTTPS records.
- `resolve` / `resolveHttps` take a **bare z32** public key.

See the PKARR / Mainline-DHT model in
[`../../pubky/references/concepts.md`](../../pubky/references/concepts.md).

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

## End-to-end: write and read a profile

Sign up, write a `pubky-app-specs` profile to `/pub/pubky.app/profile.json`, then read it back.
`get` returns a string, so `JSON.parse` it yourself. The `pubky.app` data shapes are canonical in
[`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md) — link, don't restate.

```react-native
import { signUp, put, get } from "@synonymdev/react-native-pubky";

// Sign up
const signUpRes = await signUp(secretKey, homeserverUrl);
if (signUpRes.isErr()) throw new Error(signUpRes.error.message);

// Create profile (following pubky-app-specs)
const profile = {
  name: "Alice",
  bio: "Building on Pubky",
  image:
    "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/profile.jpg",
  links: [{ title: "Website", url: "https://alice.com" }],
};

// Write profile
const putRes = await put(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/pubky.app/profile.json",
  profile,
  secretKey,
);

// Read profile
const getRes = await get(
  "pubky://z4e8s17cou9qmuwen8p1556jzhf1wktmzo6ijsfnri9c4hnrdfty/pub/pubky.app/profile.json",
);
if (getRes.isErr()) throw getRes.error;
const savedProfile = JSON.parse(getRes.value);
```

## Homeserver event stream

The mobile surface for the homeserver event stream (a shipped feature):

- `setEventListener(callback: (eventData: string) => void) → Result<void>` — calls
  `Pubky.setEventListener()` then registers `callback` on the `PubkyEvent` channel of a
  `NativeEventEmitter`. The example `App.tsx` sets this up in `useEffect`.
- `removeEventListener() → Result<void>` — removes all JS listeners for `PubkyEvent`. **Caveat:**
  its native `Pubky.removeEventListener()` call is currently commented out in `src`, so only the
  JS side detaches. Clean up on unmount.

## TypeScript types

```react-native
export type Capability = { path: string; permission: string };

export type PubkyAuthDetails = {
  relay: string;
  capabilities: Capability[];
  secret: string;
  kind?: 'signin' | 'signup';   // parsed from deep-link host; legacy URLs => 'signin'
  homeserver?: string;          // bare z32, from `hs` param of signup links
  signup_token?: string;        // from `st` param of signup links
};

export interface SessionInfo {
  pubky: string;
  capabilities: string[];
  session_secret: string;
}

export interface IPublicKeyInfo { public_key: string; uri: string }
export interface IGenerateSecretKey extends IPublicKeyInfo { secret_key: string }
export interface IMnemonicKeypair extends IGenerateSecretKey { mnemonic: string }
```

`SessionInfo.session_secret` is the value you feed to `putWithSession` / `deleteWithSession` /
`signOut` / `revalidateSession`. `PubkyAuthDetails.kind` / `homeserver` / `signup_token` come from
signup-flavored `pubkyauth` deeplinks and are **absent** against pre-0.9.1 native binaries.

## README discrepancies (trust src over README)

The README ships stale examples; treat `src/index.tsx` + `example/src/App.tsx` as ground truth:

- **`signOut`** — the README labels its arg `// Secret Key` and passes a 64-hex key; the real
  signature is `signOut(sessionSecret)`, and `App.tsx` passes `signInRes.value.session_secret`.
  Pass the **session secret**.
- **`put`** — the README's example omits the required 3rd `secretKey` arg.
- **Method names** — the README's "Implemented Methods" list names `delete` / `session`; the
  exported symbols are **`deleteFile`** / **`revalidateSession`**.

## Shipped vs planned

Everything this package exposes is **shipped**: `/pub` public storage, capability-scoped sessions,
PKARR identity/discovery, app-specs data, resumable `pubkyauth`
(`startAuthFlow` / `awaitAuthApproval`), homeserver event streams (`setEventListener`), and
recovery files / local backup. There are **no** `/priv` or private/encrypted-storage methods — do
not invent them. Stability caveats still apply: the `/pub` path layout is **not stabilized** and
app-specs are **v0.x**. See
[`../../pubky/references/shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
