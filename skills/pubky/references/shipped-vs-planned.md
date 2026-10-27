# Shipped vs planned (the production guardrail)

> **CANONICAL.** This file alone decides what is shipped, alpha, or planned in Pubky. Other `pubky` references and the `pubky-mobile` / `pubky-infra` skills link here. Link to a section; do not restate it.

**Only document what ships.** Never write code, docs or answers that depend on encrypted storage, restore or mirroring: nothing fails at review time, it fails in production. The protocol model (homeserver, PKARR, write/read split, event streams) is canonical in [`concepts.md`](concepts.md).

## The split

| Status | Items | What an app may do |
| :-- | :-- | :-- |
| **Shipped** | Public `/pub` storage · capability-scoped sessions · PKARR identity and homeserver discovery · pubky-app-specs data models · resumable `pubkyauth` flows · homeserver event streams · local Pubky Backup (one-way, `/pub` only) · PostgreSQL-backed homeservers · scoped encryption-key **delivery** (v0.16.0+, keys only, not encrypted storage; see [below](#scoped-encryption-keys-shipped-key-delivery-only)) | Depend on it, with exact version pins ([Everything is v0](#everything-is-v0)) |
| **Alpha, released, NOT for production** | `/priv` private storage (`pubky-homeserver` and SDK v0.10.0+) | Experiment only, with all three caveats in [`/priv`](#priv-private-storage-alpha) |
| **Planned / NOT shipped** | Encrypted or guarded data as a *general* storage primitive · data signing as a general primitive · homeserver mirroring · backup **restore** · **cloud** backup · **two-way** backup sync · `/priv` backup | Treat as non-existent. Never present as available. |

**Code-presence ≠ availability.** A route, symbol, config key or merged PR upstream is not a supported feature until a release ships it and release notes or docs say so.

## Everything is v0

Every layer is pre-1.0. Pin **exact** versions, put Pubky paths and response shapes behind your own adapters, and read release notes before every bump.

### SDK and homeserver: 0.16.2

- **Current release: v0.16.2** (2026-10-15): the workspace `Cargo.toml` version, crates.io [`pubky`](https://docs.rs/pubky) max, and npm [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) `latest`. Releases since v0.12.0: v0.13.0, v0.14.0, v0.15.0, v0.16.0, v0.16.1, v0.16.2 ([releases](https://github.com/pubky/pubky-homeserver/releases)).
- **npm gotcha:** dist-tags `alpha` (0.10.0-alpha.0) and `next` (0.6.0-rc.7) are **older** than `latest`. Never install `@synonymdev/pubky@alpha` or `@next`.
- **Do not trust semver-minor compatibility.** Minor bumps keep breaking app-facing APIs:
  - **v0.10.0** deprecated cookie auth, introduced grant auth, renamed auth-flow APIs and made capability matching strict. See the [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md). Current usage: [`sdk-js.md`](sdk-js.md), [`sdk-rust.md`](sdk-rust.md), [`auth.md`](auth.md#capabilities).
  - **v0.12.0** broke testnet and Docker interfaces only (`DockerPostgres::shared`, Docker default build target `homeserver`). See [`testing-and-testnet.md`](testing-and-testnet.md).
  - **v0.15.0** (BREAKING): browser sessions are shared across tabs (#635).
  - **v0.16.0** (BREAKING, scoped encryption keys, #668):
    - Grants containing `e` need upgraded homeservers **and** signers.
    - Apps that request keys must select signed approvals (`af=v1`).
    - Build grant parameters with `new()`, not struct literals.
    - Apps and tabs that share an origin must upgrade **together**: older SDKs cannot safely share V2 browser session records.

    See the [v0.16.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0).
- **Operator-only changes** don't affect app APIs: v0.14.0 stages uploads in `data/files-tmp` ([release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.14.0)); v0.15.0 runs the entries-index migration `m20261002_entry_path_c_collation` ([release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.15.0)). Operator guide: [`pubky-infra` homeserver](../../pubky-infra/references/homeserver.md).
- **Unreleased on `main` after v0.16.2. Do not present these as shipped or target them:**
  - static website serving from `/pub/website/` (#718, `websites` feature)
  - BREAKING: client IP taken from the TCP peer or PROXY protocol (#643)
  - BREAKING: `HEAD` rejected on token and SSE endpoints (#738)
- **Feature-detect via `/info`, not version numbers.** The homeserver advertises `path-addressed-storage`, `webdav-locks`, `grant-proof-logout` and, unreleased, `websites`.

### Storage transport addressing is migrating

Legacy `GET /pub/example.txt` with a `pubky-host` header is being replaced by path-addressed `GET /storage/{user-z32}/pub/example.txt`. Homeserver v0.11.0 added it; SDK v0.12.0 (2026-09-14) is the first stable SDK release that uses it.

- **Use SDK storage APIs; never hand-build homeserver URLs.** They check `/info` for `path-addressed-storage` and fall back to legacy addressing when it is absent.
- The homeserver keeps legacy addressing, `pubky-host` and cookie auth during the migration.
- **Earliest legacy-removal review: 2027-09-14.** Upstream: *"the elapsed year does not authorize removal automatically"*. A maintainer review decides (issue #529); if removal is not approved, compatibility stays. Source: [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md).

### pubky-app-specs is a v0 draft

- **Version 0.8.1** on crates.io and npm `pubky-app-specs` (`latest`). The README shows `version = "0.8"`; pin an exact version anyway.
- README: *"early development phase and is evolving quickly. Expect frequent changes … Consider this a **v0 draft**."*
- Paths are unversioned (`/pub/pubky.app/profile.json`). **Stability signal:** paths gain a `pubky.app/v1/` prefix once the schemas reach their first stable, long-term-support version. Until then, expect schema changes.
- Data contract: [`app-specs.md`](app-specs.md). Source: [pubky-app-specs](https://github.com/pubky/pubky-app-specs#readme).

### The Nexus `/v0` REST API is unstable

README: *"The API is currently **unstable**. We are using the `/v0` route prefix while the API undergoes active development and changes. Expect potential breaking changes as we work toward stability."*

```js
const response = await fetch(
  "https://nexus.pubky.app/v0/stream/posts?limit=10",
);
const posts = await response.json();
```

*From the CI type-checked KB snippet ([developer-guide.ts](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts)). Executed verbatim on 2026-10-26 against live `nexus.pubky.app` (not a testnet; Node 24 `fetch`): 200 with a JSON array of up to 10 posts. `/stream/posts` (no `/v0`) and `/v0/feeds/global` returned **404**.*

- The `/v0` segment is required.
- Check every route against Swagger before you use it: KB CI type-checks snippets but never runs them.
- Parse responses defensively; don't hardcode response shapes.
- Source of truth: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/) (staging: [nexus.staging.pubky.app/swagger-ui](https://nexus.staging.pubky.app/swagger-ui/)). Endpoints: [`nexus-api.md`](nexus-api.md).

### The path layout below the roots is not stabilized

- **Only two storage roots exist:** `/pub/` and `/priv/` ([alpha, not for production, not encrypted from the operator](#priv-private-storage-alpha)). Any other root returns **403** for reads and writes. Root access table and path rules (including the 409 file-vs-folder conflict): [`concepts.md`](concepts.md#storage-roots-and-access).
- **Paths below the roots are app-chosen.** Domain-like folders (`/pub/my-new-app/`, `/pub/mapky.app/`, `/pub/bitkit.to/`) and cross-app protocol scopes (`/pub/paykit/`) are conventions, not a frozen contract. See [`concepts.md`](concepts.md#scopes-and-data-layout).

## No private, encrypted, or guarded storage

For production, **no** private, encrypted, guarded or signed storage ships.

- The only private root is the `/priv` alpha below, and it is **access control, not encryption**.
- Scoped encryption keys (v0.16.0) deliver *keys* to apps. The homeserver still stores opaque bytes and encrypts nothing.

### `/priv` private storage (alpha)

**Released in `pubky-homeserver` v0.10.0 (2026-08-05, a normal release, not a prerelease). ALPHA, NOT for production, NOT encrypted from the operator.** The [v0.10.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.10.0): *"This feature is under active development and should NOT be used in any production environment. Expect private data APIs to change or disappear as we actively iterate over different solutions."* No release from v0.11.0 through v0.16.2 lifts the alpha status.

Every mention of `/priv` in code, docs or answers must carry all three caveats:

1. **Alpha.** The API may change or be removed. Don't store data you can't afford to lose: **no released backup tool covers `/priv`** ([Backup](#backup-restore-and-mirroring)).
2. **Not for production.**
3. **Access-controlled, not encrypted.** *"A homeserver administrator can read and write all tenant data, including data under `/priv/`"*, and the admin event stream can include private events. Never tell a user `/priv` data is hidden from the operator.

How the homeserver answers `/priv` requests (full root table: [`concepts.md`](concepts.md#storage-roots-and-access)):

- Anonymous read: **401**.
- Wrong tenant, a capability that doesn't cover the path, or a read not scoped to exactly one user: **403**.
- **The `e` (encryption-keys) capability grants no `/priv` access.** Request `r`/`w` on the `/priv/...` scope as well.
- `/priv/` is a separate namespace; existing `/pub/` data is not moved into it.

Details: [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md). That doc carries **no** alpha warning, and neither do the KB pages; don't infer stability from them.

**Version boundary.**

- Homeservers v0.9.x and earlier reject `/priv` writes.
- `@synonymdev/pubky` 0.9.3 and earlier type `Path` as `` `/pub/${string}` `` only, so `/priv` code won't type-check.
- From v0.10.0, `Path` is `` `/pub/${string}` | `/priv/${string}` `` and the homeserver accepts `/priv`.

The only upstream `/priv` code is this example; `pubky-homeserver/examples/` has no runnable `/priv` program. **Alpha.** The session needs a capability covering `/priv/my-app/`, such as `/priv/my-app/:rw`:

```js
const path = "/priv/my-app/settings.json";
await session.storage.putJson(path, { theme: "dark" });
const settings = await session.storage.getJson(path);
```

*Executed 2026-10-26 against a local testnet with `@synonymdev/pubky` 0.12.0 (root-capability `/:rw` session from `signer.signup` + `signinBlocking`): the round trip returned `{"theme":"dark"}`, and an anonymous read got 401. `putJson(path: Path)` / `getJson(path: Path)` are unchanged in the 0.16.2 typings, but the snippet was not re-run on 0.16.2. It fails to type-check on 0.9.3.*

**Gotcha: private events are silently excluded.**

- `GET /events/` returns public events only.
- `GET /events-stream` filters to `/pub/` when you omit `path`. Repeated `path` params form a union.
- A private stream needs **all** of:
  - exactly one `user`, equal to the session's own user
  - the session attached with `.session(session)` (without it: **401**)
  - an explicit `/priv/...` path
  - a read capability that covers every private path filter
- If a Bearer header is present, the homeserver ignores cookie auth.

```js
const stream = await pubky
  .eventStreamForUser(user, null)
  .session(session)
  .path("/priv/my-app/")
  .subscribe();
```

*Executed 2026-10-26 against a local testnet with `@synonymdev/pubky` 0.12.0 (`user = session.info.publicKey`): it delivered the private `PUT` event. Without `.session()` it failed with 401; with a session but no `path` it returned 0 private events. The 0.16.2 typings still declare `eventStreamForUser(user: PublicKey, cursor?: string | null)` and `EventStreamBuilder.session(session: Session)`. `.session()` does not exist on 0.9.3.*

**Sources and their status.**

- Cite the v0.10.0 release notes for `/priv` status.
- The KB ([private-storage.md](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/private-storage.md), [security-model.md](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md)) correctly calls `/priv` access control without encryption, but does **not** call it alpha, and pins homeserver links to v0.14.0.
- pubky-ai-kit still lists "private app storage roots" as planned. It predates v0.10.0; the `/priv` alpha supersedes it.

### Still planned

None of these ships as a general or production primitive:

- **Encrypted data:** end-to-end encryption where the homeserver stores ciphertext *as a storage feature*.
- **Guarded data:** access-controlled storage as a general primitive. The `/priv` alpha is the only form of it.
- **Signed data:** data signing as a general primitive.

Source for "planned": [pubky-ai-kit `pubky-dev-context.md` L1300](https://github.com/pubky/pubky-ai-kit/blob/5654d0d272189aee00cd8e11c1ecb45dcc09a04a/pubky-dev-context.md#L1300), the only upstream listing of these as planned primitives. The [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md) confirms today's state (not a roadmap): *"/priv/ adds access control; it does not provide encryption or key management"*, and *"Applications can encrypt content before uploading it and manage decryption keys themselves."*

### Scoped encryption keys (shipped, key delivery only)

Shipped in SDK v0.16.0 (#668).

- **How it works.** The app requests the `e` action on storage scopes with signed approvals: JS `"/pub/chat/:rwe"` with `approvalFormat: "signedApprovalV1"`, or Rust `.encryption_keys(...)` with `GrantApprovalFormat::SignedApprovalV1`. The signer derives keys from the user's identity secret (HKDF-SHA-256) and sends them inside an HPKE-encrypted approval.
- **What it is not.** *"The SDK delivers keys; it doesn't encrypt content for you."* The app picks the cipher and ciphertext format, generates a **fresh nonce for every encryption**, and **binds each ciphertext to its resource** (e.g. the path as AEAD associated data) so ciphertext can't be swapped between paths. The homeserver stores opaque bytes; everything under `/pub` stays publicly readable.
- **The signer may narrow scopes or decline `e`.** Check which scopes were approved before deriving keys. `encryptionKeys` is `undefined` for bare grants.
- Request code: [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#request-encryption-keys), [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys). The JS README calls `keys.free()` in `finally` without guarding for `undefined` keys (it throws a `TypeError` on bare grants); add the guard.

Security caveats ([scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md)). Surface these whenever you use the feature:

- **Keys are permanent.** They derive from the identity secret, so revoking or expiring the grant doesn't take them back. No rotation, no forward secrecy.
- **`e` on `/` hands the app every key the user will ever have.** Request the narrowest scope.
- **`e` and `r`/`w` are independent.** `e` grants no storage access; `r`/`w` deliver no keys.
- **Keys are symmetric and don't authenticate writers.** Anyone holding the key can produce valid ciphertext.
- **Metadata stays public.** Filenames and directory structure are visible. Renaming a file changes its per-file key.
- **Rollout order:** older homeservers reject any grant containing `e`, so upgrade homeservers, then signers, then apps.
- **`browserSessionStore.save()` stores the keys as plaintext in IndexedDB.**

### App-side ciphertext is your own crypto

An app may store ciphertext it produced as opaque bytes. Even with keys from scoped encryption keys, this is the app's own cryptography, not a Pubky storage feature, and the app owns its security:

- **Use a vetted, audited AEAD** (e.g. WebCrypto AES-GCM, or an audited AEAD crate). Never hand-roll primitives or constructions.
- **Fresh nonce per encryption; bind ciphertext to its path** via associated data.
- **Assume the ciphertext is exposed.** Under `/pub` it is world-readable; under `/priv` the operator can read it.
- **Metadata leaks.** Paths, sizes, write timing and event-stream entries stay visible. Fixed paths can be listed.

Worked example of client-side ciphertext over `/pub`, and its path-listing pitfalls: [`advanced-messaging-payments.md`](advanced-messaging-payments.md).

## Backup, restore, and mirroring

**Pubky Backup is the only shipped backup tool.** A desktop app (Rust core + Tauri) that keeps a **local, one-way copy** of one or more users' **public `/pub`** data, using homeserver event streams with persisted cursors, local snapshots and activity logs. **Latest release: v0.5.0** (2026-05-20). Source: [pubky-backup](https://github.com/pubky/pubky-backup) ([releases](https://github.com/pubky/pubky-backup/releases)).

**Merged to `main`, unreleased. Do not present as available:**

- `/priv` backup after Pubky Ring sign-in (#66, merged 2026-10-15)
- *"Mirror a key's backup to a second homeserver"* (#69, merged 2026-10-19): copies backed-up data and later changes, deletions included, to a second homeserver where the user already has an account. It does not change PKDNS.

Until a pubky-backup release ships them and its release notes confirm it, never tell users that Pubky Backup, or anything else, can:

- **restore** data to a homeserver,
- **mirror** one homeserver to another,
- back up `/priv`,
- do **cloud** backup,
- do **two-way sync**.

KB today:

- *"Full Homeserver mirroring and seamless failover are still planned work"* ([censorship-resistance](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/censorship-resistance.md))
- *"Pubky Backup does not provide automatic failover or restoration to another Homeserver"* ([pubky-backup](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-backup.md))
- The v0.10 grant-auth guide's *"Supports the upcoming homeserver mirroring"* is a future plan.

**Migration (credible exit) is manual.** KB: *"Re-uploading those local files to a new Homeserver is still a manual workflow today, while seamless restore and Homeserver mirroring are planned features"* ([credible-exit](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/credible-exit.md)). Sign up on the new homeserver, re-upload the data yourself (e.g. with the SDK), then update the user's PKARR record. See [`concepts.md`](concepts.md#trust-model-and-credible-exit).

## Shipped, with rough edges

- **Event streams.** Use them for indexing, backup, sync and watchers; **don't poll or recursively list `/pub` trees** when a stream is available. See [`concepts.md`](concepts.md#homeserver-write-vs-nexus-read).
- **PostgreSQL-backed homeservers.** PostgreSQL holds homeserver metadata only. **Apps never connect to PostgreSQL; they see only the file API.** See [`concepts.md`](concepts.md#the-homeserver-model).
- **Cookie auth is deprecated and insecure.** Every website in a browser shares the same homeserver cookie, and with it the same permissions ([pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)). It is kept at least until the legacy-removal review ([earliest 2027-09-14, issue #529](#storage-transport-addressing-is-migrating)). Use **grant auth** (v0.10+) for new code. See [`auth.md`](auth.md#session-lifecycle) and [`auth.md`](auth.md#deprecated-cookie-auth).

## Upstream sources of truth

- pubky-homeserver releases: [v0.10.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.10.0) (`/priv` alpha warning, auth breaking changes) · [v0.16.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0) (scoped encryption keys, breaking) · [all releases](https://github.com/pubky/pubky-homeserver/releases)
- Homeserver docs: [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md) · [scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md) · [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md) · [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md)
- [docs.rs/pubky](https://docs.rs/pubky) · [npm @synonymdev/pubky](https://www.npmjs.com/package/@synonymdev/pubky)
- Nexus: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/)
- [pubky-app-specs](https://github.com/pubky/pubky-app-specs#readme) (watch for the `pubky.app/v1/` prefix)
- [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md)
- [pubky-backup releases](https://github.com/pubky/pubky-backup/releases)
