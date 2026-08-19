# `maintenance/` — generating & updating the skill references

This directory holds the machinery that **populates and keeps current** the
`skills/**/references/*.md` files from authoritative upstream Pubky repos. It exists to kill
drift: reference content is *generated from source*, not hand-curated. Everything here lives
outside `skills/` so it never loads as skill context.

Run it with **`/sync-references`** (see `../.claude/commands/sync-references.md`).

## Pieces

| File | Role |
| --- | --- |
| `sources.lock.json` | Source of truth. Tracks each upstream repo + its last-seen commit, maps every reference file to the sources that feed it, and declares `vendoredSkills` (byte-copied upstream `SKILL.md` files + their local frontmatter). A reference regenerates **iff** one of its sources' SHA changed — or its on-disk artifact is corrupt / its last run wasn't accepted (self-heal). |
| `sync-references.workflow.js` | The Workflow script — the research/synthesis/verify **brain**. Runs a 6-stage per-file pipeline (research → draft → snippet-test → adversarial fact-check → revise/concision → gate), then a cross-file **Consistency** phase, plus structure reconciliation and an in-JS canonical-copy check. Writes nothing. |
| `lib.mjs` | Shared **deterministic** checks imported by `plan-run`/`apply-run`/`verify` (and mirrored inline in the sandboxed workflow): `checkReference` (substance), `slugifyHeading` (anchors), `auditSnippets` (tier corroboration), `selectComparisonSet`/`dedupeContradictions`/`consistencyGate` (cross-file). |
| `lib.test.mjs` | Offline unit tests for `lib.mjs` (`node maintenance/lib.test.mjs`). |
| `verify.mjs` | Deterministic, on-disk invariant checks (manifests, frontmatter, thinness budget, routing↔file bijection, "NOT for" cross-refs, disjoint triggers, **reference substance**, relative links **+ `#anchor` resolution**, canonical-copy, optional external-link check). Run after files are written. |
| `vendor-skills.mjs` | Byte-copies upstream-authored `SKILL.md` files listed under `sources.lock.json` → `vendoredSkills`. **Not** part of the workflow — a vendored skill is upstream's hand-tuned document and must never be LLM-rewritten. Idempotent (no SHA bookkeeping); tries each declared source in order and falls back to a public endpoint. |
| `snippets/` | Snippet-verification templates + the shared-testnet manager. See `snippets/README.md`. |
| `provenance/<skill>/<reference>.json` | Per-file provenance + `accept`/`substance` result + real word count, written after generation; makes the next incremental diff tractable and lets `plan-run` detect a bad last run. |

## Division of labour (why it's split this way)

A Workflow script has **no filesystem and cannot run git/clone/shell** — only its spawned
subagents have tools, and only their returned values survive resume. So:

- **The main agent** (the `/sync-references` command) does all stateful work: clone/fetch
  sources into `~/.cache/pubky-agent-skills/upstream`, diff against `lastSeenSha`, compute the
  in-scope reference set, build the job manifest, start the shared testnet, **invoke the
  workflow**, write the returned markdown + provenance, run `verify.mjs`, bump SHAs, and open a
  signed draft PR.
- **The workflow** is a pure function `manifest → {per-file results, report}`. Its subagents
  *read* the pre-cloned cache and *return* content via JSON schema; the only subagent that
  writes is the snippet-test stage, in its own temp dir.

This makes a ~130-agent initial run **resumable** (durable writes happen once, after the
workflow returns) and **reviewable** (one signed draft PR).

## Modes

- `--initial` — populate all 21 references (heavy, one-time). Reconciliation is a no-op.
- *(default, incremental)* — fetch, diff, regenerate only references whose sources moved.
- `--repos a,b,c` — force-scope to references fed by those repos.

## Output gates (don't trust the self-grade; hardcode structure, adapt content)

Generation is LLM-driven, so every verdict a script *can* corroborate, it does — and Pubky
*facts* are always derived from the live sources, never frozen in code.

- **Substance gate** (`checkReference`, enforced in the workflow's finalize gate, in `apply-run`,
  and as a blocking `verify.mjs` check): a file whose body isn't a real document — a finalize-log
  or stub written into `finalMarkdown` — is forced `accept=false`, parked as a `.rejected.md`
  sidecar, and its SHA is **not** bumped. `plan-run` then re-scopes it next run (self-heal).
- **Snippet rigor** (`auditSnippets`): a `pass` at executed/compiled tier without a `command` +
  `evidence` is demoted to `unverifiable`; CLI/bash snippets must invoke the real tool (so its own
  parser catches a bad flag or missing `--`), and install/version claims are checked against the
  registry. No per-command regexes — the real tool is the oracle.
- **Cross-file consistency** (Consistency phase): each file is checked against the canonical files
  + its related set for contradictions. A high-confidence conflict with a canonical file auto-gates
  the weaker (non-canonical) file; the rest are surfaced for human review. Adaptive — it compares
  the current generated text, with no Pubky facts baked in.

## Invariants enforced (from `../CLAUDE.md`)

Split-by-audience · **canonical-not-copy** (concepts/app-specs/shipped-vs-planned live once;
others link) · thin `SKILL.md` · link-upstream-don't-mirror · disjoint triggers · only document
what exists (honor `shipped-vs-planned.md`). `verify.mjs` checks the mechanical/structural ones;
the workflow's fact-check + consistency stages enforce the judgment ones.

## Vendored skills (the one thing this pipeline does *not* generate)

`skills/nexus-scout/SKILL.md` is a **byte copy** of a file maintained in
[`pubky/nexus-scout`](https://github.com/pubky/nexus-scout), refreshed by
`node maintenance/vendor-skills.mjs`. Why it is copied rather than generated, or moved here:

- Upstream `include_str!`s that file into the gateway binary and serves it at `/llms.txt`, so the
  service depends on it staying put. We take a copy; upstream stays the single author.
- It is hand-tuned against real agent failures, so running it through the research/draft/fact-check
  pipeline would paraphrase away the exact wording that makes it work.

Mechanics: sources are tried in declared order — the upstream checkout first, the public
`/llms.txt` endpoint last, so the copy still refreshes when the clone is missing or stale (the
gateway serves the same bytes it compiles in, so both paths yield an identical file). Upstream frontmatter is stripped and replaced with the local block in `sources.lock.json`,
which exists only to satisfy this repo's `NOT for …` cross-reference rule and to keep `neo4j` out
of the trigger (it is `pubky-infra` vocab). Before writing, the body must pass `checkReference`
and contain no relative markdown links — a bad fetch or an upstream shape change fails loudly
instead of landing in `skills/`. `verify.mjs` exempts these files from the thinness budget via
its `VENDORED` set. See `../CLAUDE.md` §7.
