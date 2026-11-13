# JavaScript / WASM client (`@synonymdev/pubky`)

> Starting a new app? Follow [new-project.md](./new-project.md) first. It owns intake, network choice and the version check. This file is the SDK detail it links to.

This page covers only the JS-specific parts of the browser and Node SDK. Everything else lives in these files:

- **Protocol concepts** (identity, `pubky://` addressing, PKARR, homeserver model, key string formats, own data vs public reads): [`./concepts.md`](./concepts.md)
- **Auth** (`pubkyauth` flows, capabilities, signup tokens, HTTP relay, session persistence, account info): [`./auth.md`](./auth.md)
- **Local testnet:** [`./testing-and-testnet.md`](./testing-and-testnet.md)
- **Data schemas:** [`./app-specs.md`](./app-specs.md) · **Guardrail:** [`./shipped-vs-planned.md`](./shipped-vs-planned.md) · **Rust SDK:** [`./sdk-rust.md`](./sdk-rust.md)

**Upstream sources.** These are authoritative. This page summarizes them and does not copy them.

- **Typings:** [`pubky.d.ts` @ 0.18.0](https://unpkg.com/@synonymdev/pubky@0.18.0/pubky.d.ts). This is the exact surface `npm install` gives you, including the full member lists for `Signer`, `Session`, `SessionStorage` and `PublicStorage`.
- **API docs:** [TypeDoc](https://pubky.github.io/pubky-homeserver/js-sdk-typedoc/). It is unversioned and already documents 0.18.0 additions such as `GrantSession.account`.
- **Package README:** [README @ v0.18.0](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/bindings/js/pkg/README.md)
- **Release notes:** [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0). They include a breaking path-encoding change; see [Paths and addresses](#paths-and-addresses).
- **Runnable programs:** [`examples/javascript` @ v0.18.0](https://github.com/pubky/pubky-homeserver/tree/v0.18.0/examples/javascript). They depend on the local SDK build (`file:../../pubky-sdk/bindings/js/pkg`), not on npm.
- **Type-checked snippets:** [`pubky-knowledge-base-v2/snippets/js/src`](https://github.com/pubky/pubky-knowledge-base-v2/tree/main/snippets/js/src). Only `developer-guide.ts` remains, and it is still pinned to **0.14.0**.
- **Homeserver HTTP statuses:** [`openapi-client.yml` @ v0.18.0](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-homeserver/openapi-client.yml)

If a signature here disagrees with your installed `.d.ts`, trust the `.d.ts`.

> **Version note:** this page targets **0.18.0**: npm dist-tag `latest`, published 2026-11-09 from `pubky-homeserver` tag `v0.18.0`. The npm releases after 0.16.2 are 0.17.1 (2026-10-26) and 0.18.0. 0.17.0 was never published. Never install the other dist-tags: `alpha` is 0.10.0-alpha.0 and `next` is a stale 0.6.0-rc.7. Pubky is pre-1.0, so treat every API as **unstable**.
>
> **Unreleased (on `main` only, not in npm 0.18.0):** per-request `request_timeout` on WASM (#725), a homeserver 413 for uploads over 100 MiB (#808), and homeserver child grants (#792, breaking). Do not rely on them yet.
>
> **Snippet provenance:** the KB snippets are type-checked and linted against **0.14.0** but are never executed. Snippets marked **Verified** were run with **SDK 0.18.0 (the npm tarball) on Node 24 against a local testnet built from pubky-homeserver `main` 8612a64**. That build is v0.18.0 plus 9 unreleased commits, so results on a released v0.18.0 homeserver may differ.

## Install and runtime

```bash
npm install @synonymdev/pubky@0.18.0
```

**Verified:** installs and resolves exactly 0.18.0, which was npm `latest` on 2026-11-12.

- **Pin the version** so the code matches this page. An unpinned install gets npm `latest`. If `latest` has moved past 0.18.0, check its `.d.ts` against this page (see [new-project.md](./new-project.md#3-check-the-sdk-version-first)).
- **Runtimes:** browsers and **Node 20+**, which provides `undici` fetch and WebCrypto. `package.json` has no `engines` field, so npm does not enforce the Node version.
  - The upstream examples use Node 24 for development (`.nvmrc`).
  - The browser examples (`2-auth-flow`, `5-browser-session-persistence`) use Vite 8, which needs Node `^20.19.0 || >=22.12.0`.
- **Modules:** ESM (`import { Pubky } from "@synonymdev/pubky"`) and CJS (`require`) both work. TypeScript typings are bundled. The only runtime dependency is `fetch-cookie`.
- **TypeScript `lib`:** the `.d.ts` declares `[Symbol.dispose]()` on every class, including the new `AccountInfo`. If your `lib` lacks `esnext.disposable` (for example, target es2022 without `esnext`), compilation fails: TS2550 on TS 5.9, and TS2339/TS1165 on older 5.x. Add `esnext.disposable` or set `skipLibCheck`.
- **There is no WASM init step.** The package instantiates the WASM module before it exposes any API, so do not call or await an `init()`. Long-polling calls (`authFlow.awaitApproval()`, `tryPollOnce()`) wait for readiness on their own.
- **Create one shared `Pubky` facade** and pass it around (through context or props). Do not construct one per request, because each construction reinitializes the transports.
- **Freeing WASM objects:** exported classes have `free()` and `[Symbol.dispose]()`. Garbage collection is enough for typical apps. Call `free()` only in long-running workers that create many short-lived instances.

## The facade

| Constructor | Use |
|---|---|
| `new Pubky()` | Mainnet, with the default HTTPS PKARR relays |
| `Pubky.testnet(host?)` | Local testnet. `host` defaults to `"localhost"`. Pass a **hostname or IP** (`"127.0.0.1"`, `"docker-host"`), not a URL. |
| `Pubky.withClient(client)` | A custom `Client` (relays, timeouts) |

- `pubky.signer(keypair)` returns a `Signer`. Use it instead of `Signer.fromKeypair`.
- Getters: `pubky.client`, `pubky.publicStorage`, `pubky.browserSessionStore`. `Client.testnet(host?)` also exists.
- Testnet setup and ports: [`./testing-and-testnet.md#standalone-local-testnet`](./testing-and-testnet.md#standalone-local-testnet) and [`./testing-and-testnet.md#js-against-the-local-testnet`](./testing-and-testnet.md#js-against-the-local-testnet).

## WASM needs PKARR relays

Browsers and WASM cannot reach the UDP Mainline DHT, so every PKARR resolve and publish goes through **HTTPS PKARR relays**. `new Pubky()` already uses pkarr's default relays ([authoritative list](https://github.com/pubky/pkarr/blob/main/pkarr/src/lib.rs)), so the common case needs no configuration. General model: [`./concepts.md#pkarr-resolution`](./concepts.md#pkarr-resolution).

To override the relays, use this snippet from KB `developer-guide.ts`, region `js_pkarr_relay_config`. Only the import line was added. **Verified:** type-checks and constructs a working `Pubky` on 0.18.0 (no relay was contacted).

```js
import { Client, Pubky } from "@synonymdev/pubky";

const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

The config shape in 0.18.0 is `{ pkarr?: { relays?: string[]; requestTimeout?: number }; maxErrorBodyBytes?: number }`.

- **`requestTimeout`** is the relay HTTP request timeout in **milliseconds**. **The default is 5000.** Guides that set `2000`, such as pubky-ai-kit, shorten it.
- **`maxErrorBodyBytes`** caps how much of an HTTP error body is captured. The default is 4096, and `0` skips the body.
- **`relays` replaces the default list. It does not append to it.**
- **Do not pass `relays: []`.** Construction throws `InternalError` ("passed an empty list of relays").
- Construction throws `InvalidInput` for an invalid relay URL, a negative or `NaN` `requestTimeout`, or a `maxErrorBodyBytes` that is not an integer in `0..=4294967295`.
- **Use camelCase.** In plain JS, `request_timeout` is silently ignored and the default applies.
- **PKARR relays are not the HTTP relay.** The HTTP relay carries `pubkyauth` messages. Set it per flow with `startGrantAuthFlow(caps, kind, { clientId, relay })`, never in `pkarr.relays`. Run your own relay in production. See [`./auth.md#relays`](./auth.md#relays).

## Quick start (testnet, end to end)

This program sets the log level, creates an identity, signs up, signs in, then writes and reads. It comes from KB `developer-guide.ts` (regions `js_developer_guide_imports` through `read`) with two changes: the `z32()` log call is changed to `toString()` for display ([key formats](./concepts.md#public-key-string-formats)), and upstream's browser `#app` rendering is left out.

**Verified** on 0.18.0 against a local testnet: signup, signin (capabilities `["/:rw"]`) and the `putJson`/`getJson` round trip. It needs a running local testnet. The hard-coded key is the fixed testnet homeserver.

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

For a first smoke test, run [`examples/javascript/6-check-testnet.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/examples/javascript/6-check-testnet.mjs).

## Sign up and sign in

`Signer` methods in 0.18.0 (unchanged since 0.16.2). All are async. Parameter names match the `.d.ts`, which has the full list.

- `signup(homeserver: PublicKey, signup_token?: string | null): Promise<void>` creates the account and publishes PKDNS. **It returns no session.**
- `signin(client_id: string): Promise<Session>` publishes PKDNS in the background (fast path).
- `signinBlocking(client_id: string): Promise<Session>` waits for the PKDNS publish to finish.
- Both sign-in variants return a grant-backed session with **root** capabilities (`session.info.capabilities` = `["/:rw"]`).
- **Never use `signupCookie` / `signinCookie` / `signinCookieBlocking`.** Cookie auth has been deprecated since v0.10.0, gets only limited security maintenance, and **will be removed in August 2027** (v0.18.0 release notes). See [`./auth.md#deprecated-cookie-auth`](./auth.md#deprecated-cookie-auth).
- Authenticator-side methods: [`./auth.md#authenticator-side-approving-requests`](./auth.md#authenticator-side-approving-requests). New in 0.18.0: the grant-flow option `GrantAuthFlowOptions.expectedSigner` (`string | null`) and the authenticator-side getter `SigninGrantDeepLink.expectedSigner` (`PublicKey | undefined`).

Gotchas:

- **Always call `signin(clientId)` after `signup()`.** `const session = await signer.signup(...)` and a no-argument `signin()` are pre-0.10 forms that pubky-ai-kit still shows. TypeScript rejects `signin()`.
- **`clientId`** is a domain-like app identifier (`"myapp.example"`). An empty one rejects with **`AuthenticationError`** ("ClientId must not be empty") without a network call.
- **Existing account:** a second signup of the same key rejects with `RequestError`, `data` = `{ reason: "Http", statusCode: 409 }` ("User already exists"). Catch it to make signup idempotent. **Verified.**
- **Signup tokens:** pass `null` (or omit the argument) on open homeservers. The v0.18.0 OpenAPI documents 400 for a missing or malformed token and 401 for an invalid or already-used token. Both arrive as `RequestError`, despite the `.d.ts` JSDoc saying `AuthenticationError`. Not runtime-verified, because the testnet allows open signup. See [`./auth.md#signup-tokens`](./auth.md#signup-tokens).
- **Signer sign-in is a dev shortcut.** It needs the user's **secret key** and grants **root** capabilities. Production apps use Pubky Ring through `startGrantAuthFlow` with scoped capabilities: see [`./auth.md#javascript`](./auth.md#javascript).

## Session

- `session.info` returns `{ publicKey: PublicKey, capabilities: string[] }`. Capabilities are normalized (for example, `"/pub/app/:rw"`).
- `session.storage` returns a `SessionStorage`. `session.cookie` is deprecated.
- `session.grant` returns `GrantSession | undefined`. **Narrow it before use.** The README's `session.grant.account()` fails strict TypeScript.
- **New in 0.18.0:** `grant.account(): Promise<AccountInfo>` returns `usedBytes`, quota and `disabled`. It needs a grant session with root read (`/:r` or `/:rw`). A path-scoped session gets a 403 `RequestError`. Details: [`./auth.md#session-lifecycle`](./auth.md#session-lifecycle).
- `session.signout()` revokes the session server-side. **Behavior in 0.18.0 (verified):**
  - After signout, writes and `/priv` reads through that session reject with **`CredentialRefreshError`**, `data` = `{ statusCode: 401 }`, not with `RequestError` 401. The SDK tries to refresh the grant bearer, and the homeserver rejects the refresh.
  - `/pub` reads through the same `session.storage` still succeed, because `/pub` is public.
  - A second `signout()` resolves and does nothing.
- `session.exportLocalSecret()` returns a **bearer-equivalent secret**: treat it like a password. Restore it with `pubky.restoreSession(exported)`. `session.export()` and `Session.restore()` are deprecated.
- **Browsers:** delegated grant sessions cannot export raw secrets. Persist them with `pubky.browserSessionStore` (`save` / `list` / `restore` / `remove` / …).
  - Since 0.15.0, `restore(id)` shares one bearer per grant across same-origin tabs. This needs IndexedDB and Web Locks in a secure context. `signout()` revokes the bearer for every tab.
  - Since 0.16.0, older SDKs cannot safely share the new browser session records. Upgrade every app and tab on an origin together.

Lifecycle and persistence: [`./auth.md#session-lifecycle`](./auth.md#session-lifecycle) and [`./auth.md#persist-and-restore`](./auth.md#persist-and-restore). Scoped encryption keys are app-side crypto material, **not** an encrypted-storage primitive ([guardrail](./shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto)).

## Storage operations

Two storage surfaces. Every method is async and rejects with `PubkyError`. Which one to use: [`./concepts.md#own-data-vs-another-users-data`](./concepts.md#own-data-vs-another-users-data).

| Surface | Access | Path type | Methods |
|---|---|---|---|
| `session.storage` | Read and write **own** data (`/priv` is alpha; see [Paths and addresses](#paths-and-addresses)) | `Path` = `` `/pub/${string}` \| `/priv/${string}` `` (absolute) | Reads, plus `putJson` / `putText` / `putBytes` / `putBlob` (all return `void`), `delete` (**files only**), and locks |
| `pubky.publicStorage` | Read-only access to **anyone's** `/pub` data, no auth | `Address` = `` `pubky${string}/pub/${string}` \| `pubky://${string}/pub/${string}` `` | Reads only |

Both surfaces have these reads: `get` (returns a streamable `Response`), `getJson`, `getText`, `getBytes`, `exists`, `stats` and `list`.

This `SessionStorage` overview is the 0.18.0 README block with the lock section left out. **Verified** on a fresh testnet session: every call succeeds, `get()` returns a `Response` with status 200, and each read returns what was written.

```js
const s = session.storage;

// Writes
await s.putJson("/pub/example.com/data.json", { ok: true });
await s.putText("/pub/example.com/note.txt", "hello");
await s.putBytes("/pub/example.com/img.bin", new Uint8Array([1, 2, 3]));
await s.putBlob("/pub/example.com/file.bin", new Blob(["file contents"]));

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

**`putBlob(path, body: Blob)` (0.17.1+)** uploads a `Blob` or `File` without copying it into WASM memory. Prefer it over `putBytes` for user files. A non-`Blob` body rejects with `InvalidInput` ("body must be a Blob or File") before any request. **Verified:** round trips with both `Blob` and `File`.

**`putJson` does not follow `JSON.stringify` semantics** (observed on 0.18.0). It converts the value through `serde_wasm_bindgen`:

- A `Date` is stored as `{}`, a `Map` as a plain object, a BigInt `1n` as `1`, and `NaN` or a top-level `undefined` as `null`. Symbol keys are dropped.
- An object with a `toJSON` method, or any function value, rejects with `InvalidInput`.
- **A circular object crashes the Node process** with an uncaught WASM error (for example `RuntimeError: memory access out of bounds`). A try/catch around the `await` cannot catch it.
- **Do this instead:** pass plain JSON data, for example `JSON.parse(JSON.stringify(value))`, or call `putText(path, JSON.stringify(value))`.

Write and delete gotchas (**verified** on 0.18.0; all are `RequestError` with `data` = `{ reason: "Http", statusCode }`):

- **`delete(path)` deletes files only.** A path ending in `/` rejects with 400 ("Target path must be a file"). A missing file rejects with 404.
- Writes reject with 400 on a directory target (`/pub/x/dir/`) and 403 outside `/pub/` and `/priv/`. The OpenAPI spec also lists 507 for quota exceeded.
- **Upload size:** the v0.18.0 homeserver caps request bodies at 100 MiB. A guaranteed 413 for every oversized upload, including streams without `Content-Length`, exists only on unreleased `main` (#808). Do not branch on 413 for released homeservers.
- Public read of someone else's file: [`examples/javascript/3-storage.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/examples/javascript/3-storage.mjs) reads with `pubky.publicStorage.exists` / `stats` / `getText` using either address form.

### Paths and addresses

Path rules: [`./concepts.md#path-rules`](./concepts.md#path-rules). Key formats: [`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).

- **BREAKING in 0.18.0 (#797): a path is the file's plain name.** Write `/pub/app/My File.txt`, not a percent-encoded form. The SDK percent-encodes once when it builds the HTTP URL. `list()` entries, `resource.path`, `toPubkyUrl()` and `event.resource.path` now come back as plain names, and a `list()` cursor takes the same plain form. **Verified:** `"/pub/example.com/My File 100%.txt"` round-trips, and public reads by its plain name work in both address forms.
- **Legacy files:** files that SDK v0.6–v0.17 wrote under a name that HTTP encoding escapes keep the escaped name. For example, `pub/my file.txt` is stored as `pub/my%20file.txt`. In 0.18.0, read such a file by its **stored** name (`/pub/.../my%20file.txt`); the plain name returns 404. **Verified.**
- **`SessionStorage` paths are absolute** and start with `/pub/` or `/priv/`. Keep app data under a domain-like folder (`/pub/example.com/`). The `/pub` layout is **not stabilized**. pubky.app schemas: [`./app-specs.md`](./app-specs.md).
- **In TypeScript, build an `Address` as** `` `pubky${pk.z32()}/pub/...` ``. It is the only template form that type-checks. `${pk.toString()}/pub/...` and `${pk}/pub/...` widen to `` `${string}/pub/...` `` and fail with TS2322/TS2345, even though the README's Getting Started uses them. In plain JS, both also work at runtime.
  - **Wrong:** `` `${pk.z32()}/pub/...` `` has no prefix. It throws `RequestError`, `data` = `{ reason: "InvalidRequest" }` (no `statusCode`), before any request. If `pk` is a raw z32 **string**, `${pk}` has the same bug.
- **`PublicKey.from(value)`** accepts raw z32 or `pubky<z32>`. `pubky://<z32>` throws `InvalidInput`.
- **`Address` covers `/pub` only.** The SDK does not reject a `/priv` address at runtime, so rely on the TypeScript type.
- **`/priv/` is ALPHA, not for production, and not encrypted from the operator.** It works with a root session, but its APIs may change or disappear, and a homeserver admin can read and write it. See [`./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage`](./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage) and [`PRIVATE_STORAGE.md`](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/docs/PRIVATE_STORAGE.md).

### Metadata: `exists` and `stats`

- **`exists(path)`** sends a HEAD request and returns `false` on 404/410.
- **`stats(path)`** returns `ResourceStats | undefined`. On 404/410 it returns `undefined`, not `null`.
- **`ResourceStats` keys are camelCase and all optional:** `contentLength`, `contentType`, `lastModifiedMs` (Unix epoch ms) and `etag` (opaque, may be absent). **Verified.**
- Only `exists` and `stats` treat 404/410 as "missing". Other HTTP failures (401/403/5xx) still reject.
- **The 0.18.0 README's PublicStorage comment is wrong:** it shows snake_case keys and `| null`. Trust the `.d.ts`.

### Locks (optional)

`SessionStorage` supports WebDAV locks. `lock(path, timeoutSeconds)` returns a `StorageLock` (`path`, `token`, the granted `timeoutSeconds`, `ifHeader()`). Then use `putTextLocked` / `putBytesLocked` / `putBlobLocked(lock, blob)` / `deleteLocked`, `refreshLock` and `unlock`. There is no `putJsonLocked`.

- While a path is locked, plain `put*` (including `putBlob`) and a second `lock()` reject with 423. **Verified.**
- After the lock is lost, locked writes (including `putBlobLocked`) reject with 412, and `unlock()` rejects with 409. **Verified.** A homeserver without lock support answers 405 (per the README).
- A `lock()` that rejects without a status may still have been granted. The path then answers 423 until the timeout expires.
- Details: [README](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-sdk/bindings/js/pkg/README.md#sessionstorage-readwrite).

## Listing and pagination

Both surfaces use the same signature (unchanged in 0.18.0):

```ts
list(path | address, cursor?: string | null, reverse?: boolean | null,
     limit?: number | null, shallow?: boolean | null): Promise<string[]>
```

- **Returns** full `pubky://<z32><path>` URL strings with **plain (unencoded) names**. An empty page is `[]`.
- **The directory must end with `/`.** Otherwise the SDK throws `RequestError`, `data` = `{ reason: "InvalidRequest" }` (no `statusCode`), before sending.
- A missing directory rejects with 404, and an invalid cursor with 400.
- **`cursor` is exclusive:** the listing starts after it. Pass the **last entry returned** (the full `pubky://` string works).
- **`reverse: true`** lists the lexicographically last entries first.
- **`shallow: true`** lists only first-level entries. Directories come back with a trailing `/`.
- **Omitting `limit` does not return everything.** `pubky-homeserver` defaults to **100** entries and caps at **1000** ([constants](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/pubky-homeserver/src/constants.rs)). `limit: 0` returns `[]`. Other implementations may differ, so always paginate.

Cursor loop from pubky-ai-kit. `dirPath` must end with `/`, for example `"/pub/example.com/"`. **Verified** against a local testnet on directories of 120, 100 and 7 files: every file collected once, and the exact-multiple case (100) ends on an empty final page.

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

SDK errors are `PubkyError` objects: `{ name: PubkyErrorName; message: string; data?: unknown }`. `interface PubkyError extends Error`, so `e instanceof Error` is `true`. **Branch on `error.name`, never on the message text.** The 0.18.0 union has **seven** names; the README lists six and leaves out `ClientStateError`.

| `name` | Typical causes |
|---|---|
| `RequestError` | HTTP status errors, transport failures, and SDK-side request validation. `data` is typed `RequestErrorData` (below). |
| `CredentialRefreshError` | **New in 0.17.1.** A grant credential refresh failed while the SDK was preparing or retrying a request, for example any write after `signout()`. `data` = `{ statusCode }` when the refresh endpoint responded; transport failures omit `data`. |
| `InvalidInput` | URL or parse failures, an invalid relay URL, a bad `requestTimeout` / `maxErrorBodyBytes`, `pubky://` passed to `PublicKey.from`, a non-convertible `putJson` body, a non-`Blob` `putBlob` body, and capability parse errors (`data.invalidEntries: string[]`) |
| `AuthenticationError` | Auth failures, such as an empty `clientId` |
| `PkarrError` | PKARR resolution failures, such as reading a key with no homeserver record ("No HTTPS endpoints found"), and sign-in internals |
| `ClientStateError` | Misuse of an auth flow or the wrong session kind: see [`./auth.md#errors`](./auth.md#errors) |
| `InternalError` | Client build errors (for example, `relays: []`) |

**`RequestError.data` is typed (since 0.17.1).** `RequestErrorData` and `RequestErrorReason` are both exported:

- `RequestErrorData` = `{ reason: RequestErrorReason; statusCode?: number }`.
- `RequestErrorReason` = `"Http" | "Timeout" | "Connection" | "TlsVerification" | "Body" | "Decode" | "InvalidRequest" | "Other"` (`"TlsVerification"` since 0.18.0).
- `statusCode` is present **only when `reason` is `"Http"`**.
- SDK-side validation (`list` without a trailing `/`, an `Address` without the `pubky` prefix) gives `"InvalidRequest"` with no status.
- In browsers, Fetch may report only `"Other"`.
- `"TlsVerification"` means the server certificate was rejected. A stale PKARR cache after a legitimate key rotation looks the same, so it does not prove interception.
- A reason describes the failure. It does not say whether retrying a write is safe.
- `data` carries no headers, so `Retry-After` is unavailable.

**Not every throw is a `PubkyError`.** Some 0.18.0 APIs still throw a plain **string** (so `e.name` is `undefined`) or a raw WASM error:

- Plain string: `Keypair.fromSecret` with input that is not 32 bytes ("Expected secret to be 32 bytes, got 31").
- Plain string: a second `setLogLevel()` call.
- Raw WASM error: an invalid level passed to `setLogLevel` from untyped JS throws a catchable `RuntimeError` ("unreachable"), with `name` `"RuntimeError"`.

Wrap these calls in a generic `catch`, not a `name` switch.

HTTP statuses, observed in verification unless a source is given:

| Status | Meaning |
|---|---|
| 400 | Directory target for put/delete; invalid `list` cursor; signup without a required token or with a malformed one (per OpenAPI) |
| 401 | `/priv` read without a session; invalid or used signup token (per OpenAPI). After `signout()`, it surfaces as `CredentialRefreshError`, not `RequestError`. |
| 403 | Write outside `/pub/` and `/priv/`; `grant.account()` from a path-scoped session |
| 404 | `get*` on a missing path (both surfaces); `delete` of a missing file; `list` of a missing directory; a legacy file read by its plain name |
| 405 | Lock request to a homeserver without lock support (per the README) |
| 409 | Signup for an existing user; `unlock()` of a lost lock |
| 412 | Stale lock token |
| 423 | Path is locked |
| 429 | Rate limited (per the v0.15.0 release notes) |
| 507 | Quota exceeded (per OpenAPI) |

**Detecting a 404.** Adapted from the 0.18.0 `.d.ts` and README, using the typed `RequestErrorData` and an `Address` that type-checks. **Verified:** compiles under `tsc --strict` and, run against a local testnet, takes the 404 branch with `data` = `{ reason: "Http", statusCode: 404 }`.

```ts
import type { PubkyError, PublicKey, PublicStorage, RequestErrorData } from "@synonymdev/pubky";

declare const publicStorage: PublicStorage;
declare const pk: PublicKey;

try {
  await publicStorage.getJson(`pubky${pk.z32()}/pub/example.com/missing.json`);
} catch (e) {
  const error = e as PubkyError;
  if (error.name === "RequestError") {
    const { reason, statusCode } = error.data as RequestErrorData;
    if (statusCode === 404) {
      // handle not found
    } else if (reason === "Timeout" || reason === "Connection") {
      // transient transport failure
    }
  }
}
```

**Retrying on 429.** This is the last version of KB `troubleshooting.ts`, which was **deleted upstream** and is no longer checked in CI. **Verified:** type-checks under strict mode against 0.18.0; run against a local testnet, real writes succeed, a real 404 is extracted and rethrown, and the 429 retry and exhaustion paths work with a **mocked** 429 (the testnet cannot be made to rate-limit).

- `data` has no headers, so the helper uses a fixed backoff.
- After the final 429, the loop sleeps once more and then throws a generic `Error` that drops the original error.
- `statusCodeOf` also returns a status for `CredentialRefreshError`. If the 429 must come from the storage request itself, also check `error.name === "RequestError"`.

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

**Troubleshooting:** `PkarrError: … No HTTPS endpoints found in PKARR record for _pubky.<z32>` means the key has no resolvable homeserver record on this network. Likely causes: the testnet is not running or not ready, the key never signed up, or you are on the wrong network. See [new-project.md step 7](./new-project.md#7-sign-in-fails-check-the-network-first).

## Keys and homeserver lookup

- **`Keypair`:** `Keypair.random()`; `Keypair.fromSecret(secret)` needs a **32-byte** `Uint8Array` and otherwise throws a plain string; `keypair.secret()`; `keypair.publicKey`; recovery files through `createRecoveryFile(passphrase)` / `Keypair.fromRecoveryFile(bytes, passphrase)`. See [`./concepts.md#identity-the-ed25519-keypair`](./concepts.md#identity-the-ed25519-keypair).
- **`PublicKey`:** `toString()` returns `pubky<z32>` for display. `z32()` returns raw z32 for hostnames, headers, query params, JSON and DB keys. `toUint8Array()` returns 32 bytes. `PublicKey.from(pk.toString())` round-trips. Rules: [`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).
- **`pubky.getHomeserverOf(user): Promise<PublicKey | undefined>`** resolves to `undefined` for a key that never published, and to the homeserver key after signup (**verified**). It rejects when resolution fails. **Check for `undefined` before calling `.z32()`;** pubky-ai-kit's example skips this check.

## Logging

`setLogLevel(level)` routes Rust logs to the console. Levels: `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"`. Call it **once**, at startup, before constructing `Pubky` or any other actor. A second call throws a plain string, so guard it with try/catch as in the [quick start](#quick-start-testnet-end-to-end). Runnable example: [`7-logging.mjs`](https://github.com/pubky/pubky-homeserver/blob/v0.18.0/examples/javascript/7-logging.mjs).

## Raw fetch: `resolvePubky`

Rarely needed: the typed storage methods cover most cases. `resolvePubky(identifier)` maps `pubky<pk>/...` or `pubky://<pk>/...` to the homeserver transport URL; only raw `pubky.client.fetch(url, init)` calls need it. Wire addressing: [`./concepts.md#transport-and-wire-addressing`](./concepts.md#transport-and-wire-addressing).
