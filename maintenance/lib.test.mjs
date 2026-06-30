#!/usr/bin/env node
// Offline unit tests for the pure deterministic helpers in lib.mjs.
//   node maintenance/lib.test.mjs   # exit 0 = all pass, 1 = failure
// These cover the logic the workflow's LLM stages can't be trusted to self-grade.

import {
  checkReference, slugifyHeading, auditSnippets,
  selectComparisonSet, dedupeContradictions, consistencyGate,
} from './lib.mjs'

let failed = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) { failed++; console.log(`✗ ${name}\n    got:  ${g}\n    want: ${w}`) }
  else console.log(`✓ ${name}`)
}
const ok = (name, cond) => eq(name, !!cond, true)

// --- checkReference ---------------------------------------------------------
ok('checkReference: real doc passes',
  checkReference('# Title\n\nA real reference with enough words ' + 'word '.repeat(150) + '\n\n## Section\n').ok)
ok('checkReference: finalize-log fails',
  !checkReference('Finalized foo.md. Gate: accept=true.\n\nFixes applied:\n1. x').ok)
ok('checkReference: tiny stub fails', !checkReference('finalize complete').ok)
ok('checkReference: no-heading long prose fails',
  !checkReference('word '.repeat(300)).ok)
ok('checkReference: unbalanced fences fails',
  !checkReference('# T\n' + 'word '.repeat(150) + '\n```js\ncode\n').ok)
ok('checkReference: reported-wordcount divergence fails',
  !checkReference('# T\n## S\n' + 'word '.repeat(150), { reportedWordCount: 2000 }).ok)

// --- slugifyHeading ---------------------------------------------------------
eq('slugifyHeading: code+punct', slugifyHeading('`EventListener` is a placeholder, not a stream'),
  'eventlistener-is-a-placeholder-not-a-stream')
eq('slugifyHeading: simple', slugifyHeading('Signup tokens'), 'signup-tokens')

// --- auditSnippets ----------------------------------------------------------
{
  const draft = [{ id: 'a', expectedTier: 'executed' }, { id: 'b', expectedTier: 'surface' }, { id: 'c', expectedTier: 'executed' }]
  const { results, notes } = auditSnippets([
    { id: 'a', lang: 'rust', tier: 'executed', status: 'pass' },                 // no command/evidence -> demote
    { id: 'b', lang: 'bash', tier: 'surface', status: 'pass', command: 'x', evidence: 'y' }, // bash surface -> flag
    { id: 'c', lang: 'rust', tier: 'compiled', status: 'pass', command: 'cargo build', evidence: 'Finished' }, // corroborated but downgraded
  ], draft)
  eq('auditSnippets: uncorroborated executed demoted', results.find(r => r.id === 'a').status, 'unverifiable')
  eq('auditSnippets: corroborated pass kept', results.find(r => r.id === 'c').status, 'pass')
  ok('auditSnippets: bash-surface flagged', notes.some(n => n.startsWith('b:') && /surface-checked/.test(n)))
  ok('auditSnippets: downgrade flagged', notes.some(n => n.startsWith('c:') && /below expected/.test(n)))
}

// --- selectComparisonSet ----------------------------------------------------
{
  const refs = {
    'C.md': { role: 'canonical', sources: [{ repo: 'core' }] },
    'A.md': { role: 'normal', sources: [{ repo: 'core' }], linksTo: ['C.md'] },
    'B.md': { role: 'normal', sources: [{ repo: 'nexus' }], linksTo: [] },
    'D.md': { role: 'normal', sources: [{ repo: 'core' }] },               // shares repo with A
  }
  const setA = selectComparisonSet('A.md', refs).sort()
  eq('selectComparisonSet: canonical + shared-repo, excludes self', setA, ['C.md', 'D.md'])
  ok('selectComparisonSet: unrelated B still gets canonical', selectComparisonSet('B.md', refs).includes('C.md'))
}

// --- dedupeContradictions ---------------------------------------------------
{
  const deduped = dedupeContradictions([
    { aPath: 'A.md', bPath: 'B.md', topic: 'events', confidence: 0.6 },
    { aPath: 'B.md', bPath: 'A.md', topic: 'events', confidence: 0.9 },   // same pair+topic, higher conf
    { aPath: 'A.md', bPath: 'B.md', topic: 'ports', confidence: 0.5 },    // different topic
  ])
  eq('dedupeContradictions: collapses A-B / B-A', deduped.length, 2)
  ok('dedupeContradictions: keeps higher confidence', deduped.some(c => c.topic === 'events' && c.confidence === 0.9))
}

// --- consistencyGate --------------------------------------------------------
{
  const canon = ['concepts.md']
  const { gate, flags } = consistencyGate([
    { aPath: 'rn.md', bPath: 'concepts.md', topic: 'events', weakerPath: 'rn.md', confidence: 0.9, reason: 'mislabel' }, // gate rn.md
    { aPath: 'rn.md', bPath: 'ffi.md', topic: 'events', weakerPath: 'rn.md', confidence: 0.9, reason: 'sibling' },       // no canonical -> flag
    { aPath: 'x.md', bPath: 'concepts.md', topic: 'ports', weakerPath: 'x.md', confidence: 0.4, reason: 'maybe' },       // low conf -> flag
  ], canon)
  ok('consistencyGate: gates non-canonical vs canonical at high confidence', gate.has('rn.md'))
  eq('consistencyGate: gate size', gate.size, 1)
  eq('consistencyGate: rest flagged', flags.length, 2)
}

console.log(`\n${failed ? '✗' : '✓'} ${failed} failure(s)`)
process.exit(failed ? 1 : 0)
