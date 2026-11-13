# Shipped vs planned (the production guardrail)

> **CANONICAL.** This file alone decides what is shipped, alpha, or planned in Pubky. Other `pubky` references and the `pubky-mobile` / `pubky-infra` skills link here. Link to a section; do not restate it.

**Only document what ships.** Never write code, docs or answers that depend on encrypted storage, restore or mirroring: nothing fails at review time, it fails in production. The protocol model (homeserver, PKARR, write/read split, event streams) is canonical in [`concepts.md`](concepts.md).

## The split

| Status | Items | What an app may do |
| :-- | :-- | :-- |
| **Shipped** | Public `/pub` storage · capability-scoped sessions · PKARR identity and homeserver discovery · pubky-app-specs data models · resumable `pubkyauth` flows · homeserver event streams · local Pubky Backup (one-way, `/pub` only) · PostgreSQL-backed homeservers · scoped encryption-key **delivery** (v0.16.0+, keys only, not encrypted storage; see [below](#scoped-encryption-keys-shipped-key-delivery-only)) · static website serving from public `/pub` files (v0.17.1+, operator can disable; see [below](#shipped-with-rough-edges)) | Depend on it, with exact version pins ([Everything is v0](#everything-is-v0)) |
| **Alpha, released, NOT for production** | `/priv` private storage (`pubky-homeserver` and SDK v0.10.0+) | Experiment only, with all three caveats in [`/priv`](#priv-private-storage-alpha) |
| **Planned / NOT shipped** | Encrypted or guarded data as a *general* storage primitive · data signing as a general primitive · homeserver mirroring · backup **restore** · **cloud** backup · **two-way** backup sync · `/priv` backup | Treat as non-existent. Never present as available. |

**Code-presence ≠ availability.** A route, symbol, config key or merged PR upstream is not a supported feature until a release ships it and release notes or docs say so.

## Everything is v0

Every layer is pre-1.0. Pin **exact** versions, put Pubky paths and response shapes behind your own adapters, and read the release notes before every bump.

### SDK and homeserver: 0.18.0

- **Current release: v0.18.0** (2026-11-09). This is the workspace `Cargo.toml` version, the crates.io [`pubky`](https://docs.rs/pubky) max (stable), and the npm [`@synonymdev/pubky`](https://www.npmjs.com/package/@synonymdev/pubky) `latest`. Releases since v0.16.2: **v0.17.1** (2026-10-26) and **v0.18.0** ([releases](https://github.com/pubky/pubky-homeserver/releases)).
- **There is no v0.17.0.** A `chore: v0.17.0` commit exists, but there is no GitHub release, npm version or crates.io version; the v0.17.1 release notes cover its changes. Never pin `0.17.0`.
- **npm gotcha:** the `alpha` (0.10.0-alpha.0) and `next` (0.6.0-rc.7) dist-tags are **older** than `latest`. Never install `@synonymdev/pubky@alpha` or `@next`.
- **Do not trust semver-minor compatibility.** Minor bumps keep breaking app-facing APIs:
  - **v0.10.0** deprecated cookie auth, introduced grant auth, renamed auth-flow APIs and made capability matching strict. See the [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md). Current usage: [`sdk-js.md`](sdk-js.md), [`sdk-rust.md`](sdk-rust.md), [`auth.md`](auth.md#capabilities).
  - **v0.12.0** broke only the testnet and Docker interfaces (`DockerPostgres::shared`; the Docker default build target became `homeserver`). See [`testing-and-testnet.md`](testing-and-testnet.md).
  - **v0.15.0** (BREAKING): browser sessions are shared across tabs (#635).
  - **v0.16.0** (BREAKING, scoped encryption keys, #668):
    - Grants containing `e` need upgraded homeservers **and** signers.
    - Apps that request keys must select signed approvals (`af=v1`).
    - Build grant parameters with `new()`, not struct literals.
    - Apps and tabs that share an origin must upgrade **together**: older SDKs cannot safely share V2 browser session records.

    See the [v0.16.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0).
  - **v0.17.1** (BREAKING, #738): `HEAD` returns **405** on `/signup_tokens/{token}`, admin `/generate_signup_token`, and both `/events-stream` endpoints. Use `GET` to look up tokens and read event streams, and `POST` to generate tokens. Storage and website `HEAD` support is unchanged. See the [v0.17.1 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1).
  - **v0.18.0** (BREAKING, [release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0)):
    - **Event cursors must be numeric event IDs (#753).** Client `/events/` and `/events-stream` and admin `/events-stream` no longer accept legacy Base32 timestamp cursors. Non-numeric cursors get **400**; all-digit values are still read as event IDs. **Cursors your app saved in the old format stop working after the upgrade.** Resume from a numeric event ID, or restart from `0` and handle repeated events.
    - **Resource paths are plain names, not percent-encoded (#797).** SDK path accessors, `toPubkyUrl()` / `to_pubky_url()`, `list()` entries and event paths now return plain names (accessor list: release notes). Pass `/pub/app/My File.txt` as is; the SDK percent-encodes it when it builds the HTTP URL, so don't encode it yourself.
      - **Data gotcha:** SDK v0.6 to v0.17 stored files whose names HTTP encoding escapes under the encoded name: `pub/my file.txt` became `pub/my%20file.txt`. The upgrade doesn't rename them. From v0.18, read them at the stored name, `pub/my%20file.txt`.
    - **Grant recovery after a rejected bearer token (#741).** Marked breaking, with no migration text. A rejected refresh now surfaces as Rust `Error::CredentialRefresh` / JS `CredentialRefreshError`, and Rust `PubkySession::revalidate` returns `None` only for a confirmed 401/404. See [`auth.md`](auth.md#session-lifecycle) and upstream [grant-session-lifecycle.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md).
    - **Embedders only (#769):** `PathLimit` and `GoogleBucketConfig` no longer implement `serde_valid::Validate`. Call `PathLimit::validate()` instead.
- **Additive, shipped in v0.17.1 and v0.18.0.** The sibling references show how to use them:
  - Static website serving, v0.17.1, #718 ([below](#shipped-with-rough-edges)).
  - Typed failures for automatic grant refresh (#698) and categories for request errors (#717).
  - `GET /account` (#749): Rust `session.as_grant()` (returns `Option<GrantSessionView>`) then `.account()`; JS `session.grant.account(): Promise<AccountInfo>`. The release-note title "`session.account()`" is not the Rust API. It accepts **grant sessions only** (cookie sessions are rejected) and needs **read on the root scope** (`/:r`, `/:rw`); path-scoped sessions get **403**. Read-only root sessions may call it (#754). Source: [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md).
  - Grant sign-in links can require an expected identity: `expectedSigner` adds `spk=<z32>` to the link (#787). Pass `publicKey.z32()`, not `toString()` (the `pubky<z32>` form is rejected). See [`auth.md`](auth.md).
  - The SDK reports rejected TLS certificates as `TlsVerification` (#800).
  - Browsers may revalidate private file reads (#790). This adds a [`/priv` caching caveat](#priv-private-storage-alpha).
- **Operator-only changes** don't affect app APIs: upload staging in `data/files-tmp` (v0.14.0), the entries-index migration (v0.15.0), client IP from the TCP peer or PROXY protocol (v0.17.1, #643), trusted client-IP headers (v0.18.0, #801), and new admin endpoints. Operator guide: [`pubky-infra` homeserver](../../pubky-infra/references/homeserver.md).
- **Unreleased on `main` after v0.18.0. Do not present these as shipped or target them:**
  - BREAKING: parent/child (delegated) grants (#792). They add the `pubky-parent-grant` and `pubky-child-grant` token types and the `/info` feature `grant-delegation`. Older homeservers reject the new token types, so even after a release, check that `/info` lists `grant-delegation` before you use them ([delegated-grants.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md)).
  - A size limit enforced on streaming uploads (#808).
  - SDK `request_timeout` on WASM, and bounded body reads (#725).
  - Internal refactors, dependency bumps and CI (#763, #777, #804, #809, #814, #815).
- **Feature-detect via `/info`, not version numbers.** v0.18.0 advertises `path-addressed-storage`, `grant-proof-logout`, `webdav-locks`, and `websites` (listed only when the operator enables it). `grant-delegation` is unreleased.

### Storage transport addressing is migrating

Path-addressed `GET /storage/{user-z32}/pub/example.txt` is replacing legacy `GET /pub/example.txt` with a `pubky-host` header. Homeserver v0.11.0 added it; SDK v0.12.0 (2026-09-14) was the first stable SDK release to use it.

- **Use the SDK storage APIs; never hand-build homeserver URLs.** They check `/info` for `path-addressed-storage` and fall back to legacy addressing when it is absent.
- The homeserver keeps legacy addressing and `pubky-host` during the migration. The migration doc also lists cookie auth here, but cookie auth has its own, earlier [removal date](#shipped-with-rough-edges).
- **Earliest legacy-removal review: 2027-09-14.** Upstream: *"the elapsed year does not authorize removal automatically"*. A maintainer review decides (issue #529); if it doesn't approve removal, compatibility stays. Source: [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md).

### pubky-app-specs is a v0 draft

- **Version 0.8.1** is on crates.io and npm `pubky-app-specs` (`latest`). The README shows `version = "0.8"`; pin an exact version anyway.
- The README says: *"early development phase and is evolving quickly. Expect frequent changes … Consider this a **v0 draft**."*
- Paths are unversioned (`/pub/pubky.app/profile.json`). **Stability signal:** paths gain a `pubky.app/v1/` prefix once the schemas reach their first stable, long-term-support version. Until then, expect schema changes.
- Data contract: [`app-specs.md`](app-specs.md). Source: [pubky-app-specs](https://github.com/pubky/pubky-app-specs#readme).

### The Nexus `/v0` REST API is unstable

The README says: *"The API is currently **unstable**. We are using the `/v0` route prefix while the API undergoes active development and changes. Expect potential breaking changes as we work toward stability."*

```js
const response = await fetch(
  "https://nexus.pubky.app/v0/stream/posts?limit=10",
);
const posts = await response.json();
```

*From the CI type-checked KB snippet ([developer-guide.ts](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/snippets/js/src/developer-guide.ts)). Executed 2026-11-12 against live `nexus.pubky.app` (not a testnet): 200 with a JSON array of 10 posts, each with `details`, `counts`, `tags`, `relationships`, `bookmark`. The same route without `/v0` returned **404**, as did `/v0/feeds/global`.*

- The `/v0` segment is required.
- Check every route against the spec before you use it. KB CI type-checks snippets but never runs them.
- Parse responses defensively; don't hardcode response shapes.
- Source of truth: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/) (staging: [nexus.staging.pubky.app/swagger-ui](https://nexus.staging.pubky.app/swagger-ui/)). Machine-readable spec: [`/api-docs/v0/openapi.json`](https://nexus.pubky.app/api-docs/v0/openapi.json) (`/api-docs/openapi.json`, without `v0`, is a 404). Endpoints: [`nexus-api.md`](nexus-api.md).

### The path layout below the roots is not stabilized

- **Only two storage roots exist:** `/pub/` and `/priv/` ([alpha, not for production, not encrypted from the operator](#priv-private-storage-alpha)). Reads and writes to any other root get **403**. Root access table and path rules, including the 409 file-vs-folder conflict: [`concepts.md`](concepts.md#storage-roots-and-access).
- **Paths below the roots are chosen by apps.** Domain-like folders (`/pub/my-new-app/`, `/pub/mapky.app/`, `/pub/bitkit.to/`) and cross-app protocol scopes (`/pub/paykit/`) are conventions, not a frozen contract. See [`concepts.md`](concepts.md#scopes-and-data-layout).

## No private, encrypted, or guarded storage

For production, **no** private, encrypted, guarded or signed storage ships.

- The only private root is the `/priv` alpha below, and it is **access control, not encryption**.
- Scoped encryption keys (v0.16.0) deliver *keys* to apps. The homeserver still stores opaque bytes and encrypts nothing.

### `/priv` private storage (alpha)

**Released in `pubky-homeserver` v0.10.0 (2026-08-05) as a normal release, not a prerelease. It is ALPHA, NOT for production, and NOT encrypted from the operator.** The [v0.10.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.10.0) say: *"This feature is under active development and should NOT be used in any production environment. Expect private data APIs to change or disappear as we actively iterate over different solutions."* No release from v0.11.0 through v0.18.0 lifts the alpha status. The only `/priv` item in v0.17.1 and v0.18.0 is browser revalidation (#790).

Every mention of `/priv` in code, docs or answers must carry all three caveats:

1. **Alpha.** The API may change or be removed. Don't store data you can't afford to lose: **no released backup tool covers `/priv`** ([Backup](#backup-restore-and-mirroring)).
2. **Not for production.**
3. **Access-controlled, not encrypted.** Upstream: *"A homeserver administrator can read and write all tenant data, including data under `/priv/`"*, and the admin event stream can include private events. Never tell a user that `/priv` data is hidden from the operator.

How the homeserver answers `/priv` requests (full root table: [`concepts.md`](concepts.md#storage-roots-and-access)):

- Anonymous read: **401**.
- Wrong tenant, a capability that doesn't cover the path, or a read not scoped to exactly one user: **403**.
- **The `e` (encryption-keys) capability grants no `/priv` access.** Request `r`/`w` on the `/priv/...` scope as well.
- `/priv/` is a separate namespace; existing `/pub/` data is not moved into it.

Details: [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md). Neither that doc nor the KB pages carry an alpha warning; don't infer stability from them.

**Gotcha: browsers may keep private file bodies on disk (v0.18.0, #790).**

- Since v0.18.0, private file reads that return 200 or 304 carry `Cache-Control: private, no-cache` (before: `no-store`).
- The caller's browser may cache the body on disk, and **nothing clears it at sign-out** (there is no `Clear-Site-Data`). On a shared machine, that copy stays exposed until the browser evicts it.
- Mitigation (upstream): clear the browser cache yourself, or read private files with `cache: 'no-store'` and give up the caching benefit.
- Errors, directory listings and `/events-stream` stay `no-store`. Shared caches never store private reads, because responses vary on `Authorization` and `Cookie` (legacy `/priv/...` responses also on `pubky-host`).
- Source: [homeserver README, caching and proxies](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/README.md#caching-and-proxies).

**Version boundary.**

- Homeservers v0.9.x and earlier reject `/priv` writes.
- `@synonymdev/pubky` 0.9.3 and earlier type `Path` as `` `/pub/${string}` `` only, so `/priv` code won't type-check.
- From v0.10.0 through 0.18.0, `Path` is `` `/pub/${string}` | `/priv/${string}` `` and the homeserver accepts `/priv`.

**Alpha storage example.** The session needs a capability that covers `/priv/my-app/`, such as `/priv/my-app/:rw`. Upstream's only `/priv` storage snippet, byte-identical to [PRIVATE_STORAGE.md L22-28](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md); `pubky-homeserver/examples/` has no runnable `/priv` program:

```js
const path = "/priv/my-app/settings.json";
await session.storage.putJson(path, { theme: "dark" });
const settings = await session.storage.getJson(path);
```

*Executed 2026-11-12 against a local testnet on `@synonymdev/pubky` 0.12.0 and 0.16.2 (type-checks on both), with a root `/:rw` session (`signer.signup` + `signinBlocking`) and with a scoped `/priv/my-app/:rw` grant session: both round trips returned `{"theme":"dark"}`, and an anonymous read got 401. The testnet homeserver was built from unreleased `main` (Cargo 0.18.0 plus post-release commits), not a released version. Not yet run on SDK 0.18.0 or a released v0.18.0 homeserver; the 0.18.0 typings still declare `putJson(path: Path, body: any)` and `getJson(path: Path)`. Fails to type-check on 0.9.3.*

**Gotcha: private events are silently excluded.**

- `GET /events/` returns public events only.
- `GET /events-stream` filters to `/pub/` when you omit `path`. Repeated `path` params form a union.
- A private stream needs **all** of:
  - exactly one `user`, equal to the session's own user
  - the session attached with `.session(session)` (without it: **401**)
  - an explicit `/priv/...` path
  - a read capability that covers every private path filter
- If a Bearer header is present, the homeserver ignores cookie auth.
- The cursor is `null` (start) or a **numeric event ID**. Since v0.18.0, legacy Base32 cursors get 400 ([above](#sdk-and-homeserver-0180)).

Byte-identical to the JS example in [v0.10-migration/README.md L141-147](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md#event-stream-path-filters) (the Rust equivalent is just above it there):

```js
const stream = await pubky
  .eventStreamForUser(user, null)
  .session(session)
  .path("/priv/my-app/")
  .subscribe();
```

*Executed 2026-11-12 against the same local testnet (homeserver built from unreleased `main`) on `@synonymdev/pubky` 0.12.0 and 0.16.2, with `user = session.info.publicKey`, using both a root session and a scoped `/priv/my-app/:rw` session: it delivered the private `PUT` events. Without `.session()` it failed with 401; with a session but no `path`, it returned 0 private events. Not yet run on SDK 0.18.0; its typings still declare `eventStreamForUser(user: PublicKey, cursor?: string | null)` and `EventStreamBuilder.session(session: Session)`. `.session()` does not exist on 0.9.3.*

**Sources and their status.**

- Cite the v0.10.0 release notes for `/priv` status.
- The KB ([private-storage.md](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/private-storage.md), [security-model.md](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md)) correctly calls `/priv` access control without encryption. It does **not** call it alpha, and it pins homeserver links to v0.14.0.
- pubky-ai-kit still lists "private app storage roots" as planned. That list predates v0.10.0; the `/priv` alpha supersedes it.

### Still planned

None of these ships as a general or production primitive:

- **Encrypted data:** end-to-end encryption where the homeserver stores ciphertext *as a storage feature*.
- **Guarded data:** access-controlled storage as a general primitive. The `/priv` alpha is the only form of it.
- **Signed data:** data signing as a general primitive.

Source for "planned": [pubky-ai-kit `pubky-dev-context.md` L1300](https://github.com/pubky/pubky-ai-kit/blob/5654d0d272189aee00cd8e11c1ecb45dcc09a04a/pubky-dev-context.md#L1300), the only upstream source that lists these as planned primitives. The [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md) describes today's state, not a roadmap: *"/priv/ adds access control; it does not provide encryption or key management"*, and *"Applications can encrypt content before uploading it and manage decryption keys themselves."*

### Scoped encryption keys (shipped, key delivery only)

Shipped in SDK v0.16.0 (#668).

- **How it works.** The app requests the `e` action on storage scopes with signed approvals: JS `"/pub/chat/:rwe"` with `approvalFormat: "signedApprovalV1"`, or Rust `.encryption_keys(...)` with `GrantApprovalFormat::SignedApprovalV1`. The signer derives keys from the user's identity secret (HKDF-SHA-256) and sends them inside an HPKE-encrypted approval.
- **What it is not.** Upstream: *"The SDK delivers keys; it doesn't encrypt content for you."* The app picks the cipher and ciphertext format, generates a **fresh nonce for every encryption**, and **binds each ciphertext to its resource** (for example, the path as AEAD associated data) so ciphertext can't be swapped between paths. The homeserver stores opaque bytes, and everything under `/pub` stays publicly readable.
- **The signer may narrow scopes or decline `e`.** Check which scopes were approved before you derive keys. `encryptionKeys` is `undefined` for bare grants.
- Request code: [Rust SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/README.md#request-encryption-keys), [JS SDK README](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/bindings/js/pkg/README.md#request-encryption-keys). The JS README uses `keys` (including `keys.free()` in `finally`) without checking for `undefined`, which throws a `TypeError` on bare grants. Add the check.

Security caveats ([scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md)). Surface these whenever you use the feature:

- **Keys are permanent.** They derive from the identity secret, so revoking or expiring the grant doesn't take them back. There is no rotation and no forward secrecy.
- **`e` on `/` hands the app every key the user will ever have.** Request the narrowest scope.
- **`e` and `r`/`w` are independent.** `e` grants no storage access, and `r`/`w` deliver no keys.
- **Keys are symmetric and don't authenticate writers.** Anyone who holds the key can produce valid ciphertext.
- **Metadata stays public.** Filenames and directory structure are visible. Renaming a file changes its per-file key.
- **Rollout order:** older homeservers reject any grant containing `e`, so upgrade homeservers first, then signers, then apps.
- **`browserSessionStore.save()` stores the keys as plaintext in IndexedDB.**

### App-side ciphertext is your own crypto

An app may store ciphertext it produced as opaque bytes. Even with keys from scoped encryption keys, this is the app's own cryptography, not a Pubky storage feature, and the app owns its security:

- **Use a vetted, audited AEAD** (for example, WebCrypto AES-GCM or an audited AEAD crate). Never hand-roll primitives or constructions.
- **Use a fresh nonce for every encryption, and bind each ciphertext to its path** via associated data.
- **Assume the ciphertext is exposed.** Under `/pub` it is world-readable; under `/priv` the operator can read it.
- **Metadata leaks.** Paths, sizes, write timing and event-stream entries stay visible, and fixed paths can be listed.

Worked example of client-side ciphertext over `/pub`, with its path-listing pitfalls: [`advanced-messaging-payments.md`](advanced-messaging-payments.md).

## Backup, restore, and mirroring

**Pubky Backup is the only shipped backup tool.** It is a desktop app (Rust core + Tauri) that keeps a **local, one-way copy** of one or more users' **public `/pub`** data, using homeserver event streams with persisted cursors, local snapshots and activity logs. **Latest release: v0.5.0** (2026-05-20); none has followed. Source: [pubky-backup](https://github.com/pubky/pubky-backup) ([releases](https://github.com/pubky/pubky-backup/releases)).

**Merged to `main` but unreleased. Do not present as available:**

- `/priv` backup after Pubky Ring sign-in (#66, merged 2026-10-15)
- SDK upgrade from 0.14 to 0.16.1 and grant auth (#67)
- *"Mirror a key's backup to a second homeserver"* (#69, merged 2026-10-19): copies backed-up data and later changes, deletions included, to a second homeserver where the user already has an account. It does not change PKDNS.
- Fixes to mirroring and status (#74, #75, #76). #76 is breaking: it removes the `Stopped` key status.

Until a pubky-backup release ships these and its release notes confirm them, never tell users that Pubky Backup, or anything else, can:

- **restore** data to a homeserver,
- **mirror** one homeserver to another,
- back up `/priv`,
- do **cloud** backup,
- do **two-way sync**.

Even unreleased `main` has no restore, cloud backup or two-way sync.

The KB agrees:

- *"Full Homeserver mirroring and seamless failover are still planned work"* ([censorship-resistance](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/censorship-resistance.md))
- *"Pubky Backup does not provide automatic failover or restoration to another Homeserver"* ([pubky-backup](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/pubky-backup.md))
- In the v0.10 grant-auth guide, *"Supports the upcoming homeserver mirroring"* describes a future plan.

**Migration (credible exit) is manual.** The KB: *"Re-uploading those local files to a new Homeserver is still a manual workflow today, while seamless restore and Homeserver mirroring are planned features"* ([credible-exit](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/credible-exit.md)). To move a user, sign up on the new homeserver, re-upload the data yourself (for example, with the SDK), then update the user's PKARR record. See [`concepts.md`](concepts.md#trust-model-and-credible-exit).

## Shipped, with rough edges

- **Event streams.** Use them for indexing, backup, sync and watchers. **Don't poll or recursively list `/pub` trees** when a stream is available. Since v0.18.0, persist cursors only as numeric event IDs ([above](#sdk-and-homeserver-0180)). See [`concepts.md`](concepts.md#homeserver-write-vs-nexus-read).
- **Static website serving (v0.17.1+, #718).**
  - Files under `/pub/website/_/` are served for Host `<user-key>`, and files under `/pub/website/<label>/` for Host `<label>.<user-key>`. They are ordinary public `/pub` files, so anyone can read them.
  - On by default (`[drive] websites = true`), but operators can turn it off. `/info` lists `websites` only when it is on, so feature-detect before relying on it.
  - Source: [WEBSITES.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md).
- **PostgreSQL-backed homeservers.** PostgreSQL holds homeserver metadata only. **Apps never connect to PostgreSQL; they see only the file API.** See [`concepts.md`](concepts.md#the-homeserver-model).
- **Cookie auth is deprecated, insecure, and has a removal date.**
  - Every website in a browser shares the same homeserver cookie, and with it the same permissions ([pubky-homeserver#520](https://github.com/pubky/pubky-homeserver/issues/520)).
  - The [v0.18.0 release notes](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0): it *"only gets limited security maintenance, and it will be removed in August 2027."*
  - STORAGE_ADDRESSING_MIGRATION.md still groups cookie auth with the [legacy-removal review](#storage-transport-addressing-is-migrating) (earliest 2027-09-14). Treat the release notes' **August 2027** as the deadline.
  - Write new code with **grant auth** (v0.10+), and migrate existing cookie code now. See [`auth.md`](auth.md#session-lifecycle) and [`auth.md`](auth.md#deprecated-cookie-auth).

## Upstream sources of truth

- pubky-homeserver releases: [v0.10.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.10.0) (`/priv` alpha warning, auth breaking changes) · [v0.16.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.16.0) (scoped encryption keys, breaking) · [v0.17.1](https://github.com/pubky/pubky-homeserver/releases/tag/v0.17.1) (`HEAD` 405, websites) · [v0.18.0](https://github.com/pubky/pubky-homeserver/releases/tag/v0.18.0) (cursors, plain paths, cookie removal date) · [all releases](https://github.com/pubky/pubky-homeserver/releases)
- Homeserver docs: [PRIVATE_STORAGE.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/PRIVATE_STORAGE.md) · [scoped-encryption-keys.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md) · [STORAGE_ADDRESSING_MIGRATION.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/STORAGE_ADDRESSING_MIGRATION.md) · [WEBSITES.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/WEBSITES.md) · [grant-session-lifecycle.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md) · [delegated-grants.md](https://github.com/pubky/pubky-homeserver/blob/main/docs/delegated-grants.md) (unreleased) · [v0.10 migration guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/README.md)
- [docs.rs/pubky](https://docs.rs/pubky) · [npm @synonymdev/pubky](https://www.npmjs.com/package/@synonymdev/pubky)
- Nexus: [nexus.pubky.app/swagger-ui](https://nexus.pubky.app/swagger-ui/) · [OpenAPI JSON](https://nexus.pubky.app/api-docs/v0/openapi.json)
- [pubky-app-specs](https://github.com/pubky/pubky-app-specs#readme) (watch for the `pubky.app/v1/` prefix)
- [KB security model](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/src/content/docs/security-model.md)
- [pubky-backup releases](https://github.com/pubky/pubky-backup/releases)
