---
description: Populate/refresh the Pubky skill reference files from upstream repos, with snippet execution + fact-checking, and open a signed draft PR.
argument-hint: "[--initial] [--repos a,b,c] [--only path1,path2] [--resume <runId>]"
---

You are the **main agent** for `/sync-references`. The Workflow script is the research/verify
brain; YOU do all git/fs/network work around it (it cannot). Read `maintenance/README.md` and
`CLAUDE.md` first. Args: `$ARGUMENTS`.

Modes: `--initial` (populate all 21, reconciliation no-op) · default incremental (fetch, diff,
regenerate only references whose source SHAs moved) · `--repos a,b,c` (force-scope by repo) ·
`--only p1,p2` (force-scope by reference path — used for the pilot) · `--resume <runId>` (re-run
from a prior Workflow run; only changed/new agent() calls re-execute).

Work through these steps, reporting what you find; stop and ask if anything looks destructive or wrong.

## 0. Preflight
- `pg_isready -h localhost -p 5432` — if down, `brew services start postgresql@18` and wait. The
  connecting role needs `CREATEDB` (Homebrew superuser has it).
- `gh auth status` (need `repo` scope to open the PR). Confirm `cargo`, `node`, `gradle` on PATH.
- Cache dir: `~/.cache/pubky-agent-skills/upstream` (created on demand; never committed).

## 1. Clone / fetch sources
For every **git** repo in `maintenance/sources.lock.json` `.repos` (skip `kind:"docs"`/`"registry"`),
clone if missing, else fetch + hard-reset to the tracked branch. Honor each repo's `branch`
(several are `master`; `pubky-app` is `dev`; `workshop` is `spanish`). Example loop:
```bash
CACHE=~/.cache/pubky-agent-skills/upstream; mkdir -p "$CACHE"
jq -r '.repos | to_entries[] | select(.value.kind!="docs" and .value.kind!="registry") | "\(.key)\t\(.value.url)\t\(.value.branch)"' maintenance/sources.lock.json |
while IFS=$'\t' read -r name url branch; do
  if [ -d "$CACHE/$name/.git" ]; then git -C "$CACHE/$name" fetch -q origin "$branch" && git -C "$CACHE/$name" reset -q --hard "origin/$branch";
  else git clone -q --depth 1 -b "$branch" "$url" "$CACHE/$name"; fi
done
```
For incremental diffs you need history: when a repo is in scope and shallow, `git -C "$CACHE/$name" fetch --unshallow -q` (or fetch enough depth) so `plan-run.mjs` can diff `lastGeneratedSha..HEAD`.

## 2. Start the shared testnet (one instance; fixed ports)
`maintenance/snippets/testnet.sh start` — builds if needed, waits for readiness. Snippet agents
connect to it; they never start their own. (First build is slow; it's cached after.)

## 3. Build the job manifest
`node maintenance/plan-run.mjs $ARGUMENTS > /tmp/sync-manifest.json` (read the stderr summary —
it lists mode, in-scope count, and testnet state). If in-scope is empty on an incremental run,
report "nothing to update" and stop (after stopping the testnet).

## 4. Run the workflow
Invoke the **Workflow** tool with `scriptPath: "maintenance/sync-references.workflow.js"` and
`args: { "manifestPath": "/tmp/sync-manifest.json" }` (the workflow loads the manifest off disk
via a bootstrap agent — do not inline the manifest). For `--resume <runId>` pass `resumeFromRunId`.
Save the returned report object to `/tmp/sync-report.json`.

## 5. Apply results
`node maintenance/apply-run.mjs --report /tmp/sync-report.json --manifest /tmp/sync-manifest.json`
— writes the generated markdown, writes `maintenance/provenance/**` sidecars, and bumps SHAs in
`sources.lock.json` (only accepted files advance; failed-gate files stay stale to retry next run).
Surface any reconciliation proposals it prints; **do not** auto-apply SKILL.md trigger edits —
present those as a diff for human approval. If a new reference file was added, add its routing-table
row to the owning `SKILL.md` (keep it thin) and re-run verify.

## 6. Verify invariants
`node maintenance/verify.mjs --links`. Treat `blocking` findings as PR-blocking; capture the list.

## 7. Stop the testnet
`maintenance/snippets/testnet.sh stop`.

## 8. Open a signed draft PR
- Branch: `sync/references-<date-or-short-tag>` off `main` (never commit straight to `main`).
- Stage only what the run produced: `skills/**`, `maintenance/sources.lock.json`,
  `maintenance/provenance/**` (and any SKILL.md routing-row edits). Do **not** stage `/tmp/*` or the cache.
- Commit with a Conventional-Commit subject (`docs(references): …`, `< 72` chars). Body explains
  what changed and why. **GPG/SSH signing is on — let it fire; never pass `--no-gpg-sign`.**
  **Never add a `Co-Authored-By`, "Generated with", or any AI/tool attribution line.**
- `gh pr create --draft` (open as draft if `verify.mjs` had blocking failures). PR body = the
  workflow report: mode, repos fetched (old→new SHA), per-file table (snippet pass/fail, fact-check,
  guardrail violations, word count), the 7 invariant checks, files needing human attention, and
  reconciliation proposals. Then summarize for the user and link the PR.
