#!/usr/bin/env node
// Apply a finished workflow run: write generated markdown, write provenance sidecars, and
// bump SHAs in sources.lock.json. Per-file lastGeneratedSha advances ONLY for accepted files,
// so a file that failed its gate stays stale and is re-attempted next run.
//
//   node maintenance/apply-run.mjs --report /tmp/report.json --manifest /tmp/manifest.json
//   add --dry-run to print what would change without writing.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkReference } from './lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }
const DRY = argv.includes('--dry-run')

const report = JSON.parse(readFileSync(val('--report'), 'utf8'))
const manifest = JSON.parse(readFileSync(val('--manifest'), 'utf8'))
const lockPath = join(ROOT, 'maintenance/sources.lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

const manifestByPath = Object.fromEntries((manifest.files || []).map(f => [f.path, f]))
const now = new Date().toISOString()
const log = []

// Restore a reference's live path to its committed state (or remove it if untracked/new). Used to
// undo any in-run subagent pollution of a gated file — apply-run is the only writer we trust, so a
// file that fails the gate must be left exactly as HEAD had it, not as a subagent left it on disk.
function restoreToHead(relPath, abs) {
  try { execFileSync('git', ['-C', ROOT, 'checkout', 'HEAD', '--', relPath], { stdio: 'pipe' }); return }
  catch { /* path not in HEAD — a newly added file the run created */ }
  try { if (existsSync(abs)) rmSync(abs) } catch { /* best effort */ }
}

// Snippet subagents run in temp dirs, but one occasionally leaks scratch (e.g. src/) into the repo
// root; remove untracked scratch there so it can never be staged. (Only touches untracked files.)
if (!DRY) { try { execFileSync('git', ['-C', ROOT, 'clean', '-fdq', 'src'], { stdio: 'pipe' }) } catch { /* best effort */ } }

let written = 0, accepted = 0, rejected = 0, bumpedRepos = new Set()
for (const r of report.files || []) {
  const mf = manifestByPath[r.path]
  const abs = join(ROOT, r.path)
  const skill = r.path.split('/')[1]
  const base = r.path.split('/').pop().replace(/\.md$/, '')
  const role = r.role || 'normal'
  const md = r.finalMarkdown || ''

  // Deterministic substance gate: even a file the workflow self-graded accept:true is parked if
  // its body isn't a real reference doc (a finalize-log/stub landed in finalMarkdown). The live
  // reference is left untouched and its SHA is NOT bumped, so the next run re-attempts it. This is
  // the last line of defense behind the workflow's own gate — apply never trusts the report blindly.
  const check = md ? checkReference(md, { role, reportedWordCount: r.wordCount ?? null })
                   : { ok: false, reasons: ['empty finalMarkdown'], stats: { words: 0 } }
  const realWords = md.split(/\s+/).filter(Boolean).length
  const accept = r.accept && check.ok

  // 1. write markdown — only when accepted AND substantive; everything else is parked in a
  // .rejected.md sidecar for inspection, never written to skills/**.
  if (md) {
    const body = md.endsWith('\n') ? md : md + '\n'
    if (accept) {
      if (!DRY) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body) }
      written++
    } else {
      const rejPath = join(ROOT, 'maintenance/provenance', skill, `${base}.rejected.md`)
      if (!DRY) { mkdirSync(dirname(rejPath), { recursive: true }); writeFileSync(rejPath, body) }
      rejected++
    }
  }

  // 1b. Defense-in-depth: a subagent may have written a gated file straight to its live path during
  // the run (observed once), which would let ungated content survive on disk. For any non-accepted
  // file, restore the live path to HEAD (or remove it if new) so "parked/left stale" is literally true.
  if (!accept && !DRY) restoreToHead(r.path, abs)

  // 2. provenance sidecar — record the EFFECTIVE accept and the REAL word count (computed from the
  // bytes, never the agent's self-report) so the sidecar can never disagree with the file on disk.
  const fn = `${base}.json`
  const provPath = join(ROOT, 'maintenance/provenance', skill, fn)
  const sidecar = {
    path: r.path, role: r.role, accept, generatedAt: now,
    sourcesUsed: r.sourcesUsed || [], provenance: r.provenance || [],
    snippet: r.snippet || null, factCheck: r.factCheck || null,
    guardrailViolations: r.guardrailViolations || [], wordCount: realWords,
    substance: { ok: check.ok, reasons: check.reasons },
  }
  if (!DRY) { mkdirSync(dirname(provPath), { recursive: true }); writeFileSync(provPath, JSON.stringify(sidecar, null, 2) + '\n') }

  // 3. bump per-file lastGeneratedSha ONLY on an effective accept
  if (accept) {
    accepted++
    const ref = lock.references[r.path]
    if (ref && mf) {
      ref.lastGeneratedSha = ref.lastGeneratedSha || {}
      for (const s of mf.sources || []) { if (s.sha) { ref.lastGeneratedSha[s.repo] = s.sha; bumpedRepos.add(s.repo) } }
    }
    log.push(`  ✓ ${r.path} (accepted)`)
  } else if (r.accept && !check.ok) {
    log.push(`  ✗ ${r.path} (workflow accepted but FAILED substance gate — parked, SHA held): ${check.reasons.join('; ')}`)
  } else {
    log.push(`  ⚠ ${r.path} (gate failed — left stale, will retry): ${(r.blocking || []).join('; ')}`)
  }
}

// 4. bump repo lastSeenSha (informational) for every repo we touched this run
for (const f of manifest.files || []) for (const s of f.sources || []) {
  if (s.sha && lock.repos[s.repo]) lock.repos[s.repo].lastSeenSha = s.sha
}

if (!DRY) writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

console.log(`${DRY ? '[dry-run] ' : ''}wrote ${written} accepted file(s), parked ${rejected} rejected draft(s); ${accepted} SHA-bumped for ${bumpedRepos.size} repo(s)`)
console.log(log.join('\n'))
if (report.copyCheck?.flags?.length) {
  console.log(`\ncanonical-copy flags (review):`)
  for (const fl of report.copyCheck.flags) console.log(`  - ${fl.file} ~ ${fl.canonical} (${fl.overlap})`)
}
if (report.reconciliation?.proposals?.filter(p => p.type !== 'none').length) {
  console.log(`\nreconciliation proposals (human decision — trigger edits NOT auto-applied):`)
  for (const p of report.reconciliation.proposals) if (p.type !== 'none') console.log(`  - [${p.type}] ${p.targetFile}: ${p.rationale}`)
}
if (report.consistency?.gated?.length || report.consistency?.flags?.length) {
  console.log(`\ncross-file consistency:`)
  for (const p of report.consistency.gated || []) console.log(`  ✗ ${p} (auto-gated — contradicts a canonical file; parked, SHA held)`)
  for (const c of report.consistency.flags || []) console.log(`  - ${c.aPath} ~ ${c.bPath} on "${c.topic}" (review): ${c.reason}`)
}
