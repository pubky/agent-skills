# Maintaining the Pubky agent skills

Rules for editing this repo. They keep the skills correct, cheap to load, and drift-resistant.

## 1. Split by audience, never by SDK language

Four skills, divided by who the developer is and what they're doing:

- `skills/pubky` — building **web / server** apps (JS/WASM + Rust SDKs)
- `skills/pubky-mobile` — building **native** apps (React Native, UniFFI Swift/Kotlin)
- `skills/pubky-infra` — **operating / self-hosting** Pubky backend services
- `skills/nexus-scout` — **querying** the social graph with read-only Cypher (vendored, see §7)

Do **not** add a skill per SDK or per language. Every SDK re-expresses the same protocol
spine (identity, `pubkyauth`, homeserver signup/session, `pubky://` CRUD, app-specs
paths/IDs, pkarr resolve, Nexus queries). Language belongs in a sibling **reference file**
inside a skill, not in a new skill. Per-SDK skills would create competing triggers that all
fire on the bare word "Pubky" and guarantee drift.

## 2. Canonical-not-copy (the load-bearing rule)

Shared protocol knowledge lives in **exactly one** place and the other skills **link** to it,
never copy:

- `skills/pubky/references/concepts.md` — identity, `pubky://` addressing, pkarr, homeserver
  model, write-vs-Nexus-read split
- `skills/pubky/references/app-specs.md` — the on-wire data contract
- `skills/pubky/references/shipped-vs-planned.md` — the production guardrails

`pubky-mobile` and `pubky-infra` reference these by relative path. If you ever find yourself
pasting concept text into a second file, stop and link instead — copying is how drift returns.

## 3. Keep SKILL.md thin

Each `SKILL.md` is always-loaded for anyone with the plugin installed, so cost = sum of every
installed skill's `SKILL.md`. Keep it to: frontmatter (`name` + a sharp trigger `description`)
+ a ~20–30 line capability map + a routing table to reference files. All substance goes in
`references/`, which is free until disclosed. Do not let a `SKILL.md` creep back toward the
old ~1,300-line monolith.

`verify.mjs` budgets this at 90 lines / 800 words. **Vendored skills (§7) are exempt** — their
body is a byte copy, so trimming it to fit is not available; `verify.mjs` lists them in `VENDORED`
and reports thinness as `info`. That exemption is the price of not maintaining a fork, and it is
paid in always-loaded context (~10 KB → ~22.5 KB with `nexus-scout`). Do not extend it to a skill
we author ourselves.

## 4. Link upstream; summarize, don't mirror

Pubky is pre-1.0 and churns (app-specs v0.x, Nexus `/v0`, FFI String Contracts). Following
the pubky-knowledge-base `.ai-rules.md`: reference files should **link** to maintained
upstream sources (docs.rs, crate/READMEs, Swagger, `openapi.yaml`) and keep only short,
stable "what this means in Pubky" summaries. Do not re-copy drift-prone API detail — that
recreates the maintenance burden this split exists to avoid.

The one sanctioned exception is a **vendored** skill (§7): a machine-refreshed byte copy carries
no maintenance burden, because nobody here edits or reconciles it. That exception applies only to
whole files copied by `vendor-skills.mjs`, never to hand-written prose.

## 5. Triggers must stay disjoint

The whole point of the audience split is non-competing auto-activation. When editing a
`description`, keep `pubky` (build/auth/post/put/get), `pubky-mobile` (iOS/Android/Swift/
Kotlin/React Native/Xcode), and `pubky-infra` (run/deploy/docker/admin/self-host) vocabularies
distinct, and keep the "NOT for … (use the X skill)" cross-references intact.

`nexus-scout` (cypher/followers/tags/threads/follow-distance — reading the graph, not building on
it) is the fourth vocabulary. Its `VOCAB` entry in `verify.mjs` deliberately uses terms absent from
the other three descriptions, so registering it cannot retroactively flag an existing trigger. Every
skill's `NOT for …` clause must name **all** the others — adding a fifth skill means touching all of
them.

## 6. Only document what exists

Never invent Pubky features. Use only documented functionality, and honor
`shipped-vs-planned.md` — do not present planned items (private storage, homeserver
mirroring, backup restore, etc.) as available.

## 7. Vendored skills: copy, never edit

`skills/nexus-scout/SKILL.md` is a **byte copy** of a file authored and maintained upstream in
[`pubky/nexus-scout`](https://github.com/pubky/nexus-scout). That file cannot move here — it is
`include_str!`'d into the gateway binary and served at `/llms.txt`, so the service depends on it.

Rules for any vendored skill:

- **Never hand-edit the body.** `node maintenance/vendor-skills.mjs` overwrites it, so an edit is
  silently lost. Corrections go **upstream** as an issue/PR; they reach us on the next sync.
- **Never route it through the reference-generation workflow.** That pipeline rewrites prose with
  an LLM; the value here is upstream's exact, production-tuned wording.
- **Only the YAML frontmatter is local**, declared in `sources.lock.json` under `vendoredSkills`.
  It exists because upstream's own frontmatter has no `NOT for …` cross-reference clause (§5
  requires one) and its "Neo4j" wording collides with `pubky-infra` trigger vocab.
- The copy is idempotent — there is no SHA bookkeeping. Run the copier on every sync; git shows
  no diff when upstream hasn't moved.
