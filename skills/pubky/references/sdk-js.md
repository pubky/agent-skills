# JavaScript / WASM client (`@synonymdev/pubky`)

`@synonymdev/pubky` is the official JS/WASM SDK — auth + data ops over `pubky://`, for browsers
and Node. Canonical protocol knowledge lives elsewhere: identity, `pubky://` addressing, PKARR,
the homeserver model, public-key string formats, and the write-own vs public-read split are in
[`./concepts.md`](./concepts.md); the full `pubkyauth` flow, capabilities, signup tokens, and
session-persistence semantics are in [`./auth.md`](./auth.md); testnet defaults and local dev are
in [`./testing-and-testnet.md`](./testing-and-testnet.md). The Rust sibling SDK is
[`./sdk-rust.md`](./sdk-rust.md).

**Upstream (authoritative — summarize, don't mirror):** the surface `npm install` resolves to is
the published TypeScript declarations
([`pubky.d.ts` @ 0.9.3](https://unpkg.com/@synonymdev/pubky@0.9.3/pubky.d.ts)); package page on
[npm](https://www.npmjs.com/package/@synonymdev/pubky). Runnable programs:
[`pubky-core/examples/javascript`](https://github.com/pubky/pubky-core/tree/main/examples/javascript)
(track `main`/HEAD — see the drift note). CI type-checked snippets:
[`pubky-knowledge-base-v2/snippets/js/src`](https://github.com/pubky/pubky-knowledge-base-v2/tree/main/snippets/js/src).
When a signature here looks stale, trust the published `.d.ts` for the version you installed.

> **Version:** latest published is **0.9.3** (dist-tag `latest`) — what `npm install
> @synonymdev/pubky` resolves to today and what this page is anchored on. Pubky is pre-1.0;
> treat APIs as **unstable**.

> **Version drift — do NOT code against this.** The `pubky-core` `main` checkout (binding source,
> `examples/javascript/*.mjs`, `pkg/README.md`) is a dev HEAD **ahead of 0.9.3** with a different,
> **unpublished** API: (a) `signer.signup(homeserver, token?)` returns `Promise<void>` and you
> must then call `signer.signin(clientId)`; (b) `signin(clientId)` / `signinBlocking(clientId)`
> **require** a `clientId`; (c) `startAuthFlow` / `resumeAuthFlow` are split into
> `startCookieAuthFlow` + `startGrantAuthFlow` and `resumeCookieAuthFlow` + `resumeGrantAuthFlow`;
> (d) grant-session persistence via `session.exportSecret()` + `pubky.restoreSession()`, with
> `session.export()` demoted to legacy cookie sessions. **None of this is in 0.9.3.** Trust the
> 0.9.3 surface (published `.d.ts`, KB snippets) for what you installed.

## Install and runtime

```bash
npm install @synonymdev/pubky
```

- Works in **browsers** and **Node 20+** (Node needs `undici` fetch + WebCrypto, both standard on
  20+).
- Ships both **ESM** and **CommonJS**; TypeScript typings (generated via `tsify`) are bundled —
  no `@types` package needed.

```js
// ESM
import { Pubky } from "@synonymdev/pubky";
// CommonJS
const { Pubky } = require("@synonymdev/pubky");
```

## Initialize the facade

**WASM is auto-initialized.** The npm package bundles the WebAssembly module and instantiates it
*before* exposing any API — there is **no** manual `init()` / `await` step. This avoids the
wasm-pack pitfall where a relay long-poll fires before the module finishes instantiating. Just
import and construct:

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = new Pubky();
```

Construction variants (published 0.9.3 `.d.ts`):

- `new Pubky()` — mainnet PKARR defaults.
- `Pubky.testnet(host?)` — local dev. `host` is a bare **hostname**, not a URL; it defaults to
  `localhost` and derives `http://<host>:15411/` internally (testnet ports are already
  15411/15412). Pass a hostname for Docker/custom (`Pubky.testnet("docker-host")`) — never a full
  URL (a URL corrupts the derived host and breaks PKDNS resolution). See
  [`./testing-and-testnet.md`](./testing-and-testnet.md).
- `Pubky.withClient(client)` — wrap a hand-built `Client` (the relay/timeout escape hatch below).

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = Pubky.testnet();
```

**Reuse one shared `Pubky`** across the app (React context / prop-drilling), not one per request
— a fresh instance reinitializes transports. The testnet homeserver pubkey used across the JS
examples (derived from the all-zeros secret) is
`pubky8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo`; local-dev details live in
[`./testing-and-testnet.md`](./testing-and-testnet.md).

## WASM needs PKARR relays

Browsers/WASM **cannot speak the Mainline DHT directly** (the DHT runs over UDP), so PKARR
resolve/publish must go through an HTTP relay. `new Pubky()` is pre-wired with default mainnet
relays, so the common case needs **no config**. To override relays (or set a request timeout),
build a `Client` and wrap it — import both `Pubky` and `Client` from the package:

```js
const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

The `pkarr` block also accepts `requestTimeout` (ms, camelCase). The *why* (PKARR resolution over
relays) is canonical — see [`./concepts.md#pkarr-resolution`](./concepts.md#pkarr-resolution).

## Quick start (end-to-end)

```js
import { Pubky, Keypair } from "@synonymdev/pubky";

// Create client and signer
const pubky = new Pubky();
const signer = pubky.signer(Keypair.random());

// Sign up (pass signup token for gated homeservers, null for open/testnet)
const session = await signer.signup(homeserverPk, null);
console.log("Your pubky:", signer.publicKey.z32());

// Store data
await session.storage.putJson("/pub/myapp/profile", {
  name: "Alice",
  bio: "Building on Pubky!",
  avatar: "https://example.com/avatar.jpg",
});

// Retrieve data
const profile = await session.storage.getJson("/pub/myapp/profile");
console.log("Profile:", profile);

// List directory
const files = await session.storage.list("/pub/myapp/");
console.log("Files:", files);

// Sign out
await session.signout();
```

## The type model

- `pubky.signer(keypair)` → **`Signer`** — the key holder; exposes `publicKey: PublicKey` and
  `pkdns: Pkdns`.
- `signer.signup(...)` / `signer.signin()` → **`Session`** — the authenticated per-identity API.

Two storage surfaces share one read API:

- `session.storage` → **`SessionStorage`** — read **and write** your **own** data, with
  **absolute** `/pub/...` paths.
- `pubky.publicStorage` → **`PublicStorage`** — **read-only** access to **anyone's** public data,
  using **addressed** paths (`pubky<user>/pub/...` preferred, or `pubky://<user>/pub/...`). No
  auth, no writes.

This write-own vs read-public split is canonical — see [`./concepts.md`](./concepts.md). For the
authoritative method surface of each type, read the published
[`pubky.d.ts`](https://unpkg.com/@synonymdev/pubky@0.9.3/pubky.d.ts) rather than relying on a
copied table here.

## Sign up and sign in

Signatures (published 0.9.3 `.d.ts`), all `async`:

- `Signer.signup(homeserver: PublicKey, signup_token?: string | null): Promise<Session>`
- `Signer.signin(): Promise<Session>`
- `Signer.signinBlocking(): Promise<Session>`

**`signup` returns a usable `Session` in 0.9.3** — you do **not** need a separate `signin` call
(that's a dev-HEAD change; see the drift note). Pass `null` for `signup_token` on open/testnet
homeservers, an invite token for gated ones (see [`./auth.md`](./auth.md)).

`signin()` is **fast** — it refreshes/publishes PKDNS in the background. `signinBlocking()` waits
for PKDNS to be discoverable (~3–5s); use it when the user's homeserver must be resolvable
immediately. Both take **no arguments** in 0.9.3:

```js
const signer = pubky.signer(keypair);

// Fast: PKDNS refresh happens in the background
const session = await signer.signin();

// Blocking: waits for PKDNS to be discoverable (~3-5s)
// Use this when you need the user's homeserver to be resolvable immediately
const sessionBlocking = await signer.signinBlocking();
```

`session.signout()` invalidates the server session — subsequent storage calls then fail. Session
owner is `session.info.publicKey`; granted capabilities are `session.info.capabilities`
(`string[]`).

## Storage operations

`SessionStorage` (read/write) and `PublicStorage` (read-only) share these read helpers:
`get(→Response)`, `getJson`, `getText`, `getBytes(→Uint8Array)`, `exists(→boolean)`,
`stats(→ResourceStats|undefined)`, `list`. `SessionStorage` adds the writes: `putJson`,
`putText`, `putBytes`, and `delete`. All are `async` and throw `PubkyError`. Use `get()` for the
raw `Response` when you need streaming or headers.

Put / get / delete on your **own** storage (absolute `/pub/...` path):

```js
// Write JSON
await session.storage.putJson("/pub/myapp/profile", profile);

// Read JSON
const profile = await session.storage.getJson("/pub/myapp/profile");

// Delete
await session.storage.delete("/pub/myapp/profile");
```

Read **another** user's public data, unauthenticated, via an addressed path. `userPk` must be the
raw **z32 string** (not a `PublicKey` object — passing the object stringifies to a doubled `pubky`
prefix):

```js
const text = await pubky.publicStorage.getText(
  `pubky://${userPk}/pub/myapp/profile`,
);
```

**Path rules.** `SessionStorage` paths are typed `` `/pub/${string}` `` — TypeScript **rejects**
anything not under `/pub/` at compile time. `PublicStorage` addresses are typed
`` `pubky${string}/pub/${string}` | `pubky://${string}/pub/${string}` ``.

```js
await session.storage.putText("/pub/myapp/data.json", data);

// Invalid paths:
// - "data.json"
// - "/myapp/data.json"
```

0.9.3's `Path` allows **only** `/pub/` — it does **not** include `/priv/`. Private storage is
**planned, not shipped** (writes outside `/pub/` return 403) — honor
[`./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage`](./shipped-vs-planned.md#no-private-encrypted-or-guarded-storage).
The `/pub` layout is not stabilized; for `pubky.app` record schemas, IDs, and path conventions
see [`./app-specs.md`](./app-specs.md).

## Pagination

`list` returns `Promise<string[]>` of `pubky://…` URLs (same shape on both surfaces):

```ts
list(path, cursor = null, reverse = false, limit?, shallow = false): Promise<string[]>
```

- The directory path/address **must end with `/`**.
- `cursor` — a suffix or full URL to start **after** (exclusive); pass the **last returned URL**
  to page forward.
- `reverse` (default `false`) — `true` lists lexicographically-last / newest first.
- `limit` — `u16` cap on entries.
- `shallow` (default `false`) — `true` lists only first-level entries.

```js
const entries = await session.storage.list(
  "/pub/myapp/posts/",
  null,
  false,
  20,
);

for (const url of entries) {
  console.log(url);
}
```

## Metadata: exists and stats

`exists(path)` is a lightweight HEAD (`→ boolean`). `stats(path)` returns
`ResourceStats | undefined` (`undefined` when the resource doesn't exist) without downloading the
body. Both also work on `publicStorage`.

`ResourceStats` fields are **camelCase**, all optional: `{ contentLength?: number, contentType?:
string, lastModifiedMs?: number, etag?: string }`. `contentLength` equals `getBytes(...).length`;
`lastModifiedMs` is Unix epoch **milliseconds**; `etag` is opaque (compare values to detect
updates).

```js
// Check if a resource exists (lightweight HEAD request)
const exists = await session.storage.exists("/pub/myapp/profile");

// Get resource metadata without downloading the body
const stats = await session.storage.stats("/pub/myapp/profile");
if (stats) {
  console.log("Size:", stats.contentLength);
  console.log("Type:", stats.contentType);
  console.log("ETag:", stats.etag);
}

// Also available on public storage
const publicExists = await pubky.publicStorage.exists(
  `pubky://${userPk}/pub/myapp/profile`,
);
```

## Error handling

Every async method throws a structured `PubkyError extends Error` with `name` (machine-readable),
`message` (human-readable), and optional `data` (structured context). The `PubkyErrorName` union
has **six** variants — switch on `error.name`:

```ts
try {
  const text = await session.storage.getText("/pub/myapp/data");
  console.log("Retrieved:", text);
} catch (e) {
  const error = e as import("@synonymdev/pubky").PubkyError;
  switch (error.name) {
    case "RequestError":
      console.error("Network or server error:", error.message);
      break;
    case "InvalidInput":
      console.error("Invalid input:", error.message);
      break;
    case "AuthenticationError":
      console.error("Authentication failed:", error.message);
      break;
    case "PkarrError":
      console.error("PKARR resolution failed:", error.message);
      break;
    case "ClientStateError":
      console.error("Client state error:", error.message);
      break;
    case "InternalError":
      console.error("Internal SDK error:", error.message);
      break;
  }
}
```

For server `RequestError`s, `error.data` carries `{ statusCode: number }` (e.g. 404, 429) — read
it to branch on HTTP status, e.g. backing off on rate limits:

```js
function statusCodeOf(error) {
  const data = error.data;
  if (typeof data !== "object" || data === null || !("statusCode" in data)) {
    return undefined;
  }
  return data.statusCode;
}

async function putWithRetry(session, path, data, retries = 3) {
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

## Public-key string formats

`publicKey.z32()` → raw z-base-32 (use for **hostnames**, DNS `_pubky.<key>` subdomains, HTTP
headers, URL params, DB keys). `publicKey.toString()` → `pubky<z32>` **display** form (logs / UI
only). `PublicKey.from(str)` parses either form. **Don't mix the two** — this distinction is
canonical, see
[`./concepts.md#public-key-string-formats`](./concepts.md#public-key-string-formats).

## Logging

`setLogLevel(level)` bridges Rust `log` output to the browser/Node console. Levels:
`"error" | "warn" | "info" | "debug" | "trace"`. Use `"debug"`/`"trace"` to see PKARR resolution,
network requests, and storage ops.

```js
// Call once at application startup, before creating Pubky or Client instances.
setLogLevel("debug");
```

Call it **once**, before constructing `Pubky` / `Client` — calling it again after the logger is
initialized **throws**.

## Session persistence

In 0.9.3, `session.export()` returns a restorable string that serializes **only the public
`SessionInfo`** — it **contains no secrets** and is meant for `localStorage`. Restore with
`Session.restore(exported, client?)` or `pubky.restoreSession(exported)`; restore reads/writes no
secrets and re-validates against the **browser-managed HTTP-only session cookie**, so it works
only while that cookie is live. (Dev HEAD adds `session.exportSecret()`, which **does** return a
bearer credential for grant sessions — treat *that* like a password — and demotes `export()` to
legacy cookie sessions; **neither change is in 0.9.3** — see the drift note.) Full session/auth
semantics live in [`./auth.md`](./auth.md).

## Escape hatch: `resolvePubky` / raw fetch

`resolvePubky(identifier)` converts a `pubky<pk>/…` or `pubky://<pk>/…` addressed resource into an
HTTPS transport URL of the form `https://_pubky.<z32-key>/<abs-path>` — needed **only** when
feeding a raw HTTP `client.fetch()`. Both addressed forms resolve to the same endpoint. Most apps
use `publicStorage` / `session.storage` and never call this.
