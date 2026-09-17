---
name: pubky
description: "Use when building or debugging an application on Pubky with the web/server SDKs: signing users up to a homeserver, authenticating with keypairs and the pubkyauth flow (capabilities, relays, recovery files, signup tokens, sessions), reading/writing data over pubky:// URLs (put/get/list/delete with pagination), constructing and validating spec-compliant social objects (users, posts, tags, bookmarks, follows, feeds, files) with pubky-app-specs and its Timestamp/Blake3-Hash IDs and canonical /pub/pubky.app paths, or querying the Nexus social-graph REST API. Covers the JavaScript/WASM client (@synonymdev/pubky) and the Rust client (the pubky crate), pubky:// addressing, pkarr identity resolution, error handling, and local pubky-testnet development. NOT for native iOS/Android or React Native apps (use pubky-mobile) and NOT for running or self-hosting homeserver/Nexus/DNS infrastructure (use pubky-infra), and NOT for querying the social graph with read-only Cypher (use nexus-scout)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Pubky — build web & server apps

You are helping build a real application on the Pubky protocol with the **web/server** SDKs.
Read this overview, then open the one reference file for the task at hand.
**Do not load every reference up front.**

## Ground rules (always apply)

- **Use only documented functionality.** Do not mock, simulate, or invent Pubky features.
  Every API used must exist in the references below or in their linked upstream sources.
- **Respect Shipped vs Planned.** Public `/pub` storage, capability-scoped sessions, PKARR
  discovery, app-specs, resumable auth flows, and event streams are shipped. Private storage
  (`/priv`) is **alpha** (v0.10.0+): not for production, access-controlled but not encrypted
  from the homeserver operator. Homeserver mirroring, backup restore, and cloud/two-way backup
  are NOT shipped — never present them as available. See `references/shipped-vs-planned.md`.
- **Public-key string formats matter.** `publicKey.toString()` → `pubky<z32>` for display;
  `publicKey.z32()` → raw z-base-32 for hostnames, DNS names, headers, params, DB keys.
- **Auth is SDK-driven.** Use the `pubkyauth` flow; never ask users to paste keys or
  mnemonics. AuthTokens are valid for a ~3-minute window. See `references/auth.md`.
- **Pre-1.0 churn is real.** app-specs is v0.x and Nexus is `/v0` — treat APIs as unstable
  and prefer linking upstream over hardcoding shapes.

## Architecture in one screen

- **Client SDK** — `@synonymdev/pubky` (JS/WASM) or the `pubky` Rust crate. Auth + data ops.
  Prefer one shared client per app/process.
- **Homeserver** — the user's backend. App-facing API is **file storage only**: HTTP
  PUT/GET/DELETE against `pubky://<pk>/pub/...`. ~10 MB default per-request limit; expect 429.
- **pkarr** — public-key DNS over the Mainline DHT; resolves `pubky://` to homeservers
  (consumed transparently via the SDK). Records are ephemeral; republished periodically.
- **pubky-app-specs** — validated data models + ID/path generation (the on-wire contract).
- **Nexus** — aggregator/indexer; a hosted **read** REST API (still `/v0`). Apps write to the
  homeserver and read social-graph data from Nexus.

URL forms: `pubky<pk>/pub/<path>` (SDK address) · `pubky://<pk>/pub/<path>` (deeplink) ·
`/pub/<path>` (signed-in session). Only `/pub` is protocol-required; the first segment under
it is an app-chosen **scope** (e.g. `/pub/pubky.app/*`).

## Where to look

| Task | Read |
| :-- | :-- |
| Identity, `pubky://` addressing, pkarr, homeserver model (shared spine) | `references/concepts.md` |
| The `pubkyauth` flow, capabilities, relays, recovery files, signup tokens, sessions | `references/auth.md` |
| Create/validate users, posts, tags, bookmarks, follows, feeds, files; IDs & paths | `references/app-specs.md` |
| JavaScript / WASM client — install, init, CRUD, pagination | `references/sdk-js.md` |
| Rust client (`pubky` crate) — usage, idioms | `references/sdk-rust.md` |
| Querying aggregated social data (the Nexus read API) | `references/nexus-api.md` |
| Local development with `pubky-testnet`; scripting with the CLI | `references/testing-and-testnet.md` |
| Worked reference apps, starter templates, and patterns (pubky.app, explorer, workshop, pubky-app-templates) | `references/reference-apps.md` |
| Advanced: E2E messaging (`pubky-noise`), payments (`paykit`) | `references/advanced-messaging-payments.md` |
| What's shipped vs planned (guardrails) | `references/shipped-vs-planned.md` |

Building a **native mobile** app (iOS/Android/React Native)? Use the **`pubky-mobile`** skill.
Running or self-hosting a homeserver, Nexus, or DNS? Use the **`pubky-infra`** skill.
Need **facts out of the social graph** (followers, tags, threads)? Use the **`nexus-scout`** skill.
