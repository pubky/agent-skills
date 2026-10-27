# Reference apps & starter templates

> Starting a new app? Read [new-project.md](./new-project.md) first. It covers intake, network choice and the version check. This file has the detail it links to.

Four open-source codebases show how real Pubky code is built. **Start new web apps from `basic-pubky-app`.** pubky.app also uses grant auth now, but it is a large app that holds keys itself, so don't start from it. Explorer and workshop pin SDK 0.6.0, so check [version drift](#version-drift-check-before-copying-any-call) before you copy from them.

| Codebase | What it is | Architecture | SDK pin |
| :-- | :-- | :-- | :-- |
| [pubky-app-templates](https://github.com/pubky/pubky-app-templates) · [live previews](https://pubky.github.io/pubky-app-templates/) | `basic-pubky-app` (Vite + TS: Ring sign-in, shared browser sessions, `/pub` + `/priv` (alpha) storage, file locks, uploads, events) and `vite-starter` (no Pubky code) | Client ↔ homeserver, authenticated | `^0.15.0` |
| [pubky-app](https://github.com/pubky/pubky-app) (pubky.app) | The main social web app (Next.js) | Custom backend (Nexus) + local cache | `0.16.2` exact |
| [pubky-explorer](https://github.com/pubky/pubky-explorer) · <https://explorer.pubky.app> | Read-only browser for any user's `/pub` tree (Solid.js) | Client ↔ homeserver, unauthenticated | `^0.6.0` |
| [workshop](https://github.com/pubky/workshop) | Spanish teaching CLI, "De cero a Pubky" | Client ↔ homeserver, authenticated | `0.6.0` exact |

Shared concepts live in other files:
- Identity, `pubky://` addressing, PKARR and the write-vs-read split: [`./concepts.md`](./concepts.md).
- The data contract: [`./app-specs.md`](./app-specs.md).
- What has shipped: [`./shipped-vs-planned.md`](./shipped-vs-planned.md).
- Auth: [`./auth.md`](./auth.md). JS API: [`./sdk-js.md`](./sdk-js.md). Nexus reads: [`./nexus-api.md`](./nexus-api.md). Local testnet: [`./testing-and-testnet.md`](./testing-and-testnet.md).

> **Scope.** Many patterns below are **app choices, not protocol guarantees**, for example the Dexie cache, write compensation and retries, the `AppError` taxonomy and the template's error heuristics. The `/pub` path layout is not stabilized, Nexus `/v0` is unstable, and pubky-app-specs is v0.x. **basic-pubky-app and pubky.app now write `/priv`.** `/priv` is **alpha and not for production**. It is access-controlled, **not encrypted**, so the homeserver operator can read it. It has no backup. See [`/priv` private storage (alpha)](./shipped-vs-planned.md#priv-private-storage-alpha).

## Version drift: check before copying any call

Snapshot from 2026-10-26. Run `npm view @synonymdev/pubky dist-tags` yourself, as [new-project.md](./new-project.md#3-check-the-sdk-version-first) says.
- `@synonymdev/pubky`: `latest` = **0.16.2** (2026-10-15). Never install `alpha` (0.10.0-alpha.0) or `next` (0.6.0-rc.7), because both are older than `latest`. `pubky-app-specs`: `latest` = **0.8.1**.
- Releases since 0.12.0: 0.13.0, 0.14.0, 0.15.0, 0.16.0, 0.16.1, 0.16.2.
- **`^0.15.0` (the template pin) stays on 0.15.x.** For a 0.x version, npm's caret locks the minor version, so `npm update` never moves the template to 0.16.x. To upgrade, read the [homeserver release notes](https://github.com/pubky/pubky-homeserver/releases), then edit the version in `package.json`.
- **Upgrade all apps on one origin together.** The v0.16.0 release notes say older SDKs "cannot safely share V2 browser session records". Never run a 0.15.x build (such as the template as pinned) next to a 0.16.x build on one origin with a shared `browserSessionStore`.
- v0.16.0 also added scoped encryption keys and HPKE-encrypted grant approvals. The scoped encryption keys are keys an app can request through a grant. They are **not encrypted storage**: `/priv` is still unencrypted, and encrypted data is still [planned](./shipped-vs-planned.md#still-planned). v0.16.1 added selective auth approval ([v0.16.0 notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0)).
- Typings: [`pubky.d.ts` @ 0.15.0](https://unpkg.com/@synonymdev/pubky@0.15.0/pubky.d.ts) (template pin) · [@ 0.16.2](https://unpkg.com/@synonymdev/pubky@0.16.2/pubky.d.ts) (latest) · [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/).

| Legacy call (still present in 0.15.0 and 0.16.2, deprecated) | Use instead |
| :-- | :-- |
| `startCookieAuthFlow` | `startGrantAuthFlow` |
| `resumeCookieAuthFlow` | `resumeGrantAuthFlow` (or `resumeDelegatedGrantAuthFlow`) |
| `signinCookie()` / `signinCookieBlocking()` | `signin(clientId)` / `signinBlocking(clientId)` |
| `session.export()` | `GrantSession.exportLocalSecret()`, or `browserSessionStore` for delegated sessions |

- **`signin` / `signinBlocking` require a `clientId` string** (since 0.10.0). A 0.6.0-style call with no argument fails in strict TypeScript.
- **`signup()` returns `void` on 0.10+.** Call `signin(clientId)` after it, and never use its result as a session.
- SDK error names: [`./sdk-js.md`](./sdk-js.md#error-handling).
- **KB snippets are pinned to 0.14.0.** The "Storage Locking" section of the KB's `sdk.md` says the JS bindings have no lock helpers. That is out of date: 0.15.0+ has them (see [File locks](#file-locks-sdk-015)).

**Don't ship the React `PubkyProvider` from [pubky-ai-kit](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md).** It is pre-0.10 code that holds the user's keys:
- It calls `pubky.signer(keypair).signin()` with no `clientId` (L1184).
- It saves the deprecated `next.export()` to `localStorage` under `pubky_session` (L1157, L1185).
- It hardcodes `Pubky.testnet()` (L1160).
- Its `usePubkySpecs` / `PostCreator` example (L593-640) uses `PubkyAppPostKind.Short` without importing it.

Use basic-pubky-app's grant flow with `browserSessionStore` instead.

## Architecture: which codebase to copy

Source: [KB App Architectures](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/app-architectures.md). Concept: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read).

| Approach | Use when | Copy |
| :-- | :-- | :-- |
| Client ↔ homeserver | The app already knows which users and paths it needs (for example, a bookmark tool) | basic-pubky-app; Explorer for public reads; workshop |
| Custom backend | You need search, feeds or relationships across many users, so you maintain indexes | pubky.app (Nexus, [`./nexus-api.md`](./nexus-api.md)) |
| Shared aggregator | Several clients need the same indexed data; pick a service by its coverage and filtering policy | — |

- **Writes always go to the user's homeserver**, whichever read approach you pick. You can combine approaches.
- **Indexed results lag behind writes and depend on what the indexer covers and filters.** Decide for each screen whether that lag is acceptable, especially right after the user publishes.

## pubky-app-templates

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app   # or /vite-starter
```

- Both templates need Node `^20.19.0 || >=22.12.0`.
- The live previews at <https://pubky.github.io/pubky-app-templates/> come in mainnet and testnet builds. Both are production builds, so they offer **Pubky Ring sign-in only**.
- The KB [Developer Guide](https://pubky.org/developer-guide/) is the tutorial. The old `/explore/pubkycore/getting-started/` URL redirects there, and the template README still links the old URL.

### vite-starter

A plain Vite + TypeScript shell (`typescript ~7.0.2`, `vite ^8.3.4`) with **no Pubky SDK**. All `src/main.ts` does is set the text of `#app` to `'Vite Starter'`. The Developer Guide clones it, runs `npm install && npm install @synonymdev/pubky`, and replaces that line with the hello world below.

#### Hello world on vite-starter

```ts
import { Keypair, Pubky, PublicKey, setLogLevel } from "@synonymdev/pubky";

try {
  setLogLevel("info");
} catch (error) {
  console.warn(
    "Pubky log level must be set only once, before creating the client.",
    error,
  );
}

const pubky = Pubky.testnet();

const keypair = Keypair.random();
const signer = pubky.signer(keypair);
console.log("Your pubky:", signer.publicKey.toString());

const homeserver = PublicKey.from(
  "pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo",
);

await signer.signup(homeserver, null);

const session = await signer.signin("myapp.example");

const path = "/pub/hello-world/data.json";
await session.storage.putJson(path, { message: "Hello Pubkyverse!" });

const data = await session.storage.getJson(path);
document.querySelector<HTMLDivElement>("#app")!.textContent = JSON.stringify(
  data,
  null,
  2,
);
```

<sub>Source: KB [`snippets/js/src/developer-guide.ts` L4-13, L16-50](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/snippets/js/src/developer-guide.ts#L16-L50) (the file was renamed from `getting-started.ts`). CI type-checks it against SDK 0.14.0. It was run against a local testnet on 0.12.0 and 0.15.0. Change from upstream: upstream logs `signer.publicKey.z32()`, but human-facing output should use `toString()` (`pubky<z32>`); see [key formats](./concepts.md#public-key-string-formats). The homeserver key is the fixed local-testnet key.</sub>

- **`setLogLevel` works only once, and only before the client is created.**
- **Local testnet.** The Developer Guide now starts one with [Pubky Docker](https://github.com/pubky/pubky-docker): `cp .env-sample .env`, then `docker compose up homeserver -d`. It also links a native alternative. Ports: `15411` PKARR relay, `15412` HTTP relay, `6286` homeserver ICANN HTTP, `6287` PubkyTLS, `6288` admin. A Docker restart wipes stored files and PKARR records. Setup choices: [new-project.md](./new-project.md#5-get-the-network-running-and-the-user-an-account) and [`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet).
- **Creating an identity and signing up inside the app are dev-only shortcuts.** Real apps assume the user already has a homeserver account. Send new users to separate onboarding (for example, <https://pubky.app/onboarding/human>).
- On first signup, the console may show a 404 for `http://localhost:15411/<user-public-key>`. That is the SDK checking for an existing PKARR record. If signup continues, ignore it.
- For production, replace `Pubky.testnet()` with `new Pubky()`. It resolves PKARR through the Mainline DHT and relays, and uses a public HTTP relay for auth.
- **Storage layout tip (KB):** put each record that is edited on its own in its own file (for example, `/pub/myapp/posts/001.json`). A write replaces everything at one path, so separate files mean smaller updates, lazy loading through directory listing, and fewer write conflicts. Keep fields that are read and updated together in one file.

### basic-pubky-app

A standalone app that uses homeservers directly as its data layer: no indexer, no aggregator and no pubky.app social data. It shows Ring sign-in, shared browser sessions, public and private (alpha) storage, file locks, uploads, downloads, and event history with live updates. Key management stays in Pubky Ring.

To run it on testnet: `VITE_PUBKY_TESTNET=true npm run dev`. To check it: `npm test` runs `node --test` against a mocked SDK and needs no homeserver, and `npm run build` runs `tsc && vite build`.

**File map**, for pruning ([README: "Keeping Only the Examples You Need"](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/README.md)):

| File | Role |
| :-- | :-- |
| `src/config.ts` | All app settings |
| `src/client.ts` | The SDK facade that every module shares |
| `src/pubky.ts` | Account, Ring sign-in, sessions |
| `src/access.ts` | Capability checks |
| `src/storage.ts` | Note files and locks |
| `src/storage-tools-data.ts` | Uploads and the public reader |
| `src/events.ts` | Event history and live stream |
| `public-reader.html` + `src/public-reader.ts` + `src/storage-tools.ts` | The anonymous reader page, registered as a second rolldown input in `vite.config.js` |

#### Config: `src/config.ts`

**Change `APP_CLIENT_ID` first.** The paths and capabilities derive from it. Capability syntax: [`./auth.md`](./auth.md#capabilities).

```ts
import type { Capabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template' as const
export type StorageSpace = 'public' | 'private'
export const APP_PATHS = {
  public: `/pub/${APP_CLIENT_ID}/`,
  private: `/priv/${APP_CLIENT_ID}/`,
} as const
export const APP_CAPABILITIES = `${APP_PATHS.public}:rw,${APP_PATHS.private}:rw` as Capabilities

// Events contain resource metadata, not file contents. Bound incoming SSE payloads.
export const MAX_EVENT_BYTES = 8 * 1024

export const IS_TESTNET = import.meta.env.VITE_PUBKY_TESTNET !== 'false'
export const TESTNET_HOST = import.meta.env.VITE_PUBKY_TESTNET_HOST || undefined
export const HTTP_RELAY =
  import.meta.env.VITE_PUBKY_HTTP_RELAY?.trim() ||
  (IS_TESTNET ? `http://${TESTNET_HOST ?? 'localhost'}:15412/inbox/` : undefined)
export const STORAGE_NAMESPACE = import.meta.env.VITE_PUBKY_STORAGE_NAMESPACE?.trim() || undefined

export const SHOW_DEVELOPMENT_SIGNUP =
  import.meta.env.DEV && IS_TESTNET && import.meta.env.VITE_SHOW_DEVELOPMENT_SIGNUP !== 'false'

// Fixed homeserver public key used by Pubky's local testnet.
export const DEVELOPMENT_SIGNUP_HOMESERVER =
  'pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
```

<sub>Source: [`basic-pubky-app/src/config.ts` L1-26](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/config.ts). Needs Vite's `import.meta.env` types. Run against a local testnet on SDK 0.15.0.</sub>

- **The template requests `/priv` by default.** Before shipping to production, remove the `private` space and its capability, because `/priv` is [alpha](./shipped-vs-planned.md#priv-private-storage-alpha). In the template README's words, private means "access-controlled, not encrypted": files are stored as unencrypted JSON that the operator can read, and `/priv` can't be shared with selected people. The README has no alpha warning.
- Deleting a public file doesn't remove copies that other people already downloaded.

```ts
import { Pubky } from '@synonymdev/pubky'
import { IS_TESTNET, TESTNET_HOST } from './config'

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()
```

<sub>Source: [`src/client.ts` L1-4](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/client.ts). Create one facade per app.</sub>

#### Relay config

**Testnet is the default.** Mainnet is selected only by the exact string `VITE_PUBKY_TESTNET=false`, because the check is `!== 'false'`.

| Condition | HTTP (auth) relay passed as `relay` to `startGrantAuthFlow` |
| :-- | :-- |
| `VITE_PUBKY_HTTP_RELAY` is set (non-empty after trimming) | That URL |
| otherwise, testnet | `http://${VITE_PUBKY_TESTNET_HOST ?? 'localhost'}:15412/inbox/` |
| otherwise, mainnet | `undefined`, so the SDK's default HTTP relay applies |

- `VITE_PUBKY_TESTNET_HOST` feeds both `Pubky.testnet(host)` and the testnet relay URL, so setting a LAN host changes both.
- **The HTTP relay (auth) and the PKARR relays (identity resolution) are separate settings.** The template sets no PKARR relays, so `new Pubky()` uses the defaults. Browsers can't query the UDP Mainline DHT, so the SDK resolves through HTTPS PKARR relays. To set the relays yourself, as pubky.app does:

```ts
  const client = new Client({
    pkarr: {
      relays: ["https://pkarr.pubky.org"],
    },
  });

  const pubky = Pubky.withClient(client);
```

<sub>Source: KB [`developer-guide.ts` L68-74](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/snippets/js/src/developer-guide.ts#L66-L76), moved there from the deleted `troubleshooting.ts`. CI type-checks it against 0.14.0. It was constructed on 0.6.0–0.16.2 but not run against mainnet. A custom HTTP relay is the grant flow's `relay` option, shown in KB [L55-63](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/snippets/js/src/developer-guide.ts#L52-L64). Relay protocol: [`./auth.md`](./auth.md#relays).</sub>

#### Sign-in with Pubky Ring (grant flow)

Before you start, call `pubky.browserSessionStore.isAvailable()`, which needs a secure context, IndexedDB and Web Locks. Then resume a pending flow from `sessionStorage` if one exists. Otherwise, start a new flow:

```ts
  const flow = await pubky.startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
    clientId: APP_CLIENT_ID,
    relay: HTTP_RELAY,
  })
  let saved: string
  try {
    if (!isCurrent()) throw ringAuthCanceledError()
    try {
      saved = JSON.stringify({ mode: 'delegated', state: flow.saveDelegated() })
    } catch (error) {
      if (!isErrorNamed(error, 'ClientStateError') || !errorText(error).includes('not delegated'))
        throw error
      saved = JSON.stringify({ mode: 'local', state: flow.saveLocal() })
    }
    // Contains a relay secret (and a PoP secret for the local fallback). Keep it
    // tab-scoped and never log it or copy it into permanent application storage.
    sessionStorage.setItem(PENDING_AUTH_KEY, saved)
  } catch (error) {
    flow.free()
    throw error
  }
  return awaitRingApproval(flow, saved)
```

<sub>Excerpt: [`src/pubky.ts` L98-119](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/pubky.ts#L98-L119) (SDK 0.15). Run against a local testnet; in Node, `saveDelegated()` throws "not delegated", so the `saveLocal` fallback runs. `PENDING_AUTH_KEY` is `${SESSION_KEY}:pending-auth`. Why the code tries delegated first and falls back to local: [`./auth.md`](./auth.md#resume-after-reload-or-restart). Show `flow.authorizationUrl` as a QR code, a clickable link and a **Copy link** button. URL format: [`./auth.md`](./auth.md#pubkyauth-deep-links).</sub>

**Resume and cleanup rules:**
- **Resume:** for `mode === 'delegated'`, call `await pubky.resumeDelegatedGrantAuthFlow(state)`, which is async. For `'local'`, call `pubky.resumeGrantAuthFlow(state)`, which is sync. `options.fresh` deletes the pending record first.
- **Clear the pending record after a failed resume only for a `SyntaxError`, an invalid-saved-session error or an expired-auth error.** Re-throw transient storage and network errors so the link can still be resumed.
- **Keep pending state only in tab-scoped `sessionStorage`.** Never put it in `localStorage` or logs: it holds the relay secret, and for local flows the PoP secret too.
- **Cancel and suspend reject immediately.** `awaitApproval` is `Promise.race([approval, cancellation]).finally(release)`. `cancel()` abandons the flow and deletes the pending link. `suspend()` stops this page's waiter but keeps the resumable state; the template calls it when the page really unloads. If a cancelled flow is approved late, the session is saved and then revoked with `signout()`. `flow.free()` stays inside try/catch. A unit test with a mocked SDK covers this.
- **Detect expiry by the exact message, not a heuristic.** A proxy's 504 is not expiry, so the authorization can still be resumed:

```ts
function isExpiredAuthError(error: unknown) {
  // The SDK reports relay expiry as AuthenticationError. Request errors such as
  // a proxy's 504 Gateway Timeout leave the pending authorization resumable.
  return (
    isErrorNamed(error, 'AuthenticationError') &&
    errorText(error).toLowerCase().includes('auth request has expired or was cancelled')
  )
}
```

<sub>Source: [`src/pubky.ts` L392-399](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/pubky.ts#L392-L399). `errorText` also walks `error.cause` recursively. The message is present in the 0.12.0, 0.15.0 and 0.16.2 binaries. No real relay expiry was triggered. Message matching can break between SDK versions, so re-check it on every SDK bump.</sub>

**Testing without a phone.** Use the [Pubky Ring Simulator](https://simulator.pubkyring.app):
1. In the template, click **Copy link**.
2. In the simulator, choose **Shortcut** mode and paste the link into *Auth link*. The simulator creates an identity, signs it up on the local homeserver and approves the request.
3. The template is already polling, so it signs in on its own.

Use **Regular** mode to create or pick identities yourself. The hosted simulator connects to `localhost`, so your browser may ask for local-network access.

#### Session persistence and sign-out

Browser store API: [`./auth.md`](./auth.md#persist-and-restore) and [`./sdk-js.md`](./sdk-js.md#session).

- **Store only the opaque `stored.id` in `localStorage`, after calling `browserSessionStore.save(session)`.** The key is `SESSION_KEY` = `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`, or `${APP_CLIENT_ID}:session` when no namespace is set. **Set `VITE_PUBKY_STORAGE_NAMESPACE` when several builds share one origin.** CI uses `testnet`.
- **Select a session under a Web Lock.** Selection runs inside `navigator.locks.request(`${SESSION_KEY}:selection`)` and calls `browserSessionStore.restore(stored.id)` again before writing the pointer.
- **Revoke sessions that lose the selection.** The losing session is revoked with `session.signout()`. A `${SESSION_KEY}:pending-revocation:<id>` key tracks it, and `restoreSavedSession` retries the revocation on the next load.
- `.free()` each `StoredSessionInfo` handle.
- **Sign-out:** `await session.signout()`, then delete the `localStorage` pointer. The template README says sign-out revokes the session and clears affected tabs. **If sign-out fails, keep the SDK record.** It holds the pending-revocation marker and blocks authenticated requests until a retry succeeds; the UI shows "Retry sign out".
- **Cross-tab sync:** listen for the window `pubky-session-changed` `CustomEvent` (`detail.action` is either `'removed'` with an `id`, or `'cleared'` with `id: null`), and for `storage` events on `SESSION_KEY`. ⚠️ The SDK's `index.js` dispatches `pubky-session-changed` (in 0.15.0 and 0.16.2), but `pubky.d.ts` and the README don't mention it. It is undocumented, so re-check it on every SDK bump.

**Choose which restore errors mean "forget the saved session":**

```ts
function isInvalidSavedSessionError(error: unknown) {
  // SDK 0.15 also wraps browser coordination failures as AuthenticationError.
  // Keep those records for retry; revoked sessions are reported explicitly as
  // ClientStateError ("Browser session is no longer valid.").
  return (
    isErrorNamed(error, 'InvalidInput') ||
    (isErrorNamed(error, 'ClientStateError') &&
      /Stored Pubky session not found:|Invalid stored session record:|Browser session was signed out\.|Browser session is no longer valid\.|Stored session identity does not match its grant\.|Delegated grant key public key does not match saved (session|flow)\./.test(
        errorText(error),
      ))
  )
}
```

<sub>Source: [`src/pubky.ts` L401-412](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/pubky.ts#L401-L412). Each message was checked against the 0.15.0 SDK binary; a real revoked session needs a browser. The 0.16.2 binary no longer contains `Invalid stored session record:`, so that alternative never matches there. This replaces the 0.12-era rule "forget on `AuthenticationError`, `InvalidInput` or `ClientStateError`". On 0.15+, **don't** forget a session on a bare `AuthenticationError`.</sub>

**Check the session's capabilities before every storage call.** Sessions saved by the older public-only template have no `/priv` capabilities, so the user must sign out and authorize again.

```ts
export function hasStorageAccess(session: Session, space: StorageSpace) {
  const path = APP_PATHS[space]
  const capabilities = session.info.capabilities
  return ['r', 'w'].every((action) =>
    capabilities.some((capability) => {
      const separator = capability.lastIndexOf(':')
      const scope = capability.slice(0, separator)
      const actions = capability.slice(separator + 1)
      return (
        separator > 0 &&
        actions.includes(action) &&
        (scope.endsWith('/') ? path.startsWith(scope) : path === scope)
      )
    }),
  )
}
```

<sub>Source: [`src/access.ts` L4-19](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/access.ts). A scope that ends in `/` matches by prefix. Any other scope must match exactly. Run against a real grant session and a root `/:rw` session.</sub>

#### Dev-only identity shortcut

```ts
export async function signupDevelopmentUser(homeserver: string) {
  if (!SHOW_DEVELOPMENT_SIGNUP) {
    throw new Error('Development identity creation is available only in development on testnet.')
  }
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  try {
    await signer.signup(homeserverKey, null)
  } catch (error) {
    throw closedSignupError(error)
  }

  return signer.signin(APP_CLIENT_ID)
}
```

<sub>Source: [`src/pubky.ts` L38-52](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/pubky.ts#L38-L52). Run against a local testnet.</sub>

- The **New identity** button appears only under `vite dev` on testnet. `VITE_SHOW_DEVELOPMENT_SIGNUP=false` hides it, and the function checks the same flag itself.
- It needs a homeserver with open signup (`signup_mode = "open"`).
- **It holds a raw keypair in the browser. Never ship it.**
- **`isClosedSignupError` is a heuristic.** It returns true for any HTTP 400, for a 401 or 403 whose text matches `/signup|token|invite/`, for any `AuthenticationError`, and for text containing `signup token required`, `signup_mode` or `token required`. When it matches, the template throws a friendly `Error` with `cause` set to the original error.

#### Note files and listing

```ts
async function listFileUrls(session: Session, space: StorageSpace) {
  try {
    const urls: string[] = []
    let cursor: string | null = null

    // The last listed URL is the next cursor; session.storage.list does not return a separate cursor field.
    while (true) {
      const batch = await session.storage.list(
        `${APP_PATHS[space]}files/` as Path,
        cursor,
        true,
        LIST_PAGE_SIZE,
        true,
      )
      if (batch.length === 0) break

      const nextCursor = batch[batch.length - 1]
      if (!nextCursor || nextCursor === cursor) break

      urls.push(...batch)
      if (batch.length < LIST_PAGE_SIZE) break
      cursor = nextCursor
    }

    return urls
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}
```

<sub>Source: [`src/storage.ts` L64-93](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/storage.ts#L40-L93). `LIST_PAGE_SIZE` is 50. Argument order: `list(path, cursor, reverse, limit, shallow)`. Run against a local testnet with 57 files. General pagination: [`./sdk-js.md`](./sdk-js.md#listing-and-pagination).</sub>

- **Use the last URL as the cursor.** Stop on an empty page, an unchanged cursor or a short page. **Always pass a finite limit.** A 404 means the folder doesn't exist yet, so treat it as empty.
- **Validate every listed URL.** Parse it with `PubkyResource.parse`. Then require `owner.z32()` to equal the session's z32 and `path` to equal `${dir}${id}.json` exactly. Otherwise, throw "The homeserver returned a file outside the selected folder."
- **Take the ID from the filename, never from the JSON body.** File content must never decide which path you write or delete. IDs come from `crypto.randomUUID()` and must match `/^[a-zA-Z0-9_-]+$/`.
- `saveFile` writes `{id, title, body, updatedAt}` to `${APP_PATHS[space]}files/${id}.json`. New files use `session.storage.putJson`. **Editing an existing file needs a lock** and uses `putTextLocked(lock, JSON.stringify(file))`, because there is no `putJsonLocked`.
- `readFile` runs `getJson` and `stats(path)` in parallel. If `stats` fails, the file is shown with `metadataUnavailable`. `stats`: [`./sdk-js.md`](./sdk-js.md#metadata-exists-and-stats).

#### File locks (SDK 0.15+)

The SDK added WebDAV locks in 0.15.0. The homeserver added basic locks in v0.13.0, and in v0.15.0 it started refusing a locked write once the lock is lost ([v0.15.0 notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.15.0)). **The full API is in the [SDK README](https://github.com/pubky/pubky-homeserver/blob/v0.15.0/pubky-sdk/bindings/js/pkg/README.md) and [`pubky.d.ts`](https://unpkg.com/@synonymdev/pubky@0.15.0/pubky.d.ts).** Below is a summary.

- `SessionStorage` has `lock(path, timeoutSeconds)`, `putTextLocked` / `putBytesLocked(lock, body)`, `deleteLocked(lock)`, `refreshLock(lock, timeoutSeconds)` and `unlock(lock)`. There is no `putJsonLocked`. The file doesn't need to exist before you lock it.
- **A `StorageLock` (`path`, `token`, `timeoutSeconds`, `ifHeader()`, `free()`) is a bearer token. Never log it or expose it.** The homeserver caps how long a lock lasts. `timeoutSeconds` is the lifetime the server granted, counted from when the call resolved. It is not the time remaining.
- Status codes: **423** = someone else holds a lock (plain writes and deletes to the path, and a second `lock()`, are refused). **412** = your lock is gone (a locked write, delete or refresh was refused). **409** = `unlock()` on a lock that is already gone. **405** = the homeserver doesn't support locks. **400** = the target is a directory.
- **If `lock()` rejects without a status code** (for example, because the connection dropped), the server may still have granted the lock, and nothing can release it. The path returns 423 until the lock times out.

**Template workflow:**
1. Call `lock(path, 60)`.
2. **Read the file again under the lock.** The copy on screen may be stale.
3. Renew with `refreshLock(lock, 60)` and set `expiresAt = now + timeoutSeconds * 1000`.
4. Save with the lock, then release it.

- **Delete** takes its own lock if none is held and releases it in `finally`, ignoring unlock errors. On release, the template ignores 409 and 412 from `unlock`, and `sdkLock.free()` always runs.
- **Locks block competing writes. They don't merge edits.** If the re-read file differs from the baseline your draft started from, keep the draft on screen and block saving as a conflict.
- The template keeps the SDK lock inside `storage.ts`, in a `WeakMap`. The UI sees only `{id, space, expiresAt}`. A 412 during a locked operation also marks the local lock inactive.

```ts
function lockError(error: unknown) {
  switch (statusCode(error)) {
    case 423:
      return new Error('Another editor holds this file lock. Try again after it is released.')
    case 405:
      return new Error('This homeserver does not support file locks. Upgrade it to edit safely.')
    case 412:
      return new Error(
        'The file lock was lost. Lock and reopen the file to read its latest contents.',
      )
    default:
      return error
  }
}
```

<sub>Source: [`src/storage.ts` L244-257](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/storage.ts#L191-L257). `statusCode` reads `error.data.statusCode`. A real 423 was produced against a local testnet. These are not pubky.app's "Locks", which is a paid-content product feature (see [pubky.app](#pubkyapp)).</sub>

#### Uploads, downloads and the public reader

```ts
export async function uploadFileBytes(
  session: Session,
  space: StorageSpace,
  file: File,
  isCurrent: () => boolean = () => true,
) {
  requireStorageAccess(session, space)
  checkByteLength(file.size)
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file'
  const name = `${crypto.randomUUID()}-${filename}`
  const bytes = new Uint8Array(await file.arrayBuffer())
  checkByteLength(bytes.byteLength)
  requireCurrent(isCurrent)
  await session.storage.putBytes(uploadedFilePath(space, name), bytes)
  return name
}
```

<sub>Source: [`src/storage-tools-data.ts` L66-81](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/storage-tools-data.ts#L66-L81). `checkByteLength` enforces a 5 MiB limit (`MAX_FILE_BYTES`) before and after the file is read. The UUID prefix keeps earlier uploads addressable. Uploads go under `${APP_PATHS[space]}attachments/`, which is a template convention, not an SDK storage type. Run against a local testnet.</sub>

- **Build share links with the raw z32:** `` `pubky://${session.info.publicKey.z32()}${path}` ``. The `pubky://` URI form takes z32, not the `pubky`-prefixed display form ([key formats](./concepts.md#public-key-string-formats)).
- **Never render uploaded content in your app's origin.** Download it as an attachment, and escape text previews:

```ts
/** Download as an attachment; never render uploaded HTML/SVG in the app origin. */
export function downloadBytes(bytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download'
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
```

<sub>Source: [`src/storage-download.ts` L1-12](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/storage-download.ts). Checked with DOM stubs only, not in a real browser. Text previews appear only for `text/*` or JSON content types, escaped with `escapeHtml` inside a `<pre>` and cut off at 4000 bytes. **Fetch untrusted bytes with a size cap:** the public reader and uploaded-file reads use `storage.get()` plus `readLimitedResponse` (5 MiB cap). Only note downloads (`downloadFile` in `storage.ts`) use the uncapped `getBytes`, so don't copy that for other users' content.</sub>

**Anonymous public reader** (`public-reader.html`, no sign-in). It reads another user's `/pub` file safely:

```ts
export async function readPublicFile(
  storage: PublicStorage,
  input: string,
  isCurrent: () => boolean = () => true,
) {
  const { address, filename } = parsePublicAddress(input)
  const metadata = await storage.stats(address)
  if (!metadata) throw new Error('No public file exists at that address.')
  if (metadata.contentLength !== undefined) checkByteLength(metadata.contentLength)
  requireCurrent(isCurrent)
  // Bound the stream even if Content-Length is missing or incorrect.
  const response = await storage.get(address)
  const bytes = await readLimitedResponse(response, isCurrent)
  return { address, filename, metadata, bytes }
}
```

<sub>Source: [`src/storage-tools-data.ts` L140-154](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/storage-tools-data.ts#L112-L190). Run against a local testnet. Own data vs. another user's data: [`./concepts.md`](./concepts.md#own-data-vs-another-users-data).</sub>

- **`parsePublicAddress` accepts only canonical `pubky` resources under `/pub/`.** It rejects `?`, `#`, whitespace, control characters, a trailing `/`, and empty, `.` or `..` path segments.
- `stats()` returns `undefined` when the file doesn't exist (HTTP 404 or 410).
- **Cap the response stream yourself. Don't trust `Content-Length`.**
- **Pass the original string as the `Address`.** The parsed path is already encoded, so rebuilding the address from it encodes the path twice.

#### Event history and live updates

```ts
function eventBuilder(session: Session, space: StorageSpace, cursor: string | null) {
  const builder = pubky
    .eventStreamForUser(session.info.publicKey, cursor)
    .path(APP_PATHS[space])
    .maxEventBytes(MAX_EVENT_BYTES) // optional; SSE payload sizes are uncapped by default.

  // Public events work without a session. Private events require owner authorization.
  return space === 'private' ? builder.session(session) : builder
}
```

<sub>Source: [`src/events.ts` L73-81](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/src/events.ts#L73-L81). Run against a local testnet on 0.15.0. `maxEventBytes` needs SDK 0.15+ and doesn't exist in 0.12.0. If an event is larger than `maxEventBytes`, the SDK cancels the response and the stream errors. A `/priv` stream without `.session()` gets a 401.</sub>

- **History:** `reverse().limit(12)` (`EVENT_HISTORY_LIMIT`). **You can't combine `reverse()` with `live()`.**
- **Live stream with resume:**
  1. With no cursor, subscribe to `reverse().limit(1)` (not live) to get the newest event's cursor.
  2. Subscribe with `.live()` from that cursor.
  3. On restart, resume after the last cursor that was delivered. Cursors are stored per space and cleared on sign-out.
- **`subscribe()` can't be aborted.** `stop()` sets a flag, and the reader is cancelled once it exists. Call `reader.cancel()` in `finally` so it runs even if validation or the consumer throws. `.free()` any event that arrives after stop.
- **Validate every event.** `owner.z32()` must equal the session's z32, and `resource.path` must be inside the space's prefix. Otherwise, throw. Free the `owner`, `resource` and event WASM handles in `finally`. Each event maps to `{type: eventType, path: resource.path, cursor, contentHash}`. **Events carry metadata, not file contents.**

#### UI lifecycle and hygiene

- **Run every action through `run(label, task)`.** It sets the busy state, uses a `Symbol` token so only the latest operation updates the UI, and shows `error.message`. Ring sign-in refreshes use `Symbol('ring-signin')` tokens, and stale flows are `cancel()`ed.
- **Handle the back/forward cache:**
  - On `pagehide` with `event.persisted`, pause the Ring waiter. On any other `pagehide`, cancel the waiter and call `flow.suspend()`.
  - Also on `pagehide`, stop event streams and release held editor locks.
  - On `pageshow` with `persisted`, resume or re-initialize.
- **Escape every interpolated HTML string with `escapeHtml` (`& < > " '`).** This includes homeserver data and the authorization URL.
- **CI** ([`ci.yml`](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/.github/workflows/ci.yml), Node 22):
  - Repo root: `npm ci`, `npm run audit`, `npm run check` (prettier + eslint + actionlint).
  - Each template: `npm ci`, `npm run audit`, `npm test --if-present` and a build. The basic app is built for testnet (`VITE_PUBKY_TESTNET=true VITE_PUBKY_STORAGE_NAMESPACE=testnet`) and for mainnet (`VITE_PUBKY_TESTNET=false`).
  - Playwright browser regression tests on Chromium and Firefox, with controlled SDK responses.
- **tsconfig:** `strict`, `noUnusedLocals`, `noUnusedParameters`.
- **Dependabot:** weekly, with `@synonymdev/pubky*` grouped as `pubky-stack`. Other packages have a 7-day cooldown, but `@synonymdev/pubky` is exempt.

## pubky.app

**Repo facts** (at `202b02757229`, default branch `dev`):
- Package `franky` v1.12.0, built with `next build --webpack`. Docker image `node:lts-alpine`. No `engines` field.
- Dependencies: `@synonymdev/pubky` 0.16.2, `pubky-app-specs` 0.8.1, next 16.3.6, react 19.3.0, dexie 4.4.5, zustand 5.0.15, zod 4.5.4, `@tanstack/react-query` 5.102.8, `@synonymdev/locks-sdk` 0.1.0.

**Data flow** ([KB pubky.app](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/pubky-app.md); concept: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read)):
1. The frontend keeps data locally in a browser database.
2. Users publish to their homeservers through the SDK, using [pubky-app-specs](./app-specs.md).
3. Nexus follows the homeservers' event feeds, then fetches and indexes the public records.
4. The frontend refreshes its local cache from Nexus.

Local changes and indexed views don't update everywhere at the same moment. Bookmarks are public social records.

**The network defaults point at staging.** Only dev and test, which parse the config leniently, use `NETWORK_RUNTIME_DEFAULTS`. Deployed containers must set every required `PUBKY_RUNTIME_*` value.
- Nexus: `https://nexus.staging.pubky.app`.
- Homeserver: `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`, at the explicit URL `https://homeserver.staging.pubky.app`. The explicit URL is needed because that pubkey has no resolvable HTTPS endpoint (pubky-core#410).
- Homegate: `https://homegate.staging.pubky.app`.
- HTTP relay: `https://httprelay.staging.pubky.app/inbox`.
- PKARR relays: `https://pkarr.pubky.app`, `https://pkarr.pubky.org`.
- `testnet: false`, `deployEnv: 'staging'`.

### Auth: grant-only now, but don't copy the key custody

- **pubky.app now uses grant auth only** ([ADR-0024](https://github.com/pubky/pubky-app/blob/202b02757229/docs/adr/0024-grant-authentication.md)). The ADR's status line still says "Proposed for merge in PR #2614", but `src` has no cookie-auth calls left.
  - It uses `startGrantAuthFlow` with `saveDelegated()` falling back to `saveLocal()`, plus `resumeDelegatedGrantAuthFlow` / `resumeGrantAuthFlow`, `signer.signin(getAuthClientId())` and `browserSessionStore`.
  - It restores legacy cookie sessions only to revoke them.
- **`clientId`:** `config.authClientId ?? (deployEnv === 'production' ? 'pubky.app' : 'staging.pubky.app')`.
- **Capabilities** (every `/priv` path is [alpha](./shipped-vs-planned.md#priv-private-storage-alpha)):
  - Core: `/pub/pubky.app/:rw`.
  - Locks adds `/priv/social/:rw` (alpha) and the guarded content path with `:r`.
  - Shop adds `/pub/paykit/:rw`, `/priv/pubky.app/:rw`, `/pub/chat/v0/:rw` and `/priv/chat/v0/:rw`.
- **Pending flows:**
  - A tab record lives in `sessionStorage` under `pubky-app-pending-grant-v1`, validated with zod: `{id, context, createdAt, mode, saved}`.
  - For ordinary Ring/Bitkit sign-in, the app also keeps the delegated state in its own IndexedDB store, with a Web Lock per attempt, for a three-minute recovery window. This is because Safari loses `sessionStorage` when it kills the process (#2840).
  - **Resume is refused unless the whole request context matches:** purpose, capabilities, clientId, homeserver, environment, testnet, relay and invite hash.
  - On iOS WebKit, the flow is released while the page is hidden.
- **ADR-0024 security note:** the delegated serialization holds relay and HPKE secrets, and IndexedDB stores them unencrypted. **Never log it or put it in URLs or telemetry.**
- **Key custody: don't copy it.** pubky.app's own onboarding and root-key path holds keys: `HomeserverService.signIn({keypair})`, `createAccount` and `signInCreatedAccount` all take a `Keypair`.
  - It force-republishes the user's homeserver record (`signer.pkdns.publishHomeserverForce`) in two cases only: after its own signup, or, outside staging, when the PKARR record is **provably absent** (`getHomeserverOf` returns `null`). A failed lookup throws instead, and a failed grant exchange never republishes.
  - On staging it fails closed (`WRONG_ENVIRONMENT_HOMESERVER`) unless the record already points at the staging homeserver.
  - **Third-party apps must not hold keys or republish records.** Use the Ring grant flow, as basic-pubky-app does.
- **Signup-token check:** `GET ${homeserverUrl}/signup_tokens/${encodeURIComponent(token)}` through `pubkySdk.client.fetch` with `credentials: 'omit'`.
  - A 404 means `invalid`. Otherwise, the JSON body is `{status: 'valid' | 'used'}`.
  - A network failure throws, so it can't be mistaken for a verification result.
  - Token model: [`./auth.md`](./auth.md#signup-tokens).

### SDK facade

Build the facade once as a singleton, and set PKARR relays explicitly when not on testnet:

```ts
  private static getPubkySdk(): Pubky {
    if (!this.pubkySdk) {
      if (getTestnet()) {
        this.pubkySdk = Pubky.testnet();
      } else {
        const client = new Client({ pkarr: { relays: getPkarrRelays() } });
        this.pubkySdk = Pubky.withClient(client);
      }
    }
    return this.pubkySdk;
  }
```

<sub>Source: [`src/core/services/homeserver/homeserver.ts` L203-213](https://github.com/pubky/pubky-app/blob/202b02757229/src/core/services/homeserver/homeserver.ts#L203-L213). Internal app code. Type-checked in the full app on 0.16.2.</sub>

### Writes: compensate, then retry only what is safe

Copy the code, not [`docs/local-first.md`](https://github.com/pubky/pubky-app/blob/202b02757229/docs/local-first.md). That doc still says writes "Sync to homeserver in background" and that rollback is optional. **The code waits for the homeserver PUT and always rolls back on failure:**
1. Upload files. If any upload fails, delete all of them.
2. Write to Dexie locally. On failure, delete the uploads.
3. **Await** the homeserver PUT. On failure, delete the local post and the uploads, then re-throw.
4. Create tags only after the PUT succeeds.

```ts
  static async commitCreate({ postUrl, compositePostId, post, fileAttachments, tags, isCurrent }: TCreatePostInput) {
    const hasFiles = fileAttachments != null && fileAttachments.length > 0;
    const rollbackUploadedFiles = () =>
      this.rollbackUploadedFiles({
        fileAttachments: hasFiles ? fileAttachments : [],
        compositePostId,
        operation: 'commitCreate',
      });

    if (hasFiles) {
      try {
        await FileApplication.commitCreate({ fileAttachments });
      } catch (error) {
        // Uploads run in parallel and can partially succeed (an article sends
        // its cover and body files as one batch); sweep everything before
        // rethrowing, so nothing of the unpublished post stays behind.
        await rollbackUploadedFiles();
        throw error;
      }
    }

    try {
      await LocalPostService.create({ compositePostId, post });
    } catch (error) {
      await rollbackUploadedFiles();
      throw error;
    }

    try {
      await HomeserverService.request({ method: HttpMethod.PUT, url: postUrl, bodyJson: post.toJson() });
    } catch (error) {
      try {
        await LocalPostService.delete({ compositePostId });
      } catch (rollbackError) {
        Logger.error('[PostApplication.commitCreate] Failed to rollback local post create', {
          compositePostId,
          rollbackError,
        });
      }
      await rollbackUploadedFiles();
      throw error;
    }

    if (tags && tags.length > 0) {
      await TagApplication.commitCreate({ tagList: tags, isCurrent });
    }
  }
```

<sub>Source: [`src/core/application/post/post.ts` L238-284](https://github.com/pubky/pubky-app/blob/202b02757229/src/core/application/post/post.ts#L238-L284). Internal app code. Type-checked in the full app.</sub>

**Homeserver write retries** ([`docs/error-handling.md` L96-107](https://github.com/pubky/pubky-app/blob/202b02757229/docs/error-handling.md#L96-L107)). Every PUT and DELETE goes through `retryHomeserverWrite`:

| Response | Action |
| :-- | :-- |
| 429, 500, 503 | Retry, up to 3 attempts, with jittered exponential backoff (250 ms base, 4 s cap). A 429's `Retry-After` is honored up to 30 s. |
| 409 whose body is exactly `The file changed before the change was published; read it again and retry` | Retry. Nothing was written, so replaying is safe. This is the GCS publish conflict added in homeserver v0.16.2 ([notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.2)). |
| Any other 409 (path collision, unknown lock token), 412, 423 | A real conflict. **Never retry.** |
| Logout or session change (`SESSION_EXPIRED`) | Stop retrying. |

- **Never replay a body built by read-check-write.** Read again inside `retryHomeserverWriteAfterReread`, behind a write fence.
- **Serialize writes to the same file**, so an older retry never lands after a newer write.
- Homeserver v0.15.0 started returning 429 when its storage backend rate-limits a request.

**Cross-Application calls ([ADR-0009](https://github.com/pubky/pubky-app/blob/202b02757229/docs/adr/0009-application-cross-domain-orchestration.md)).** Only a few orchestrating Applications may call other Applications, and call chains have a depth limit. Read the ADR before adding a cross-domain call.

### Local-first reads: `useLocalFirstQuery` (ADR-0011)

```ts
export function usePostDetails(
  compositeId: string | null | undefined,
  options?: UsePostDetailsOptions,
): UsePostDetailsResult {
  const enabled = isLocalFirstQueryEnabled(compositeId, options?.enabled);

  const { data, isLoading } = useLocalFirstQuery<EnrichedPostDetails>({
    queryFn: () => PostController.getDetails({ compositeId: compositeId! }),
    fetchFn: () => PostController.fetch({ compositeId: compositeId! }),
    deps: [compositeId, enabled],
    enabled,
  });

  return {
    postDetails: data,
    isLoading,
  };
}
```

<sub>Source: [`src/hooks/usePostDetails/usePostDetails.tsx` L16-33](https://github.com/pubky/pubky-app/blob/202b02757229/src/hooks/usePostDetails/usePostDetails.tsx#L16-L33). Internal app code. Type-checked in the full app.</sub>

- **`queryFn`** runs inside Dexie's `useLiveQuery`. If it throws, the error is logged and the result counts as `null` (a cache miss).
- **`fetchFn`** runs in `useEffect`, and only when `data === null`. A failed fetch is logged and isn't retried in a loop.
- **Each change to `deps` or `enabled` gets a new query identity**, so a stale hit or miss is never used.
- `isLoading = data === undefined || (enabled && data === null && (isFetching || settledQuery !== query))`.
- **Errors are not exposed.** The hook returns only `{data, isLoading}`, so treat a settled `null` as "missing". Source: [`useLocalFirstQuery.ts`](https://github.com/pubky/pubky-app/blob/202b02757229/src/hooks/useLocalFirstQuery/useLocalFirstQuery.ts#L148-L159).
- **TTL defaults:** `ttlPostMs` 300 000, `ttlUserMs` 600 000, `ttlBatchIntervalMs` 5 000, `ttlPostMaxBatchSize` 20, `ttlUserMaxBatchSize` 20, `ttlRetryDelayMs` 60 000. TTL refresh also runs for signed-out visitors.
- **Stamp `*_ttl.lastUpdatedAt` on every local write.** Otherwise, a stale refresh from Nexus can overwrite a newer local write.
- **A version mismatch deletes the local Dexie database** ([ADR-0019](https://github.com/pubky/pubky-app/blob/202b02757229/docs/adr/0019-dexie-recreate-on-version-mismatch.md)). Synced data comes back on the next sync, but local-only state is lost.
- **ADR-0020 is only *Proposed* (2026-09-07). Don't treat it as current behavior.** Newer ADRs: 0022 Locks creator publishing (Accepted), 0023 article inline media slots (Accepted), 0024 grant-only auth (Proposed), 0025 same-origin shop session (Proposed) ([ADR index](https://github.com/pubky/pubky-app/tree/202b02757229/docs/adr)).

> **"Locks" in pubky.app is not a protocol feature.** [ADR-0022](https://github.com/pubky/pubky-app/blob/202b02757229/docs/adr/0022-locks-creator-publishing.md) describes paid or locked content. A separate Lock Server enforces it through `@synonymdev/locks-sdk`, and the guarded bytes live under `/priv/app.locks/content/` ([alpha](./shipped-vs-planned.md#priv-private-storage-alpha) `/priv`). It is an app-level product feature. **Don't present it as shipped "guarded/encrypted data"**: that is still [planned](./shipped-vs-planned.md). It is also unrelated to the homeserver's WebDAV [file locks](#file-locks-sdk-015).

### Specs builder

Cache one `PubkySpecsBuilder` per user and reset it on sign-out. Pass the **raw z32** key (52 characters, [`./app-specs.md`](./app-specs.md#js-pubkyspecsbuilder)).

```ts
import { PubkySpecsBuilder } from 'pubky-app-specs';
import type { Pubky } from '@/models/models.types';

export class PubkySpecsSingleton {
  private static builder: PubkySpecsBuilder | null = null;
  private static builderPubky: Pubky | null = null;

  private constructor() {}

  static get(pubky: Pubky): PubkySpecsBuilder {
    if (!this.builder || this.builderPubky !== pubky) {
      this.builder = new PubkySpecsBuilder(pubky);
      this.builderPubky = pubky;
    }
    return this.builder;
  }

  static reset(): void {
    this.builder = null;
    this.builderPubky = null;
  }
}
```

<sub>Source: [`src/core/pipes/pipes.builder.ts`](https://github.com/pubky/pubky-app/blob/202b02757229/src/core/pipes/pipes.builder.ts) (one doc comment omitted). Internal app code. Type-checked on specs 0.7.0 and 0.8.1.</sub>

- **There is no `createProfile`**, even though `docs/architecture.md` L237 calls one. In pubky-app-specs 0.8.1, use `createUser` and `createPost`. `createPost` now takes an optional sixth `lock` argument.

### Listing, event streams and errors

- **`list()` picks the client based on who owns the path.** Paths under the active session's own `/pub/` or `/priv/` go through `session.storage.list`. Everything else goes through `publicStorage.list`. A 404 returns `[]`.
- **`listAll` must use a finite limit** (`LIST_DEFAULT_LIMIT = 500`). The source comment says `Infinity` turns into 0 at the WASM boundary and silently returns an empty page. The last URL is the cursor, and listing stops only on a short page. Source: [`homeserver.ts` L805-863](https://github.com/pubky/pubky-app/blob/202b02757229/src/core/services/homeserver/homeserver.ts#L805-L863).
- **`subscribeUserEventStreamForPath`** calls `eventStreamForUser(PublicKey.from(userZ32), cursor).path(prefix).live().subscribe()`.
  - It emits `{cursor, eventType}` and calls `value.free()` in `finally`, ignoring dispose errors.
  - `cancel` forwards to `reader.cancel`. Callers own the reader.
  - It is used to sync the mute list. When it fails to connect, it reconnects; that is intended.
- **Mapping SDK errors to `AppError` by `error.name`** ([`docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/202b02757229/docs/error-handling.md)):

| SDK error | `AppError` |
| :-- | :-- |
| `InvalidInput` | Validation |
| `AuthenticationError`, or HTTP 401 | Auth, `SESSION_EXPIRED` |
| `PkarrError` (lookup failed; absence not proven) | Network, `CONNECTION_FAILED` (retryable) |
| anything else | `httpStatusCodeToError` |

| Helper | True for |
| :-- | :-- |
| `isRetryable` | Network, Timeout, Server, RateLimit |
| `requiresLogin` | Auth + `UNAUTHORIZED` or `SESSION_EXPIRED` |
| `isNotFound` | `NOT_FOUND` or `RECORD_NOT_FOUND` |
| `hasHttpStatus` | Remote HTTP errors only |

`getRetryAfter` returns the retry delay. Catch `AppError` in the UI and decide there what to do:

```ts
import { toast } from '@/molecules/Toaster/toast';

try {
  await PostController.commitCreate({ authorId, content, isArticle, tags, attachments });
} catch (error) {
  if (error instanceof AppError) {
    if (requiresLogin(error)) {
      router.push('/login');
      return;
    }
    toast({ variant: 'error', description: getErrorMessage(error) });
  }
}
```

<sub>Source: [`docs/error-handling.md` L147-161](https://github.com/pubky/pubky-app/blob/202b02757229/docs/error-handling.md#L147-L161). Upstream leaves out the imports for `PostController`, `AppError`, `requiresLogin` and `getErrorMessage`. Type-checked inside pubky-app with those imports added.</sub>

## Pubky Explorer: the read pattern

Explorer uses **only the unauthenticated `pubky.publicStorage`**: no signer, no session and no Nexus. Copy its read pattern for any viewer of public data, but not its cursor handling (see below).
- **Use it to tell a storage problem from an indexing problem.** Explorer shows the files that are actually stored, while Nexus builds indexed views. A file can exist on a homeserver before it appears in an app's indexed view ([KB Explorer](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/pubky-explorer.md)).
- Own data vs. another user's data: [`./concepts.md`](./concepts.md#own-data-vs-another-users-data).

**Running it** (main at `02bdce2ec1f4`; `@synonymdev/pubky ^0.6.0`, solid-js `^1.9.11`):
- `npm run build:pages` builds `_site` plus a testnet variant (`VITE_TESTNET=true`, `--base /testnet/`). Preview both with `npm run preview:pages`.
- **Testnet Explorer:** <https://explorer.pubky.app/testnet/>. The hosted app connects to `localhost`, so allow local-network access if the browser asks. It needs a local PKARR relay on port `15411` ([`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet)). `TestnetBanner` probes `http://localhost:15411/`.

```ts
import { Pubky } from "@synonymdev/pubky";
import type { Address } from "@synonymdev/pubky";

export const IS_TESTNET = import.meta.env.VITE_TESTNET === "true";
export const pubky = IS_TESTNET ? Pubky.testnet() : new Pubky();
const publicStorage = pubky.publicStorage;

function listDirectory(
  path: string,
  cursor: string | null,
  limit: number,
): Promise<string[]> {
  const address = toAddress(`pubky://${path}`);
  return publicStorage.list(address, cursor, false, limit, store.shallow);
}

function toAddress(value: string): Address {
  return value as Address;
}
```

<sub>Source: [`src/state.ts` L1-2, L5-7, L404-415](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L404-L415). Run against a local testnet on SDK 0.6.0, 0.12.0, 0.15.0 and 0.16.2. `Address` is a template-literal type, so a plain `string` needs a cast. The testnet flag works differently from the template's: Explorer is on mainnet unless `VITE_TESTNET === 'true'`.</sub>

- **The page size is `Math.ceil(window.innerHeight / 40)`.** Always pass a finite limit.
- **Don't copy Explorer's cursor handling.** Its `loadMore` (state.ts L126-127) takes the cursor from the last item of `store.list`, which `sortItems` has re-sorted (directories first, then name ascending or descending, L457-465). Use the **last URL of the raw `list()` result** as the cursor instead, as basic-pubky-app does.
- **Cache:** `sessionStorage` under `pkx-cache-v1`.
- **Weak key check:** `PUBKEY_RE = /^[a-z0-9]{52}$/i` ignores case and doesn't check the z-base-32 alphabet. Don't copy it as a validator.
- **Treat all homeserver content as untrusted** when you preview it.

**Errors from public reads.** Check `name` and `data.statusCode` first. Fall back to message regexes only after that:

```ts
function normalizeError(e: any): string {
  if (!e) return "Unknown error";
  if (typeof e === "string") {
    if (e.toLowerCase().includes("error sending request"))
      return "Network error or PK not found";
    return e;
  }
  const name = e?.name;
  const statusCode =
    e?.data && typeof e.data === "object" && "statusCode" in e.data
      ? (e.data as { statusCode?: number }).statusCode
      : undefined;
  if (name === "RequestError" && typeof statusCode === "number") {
    if (statusCode === 404) return "Not found";
    if (statusCode === 403) return "Forbidden";
    return `Request failed (${statusCode})`;
  }
  if (name === "InvalidInput") return "Invalid input";
  const msg = e.message || "Unknown error";
  if (/abort/i.test(msg)) return "Request canceled";
  if (/404/.test(msg)) return "Not found";
  if (/403/.test(msg)) return "Forbidden";
  if (/timeout/i.test(msg)) return "Request timeout";
  return msg;
}
```

<sub>Source: [`src/state.ts` L497-521](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L497-L521). Run against a real SDK 404 (`RequestError`, `statusCode: 404`) on 0.6.0–0.16.2. Error names: [`./sdk-js.md`](./sdk-js.md#error-handling).</sub>

## workshop: the end-to-end flow

**Setup** (pinned at `b952363b519a` on the default branch `spanish`; GitHub also has `english` and `feat/render-url`):
- It pins the SDK to exactly `0.6.0`, and `engines` requires Node `>=20`.
- Run it with `npm run workshop -- --homeserver pubky<z32> --invite INVITE-123`.

**Flow in `workshop.mjs`** ([L110-270](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L110-L270)):
1. `setLogLevel(level)`, only when `--log` is passed, and **before any Pubky object is created**.
2. `new Pubky()`.
3. Load the keypair: `Keypair.fromRecoveryFile(bytes, passphrase)` reads `./pubky.recovery`. If there is no file, it calls `Keypair.random()` and writes `createRecoveryFile(passphrase)`.
4. `pubky.signer(keypair)`.
5. `signer.pkdns.getHomeserver()`. If a homeserver is already published, it skips signup.
6. `signer.signup(homeserver, invite || null)`. It treats the result as a session and reads `.info.publicKey` from it. ⚠️ **This breaks on 0.10+**, where `signup` returns `void`.
7. `signer.signinBlocking()` with no `clientId`, which creates the real session. ⚠️ **This breaks on 0.10+.** Pass a `clientId`, as in the [hello world](#hello-world-on-vite-starter).
8. `session.storage.putJson('/pub/pubky-workshop/hello.json', payload)`.
9. Read it back publicly with `pubky.publicStorage.getJson`.
10. Read another user's resource with `publicStorage.getText(other)`.

```js
  await session.storage.putJson(DEFAULT_WRITE_PATH, payload);

  // PublicStorage uses addressed URIs: pubky<user>/pub/...
  const selfAddress = `${session.info.publicKey.toString()}${DEFAULT_WRITE_PATH}`;
  const roundtrip = await pubky.publicStorage.getJson(selfAddress);
```

<sub>Excerpt: [`workshop.mjs` L242-250](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L242-L250) (comment translated from Spanish). Run against a local testnet on 0.6.0, 0.12.0, 0.15.0 and 0.16.2. In strict TypeScript, cast `selfAddress as Address`, or the call fails with TS2345.</sub>

**Inspection links.** PKDNS Digger takes the **raw z32** key. Explorer's `#p=` takes the `pubky`-prefixed display form or a resource path.

```js
export function pkdnsUrl(publicKeyZ32) {
  return `https://pkdns.net/?id=${publicKeyZ32}`;
}

export function explorerUrl(pubkyOrResource, path = "") {
  if (path) {
    const id = pubkyOrResource.split("/")[0];
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `https://explorer.pubky.app/#p=${encodeURIComponent(`${id}${suffix}`)}`;
  }
  return `https://explorer.pubky.app/#p=${encodeURIComponent(pubkyOrResource)}`;
}
```

<sub>Source: [`utils.mjs` L15-26](https://github.com/pubky/workshop/blob/b952363b519a/utils.mjs#L15-L26).</sub>

## Upstream

- Templates: [README](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/README.md) · [basic-pubky-app README](https://github.com/pubky/pubky-app-templates/blob/700f4a04f97c/basic-pubky-app/README.md) · [live previews](https://pubky.github.io/pubky-app-templates/) · [Pubky Ring Simulator](https://simulator.pubkyring.app)
- KB: [Developer Guide](https://pubky.org/developer-guide/) ([source](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/developer-guide.md)) · [app architectures](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/app-architectures.md) · [pubky.app](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/pubky-app.md) · [Explorer](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/src/content/docs/pubky-explorer.md) · [snippets](https://github.com/pubky/pubky-knowledge-base-v2/blob/44fcaed5b122/snippets/js/src/developer-guide.ts)
- pubky.app: [`docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/202b02757229/docs/error-handling.md) · [`docs/local-first.md`](https://github.com/pubky/pubky-app/blob/202b02757229/docs/local-first.md) · [ADRs](https://github.com/pubky/pubky-app/tree/202b02757229/docs/adr)
- Explorer: [`src/state.ts`](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts) · workshop: [README](https://github.com/pubky/workshop/blob/b952363b519a/README.md)
- SDK: [npm](https://www.npmjs.com/package/@synonymdev/pubky) · [README @ v0.15.0](https://github.com/pubky/pubky-homeserver/blob/v0.15.0/pubky-sdk/bindings/js/pkg/README.md) · [`pubky.d.ts` @ 0.15.0](https://unpkg.com/@synonymdev/pubky@0.15.0/pubky.d.ts) · [@ 0.16.2](https://unpkg.com/@synonymdev/pubky@0.16.2/pubky.d.ts) · [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/) · [homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
