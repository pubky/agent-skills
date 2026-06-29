#!/usr/bin/env node
// Apply a finished workflow run: write generated markdown, write provenance sidecars, and
// bump SHAs in sources.lock.json. Per-file lastGeneratedSha advances ONLY for accepted files,
// so a file that failed its gate stays stale and is re-attempted next run.
//
//   node maintenance/apply-run.mjs --report /tmp/report.json --manifest /tmp/manifest.json
//   add --dry-run to print what would change without writing.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

let written = 0, accepted = 0, rejected = 0, bumpedRepos = new Set()
for (const r of report.files || []) {
  const mf = manifestByPath[r.path]
  const abs = join(ROOT, r.path)
  const skill = r.path.split('/')[1]
  const base = r.path.split('/').pop().replace(/\.md$/, '')

  // 1. write markdown — ONLY for accepted files. A gate-failed file must stay stale
  // (the on-disk reference is left untouched so it's re-attempted next run); its draft
  // is parked in a .rejected.md sidecar for inspection, never in skills/**.
  if (r.finalMarkdown) {
    const body = r.finalMarkdown.endsWith('\n') ? r.finalMarkdown : r.finalMarkdown + '\n'
    if (r.accept) {
      if (!DRY) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, body) }
      written++
    } else {
      const rejPath = join(ROOT, 'maintenance/provenance', skill, `${base}.rejected.md`)
      if (!DRY) { mkdirSync(dirname(rejPath), { recursive: true }); writeFileSync(rejPath, body) }
      rejected++
    }
  }

  // 2. provenance sidecar
  const fn = `${base}.json`
  const provPath = join(ROOT, 'maintenance/provenance', skill, fn)
  const sidecar = {
    path: r.path, role: r.role, accept: r.accept, generatedAt: now,
    sourcesUsed: r.sourcesUsed || [], provenance: r.provenance || [],
    snippet: r.snippet || null, factCheck: r.factCheck || null,
    guardrailViolations: r.guardrailViolations || [], wordCount: r.wordCount || null,
  }
  if (!DRY) { mkdirSync(dirname(provPath), { recursive: true }); writeFileSync(provPath, JSON.stringify(sidecar, null, 2) + '\n') }

  // 3. bump per-file lastGeneratedSha ONLY on accept
  if (r.accept) {
    accepted++
    const ref = lock.references[r.path]
    if (ref && mf) {
      ref.lastGeneratedSha = ref.lastGeneratedSha || {}
      for (const s of mf.sources || []) { if (s.sha) { ref.lastGeneratedSha[s.repo] = s.sha; bumpedRepos.add(s.repo) } }
    }
    log.push(`  ✓ ${r.path} (accepted)`)
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
