# Shipped vs planned (the production guardrail)

> **CANONICAL.** Single source of truth for this material. `concepts.md`, `sdk-js.md`,
> `nexus-api.md`, `testing-and-testnet.md`, and the `pubky-mobile` / `pubky-infra` skills all
> link here — never copy.

**Only document what ships.** Pubky is pre-1.0 and deliberately reserves room for features that
do not exist yet. Presenting a planned item as available is the most damaging mistake here: the
failure is silent — code that assumes `/priv`, encryption, or restore passes review and breaks
in production.

For the protocol model itself (homeserver, PKARR, Nexus read/write split, event streams,
PostgreSQL metadata) see [`concepts.md`](concepts.md) — that is canonical there; this file
only owns the shipped-vs-planned line.

## The split: shipped vs planned

| Shipped — safe to document as available | Planned / NOT shipped — never present as available |
| :-- | :-- |
| Public `/pub` storage (unauthenticated `GET`/`HEAD`, capability-gated `PUT`/`DELETE`) | `/priv` storage — **implemented & tested in `main`, not in the latest release** (a released homeserver `403`s non-`/pub` writes); access-controlled, *not* encrypted |
| Capability-scoped sessions | Encrypted data / guarded (access-controlled) storage as a general app primitive |
| PKARR identity & homeserver discovery | Homeserver-to-homeserver **mirroring** |
| pubky-app-specs data models | Backup **restore** (writing a backup back to a homeserver) |
| Resumable `pubkyauth` flows | **Cloud** backup |
| Homeserver event streams (`/events-stream`, `/events/`) | **Two-way** backup sync |
| Local **Pubky Backup** (one-way, local snapshots) | |
| PostgreSQL-backed homeservers (server metadata only) | |

The shipped column is the only thing an app may depend on. Treat anything in the right column
as non-existent when writing code.

## Everything is v0

Every layer is pre-1.0 and changes without long-term compatibility guarantees. Do not hardcode
shapes, paths, or API surfaces; isolate them behind your own adapters and pin versions.

- **Pubky SDK / Pubky Homeserver — 0.x.** The Rust workspace and the JS package
  ([`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky)) are both still in the
  `0.9.x` range. The churn is real, not theoretical: the v0.9 → v0.10 migration **renamed core
  auth APIs** (e.g. `PubkyAuthFlow` → `PubkyCookieAuthFlow`, `startAuthFlow` →
  `startCookieAuthFlow`, added `-Cookie` / `_cookie` variants of signup/signin) and **tightened
  capability path matching so a trailing slash is now significant**. SDK-specific detail belongs
  in [`sdk-rust.md`](sdk-rust.md) / [`sdk-js.md`](sdk-js.md); see the upstream
  [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md)
  for proof of the breakage. **Stable signal:** a 1.0 release.
- **pubky-app-specs — v0.x draft (currently `0.5.x`).** The README states it plainly: *"this
  specification is in an early development phase and is evolving quickly … Consider this a v0
  draft."* Paths are currently unversioned (`/pub/pubky.app/...`). **Stable signal:** the README
  promises a `pubky.app/v1/` path prefix once schemas reach LTS — until you see that prefix,
  assume schemas can change. Data-contract detail is canonical in [`app-specs.md`](app-specs.md);
  the [specs README + `src/` Rust models](https://github.com/pubky/pubky-app-specs) are the
  maintained source (the Rust models are authoritative over the README).
- **Nexus `/v0` REST API — unstable.** The README warns: *"The API is currently unstable. We are
  using the `/v0` route prefix while the API undergoes active development … Expect potential
  breaking changes."* The `/v0` segment is load-bearing on the live hosted endpoint:

  ```js
  // The /v0 segment is required; the global post feed lives at /v0/stream/posts.
  const response = await fetch("https://nexus.pubky.app/v0/stream/posts");
  ```

  Treat every Nexus response defensively; do not hardcode its shapes. The Swagger UI is the
  source of truth — [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/) (staging:
  [nexus.staging.pubky.app/swagger-ui](https://nexus.staging.pubky.app/swagger-ui/)). Endpoint
  detail is canonical in [`nexus-api.md`](nexus-api.md).
- **The `/pub` path layout is not stabilized.** `/pub` is the only protocol-required top-level
  directory; the scope conventions beneath it (first segment = app-domain or protocol scope) are
  *current practice, not a frozen contract*. See [`concepts.md`](concepts.md#addressing-and-the-pub-tree).

## No private, encrypted, or guarded storage

The **latest release** serves only public, unencrypted data under `/pub`. `/priv` has since
**landed in `main`**, so state its status precisely — it is real code, but not yet available to
release users:

- **`/priv` is implemented and tested in `main`, not a placeholder.** `pubky-homeserver` defines
  `PRIVATE_ROOT = "/priv/"` and enforces it in `authorization.rs` (401 anonymous read, 403
  wrong-tenant / under-scoped), with unit tests. It is a real storage root there.
- **…but it is not in the latest release.** The published SDK types paths as `/pub/…` only, so a
  release client cannot even form a `/priv` path, and a released homeserver `403`s non-`/pub`
  writes. **Do not build on `/priv` from released code** — pin to `main` if you need it, and always
  carry an "unreleased" caveat.
- **`/priv` is access-controlled, *not* encrypted.** Even where enforced it is gated by session
  capability, not cryptography — a trusted operator can still read, tamper with, or deny-serve the
  data. Encrypted / confidential storage as a general app primitive is **still planned, not
  shipped**; the confidentiality mitigation today is **credible exit** (identity follows the keys,
  not the server). Never tell a user their `/priv` data is private or encrypted from the operator.

(Apps may of course store their own ciphertext as opaque bytes under `/pub` — but that is the
app's own crypto, not a Pubky-provided primitive, and the blob is still publicly readable.)

## Backup, restore, and mirroring

**Pubky Backup** is the one shipped backup tool: a desktop app (Rust core + Tauri frontend) that
keeps a **local, one-way copy** of one or more users' public `/pub` data. It consumes homeserver
event streams with persisted cursors to keep local files current, and provides local snapshots
and activity logs. That is the entire shipped scope.

Do **not** tell users Pubky Backup (or anything else) can today:

- **restore** data back to a homeserver,
- **mirror** one homeserver to another,
- perform **cloud** backup, or
- do **two-way sync**.

All four are roadmap / open-work, not shipped. Consequently **credible exit is manual**: to
migrate, a user signs up on a new homeserver, **re-uploads their data by hand**, then repoints
their PKARR record (the moment the record moves, the old homeserver loses authority). Automated
homeserver-to-homeserver mirroring and restore are planned, not current behavior. See
[`concepts.md`](concepts.md#the-homeserver-model) for the credible-exit model.

## Shipped, with rough edges

Safe to use today, but carry caveats an agent must respect. Mechanics are canonical elsewhere —
link, don't restate:

- **Event streams — shipped.** Homeservers emit `PUT`/`DEL` events that subscribers consume from
  a persisted cursor (Pubky Backup and Nexus both do). **Do not poll or recursively list `/pub`
  when an event stream is available.** Mechanics: [`concepts.md`](concepts.md#homeserver-write-vs-nexus-read).
- **PostgreSQL-backed homeservers — shipped.** PostgreSQL holds homeserver metadata only; user
  file content lives in a separate filesystem under `/pub/`. **Apps never connect to PostgreSQL —
  they see only the file API.** Detail: [`concepts.md`](concepts.md#the-homeserver-model).
- **Single session cookie — known limitation ([pubky-homeserver#122](https://github.com/pubky/pubky-homeserver/issues/122)).**
  All sessions share one auth cookie, so signing into App B **overwrites** App A's session; a
  JWT-based rework is in progress. Detail: [`auth.md`](auth.md), [`concepts.md`](concepts.md#stability-and-known-limits).

## Upstream sources of truth

Link these instead of mirroring their (drift-prone) contents:

- **Nexus `/v0` API:** [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/)
- **Data-contract version/stability:** [pubky-app-specs](https://github.com/pubky/pubky-app-specs)
  (README + `src/` Rust models; watch for the `pubky.app/v1/` path prefix)
- **Protocol / homeserver / SDK status:** [Pubky SDK guide](https://pubky.org/explore/pubky-protocol/sdk/),
  [docs.rs/pubky](https://docs.rs/pubky), and the
  [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md)
  (concrete proof of breaking SDK changes)
