# Reference apps & starter templates

> Starting a new app? Read [new-project.md](./new-project.md) first. It owns intake, network choice and the version check. This file has the detail it links to.

Four open-source codebases show how real Pubky code is built. **Start new web apps from `basic-pubky-app`.** pubky.app also uses grant auth, but it is a large app that holds keys itself, so don't start from it. Explorer and workshop pin SDK 0.6.0, so check [version drift](#version-drift-check-before-copying-any-call) before you copy from them.

| Codebase | What it is | Architecture | SDK pin |
| :-- | :-- | :-- | :-- |
| [pubky-app-templates](https://github.com/pubky/pubky-app-templates) · [live previews](https://pubky.github.io/pubky-app-templates/) | `basic-pubky-app` (Vite + TS: Ring sign-in, shared browser sessions, `/pub` + `/priv` (alpha) storage, file locks, uploads, optional encrypted uploads with local key recovery, custom proofs, events) and `vite-starter` (no Pubky code) | Client ↔ homeserver, authenticated | `^0.17.1` |
| [pubky-app](https://github.com/pubky/pubky-app) (pubky.app) | The main social web app (Next.js) | Shared indexer (Nexus) + local cache | `0.17.1` exact |
| [pubky-explorer](https://github.com/pubky/pubky-explorer) · <https://explorer.pubky.app> | Read-only browser for any user's `/pub` tree (Solid.js) | Client ↔ homeserver, unauthenticated | `^0.6.0` |
| [workshop](https://github.com/pubky/workshop) | Spanish teaching CLI, "De cero a Pubky" | Client ↔ homeserver, authenticated | `0.6.0` exact |

Shared concepts live elsewhere; link, don't restate:
- Identity, `pubky://` addressing, PKARR, write-vs-read split: [`./concepts.md`](./concepts.md).
- Data contract: [`./app-specs.md`](./app-specs.md). What has shipped: [`./shipped-vs-planned.md`](./shipped-vs-planned.md).
- Auth: [`./auth.md`](./auth.md). JS API: [`./sdk-js.md`](./sdk-js.md). Nexus reads: [`./nexus-api.md`](./nexus-api.md). Local testnet: [`./testing-and-testnet.md`](./testing-and-testnet.md).

> **Scope.** Many patterns below are **app choices, not protocol guarantees**: the Dexie cache, write compensation and retries, the `AppError` taxonomy, the template's encryption envelope and its error heuristics. The `/pub` path layout is not stabilized, Nexus `/v0` is unstable, and pubky-app-specs is v0.x. **basic-pubky-app and pubky.app write `/priv`.** `/priv` is **alpha and not for production**: access-controlled, **not encrypted** (the homeserver operator can read it), no backup. See [`/priv` private storage (alpha)](./shipped-vs-planned.md#priv-private-storage-alpha). The template's encrypted uploads are the app's own crypto on top of scoped-key delivery, **not encrypted storage**, which is still [planned](./shipped-vs-planned.md#still-planned).

## Version drift: check before copying any call

Snapshot from 2026-11-12. Run `npm view @synonymdev/pubky dist-tags` yourself, as [new-project.md](./new-project.md#3-check-the-sdk-version-first) says.
- `@synonymdev/pubky`: `latest` = **0.18.0** (2026-11-09). Never install `alpha` (0.10.0-alpha.0) or `next` (0.6.0-rc.7); both are older than `latest`. `pubky-app-specs`: `latest` = **0.8.1**.
- Releases after 0.16.2: **0.17.1** (2026-10-26) and **0.18.0**. There is no 0.17.0 on npm.
- **Neither reference app is on 0.18.0.** The template pins `^0.17.1`; for a 0.x version npm's caret locks the minor, so `npm update` stays on 0.17.x. pubky.app pins `0.17.1` exactly. To upgrade, read the [homeserver release notes](https://github.com/pubky/pubky-homeserver/releases), then edit the version in `package.json`. The templates repo has its own upgrade procedure in `.agents/skills/pubky-sdk-upgrade/SKILL.md` ([AGENTS.md](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/AGENTS.md)).
- **Upgrade all apps on one origin together.** Template README: *"Signed approvals use V2 browser records that older SDKs cannot safely share: upgrade every app sharing the origin and reload its open tabs together."*
- **0.17.1, for apps** ([notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1)):
  - Automatic grant-refresh failures are typed as `CredentialRefreshError` (#698).
  - `RequestError` exposes a category in `data.reason` (#717); see [Errors and uncertain writes](#errors-and-uncertain-writes).
  - `session.storage.putBlob(path, blob)` uploads a `Blob`/`File` without WASM copies (#667); `putBlobLocked(lock, body)` is its locked twin.
  - **Breaking:** `HEAD` now returns 405 on `/signup_tokens/{token}`, admin `/generate_signup_token` and both `/events-stream` endpoints. Use `GET`.
- **0.18.0 breaking changes, re-check copied code** ([notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0)):
  - Legacy Base32 timestamp cursors are removed from `/events` and `/events-stream`; a non-numeric cursor gets 400. Discard any persisted legacy cursor.
  - **Storage paths are percent-encoded once.** JS `resource.path`, `toPubkyUrl()`, `list()` entries and `event.resource.path` are now **plain** names. Files written by SDK 0.6–0.17 under names that HTTP escapes (e.g. `pub/my file.txt`) are stored as `pub/my%20file.txt` and must be read at that stored name from 0.18. Code comments that assume encoded paths (the template's "The parsed path is already encoded; rebuilding an address would encode it twice") describe ≤0.17 behavior. The template's own file names use only `[a-zA-Z0-9._-]`, which HTTP doesn't escape.
  - New: `GET /account`, exposed in JS as `session.grant.account()` (`GrantSession` only; `Session` has no `account()`). It needs a root `/:r` scope, so a path-scoped session like the template's gets 403. Grant sign-in links can require an expected identity.
- Typings: [`pubky.d.ts` @ 0.17.1](https://unpkg.com/@synonymdev/pubky@0.17.1/pubky.d.ts) (both app pins) · [@ 0.18.0](https://unpkg.com/@synonymdev/pubky@0.18.0/pubky.d.ts) (latest) · [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/).

| Legacy call (still in 0.17.1 and 0.18.0, `@deprecated`) | Use instead |
| :-- | :-- |
| `startCookieAuthFlow` | `startGrantAuthFlow` |
| `resumeCookieAuthFlow` | `resumeGrantAuthFlow` (or `resumeDelegatedGrantAuthFlow`) |
| `signinCookie()` / `signinCookieBlocking()` | `signin(clientId)` / `signinBlocking(clientId)` |
| `session.export()` | `GrantSession.exportLocalSecret()`, or `browserSessionStore` for delegated sessions |

- **Cookie auth has an end date.** Homeserver v0.18.0 notes: deprecated since v0.10.0, now only limited security maintenance, and it *"will be removed in August 2027"*. See [`./auth.md`](./auth.md#deprecated-cookie-auth).
- **`signin` / `signinBlocking` require a `clientId` string** (since 0.10.0). A 0.6.0-style call with no argument fails in strict TypeScript.
- **`signup()` returns `void` on 0.10+.** Call `signin(clientId)` after it; never use its result as a session.
- SDK error names: [`./sdk-js.md`](./sdk-js.md#error-handling).
- **KB snippets are still pinned to 0.14.0.** The KB `sdk.md` "Storage Locking" section says the JS bindings have no lock helpers. That is out of date: 0.15.0+ has them (see [File locks](#file-locks-sdk-015)).

**Don't ship the React `PubkyProvider` from [pubky-ai-kit](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md).** It is pre-0.10 code that holds the user's keys:
- It calls `pubky.signer(keypair).signin()` with no `clientId` (L1184).
- It saves the deprecated `next.export()` to `localStorage` under `pubky_session` (L1157, L1185).
- It hardcodes `Pubky.testnet()` (L1160).
- Its `usePubkySpecs` / `PostCreator` example (L593-640) uses `PubkyAppPostKind.Short` without importing it.

Use basic-pubky-app's grant flow with `browserSessionStore` instead.

## Architecture: which codebase to copy

Source: [KB App Architectures](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/app-architectures.md). Concept: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read).

| Approach | Use when | Copy |
| :-- | :-- | :-- |
| Client ↔ homeserver | The app already knows which users and paths it needs (e.g. a bookmark tool) | basic-pubky-app; Explorer for public reads; workshop |
| Custom backend | Your app uses its own data model and needs search, feeds or relationships across many users; index only what it needs | None of these codebases |
| Shared indexer | Several clients need the same indexed data. Nexus does this for the shared social data model; pick a service by its coverage and filtering policy | pubky.app (Nexus, [`./nexus-api.md`](./nexus-api.md)) |

- **Writes always go to the user's homeserver**, whichever read approach you pick. You can combine approaches.
- **Indexed results lag behind writes and depend on what the indexer covers and filters.** Decide per screen whether that lag is acceptable, especially right after the user publishes.

## pubky-app-templates

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app   # or /vite-starter
```

<sub>Both variants were scaffolded with tiged 2.12.8.</sub>

- Pinned at [`840fcf1`](https://github.com/pubky/pubky-app-templates/commit/840fcf1bef47) ("Adopt Pubky SDK 0.17.1 encryption and custom proofs (#60)").
- Both templates need Node `^20.19.0 || >=22.12.0`.
- Live previews come in [mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) and [testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/) builds. Both are production builds, so they offer **Pubky Ring sign-in only**.
- The KB [Developer Guide](https://pubky.org/developer-guide/) is the tutorial. The old `/explore/pubkycore/getting-started/` URL (still linked from the template README) redirects there.
- Upstream intent ([AGENTS.md](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/AGENTS.md)): the templates demonstrate SDK usage through reusable functions. Copy functions, not the vanilla UI.

### vite-starter

A plain Vite + TypeScript shell (`typescript ~7.0.2`, `vite ^8.3.5`) with **no Pubky SDK**. `src/main.ts` only sets the text of `#app` to `'Vite Starter'`. The Developer Guide clones it, runs `npm install && npm install @synonymdev/pubky`, and replaces that line with the hello world below.

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

<sub>Source: KB [`snippets/js/src/developer-guide.ts` L4-13, L16-50](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/snippets/js/src/developer-guide.ts#L16-L50), unchanged since `44fcaed`. CI type-checks it against SDK 0.14.0. Run against a local testnet on 0.12.0, 0.15.0, 0.17.1 and 0.18.0. Change from upstream: upstream logs `signer.publicKey.z32()`, but human-facing output should use `toString()` (`pubky<z32>`); see [key formats](./concepts.md#public-key-string-formats). The homeserver key is the fixed local-testnet key.</sub>

- **`setLogLevel` works only once, and only before the client is created.**
- **Local testnet.** The Developer Guide starts one with [Pubky Docker](https://github.com/pubky/pubky-docker): `cp .env-sample .env`, then `docker compose up homeserver -d` (it also links a native alternative). Ports: `15411` PKARR relay, `15412` HTTP relay, `6286` homeserver ICANN HTTP, `6287` PubkyTLS, `6288` admin. A Docker restart wipes stored files and PKARR records. Setup choices: [new-project.md](./new-project.md#5-get-the-network-running-and-the-user-an-account) and [`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet).
- **Creating an identity and signing up inside the app are dev-only shortcuts.** Real apps assume the user already has a homeserver account; send new users to separate onboarding (e.g. <https://pubky.app/onboarding/human>).
- On first signup the console may show a 404 for `http://localhost:15411/<user-public-key>`: the SDK checking for an existing PKARR record. If signup continues, ignore it.
- For production, replace `Pubky.testnet()` with `new Pubky()`. It resolves PKARR through the Mainline DHT and relays, and uses a public HTTP relay for auth.
- **Storage layout (KB):** put each independently edited record in its own file (e.g. `/pub/myapp/posts/001.json`). A write replaces everything at one path, so separate files mean smaller updates, lazy loading via listing, and fewer write conflicts. Keep fields that are read and updated together in one file.

### basic-pubky-app

A standalone app that uses homeservers directly as its data layer: no indexer, no aggregator, no pubky.app social data. It shows Ring sign-in, shared browser sessions, public and private (alpha) storage, file locks, uploads, optional encrypted uploads with local key recovery, custom grant proofs, and event history with live updates. Key management stays in Pubky Ring.

- Run on testnet: `VITE_PUBKY_TESTNET=true npm run dev`.
- `npm test` runs `node --test` against a mocked SDK (sessions, capabilities, locks, storage, encryption and proof validation, events); no homeserver needed. `npm run build` runs `tsc && vite build`.

**File map**, for pruning ([README: "Keeping Only the Examples You Need"](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/README.md#keeping-only-the-examples-you-need)):

| File | Role |
| :-- | :-- |
| `src/config.ts` | All app settings |
| `src/client.ts` | The SDK facade that every module shares |
| `src/pubky.ts` | Account, Ring sign-in, sessions |
| `src/access.ts` | Capability checks |
| `src/storage.ts` | Note files and locks |
| `src/storage-tools-data.ts` | Uploads (plain and encrypted) and the public reader |
| `src/encryption.ts` | Template encryption envelope over scoped keys |
| `src/encryption-recovery.ts` (+ `-ui.ts`) | Offline decryption of a ciphertext download with saved keys |
| `src/proofs.ts` (+ `proofs-ui.ts`) | Custom grant proofs: sign and verify |
| `src/events.ts` | Event history and live stream |
| `src/navigation.ts` | Links between the pages |
| `index.html` (input `app`), `public-reader.html` (`reader`), `tools.html` (`tools`) | The three rolldown inputs in `vite.config.js`. Tools holds message signing and encrypted-download recovery. |

- **Keep only the public reader:** delete `index.html`, `tools.html`, `src/main.ts`, `src/tools.ts`, `src/app.ts` and `tests/browser-cache.test.js`; rename `public-reader.html` to `index.html`; in `vite.config.js` remove the `app` and `tools` inputs and set `reader: resolve(import.meta.dirname, 'index.html')`; remove the **Your files** and **Tools** entries from `src/navigation.ts`.
- **Remove the reader:** delete its files, its `vite.config.js` input **and** its entry in `src/navigation.ts`.

#### Config: `src/config.ts`

**Change `APP_CLIENT_ID` first.** The paths and capabilities derive from it. Capability syntax: [`./auth.md`](./auth.md#capabilities).

```ts
import { validateCapabilities } from '@synonymdev/pubky'
import type { Capabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template' as const
export type StorageSpace = 'public' | 'private'
export const APP_PATHS = {
  public: `/pub/${APP_CLIENT_ID}/`,
  private: `/priv/${APP_CLIENT_ID}/`,
} as const
export const APP_CAPABILITIES = validateCapabilities(
  `${APP_PATHS.public}:rw,${APP_PATHS.private}:rw,${APP_PATHS.public}attachments/:e,${APP_PATHS.private}attachments/:e`,
) as Capabilities

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

<sub>Source: [`basic-pubky-app/src/config.ts` L1-29](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/config.ts). Needs Vite's `import.meta.env` types. Run on SDK 0.17.1 and 0.18.0 with an `import.meta.env` shim; `validateCapabilities` accepts the `:e` scopes.</sub>

- **`rw` on both app folders; `e` (encryption keys) only on the two `attachments/` folders.** `e` and `r`/`w` are independent, and the signer may narrow folders or decline `e`: see [scoped encryption keys](./shipped-vs-planned.md#scoped-encryption-keys-shipped-key-delivery-only) and [`./auth.md`](./auth.md#scoped-encryption-keys).
- **`e` forces a signed approval.** The template signs in with `approvalFormat: 'signedApprovalV1'`; a bare-grant request containing `e` is rejected, and every signed-approval request needs a signer that supports it. Check signer support (including released Pubky Ring) in [approval format](./auth.md#approval-format-bare-grant-or-signed-approval). **If you don't need encryption, remove both the `:e` scopes and the `approvalFormat` option.**
- **The template requests `/priv` by default.** Before shipping to production, remove the `private` space and its capability: `/priv` is [alpha](./shipped-vs-planned.md#priv-private-storage-alpha). README: *"Private storage is access-controlled. Notes and ordinary uploads remain unencrypted, so the Homeserver operator can read them."* `/priv` can't be shared with selected people. The README still has no alpha warning.
- Deleting a public file doesn't remove copies others already downloaded.

```ts
import { Pubky } from '@synonymdev/pubky'
import { IS_TESTNET, TESTNET_HOST } from './config'

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()
```

<sub>Source: [`src/client.ts` L1-4](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/client.ts). Create one facade per app. Run against a local testnet.</sub>

#### Relay config

**Testnet is the default.** Mainnet is selected only by the exact string `VITE_PUBKY_TESTNET=false`, because the check is `!== 'false'`.

| Condition | HTTP (auth) relay passed as `relay` to `startGrantAuthFlow` |
| :-- | :-- |
| `VITE_PUBKY_HTTP_RELAY` is set (non-empty after trimming) | That URL |
| otherwise, testnet | `http://${VITE_PUBKY_TESTNET_HOST ?? 'localhost'}:15412/inbox/` |
| otherwise, mainnet | `undefined`, so the SDK's default HTTP relay applies |

- `VITE_PUBKY_TESTNET_HOST` feeds both `Pubky.testnet(host)` and the testnet relay URL, so setting a LAN host changes both.
- **Signed approvals can silently stall on a local testnet.** `http-relay` and `pubky-testnet` cap request bodies at **2 KiB** by default. A signed approval (especially one carrying encryption keys) can get **HTTP 413 at the signer**, and the app receives neither approval nor error: the flow waits until expiry or cancel. The SDK doesn't reduce scopes or fall back to a bare grant. Run a relay with a larger limit and point `VITE_PUBKY_HTTP_RELAY` at its inbox URL. Apps can't change a remote relay's limit. Details: [`./auth.md`](./auth.md#relays), [homeserver relay limits](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/scoped-encryption-keys.md#relay-limits).

```bash
http-relay --max-body-size 16384
```

<sub>Source: [template README L49](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/README.md). Run with `http-relay` 0.8.0 (`cargo install http-relay`): default limit 2048 B; with this flag a 10 KB body is accepted and a 20 KB body gets 413. Embedded equivalent: `HttpRelay::builder().max_body_size(16 * 1024)`.</sub>

- **The HTTP relay (auth) and the PKARR relays (identity resolution) are separate settings.** The template sets no PKARR relays, so `new Pubky()` uses the defaults. Browsers can't query the UDP Mainline DHT, so the SDK resolves through HTTPS PKARR relays. To set them yourself, as pubky.app does:

```ts
  const client = new Client({
    pkarr: {
      relays: ["https://pkarr.pubky.org"],
    },
  });

  const pubky = Pubky.withClient(client);
```

<sub>Source: KB [`developer-guide.ts` L68-74](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/snippets/js/src/developer-guide.ts#L66-L76). CI type-checks it against 0.14.0. Constructed on 0.6.0–0.18.0; not run against mainnet. A custom HTTP relay is the grant flow's `relay` option, shown in KB [L55-63](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/snippets/js/src/developer-guide.ts#L52-L64).</sub>

#### Sign-in with Pubky Ring (grant flow)

First call `pubky.browserSessionStore.isAvailable()` (needs a secure context, IndexedDB and Web Locks). Then resume a pending flow from `sessionStorage` if one exists. Otherwise start a new flow:

```ts
  const flow = await pubky.startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
    clientId: APP_CLIENT_ID,
    relay: HTTP_RELAY,
    approvalFormat: 'signedApprovalV1',
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

<sub>Excerpt: [`src/pubky.ts` L98-120](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/pubky.ts#L98-L120). Run against a local testnet on 0.17.1 and 0.18.0, approved programmatically with `Signer.approveAuthRequest(authorizationUrl)`. In Node, `saveDelegated()` throws "not delegated", so the `saveLocal` fallback runs. `PENDING_AUTH_KEY` is `${SESSION_KEY}:pending-auth`. Why delegated first, then local: [`./auth.md`](./auth.md#resume-after-reload-or-restart). Show `flow.authorizationUrl` as a QR code, a clickable link and a **Copy link** button. URL format: [`./auth.md`](./auth.md#pubkyauth-deep-links).</sub>

- **`approvalFormat: 'signedApprovalV1'` is there only to receive `e` keys.** See the [config notes](#config-srcconfigts) before keeping it.
- **Expect a narrowed grant.** The signer may approve fewer folders or no keys. Normal storage still works in approved folders; a read-only grant allows listing, downloads and events with editing disabled. Gate every action on the session's actual capabilities ([`hasStorageAccess`](#session-persistence-and-sign-out)).

**Resume and cleanup rules:**
- **Resume:** for `mode === 'delegated'`, `await pubky.resumeDelegatedGrantAuthFlow(state)` (async). For `'local'`, `pubky.resumeGrantAuthFlow(state)` (sync). `options.fresh` deletes the pending record first.
- **After a failed resume, clear the pending record only for a `SyntaxError`, an invalid-saved-session error or an expired-auth error.** Re-throw transient storage and network errors so the link stays resumable.
- **Keep pending state only in tab-scoped `sessionStorage`.** Never in `localStorage` or logs: it holds the relay secret, and for local flows the PoP secret too.
- **Cancel and suspend reject immediately.** `awaitApproval` is `Promise.race([approval, cancellation]).finally(release)`. `cancel()` abandons the flow and deletes the pending link. `suspend()` stops this page's waiter but keeps the resumable state; the template calls it when the page really unloads. If a cancelled flow is approved late, the session is saved and then revoked with `signout()`. `flow.free()` stays inside try/catch.
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

<sub>Source: [`src/pubky.ts` L393-400](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/pubky.ts#L393-L400). `errorText` also walks `error.cause` recursively. The message is present in the 0.12.0, 0.15.0, 0.16.2, 0.17.1 and 0.18.0 binaries; no real relay expiry was triggered. Message matching can break between SDK versions: re-check it on every SDK bump.</sub>

**Testing without a phone:** use the [Pubky Ring Simulator](https://simulator.pubkyring.app).
1. In the template, click **Copy link**.
2. In the simulator, choose **Shortcut** mode and paste the link into *Auth link*. It creates an identity, signs it up on the local homeserver and approves the request.
3. The template is already polling, so it signs in on its own.

**Regular** mode lets you create or pick identities yourself. The hosted simulator connects to `localhost`, so your browser may ask for local-network access. If the app keeps waiting after approval, suspect the [2 KiB relay limit](#relay-config).

#### Session persistence and sign-out

Browser store API: [`./auth.md`](./auth.md#persist-and-restore) and [`./sdk-js.md`](./sdk-js.md#session).

- **Store only the opaque `stored.id` in `localStorage`, after `browserSessionStore.save(session)`.** The key is `SESSION_KEY` = `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`, or `${APP_CLIENT_ID}:session` with no namespace. **Set `VITE_PUBKY_STORAGE_NAMESPACE` when several builds share one origin** (CI uses `testnet`).
- **Select a session under a Web Lock:** `navigator.locks.request(`${SESSION_KEY}:selection`)`, calling `browserSessionStore.restore(stored.id)` again before writing the pointer.
- **Revoke sessions that lose the selection** with `session.signout()`. A `${SESSION_KEY}:pending-revocation:<id>` key tracks it, and `restoreSavedSession` retries the revocation on the next load.
- `.free()` each `StoredSessionInfo` handle.
- **Sign-out:** `await session.signout()`, then delete the `localStorage` pointer. Sign-out revokes the grant and clears affected tabs. **If sign-out fails, keep the SDK record:** it holds the pending-revocation marker and blocks authenticated requests until a retry succeeds. **Deleting a local session record alone does not revoke a grant.**
- **Sign-out also deletes saved encryption keys** for that record; a ciphertext download is not a key backup (see [Encrypted uploads](#encrypted-uploads-app-side-crypto)).
- **Cross-tab sync:** listen for the window `pubky-session-changed` `CustomEvent` (`detail.action` is `'removed'` with an `id`, or `'cleared'` with `id: null`), and for `storage` events on `SESSION_KEY`. ⚠️ The SDK's `index.js` dispatches `pubky-session-changed` (through 0.18.0), but `pubky.d.ts` and the README don't mention it. It is undocumented: re-check it on every SDK bump.

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

<sub>Source: [`src/pubky.ts` L402-413](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/pubky.ts#L402-L413). Every alternative except `Invalid stored session record:` is present in the 0.17.1 and 0.18.0 binaries; that one has been absent since 0.16.2, so it never matches there. On 0.15+, **don't** forget a session on a bare `AuthenticationError`.</sub>

**Check the session's capabilities before every storage call.** Writes need `rw`; reads (listing, downloads) need only `r`:

```ts
export function hasStorageAccess(session: Session, space: StorageSpace, actions = 'rw') {
  const path = APP_PATHS[space]
  const capabilities = session.info.capabilities
  return [...actions].every((action) =>
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

<sub>Source: [`src/access.ts` L4-19](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/access.ts#L4-L19). Run against a local testnet with a grant session and a root `/:rw` session. A scope ending in `/` matches by prefix; any other scope must match exactly. `listUploadedFiles` and `readUploadedFile` call `requireStorageAccess(session, space, 'r')`.</sub>

- **To add permissions to an older session** (e.g. one saved before `/priv` or `e` was requested), sign out to revoke its grant, then authorize again.

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

<sub>Source: [`src/pubky.ts` L38-52](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/pubky.ts#L38-L52). Run against a local testnet.</sub>

- The **New identity** button appears only under `vite dev` on testnet. `VITE_SHOW_DEVELOPMENT_SIGNUP=false` hides it, and the function checks the same flag itself.
- It needs a homeserver with open signup (`signup_mode = "open"`).
- **It supplies no encryption keys and no grant**, so encrypted uploads and custom proofs need a Ring sign-in.
- **It holds a raw keypair in the browser. Never ship it.**
- **`isClosedSignupError` is a heuristic.** It returns true for any HTTP 400, for a 401 or 403 whose text matches `/signup|token|invite/`, for any `AuthenticationError`, and for text containing `signup token required`, `signup_mode` or `token required`. On a match the template throws a friendly `Error` with `cause` set to the original.

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

<sub>Source: [`src/storage.ts` L64-93](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/storage.ts#L62-L93). `LIST_PAGE_SIZE` is 50 (L62). Argument order: `list(path, cursor, reverse, limit, shallow)`. Run against a local testnet: a missing folder returns `[]`; 57 files list over 2 pages. General pagination: [`./sdk-js.md`](./sdk-js.md#listing-and-pagination).</sub>

- **Use the last URL as the cursor.** Stop on an empty page, an unchanged cursor or a short page. **Always pass a finite limit.** A 404 means the folder doesn't exist yet: treat it as empty.
- **Validate every listed URL.** Parse it with `PubkyResource.parse`, then require `owner.z32()` to equal the session's z32 and `path` to equal `${dir}${id}.json` exactly. Otherwise throw "The homeserver returned a file outside the selected folder."
- **Take the ID from the filename, never from the JSON body.** File content must never decide which path you write or delete. IDs come from `crypto.randomUUID()` and must match `/^[a-zA-Z0-9_-]+$/`.
- `saveFile` writes `{id, title, body, updatedAt}` to `${APP_PATHS[space]}files/${id}.json`. New files use `session.storage.putJson`. **Editing an existing file needs a lock** and uses `putTextLocked(lock, JSON.stringify(file))`; there is no `putJsonLocked`.
- `readFile` runs `getJson` and `stats(path)` in parallel. If `stats` fails, the file is shown with `metadataUnavailable`. `stats`: [`./sdk-js.md`](./sdk-js.md#metadata-exists-and-stats).

#### File locks (SDK 0.15+)

The SDK added WebDAV locks in 0.15.0. The homeserver added basic locks in v0.13.0, and from v0.15.0 refuses a locked write once the lock is lost ([v0.15.0 notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.15.0)). **Full API: [SDK README](https://github.com/pubky/pubky-homeserver/blob/v0.15.0/pubky-sdk/bindings/js/pkg/README.md) and [`pubky.d.ts`](https://unpkg.com/@synonymdev/pubky@0.17.1/pubky.d.ts); concept: [`./concepts.md`](./concepts.md#storage-locks).** Summary:

- `SessionStorage` has `lock(path, timeoutSeconds)`, `putTextLocked` / `putBytesLocked` / `putBlobLocked` (0.17.1+) `(lock, body)`, `deleteLocked(lock)`, `refreshLock(lock, timeoutSeconds)` and `unlock(lock)`. There is no `putJsonLocked`. The file doesn't need to exist before you lock it.
- **A `StorageLock` (`path`, `token`, `timeoutSeconds`, `ifHeader()`, `free()`) is a bearer token. Never log or expose it.** The homeserver caps lock lifetime. `timeoutSeconds` is the lifetime the server granted, counted from when the call resolved, not the time remaining.
- Status codes:
  - **423** = someone else holds a lock (plain writes and deletes to the path, and a second `lock()`, are refused).
  - **412** = your lock is gone (a locked write, delete or refresh was refused).
  - **409** = `unlock()` on a lock that is already gone. On a locked write (0.17.1+), 409 instead means **the file changed after the write was prepared** (the publish conflict), not that the lock was lost: read again before retrying. A file-vs-directory path conflict is also 409.
  - **405** = the homeserver doesn't support locks. **400** = the target is a directory.
- **If `lock()` rejects without a status code** (e.g. the connection dropped), the server may still have granted the lock, and nothing can release it. The path returns 423 until the lock times out.

**Template workflow:**
1. `lock(path, 60)`.
2. **Read the file again under the lock.** The copy on screen may be stale.
3. Renew with `refreshLock(lock, 60)` and set `expiresAt = now + timeoutSeconds * 1000`.
4. Save with the lock, then release it.

- **Delete** takes its own lock if none is held and releases it in `finally`, ignoring unlock errors. On release the template ignores 409 and 412 from `unlock`, and `sdkLock.free()` always runs.
- **Locks block competing writes; they don't merge edits.** If the re-read file differs from the baseline your draft started from, keep the draft on screen and block saving as a conflict.
- Keep the SDK lock inside `storage.ts` (the template uses a `WeakMap`); the UI sees only `{id, space, expiresAt}`. A 412 during a locked operation also marks the local lock inactive.

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

<sub>Source: [`src/storage.ts` L244-257](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/storage.ts#L244-L257). Run against a local testnet: a real 423 and a real 412 map to these messages; the 405 branch was not exercised. `statusCode` reads `error.data.statusCode` and returns `undefined` for `CredentialRefreshError`, so a refresh endpoint's status is never mistaken for a storage response. Not to be confused with pubky.app's paid-content "Locks" (see [pubky.app](#pubkyapp)).</sub>

#### Uploads, downloads and the public reader

```ts
export async function uploadFileBytes(
  session: Session,
  space: StorageSpace,
  file: File,
  isCurrent: () => boolean = () => true,
  encrypt = false,
) {
  requireStorageAccess(session, space)
  checkByteLength(file.size + (encrypt ? ENCRYPTION_OVERHEAD_BYTES : 0))
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file'
  const suffix = encrypt
    ? ENCRYPTED_FILE_SUFFIX
    : filename.endsWith(ENCRYPTED_FILE_SUFFIX)
      ? '.raw'
      : ''
  const name = `${crypto.randomUUID()}-${filename}${suffix}`
  const path = uploadedFilePath(space, name)
  requireCurrent(isCurrent)
  if (encrypt) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    try {
      checkByteLength(bytes.byteLength + ENCRYPTION_OVERHEAD_BYTES)
      const encrypted = await encryptUpload(session, path, bytes, isCurrent)
      requireCurrent(isCurrent)
      await session.storage.putBytes(path, encrypted)
    } finally {
      bytes.fill(0)
    }
  } else {
    // The SDK accepts the native File without materializing another JS byte copy.
    await session.storage.putBlob(path, file)
  }
  requireCurrent(isCurrent)
  return name
}
```

<sub>Source: [`src/storage-tools-data.ts` L73-107](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/storage-tools-data.ts#L73-L107). Run against a local testnet: a plain upload and an encrypted upload, both read back. `checkByteLength` enforces a 5 MiB limit (`MAX_FILE_BYTES`) that **includes the encryption envelope**. The UUID prefix keeps earlier uploads addressable. Uploads go under `${APP_PATHS[space]}attachments/`, a template convention, not an SDK storage type.</sub>

- **Upload plain files with `putBlob`, not `putBytes(await file.arrayBuffer())`.** `putBlob(path: Path, body: Blob): Promise<void>` (SDK 0.17.1+) takes a `Blob` or `File`; the path must not end with `/`, and a non-`Blob` body throws `InvalidInput`.
- **Suffix rules:** encrypted uploads get `.pubkyenc`; a plaintext file whose name already ends in `.pubkyenc` gets `.raw` appended, so it is never mistaken for ciphertext.
- **Build share links with the raw z32:** `` `pubky://${session.info.publicKey.z32()}${path}` ``. The `pubky://` URI takes z32, not the `pubky`-prefixed display form ([key formats](./concepts.md#public-key-string-formats)).
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

<sub>Source: [`src/storage-download.ts` L1-12](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/storage-download.ts). Type-checked, and run with DOM stubs only. Text previews appear only for `text/*` or JSON content types, escaped with `escapeHtml` inside a `<pre>` and cut at 4000 bytes. **Fetch untrusted bytes with a size cap:** the public reader and uploaded-file reads use `storage.get()` plus `readLimitedResponse` (5 MiB cap). Only note downloads (`downloadFile` in `storage.ts`) use the uncapped `getBytes`; don't copy that for other users' content.</sub>

**Anonymous public reader** (`public-reader.html`, no sign-in) reads another user's `/pub` file safely:

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

<sub>Source: [`src/storage-tools-data.ts` L170-184](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/storage-tools-data.ts#L170-L184). Run against a local testnet. Own data vs. another user's data: [`./concepts.md`](./concepts.md#own-data-vs-another-users-data).</sub>

- **`parsePublicAddress` accepts only canonical `pubky` resources under `/pub/`.** It rejects `?`, `#`, whitespace, control characters, a trailing `/`, and empty, `.` or `..` path segments.
- `stats()` returns `undefined` when the file doesn't exist (HTTP 404 or 410).
- **Cap the response stream yourself. Don't trust `Content-Length`.**
- **Pass the original string as the `Address`.** On ≤0.17 the parsed path is already encoded, so rebuilding the address from it encodes the path twice. On 0.18.0 parsed paths are plain names ([version drift](#version-drift-check-before-copying-any-call)); re-test this on upgrade.

#### Encrypted uploads (app-side crypto)

This is **the app's own cryptography over shipped scoped-key delivery**, not encrypted storage. Read the canonical caveats first: [scoped encryption keys](./shipped-vs-planned.md#scoped-encryption-keys-shipped-key-delivery-only), [app-side ciphertext](./shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto), [`./auth.md`](./auth.md#scoped-encryption-keys), and the homeserver [scoped encryption guide](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/scoped-encryption-keys.md).

Derive a non-extractable WebCrypto key per path from the grant, and free both handles:

```ts
async function deriveUploadKey(session: Session, path: Path) {
  validateUploadPath(path)
  const grant = session.grant
  let keys: EncryptionKeys | undefined
  try {
    keys = grant?.encryptionKeys
    if (!keys?.scopes.length) {
      throw new Error(
        'No encryption keys were approved. Sign out and authorize encryption in Pubky Ring again.',
      )
    }
    return await keys.deriveCryptoKeyForPath(path)
  } finally {
    keys?.free()
    grant?.free()
  }
}
```

<sub>Source: [`src/encryption.ts` L115-131](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/encryption.ts#L115-L131). Run against a local testnet: an `e`-scoped grant derives an AES-GCM `CryptoKey`; a root session throws. `encryptionKeys` is `undefined` for bare grants, hence the guarded `keys?.free()`. **Missing or narrowed keys throw; never fall back to a plaintext upload.**</sub>

- **Template envelope v1** (a template convention, not an SDK or protocol format): 8-byte magic `PUBKYEN\x01` + a **fresh random 12-byte IV per encryption** + AES-GCM ciphertext with a 128-bit tag. `ENCRYPTION_OVERHEAD_BYTES` = 8 + 12 + 16 = 36.
- **AAD binds ciphertext to account and path:** UTF-8 JSON `['pubky-template-upload-v1', ownerZ32, path]`. Renaming or moving an encrypted file breaks decryption.
- Encryption is allowed only under `${APP_PATHS.*}attachments/` with a filename matching `/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/`. Decrypt failures return a generic message. Plaintext buffers are zeroed (`fill(0)`) after use.
- **Template limits:** public encrypted files stay downloadable by anyone as ciphertext; file names, sizes and metadata stay visible to the homeserver; no key distribution to other recipients; the dev shortcut supplies no keys.
- **Plan recovery before you ship.** Keys can't be rotated and survive grant expiry or revocation; the SDK keeps key recovery material as plaintext in IndexedDB, readable by any same-origin script; sign-out deletes that browser record, and a ciphertext download alone is not a key backup. The README says a production app needs an explicit recovery design.

**Offline recovery of a ciphertext download** (Tools page, [`src/encryption-recovery.ts` L7-35](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/encryption-recovery.ts)):
- `await pubky.browserSessionStore.restoreEncryptionKeys(recordId)` returns the saved key bundle, or nothing if the record has none. It restores no authenticated session and makes no network request during decryption. **`free()` the bundle** in `finally`.
- The user must supply the original `.pubkyenc` filename and storage space, because the AAD includes the path.

#### Custom grant proofs

Sign app data with the session's delegated client key (no network request). Contract and API: [`./auth.md`](./auth.md#custom-grant-proofs), [CUSTOM_POP.md](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/CUSTOM_POP.md).

```ts
export async function createAppProof(
  session: Session,
  message: string,
  audience: string,
  challenge: string,
): Promise<CustomPop> {
  checkMessage(message)
  const grant = session.grant
  if (!grant) throw new Error('Custom proofs require a grant session. Sign in with Pubky Ring.')
  try {
    return await grant.createCustomPop({ audience, purpose: PROOF_PURPOSE, challenge, message })
  } finally {
    grant.free()
  }
}
```

<sub>Source: [`src/proofs.ts` L27-41](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/proofs.ts#L27-L41). Run against a local testnet; the proof passed the template's `verifyAppProof`. `checkMessage` caps the message at 4 KiB; `PROOF_PURPOSE` is `'template-proof-demo'`.</sub>

**`verifyCustomGrantPop` only checks the identity chain. The verifier must enforce the app contract itself.** `verifyAppProof` ([L47-90](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/proofs.ts#L47-L90)):
1. Bound the `{grant, pop}` bundle (32 KiB), then call `verifyCustomGrantPop(credentials, { clockSkewSeconds: 30 })`.
2. Require `identity` to equal the expected user and `grantClaims.client_id` to equal `APP_CLIENT_ID`.
3. Require `data` to have exactly four keys: `audience`, `purpose`, `challenge` (all equal to expected values) and a string `message`.
4. **Enforce freshness yourself:** `iat` no older than 60 s and no more than 30 s in the future. The SDK enforces no max proof age.
5. **Reject replays yourself:** record `${identity}:${grantClaims.jti}:${nonce}` until `grantClaims.exp`. The SDK keeps no replay state.

- The template's replay map lives only while the panel is mounted. **A real service needs durable, atomic challenge and replay state.**
- Offline verification can't check current revocation, and storage capabilities don't authorize service actions. Enforce your service's own permissions.

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

<sub>Source: [`src/events.ts` L73-81](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/events.ts#L73-L81). Run against a local testnet (public, and private with `.session()`). `maxEventBytes` needs SDK 0.15+. An event larger than `maxEventBytes` makes the SDK cancel the response and the stream errors. A `/priv` stream without `.session()` gets a 401.</sub>

- **History:** `reverse().limit(12)` (`EVENT_HISTORY_LIMIT`). **You can't combine `reverse()` with `live()`.**
- **Live stream with resume:**
  1. With no cursor, subscribe to `reverse().limit(1)` (not live) to get the newest event's cursor.
  2. Subscribe with `.live()` from that cursor.
  3. On restart, resume after the last delivered cursor. Cursors are stored per space and cleared on sign-out. From 0.18.0, a persisted legacy Base32 cursor gets 400.
- **`subscribe()` can't be aborted.** `stop()` sets a flag, and the reader is cancelled once it exists. Call `reader.cancel()` in `finally` so it runs even if validation or the consumer throws. `.free()` any event that arrives after stop. (pubky.app works around this with its own fetch; see [below](#listing-event-streams-and-errors).)
- **Validate every event.** `owner.z32()` must equal the session's z32, and `resource.path` must be inside the space's prefix; otherwise throw. Free the `owner`, `resource` and event WASM handles in `finally`. Each event maps to `{type: eventType, path: resource.path, cursor, contentHash}`. **Events carry metadata, not file contents.**

#### Errors and uncertain writes

Format SDK errors by category (SDK 0.17.1+). Error names: [`./sdk-js.md`](./sdk-js.md#error-handling).

```ts
export function formatError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'CredentialRefreshError') {
      return `Session credentials could not be refreshed. ${error.message} Sign out and authorize again if access was revoked or expired.`
    }
    if (error.name === 'RequestError' && 'data' in error) {
      const data = error.data
      if (typeof data === 'object' && data !== null && 'reason' in data) {
        if (['Timeout', 'Connection', 'Body'].includes(String(data.reason))) {
          return `${error.message} The operation's result may be unknown; check the file before repeating a write.`
        }
        if (data.reason === 'Decode')
          return `${error.message} The server response could not be decoded.`
        if (data.reason === 'InvalidRequest')
          return `${error.message} Check the request parameters.`
      }
    }
    return error.message
  }
  return String(error)
}
```

<sub>Source: [`src/html.ts` L31-51](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/src/html.ts). Run with a real 404 (`data.reason: 'Http'`, `statusCode: 404`) and a synthetic `Timeout`.</sub>

- **`CredentialRefreshError`** = automatic grant refresh failed (often revoked or expired access). Don't read its HTTP status as a storage response.
- **`RequestError` with `data.reason` `Timeout`, `Connection` or `Body` = outcome unknown.** The write may have reached the homeserver.
- **The template never retries writes automatically.** Check the file before repeating an uncertain operation. pubky.app instead [retries a fixed set of statuses](#writes-compensate-then-retry-only-what-is-safe); neither retries an unknown-outcome write blindly.
- **Report a failed follow-up separately.** If a save, upload or delete succeeds but the list refresh fails, keep the success message and show the refresh error on its own; the completed operation doesn't need repeating.

#### UI lifecycle and hygiene

- **Run every action through `run(label, task)`.** It sets the busy state, uses a `Symbol` token so only the latest operation updates the UI, and shows `error.message`. Ring sign-in refreshes use `Symbol('ring-signin')` tokens, and stale flows are `cancel()`ed.
- **Handle the back/forward cache:**
  - On `pagehide` with `event.persisted`, pause the Ring waiter. On any other `pagehide`, cancel the waiter and call `flow.suspend()`.
  - Also on `pagehide`, stop event streams and release held editor locks.
  - On `pageshow` with `persisted`, resume or re-initialize.
- **Escape every interpolated HTML string with `escapeHtml` (`& < > " '`)**, including homeserver data and the authorization URL.
- **CI** ([`ci.yml`](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/.github/workflows/ci.yml), Node 22):
  - Repo root: `npm ci`, `npm run audit`, `npm run check` (prettier + eslint + actionlint).
  - Each template: `npm ci`, `npm run audit`, `npm test --if-present` and a build. The basic app is built for testnet (`VITE_PUBKY_TESTNET=true VITE_PUBKY_STORAGE_NAMESPACE=testnet`) and for mainnet (`VITE_PUBKY_TESTNET=false`).
  - Playwright browser tests on Chromium and Firefox (`npm run test:browser` from the repo root): loopback-only, controlled SDK responses, no homeserver. They complement, not replace, live testnet checks.
- **tsconfig:** `strict`, `noUnusedLocals`, `noUnusedParameters`.

## pubky.app

**Repo facts** (at `292587b74061`, default branch `dev`): package `franky` v1.14.0, built with `next build --webpack`. Dependencies: `@synonymdev/pubky` 0.17.1 (exact), `pubky-app-specs` 0.8.1, next 16.4.3, react 19.3.1, dexie 4.4.7, zustand 5.0.16, zod 4.6.7, `@tanstack/react-query` 5.105.0, `@synonymdev/locks-sdk` 0.1.0.

**Data flow** ([KB pubky.app](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/pubky-app.md); concept: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read)):
1. The frontend keeps data locally in a browser database.
2. Users publish to their homeservers through the SDK, using [pubky-app-specs](./app-specs.md).
3. Nexus follows the homeservers' event feeds, then fetches and indexes the public records.
4. The frontend refreshes its local cache from Nexus.

Local changes and indexed views don't update at the same moment. Bookmarks are public social records.

**The network defaults point at staging.** Only dev and test, which parse the config leniently, use `NETWORK_RUNTIME_DEFAULTS` ([schema L432-442](https://github.com/pubky/pubky-app/blob/292587b74061/src/libs/runtime-config/runtime-config.schema.ts#L432-L442)). Deployed containers must set every required `PUBKY_RUNTIME_*` value.
- Nexus: `https://nexus.staging.pubky.app`.
- Homeserver: `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy`, at the explicit URL `https://homeserver.staging.pubky.app`, because that pubkey has no resolvable HTTPS endpoint (pubky-homeserver#410).
- Homegate: `https://homegate.staging.pubky.app`.
- HTTP relay: `https://httprelay.staging.pubky.app/inbox`.
- PKARR relays: `https://pkarr.pubky.app`, `https://pkarr.pubky.org`.
- `testnet: false`, `deployEnv: 'staging'`.

### Auth: grant-only now, but don't copy the key custody

- **pubky.app uses grant auth only** ([ADR-0024](https://github.com/pubky/pubky-app/blob/292587b74061/docs/adr/0024-grant-authentication.md)). The ADR's status line still says "Proposed for merge in PR #2614", but `src` has no cookie-auth calls left.
  - It uses `startGrantAuthFlow` with `saveDelegated()` falling back to `saveLocal()`, plus `resumeDelegatedGrantAuthFlow` / `resumeGrantAuthFlow`, `signer.signin(getAuthClientId())` and `browserSessionStore`.
  - It restores legacy cookie sessions only to revoke them.
  - **It requests bare grants:** `startGrantAuthFlow` gets `{ clientId, relay, xCallback }` with no `approvalFormat`, and `src` uses neither `encryptionKeys` nor `createCustomPop` ([`grant-flow.ts` L279-291](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/services/homeserver/grant-flow.ts#L279-L291)). For those features, copy the template.
  - Its delegated-to-local fallback is a bare `try/catch`. **Prefer the template's version**, which falls back only on `ClientStateError` "not delegated" and re-throws everything else.
- **`clientId`:** `config.authClientId ?? (deployEnv === 'production' ? 'pubky.app' : 'staging.pubky.app')`.
- **Capabilities** (every `/priv` path is [alpha](./shipped-vs-planned.md#priv-private-storage-alpha)):
  - Core: `/pub/pubky.app/:rw`.
  - Locks adds `/priv/social/:rw` and the guarded content path with `:r`.
  - Shop adds `/pub/paykit/:rw`, `/priv/pubky.app/:rw`, `/pub/chat/v0/:rw` and `/priv/chat/v0/:rw`.
- **Pending flows:**
  - A tab record lives in `sessionStorage` under `pubky-app-pending-grant-v1`, validated with zod: `{id, context, createdAt, mode, saved}`.
  - For ordinary Ring/Bitkit sign-in, the app also keeps the delegated state in its own IndexedDB store (`pubky-app-pending-grants-v1`), with a Web Lock per attempt, for a three-minute recovery window, because Safari loses `sessionStorage` when it kills the process (#2840).
  - **Resume is refused unless the whole request context matches:** purpose, capabilities, clientId, homeserver, environment, testnet, relay and invite hash.
  - On iOS WebKit, the flow is released while the page is hidden.
- **ADR-0024 security note:** the delegated serialization holds relay and HPKE secrets, and IndexedDB stores them unencrypted. **Never log it or put it in URLs or telemetry.** Late restored-session results update only the generation that still owns the session.
- **Key custody: don't copy it.** pubky.app's own onboarding and root-key path holds keys: `HomeserverService.signIn({keypair})`, `createAccount` and `signInCreatedAccount` all take a `Keypair`.
  - It force-republishes the user's homeserver record (`signer.pkdns.publishHomeserverForce`) only after its own signup, or, outside staging, when the PKARR record is **provably absent** (`getHomeserverOf` returns `null`). A failed lookup throws instead, and a failed grant exchange never republishes.
  - On staging it fails closed (`WRONG_ENVIRONMENT_HOMESERVER`) unless the record already points at the staging homeserver.
  - **Third-party apps must not hold keys or republish records.** Use the Ring grant flow, as basic-pubky-app does.
- **Signup-token check:** `GET ${homeserverUrl}/signup_tokens/${encodeURIComponent(token)}` through `pubkySdk.client.fetch` with `credentials: 'omit'` (`HEAD` returns 405 from homeserver 0.17.1).
  - A 404 means `invalid`; otherwise the JSON body is `{status: 'valid' | 'used'}`.
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

<sub>Source: [`src/core/services/homeserver/homeserver.ts` L218-228](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/services/homeserver/homeserver.ts#L218-L228). Internal app code; both branches constructed on 0.17.1 and 0.18.0.</sub>

### Writes: compensate, then retry only what is safe

Copy the code, not [`docs/local-first.md`](https://github.com/pubky/pubky-app/blob/292587b74061/docs/local-first.md), which still says writes "Sync to homeserver in background" and that rollback is optional. **The code waits for the homeserver PUT and always rolls back on failure:**
1. Upload files. If any upload fails, delete all of them.
2. Write to Dexie locally. On failure, delete the uploads.
3. **Await** the homeserver PUT. On failure, delete the local post and the uploads, then re-throw.
4. Call the optional `onPostSynced` callback right after the PUT succeeds.
5. Create tags only after the PUT succeeds.

```ts
  static async commitCreate({
    postUrl,
    compositePostId,
    post,
    fileAttachments,
    tags,
    isCurrent,
    onPostSynced,
  }: TCreatePostInput) {
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
    onPostSynced?.();

    if (tags && tags.length > 0) {
      await TagApplication.commitCreate({ tagList: tags, isCurrent });
    }
  }
```

<sub>Source: [`src/core/application/post/post.ts` L238-293](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/application/post/post.ts#L238-L293). Internal app code; type-checked against stubs only.</sub>

**Homeserver write retries** ([`docs/error-handling.md` L96-111](https://github.com/pubky/pubky-app/blob/292587b74061/docs/error-handling.md#L96-L111)). Every PUT and DELETE goes through `HomeserverService` (`request`, `putBlob`, `delete`), which wraps it in `retryHomeserverWrite`; `write-call-sites.gate.test.ts` fails on any write that bypasses it.

| Response | Action |
| :-- | :-- |
| 429, 500, 503 | Retry, up to 3 attempts, jittered exponential backoff (250 ms base, 4 s cap). A 429's `Retry-After` is honored up to 30 s. |
| 409 whose body is exactly `The file changed before the change was published; read it again and retry` | Retry. Nothing was written, so replaying is safe. This is the GCS publish conflict added in homeserver v0.16.2 ([notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.2)). |
| Any other 409 (path collision, unknown lock token), 412, 423 | A real conflict. **Never retry.** |
| Logout or session/account change (`SESSION_EXPIRED`) | Stop retrying. |

- **Never replay a body built by read-check-write.** Take a fence from `HomeserverService.createWriteFence()` and wrap the read and the write in `retryHomeserverWriteAfterReread(fence, …)`, so each retry reads again.
- **Serialize writes to the same file**, retries included, so an older retry never lands after a newer write.
- Homeserver v0.15.0+ returns 429 when its storage backend rate-limits a request.

**Cross-Application calls ([ADR-0009](https://github.com/pubky/pubky-app/blob/292587b74061/docs/adr/0009-application-cross-domain-orchestration.md)).** Only a few orchestrating Applications may call other Applications, and call chains have a depth limit. Read the ADR before adding a cross-domain call.

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

<sub>Source: [`src/hooks/usePostDetails/usePostDetails.tsx` L16-33](https://github.com/pubky/pubky-app/blob/292587b74061/src/hooks/usePostDetails/usePostDetails.tsx#L16-L33). Internal app code; type-checked against stubs only.</sub>

- **`queryFn`** runs inside Dexie's `useLiveQuery`. If it throws, the error is logged and the result counts as `null` (a cache miss).
- **`fetchFn`** runs in `useEffect`, only when `data === null`. A failed fetch is logged and isn't retried in a loop.
- **Each change to `deps` or `enabled` gets a new query identity**, so a stale hit or miss is never used.
- `isLoading = data === undefined || (enabled && data === null && (isFetching || settledQuery !== query))`.
- **Errors are not exposed.** The hook returns only `{data, isLoading}`, so treat a settled `null` as "missing". Source: [`useLocalFirstQuery.ts`](https://github.com/pubky/pubky-app/blob/292587b74061/src/hooks/useLocalFirstQuery/useLocalFirstQuery.ts#L148-L159).
- **TTL defaults:** `ttlPostMs` 300 000, `ttlUserMs` 600 000, `ttlBatchIntervalMs` 5 000, `ttlPostMaxBatchSize` 20, `ttlUserMaxBatchSize` 20, `ttlRetryDelayMs` 60 000. TTL refresh also runs for signed-out visitors.
- **Stamp `*_ttl.lastUpdatedAt` on every local write.** Otherwise a stale refresh from Nexus can overwrite a newer local write.
- **Compensate even after a 401.** A write the homeserver rejected, or one an ended session never sent, is still rolled back after 401 handling ended the session, because the undo is bound to the operation ([`docs/local-first.md`](https://github.com/pubky/pubky-app/blob/292587b74061/docs/local-first.md) L326).
- **A version mismatch deletes the local Dexie database** ([ADR-0019](https://github.com/pubky/pubky-app/blob/292587b74061/docs/adr/0019-dexie-recreate-on-version-mismatch.md)). Synced data comes back on the next sync; local-only state is lost.
- **Don't treat a *Proposed* ADR as current behavior** ([ADR index](https://github.com/pubky/pubky-app/tree/292587b74061/docs/adr)). Proposed: 0020, 0024 grant-only auth, 0025 same-origin shop session, 0029 cross-device notification `last_read` sync. Accepted: 0022 Locks creator publishing (amended 2026-10-29: optional `content_kind` in the announcement envelope), 0023 article inline media slots. There are no ADRs 0026-0028.

> **"Locks" in pubky.app is not a protocol feature.** [Pubky Locks](https://pubky.org/pubky-locks/) ([source](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/pubky-locks.md)) is an application service for paid content: a public content lock describes the access criteria, and a separate Lock Server checks the viewer before serving guarded content (via `@synonymdev/locks-sdk`; [ADR-0022](https://github.com/pubky/pubky-app/blob/292587b74061/docs/adr/0022-locks-creator-publishing.md)). Guarded bytes live under `/priv/app.locks/content/` ([alpha](./shipped-vs-planned.md#priv-private-storage-alpha) `/priv`). **Trust:** *"The Lock Server acts with authority granted by the creator and can read the content it serves."* pubky.app saves a private copy on the viewer's homeserver, and deleting the original lock doesn't remove copies already obtained. Availability depends on deployment and region. **Don't present it as shipped "guarded/encrypted data"**: that is still [planned](./shipped-vs-planned.md#still-planned). It is also unrelated to the homeserver's WebDAV [file locks](#file-locks-sdk-015).

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

<sub>Source: [`src/core/pipes/pipes.builder.ts`](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/pipes/pipes.builder.ts) (one doc comment omitted). Internal app code. Type-checked on specs 0.7.0 and 0.8.1; memoization and reset run on 0.8.1.</sub>

- **There is no `createProfile`**, even though `docs/architecture.md` calls one. In pubky-app-specs 0.8.1, use `createUser` and `createPost`. `createPost` takes an optional sixth `lock` argument.

### Listing, event streams and errors

- **`list()` picks the client by who owns the path.** Paths under the active session's own `/pub/` or `/priv/` go through `session.storage.list(dirPath, cursor ?? null, reverse, limit, false)`; everything else through `publicStorage.list(..., false)`. Both are deep (`shallow = false`). A 404 returns `[]`.
- **`listAll` must use a finite limit** (`LIST_DEFAULT_LIMIT = 500`). The source comment says `Infinity` turns into 0 at the WASM boundary and silently returns an empty page. The last URL is the cursor, and listing stops only on a short page. Source: [`homeserver.ts` L844-902](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/services/homeserver/homeserver.ts#L844-L902).
- **Live events no longer use the SDK's `subscribe()`.** `HomeserverService.subscribeUserEventStream({userZ32, cursor, paths, signal})` ([L1098-1145](https://github.com/pubky/pubky-app/blob/292587b74061/src/core/services/homeserver/homeserver.ts#L1098-L1145)) resolves the homeserver with `getHomeserverOf`, builds `https://<hsZ32>/events-stream?user=<z32>[:cursor]&live=true&path=…`, fetches it with `pubkySdk.client.fetch(url, { method: 'GET', credentials: 'omit', signal })` and decodes the SSE itself.
  - **Why:** *"SDK 0.17.1's `subscribe()` takes no `AbortSignal` and its WASM transport has no timeout: a request waiting for response headers could not be ended."*
  - **One stream per tab for all paths.** The homeserver is HTTP/1.1 and the browser's six connections per host are shared by every tab, so one `HomeserverEventStreamCoordinator` per tab owns a single connection (#3066, [ADR-0029](https://github.com/pubky/pubky-app/blob/292587b74061/docs/adr/0029-cross-device-last-read-sync.md)). It syncs the mute list and notification `last_read`, and reconnects on connect failures by design.
  - **Prefer the SDK builder** (as in the [template](#event-history-and-live-updates)) unless you must abort a request still waiting for headers. This workaround hand-builds a homeserver URL, so it bypasses SDK addressing changes; re-check it on every SDK and homeserver bump.
- **Mapping SDK errors to `AppError` by `error.name`** ([`docs/error-handling.md` L82](https://github.com/pubky/pubky-app/blob/292587b74061/docs/error-handling.md)):

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

<sub>Source: [`docs/error-handling.md` L147-161](https://github.com/pubky/pubky-app/blob/292587b74061/docs/error-handling.md#L147-L161). A doc fragment: the bare `return` needs an enclosing handler function, and upstream leaves out the imports for `PostController`, `AppError`, `requiresLogin` and `getErrorMessage`.</sub>

## Pubky Explorer: the read pattern

Explorer uses **only the unauthenticated `pubky.publicStorage`**: no signer, no session, no Nexus. Copy its read pattern for any viewer of public data, but not its cursor handling (see below).
- **Use it to tell a storage problem from an indexing problem.** Explorer shows the files actually stored, while Nexus builds indexed views. A file can exist on a homeserver before it appears in an app's indexed view ([KB Explorer](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/pubky-explorer.md)).
- Own data vs. another user's data: [`./concepts.md`](./concepts.md#own-data-vs-another-users-data).

**Running it** (main at `02bdce2ec1f4`; `@synonymdev/pubky ^0.6.0`, solid-js `^1.9.11`):
- `npm run build:pages` builds `_site` plus a testnet variant (`VITE_TESTNET=true`, `--base /testnet/`). Preview both with `npm run preview:pages`.
- **Testnet Explorer:** <https://explorer.pubky.app/testnet/>. The hosted app connects to `localhost`, so allow local-network access if asked. It needs a local PKARR relay on port `15411` ([`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet)); `TestnetBanner` probes `http://localhost:15411/`.

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

<sub>Source: [`src/state.ts` L1-2, L5-7, L404-415](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L404-L415). Run against a local testnet on SDK 0.6.0, 0.12.0, 0.15.0, 0.16.2, 0.17.1 and 0.18.0. `Address` is a template-literal type, so a plain `string` needs a cast. The testnet flag is inverted relative to the template's: Explorer is on mainnet unless `VITE_TESTNET === 'true'`.</sub>

- **The page size is `Math.ceil(window.innerHeight / 40)`.** Always pass a finite limit.
- **Don't copy Explorer's cursor handling.** Its `loadMore` (state.ts L126-127) takes the cursor from the last item of `store.list`, which `sortItems` has re-sorted (directories first, then name ascending or descending, L457-465). Use the **last URL of the raw `list()` result** as the cursor, as basic-pubky-app does.
- **Cache:** `sessionStorage` under `pkx-cache-v1`.
- **Weak key check:** `PUBKEY_RE = /^[a-z0-9]{52}$/i` ignores case and doesn't check the z-base-32 alphabet. Don't copy it as a validator.
- **Treat all homeserver content as untrusted** when you preview it.

**Errors from public reads.** Check `name` and `data.statusCode` first; fall back to message regexes only after that:

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

<sub>Source: [`src/state.ts` L497-521](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L497-L521). Run against a real SDK 404 (`RequestError`, `statusCode: 404`) on 0.6.0–0.16.2, and again on 2026-11-12. On 0.17.1+, also check `data.reason` for transport failures (see [Errors and uncertain writes](#errors-and-uncertain-writes)). Error names: [`./sdk-js.md`](./sdk-js.md#error-handling).</sub>

## workshop: the end-to-end flow

**Setup** (pinned at `b952363b519a` on the default branch `spanish`; GitHub also has `english` and `feat/render-url`): SDK pinned to exactly `0.6.0`; `engines` requires Node `>=20`. Run: `npm run workshop -- --homeserver pubky<z32> --invite INVITE-123`.

**Flow in `workshop.mjs`** ([L110-270](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L110-L270)):
1. `setLogLevel(level)`, only when `--log` is passed, and **before any Pubky object is created**.
2. `new Pubky()`.
3. Load the keypair: `Keypair.fromRecoveryFile(bytes, passphrase)` reads `./pubky.recovery`. With no file, it calls `Keypair.random()` and writes `createRecoveryFile(passphrase)`.
4. `pubky.signer(keypair)`.
5. `signer.pkdns.getHomeserver()`. If a homeserver is already published, skip signup.
6. `signer.signup(homeserver, invite || null)`, treating the result as a session and reading `.info.publicKey`. ⚠️ **Breaks on 0.10+**, where `signup` returns `void`.
7. `signer.signinBlocking()` with no `clientId`, which creates the real session. ⚠️ **Breaks on 0.10+.** Pass a `clientId`, as in the [hello world](#hello-world-on-vite-starter).
8. `session.storage.putJson('/pub/pubky-workshop/hello.json', payload)`.
9. Read it back publicly with `pubky.publicStorage.getJson`.
10. Read another user's resource with `publicStorage.getText(other)`.

```js
  await session.storage.putJson(DEFAULT_WRITE_PATH, payload);

  // PublicStorage uses addressed URIs: pubky<user>/pub/...
  const selfAddress = `${session.info.publicKey.toString()}${DEFAULT_WRITE_PATH}`;
  const roundtrip = await pubky.publicStorage.getJson(selfAddress);
```

<sub>Excerpt: [`workshop.mjs` L242-250](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L242-L250) (comment translated from Spanish). Run against a local testnet on 0.6.0, 0.12.0, 0.15.0, 0.16.2, 0.17.1 and 0.18.0. In strict TypeScript, cast `selfAddress as Address`, or the call fails with TS2345.</sub>

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

<sub>Source: [`utils.mjs` L15-26](https://github.com/pubky/workshop/blob/b952363b519a/utils.mjs#L15-L26). Outputs of both `explorerUrl` branches and `pkdnsUrl` asserted in Node.</sub>

## Upstream

- Templates: [README](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/README.md) · [basic-pubky-app README](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/basic-pubky-app/README.md) · [AGENTS.md](https://github.com/pubky/pubky-app-templates/blob/840fcf1bef47/AGENTS.md) · [live previews](https://pubky.github.io/pubky-app-templates/) · [Pubky Ring Simulator](https://simulator.pubkyring.app)
- Homeserver docs @ v0.17.1: [scoped encryption keys](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/scoped-encryption-keys.md) · [custom grant proofs](https://github.com/pubky/pubky-homeserver/blob/v0.17.1/docs/CUSTOM_POP.md) · releases [v0.17.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1), [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0)
- KB: [Developer Guide](https://pubky.org/developer-guide/) ([source](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/developer-guide.md)) · [app architectures](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/app-architectures.md) · [pubky.app](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/pubky-app.md) · [Pubky Locks](https://pubky.org/pubky-locks/) · [Explorer](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/src/content/docs/pubky-explorer.md) · [snippets](https://github.com/pubky/pubky-knowledge-base-v2/blob/827fb3ad3a2f/snippets/js/src/developer-guide.ts)
- pubky.app: [`docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/292587b74061/docs/error-handling.md) · [`docs/local-first.md`](https://github.com/pubky/pubky-app/blob/292587b74061/docs/local-first.md) · [ADRs](https://github.com/pubky/pubky-app/tree/292587b74061/docs/adr)
- Explorer: [`src/state.ts`](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts) · workshop: [README](https://github.com/pubky/workshop/blob/b952363b519a/README.md)
- SDK: [npm](https://www.npmjs.com/package/@synonymdev/pubky) · [`pubky.d.ts` @ 0.17.1](https://unpkg.com/@synonymdev/pubky@0.17.1/pubky.d.ts) · [@ 0.18.0](https://unpkg.com/@synonymdev/pubky@0.18.0/pubky.d.ts) · [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/) · [homeserver releases](https://github.com/pubky/pubky-homeserver/releases)
