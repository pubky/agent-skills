# JavaScript / WASM client (`@synonymdev/pubky`)

> Starting a new app? Follow [new-project.md](./new-project.md) first (intake, network choice, version check). This file is the SDK detail it links to.

This page covers the JS-specific parts of the browser/Node SDK only. For everything else:

- **Protocol concepts** (identity, `pubky://` addressing, PKARR, homeserver model, key string formats, own data vs public reads): [`./concepts.md`](./concepts.md)
- **Auth** (`pubkyauth` flows, capabilities, signup tokens, HTTP relay, session persistence): [`./auth.md`](./auth.md)
- **Local testnet:** [`./testing-and-testnet.md`](./testing-and-testnet.md)
- **Data schemas:** [`./app-specs.md`](./app-specs.md) · **Guardrail:** [`./shipped-vs-planned.md`](./shipped-vs-planned.md) · **Rust SDK:** [`./sdk-rust.md`](./sdk-rust.md)

**Upstream sources. They are authoritative; this page summarizes them and does not copy them:**

- **Typings:** [`pubky.d.ts` @ 0.16.2](https://unpkg.com/@synonymdev/pubky@0.16.2/pubky.d.ts). This is the exact surface `npm install` gives you, including the full member lists for `Signer`, `Session`, `SessionStorage` and `PublicStorage`.
- **API docs:** [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/). It is unversioned and may come to track `main`.
- **Package README:** [README @ v0.16.2](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/bindings/js/pkg/README.md)
- **Runnable programs:** [`examples/javascript` @ v0.16.2](https://github.com/pubky/pubky-homeserver/tree/v0.16.2/examples/javascript). They need Node 20+ and depend on the local SDK build, not on npm.
- **Type-checked snippets:** [`pubky-knowledge-base-v2/snippets/js/src`](https://github.com/pubky/pubky-knowledge-base-v2/tree/main/snippets/js/src). Only `developer-guide.ts` remains.

If a signature here disagrees with your installed `.d.ts`, trust the `.d.ts`.

> **Version note:** this page targets **0.16.2**. That is npm dist-tag `latest`, published 2026-10-15 from `pubky-homeserver` tag `v0.16.2`. Releases after 0.12.0 were 0.13.0, 0.14.0, 0.15.0, 0.16.0, 0.16.1 and 0.16.2. Never install the other dist-tags: `alpha` is 0.10.0-alpha.0 and `next` is a stale 0.6.0-rc.7. Pubky is pre-1.0, so treat every API as **unstable**.
>
> **Not in 0.16.2 (unreleased, on `main` only):** `SessionStorage.putBlob` / `putBlobLocked` and the error name `CredentialRefreshError`. Do not use them until a release ships them. 0.16.2 has six error names.
>
> **Snippet provenance:** KB snippets are type-checked against **0.14.0** with `tsc --noEmit` and lint, but never executed. Snippets marked **Verified** below were run with **SDK 0.16.2 against a local testnet built from pubky-homeserver `main` (fd24bf0)**. That build is 24 commits past v0.16.2 and includes a breaking change (#738). Results on a released v0.16.2 homeserver may differ.

## Install and runtime

```bash
npm install @synonymdev/pubky@0.16.2
```

- **Pin the version** so the code matches this page. An unpinned install gets npm `latest`. If that is newer than 0.16.2, check its `.d.ts` against this page (see [new-project.md](./new-project.md#3-check-the-sdk-version-first)). Verified: the unpinned install resolved to 0.16.2 on 2026-10-26.
- **Runtimes:** browsers and **Node 20+**, which provides `undici` fetch and WebCrypto. `package.json` has no `engines` field, so npm does not enforce the Node version.
- **Modules:** ESM (`import { Pubky } from "@synonymdev/pubky"`) and CJS (`require`). TypeScript typings are bundled. The only runtime dependency is `fetch-cookie`.
- **TypeScript `lib`:** the `.d.ts` declares `[Symbol.dispose]()` on every class. With a `lib` that lacks `esnext.disposable` (for example, target es2022 without `esnext`), compilation fails with TS2339/TS1165. Add `esnext.disposable` or set `skipLibCheck`.
- **No WASM init step.** The package instantiates the WASM module before it exposes any API. Do not call or await an `init()`. Long-polling calls (`authFlow.awaitApproval()`, `tryPollOnce()`) wait for readiness on their own.
- **Create one shared `Pubky` facade** and pass it around (context or props). Do not construct one per request, because each construction reinitializes the transports.
- **Freeing WASM objects:** exported classes have `free()` and `[Symbol.dispose]()`. The garbage collector is enough for typical apps. Call `free()` only in long-running workers that create many short-lived instances.

## The facade

| Constructor | Use |
|---|---|
| `new Pubky()` | Mainnet, with the default HTTPS PKARR relays |
| `Pubky.testnet(host?)` | Local testnet. `host` defaults to `"localhost"`. Pass a **hostname or IP** (`"127.0.0.1"`, `"docker-host"`), not a URL. Endpoints become `http://<host>:<port>`, with the PKARR relay on 15411. |
| `Pubky.withClient(client)` | A custom `Client` (relays, timeouts) |

- `pubky.signer(keypair)` returns a `Signer`. Use it instead of `Signer.fromKeypair`.
- Getters: `pubky.client`, `pubky.publicStorage`, `pubky.browserSessionStore`. `Client.testnet(host?)` also exists.
- Testnet setup and ports: [`./testing-and-testnet.md#standalone-local-testnet`](./testing-and-testnet.md#standalone-local-testnet), [`./testing-and-testnet.md#js-against-the-local-testnet`](./testing-and-testnet.md#js-against-the-local-testnet).

## WASM needs PKARR relays

Browsers and WASM cannot reach the UDP Mainline DHT, so every PKARR resolve and publish goes through **HTTPS PKARR relays**. `new Pubky()` already uses pkarr's default relays (`https://pkarr.pubky.app`, `https://pkarr.pubky.org`; see the [authoritative list](https://github.com/pubky/pkarr/blob/main/pkarr/src/lib.rs)), so the common case needs no configuration. For the general model, see [`./concepts.md#pkarr-resolution`](./concepts.md#pkarr-resolution).

To override the relays, use this snippet from KB `developer-guide.ts`, region `js_pkarr_relay_config`; only the import line was added. Verified: client construction and the facade getters.

```js
import { Client, Pubky } from "@synonymdev/pubky";

const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

Config shape in 0.16.2: `{ pkarr?: { relays?: string[]; requestTimeout?: number }; maxErrorBodyBytes?: number }`.

- **`requestTimeout`** is the relay HTTP request timeout in **milliseconds; the default is 5000**. Before 0.15.0 the default was 2000, so older guides that set `2000` (such as pubky-ai-kit) now shorten the timeout.
- **`maxErrorBodyBytes`** (since 0.13.0) caps how much of an HTTP error body is captured. The default is 4096; `0` skips the body.
- **`relays` replaces the default list. It does not append to it.**
- **Do not pass `relays: []`.** Construction throws `InternalError`.
- An invalid relay URL, a negative or `NaN` `requestTimeout`, or a negative `maxErrorBodyBytes` throws `InvalidInput` at construction.
- **Use camelCase.** In plain JS, `request_timeout` is silently ignored and the default applies.
- **PKARR relays are not the HTTP relay.** The HTTP relay carries `pubkyauth` messages; the SDK default is `https://httprelay.pubky.app/inbox`. Set it per flow with `startGrantAuthFlow(caps, kind, { clientId, relay })`, never in `pkarr.relays`. If the Synonym-hosted default is down, logins cannot complete, so run your own relay in production. See [`./auth.md#relays`](./auth.md#relays).

## Quick start (testnet, end to end)

This program sets the log level, creates an identity, signs up, signs in, writes and reads. It comes from KB `developer-guide.ts` (regions `js_developer_guide_imports` through `read`), with two changes: upstream logs `z32()`, which is changed here to `toString()` for display ([key formats](./concepts.md#public-key-string-formats)), and upstream's browser `#app` rendering is left out. **Verified** (see provenance above). It needs a running local testnet; the hard-coded key is the fixed testnet homeserver.

```js
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
```

For a first smoke test, run [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/examples/javascript/6-check-testnet.mjs). It runs signup, signin, `putText`, `getText` and `signout`.

## Sign up and sign in

`Signer` methods in 0.16.2. All are async; parameter names are as the `.d.ts` declares them, and the full list is in the `.d.ts`.

- `signup(homeserver: PublicKey, signup_token?: string | null): Promise<void>` creates the account and publishes PKDNS. **It returns no session.**
- `signin(client_id: string): Promise<Session>` publishes PKDNS in the background (fast path).
- `signinBlocking(client_id: string): Promise<Session>` waits for the PKDNS publish to finish.
- Both sign-in variants return a grant-backed session with **root** capabilities (`session.info.capabilities` = `["/:rw"]`).
- `signupCookie` / `signinCookie` / `signinCookieBlocking` are **deprecated** cookie auth. Do not use them.
- Authenticator-side methods (`approveAuthRequest`, `approveAuthWithCapabilities`, `handleDeepLink`, `pkdns`) are covered in [`./auth.md#authenticator-side-approving-requests`](./auth.md#authenticator-side-approving-requests).

Gotchas:

- **Always call `signin(clientId)` after `signup()`.** `const session = await signer.signup(...)` and a no-argument `signin()` are pre-0.10 forms (pubky-ai-kit still shows them). TypeScript rejects `signin()`.
- **`clientId`** is a domain-like app identifier (`"myapp.example"`). An empty one rejects with **`AuthenticationError`**, not `InvalidInput`.
- **Existing account:** signing up the same key a second time rejects with `RequestError`, `data.statusCode === 409` ("User already exists"). Catch that status to make signup idempotent.
- **Signup tokens:** pass `null` (or omit the argument) on open homeservers. For token failures, follow [`./auth.md#signup-tokens`](./auth.md#signup-tokens), which documents `RequestError` 400 for a missing token and 401 for an invalid or used one. The 0.16.2 `signup` JSDoc still says `AuthenticationError`. Neither claim was re-verified on 0.16.2, so check both `name` and `statusCode`.
- **Signer sign-in is a dev shortcut.** It needs the user's **secret key** and grants **root** capabilities. Production apps use Pubky Ring through `startGrantAuthFlow` with scoped capabilities: [`./auth.md#javascript`](./auth.md#javascript).

## Session

- `session.info` returns `{ publicKey: PublicKey, capabilities: string[] }`. Capabilities are normalized (for example, `"/pub/app/:rw"`).
- `session.storage` returns a `SessionStorage`. `session.grant` returns the grant session or `undefined`. `session.cookie` is deprecated.
- `session.signout()` revokes the session server-side. After signout, writes reject with `RequestError` 401 and `/priv` reads reject with 401, but **`/pub` reads through the same `session.storage` still succeed**, because `/pub` is public. A second `signout()` resolves and does nothing.
- `session.exportLocalSecret()` returns a **bearer-equivalent secret**, so treat it like a password. Restore it with `pubky.restoreSession(exported)`. `session.export()` / `Session.restore()` are deprecated.
- **Browsers:** delegated grant sessions cannot export raw secrets. Persist them with `pubky.browserSessionStore` (`save` / `list` / `restore` / `remove` / …).
  - Since 0.15.0, `restore(id)` shares one bearer per grant across same-origin tabs. This needs IndexedDB and Web Locks in a secure context. `signout()` revokes the bearer for every tab.
  - Since 0.16.0, older SDKs cannot safely share the new browser session records. Upgrade every app and tab on an origin together.

For lifecycle and persistence, see [`./auth.md#session-lifecycle`](./auth.md#session-lifecycle) and [`./auth.md#persist-and-restore`](./auth.md#persist-and-restore). The new 0.16.x grant features (scoped encryption keys, custom grant proofs) are covered in [`./auth.md`](./auth.md). Encryption keys are app-side crypto material, **not** an encrypted-storage primitive ([guardrail](./shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto)).

## Storage operations

There are two storage surfaces. Every method is async and rejects with `PubkyError`. For when to read your own data and when to read someone else's, see [`./concepts.md#own-data-vs-another-users-data`](./concepts.md#own-data-vs-another-users-data).

| Surface | Access | Path type | Methods |
|---|---|---|---|
| `session.storage` | Read/write **own** data (`/priv` is alpha, see [Paths and addresses](#paths-and-addresses)) | `Path` = `` `/pub/${string}` \| `/priv/${string}` `` (absolute) | reads, plus `putJson` / `putText` / `putBytes` (return `void`), `delete` (**files only**), locks |
| `pubky.publicStorage` | Read-only, **anyone's** `/pub` data, no auth | `Address` = `` `pubky${string}/pub/${string}` \| `pubky://${string}/pub/${string}` `` | reads only |

Both surfaces have these reads: `get` (returns a streamable `Response`), `getJson`, `getText`, `getBytes`, `exists`, `stats`, `list`.

`SessionStorage` overview, from the 0.16.2 README with the lock section left out. **Verified.**

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

Write and delete gotchas:

- **`delete(path)` deletes files only.** This changed after 0.12.0, which documented "file or empty directory". A path that ends in `/` rejects with 400 ("Target path must be a file"). A missing file rejects with 404.
- Writes reject with 400 on a directory target (`/pub/x/dir/`), 403 outside `/pub/` and `/priv/`, 409 on a file/directory path conflict, 423 on a locked path, and 507 over quota.
- `putJson` throws `InvalidInput` if the body cannot be converted to JSON.

Public read, from [`examples/javascript/3-storage.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/examples/javascript/3-storage.mjs). **Verified**, with both the `pubky<pk>` and `pubky://` forms. In this snippet, `a` is the parsed CLI arguments and `resource` is a `pubky<pk>/pub/...` or `pubky://<pk>/pub/...` string. Despite its name, `bytes` holds a string.

```js
const pubky = a.testnet ? Pubky.testnet() : new Pubky();

// PublicStorage reads from addressed `pubky<pk>/<abs-path>` or `pubky://<pk>/<abs-path>` values
const exists = await pubky.publicStorage.exists(resource);
console.log(`Exists: ${exists ? "yes" : "no"}`);

const stats = await pubky.publicStorage.stats(resource);
console.log(`File stats: ${stats ? JSON.stringify(stats, null, 2) : "(none)"}`);

const bytes = await pubky.publicStorage.getText(resource);
```

### Paths and addresses

Path rules are in [`./concepts.md#path-rules`](./concepts.md#path-rules) and key formats in [`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).

- **`SessionStorage` paths are absolute** and start with `/pub/` or `/priv/`. Keep app data under a domain-like folder (`/pub/example.com/`). The `/pub` layout is **not stabilized**. For the pubky.app schemas, see [`./app-specs.md`](./app-specs.md).
- **Build an `Address` in TypeScript as** `` `pubky${pk.z32()}/pub/...` ``. This is the only form that type-checks: `${pk.toString()}/pub/...` and `${pk}/pub/...` widen to `` `${string}/pub/...` `` and fail with TS2322/TS2345. In plain JS, those two forms also work at runtime, because both produce `pubky<z32>`.
  - **Wrong:** `` `${pk.z32()}/pub/...` `` (no prefix) throws `RequestError` with no `statusCode` before any request is sent. If `pk` is a raw z32 **string**, `${pk}` has the same bug.
- **`PublicKey.from(value)`** accepts raw z32 or `pubky<z32>`. Passing `pubky://<z32>` throws `InvalidInput`.
- **`Address` covers `/pub` only.** The SDK does not reject a `/priv` address at runtime, so rely on the TS type.
- **`/priv/` is ALPHA, not for production, and not encrypted from the operator.** It works with a root session on 0.16.2, but its APIs may change or disappear, and a homeserver admin can read and write it. See [`./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage`](./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage) and [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/docs/PRIVATE_STORAGE.md).

### Metadata: `exists` and `stats`

- **`exists(path)`** sends HEAD and returns `false` on 404/410.
- **`stats(path)`** returns `ResourceStats | undefined`. It returns `undefined`, not `null`, on 404/410.
- **`ResourceStats` keys are camelCase and all optional:** `contentLength`, `contentType`, `lastModifiedMs` (Unix epoch ms), `etag` (opaque, may be absent).
- Only `exists` and `stats` treat 404/410 as "missing". Other HTTP failures (401/403/5xx) still reject.
- **The README's PublicStorage comment is wrong:** it shows snake_case keys and `| null`. Trust the `.d.ts`.

### Locks (optional)

`SessionStorage` supports WebDAV locks; the JS API exists since 0.15.0. `lock(path, timeoutSeconds)` returns a `StorageLock` (`path`, `token`, the granted `timeoutSeconds`, `ifHeader()`). Then use `putTextLocked` / `putBytesLocked` / `deleteLocked` (there is no `putJsonLocked`), `refreshLock` and `unlock`.

- While a path is locked, plain `put*`/`delete` and a second `lock()` reject with 423.
- After the lock is lost, writes, deletes and refreshes reject with 412, and `unlock()` rejects with 409. A homeserver without lock support answers 405 (per the README).
- A `lock()` that rejects without a status may still have been granted. In that case the path answers 423 until the timeout expires.
- Details: [README](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/pubky-sdk/bindings/js/pkg/README.md#sessionstorage-readwrite).

## Listing and pagination

Both surfaces use the same signature:

```ts
list(path | address, cursor?: string | null, reverse?: boolean | null,
     limit?: number | null, shallow?: boolean | null): Promise<string[]>
```

- **Returns** full `pubky://<z32>/...` URL strings. An empty page is `[]`.
- **The directory must end with `/`.** Otherwise the SDK throws `RequestError` (no `statusCode`) before sending.
- A missing directory rejects with 404. An invalid cursor rejects with 400.
- **`cursor`** is exclusive: the listing starts after it. Pass the **last URL returned**. The suffix form (`<z32>/pub/...`) gives identical results; this was not re-tested on 0.16.2.
- **`reverse: true`** lists the lexicographically last entries first.
- **`shallow: true`** lists first-level entries only. Directories come back with a trailing `/`.
- **Omitting `limit` does not return everything.** `pubky-homeserver` defaults to **100** entries and caps at **1000**; `limit: 0` returns 0 entries. Other implementations may differ. Always paginate.

Cursor loop, from pubky-ai-kit. **Verified:** it collected 123 files over 3 pages with no duplicates. `dirPath` must end with `/`, for example `"/pub/example.com/"`.

```js
let cursor = null;
const allFiles = [];
let batch;
do {
  batch = await session.storage.list(dirPath, cursor, false, 50);
  allFiles.push(...batch);
  cursor = batch.length > 0 ? batch[batch.length - 1] : null;
} while (cursor && batch.length === 50);
```

## Error handling

SDK errors are `PubkyError` objects: `{ name: PubkyErrorName; message: string; data?: unknown }`. **Branch on `error.name`, never on the message text.** The 0.16.2 union has six names. The README lists only five; it leaves out `ClientStateError`.

| `name` | Typical causes |
|---|---|
| `RequestError` | HTTP status errors (`data.statusCode`); transport failures; SDK-side path validation (`list` without a trailing `/`, `Address` without the `pubky` prefix; these have no `statusCode`) |
| `InvalidInput` | URL parse failures, an invalid relay URL, a bad `requestTimeout` / `maxErrorBodyBytes`, `pubky://` passed to `PublicKey.from`, a non-JSON `putJson` body, capability parse errors (`data.invalidEntries: string[]`) |
| `AuthenticationError` | Auth failures, such as an empty `clientId` |
| `PkarrError` | PKARR resolution failures: reads of a key with no homeserver record, sign-in internals, and probably `getHomeserverOf` failures (not observed; see [below](#keys-and-homeserver-lookup)) |
| `ClientStateError` | Auth-flow or session-kind misuse: see [`./auth.md#errors`](./auth.md#errors) |
| `InternalError` | Client build errors (for example, `relays: []`) |

**Not every throw is a `PubkyError`.** Some 0.16.2 APIs throw a plain **string**, so `e.name` is `undefined` and `e instanceof Error` is `false`. This happens with `Keypair.fromSecret` given an input that is not 32 bytes, and with a second `setLogLevel()` call. Passing an invalid level to `setLogLevel` from untyped JS causes a WASM trap (`RuntimeError: unreachable`). Wrap these calls in a generic `catch`, not a `name` switch.

For HTTP errors, `error.data` is `{ statusCode: number }` only, with no headers. Statuses, documented or observed (rows without a source tag were observed in verification):

| Status | Meaning |
|---|---|
| 400 | Directory target for put/delete; invalid `list` cursor; signup without a required token (per [auth.md](./auth.md#signup-tokens), not re-verified) |
| 401 | No valid session (write after signout, `/priv` read without a session); invalid or used signup token (per [auth.md](./auth.md#signup-tokens), not re-verified) |
| 403 | Write outside `/pub/` and `/priv/` |
| 404 | `get*` on a missing path (both surfaces); `delete` of a missing file; `list` of a missing directory |
| 405 | Lock request to a homeserver without lock support (per the README) |
| 409 | Signup for an existing user; file/directory path conflict; `unlock()` of a lost lock |
| 412 | Stale lock token |
| 423 | Path is locked |
| 429 | Rate limited, including when the storage backend rate-limits (per the v0.15.0 release notes, #662) |
| 507 | Quota exceeded (per the `.d.ts`) |

**Detecting a 404.** Adapted from the 0.16.2 README, which uses `${pk}/pub/...`. That form fails `tsc` against `Address` (TS2345), so this version uses `pubky${pk.z32()}`, which type-checks and adds the required `pubky` prefix. **Verified:** it compiles, and it reaches the 404 branch against the testnet.

```ts
import type { PubkyError, PublicKey, PublicStorage } from "@synonymdev/pubky";

declare const publicStorage: PublicStorage;
declare const pk: PublicKey;

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

**Retrying on 429.** This is the last version of KB `troubleshooting.ts`, which was **deleted upstream** and is no longer type-checked in CI; the APIs it uses are unchanged in 0.16.2. It type-checks on 0.16.2, and the success and rethrow paths ran against the testnet. The 429 branch was only type-checked, because the testnet cannot be made to rate-limit. `data` carries no headers, so `Retry-After` cannot be read; use a fixed backoff instead. After the final 429, the loop still sleeps once and then throws a generic `Error` that drops the original error.

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

**Troubleshooting:** `PkarrError: … No HTTPS endpoints found in PKARR record for _pubky.<z32>` means the key has no resolvable homeserver record on this network. Likely causes: the testnet is not running or not ready yet, the key never signed up, or you are on the wrong network. See [new-project.md step 7](./new-project.md#7-sign-in-fails-check-the-network-first).

## Keys and homeserver lookup

- **`Keypair`:** `Keypair.random()`; `Keypair.fromSecret(secret)`, which needs a **32-byte** `Uint8Array` and otherwise throws a plain string; `keypair.secret()`, `keypair.publicKey`; recovery files with `createRecoveryFile(passphrase)` / `Keypair.fromRecoveryFile(bytes, passphrase)`. See [`./concepts.md#identity-the-ed25519-keypair`](./concepts.md#identity-the-ed25519-keypair).
- **`PublicKey`:** `toString()` returns `pubky<z32>` (for display). `z32()` returns raw z32 (for hostnames, headers, query params, JSON and DB keys). `toUint8Array()` returns 32 bytes. Rules: [`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).
- **`pubky.getHomeserverOf(user): Promise<PublicKey | undefined>`** resolves to `undefined` when there is no homeserver record. On 0.16.2, a fresh, never-published testnet key resolved to `undefined`, and the same key resolved after signup. It rejects when resolution fails or the record is malformed. The `.d.ts` does not name the error; `PkarrError` is expected but was not observed. **Handle both outcomes**, and check for `undefined` before calling `.z32()` (pubky-ai-kit's example does not).

## Logging

`setLogLevel(level)` routes Rust logs to the console. The levels are `"error"`, `"warn"`, `"info"`, `"debug"` and `"trace"`. Call it **once**, at startup, before constructing `Pubky` or any other actor. A second call throws a plain string, so guard it with try/catch as in the [quick start](#quick-start-testnet-end-to-end). Runnable example: [`7-logging.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.16.2/examples/javascript/7-logging.mjs).

## Raw fetch: `resolvePubky`

You rarely need this, because the typed storage methods cover most cases. `resolvePubky(identifier)` maps `pubky<pk>/...` or `pubky://<pk>/...` (both give the same result) to the transport URL `https://_pubky.<pk>/storage/<pk>/<abs-path>`. Only raw `pubky.client.fetch(url, init)` calls need it. For wire addressing, see [`./concepts.md#transport-and-wire-addressing`](./concepts.md#transport-and-wire-addressing).
