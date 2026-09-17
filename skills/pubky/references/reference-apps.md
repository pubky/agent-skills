# Reference apps & starter templates

Four open-source codebases show how real Pubky code is built. **Start new apps from `basic-pubky-app`.** It is the only one on the current SDK and the only one using grant auth. Before copying a pattern from the others, check the SDK version they pin (next section).

| Codebase | What it is | Architecture | SDK pin |
| :-- | :-- | :-- | :-- |
| [pubky-app-templates](https://github.com/pubky/pubky-app-templates) · [live previews](https://pubky.github.io/pubky-app-templates/) | `basic-pubky-app` (Vite + TS: Ring sign-in, file storage, event stream) and `vite-starter` (no Pubky code) | Client ↔ homeserver, authenticated | `^0.12.0` |
| [pubky-app](https://github.com/pubky/pubky-app) (pubky.app) | Flagship social PWA (Next.js) | Custom backend (Nexus) | 0.11.0 |
| [pubky-explorer](https://github.com/pubky/pubky-explorer) · <https://explorer.pubky.app> | Read-only browser for any user's `/pub` tree (Solid.js) | Client ↔ homeserver, unauthenticated | `^0.6.0` |
| [workshop](https://github.com/pubky/workshop) | Spanish teaching CLI, "De cero a Pubky" | Client ↔ homeserver, authenticated | 0.6.0 |

Shared concepts are linked, not restated here:
- Identity, `pubky://` addressing, PKARR and the write-vs-read split: [`./concepts.md`](./concepts.md).
- The data contract: [`./app-specs.md`](./app-specs.md).
- What is released: [`./shipped-vs-planned.md`](./shipped-vs-planned.md).
- Auth: [`./auth.md`](./auth.md). JS API: [`./sdk-js.md`](./sdk-js.md). Nexus reads: [`./nexus-api.md`](./nexus-api.md).

> **Scope.** Many patterns below are **app choices, not protocol guarantees**. Examples include the Dexie cache, write compensation, the `AppError` taxonomy and the template's error heuristics. All four codebases use only public `/pub` storage. The `/pub` path layout is not stabilized, Nexus `/v0` is unstable, and pubky-app-specs is v0.x.

## Version drift: check before copying any call

As of 2026-09-17:
- npm `latest` for `@synonymdev/pubky` is **0.12.0**.
- npm `latest` for `pubky-app-specs` is **0.7.0**. The crate and GitHub release are already at 0.8.0.
- Pins: basic-pubky-app `^0.12.0` (current), pubky.app 0.11.0, Explorer 0.6.0, workshop 0.6.0.

Legacy calls the older apps still use. This is not a full list; see [`pubky.d.ts` @ 0.12.0](https://unpkg.com/@synonymdev/pubky@0.12.0/pubky.d.ts).

| Legacy (deprecated in 0.12.0) | Use instead |
| :-- | :-- |
| `startCookieAuthFlow` | `startGrantAuthFlow` |
| `signinCookie()` / `signinCookieBlocking()` | `signin(clientId)` / `signinBlocking(clientId)` |
| `signupCookie` | `signup()` (returns `void` on 0.10+), then `signin(clientId)` |
| `session.export()` | `GrantSession.exportLocalSecret()` |

- **The no-argument `signin()` / `signinBlocking()` was removed in 0.10.0, not deprecated.** The signature became `signin(clientId: string)`. In strict TypeScript, 0.6.0-style calls fail with TS2554.
- `pubky.restoreSession(exported)` accepts both grant secrets from `exportLocalSecret()` and legacy `export()` strings.
- SDK error names: [`./sdk-js.md`](./sdk-js.md#error-handling).
- **The workshop's signup and sign-in steps break on 0.10.0 and later.** Use the 0.10+ flow in [Hello world on vite-starter](#hello-world-on-vite-starter).

**Don't ship the React `PubkyProvider` from [pubky-ai-kit](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md).** It is pre-0.10 code and holds the user's keys:
- It calls `pubky.signer(keypair).signin()` with no `clientId`.
- It saves the deprecated `next.export()` to `localStorage` under `pubky_session`.
- It hardcodes `Pubky.testnet()`.
- Its `usePubkySpecs` example uses `PubkyAppPostKind.Short` without importing it.

## Architecture spectrum: which codebase to copy

Source: [KB app architectures](https://github.com/pubky/pubky-knowledge-base-v2/tree/2bcd30cc8fe5/src/content/docs/explore/pubky-apps/app-architectures).

1. **Client ↔ homeserver.** The client talks to the homeserver directly, with the lowest latency and complexity. Use it when you need no real-time interaction or data normalization, for example bookmarks, file sync or a pastebin. Copy **basic-pubky-app**, **Explorer** (public reads) or **workshop**.
2. **Custom backend.** An indexer normalizes data, and an optional aggregator filters events. Pubky Nexus is the production implementation ([`./nexus-api.md`](./nexus-api.md), `/v0` unstable). **pubky.app** uses this model.
3. **Global aggregators.** One aggregator consumes event streams from many homeservers and can filter them by policy. Clients can switch aggregators or read homeservers directly.

## pubky-app-templates

```bash
npx tiged pubky/pubky-app-templates/basic-pubky-app my-pubky-app
```

- Both templates need Node `^20.19.0 || >=22.12.0`.
- Live builds: [mainnet](https://pubky.github.io/pubky-app-templates/mainnet/basic-pubky-app/) · [testnet](https://pubky.github.io/pubky-app-templates/testnet/basic-pubky-app/).

### vite-starter

`vite-starter` is a plain Vite + TypeScript shell (`typescript ~7.0.2`, `vite ^8.2.2`) with **no Pubky code**. `src/main.ts` only sets the text of `#app` to `'Vite Starter'`. The KB getting-started tutorial clones it, runs `npm install @synonymdev/pubky`, and replaces that line with the hello-world below.

#### Hello world on vite-starter

This flow needs SDK 0.10 or later:

```ts
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
```

<sub>Source: [`snippets/js/src/getting-started.ts` L14-42](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/snippets/js/src/getting-started.ts#L14-L42). Run on 0.12.0 against a local testnet. Adapted: upstream logs `signer.publicKey.z32()`; human-facing output uses `toString()` (`pubky<z32>`), see [key formats](./concepts.md#public-key-string-formats). It type-checks on 0.10+ and fails on 0.6.0. The homeserver key is the fixed static-testnet key; for ports, see [`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet).</sub>

- **Creating an identity and signing up inside the app are dev-only shortcuts.** In production, keys and homeserver signup stay outside the app: in Pubky Ring, or in a separate onboarding flow such as pubky.app's.
- On first signup, the console can show a 404 for `http://localhost:15411/<user-public-key>`. The SDK checks for an existing PKARR record before publishing. If signup continues, ignore that 404.
- For production, replace `Pubky.testnet()` with `new Pubky()`. It resolves PKARR through relays and uses the public HTTP relay for auth.

### basic-pubky-app

This standalone app uses homeservers directly as its data layer. It has no indexer, no aggregator and no pubky.app social data. It pins `@synonymdev/pubky ^0.12.0` and `qrcode ^1.5.4`.

- **Includes:** grant-based Pubky Ring sign-in (QR code, authorization link and copy button); a dev-only "New identity" shortcut, which needs `signup_mode = "open"`; session persistence through `browserSessionStore`, plus sign-out; file storage helpers under one path; and a live event stream scoped to that path.
- **Excludes:** key and recovery-phrase management (left to Pubky Ring), homeserver admin tools, and any indexer or aggregator.

#### Config: `src/config.ts`

All app-level settings live in this file. **Change `APP_CLIENT_ID` first**, because `APP_PATH` and `APP_CAPABILITIES` derive from it. Capability syntax: [`./auth.md`](./auth.md#capabilities).

```ts
import type { Capabilities } from '@synonymdev/pubky'

export const APP_CLIENT_ID = 'template' as const
export const APP_PATH = `/pub/${APP_CLIENT_ID}/` as const
export const APP_CAPABILITIES = `${APP_PATH}:rw` as Capabilities

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

<sub>Source: [`basic-pubky-app/src/config.ts` L1-19](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/config.ts#L1-L19). Type-checked with Vite's `import.meta.env` types against 0.12.0.</sub>

#### Relay config

**Testnet is the default.** Only the exact string `VITE_PUBKY_TESTNET=false` turns it off, because the check is `!== 'false'`.

| Condition | HTTP relay passed to `startGrantAuthFlow` |
| :-- | :-- |
| `VITE_PUBKY_HTTP_RELAY` is set (non-empty after trimming) | That URL |
| otherwise, testnet | `http://${VITE_PUBKY_TESTNET_HOST ?? 'localhost'}:15412/inbox/` (the static-testnet HTTP relay) |
| otherwise, mainnet | `undefined`, so the SDK default applies: `DEFAULT_HTTP_RELAY_INBOX` = `https://httprelay.pubky.app/inbox`. The older `…/link` constant is deprecated. |

- `VITE_PUBKY_TESTNET_HOST` also feeds `Pubky.testnet(TESTNET_HOST)`, so setting a LAN or remote testnet host changes both values together.
- **The HTTP relay (auth) and the PKARR relays (identity resolution) are separate settings.** The template sets no PKARR relays, so on mainnet `new Pubky()` uses the defaults. To set them explicitly, as pubky.app does, see [`./sdk-js.md`](./sdk-js.md#wasm-needs-pkarr-relays):

```ts
  const client = new Client({
    pkarr: {
      relays: ["https://pkarr.pubky.org"],
    },
  });

  const pubky = Pubky.withClient(client);
```

<sub>Source: [`snippets/js/src/troubleshooting.ts` L108-116](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/snippets/js/src/troubleshooting.ts#L108-L116). Type-checked on 0.6.0 through 0.12.0. The same `withClient` path, pointed at a local relay, completed a signup/put/get on testnet. Browsers can't reach the UDP Mainline DHT, so they resolve through HTTPS PKARR relays.</sub>

Relay protocol: [`./auth.md`](./auth.md#relays). A custom relay is the `relay` option (`{ clientId, relay }`), as in KB [`getting-started.ts` L50-62](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/snippets/js/src/getting-started.ts#L50-L62).

#### Sign-in with Pubky Ring (grant flow)

```ts
export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()

export async function startRingAuthFlow(): Promise<RingAuthFlow> {
  const flow = await pubky.startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
    clientId: APP_CLIENT_ID,
    relay: HTTP_RELAY,
  })
  const approval = awaitRingApproval(flow)

  return {
    authorizationUrl: flow.authorizationUrl,
    awaitApproval: approval.awaitApproval,
    cancel: approval.cancel,
  }
}
```

<sub>Excerpt: [`basic-pubky-app/src/pubky.ts`](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/pubky.ts#L20-L53) (two fragments). Run on 0.12.0 against a local testnet relay; the approved grant session could write under `/pub/template/`. Show `authorizationUrl` as a QR code or link, then await approval.</sub>

**Treat grant-flow secrets as credentials.**
- A grant `authorizationUrl` carries the relay `secret` query parameter. Never log or persist it.
- To survive a page refresh, persist `flow.saveLocal()` and resume with `pubky.resumeGrantAuthFlow(saved)`. Do not resume from the URL.
- The saved state holds the relay secret **and** the PoP client private key. Store it only briefly, and delete it once the flow completes or is abandoned.
- The d.ts advice to keep `authorizationUrl` in `sessionStorage` applies to the legacy cookie flow only.
- URL format: [`./auth.md`](./auth.md#pubkyauth-deep-links).

**Wrap `awaitApproval` so that cancel and expiry become distinct errors:**

```ts
function awaitRingApproval(flow: GrantAuthFlow) {
  let canceled = false
  let freed = false

  const cancel = () => {
    canceled = true
    if (freed) return
    freed = true

    try {
      flow.free()
    } catch {
      // The WASM handle can already be consumed or freed by the time cleanup runs.
    }
  }

  const awaitApproval = (async () => {
    try {
      const session = await flow.awaitApproval()
      if (canceled) throw ringAuthCanceledError()
      return session
    } catch (error) {
      if (canceled) throw ringAuthCanceledError()
      if (isExpiredAuthError(error)) throw ringAuthExpiredError()
      throw error
    }
  })()

  return {
    awaitApproval: awaitApproval.finally(cancel),
    cancel,
  }
}
```

<sub>Source: [`pubky.ts` L90-122](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/pubky.ts#L90-L122). The approve path ran on 0.12.0; the cancel path was probed but does not work as its comment implies (see below). `isExpiredAuthError` is a heuristic that matches `expired`, `timed out` or `timeout` in the error text.</sub>

**`cancel()` marks the flow as abandoned but does not abort it** (tested on 0.12.0):
- If you call `cancel()` while `awaitApproval()` is pending, `flow.free()` throws `attempted to take ownership of Rust value while it was borrowed`. The catch swallows that error. The code comment's "already consumed or freed" is not the real cause.
- `freed` is already `true` by then, so the handle is never freed explicitly and is left to GC.
- The wrapped promise stays pending until the relay poll settles (more than 60 s was observed). Only then does it reject with the canceled error.
- **Don't rely on `cancel()` to stop polling or to reject quickly.** Discard late results with a token guard, as `app.ts` does:
  - Each sign-in refresh creates a `Symbol('ring-signin')` token. A flow that resolves after its token was replaced is ignored.
  - Signing in or out calls `flow.cancel()` on any pending Ring flow. The token guard, not `cancel()`, is what discards its late result.

**Testing on a local testnet without a phone.** Use the [Pubky Ring Simulator](https://simulator.pubkyring.app):
1. Click **Copy link** in the template.
2. Paste the link into the simulator's *Auth link* field in **Shortcut** mode. The simulator creates an identity, signs it up on the local homeserver and approves the request.
3. The template is already polling, so it signs in automatically.

To create or pick identities yourself, use **Regular** mode instead.

#### Session persistence (0.12.0)

```ts
export async function saveSession(session: Session) {
  const stored = await pubky.browserSessionStore.save(session)
  localStorage.setItem(SESSION_KEY, stored.id)
}

export async function restoreSavedSession() {
  const savedId = localStorage.getItem(SESSION_KEY)
  if (!savedId) return undefined

  try {
    return await pubky.browserSessionStore.restore(savedId)
  } catch (error) {
    if (isInvalidSavedSessionError(error)) {
      await forgetSavedSession(savedId)
      return undefined
    }

    throw error
  }
}

export async function signOut(session: Session) {
  const savedId = localStorage.getItem(SESSION_KEY)
  await session.signout()
  await forgetSavedSession(savedId)
}
```

<sub>Source: [`pubky.ts` L55-80](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/pubky.ts#L55-L80). Type-checked on 0.12.0 but not run: it needs a browser, for IndexedDB and `localStorage`.</sub>

- **Put only the opaque `stored.id` in `localStorage`.** The session itself stays in IndexedDB through `BrowserSessionStore`. API and general session rules: [`./sdk-js.md`](./sdk-js.md#session), [`./auth.md`](./auth.md#session-lifecycle).
- If a restore fails with `AuthenticationError`, `InvalidInput` or `ClientStateError`, the saved session is invalid: forget it. Re-throw any other error.
- The `localStorage` key is `${APP_CLIENT_ID}:session`. When `VITE_PUBKY_STORAGE_NAMESPACE` is set, it is prefixed with `${namespace}:`. **Set a namespace when several builds share one origin.** The GitHub Pages testnet build uses `testnet`.
- `forgetSavedSession` removes the `localStorage` key first. It then calls `browserSessionStore.remove(id)` inside a try/catch, because the IndexedDB record may already be gone.

#### Dev-only identity shortcut

`signupDevelopmentUser(homeserver)` runs `pubky.signer(Keypair.random())`, then `signer.signup(PublicKey.from(hs), null)`, then `signer.signin(APP_CLIENT_ID)`.
- It appears only under `vite dev` (`import.meta.env.DEV`) on testnet. `VITE_SHOW_DEVELOPMENT_SIGNUP=false` hides it.
- Hosted Pages builds are production builds, so they offer Ring sign-in only.
- It needs an open homeserver (`signup_mode = "open"`).
- **It holds a raw keypair in the browser. Do not ship it.**

#### File storage

```ts
const LIST_PAGE_SIZE = 50

async function listFileUrls(session: Session) {
  try {
    const urls: string[] = []
    let cursor: string | null = null

    // The last listed URL is the next cursor; session.storage.list does not return a separate cursor field.
    while (true) {
      const batch = await session.storage.list(FILES_DIR, cursor, true, LIST_PAGE_SIZE, true)
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

<sub>Source: [`basic-pubky-app/src/storage.ts` L31-56](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/storage.ts#L31-L56). Run on 0.12.0 against a local testnet: 57 files across two pages with no duplicates or gaps, and an empty directory returned `[]`. Argument order: `list(path, cursor, reverse, limit, shallow)`. Pagination in general: [`./sdk-js.md`](./sdk-js.md#listing-and-pagination).</sub>

- **Use the last URL as the next cursor.** Stop on an empty page, a short page or an unchanged cursor.
- **Always pass a finite limit.** The template passes `reverse=true` with a limit of 50.
- A 404 (`error.data.statusCode === 404`) means the directory doesn't exist yet: treat it as empty.
- Listing returns `pubky://` URLs. Convert each back to a session `Path` with `PubkyResource.parse(url).path`.
- `saveFile` writes `{id, title, body, updatedAt}` to `${APP_PATH}files/${id}.json` with `session.storage.putJson`. IDs come from `crypto.randomUUID()`, and `updatedAt` is an ISO string.
- `deleteFile` calls `session.storage.delete(path)`.
- `listFiles` keeps only `.json` URLs and reads each one with `getJson` in `Promise.all`, so it makes one request per file. It coerces the JSON to `AppFile` and sorts by `updatedAt`, newest first.
- **On 0.12.0, keep session paths such as `/pub/template/files/` as they are.** The SDK uses the new `/storage/{user}/...` transport routes itself, and falls back to legacy addressing when the homeserver doesn't advertise support. Listed `pubky://` URLs are resource URLs, not transport URLs. Details: [`./concepts.md`](./concepts.md#transport-and-wire-addressing).

#### Event stream

```ts
export async function startAppEventStream(
  session: Session,
  onEvent: (event: AppEvent) => void,
): Promise<AppEventStream> {
  const eventStream = await pubky
    .eventStreamForUser(session.info.publicKey, null)
    .path(APP_PATH)
    .live()
    .subscribe()

  const reader = eventStream.getReader()
  let stopped = false

  async function read() {
    try {
      while (!stopped) {
        const { done, value } = await reader.read()
        if (done) return

        onEvent(toAppEvent(value as PubkyEvent))
      }
    } finally {
      reader.releaseLock()
    }
  }

  return {
    done: read(),
    stop: async () => {
      if (stopped) return
      stopped = true
      await reader.cancel()
    },
  }
}
```

<sub>Source: [`basic-pubky-app/src/events.ts` L17-51](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/src/events.ts#L17-L51). Run on 0.12.0 against a local testnet: 57 PUT events arrived, writes outside `APP_PATH` were filtered out, and `stop()` settled `done`. Each event maps to `{type: eventType, path: resource.path, cursor, contentHash}`.</sub>

- **Don't combine `live()` with `reverse()`.** `subscribe()` rejects with a `RequestError` whose message is `…Cannot use live mode with reverse ordering`. The `ValidationError` named in a d.ts comment is not a real error name.
- The UI ignores callbacks from a stream that has been replaced (`state.stopEventStream !== eventStream.stop`).

#### Error handling and hygiene

- **Run every action through a `run(label, task)` wrapper.** It sets the busy state, catches errors and shows `error.message`.
- **`isClosedSignupError` is a heuristic.** It matches any of these:
  - any HTTP 400;
  - a 401 or 403 whose text mentions signup, token or invite;
  - any `AuthenticationError`;
  - text containing `signup token required`, `signup_mode` or `token required`.

  On a match it re-throws a friendly `Error` with `cause` set. The status comes from `error.data.statusCode`.
- **Escape before writing to `innerHTML`.** Every interpolated string, including homeserver data and the authorization URL, goes through `escapeHtml` (`& < > " '`).
- **Tooling:**
  - Dependabot updates npm weekly and groups `@synonymdev/pubky*` as `pubky-stack`.
  - CI runs on Node 22. At the repo root it runs `npm audit` (moderate level), prettier, eslint and actionlint. For each template it runs `npm ci && npm run audit && npm run build` (`tsc && vite build`).
  - tsconfig uses `strict`, `noUnusedLocals` and `noUnusedParameters`.

## pubky.app

**Repo facts** (at `8de93300ae3c`):
- Default branch `dev`. Package `franky` v1.9.0, Node 24, built with `next build --webpack`.
- Dependencies: `@synonymdev/pubky` 0.11.0, `pubky-app-specs` 0.7.0, next 16, react 19, dexie 4, zustand 5, zod 4, TanStack Query 5.

**Data flow** (per the [KB overview](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/src/content/docs/explore/pubky-apps/reference-app/pubky-app.md); concept: [`./concepts.md`](./concepts.md#homeserver-write-vs-nexus-read)):
1. Writes go to the homeserver through the SDK.
2. Nexus polls homeservers through `/events/`, then indexes and aggregates the data.
3. Reads come from Nexus, with a local Dexie cache for offline use.

All app data lives under `/pub/pubky.app/`; field rules are in [`./app-specs.md`](./app-specs.md). The KB lists these layers: Controllers, Coordinators, Application, Services, Models (Dexie) and Stores (Zustand).

**The network defaults point at staging** (`runtime-config.schema.ts`):
- HTTP relay: `https://httprelay.staging.pubky.app/inbox`.
- PKARR relays: `https://pkarr.pubky.app` and `https://pkarr.pubky.org`.
- Nexus: `https://nexus.staging.pubky.app`. Homeserver: `https://homeserver.staging.pubky.app`. Testnet: `false`.

### Auth: do not copy

- **pubky.app deliberately stays on legacy cookie auth.** Its calls to `signupCookie`, `signinCookie` and `startCookieAuthFlow(capabilities, AuthFlowKind.signin(), relay)` each carry the comment "the grant-auth migration is tracked separately".
- **It holds the user's keys (key-custodial) and rewrites their homeserver record.**
  - On every deploy, any `signinCookie` failure force-republishes the user's homeserver record to the configured homeserver (`signer.pkdns.publishHomeserverForce`).
  - Off staging, a provably absent record also triggers the republish.
  - Staging adds a fail-closed pre-check that the existing record already points at the staging homeserver.
- **New third-party apps must copy neither behavior.** Use `startGrantAuthFlow` with `browserSessionStore`, as basic-pubky-app does.

**Signup-token check.** pubky.app calls `GET ${homeserverUrl}/signup_tokens/${encodeURIComponent(token)}` through `pubkySdk.client.fetch`, using the explicit HTTPS homeserver URL. Token model: [`./auth.md`](./auth.md#signup-tokens).

### SDK facade

Build the facade once, as a singleton, and set PKARR relays explicitly when not on testnet:

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

<sub>Source: [`src/core/services/homeserver/homeserver.ts` L84-94](https://github.com/pubky/pubky-app/blob/8de93300ae3c/src/core/services/homeserver/homeserver.ts#L84-L94). Internal app code. Both branches ran a signup/put/get on 0.12.0 against a local testnet.</sub>

### Local-first writes: copy the code, not `docs/local-first.md`

The doc and the KB say writes sync "in the background" and that rollback is optional. **The code does something else:**
1. It uploads files.
2. It writes locally.
3. It **awaits** the homeserver PUT.
4. If the PUT fails, it rolls back the local post, deletes the uploaded files and re-throws.
5. It creates tags only after the PUT succeeds.

```ts
  static async commitCreate({ postUrl, compositePostId, post, fileAttachments, tags, isCurrent }: TCreatePostInput) {
    const hasFiles = fileAttachments != null && fileAttachments.length > 0;

    if (hasFiles) {
      await FileApplication.commitCreate({ fileAttachments });
    }
    await LocalPostService.create({ compositePostId, post });

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

      if (hasFiles) {
        try {
          // Known record + blob URLs: also cleans up partial uploads (blob PUT
          // ok, record PUT failed) that a record-based delete cannot reach
          await FileApplication.commitDeleteUploaded(fileAttachments);
        } catch (fileRollbackError) {
          Logger.error('[PostApplication.commitCreate] Failed to rollback file attachments', {
            compositePostId,
            fileRollbackError,
          });
        }
      }

      throw error;
    }

    if (tags && tags.length > 0) {
      await TagApplication.commitCreate({ tagList: tags, isCurrent });
    }
  }
```

<sub>Source: [`src/core/application/post/post.ts` L200-239](https://github.com/pubky/pubky-app/blob/8de93300ae3c/src/core/application/post/post.ts#L200-L239). Internal app code, type-checked in the full project.</sub>

**Cross-Application calls ([ADR-0009](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/adr/0009-application-cross-domain-orchestration.md)):**
- Only these Applications may call other Applications: `PostApplication`, `NotificationApplication`, `BootstrapApplication`, `MigrationApplication`, `HotApplication`, `PostStreamApplication` and `TtlApplication`.
- Bootstrap and Migration are root nodes: no Application may call them.
- Call chains stop at depth 1. The one allowed depth-2 chain is `Post | Notification | Ttl → PostStreamApplication → FileApplication`, used to save attachments.

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

<sub>Source: [`src/hooks/usePostDetails/usePostDetails.tsx` L16-33](https://github.com/pubky/pubky-app/blob/8de93300ae3c/src/hooks/usePostDetails/usePostDetails.tsx#L16-L33). Internal app code, type-checked in the full project.</sub>

- **`queryFn`** runs inside `useLiveQuery` and returns `null` when the query is disabled. If it throws, the error is logged and the result counts as `null`, a cache miss.
- **`fetchFn`** runs in `useEffect`, and only when the data is `null`. It never runs on `undefined` or on a cache hit. The hook itself never refreshes cached data; the TTL coordinator (ADR-0012) handles freshness.
- **Errors are not exposed.** A failed fetch is logged and not retried in a loop. The hook returns only `{data, isLoading}`, so treat a settled `null` as "missing".
- `isLoading = data === undefined || (data === null && isFetching)`.
- **TTL defaults:** `ttlPostMs` 300 000, `ttlUserMs` 600 000, `ttlBatchIntervalMs` 5 000. Override them with `PUBKY_RUNTIME_TTL_*` variables.
- **A version mismatch deletes the local database ([ADR-0019](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/adr/0019-dexie-recreate-on-version-mismatch.md)).**
  - When the stored version differs from `NEXT_PUBLIC_DB_VERSION`, `franky.ts` deletes the IndexedDB database. In browsers it uses native `indexedDB.deleteDatabase`, with `Dexie.delete` only as a fallback.
  - Synced data comes back on the next sync. Local-only state is lost for good; for example, the user's unblur choice (`moderation.is_blurred=false`) is never written to the homeserver.
- **ADR-0020 (local-first tag cache and viewport lifetimes) is only *Proposed* (2026-09-07). Do not treat it as current behavior.**

### Specs builder and key helpers

Cache one `PubkySpecsBuilder` per user and reset it on sign-out. Pass the **raw z32** key ([`./concepts.md`](./concepts.md#public-key-string-formats)). The `pubky`-prefixed form throws `Validation Error: the string is not 52 utf chars`.

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

<sub>Source: [`src/core/pipes/pipes.builder.ts`](https://github.com/pubky/pubky-app/blob/8de93300ae3c/src/core/pipes/pipes.builder.ts) (one doc comment omitted). Run with pubky-app-specs 0.7.0 on a local testnet: `createPost` output was written with `putJson(meta.path)` and read back.</sub>

- **There is no `createProfile`**, even though `docs/architecture.md` L232 mentions one. Use `createUser` and `createPost`; for their parameters, see [`./app-specs.md`](./app-specs.md#js-pubkyspecsbuilder).
- `isPubkyIdentifier` is `/^[a-z0-9]{52}$/`.
- `parseCompositeId` throws `Invalid composite id: ${id}`.
- `buildCompositeIdFromPubkyUri({uri, domain})` returns `string | null`.

### Homeserver listing and event streams

- **`listAll` must use a finite limit** (`LIST_DEFAULT_LIMIT = 500`). According to the source comment, `Infinity` becomes 0 at the WASM boundary and silently returns an empty page. The pattern is similar to the [template's file listing](#file-storage): the last URL is the cursor. Unlike the template, it stops only on a short page. Source: [`homeserver.ts` L540-566](https://github.com/pubky/pubky-app/blob/8de93300ae3c/src/core/services/homeserver/homeserver.ts#L540-L566).
- **`subscribeUserEventStreamForPath`** calls `eventStreamForUser(PublicKey.from(userZ32), cursor).path(prefix).live().subscribe()`.
  - It normalizes events to `{cursor, eventType}`.
  - It calls `value.free()` on each WASM event in a `finally` block and ignores dispose errors.
  - `cancel` forwards to `reader.cancel`; callers own the reader lifecycle.

### Error handling (ADR-0015)

Catch `AppError` in the UI and decide what to do there:

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

<sub>Source: [`docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/error-handling.md#L120-L152). Internal app code, type-checked against the real modules. The excerpt omits imports for `PostController`, `AppError`, `requiresLogin` and `getErrorMessage`.</sub>

| Helper | True for |
| :-- | :-- |
| `isRetryable` | Network, Timeout, Server, RateLimit |
| `requiresLogin` | Auth + `UNAUTHORIZED` or `SESSION_EXPIRED` |
| `isNotFound` | `NOT_FOUND` or `RECORD_NOT_FOUND` |
| `hasHttpStatus` | Remote HTTP errors only |

`getRetryAfter` returns the retry delay.

## Pubky Explorer: the read pattern

Explorer uses **only the unauthenticated `pubky.publicStorage`**: no signer, no session and no Nexus. Copy it for any viewer of public data. How to address your own data versus another user's: [`./concepts.md`](./concepts.md#own-data-vs-another-users-data).

**Running it** (`@synonymdev/pubky ^0.6.0`, solid-js):
- `npm run dev` serves on `:5173`.
- `npm run build:pages` builds `_site` plus a testnet variant (`VITE_TESTNET=true`, `--base /testnet/`). `npm run preview:pages` serves both on `:4173`.
- The testnet build at <https://explorer.pubky.app/testnet/> needs a local PKARR relay on port `15411` and at least one homeserver ([`./testing-and-testnet.md`](./testing-and-testnet.md#standalone-local-testnet)). A banner probes `http://localhost:15411/` every 15 s with a 4 s timeout, and skips probes while the tab is hidden.

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

<sub>Source: [`src/state.ts` L1-7, L404-415](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L404-L415). Run on 0.12.0 against a local testnet in shallow and deep modes, with last-URL cursor paging; type-checks on 0.6.0 through 0.12.0. `Address` is a template-literal type, so a plain `string` needs a cast.</sub>

**Pagination (`loadMore`, L124-168):**
- An `isFetching` flag blocks duplicate requests.
- The page size is `limit = Math.ceil(window.innerHeight / 40)`.
- Each request gets an increasing ID, so stale responses are discarded.
- Pages are merged into a `Map` keyed by `name`.
- **Bug, don't copy:** the cursor is `.link` taken from the **sorted UI list** (directories first, ascending or descending), not from the raw `list()` result. The cursor can go backwards or get stuck. **Use the last URL of the raw `list()` result instead.**

**Cache.** Explorer caches listings in `sessionStorage` under `pkx-cache-v1`, as an LRU capped at 40 entries. Its `PUBKEY_RE = /^[a-z0-9]{52}$/i` is case-insensitive and doesn't check the z-base-32 alphabet.

**Previewing files (L284-350):**
- `publicStorage.get(address)` returns a fetch `Response`. The renderer is chosen by `content-type`:
  - `image/*`: shown through an object URL.
  - text, JSON or XML: shown as text.
  - `application/octet-stream`, `binary/octet-stream` or no type: read as text, strip the BOM, then try `JSON.parse`.
- A second `get` call at L223 handles downloads.
- Treat all homeserver content as untrusted.

**Errors from public reads:**

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

<sub>Source: [`src/state.ts` L497-521](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts#L497-L521). Tested on 0.12.0 against a local testnet: a real 404 gave `RequestError` with `{statusCode: 404}`. A malformed address gave `RequestError` with no `statusCode`, which falls through to the message checks. Check `name` and `data.statusCode` first, and use message regexes only as a fallback.</sub>

## workshop: the end-to-end flow

**Setup** (branch `spanish`, pinned at `b952363b519a`; branches `english` and `feat/render-url` also exist):

```bash
npm run workshop -- --homeserver pubky<z32> --invite INVITE-123
```

- Optional flags: `--recovery`, `--passphrase` (or `PUBKY_PASSPHRASE`), `--other pubky<z32>/pub/app/file.txt`, `--log debug`.
- The README asks for Node 22+, but `engines` says `>=20`.
- The SDK is pinned to exactly `0.6.0`.

**Flow in `workshop.mjs`** ([L110-270](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L110-L270)):
1. `setLogLevel(level)`, called **before any Pubky object is created**.
2. `new Pubky()` creates the facade.
3. The keypair comes from `Keypair.fromRecoveryFile(bytes, passphrase)`, reading `./pubky.recovery`. With no file, it uses `Keypair.random()` and writes `createRecoveryFile(passphrase)`.
4. `pubky.signer(keypair)`.
5. `signer.pkdns.getHomeserver()`. **If a homeserver is already published, signup is skipped.**
6. `signer.signup(homeserver, invite || null)`, whose result is used as the Session. ⚠️ **Breaks on 0.10+**, where `signup` returns `void`.
7. `signer.signinBlocking()` with no `clientId`. ⚠️ **Breaks on 0.10+**, where the no-argument form was removed. Pass a `clientId` ([hello world](#hello-world-on-vite-starter)).
8. `session.storage.putJson('/pub/pubky-workshop/hello.json', payload)`.
9. A public read-back: ``pubky.publicStorage.getJson(`${publicKey.toString()}${path}`)``.
10. `publicStorage.getText(other)` reads another user's resource.

**Round trip** (these storage calls still work on 0.12.0):

```js
  await session.storage.putJson(DEFAULT_WRITE_PATH, payload);

  // PublicStorage uses addressed URIs: pubky<user>/pub/...
  const selfAddress = `${session.info.publicKey.toString()}${DEFAULT_WRITE_PATH}`;
  const roundtrip = await pubky.publicStorage.getJson(selfAddress);
```

<sub>Excerpt: [`workshop.mjs` L242-250](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs#L242-L250) (comment translated from Spanish). Run on 0.12.0 against a local testnet. In strict TypeScript, cast with `selfAddress as Address`; without the cast you get TS2345.</sub>

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

<sub>Source: [`utils.mjs` L15-26](https://github.com/pubky/workshop/blob/b952363b519a/utils.mjs#L15-L26). Run with assertions.</sub>

## Upstream

- Templates: [README](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/README.md) · [basic-pubky-app README](https://github.com/pubky/pubky-app-templates/blob/5c8f27d65922/basic-pubky-app/README.md) · [live previews](https://pubky.github.io/pubky-app-templates/) · [Pubky Ring Simulator](https://simulator.pubkyring.app)
- KB: [getting-started](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/src/content/docs/explore/pubky-protocol/getting-started.md) · [app architectures](https://github.com/pubky/pubky-knowledge-base-v2/tree/2bcd30cc8fe5/src/content/docs/explore/pubky-apps/app-architectures) · [pubky.app overview](https://github.com/pubky/pubky-knowledge-base-v2/blob/2bcd30cc8fe5/src/content/docs/explore/pubky-apps/reference-app/pubky-app.md)
- pubky.app: [`docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/error-handling.md) · [ADR-0009](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/adr/0009-application-cross-domain-orchestration.md) · [ADR-0019](https://github.com/pubky/pubky-app/blob/8de93300ae3c/docs/adr/0019-dexie-recreate-on-version-mismatch.md)
- Explorer: [README](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/README.md) · [`src/state.ts`](https://github.com/pubky/pubky-explorer/blob/02bdce2ec1f4/src/state.ts)
- workshop: [README](https://github.com/pubky/workshop/blob/b952363b519a/README.md)
- SDK: [`@synonymdev/pubky@0.12.0/pubky.d.ts`](https://unpkg.com/@synonymdev/pubky@0.12.0/pubky.d.ts) · [npm](https://www.npmjs.com/package/@synonymdev/pubky)
