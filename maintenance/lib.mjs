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
