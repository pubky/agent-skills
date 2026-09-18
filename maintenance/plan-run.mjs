#!/usr/bin/env node
// Build the workflow job manifest from sources.lock.json + the local clones.
// Deterministic so the workflow's resume cache stays warm across re-runs.
//
//   node maintenance/plan-run.mjs --initial                          > /tmp/manifest.json
//   node maintenance/plan-run.mjs                                    > /tmp/manifest.json  # incremental
//   node maintenance/plan-run.mjs --repos pubky-homeserver,pubky-nexus     > /tmp/manifest.json
//   node maintenance/plan-run.mjs --only skills/pubky/references/concepts.md,...  > /tmp/manifest.json
//
// Reads current SHAs from clones under cacheDir; clones must already exist (the command clones).
// References flagged `handAuthored: true` in the lock are maintained by hand (CLAUDE.md §8): they
// stay out of every automatic scope, and --only refuses them too — the generation workflow must
// never rewrite one.

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkReference, selectComparisonSet } from './lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const lock = JSON.parse(readFileSync(join(ROOT, 'maintenance/sources.lock.json'), 'utf8'))
const cacheDir = (val('--cache-dir') || lock.cacheDir || '~/.cache/pubky-agent-skills/upstream')
  .replace(/^~/, process.env.HOME)
const mode = has('--initial') ? 'initial' : 'incremental'
const onlyFiles = val('--only') ? val('--only').split(',').map(s => s.trim()).filter(Boolean) : null
const forceRepos = val('--repos') ? val('--repos').split(',').map(s => s.trim()).filter(Boolean) : null

const isGitRepo = (key, r) => !['docs', 'registry'].includes(r.kind)
const clonePath = (key) => join(cacheDir, key)

function headSha(key) {
  const p = clonePath(key)
  if (!existsSync(p)) return null
  try { return execFileSync('git', ['-C', p, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  catch { return null }
}

// current effective SHA for any source key (docs/registry inherit from tracksRepo)
const shaCache = {}
function currentSha(key) {
  if (key in shaCache) return shaCache[key]
  const r = lock.repos[key]
  if (!r) return (shaCache[key] = null)
  const sha = isGitRepo(key, r) ? headSha(key) : currentSha(r.tracksRepo)
  return (shaCache[key] = sha)
}

// a reference is in scope iff any source's current SHA differs from its recorded lastGeneratedSha
function refStale(ref) {
  for (const s of ref.sources || []) {
    const cur = currentSha(s.repo)
    const gen = (ref.lastGeneratedSha || {})[s.repo] ?? null
    if (cur !== gen) return true
  }
  return false
}

// A reference also needs regenerating if its on-disk artifact is corrupt/stub or its last run
// wasn't accepted — this lets a plain incremental rerun self-heal a bad file even though its
// source SHAs were (wrongly) bumped by a prior run. Returns null when healthy, else a short reason.
function refUnhealthyReason(p) {
  const abs = join(ROOT, p)
  if (!existsSync(abs)) return 'missing on disk'
  const role = (refs[p] || {}).role || 'normal'
  const res = checkReference(readFileSync(abs, 'utf8'), { role })
  if (!res.ok) return res.reasons[0]
  const sk = p.split('/')[1], fn = p.split('/').pop().replace(/\.md$/, '.json')
  const pp = join(ROOT, 'maintenance/provenance', sk, fn)
  if (!existsSync(pp)) return 'no provenance sidecar'
  try { if (JSON.parse(readFileSync(pp, 'utf8')).accept !== true) return 'last run not accepted' }
  catch { return 'unreadable provenance sidecar' }
  return null
}

// --- compute in-scope set ---------------------------------------------------
const refs = lock.references
const handAuthored = (p) => Boolean((refs[p] || {}).handAuthored)
let inScope
if (onlyFiles) {
  inScope = onlyFiles.filter(p => refs[p])
  const missing = onlyFiles.filter(p => !refs[p])
  if (missing.length) { console.error(`unknown reference(s): ${missing.join(', ')}`); process.exit(1) }
  const hand = inScope.filter(handAuthored)
  if (hand.length) {
    console.error(`hand-authored reference(s) cannot be regenerated (handAuthored: true, see CLAUDE.md §8): ${hand.join(', ')} — remove them from --only, or clear the flag in sources.lock.json if you really mean to rewrite them`)
    process.exit(1)
  }
} else if (mode === 'initial' && !forceRepos) {
  // --initial regenerates every generated reference, regardless of recorded SHAs
  inScope = Object.keys(refs).filter(p => !handAuthored(p))
} else {
  const healthNotes = []
  inScope = Object.keys(refs).filter(p => {
    const ref = refs[p]
    if (handAuthored(p)) return false   // no sources and no provenance sidecar: never auto-scoped
    if (forceRepos) return (ref.sources || []).some(s => forceRepos.includes(s.repo))
    if (refStale(ref)) return true
    const bad = refUnhealthyReason(p)            // self-heal: re-scope corrupt/unaccepted files
    if (bad) { healthNotes.push(`  ! ${p} (${bad})`); return true }
    return false
  })
  if (healthNotes.length)
    console.error(`self-heal: ${healthNotes.length} unhealthy file(s) re-scoped despite fresh SHAs:\n${healthNotes.join('\n')}`)
  // pull in pointer/linking files whose linksTo target is in scope (light recheck)
  const set = new Set(inScope)
  for (const [p, ref] of Object.entries(refs))
    if (!set.has(p) && !handAuthored(p) && (ref.linksTo || []).some(t => set.has(t))) inScope.push(p)
}

// --- diff hunks for incremental --------------------------------------------
function diffHunks(key, oldSha, curSha, paths) {
  if (!oldSha || !curSha || oldSha === curSha) return null
  const specs = (paths || []).map(p => p.replace(/\/\*\*$/, '').replace(/\{[^}]*\}/g, '')).filter(Boolean)
  try {
    const out = execFileSync('git', ['-C', clonePath(key), 'diff', '--stat', `${oldSha}..${curSha}`, '--', ...specs], { encoding: 'utf8' })
    const detail = execFileSync('git', ['-C', clonePath(key), 'diff', `${oldSha}..${curSha}`, '--', ...specs], { encoding: 'utf8' })
    return (out + '\n' + detail).slice(0, 6000)
  } catch { return null }
}

// --- read condensed authoring rules + guardrail (stable text) --------------
const rulesText = readFileSync(join(ROOT, 'maintenance/authoring-rules.md'), 'utf8')
const guardrailMatch = rulesText.match(/## Shipped-vs-planned guardrail[\s\S]*$/)
const shippedVsPlannedText = guardrailMatch ? guardrailMatch[0] : ''

// --- build manifest ---------------------------------------------------------
const files = inScope.map(path => {
  const ref = refs[path]
  const sources = (ref.sources || []).map(s => {
    const r = lock.repos[s.repo] || {}
    const git = isGitRepo(s.repo, r)
    return {
      repo: s.repo, kind: r.kind || 'git', paths: s.paths || [],
      cachePath: git ? clonePath(s.repo) : null,
      sha: currentSha(s.repo), branch: r.branch || null, url: r.url || null,
    }
  })
  let diff = null
  if (mode === 'incremental' && !onlyFiles && !forceRepos) {
    for (const s of ref.sources || []) {
      const r = lock.repos[s.repo] || {}
      if (!isGitRepo(s.repo, r)) continue
      const d = diffHunks(s.repo, (ref.lastGeneratedSha || {})[s.repo], currentSha(s.repo), r.pathsOfInterest)
      if (d) diff = (diff || '') + `\n### ${s.repo}\n` + d
    }
  }
  const abs = join(ROOT, path)
  return {
    path, role: ref.role, covers: ref.covers, linksTo: ref.linksTo || [],
    sources,
    priorMarkdown: existsSync(abs) ? readFileSync(abs, 'utf8') : '',
    priorProvenance: (() => {
      const sk = path.split('/')[1], fn = path.split('/').pop().replace(/\.md$/, '.json')
      const pp = join(ROOT, 'maintenance/provenance', sk, fn)
      return existsSync(pp) ? JSON.parse(readFileSync(pp, 'utf8')) : null
    })(),
    diffHunks: diff,
  }
})

// cross-file consistency inputs: for each in-scope file, the small set it could contradict;
// plus the on-disk content of any set member NOT regenerated this run (the workflow compares
// in-scope files against fresh output and the rest against this corpus). The sandbox can't read
// fs, so we hand it everything it needs.
const inScopeSet = new Set(inScope)
const comparisonSets = {}
const corpusPaths = new Set()
for (const p of inScope) {
  const set = selectComparisonSet(p, refs)
  comparisonSets[p] = set
  for (const q of set) if (!inScopeSet.has(q)) corpusPaths.add(q)
}
const comparisonCorpus = {}
for (const q of corpusPaths) {
  const abs = join(ROOT, q)
  if (existsSync(abs)) comparisonCorpus[q] = { markdown: readFileSync(abs, 'utf8'), role: (refs[q] || {}).role || 'normal' }
}
const canonicalPaths = Object.keys(refs).filter(p => refs[p].role === 'canonical')

// testnet status (the command starts it before invoking the workflow)
let testnet = { up: false }
try {
  const status = execFileSync('bash', [join(ROOT, 'maintenance/snippets/testnet.sh'), 'status'], { encoding: 'utf8' })
  if (/running/.test(status)) {
    const ep = execFileSync('bash', [join(ROOT, 'maintenance/snippets/testnet.sh'), 'endpoints'], { encoding: 'utf8' })
    testnet = JSON.parse(ep)
  }
} catch { /* leave up:false */ }

const manifest = {
  mode, repoRoot: ROOT, cacheDir,
  snippetHarnessDir: join(ROOT, 'maintenance/snippets'),
  rulesText, shippedVsPlannedText, testnet,
  layout: Object.keys(refs),
  comparisonSets, comparisonCorpus, canonicalPaths,
  files,
}

// --- write split workflow inputs --------------------------------------------
// The workflow ingests its manifest through agents, and a single agent cannot echo a blob larger
// than its per-response token budget (~25k tokens). The full manifest (comparisonCorpus alone is
// 100k+ chars) blows past that, so hand the workflow a slim header plus per-corpus side files it
// loads concurrently. priorMarkdown/priorProvenance are dropped here: the research stage regenerates
// from sources and never reads the prior file, so they are dead weight for the workflow.
const wfDir = (val('--wf-dir') || '/tmp/sync-wf')
rmSync(wfDir, { recursive: true, force: true })
mkdirSync(wfDir, { recursive: true })
const corpusSlices = {}
let corpusIdx = 0
for (const [p, v] of Object.entries(comparisonCorpus)) {
  const fn = `corpus-${corpusIdx++}.json`
  writeFileSync(join(wfDir, fn), JSON.stringify({ path: p, markdown: v.markdown, role: v.role }))
  corpusSlices[p] = fn
}
const wfHeader = {
  mode, repoRoot: ROOT, cacheDir,
  snippetHarnessDir: join(ROOT, 'maintenance/snippets'),
  rulesText, shippedVsPlannedText, testnet,
  layout: Object.keys(refs),
  comparisonSets, canonicalPaths, corpusSlices,
  files: files.map(({ priorMarkdown, priorProvenance, ...rest }) => rest),
}
writeFileSync(join(wfDir, 'header.json'), JSON.stringify(wfHeader, null, 2))
console.error(`wf split: header ${(JSON.stringify(wfHeader).length / 1024).toFixed(1)}KB + ${corpusIdx} corpus slice(s) -> ${wfDir}`)

// summary to stderr (stdout is pure JSON for piping)
console.error(`mode=${mode}  in-scope=${files.length}/${Object.keys(refs).length}  testnet=${testnet.up ? 'up' : 'down'}`)
console.error(files.map(f => `  - ${f.path}`).join('\n'))
process.stdout.write(JSON.stringify(manifest, null, 2))
