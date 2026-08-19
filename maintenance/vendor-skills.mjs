#!/usr/bin/env node
// Copy upstream-authored SKILL.md files into skills/ verbatim.
//
//   node maintenance/vendor-skills.mjs            # copy every entry in lock.vendoredSkills
//   node maintenance/vendor-skills.mjs --check    # exit 1 if any file is out of date (CI)
//
// This is deliberately NOT part of the plan-run/apply-run pipeline. That pipeline uses an LLM to
// GENERATE references/*.md; a vendored skill is a hand-tuned upstream document and must survive
// byte-for-byte, so it is copied, never regenerated. Only the YAML frontmatter is local — see the
// `frontmatter` key in sources.lock.json and the note beside it.
//
// The copy is idempotent, so there is no staleness/SHA bookkeeping: run it every sync and git shows
// no diff when upstream hasn't moved.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkReference } from './lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- source resolution ------------------------------------------------------
// Sources are tried in declared order: upstream checkout first, public endpoint last. Refresh the
// checkout's tracked branch and read its committed blob rather than trusting a possibly stale or
// dirty worktree. If that refresh fails, the public endpoint remains available as the fallback.
export function fromGit(spec, { cacheDir, repos }) {
  const clone = join(cacheDir, spec.repo)
  const branch = repos[spec.repo]?.branch
  if (!branch || !existsSync(join(clone, '.git'))) return null
  try {
    execFileSync('git', ['-C', clone, 'fetch', '--quiet', 'origin', branch], { maxBuffer: 16 << 20 })
    const body = execFileSync('git', ['-C', clone, 'show', `FETCH_HEAD:${spec.path}`], {
      encoding: 'utf8', maxBuffer: 16 << 20,
    })
    return { body, origin: `${spec.repo}:${spec.path}` }
  } catch { return null }
}

function fromEndpoint(spec) {
  try {
    const body = execFileSync('curl', ['-sSf', '-m', '30', '-L', spec.endpoint], { encoding: 'utf8', maxBuffer: 16 << 20 })
    return { body, origin: spec.endpoint }
  } catch { return null }
}

function resolveBody(from, context) {
  const tried = []
  for (const spec of from) {
    const got = spec.endpoint ? fromEndpoint(spec) : fromGit(spec, context)
    if (got && got.body.trim()) return { ...got, tried }
    tried.push(spec.endpoint || `${spec.repo}:${spec.path}`)
  }
  return { body: null, origin: null, tried }
}

// --- transforms -------------------------------------------------------------
const stripFrontmatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, '')

// Mirrors nexus-scout's own strip_frontmatter(): /llms.txt already arrives without a header, a repo
// checkout arrives with one. Normalising both to a bare body keeps the two sources interchangeable.
function renderFrontmatter(fm) {
  // Quote only what YAML needs quoting, to match the hand-written sibling SKILL.md files
  // (`author: pubky` bare, `version: "0.1.0"` quoted so it isn't read as a number).
  const scalar = (v) => (/^[A-Za-z][\w-]*$/.test(String(v)) ? String(v) : JSON.stringify(v))
  const lines = ['---', `name: ${fm.name}`, `description: ${JSON.stringify(fm.description)}`]
  if (fm.metadata) {
    lines.push('metadata:')
    for (const [k, v] of Object.entries(fm.metadata)) lines.push(`  ${k}: ${scalar(v)}`)
  }
  lines.push('---', '', '')
  return lines.join('\n')
}

// verify.mjs resolves relative links and #anchor targets inside skills/, so a relative link that
// upstream adds later would turn into a blocking failure here. Catch it at copy time instead.
function relativeLinks(md) {
  const out = []
  for (const m of md.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const t = m[1].trim()
    if (!/^(https?:|mailto:|#)/i.test(t)) out.push(t)
  }
  return out
}

// --- copy -------------------------------------------------------------------
function main() {
  const checkOnly = process.argv.includes('--check')
  const lock = JSON.parse(readFileSync(join(ROOT, 'maintenance/sources.lock.json'), 'utf8'))
  const cacheDir = (lock.cacheDir || '~/.cache/pubky-agent-skills/upstream').replace(/^~/, process.env.HOME)
  const context = { cacheDir, repos: lock.repos || {} }
  let changed = 0, failed = 0

  for (const [relPath, entry] of Object.entries(lock.vendoredSkills || {})) {
    const { body, origin, tried } = resolveBody(entry.from || [], context)
    if (!body) {
      console.error(`✗ ${relPath}: no source available (tried ${tried.join(', ')})`)
      failed++
      continue
    }

    // Normalise both source shapes to the same bare body: a repo checkout arrives with a YAML
    // header (stripping it leaves a leading blank line), /llms.txt arrives without one. Trim both
    // ends so the two sources are byte-for-byte interchangeable.
    const upstream = stripFrontmatter(body).replace(/^\s*/, '').replace(/\s*$/, '\n')

    // Reuse the pipeline's substance gate so a truncated fetch or an HTML error page can never land
    // in skills/. Role 'normal' == the 120-word floor.
    const sub = checkReference(upstream, { role: 'normal' })
    if (!sub.ok) {
      console.error(`✗ ${relPath}: body from ${origin} failed the substance gate — ${sub.reasons.join('; ')}`)
      failed++
      continue
    }
    const rel = relativeLinks(upstream)
    if (rel.length) {
      console.error(`✗ ${relPath}: upstream added relative link(s) [${rel.join(', ')}] — verify.mjs would block; fix upstream or vendor with a rewrite`)
      failed++
      continue
    }

    const next = renderFrontmatter(entry.frontmatter) + upstream
    const abs = join(ROOT, relPath)
    const prev = existsSync(abs) ? readFileSync(abs, 'utf8') : null

    if (prev === next) { console.log(`= ${relPath} unchanged (${origin})`); continue }
    changed++
    if (checkOnly) { console.error(`✗ ${relPath}: out of date vs ${origin}`); failed++; continue }

    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, next)
    const words = upstream.split(/\s+/).filter(Boolean).length
    console.log(`${prev ? '~' : '+'} ${relPath} ${prev ? 'updated' : 'created'} from ${origin} (${words} words verbatim)`)
  }

  if (failed) process.exit(1)
  if (!changed) console.log('all vendored skills up to date')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
