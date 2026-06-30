// Shared deterministic checks for the reference-sync system. ONE definition, imported by:
//   - plan-run.mjs  (staleness: re-scope a corrupt/unaccepted file even if its SHAs were bumped)
//   - apply-run.mjs (write gate: never write a non-document, never bump its SHA)
//   - verify.mjs    (CI gate: corruption is PR-blocking, can't reach "0 blocking")
//
// NOTE: the Workflow sandbox (sync-references.workflow.js) cannot import Node modules, so it
// carries a compact inline copy of this logic (`stubReasons`). Keep the two in sync.

const FINALIZE_LOG_FIRST = /^(done|finalize|finalized|gate:|fixes applied)\b/i

// Is this markdown a real reference document, or an agent finalize-log / stub written into the
// wrong field? Deterministic (no fs, no network). Returns { ok, reasons[], stats }.
//
// The dominant signal is "has at least one markdown heading" — every real reference file has
// many (4+), and the failure mode (a status line written into finalMarkdown) has none. Word
// floor, fence balance, the finalize-log denylist, and the reported-word-count divergence are
// independent backstops.
export function checkReference(md, { role = 'normal', reportedWordCount = null } = {}) {
  const text = (md || '').trim()
  const reasons = []
  const words = text ? text.split(/\s+/).length : 0
  const headings = (text.match(/^#{1,6}\s/gm) || []).length
  const fenceLines = (text.match(/^```/gm) || []).length
  const firstLine = (text.split('\n').find(l => l.trim()) || '').trim()

  const minWords = role === 'pointer' ? 60 : 120 // thinnest real file today is 659 words
  if (words < minWords) reasons.push(`body too short: ${words} words (< ${minWords})`)
  if (headings < 1) reasons.push('no markdown heading — not a reference document')
  if (fenceLines % 2 !== 0) reasons.push(`unbalanced code fences: ${fenceLines} \`\`\` lines`)
  if (FINALIZE_LOG_FIRST.test(firstLine) || /\bgate:\s*accept=/i.test(text) || /\bfile finalized\b/i.test(text))
    reasons.push(`looks like an agent finalize-log, not docs (starts "${firstLine.slice(0, 48)}")`)
  if (reportedWordCount != null && words > 0 && words < reportedWordCount * 0.5)
    reasons.push(`body word count ${words} is far below the reported ${reportedWordCount} — wrong field written?`)

  return { ok: reasons.length === 0, reasons, stats: { words, headings, fenceLines } }
}

// GitHub-style heading slug, for verifying that #anchor links resolve to a real heading.
// Lowercase, drop punctuation (keep word chars / spaces / hyphens), spaces -> hyphens.
export function slugifyHeading(h) {
  return h.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')
}

// ---------------------------------------------------------------------------
// Snippet audit — never trust a self-graded tier. Demote a "pass" at an
// execution tier that lacks the command+evidence that would corroborate it, and
// flag tier downgrades / bash commands that were only surface-checked. Pure;
// MIRRORED INLINE in the workflow sandbox (sync-references.workflow.js, which
// cannot import this file) — keep the two in sync.
// ---------------------------------------------------------------------------
const TIER_RANK = { lint: 0, surface: 1, compiled: 2, executed: 3 }

export function auditSnippets(results, draftSnippets = []) {
  const expected = Object.fromEntries((draftSnippets || []).map(s => [s.id, s.expectedTier]))
  const notes = []
  const audited = (results || []).map(r => {
    const out = { ...r }
    const corroborated = r.command && r.command.trim() && r.evidence && r.evidence.trim()
    if (r.status === 'pass' && (r.tier === 'executed' || r.tier === 'compiled') && !corroborated) {
      out.status = 'unverifiable'
      notes.push(`${r.id}: claimed ${r.tier}/pass without command+evidence — demoted to unverifiable`)
    }
    if (r.status === 'pass' && r.lang === 'bash' && r.tier === 'surface')
      notes.push(`${r.id}: bash command only surface-checked — invoke the real tool (--help/--dry-run/config) to validate flags`)
    const exp = expected[r.id]
    if (exp && TIER_RANK[r.tier] < TIER_RANK[exp])
      notes.push(`${r.id}: tier ${r.tier} below expected ${exp}`)
    return out
  })
  return { results: audited, notes }
}

// ---------------------------------------------------------------------------
// Cross-file consistency helpers (adaptive — derived from the lock, no Pubky
// facts baked in). selectComparisonSet runs in plan-run (real fs); the other two
// are MIRRORED INLINE in the workflow — keep in sync.
// ---------------------------------------------------------------------------

// For a reference, the small set of files it could plausibly contradict: every
// canonical file + its linksTo targets + files sharing an upstream source repo.
// Keeps the cross-check off N^2 without hardcoding which files relate.
export function selectComparisonSet(path, refs) {
  const ref = refs[path]
  if (!ref) return []
  const canonical = Object.keys(refs).filter(p => refs[p].role === 'canonical')
  const myRepos = new Set((ref.sources || []).map(s => s.repo))
  const sharesRepo = (p) => (refs[p].sources || []).some(s => myRepos.has(s.repo))
  const set = new Set([
    ...canonical,
    ...(ref.linksTo || []),
    ...Object.keys(refs).filter(p => p !== path && sharesRepo(p)),
  ])
  set.delete(path)
  return Array.from(set).filter(p => refs[p])   // linksTo may name a not-yet-real file
}

// Collapse A-vs-B and B-vs-A on the same topic to one record; keep higher confidence.
export function dedupeContradictions(list) {
  const byKey = new Map()
  for (const c of list || []) {
    const key = JSON.stringify([[c.aPath, c.bPath].sort(), c.topic || ''])
    const prev = byKey.get(key)
    if (!prev || (c.confidence || 0) > (prev.confidence || 0)) byKey.set(key, c)
  }
  return Array.from(byKey.values())
}

// Decide auto-gate vs human-flag. Auto-gate ONLY the safe, narrow case: a
// non-canonical file that, with high confidence, contradicts a canonical file.
// Everything else (sibling-vs-sibling, low confidence, a canonical file itself
// being contradicted) is surfaced for a human — no auto-block on LLM noise.
export function consistencyGate(contradictions, canonicalPaths = [], minConfidence = 0.7) {
  const canon = new Set(canonicalPaths)
  const gate = new Map()   // path -> reason
  const flags = []
  for (const c of contradictions || []) {
    const involvesCanon = canon.has(c.aPath) || canon.has(c.bPath)
    const weaker = c.weakerPath
    const autoGate = involvesCanon && weaker && !canon.has(weaker) && (c.confidence || 0) >= minConfidence
    if (autoGate) {
      const other = weaker === c.aPath ? c.bPath : c.aPath
      if (!gate.has(weaker)) gate.set(weaker, `contradicts canonical ${other} on "${c.topic}": ${c.reason}`)
    } else {
      flags.push(c)
    }
  }
  return { gate, flags }
}
