# JavaScript / WASM client (`@synonymdev/pubky`)

`@synonymdev/pubky` is the official JS/WASM client (auth + data ops over `pubky://`).
This page covers install, client init, sign up / sign in, storage CRUD + pagination, and
JS error idioms. For protocol concepts (identity, `pubky://` addressing, pkarr, the
homeserver model) see [`./concepts.md`](./concepts.md); for the `pubkyauth` flow,
capabilities, signup tokens, and session persistence see [`./auth.md`](./auth.md).

**Upstream (authoritative — summarize, don't mirror):** the maintained API doc is the
package README ([npm](https://www.npmjs.com/package/@synonymdev/pubky) ·
[source](https://github.com/pubky/pubky-core/blob/main/pubky-sdk/bindings/js/pkg/README.md)),
and runnable programs live in
[`pubky-core/examples/javascript`](https://github.com/pubky/pubky-core/tree/main/examples/javascript)
(`0-check-testnet` … `5-request`). When a signature here looks stale, trust the
README/bundled typings for the version you installed.

> **Version:** latest published is **0.9.3**. The in-repo `pkg/package.json` can lag (e.g.
> reads 0.9.0) — prefer the npm 0.9.3 surface for API shape. Pubky is pre-1.0; treat APIs as
> unstable.

## Install and runtime

```bash
npm install @synonymdev/pubky
```

- **Node 20+** (relies on undici `fetch` + WebCrypto); also works in modern browsers. One
  runtime dependency: `fetch-cookie`.
- ESM and CommonJS both work, with TypeScript typings bundled:
  - ESM — `import { Pubky } from "@synonymdev/pubky"`
  - CJS — `const { Pubky } = require("@synonymdev/pubky")`
- **No manual WASM init.** The package bundles and instantiates the WebAssembly module
  before exposing any API, so there is no `init()` / `wasm-pack` step to await. Long-poll
  auth flows only begin relay calls once the module is ready, so approvals aren't missed
  while the bundle loads.

## Initialize the client

```js
import { Pubky } from "@synonymdev/pubky";

const pubky = new Pubky();
```

`new Pubky()` builds the SDK facade wired to the default **mainnet Pkarr relays**.
Construct it **once** and share it across the app (context / prop-drilling) — don't build
one per request, or you re-initialize transports each time.

> **WASM needs relays.** In the browser the SDK can't open raw UDP sockets to the Mainline
> DHT, so it resolves `pubky://` identities through **HTTP Pkarr relays**. `new Pubky()`
> uses mainnet defaults (DHT `requestTimeout` 2000 ms). Override them by building a `Client`
> (imported from the same package) and handing it to `Pubky.withClient()`:

```js
const client = new Client({
  pkarr: {
    relays: ["https://pkarr.pubky.org"],
  },
});

const pubky = Pubky.withClient(client);
```

The config shape is `{ pkarr?: { relays?: string[], requestTimeout?: number } }` (camelCase
in JS). Invalid relay URLs throw `InvalidInput`. For local development use
`Pubky.testnet(...)` — see [`./testing-and-testnet.md`](./testing-and-testnet.md).

## Quick example

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

The second argument to `signup` is the **signup token** (`null` for open/testnet
homeservers; required for gated ones — see [`./auth.md`](./auth.md)).

## Identity and key formats

`Keypair.random()` mints a new identity; `pubky.signer(keypair)` wraps it for auth. Use the
two public-key string forms deliberately (canonical rule in [`./concepts.md`](./concepts.md)
— don't mix them):

- `publicKey.toString()` → `pubky<z32>` — display / UI / logs.
- `publicKey.z32()` → raw z-base-32 — hostnames, headers, URL params, DB keys, addressed
  storage paths.

`PublicKey.from(z32)` parses a raw z32 string back into a key.

## Sign up and sign in

```js
const signer = pubky.signer(keypair);

// Fast: PKDNS refresh happens in the background
const session = await signer.signin();

// Blocking: waits for PKDNS to be discoverable (~3-5s)
// Use this when you need the user's homeserver to be resolvable immediately
const sessionBlocking = await signer.signinBlocking();
```

- `signer.signup(homeserverPk, signupToken)` registers the identity at a homeserver and
  returns a `Session`.
- `signer.signin()` re-authenticates an existing identity. It's **fast** — the PKDNS record
  refresh happens in the background. Use `signer.signinBlocking()` (~3–5 s) when you need
  the homeserver to be resolvable *immediately* after sign-in.
- `session.info.publicKey` is a `PublicKey` (use `.z32()` / `.toString()` as above);
  `session.info.capabilities` is a `string[]` of granted scopes; `session.signout()`
  invalidates the server session.

> **0.9.x drift:** the README/examples call `signer.signin("clientId")` with a client-id
> string, but in 0.9.3 `signin()` takes **no** argument (the code above is correct). That
> argument is stale 0.9.0 surface — not an optional parameter; passing one is a type error.
> Likewise, the shipped persistence and `pubkyauth` entrypoints are `session.export()` /
> `Session.restore()` / `pubky.restoreSession()` and `startAuthFlow` / `resumeAuthFlow`
> (documented in [`./auth.md`](./auth.md)); the README's `exportSecret` and
> `startGrantAuthFlow` names are **not** in the 0.9.3 published surface. Confirm against your
> installed typings.

## Storage operations

Two surfaces share one read API:

- **`session.storage`** — read/write **your own** storage, using **absolute** paths
  (`"/pub/app/file"`).
- **`pubky.publicStorage`** — **read-only** access to **anyone's** public data, using
  **addressed** paths (`pubky<z32>/pub/app/file`, or `pubky://<z32>/...`). No writes.

```js
// PUT
await session.storage.putJson("/pub/myapp/profile", profile);
// GET
const profile = await session.storage.getJson("/pub/myapp/profile");
// DELETE
await session.storage.delete("/pub/myapp/profile");
// LIST (path, cursor, reverse, limit)
const entries = await session.storage.list("/pub/myapp/posts/", null, false, 20);
for (const url of entries) {
  console.log(url);
}
```

`session.storage` methods — writes: `putJson(path, obj)` / `putText(path, str)` /
`putBytes(path, Uint8Array)`; reads: `get(path)` (a streamable `Response`) / `getJson` /
`getText` / `getBytes`; metadata: `exists(path) → boolean` and
`stats(path) → metadata | undefined`; plus `list(...)` and `delete(path)`. `publicStorage`
exposes the read/metadata/`list` methods only — no writes or delete.

Read another user's public data with no auth:

```js
const text = await pubky.publicStorage.getText(
  `pubky://${userPk}/pub/myapp/profile`,
);
```

Lightweight presence / metadata checks (no body download):

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
```

`stats(path)` returns `{ contentLength?, contentType?, etag?, lastModifiedMs? }` — all fields
may be absent, so guard each before use (camelCase at runtime; older README prose shows
snake_case — trust the typings).

**Path rules:** session paths must be absolute and begin with `/pub/` (the TS `Path` type
rejects anything else at compile time). Writing outside `/pub/` returns **HTTP 403**.
Namespace your data under a domain-like scope, e.g. `/pub/your-app/` (for the `pubky.app`
social schema and its ID/path rules see [`./app-specs.md`](./app-specs.md)). Note the `/pub`
layout is **not stabilized**, and `/priv` private storage is **not shipped** — write only
under `/pub`. See [`./shipped-vs-planned.md`](./shipped-vs-planned.md).

## Listing and pagination

`list(path, cursor = null, reverse = false, limit?, shallow = false)` returns a `string[]`
of `pubky://<z32>/...` URLs (always the `pubky://` form, even when you listed an addressed
dir). Directory paths must end with `/`.

- `cursor` accepts a suffix (`<z32>/pub/dir/file`) or a full `pubky://` URL.
- `reverse = true` sorts descending.
- `shallow = true` collapses sub-directories (returns directory entries with a trailing `/`
  plus top-level files).

Page by feeding the last URL of each page back as the next `cursor`, stopping when a page is
shorter than `limit`:

```js
// list(path, cursor, reverse, limit, shallow)
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

Every async method throws a structured **`PubkyError`** (`extends Error`) with `name` (a
`PubkyErrorName`), `message`, and an optional `data` (e.g. `{ statusCode }`). Discriminate on
`error.name`:

```js
try {
  const text = await session.storage.getText("/pub/myapp/data");
  console.log("Retrieved:", text);
} catch (error) {
  // In TypeScript, narrow `error` to PubkyError from "@synonymdev/pubky".
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

The 0.9.3 `name` union is
**`RequestError | InvalidInput | AuthenticationError | PkarrError | ClientStateError | InternalError`**
(the older README lists five and omits `ClientStateError` — confirm against your typings).

Read the HTTP status from `error.data`:

```js
function statusCodeOf(error) {
  const data = error.data;
  if (typeof data !== "object" || data === null || !("statusCode" in data)) {
    return undefined;
  }
  return data.statusCode;
}
```

Common codes: **401** unauthorized (missing/invalid session — e.g. after `signout` — or
wrong user), **403** forbidden (write outside `/pub/`), **404** not found
(`getJson`/`getText`/`getBytes` throw `RequestError` with `statusCode` 404; `exists()`
returns `false`), **429** rate limited. Back off and retry on 429:

```js
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

## Logging and low-level access

```js
import { setLogLevel } from "@synonymdev/pubky";

// Call once at application startup, before creating Pubky or Client instances.
setLogLevel("debug"); // "error" | "warn" | "info" | "debug" | "trace"
```

`setLogLevel` bridges Rust `log` output to the console — call it **once at startup, before**
constructing `Pubky` / `Client` (calling it again after init throws).

Escape hatch for raw requests:
`pubky.client.fetch(url, { method, headers, body, credentials: "include" })` issues a request
through the Pubky HTTP client (`credentials: "include"` sends the session cookie).
`resolvePubky(identifier)` converts an addressed `pubky<z32>/pub/...` into its transport URL
`https://_pubky.<z32>/pub/...`. Prefer `session.storage` / `publicStorage` for normal use.
