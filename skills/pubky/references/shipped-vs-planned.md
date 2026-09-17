# Shipped vs planned (the production guardrail)

> **CANONICAL.** This file alone decides what is shipped, alpha, or planned in Pubky. `concepts.md`, `sdk-js.md`, `sdk-rust.md`, `nexus-api.md`, `testing-and-testnet.md` and the `pubky-mobile` / `pubky-infra` skills link here. Link to a section; do not restate it.

**Only document what ships.** Never write code, docs or answers that depend on encryption, restore or mirroring: nothing fails at review time, it fails in production. The protocol model (homeserver, PKARR, write/read split, event streams) is canonical in [`concepts.md`](concepts.md).

## The split

| Status | Items | What an app may do |
| :-- | :-- | :-- |
| **Shipped** | Public `/pub` storage · capability-scoped sessions · PKARR identity and homeserver discovery · pubky-app-specs data models · resumable `pubkyauth` flows · homeserver event streams · local Pubky Backup (one-way, `/pub` only) · PostgreSQL-backed homeservers | Depend on it, with exact version pins (see [Everything is v0](#everything-is-v0)) |
| **Alpha, released, NOT for production** | `/priv` private storage (`pubky-homeserver` and SDK ≥ v0.10.0) | Experiment only, with all three caveats in [`/priv`](#priv-private-storage-alpha) |
| **Planned / NOT shipped** | Encrypted data · guarded data or data signing as a *general* primitive · homeserver mirroring · backup **restore** · **cloud** backup · **two-way** backup sync | Treat as non-existent. Never present as available. |

**Code-presence ≠ availability.** A route, symbol or config key upstream is not a supported feature until release notes or docs say so.

## Everything is v0

Every layer is pre-1.0. Pin **exact** versions, put Pubky paths and response shapes behind your own adapters, and read release notes before bumping.

- **Pubky SDK and homeserver: 0.12.0** (workspace `Cargo.toml`; crates.io [`pubky`](https://docs.rs/pubky); npm [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky), published 2026-09-14). **Do not trust semver-minor compatibility.** `RELEASING.md` says 0.x.0 releases are backwards-compatible, yet:
  - **v0.10.0 broke app-facing SDK APIs.** It deprecated cookie auth, introduced grant auth, renamed auth-flow APIs and made capability matching strict. Follow the [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md); current usage is in [`sdk-js.md`](sdk-js.md), [`sdk-rust.md`](sdk-rust.md) and [`auth.md`](auth.md#capabilities).
  - **v0.12.0 broke testnet/Docker interfaces only** (`DockerPostgres::shared`, Docker default build target `homeserver`), not SDK app APIs. See the [v0.12.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.12.0) and [`testing-and-testnet.md`](testing-and-testnet.md).
- **Storage transport addressing is migrating.** Legacy `GET /pub/example.txt` + `pubky-host` header is being replaced by path-addressed `GET /storage/{user-z32}/pub/example.txt` (homeserver v0.11.0, SDK v0.12.0).
  - **Use SDK storage APIs; never hand-build homeserver URLs.** The high-level Rust storage APIs and JS `Client.fetch` check `/info` for `path-addressed-storage` and fall back to legacy addressing when it is absent.
  - The homeserver still accepts legacy addressing, `pubky-host` and cookie auth. Upstream policy: removal comes no earlier than **one year after the first stable path-addressing SDK release**, plus an explicit maintainer review.
  - Upstream is inconsistent: [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md) (at v0.12.0 and on `main`) still lists the first stable path-addressing SDK release as "Not released", even though SDK v0.12.0 ships path addressing. Don't compute a removal date from it.
- **pubky-app-specs is a v0 draft.** crates.io has 0.8.0; npm `pubky-app-specs` `latest` is still 0.7.0, and the README install snippet says `0.7`. Check which version you actually resolve. The README: *"early development phase and is evolving quickly … Consider this a v0 draft."*
  - Paths are unversioned (`/pub/pubky.app/...`). **Stability signal:** they gain a `pubky.app/v1/` prefix once schemas reach LTS. Until then expect schema changes.
  - Data contract: [`app-specs.md`](app-specs.md). Source: [pubky-app-specs](https://github.com/pubky/pubky-app-specs).
- **The Nexus `/v0` REST API is unstable.** README: *"The API is currently **unstable**. We are using the `/v0` route prefix while the API undergoes active development and changes. Expect potential breaking changes."*

  ```js
  // The /v0 segment is required; the global post feed lives at /v0/stream/posts.
  const response = await fetch("https://nexus.pubky.app/v0/stream/posts");
  ```

  *Verified live against nexus.pubky.app on 2026-09-17: 200 with a JSON array of posts; the same path without `/v0` returns 404.*

  - **Don't copy Nexus URLs from docs unchecked.** A knowledge-base snippet still fetches `/v0/feeds/global`, which returned **404** on 2026-09-17; KB CI type-checks snippets but never runs them.
  - Parse responses defensively; don't hardcode shapes.
  - Source of truth: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/) (staging: [nexus.staging.pubky.app/swagger-ui](https://nexus.staging.pubky.app/swagger-ui/)). Endpoints: [`nexus-api.md`](nexus-api.md).
- **The path layout below the roots is not stabilized.** `/pub/` (and, alpha, `/priv/`) are the only roots the homeserver accepts; reads and writes anywhere else get **403**. Below them, paths are app-chosen. The convention of a scope as first segment, an app domain (`/pub/mapky.app/`, `/pub/bitkit.to/`) or a cross-app protocol scope (`/pub/paykit/`), is current practice, not a frozen contract. See [`concepts.md`](concepts.md#addressing-and-the-pub-tree).

## No private, encrypted, or guarded storage

For production, **no** private, encrypted, guarded or signed storage ships. The only private root is the `/priv` alpha below, and it is access control, not encryption.

### `/priv` private storage (alpha)

**Released in `pubky-homeserver` v0.10.0 (2026-08-05, a normal release, not a prerelease). ALPHA, NOT for production, NOT encrypted from the operator.** The v0.10.0 release notes: *"This feature is under active development and should NOT be used in any production environment. Expect private data APIs to change or disappear …"*

Every mention of `/priv` in code, docs or answers must carry all three caveats:

1. **Alpha.** The API may change or be removed. Don't store data you can't lose: Pubky Backup covers `/pub` only, so **`/priv` data has no backup tool**.
2. **Not for production.**
3. **Access-controlled, not encrypted.** *"A homeserver administrator can read and write all tenant data, including data under `/priv/`"*, and the admin event stream can include private events. Never tell a user `/priv` data is hidden from the operator.

| Root | Read | Write |
| :-- | :-- | :-- |
| `/pub/` | Anyone | Owner's session with a write capability |
| `/priv/` | Owner's session with a read capability | Owner's session with a write capability |
| Anything else | 403 | 403 |

Homeserver errors on `/priv`:
- Anonymous read → **401**.
- Wrong tenant, too narrow a capability, or a read not scoped to exactly one user → **403**.

`/priv/` is a separate namespace; existing `/pub/` data is not moved into it. Details: [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md).

**Version boundary.** Homeservers ≤ v0.9.x reject `/priv` writes, and `@synonymdev/pubky` ≤ 0.9.3 types `Path` as `` `/pub/${string}` `` only, so `/priv` code won't type-check. From v0.10.0, SDK and homeserver both accept `/priv`.

Upstream example (**alpha**; the session needs a capability covering `/priv/my-app/`, e.g. `/priv/my-app/:rw`):

```js
const path = "/priv/my-app/settings.json";
await session.storage.putJson(path, { theme: "dark" });
const settings = await session.storage.getJson(path);
```

*Executed against a local testnet with `@synonymdev/pubky` 0.12.0: round-trip succeeded, anonymous read got 401. Fails to type-check on 0.9.3.*

**Gotcha: private events are silently excluded.**
- `GET /events/` returns public events only.
- `GET /events-stream` filters to `/pub/` when you omit `path`.
- A private stream needs: exactly one `user`, equal to the session's own user; the attached `.session(session)`; an explicit `/priv/...` path; and a read capability covering every private path filter. Without `.session()` it fails with 401.

```js
const stream = await pubky
  .eventStreamForUser(user, null)
  .session(session)
  .path("/priv/my-app/")
  .subscribe();
```

*Executed against a local testnet with `@synonymdev/pubky` 0.12.0 (`user` is the session's `PublicKey`): delivered the private `PUT` event. `.session()` does not exist on 0.9.3.*

**Stale sources: don't cite them for `/priv` status.** These predate v0.10.0 and are superseded by the release notes and `PRIVATE_STORAGE.md`:
- KB `homeserver.md` ("only support public, unencrypted data")
- KB FAQ ("Is Pubky suitable for private sharing? Not yet")
- pubky-ai-kit, which lists private storage roots as planned/placeholder

### Still planned

Per the [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/explore/pubky-protocol/security-model.md), none of these ships as a general or production primitive:
- *Guarded data*: access control only; "the homeserver can still read the data". The `/priv` alpha follows this model.
- *Encrypted data*: end-to-end; the homeserver stores ciphertext.
- *Data signing*.

### App-side ciphertext is your own crypto

An app may store ciphertext it produced as opaque bytes. That is the app's cryptography, not a Pubky feature, and the app owns its security:
- **Use a vetted, audited library.** Never hand-roll primitives or constructions.
- **Assume the ciphertext is exposed.** Under `/pub` it is world-readable; under `/priv` the operator can read it.
- **Metadata leaks.** Paths, sizes, write timing and event-stream entries stay visible. Fixed paths are listable.

For a worked example of client-side ciphertext over `/pub` (and its path-listing pitfalls), see [`advanced-messaging-payments.md`](advanced-messaging-payments.md).

## Backup, restore, and mirroring

**Pubky Backup** is the only shipped backup tool: a desktop app (Rust core + Tauri) that keeps a **local, one-way copy** of one or more users' **public `/pub`** data, using homeserver event streams with persisted cursors, local snapshots and activity logs. Source: [pubky-backup](https://github.com/pubky/pubky-backup).

It does **not** back up `/priv`, restore, mirror, cloud-sync or two-way sync. Never tell users that Pubky Backup, or anything else, can:
- **restore** data to a homeserver,
- **mirror** one homeserver to another (KB: "concept only — implementation has not started"),
- do **cloud** backup,
- do **two-way sync**.

The v0.10 grant-auth guide's "the upcoming homeserver mirroring" is a future plan, not a shipped feature.

**Migration (credible exit) is manual.** Sign up on the new homeserver, re-upload the data yourself (e.g. with the SDK), then update the user's PKARR record. No dedicated re-upload tool exists. See [`concepts.md`](concepts.md#trust-model-and-credible-exit).

## Shipped, with rough edges

- **Event streams.** Use them for indexing, backup, sync and watchers; **don't poll or recursively list `/pub` trees** when a stream is available. See [`concepts.md`](concepts.md#homeserver-write-vs-nexus-read).
- **PostgreSQL-backed homeservers.** PostgreSQL holds homeserver metadata (e.g. users, sessions/grants, entries, events, signup codes). **Apps never connect to PostgreSQL; they see only the file API.** See [`concepts.md`](concepts.md#the-homeserver-model).
- **Cookie auth is deprecated and insecure.** Every website in a browser shares the same homeserver cookie and so its permissions ([pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)); it will be removed. Use **grant auth** (v0.10+) for new code. See [`auth.md`](auth.md#session-lifecycle) and [`auth.md`](auth.md#deprecated-cookie-auth).

## Upstream sources of truth

- [pubky-homeserver v0.10.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.10.0) (`/priv` alpha warning, breaking changes) · [v0.12.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.12.0)
- [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md) · [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md) · [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md)
- [docs.rs/pubky](https://docs.rs/pubky)
- Nexus: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/)
- [pubky-app-specs](https://github.com/pubky/pubky-app-specs) (watch for the `pubky.app/v1/` prefix)
- [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/explore/pubky-protocol/security-model.md) (planned guarded/encrypted data, signing, mirroring)
- [pubky-backup](https://github.com/pubky/pubky-backup)
