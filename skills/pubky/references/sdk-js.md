# JavaScript / WASM client (`@synonymdev/pubky`)

> Starting a new app? Read [new-project.md](./new-project.md) first; this file is the detail it links to.

The official JS/WASM SDK for browsers and Node: identity, auth and `pubky://` storage. This page covers only JS-specific usage. For everything else:

- **Protocol concepts** (identity, `pubky://` addressing, PKARR, homeserver model, key string formats, own data vs public reads): [`./concepts.md`](./concepts.md)
- **Auth** (`pubkyauth` flow, capabilities, signup tokens, session persistence): [`./auth.md`](./auth.md)
- **Local testnet:** [`./testing-and-testnet.md`](./testing-and-testnet.md)
- **Data schemas:** [`./app-specs.md`](./app-specs.md)
- **Rust SDK:** [`./sdk-rust.md`](./sdk-rust.md)

**Upstream (authoritative; this page summarizes, it does not mirror):**

- **Typings:** [`pubky.d.ts` @ 0.12.0](https://unpkg.com/@synonymdev/pubky@0.12.0/pubky.d.ts), the exact surface `npm install` gives you. Full member lists for `Signer`, `Session`, `SessionStorage`, `PublicStorage` live here.
- **API docs:** [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/), rebuilt on every `v*` tag.
- **Package README:** [README @ v0.12.0](https://github.com/pubky/pubky-homeserver/blob/v0.12.0/pubky-sdk/bindings/js/pkg/README.md)
- **Runnable programs:** [`examples/javascript`](https://github.com/pubky/pubky-homeserver/tree/main/examples/javascript)
- **CI type-checked snippets:** [`pubky-knowledge-base-v2/snippets/js/src`](https://github.com/pubky/pubky-knowledge-base-v2/tree/main/snippets/js/src)

If a signature here looks stale, trust the `.d.ts` for your installed version.

> **Version:** this page targets **0.12.0** (npm dist-tag `latest`, released 2026-09-14 from `pubky-homeserver` tag `v0.12.0`). Earlier releases: 0.11.0, 0.10.0, 0.9.3. Do not install the other dist-tags (`alpha` = 0.10.0-alpha.0, `next` = stale 0.6.0-rc.7). Pubky is pre-1.0: treat all APIs as **unstable**.
>
> **Drift:** `pubky-homeserver` `main` adds a `Client` config key `maxErrorBodyBytes` that is **not in 0.12.0**; do not use it. The KB snippets are type-checked against **0.10.0** (not executed); the APIs they use (`signup` → void, `signin(clientId)`, `startGrantAuthFlow`) are unchanged in 0.12.0. Snippets marked "Verified" below were type-checked and executed against 0.12.0 on a local testnet.

## Install and runtime

```bash
npm install @synonymdev/pubky
```

- **Runtimes:** browsers and **Node 20+** (needs `undici` fetch and WebCrypto). `package.json` has no `engines` field, so npm will not enforce the Node version.
- **Modules:** ESM (`import { Pubky } from "@synonymdev/pubky"`) and CJS (`require`). TypeScript typings bundled. Only runtime dependency: `fetch-cookie`.
- **No WASM init step.** The package instantiates the WASM module before exposing any API. Do not call `init()` or await anything first; long-polling calls (`authFlow.awaitApproval()`, `tryPollOnce()`) wait for readiness themselves.
- **Create one shared `Pubky` facade** and pass it around (context/props). Do not create one per request: each facade reinitializes its transports.
- **Freeing WASM objects:** exported classes have `free()` and `[Symbol.dispose]()`. GC handles typical apps; call `free()` in long-running workers that create many short-lived instances.

## The facade

| Constructor | Use |
|---|---|
| `new Pubky()` | Mainnet, default public PKARR relays |
| `Pubky.testnet(host?)` | Local testnet. `host` defaults to `"localhost"`. Pass a **hostname or IP** (`"127.0.0.1"`, `"docker-host"`), not a URL. PKARR relay becomes `http://<host>:15411`. |
| `Pubky.withClient(client)` | Custom `Client` (relays, timeout) |

- `pubky.signer(keypair)` → `Signer`. Use it instead of `Signer.fromKeypair`.
- Getters: `pubky.client`, `pubky.publicStorage`, `pubky.browserSessionStore`. `Client.testnet(host?)` also exists.
- Testnet ports and setup: [`./testing-and-testnet.md#standalone-local-testnet`](./testing-and-testnet.md#standalone-local-testnet), [`./testing-and-testnet.md#js-against-the-local-testnet`](./testing-and-testnet.md#js-against-the-local-testnet).

## WASM needs PKARR relays

Browsers/WASM cannot reach the UDP Mainline DHT, so every PKARR resolve and publish goes through **HTTPS PKARR relays**. `new Pubky()` already uses pkarr's defaults (`https://pkarr.pubky.app`, `https://pkarr.pubky.org`); the common case needs no config. General model: [`./concepts.md#pkarr-resolution`](./concepts.md#pkarr-resolution).

Override the relays (from KB `troubleshooting.ts`; Verified):

```js
import { Client, Pubky } from "@synonymdev/pubky";

const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

Config shape (0.12.0): `{ pkarr?: { relays?: string[]; requestTimeout?: number } }`. `requestTimeout` is milliseconds, default 2000.

- **`relays` replaces the default list; it does not append.** An invalid relay URL throws `InvalidInput` at construction.
- **Use `requestTimeout` (camelCase).** The 0.12.0 JSDoc on `new Client` wrongly shows `request_timeout`. TypeScript rejects that key in an object literal; in plain JS it is silently ignored and the 2000 ms default applies. A negative `requestTimeout` throws.
- **Do not pass `relays: []`.** pkarr rejects an empty relay list on every target (not only WASM), so construction throws `InternalError`.
- **PKARR relays are not the HTTP relay.** The HTTP relay carries `pubkyauth` messages (SDK default `https://httprelay.pubky.app/inbox`). Set it via `startGrantAuthFlow(..., { clientId, relay })`, never in `pkarr.relays`. See [`./auth.md#relays`](./auth.md#relays).

## Quick start (testnet, end to end)

Creates an identity, signs up, signs in, writes and reads. Adapted from KB `getting-started.ts` (upstream logs `z32()`; human-facing output uses `toString()`, see [key formats](./concepts.md#public-key-string-formats)); Verified. Needs a running local testnet; the homeserver key is the fixed testnet homeserver.

```js
import { Keypair, Pubky, PublicKey } from "@synonymdev/pubky";

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

First smoke test: [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/6-check-testnet.mjs) runs signup, signin, write, read and signout without needing public PKDNS resolution.

## Sign up and sign in

Key `Signer` signatures (0.12.0, all async; full list in the `.d.ts`):

- `signup(homeserver: PublicKey, signupToken?: string | null): Promise<void>` creates the account and publishes PKDNS. **Returns no session.**
- `signin(clientId: string): Promise<Session>` publishes PKDNS in the background (fast path).
- `signinBlocking(clientId: string): Promise<Session>` waits for the PKDNS publish.
- `signupCookie` / `signinCookie` / `signinCookieBlocking` are **deprecated and insecure** cookie auth. Do not use them.

Gotchas:

- **Always call `signin(clientId)` after `signup()`** (breaking since 0.10). `signin()` with no argument is the removed 0.9.x form and TypeScript rejects it. Older guides (including pubky-ai-kit) show `const session = await signer.signup(...)` and `signin()`; both are wrong for 0.12.0.
- **`clientId`:** domain-like app identifier (`"myapp.example"`), non-empty, ≤ 253 bytes (UTF-8); the user sees it in their grant and session list. An invalid `clientId` throws **`AuthenticationError`**, not `InvalidInput`.
- **Existing account:** signup rejects with `RequestError`, `data.statusCode === 409`. Catch that status to make signup idempotent.
- **Signup tokens:** failures are `RequestError`, **not** `AuthenticationError` (the `.d.ts` JSDoc is wrong): `statusCode` 401 for an invalid or already-used token (tokens are single-use), 400 when the homeserver requires a token and none was sent. Pass `null` on open homeservers. See [`./auth.md#signup-tokens`](./auth.md#signup-tokens).
- **Signer sign-in is a dev shortcut.** It needs the user's **secret key** and grants **root capabilities**. For production, use Pubky Ring: `startGrantAuthFlow` with scoped capabilities. See [`./auth.md#javascript`](./auth.md#javascript).

## Session

- `session.info` → `{ publicKey, capabilities: string[] }`; capabilities are normalized (e.g. `"/pub/app/:rw"`).
- `session.storage` → `SessionStorage`. `session.grant` → grant session or undefined. `session.cookie` is deprecated.
- `session.signout()` invalidates the session server-side. Afterwards, writes and `/priv` reads fail with 401, but **`/pub` reads still succeed** (`/pub` is public). A second `signout()` is a no-op; `info` stays readable.
- `session.exportLocalSecret()` returns a **bearer-equivalent secret**. Treat it like a password.

Restoring:

- **Node / a secret store you control:** `pubky.restoreSession(exported)` accepts an `exportLocalSecret()` value (or a legacy cookie export) and mints a fresh short-lived bearer.
- **Browsers:** use `pubky.browserSessionStore.save / list / restore` (IndexedDB).
  - **Delegated browser grant sessions** (the `startGrantAuthFlow` default when the runtime supports non-extractable PoP keys) cannot export raw secrets via `exportLocalSecret()`; they **must** use `browserSessionStore`.
  - Local sessions saved to `browserSessionStore` still store bearer-equivalent secrets in IndexedDB.
- `session.export()` and `Session.restore()` are deprecated.

Lifecycle and persistence semantics: [`./auth.md#session-lifecycle`](./auth.md#session-lifecycle), [`./auth.md#persist-and-restore`](./auth.md#persist-and-restore).

## Storage operations

Two surfaces; every method is async and throws `PubkyError`. Own data vs public reads: [`./concepts.md#own-data-vs-another-users-data`](./concepts.md#own-data-vs-another-users-data).

| Surface | Access | Path type | Methods |
|---|---|---|---|
| `session.storage` | Read/write **own** data | `Path` = `` `/pub/${string}` \| `/priv/${string}` `` | reads + `putJson` / `putText` / `putBytes` (→ `void`), `delete` (file or empty directory) |
| `pubky.publicStorage` | Read-only, **anyone's** data, no auth | `Address` = `` `pubky${string}/pub/${string}` \| `pubky://${string}/pub/${string}` `` | reads only |

Reads on both: `get` (→ `Response`, streamable), `getJson`, `getText`, `getBytes`, `exists`, `stats`, `list`.

`SessionStorage` overview (from the 0.12.0 README; Verified):

```js
const s = session.storage;

// Writes
await s.putJson("/pub/example.com/data.json", { ok: true });
await s.putText("/pub/example.com/note.txt", "hello");
await s.putBytes("/pub/example.com/img.bin", new Uint8Array([1, 2, 3]));

// Reads
const response = await s.get("/pub/example.com/data.json"); // -> Response (stream it)
await s.getJson("/pub/example.com/data.json");
await s.getText("/pub/example.com/note.txt");
await s.getBytes("/pub/example.com/img.bin");

// Metadata
await s.exists("/pub/example.com/data.json");
await s.stats("/pub/example.com/data.json");

// Listing (session-scoped absolute dir)
await s.list("/pub/example.com/", null, false, 100, false);

// Delete
await s.delete("/pub/example.com/data.json");
```

Public read, adapted from [`examples/javascript/3-storage.mjs`](https://github.com/pubky/pubky-homeserver/blob/main/examples/javascript/3-storage.mjs) (`userPk` is a `PublicKey`; Verified with `Pubky.testnet()`):

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = new Pubky(); // or Pubky.testnet()
const user = userPk.z32();

const exists = await pubky.publicStorage.exists(`pubky${user}/pub/my-cool-app/hello.txt`);
const stats = await pubky.publicStorage.stats(`pubky${user}/pub/my-cool-app/hello.txt`); // ResourceStats | undefined
const text = await pubky.publicStorage.getText(`pubky${user}/pub/my-cool-app/hello.txt`);
```

- **In TypeScript, write the address template literal inline** (or annotate `const resource: Address = ...`). A plain `` const resource = `pubky${...}/pub/...` `` widens to `string` and fails with TS2345.
- Public reads need the user's PKDNS record to resolve. A brand-new testnet user may not resolve yet.

### Paths and addresses

Path rules: [`./concepts.md#path-rules`](./concepts.md#path-rules). Key formats: [`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).

- **`SessionStorage` paths are absolute.** TypeScript rejects `"data.json"` and `"/myapp/data.json"`. If a cast lets one through, writes outside `/pub/` and `/priv/` fail with 403 `RequestError`.
- **Namespace app data** under a domain-like folder (`/pub/example.com/`). The `/pub` layout is **not stabilized**. pubky.app schemas and IDs: [`./app-specs.md`](./app-specs.md).
- **Build `Address` as** `` `pubky${pk.z32()}/pub/...` `` or `` `${pk.toString()}/pub/...` `` (`toString()` already includes `pubky`).
  - **Wrong:** `` `pubky${pk.toString()}` `` (double prefix), `` `pubky://${pk.toString()}` ``, or `` `${pk.z32()}/pub/...` `` (no prefix: throws `RequestError` with no `statusCode`).
- **`Address` covers `/pub` only**; you cannot read `/priv` through `publicStorage`.
- **`/priv/` is ALPHA. Do not use it in production.** Typed in 0.12.0; a root-capability session can write, read and delete under it. Its APIs may change or disappear (v0.10.0 release notes). It is access-controlled but **not encrypted**: the homeserver operator can read and write it. See [`./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage`](./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage) and [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md).

### Metadata: `exists` and `stats`

- **`exists(path)`** sends HEAD; returns `false` on 404/410, does not throw.
- **`stats(path)`** returns `ResourceStats | undefined` — `undefined` (not `null`) when missing, does not throw.
- **`ResourceStats` keys are camelCase and all optional:** `contentLength`, `contentType`, `lastModifiedMs` (Unix epoch ms), `etag` (opaque, may be absent; compare to detect changes).
- **The README is wrong here** (snake_case keys, `| null`). Trust the `.d.ts`.

## Listing and pagination

Same signature on both surfaces:

```
list(path | address, cursor?: string | null, reverse?: boolean | null,
     limit?: number | null, shallow?: boolean | null): Promise<string[]>
```

- **Returns** full `pubky://<z32>/...` URL strings.
- **The directory must end with `/`.** Otherwise the SDK throws `RequestError` before sending, with no `data.statusCode`.
- **`cursor`** is exclusive; a suffix (`<z32>/pub/example.com/a.txt`) or a full URL gives identical results. To page forward, pass the **last URL returned**.
- **`reverse: true`** lists lexicographically last entries first; the cursor then pages backwards.
- **`shallow: true`** lists first-level entries only; directories come back with a trailing `/`.
- **Omitting `limit` does not return everything.** `pubky-homeserver` defaults to **100** and caps at **1000**; other implementations may differ. Always paginate with a cursor.

Cursor loop (Verified: 123 files collected over 3 pages, no duplicates):

```js
// Paginated listing
let cursor = null;
const allFiles = [];
let batch;
do {
  batch = await session.storage.list(dirPath, cursor, false, 50);
  allFiles.push(...batch);
  cursor = batch.length > 0 ? batch[batch.length - 1] : null;
} while (cursor && batch.length === 50);
```

`dirPath` must end with `/`, e.g. `"/pub/example.com/"`.

## Error handling

Every SDK error is a real `Error` (`instanceof Error` holds) with `name: PubkyErrorName`, `message: string`, `data?: unknown`.

**Branch on `error.name`, never on message text.** The README lists five names and omits `ClientStateError`; the `.d.ts` union has all six.

| `name` | Typical causes |
|---|---|
| `RequestError` | HTTP/server status errors (`data.statusCode`), including signup-token failures; network failures; JSON decoding; SDK-side validation (e.g. missing trailing `/` on `list`) |
| `InvalidInput` | Malformed URLs or public keys, bad JS values, invalid relay URLs, invalid grant id, capability parse errors (`data.invalidEntries: string[]`) |
| `AuthenticationError` | Auth failures, AuthToken verification, invalid `clientId` |
| `PkarrError` | DHT/relay resolution failures, including `getHomeserverOf` and sign-in, grant exchange or event streams that resolve a homeserver internally |
| `ClientStateError` | Corrupt recovery file or wrong passphrase; concurrent or post-completion auth-flow polling; `saveLocal()` / `saveDelegated()` / `exportLocalSecret()` on the wrong kind of flow or session; grant-only calls on a non-grant session. See [`./auth.md#errors`](./auth.md#errors) |
| `InternalError` | Client build errors (e.g. `relays: []`), unknown JS errors |

For server HTTP errors, `error.data` is `{ statusCode: number }`:

| Status | Meaning |
|---|---|
| 400 | Signup without a token on a homeserver that requires one |
| 401 | No valid session (e.g. write after signout), or invalid / already-used signup token |
| 403 | Path outside `/pub/` and `/priv/`, another user's data, or no covering capability |
| 404 | `getJson` / `getText` / `getBytes` on a missing or deleted path |
| 409 | Signup for an existing user |
| 429 | Rate limited |

**Detecting a 404** (adapted from the README, whose version omits the `pubky` prefix and never reaches the 404 branch; `pk` is a `PublicKey`, `publicStorage` is `pubky.publicStorage`; Verified):

```ts
try {
  await publicStorage.getJson(`pubky${pk.z32()}/pub/example.com/missing.json`);
} catch (e) {
  const error = e as PubkyError;
  if (
    error.name === "RequestError" &&
    typeof error.data === "object" &&
    error.data !== null &&
    "statusCode" in error.data &&
    typeof (error.data as { statusCode?: number }).statusCode === "number" &&
    (error.data as { statusCode?: number }).statusCode === 404
  ) {
    // handle not found
  }
}
```

**Retrying on 429** (KB `troubleshooting.ts`; Verified for the success and rethrow paths — the 429 backoff branch was type-checked only, since the testnet could not be made to rate-limit):

```ts
import type { Path, PubkyError, Session } from "@synonymdev/pubky";

function statusCodeOf(error: unknown): number | undefined {
  const data = (error as PubkyError).data;
  if (typeof data !== "object" || data === null || !("statusCode" in data)) {
    return undefined;
  }

  return (data as { statusCode?: number }).statusCode;
}

async function putWithRetry(
  session: Session,
  path: Path,
  data: string,
  retries = 3,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      return await session.storage.putText(path, data);
    } catch (error) {
      if (statusCodeOf(error) === 429) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }

  throw new Error("PUT failed after retrying rate limits");
}
```

`pubky-homeserver` sends `Retry-After` on 429 since v0.12.0, but `PubkyError.data` carries only `statusCode` (no response headers), so storage methods cannot read it. Use a fixed backoff as above.

**Troubleshooting:**

- `PkarrError: No HTTPS endpoints found`: testnet not running or not ready, or the key is not yet published/resolvable.
- 401 / 403: see the status table.

## Keys and homeserver lookup

- **`Keypair`:** `Keypair.random()`; `Keypair.fromSecret(secret)` needs a **32-byte** `Uint8Array` (throws otherwise); `keypair.secret()`, `keypair.publicKey`. Recovery files: `createRecoveryFile(passphrase)` / `Keypair.fromRecoveryFile(bytes, passphrase)`; wrong passphrase throws `ClientStateError`. See [`./concepts.md#identity-the-ed25519-keypair`](./concepts.md#identity-the-ed25519-keypair).
- **`PublicKey.from(value)`** accepts raw z32 or `pubky<z32>`; it **rejects `pubky://...`** with `InvalidInput`.
  - `toString()` → `pubky<z32>` (display).
  - `z32()` → raw z32 (hostnames, headers, query params, JSON, DB keys).
  - `toUint8Array()` → 32 raw bytes.
- **`pubky.getHomeserverOf(user): Promise<PublicKey | undefined>`** resolves `undefined` when the user has no homeserver record and **rejects with `PkarrError`** when resolution fails. On testnet, a fresh unpublished key rejects (message contains "no responses") instead of resolving `undefined`. Handle both.

Homeserver lookup cache (KB `troubleshooting.ts`; Verified). **Harden before use:** it is keyed by the exact input string, so `z32` and `pubky<z32>` forms get separate entries (key by `PublicKey.from(x).z32()`), and it never expires, so after a user migrates homeservers it keeps pointing at the old one. See the notes in [`./concepts.md#pkarr-resolution`](./concepts.md#pkarr-resolution):

```ts
import { Pubky, PublicKey } from "@synonymdev/pubky";

const homeserverCache = new Map<string, PublicKey>();

async function getCachedHomeserver(
  pubky: Pubky,
  userPublicKey: string,
): Promise<PublicKey | undefined> {
  const cached = homeserverCache.get(userPublicKey);
  if (cached) return cached;

  const user = PublicKey.from(userPublicKey);
  const homeserver = await pubky.getHomeserverOf(user);

  if (homeserver) {
    homeserverCache.set(userPublicKey, homeserver);
  }

  return homeserver;
}
```

## Logging

`setLogLevel(level)` routes Rust log output to the console. Levels: `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"`. It throws on an invalid level **and on any second call** (logger already initialized); wrap it in try/catch where hot reload may call it twice.

From KB `troubleshooting.ts`; Verified:

```js
import { setLogLevel } from "@synonymdev/pubky";

// Call once at application startup, before creating Pubky or Client instances.
setLogLevel("debug");
```

## Raw fetch: `resolvePubky`

Rarely needed; the typed storage methods cover most cases.

- **`resolvePubky(identifier)`** converts `pubky<pk>/...` or `pubky://<pk>/...` (same result) into the transport URL `https://_pubky.<pk>/storage/<pk>/<abs-path>`. The `/storage/<owner>` segment is **new in 0.12.0**; 0.10.x and 0.11.x return `https://_pubky.<pk>/<abs-path>`.
- **Only raw `pubky.client.fetch(url, init)` calls need it.** Since 0.12.0, on homeservers without path-addressed storage, `Client.fetch` falls back to the legacy path plus a `pubky-host` header.

Wire addressing: [`./concepts.md#transport-and-wire-addressing`](./concepts.md#transport-and-wire-addressing).
