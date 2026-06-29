#!/usr/bin/env node
// Deterministic invariant checks for the Pubky agent-skills repo.
// Runs on the real, on-disk tree (call AFTER the workflow's markdown is written).
// Enforces the load-bearing rules in CLAUDE.md that don't need an LLM.
//
//   node maintenance/verify.mjs            # structural checks (offline)
//   node maintenance/verify.mjs --links    # also HTTP-check external links (slow, network)
//   node maintenance/verify.mjs --json     # machine-readable report on stdout
//
// Exit code 0 = no blocking failures; 1 = blocking failures present.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkReference, slugifyHeading } from './lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_LINKS = process.argv.includes('--links')
const AS_JSON = process.argv.includes('--json')

const LINE_BUDGET = 90      // per SKILL.md — keep it thin (largest today is 62)
const WORD_BUDGET = 800     // per SKILL.md (largest today is 604)
const DESC_BUDGET = 1200    // frontmatter description chars
const COPY_THRESHOLD = 0.18 // shingle-overlap ratio vs a canonical file

const SKILLS = ['pubky', 'pubky-mobile', 'pubky-infra']
const CANONICAL = [
  'skills/pubky/references/concepts.md',
  'skills/pubky/references/app-specs.md',
  'skills/pubky/references/shipped-vs-planned.md',
]
// distinctive trigger vocab per skill — a skill's POSITIVE trigger must not
// contain another skill's distinctive terms (mentions inside "NOT for" are fine)
const VOCAB = {
  'pubky-mobile': ['ios', 'android', 'swift', 'kotlin', 'react native', 'react-native', 'xcode', 'uniffi'],
  'pubky-infra': ['self-host', 'self-hosting', 'deploy', 'docker', 'nexusd', 'neo4j', 'umbrel', 'operating', 'operator'],
}

const findings = []
const add = (sev, check, detail) => findings.push({ sev, check, detail })
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

// --- frontmatter (light YAML) ----------------------------------------------
function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return null
  const body = m[1]
  const name = (body.match(/^name:\s*(.+)$/m) || [])[1]?.trim()
  // description may be a quoted block spanning lines until the next top-level key
  const dm = body.match(/^description:\s*([\s\S]*?)(?=\n[a-zA-Z_]+:|\n*$)/m)
  let description = dm ? dm[1].trim().replace(/^["']|["']$/g, '') : undefined
  return { name, description }
}

// --- 1. manifests parse + skill lists agree --------------------------------
let marketplace, plugin
try { marketplace = JSON.parse(read('.claude-plugin/marketplace.json')); add('ok', 'manifests', 'marketplace.json parses') }
catch (e) { add('blocking', 'manifests', `marketplace.json invalid: ${e.message}`) }
try { plugin = JSON.parse(read('.codex-plugin/plugin.json')); add('ok', 'manifests', 'plugin.json parses') }
catch (e) { add('blocking', 'manifests', `plugin.json invalid: ${e.message}`) }
try { JSON.parse(read('gemini-extension.json')); add('ok', 'manifests', 'gemini-extension.json parses') }
catch (e) { add('blocking', 'manifests', `gemini-extension.json invalid: ${e.message}`) }

const skillDirs = readdirSync(join(ROOT, 'skills')).filter(d => statSync(join(ROOT, 'skills', d)).isDirectory())
if (marketplace?.plugins?.[0]?.skills) {
  const declared = marketplace.plugins[0].skills.map(s => s.replace(/^\.\/skills\//, '')).sort()
  const actual = skillDirs.slice().sort()
  if (JSON.stringify(declared) !== JSON.stringify(actual))
    add('blocking', 'manifest-skills', `marketplace skills ${JSON.stringify(declared)} != folders ${JSON.stringify(actual)}`)
  else add('ok', 'manifest-skills', `marketplace skill list matches folders (${actual.join(', ')})`)
}

// --- per-skill checks -------------------------------------------------------
for (const skill of SKILLS) {
  const skillPath = `skills/${skill}/SKILL.md`
  if (!existsSync(join(ROOT, skillPath))) { add('blocking', 'skill-md', `missing ${skillPath}`); continue }
  const md = read(skillPath)
  const fm = frontmatter(md)

  // 2. name == dir, description present + NOT-for cross-refs
  if (!fm?.name) add('blocking', 'frontmatter', `${skillPath}: missing name`)
  else if (fm.name !== skill) add('blocking', 'frontmatter', `${skillPath}: name "${fm.name}" != dir "${skill}"`)
  if (!fm?.description) add('blocking', 'frontmatter', `${skillPath}: missing description`)
  else {
    if (fm.description.length > DESC_BUDGET) add('warn', 'desc-budget', `${skillPath}: description ${fm.description.length} > ${DESC_BUDGET} chars`)
    const others = SKILLS.filter(s => s !== skill)
    const notForOk = others.every(o => fm.description.toLowerCase().includes(o))
    if (!/not for/i.test(fm.description) || !notForOk)
      add('blocking', 'cross-ref', `${skillPath}: description must keep a "NOT for … (use <other-skill>)" pointer naming ${others.join(' & ')}`)
    else add('ok', 'cross-ref', `${skillPath}: NOT-for cross-refs intact`)

    // 3b. disjoint triggers: positive trigger (text before "NOT for") must not carry foreign vocab
    const positive = fm.description.toLowerCase().split(/not for/i)[0]
    for (const [otherSkill, terms] of Object.entries(VOCAB)) {
      if (otherSkill === skill) continue
      const leaked = terms.filter(t => positive.includes(t))
      if (leaked.length) add('warn', 'trigger-overlap', `${skillPath}: positive trigger contains ${otherSkill} vocab [${leaked.join(', ')}] — verify triggers stay disjoint`)
    }
  }

  // 3. thinness budget
  const lines = md.split('\n').length, words = md.split(/\s+/).filter(Boolean).length
  if (lines > LINE_BUDGET || words > WORD_BUDGET)
    add('warn', 'thinness', `${skillPath}: ${lines} lines / ${words} words exceeds budget ${LINE_BUDGET}/${WORD_BUDGET}`)
  else add('ok', 'thinness', `${skillPath}: ${lines} lines / ${words} words (budget ${LINE_BUDGET}/${WORD_BUDGET})`)

  // 4. routing-table <-> reference-file bijection
  const refDir = `skills/${skill}/references`
  const refFiles = existsSync(join(ROOT, refDir))
    ? readdirSync(join(ROOT, refDir)).filter(f => f.endsWith('.md'))
    : []
  // Routing entries live in the markdown ROUTING TABLE; only scan table rows so we
  // don't pick up prose mentions of another skill's references (e.g. pubky-mobile
  // pointing readers at the pubky skill's `references/concepts.md`).
  const routed = new Set()
  for (const line of md.split('\n')) {
    if (!/^\s*\|.*\|/.test(line)) continue
    for (const m of line.matchAll(/references\/([a-z0-9-]+\.md)/gi)) routed.add(m[1])
  }
  for (const rf of refFiles)
    if (!routed.has(rf)) add('blocking', 'routing', `${skillPath}: reference ${rf} exists but is not in the routing table`)
  for (const rr of routed)
    if (!refFiles.includes(rr)) add('blocking', 'routing', `${skillPath}: routing table points to references/${rr} which does not exist`)
  if (refFiles.length && refFiles.every(rf => routed.has(rf)))
    add('ok', 'routing', `${skill}: all ${refFiles.length} references are routed`)
}

// --- 5. relative links in references resolve -------------------------------
const allRefs = []
for (const skill of SKILLS) {
  const refDir = `skills/${skill}/references`
  if (!existsSync(join(ROOT, refDir))) continue
  for (const f of readdirSync(join(ROOT, refDir)).filter(f => f.endsWith('.md'))) allRefs.push(`${refDir}/${f}`)
}
// --- 5a. reference substance: a finalize-log / stub written as content is PR-blocking ----------
// roles drive the word floor (pointer files are legitimately thin); default to 'normal' if absent.
let refRoles = {}
try {
  const lk = JSON.parse(read('maintenance/sources.lock.json'))
  for (const [p, r] of Object.entries(lk.references || {})) refRoles[p] = r.role || 'normal'
} catch { /* sources.lock.json missing/invalid — all roles default to normal */ }
for (const ref of allRefs) {
  const res = checkReference(read(ref), { role: refRoles[ref] || 'normal' })
  if (!res.ok) add('blocking', 'substance', `${ref}: ${res.reasons.join('; ')}`)
}
add('ok', 'substance', `reference substance checked across ${allRefs.length} files`)

// --- 5b. relative links resolve, AND #anchors point at a real heading in the target -----------
const externalUrls = new Set()
const headingCache = {}
const headingsOf = (absPath) => {
  if (absPath in headingCache) return headingCache[absPath]
  const set = new Set()
  try { for (const m of readFileSync(absPath, 'utf8').matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) set.add(slugifyHeading(m[1])) }
  catch { /* unreadable target -> empty set; existence is checked separately */ }
  return (headingCache[absPath] = set)
}
for (const ref of allRefs) {
  const md = read(ref)
  const refAbs = join(ROOT, ref)
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = m[1].split(' ')[0]                 // drop an optional "title"
    const hashIdx = raw.indexOf('#')
    const target = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
    const anchor = hashIdx >= 0 ? raw.slice(hashIdx + 1) : ''
    if (/^https?:\/\//.test(target)) { externalUrls.add(target); continue }
    if (target.startsWith('mailto:')) continue
    let targetAbs = refAbs                          // empty target => same-file anchor
    if (target) {
      targetAbs = resolve(dirname(refAbs), target)
      if (!existsSync(targetAbs)) { add('blocking', 'rel-link', `${ref}: broken relative link -> ${target}`); continue }
    }
    if (anchor && /\.md$/.test(targetAbs) && !headingsOf(targetAbs).has(slugifyHeading(anchor)))
      add('blocking', 'rel-link', `${ref}: link -> ${target || '(self)'}#${anchor} has no matching heading in target`)
  }
}
add('ok', 'rel-link', `relative links + #anchors checked across ${allRefs.length} reference files`)

// --- 6. canonical-copy (disk shingle overlap) ------------------------------
function shingles(text, n = 8) {
  const w = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const s = new Set()
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '))
  return s
}
function overlap(a, b) {
  const sa = shingles(a), sb = shingles(b)
  if (!sa.size || !sb.size) return 0
  let hit = 0; for (const x of sa) if (sb.has(x)) hit++
  return hit / sa.size
}
const canonTexts = CANONICAL.filter(c => existsSync(join(ROOT, c))).map(c => ({ path: c, text: read(c) }))
for (const ref of allRefs) {
  if (CANONICAL.includes(ref)) continue
  const text = read(ref)
  for (const c of canonTexts) {
    const r = overlap(text, c.text)
    if (r >= COPY_THRESHOLD)
      add('blocking', 'canonical-copy', `${ref}: ${(r * 100).toFixed(0)}% shingle overlap with canonical ${c.path} — LINK, don't restate`)
  }
}
if (canonTexts.length) add('ok', 'canonical-copy', `canonical-copy checked (threshold ${COPY_THRESHOLD})`)

// --- 7. external links (opt-in) --------------------------------------------
if (CHECK_LINKS) {
  // npm/crates web pages bot-block (403/404) even when the package exists — verify via their
  // registry APIs instead so we still catch real typos without false positives.
  const apiFor = (url) => {
    let m
    if ((m = url.match(/^https?:\/\/(?:www\.)?npmjs\.com\/package\/(@?[^/?#]+(?:\/[^/?#]+)?)/))) return `https://registry.npmjs.org/${m[1]}`
    if ((m = url.match(/^https?:\/\/crates\.io\/crates\/([^/?#]+)/))) return `https://crates.io/api/v1/crates/${m[1]}`
    return url
  }
  for (const url of externalUrls) {
    const target = apiFor(url)
    try {
      const code = Number(execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-L', '--max-time', '20',
        '-A', 'Mozilla/5.0 (compatible; pubky-agent-skills link-check)', '-r', '0-0', target], { encoding: 'utf8' }).trim())
      if (code >= 400) add('warn', 'ext-link', `${url} -> HTTP ${code}${target !== url ? ` (via ${target})` : ''}`)
    } catch { add('warn', 'ext-link', `${url} -> unreachable`) }
  }
  add('ok', 'ext-link', `external links checked (${externalUrls.size})`)
} else if (externalUrls.size) {
  add('info', 'ext-link', `${externalUrls.size} external links found (run with --links to verify)`)
}

// --- report -----------------------------------------------------------------
const blocking = findings.filter(f => f.sev === 'blocking')
const warn = findings.filter(f => f.sev === 'warn')
if (AS_JSON) {
  console.log(JSON.stringify({ blocking: blocking.length, warnings: warn.length, findings }, null, 2))
} else {
  const icon = { ok: '✓', info: 'ℹ', warn: '⚠', blocking: '✗' }
  for (const f of findings) if (f.sev !== 'ok') console.log(`${icon[f.sev]} [${f.check}] ${f.detail}`)
  console.log(`\n${blocking.length ? '✗' : '✓'} ${blocking.length} blocking, ${warn.length} warnings, ${findings.filter(f=>f.sev==='ok').length} passed`)
}
process.exit(blocking.length ? 1 : 0)
