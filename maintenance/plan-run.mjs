#!/usr/bin/env node
// Build the workflow job manifest from sources.lock.json + the local clones.
// Deterministic so the workflow's resume cache stays warm across re-runs.
//
//   node maintenance/plan-run.mjs --initial                          > /tmp/manifest.json
//   node maintenance/plan-run.mjs                                    > /tmp/manifest.json  # incremental
//   node maintenance/plan-run.mjs --repos pubky-core,pubky-nexus     > /tmp/manifest.json
//   node maintenance/plan-run.mjs --only skills/pubky/references/concepts.md,...  > /tmp/manifest.json
//
// Reads current SHAs from clones under cacheDir; clones must already exist (the command clones).

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

// --- compute in-scope set ---------------------------------------------------
const refs = lock.references
let inScope
if (onlyFiles) {
  inScope = onlyFiles.filter(p => refs[p])
  const missing = onlyFiles.filter(p => !refs[p])
  if (missing.length) { console.error(`unknown reference(s): ${missing.join(', ')}`); process.exit(1) }
} else if (mode === 'initial' && !forceRepos) {
  inScope = Object.keys(refs)   // --initial regenerates every reference, regardless of recorded SHAs
} else {
  inScope = Object.keys(refs).filter(p => {
    const ref = refs[p]
    if (forceRepos) return (ref.sources || []).some(s => forceRepos.includes(s.repo))
    return refStale(ref)
  })
  // pull in pointer/linking files whose linksTo target is in scope (light recheck)
  const set = new Set(inScope)
  for (const [p, ref] of Object.entries(refs))
    if (!set.has(p) && (ref.linksTo || []).some(t => set.has(t))) inScope.push(p)
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
  files,
}

// summary to stderr (stdout is pure JSON for piping)
console.error(`mode=${mode}  in-scope=${files.length}/${Object.keys(refs).length}  testnet=${testnet.up ? 'up' : 'down'}`)
console.error(files.map(f => `  - ${f.path}`).join('\n'))
process.stdout.write(JSON.stringify(manifest, null, 2))
