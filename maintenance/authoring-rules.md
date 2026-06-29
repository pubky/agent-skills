# Authoring rules for Pubky skill reference files

Passed verbatim into every workflow stage as `rulesText` (and the guardrail as
`shippedVsPlannedText`). Keep this stable — changing it invalidates resume caches, so edit
deliberately. Derived from the repo `CLAUDE.md` and the pubky-knowledge-base `.ai-rules.md`.

## Core rules

1. **Link upstream, summarize — don't mirror.** Pubky is pre-1.0 and churns (app-specs v0.x,
   Nexus `/v0`, FFI String Contracts). Link to maintained sources (docs.rs, crate/READMEs,
   Swagger, `openapi.yaml`) and keep only short "what this means in Pubky" summaries. Never
   re-copy drift-prone API tables — that recreates the maintenance burden this split exists to
   avoid.
2. **Canonical-not-copy.** Shared protocol knowledge lives in exactly one place —
   `skills/pubky/references/{concepts,app-specs,shipped-vs-planned}.md`. Other references LINK
   to it (relative path), never restate it. A `pointer` file is a thin map only.
3. **Only document what exists.** Never invent features. Honor the shipped-vs-planned guardrail
   below; never present a planned item as available.
4. **Be concise and to the point.** Cut filler. Prefer a link + one-line summary over a restated
   table. Include accurate code snippets only where they earn their place.
5. **Public-key string formats matter.** `publicKey.toString()` → `pubky<z32>` (display);
   `publicKey.z32()` → raw z-base-32 (hostnames, DNS, headers, URL params, DB keys). Don't mix
   them up; flag misuse.
6. **Prefer CI-verified snippets.** Lift code verbatim from `pubky-knowledge-base-v2/snippets/*`
   (CI type-checked/clippy'd) and runnable programs from `pubky-core/examples/*` where they
   exist; attribute the source. Author new snippets only for genuine gaps.

## Shipped-vs-planned guardrail (authoritative)

**Shipped (safe to document as available):** public `/pub` storage; capability-scoped sessions;
PKARR identity/discovery; pubky-app-specs data models; resumable `pubkyauth` flows; homeserver
event streams; local Pubky Backup; PostgreSQL-backed homeservers.

**Planned / NOT shipped (never present as available):** `/priv` private storage;
encrypted/guarded data as a general primitive; homeserver mirroring; backup *restore*; cloud
backup; two-way backup sync.

**Stability caveats to keep:** the `/pub` path layout is not stabilized; the Nexus `/v0` REST
API is unstable and breaking-change-prone; app-specs are v0.x. Any stable-sounding claim about
these must carry an instability caveat.
