# Reference apps & patterns

Three live, open-source apps show how real code is structured on Pubky. Each sits at a different
point on the architecture spectrum — pick the one whose shape matches what you're building and copy
*its* patterns:

| App | What it is | Architecture | Repo / live |
| :-- | :-- | :-- | :-- |
| **pubky.app** | Flagship social web app (publisher + feed) on Pubky Core + Nexus | Custom backend (Nexus aggregator) | [pubky-app](https://github.com/pubky/pubky-app) · <https://pubky.app> |
| **Pubky Explorer** | Read-only public-data browser ("enter a Pubky, browse `/pub`") | Client↔homeserver (direct, unauthenticated reads) | [pubky-explorer](https://github.com/pubky/pubky-explorer) · <https://explorer.pubky.app> |
| **workshop** | Teaching CLI ("De cero a Pubky") — init → connect → auth → read/write | Client↔homeserver (direct, authenticated) | [workshop](https://github.com/pubky/workshop) |

All three are *applications*, not part of Pubky Core. The homeserver-write vs Nexus-read split,
`pubky://` addressing, and public-key string formats they rely on are canonical in
[`./concepts.md`](./concepts.md) — this file links there rather than restating them.

> **These apps lag the current SDK — treat their API surface as version-pinned, not current.**
> pubky.app pins `@synonymdev/pubky` 0.8.0 / `pubky-app-specs` 0.4.4; Explorer and workshop are
> on `@synonymdev/pubky` 0.6.0. The latest published packages are **0.9.3** / **0.5.3**
> (npm, verified 2026-06-29). When you copy a call from these repos, verify it against the
> version you installed — [`./sdk-js.md`](./sdk-js.md) documents the shipped 0.9.3 surface and
> flags where 0.6.0/0.8.0 names differ.

## App architectures: which reference to copy

The knowledge base describes a spectrum (see [`./concepts.md`](./concepts.md) for the underlying
write/read split):

- **Client↔homeserver (direct)** — the client talks straight to one homeserver, lowest
  latency/complexity. Best for bookmarks, file-sync, pastebin-style apps. **Pubky Explorer**
  (public reads) and **workshop** (authenticated read/write) exemplify this.
- **Global aggregators** — one aggregator consumes event streams from many homeservers and serves
  clients a unified feed; clients can switch aggregators.
- **Custom backend** — middleware *Indexer* (normalization) + *Aggregator* (event filtering)
  between client and homeservers. **Pubky Nexus** is the production implementation (Neo4j graph +
  Redis cache + REST API) and powers pubky.app's social features. Query it via
  [`./nexus-api.md`](./nexus-api.md).

## pubky.app structure

The primary reference for building on the Pubky SDK (auth + data storage) combined with **Nexus**
(aggregation/indexing). A Next.js PWA; not part of Pubky Core — it sits in the Pubky social-app
stack alongside Nexus.

**Tech stack** (per KB docs): Next.js 16 / React 19 / TypeScript; Tailwind 4 / Shadcn / Radix;
**Zustand** (global UI state); **Dexie** (IndexedDB wrapper, local-first persistence); **TanStack
Query** (data fetching/caching); `@synonymdev/pubky` (WASM SDK for homeserver comms);
`pubky-app-specs` (shared data contract — canonical in [`./app-specs.md`](./app-specs.md)). Offline-
capable PWA via a Serwist (`@serwist/next`) service worker.

**Data flow** (the concrete instance of the canonical homeserver-write vs Nexus-read split — see
[`./concepts.md`](./concepts.md)):

1. Writes go to the user's **homeserver** via the SDK.
2. **Nexus** polls each homeserver for changes via the `/events/` endpoint.
3. Nexus indexes/aggregates.
4. Reads come from **Nexus** for performance.
5. A local **Dexie** cache provides offline access.

All social data lives under **`/pub/pubky.app/`** following the `pubky-app-specs` schema (paths/IDs:
[`./app-specs.md`](./app-specs.md)).

## pubky.app: layered core architecture

Everything domain-related lives in `src/core/` as a strict layering. **UI** (user actions) and
**Coordinators** (system events) are the only entry points; both flow down:

```
UI / Coordinators
  -> Controllers   (mutate Zustand Stores; call Pipes for pure transforms)
    -> Application (orchestrate; call Pipes; call other Applications, max depth 1)
      -> Services  (homeserver = network WRITES; nexus = network READS; local = Dexie only)
        -> Models  (Dexie / Database)
```

**Hard constraints** (enforced by review, not the compiler — the layers are static classes with no
DI, per ADR-0009):

- Controllers **never** call Services directly — go through Application.
- Coordinators **never** call Application — go through Controllers.
- Application **never** touches Stores — only Controllers manage stores.
- **Pipes are pure** — no IO, no side effects.
- Only `PostApplication`, `NotificationApplication`, `BootstrapApplication`, `HotApplication`,
  `PostStreamApplication`, `TtlApplication` may call other Applications (max depth 1, no cycles).

**Other conventions:**

- QR-code auth via **Pubky Ring**; offline-first PWA (Serwist SW + a local-file cache, ADR-0016).
- `subscribe*` methods are long-lived homeserver **event-stream** subscriptions (ADR-0014) — e.g.
  `MuteListSyncCoordinator` subscribes the stream for `/pub/pubky.app/mutes/`. (Event streams are
  canonical in [`./concepts.md`](./concepts.md).)
- **Zod v4** — use `z.url()`, not `z.string().url()`.
- Import via tsconfig path aliases (`@/controllers/*`, `@/services/*`, …) to **concrete modules**,
  not aggregate re-export index files.
- Data-model tables live in `src/core/database/franky/franky.ts` (`user_details`, `post_details`,
  `post_streams`, `bookmarks`, `notifications`, …).

## pubky.app: local-first data flow

The load-bearing pattern (ADR-0001). This is an **app-level** architecture choice, not a Pubky
protocol feature. Every write follows:

1. Write to IndexedDB (Dexie) **first**.
2. Update UI immediately (optimistic).
3. Sync to the homeserver in the background.
4. Reconcile conflicts asynchronously (periodic retries / explicit repair). Rollback/compensation
   is optional — only when strict consistency is required.

Net effect: the UI reflects local state instantly, with eventual consistency to homeserver + Nexus.

**Controller method names encode IO behavior + delivery guarantees.** This naming convention is a
decision table for any code touching `src/core`:

| Prefix | Meaning |
| :-- | :-- |
| `fetch*` | Nexus network only, no cache |
| `get*` | IndexedDB local only |
| `getMany*` | Bulk local reads → `Map<Pubky, T>` |
| `getOrFetch*` | Local first, network fallback |
| `getMany*OrFetch` | Bulk local first, fetch missing |
| `subscribe*` | Long-lived live stream subscription (e.g. homeserver event streams), not one-shot |
| `commitCreate*` / `commitUpdate*` / `commitDelete*` | Optimistic local write + background homeserver sync |

The commit flow, distilled from `src/core/application/post/post.ts` (a Controller normalizes input
via Pipes, then the Application writes Dexie *then* syncs the homeserver):

```js
// Application layer: local-first persistence then homeserver sync
class PostApplication {
  static async commitCreate({ postUrl, compositePostId, post, fileAttachments, tags }) {
    // 1. Upload files first (dependency)
    if (fileAttachments?.length > 0) await FileApplication.commitCreate({ fileAttachments });
    // 2. Write to IndexedDB (Dexie) — UI reads this immediately
    await LocalPostService.create({ compositePostId, post });
    // 3. Sync to homeserver (network write)
    await HomeserverService.request({ method: HttpMethod.PUT, url: postUrl, bodyJson: post.toJson() });
    // 4. Create tags
    if (tags?.length > 0) await TagApplication.commitCreate({ tagList: tags });
  }
}
```

<sub>Source: [`pubky-app/docs/local-first.md`](https://github.com/pubky/pubky-app/blob/57d41baa6dae/docs/local-first.md) · app-internal pseudo-code, not standalone-runnable.</sub>

**Persistence order rule:** persist dependencies before dependents (author → post → tags), or
foreign-key/join integrity breaks — e.g. `LocalUserService.upsertDetails(author)` **before**
`LocalPostService.create(post)` **before** `LocalPostTagService.create(...)`.

**`useLiveQuery` rule (ADR-0011):** Dexie's `useLiveQuery` is for **local reads only** — never call
TanStack Query or any network code inside it (it breaks Dexie's Promise-Specific Data). The
canonical pattern is *fetch in `useEffect`, read in `useLiveQuery`*:

```js
// Pattern: fetch in useEffect, read in useLiveQuery (src/hooks/usePostDetails)
function usePostDetails(compositeId) {
  useEffect(() => {
    if (!compositeId) return;
    PostController.getOrFetchDetails({ compositeId })
      .catch((error) => Logger.error('[usePostDetails] fetch failed:', { compositeId, error }));
  }, [compositeId]);

  const postDetails = useLiveQuery(
    async () => (compositeId ? PostController.getDetails({ compositeId }) : null),
    [compositeId],
    undefined,
  );
  return { postDetails, isLoading: postDetails === undefined };
}
```

<sub>Source: [`pubky-app/docs/local-first.md`](https://github.com/pubky/pubky-app/blob/57d41baa6dae/docs/local-first.md) · app-internal hook, not standalone-runnable.</sub>

## pubky.app: caching, IDs, and pipes

- **Composite post IDs (ADR-0002):** posts are keyed `author:postId` (plain string, delimiter `:`,
  no branded type), e.g. `pk1abc123xyz:0000000123`. Helpers: `buildCompositeId({pubky, id})`,
  `parseCompositeId(id) → {pubky, id}`, `buildCompositeIdFromPubkyUri({uri, domain})`. Rationale:
  globally unique, stable for Dexie-table joins, collision-proof across migrations, retains
  chronological order.
- **Streams as caches (ADR-0003):** cached sequences are stored in Dexie keyed by a stream id (enum
  like `'all:latest:all'`) holding an ordered array of composite IDs / pubkeys / hot-tags.
- **TTL management (ADR-0005):** each entity carries `lastUpdatedAt`; staleness =
  `now - lastUpdatedAt > ttlMs`. Defaults: `NEXT_PUBLIC_TTL_POST_MS=300_000` (5 min),
  `NEXT_PUBLIC_TTL_USER_MS=600_000` (10 min), `NEXT_PUBLIC_TTL_BATCH_INTERVAL_MS=5_000`. Local
  services update the TTL automatically on write — **forgetting the TTL update = a stale cache that
  never refreshes.**
- **Pipes (ADR-0006)** are pure functions that normalize/validate external shapes into domain shapes
  by enforcing `pubky-app-specs` through a builder: `PubkySpecsSingleton.get(pubky)` →
  `builder.createPost(...)` / `builder.createProfile(...)` / `builder.editPost(...)`. Results carry
  `{ post|user, meta }` where `meta.url` / `meta.path` is the homeserver target. **Pipes never do
  IO; never return un-normalized data straight from the homeserver.** The `pubky-app-specs` contract
  itself is canonical in [`./app-specs.md`](./app-specs.md) — the same builder→`meta.path`→`putJson`
  idiom appears in [React integration patterns](#react-integration-patterns) below.

## pubky.app: error handling

**Every layer in `src/core` uses `AppError` via `Err.*` factories — never raw `Error`, never plain
strings (ADR-0015).** The taxonomy is three-axis:

- **Category (WHAT):** `Network`, `Timeout`, `Server`, `Client`, `Auth`, `RateLimit`, `Validation`,
  `Database`.
- **Code (WHICH):** `WRITE_FAILED`, `NOT_FOUND`, `UNAUTHORIZED`, `SESSION_EXPIRED`, …
- **Service (WHERE):** `Nexus`, `Homeserver`, `Homegate`, `Local`, …

`Err.*` factories **log automatically** (`src/libs/error/error.factories.ts`) — do **not**
`Logger.error(...)` and then `throw Err.*` (double-log).

**Decision helpers drive retry/UX deterministically:** `isRetryable(error)` → true for
`Network`/`Timeout`/`Server`/`RateLimit`; `requiresLogin(error)` → true for `Auth` +
`UNAUTHORIZED`/`SESSION_EXPIRED`; `isNotFound(error)` → `NOT_FOUND`/`RECORD_NOT_FOUND`;
`hasHttpStatus(error, code)`; `getRetryAfter(error)`. Normalize with `toAppError(error, service,
operation)`; render with `getErrorMessage(error)`.

**Re-throw discipline:** caught `AppError` → re-throw unchanged (`throw error`); caught unknown →
normalize once with `toAppError` then throw. Remote services use `safeFetch` + `httpResponseToError`;
the TanStack `QueryClient` reads `error.context.statusCode` for retry decisions (Network/Timeout/
Server/RateLimit retryable; Client/Auth/Validation/Database not).

**UI layer:** catch `AppError`, route `requiresLogin(error)` to `/login`, otherwise toast. Toast
variants are `default | error | warning | info` — no `showErrorToast` wrappers:

```js
try {
  await PostController.commitCreate({ authorId, content, isArticle, tags, attachments });
} catch (error) {
  if (error instanceof AppError) {
    if (requiresLogin(error)) { router.push('/login'); return; }
    toast({ variant: 'error', description: getErrorMessage(error) });
  }
}
```

<sub>Source: [`pubky-app/docs/error-handling.md`](https://github.com/pubky/pubky-app/blob/57d41baa6dae/docs/error-handling.md) · app-internal pattern, not standalone-runnable.</sub>

## Pubky Explorer: read-only public-data browser

Enter a Pubky, browse the public data under any user's homeserver via `pubky://` links. Built with
**Solid.js + Vite** (not React/Next), deps `@synonymdev/pubky ^0.6.0` and `solid-js ^1.9.11`. The
canonical **client↔homeserver direct** example: pure unauthenticated public reads via the SDK's
`publicStorage` — no signup, no session, no Nexus.

**Minimal read-only client** — pick testnet vs mainnet from an env flag, then read everything via
`pubky.publicStorage` (no signer/session anywhere):

```js
import { Pubky } from "@synonymdev/pubky";
import type { Address } from "@synonymdev/pubky";

export const pubky =
  import.meta.env.VITE_TESTNET === "true" ? Pubky.testnet() : new Pubky();
const publicStorage = pubky.publicStorage;
```

<sub>Source: [`pubky-explorer/src/state.ts`](https://github.com/pubky/pubky-explorer/blob/aa04d4914350/src/state.ts) · testnet vs mainnet: [`./testing-and-testnet.md`](./testing-and-testnet.md) · executed against a local testnet (0.9.3): `Pubky.testnet()` + `publicStorage` resolve and operate.</sub>

**Directory listing** uses `publicStorage.list(address, cursor, reverse, limit, shallow)` — the same
5-arg surface documented in [`./sdk-js.md`](./sdk-js.md) (`list(path, cursor=null, reverse=false,
limit?, shallow=false)`). It builds the address as a `pubky://` URL, passes `reverse=false` plus the
app's `shallow` toggle, and paginates by feeding the **last returned item's `.link`** back as the
next cursor.

**File fetch + content-type sniffing** demonstrates that homeserver entries are **opaque MIME-typed
blobs**: call `publicStorage.get(address)` (a streamable `Response`), check `res.ok`, read the
`content-type` header, and branch on the MIME — images by `image/*`, text by
`text/*`/`json`/`xml`, and for `application/octet-stream`/empty, attempt `JSON.parse` (after
stripping a BOM) before falling back to binary:

```js
const res = await publicStorage.get(toAddress(link));
if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
const mime = (res.headers.get("content-type") || "").toLowerCase();
if (mime.startsWith("image/")) { /* URL.createObjectURL(await res.blob()) */ }
else if (mime.startsWith("text/") || mime.includes("application/json") || mime.includes("application/xml")) {
  const text = await res.text();
} else if (mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "") {
  const text = (await (await res.blob()).text()).replace(/^﻿/, "").trim();
  try { JSON.parse(text); /* render as JSON */ } catch { /* binary */ }
}
```

<sub>Source: [`pubky-explorer/src/state.ts`](https://github.com/pubky/pubky-explorer/blob/aa04d4914350/src/state.ts) · `get()` + the text/json branch executed against a local testnet (0.9.3); the octet-stream BOM-strip/JSON-fallback and `!res.ok` throw were unit-asserted with synthetic Responses.</sub>

**Error normalization for public reads** keys on the `PubkyError` shape (cross-confirms the taxonomy
in [`./sdk-js.md`](./sdk-js.md)):

```js
function normalizeError(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") {
    if (e.toLowerCase().includes("error sending request")) return "Network error or PK not found";
    return e;
  }
  const name = e?.name;
  const statusCode = e?.data && typeof e.data === "object" && "statusCode" in e.data ? e.data.statusCode : undefined;
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

<sub>Source: [`pubky-explorer/src/state.ts`](https://github.com/pubky/pubky-explorer/blob/aa04d4914350/src/state.ts) · pure function, executed verbatim with all branches asserted (error names `RequestError`/`InvalidInput` match `PubkyErrorName` in 0.9.3).</sub>

**Read-side robustness patterns:**

- **Request-id guard** — increment `currentRequestId` per request and discard responses whose
  `reqId !== currentRequestId` (stale-response protection on rapid navigation); plus an `isFetching`
  dedupe flag.
- **Stale-while-revalidate** via a `sessionStorage` LRU cache (`CACHE_NS = 'pkx-cache-v1'`,
  `CACHE_MAX = 40`) keyed by `dir + shallow + sortOrder`: restore the cached list instantly, then
  `backgroundRevalidate`.
- **Prefetch** the first page on hover/focus/keyboard-highlight of a directory (`prefetchDir`,
  guarded by a `prefetchInFlight` set).
- **Infinite scroll** — `IntersectionObserver` → `loadMore`.

<sub>Source: [`pubky-explorer/src/state.ts`](https://github.com/pubky/pubky-explorer/blob/aa04d4914350/src/state.ts) (request-id guard, dedupe, SWR cache, prefetch, and `loadMore`) · [`src/Explorer.tsx`](https://github.com/pubky/pubky-explorer/blob/aa04d4914350/src/Explorer.tsx) (the `IntersectionObserver` → `loadMore` wiring).</sub>

**Input normalization** for pubky addresses (concrete handling of the display-vs-raw key distinction
whose rule is canonical in [`./concepts.md`](./concepts.md)): strip `pubky://`/`pubky:/`/`pk:`
prefixes and a leading `pubky` before a 52-char z32 key; a bare 52-char key (`/^[a-z0-9]{52}$/i`)
defaults to `<key>/pub/`; directory paths always end with `/`; display re-adds the `pubky` prefix via
`formatDisplayPath`.

## Workshop: the end-to-end newcomer flow

A live, Spanish-language teaching CLI ("De cero a Pubky") using `@synonymdev/pubky` 0.6.0 (Node 20+;
README says 22+). The canonical newcomer path: **init project → connect to a homeserver →
authenticate with an invite code → build a tiny app that reads/writes user data**, then verify writes
via PKDNS Digger and Pubky Explorer.

**The full flow** (`workshop.mjs`):

1. Optional `setLogLevel`.
2. `new Pubky()` facade.
3. Recovery file: restore `Keypair.fromRecoveryFile(bytes, passphrase)` if a file exists, else
   `Keypair.random()` + `keypair.createRecoveryFile(passphrase)`, then persist.
4. `signer = pubky.signer(keypair)`.
5. Check for an existing homeserver via `signer.pkdns.getHomeserver()`.
6. **Signup only if none:** `signer.signup(homeserver, inviteCode || null)` (publishes the `_pubky`
   PKARR record).
7. **Signin** via `signer.signinBlocking()` (PKDNS lookup + `/session` exchange).
8. Write own data: `session.storage.putJson('/pub/...')`.
9. Read it back publicly: `pubky.publicStorage.getJson(address)`.
10. Read another user's resource: `pubky.publicStorage.getText(resource)`.

`DEFAULT_WRITE_PATH = '/pub/pubky-workshop/hello.json'`.

```js
import { Pubky, Keypair, PublicKey } from "@synonymdev/pubky";

const pubky = new Pubky();
// restore or create identity from an encrypted recovery file
let keypair = hasRecovery
  ? Keypair.fromRecoveryFile(recoveryBytes, passphrase)
  : Keypair.random();
if (!hasRecovery) await writeFile(recoveryPath, keypair.createRecoveryFile(passphrase));

const signer = pubky.signer(keypair);
const existing = await signer.pkdns.getHomeserver();          // already published?
if (!existing) {
  const homeserver = PublicKey.from(homeserverString);
  await signer.signup(homeserver, inviteCode || null);        // publishes _pubky PKARR record
}
const session = await signer.signinBlocking();                // PKDNS lookup + /session
// write own data, then read it back publicly
await session.storage.putJson("/pub/pubky-workshop/hello.json", payload);
const selfAddress = `${session.info.publicKey.toString()}/pub/pubky-workshop/hello.json`;
const roundtrip = await pubky.publicStorage.getJson(selfAddress);
// read another user's public data (no session needed)
const otherText = await pubky.publicStorage.getText("pubky<z32>/pub/app/file.txt");
```

<sub>Source: [`workshop/workshop.mjs`](https://github.com/pubky/workshop/blob/b952363b519a/workshop.mjs) · full flow executed end-to-end against a local testnet: recovery-file roundtrip → `getHomeserver()` → `signup` → `signinBlocking` → `putJson` → `getJson`/`getText` roundtrip. These 0.6.0-era names still exist and work under pinned 0.9.3.</sub>

> **0.6.0 surface — verify before reusing.** `signer.pkdns.getHomeserver()` and the recovery-file
> method names (`keypair.createRecoveryFile` / `Keypair.fromRecoveryFile`) are 0.6.0 shapes and may
> differ from the current 0.9.3 surface; [`./concepts.md`](./concepts.md) uses
> `pubky.getHomeserverOf(publicKey)`. Recovery files, sessions, and the `pubkyauth` flow are canonical
> in [`./auth.md`](./auth.md).

**Session shape** (consistent across the SDK): `session.info.publicKey` is a `PublicKey` — use
`.toString()` for the `pubky<z32>` display form and `.z32()` for the raw transport form;
`session.info.capabilities` holds the granted capability scopes. Public-read addresses are built as
`${publicKey.toString()}/pub/...` (display form concatenated with the path).

**Verify your writes** with the inspection URLs the docs point at — PKDNS Digger (which homeserver a
Pubky resolves to) and the Explorer (browse `/pub`). The Explorer reads its target from the URL hash
`#p=` (falling back to `?p=`):

```js
export function pkdnsUrl(publicKeyZ32) {
  return `https://pkdns.net/?id=${publicKeyZ32}`;
}
export function explorerUrl(pubkyOrResource) {
  return `https://explorer.pubky.app/#p=${encodeURIComponent(pubkyOrResource)}`;
}
```

<sub>Source: [`workshop/utils.mjs`](https://github.com/pubky/workshop/blob/b952363b519a/utils.mjs) · pure URL builders, executed and asserted (the single-arg `explorerUrl` equals `utils.mjs`'s no-path default).</sub>

## React integration patterns

> **Executed against a local testnet (0.9.3), but sourced from `pubky-ai-kit` migration notes — not
> a type-checked CI snippet.** Every Pubky/specs call below was run end-to-end on the shared testnet:
> `pubky.signer(keypair).signin()`, `session.export()`, `pubky.restoreSession(...)`,
> `new PubkySpecsBuilder(z32)`, `session.signout()`, and `specs.createPost(...)` →
> `session.storage.putJson(meta.path, ...)`. The surrounding React shell (`useState`/`useEffect`/JSX)
> is standard plumbing and was not rendered. **One compile-time gotcha:** `pubky-app-specs` 0.5.3
> types `meta.path` as `string`, while `SessionStorage.putJson` expects a branded `Path`
> (`/pub/${string}`) in 0.9.3 — runtime-correct (the value is a real `/pub/pubky.app/posts/...`),
> but under strict TS you may need a cast. Confirm names against your installed `@synonymdev/pubky`
> typings.

A `PubkyProvider` context: restore an exported session on mount, persist via `session.export()` to
`localStorage`, sign in with `pubky.signer(keypair).signin()`, sign out with `session.signout()`, and
rebuild a `PubkySpecsBuilder(session.info.publicKey.z32())` whenever the session changes (note: the
builder takes the **raw z32** form):

```jsx
// React provider (verify API names against your installed @synonymdev/pubky)
export function PubkyProvider({ children }) {
  const [pubky] = useState(() => Pubky.testnet());
  const [session, setSession] = useState(null);
  const [specs, setSpecs] = useState(null);

  useEffect(() => {            // restore exported session on mount
    const exported = localStorage.getItem(SESSION_KEY);
    if (!exported) return;
    pubky.restoreSession(exported).then(setSession)
      .catch(() => localStorage.removeItem(SESSION_KEY));
  }, [pubky]);

  useEffect(() => {            // rebuild specs builder on session change
    setSpecs(session ? new PubkySpecsBuilder(session.info.publicKey.z32()) : null);
  }, [session]);

  async function signIn(keypair) {
    const next = await pubky.signer(keypair).signin();
    localStorage.setItem(SESSION_KEY, next.export());
    setSession(next);
  }
  async function signOut() {
    if (!session) return;
    await session.signout();
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }
  /* provide { pubky, session, specs, signIn, signOut, isSignedIn } */
}
```

<sub>Source: [`pubky-ai-kit/pubky-dev-context.md`](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md) · SDK calls executed against a local testnet (0.9.3); React shell not rendered.</sub>

A `usePubkySpecs(pubkyId)` hook lazily builds the specs builder, and a form writes via the
builder→`meta.path`→`storage.putJson` idiom (the same Pipes pattern pubky.app uses — see
[`./app-specs.md`](./app-specs.md)):

```jsx
function usePubkySpecs(pubkyId) {
  const [specs, setSpecs] = useState(null);
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    if (!pubkyId) return;
    setSpecs(new PubkySpecsBuilder(pubkyId));
    setIsReady(true);
  }, [pubkyId]);
  return { specs, isReady };
}
// in submit handler:
const postResult = specs.createPost(content, PubkyAppPostKind.Short);
await session.storage.putJson(postResult.meta.path, postResult.post.toJson());
```

<sub>Source: [`pubky-ai-kit/pubky-dev-context.md`](https://github.com/pubky/pubky-ai-kit/blob/5654d0d27218/pubky-dev-context.md) · `createPost` → `putJson(meta.path)` → `getJson` round-trip executed against a local testnet (0.9.3); React shell not rendered.</sub>

## Upstream references

- **pubky.app** — repo [pubky/pubky-app](https://github.com/pubky/pubky-app) (`docs/architecture.md`,
  `docs/local-first.md`, `docs/data-patterns.md`, `docs/error-handling.md`, `AGENTS.md`) · live
  <https://pubky.app>
- **Pubky Explorer** — repo [pubky/pubky-explorer](https://github.com/pubky/pubky-explorer) · live
  <https://explorer.pubky.app>
- **workshop** — repo [pubky/workshop](https://github.com/pubky/workshop)
- **App architectures** — knowledge base `explore/pubky-apps/*`
- **Inspection tools** — PKDNS Digger <https://pkdns.net> · Pubky Explorer <https://explorer.pubky.app>
