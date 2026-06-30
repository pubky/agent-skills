export const meta = {
  name: 'sync-references',
  description: 'Generate/refresh Pubky skill reference files from upstream sources, with snippet execution and adversarial fact-checking',
  whenToUse: 'Invoked by /sync-references. The main agent clones sources, builds the job manifest, starts a shared testnet, then runs this workflow; it writes the returned markdown + provenance and opens a draft PR.',
  phases: [
    { title: 'Reconcile', detail: 'detect add/remove/rescope of reference files vs upstream reality' },
    { title: 'Research', detail: 'read cached sources + live docs; extract claims with provenance' },
    { title: 'Draft', detail: 'write concise, link-first markdown honoring role + rules' },
    { title: 'Snippet', detail: 'execute JS/Rust against the shared testnet; compile RN/Swift/Kotlin; surface-check Nexus' },
    { title: 'FactCheck', detail: 'adversarially falsify each claim; enforce shipped-vs-planned guardrail' },
    { title: 'Finalize', detail: 'revise + concision pass; per-file gate; capture provenance' },
    { title: 'Consistency', detail: 'cross-file contradiction detection; auto-gate canonical conflicts' },
  ],
}

// ---------------------------------------------------------------------------
// args (built by the main agent, see .claude/commands/sync-references.md):
// {
//   mode: 'initial' | 'incremental',
//   repoRoot, cacheDir, snippetHarnessDir,
//   rulesText,                // condensed CLAUDE.md + .ai-rules.md authoring rules
//   shippedVsPlannedText,     // canonical guardrail text (may be '' on first run)
//   testnet: { up: bool, pkarrRelay, httpRelay, homeserverPubky } | null,
//   layout: [ "skills/pubky/references/concepts.md", ... ],  // all current ref paths
//   comparisonSets: { "<path>": ["<path>", ...] },     // per-file cross-file consistency set
//   comparisonCorpus: { "<path>": { markdown, role } },// content of set members not regenerated
//   canonicalPaths: [ "<path>", ... ],                 // role==='canonical' references
//   files: [ {
//     path, role, covers, linksTo[],
//     sources: [ { repo, kind, paths[], cachePath, sha, branch, url } ],
//     priorMarkdown, priorProvenance, diffHunks
//   } ]
// }
// Returns: { mode, reconciliation, files: [...perFileResult], copyCheck, spend }
// ---------------------------------------------------------------------------

// args is either the full manifest inline, or { manifestPath } — in which case a bootstrap
// agent reads it off disk (the manifest is too large to pass inline at scale). A schema'd
// return guarantees clean JSON text regardless of any agent chatter/fences. If args doesn't
// arrive at all, fall back to the default path the /sync-references command writes.
let A = args || {}
if (typeof A === 'string') { try { A = JSON.parse(A) } catch { A = {} } }  // tool may deliver args JSON-encoded
log(`args: type=${typeof args} keys=${A && typeof A === 'object' ? Object.keys(A).join(',') : 'none'}`)
const manifestPath = A.files ? null : (A.manifestPath || '/tmp/sync-manifest.json')
if (manifestPath) {
  const loaded = await agent(
    `Run \`cat ${manifestPath}\` and return its exact stdout verbatim as the string field 'contents'. It is a JSON document; do not alter, summarize, or re-indent it.`,
    { schema: { type: 'object', additionalProperties: false, required: ['contents'], properties: { contents: { type: 'string' } } },
      label: 'load-manifest', phase: 'Reconcile' }
  )
  A = JSON.parse(loaded.contents)
  log(`manifest loaded: mode=${A.mode} files=${(A.files || []).length}`)
}
const FILES = A.files || []
const RULES = A.rulesText || ''
const GUARDRAIL = A.shippedVsPlannedText || ''
const TESTNET = A.testnet || { up: false }

// ---- shared schema fragments ----------------------------------------------
const CLAIMS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['claims', 'openQuestions'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'statement', 'kind', 'sourceRepo', 'sourcePath'],
        properties: {
          id: { type: 'string' },
          statement: { type: 'string' },
          kind: { enum: ['fact', 'snippet', 'link', 'caveat'] },
          sourceRepo: { type: 'string' },
          sourcePath: { type: 'string' },
          sourceUrl: { type: 'string' },
          lang: { type: 'string', description: 'for snippet claims: js|rust|react-native|swift|kotlin|bash|http|none' },
          code: { type: 'string', description: 'for snippet claims: the verbatim code' },
        },
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    proposedLinks: { type: 'array', items: { type: 'string' } },
  },
}

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['markdown', 'snippets', 'outboundLinks'],
  properties: {
    markdown: { type: 'string' },
    outboundLinks: { type: 'array', items: { type: 'string' } },
    sectionProvenance: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['anchor', 'claimIds'],
        properties: { anchor: { type: 'string' }, claimIds: { type: 'array', items: { type: 'string' } } },
      },
    },
    snippets: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'lang', 'code'],
        properties: {
          id: { type: 'string' },
          lang: { enum: ['js', 'rust', 'react-native', 'swift', 'kotlin', 'bash', 'http'] },
          code: { type: 'string' },
          needsTestnet: { type: 'boolean' },
          expectedTier: { enum: ['executed', 'compiled', 'surface', 'lint'] },
        },
      },
    },
  },
}

const SNIPPET_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'lang', 'tier', 'status'],
        properties: {
          id: { type: 'string' },
          lang: { type: 'string' },
          tier: { enum: ['executed', 'compiled', 'surface', 'lint'] },
          status: { enum: ['pass', 'fail', 'unverifiable'] },
          reason: { type: 'string' },
          correctedCode: { type: 'string' },
          command: { type: 'string', description: 'the exact command/run that produced this verdict' },
          evidence: { type: 'string', description: 'captured stdout/stderr/exit excerpt — required to corroborate an executed/compiled pass' },
        },
      },
    },
  },
}

const CONTRADICTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['contradictions'],
  properties: {
    contradictions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['otherPath', 'topic', 'thisClaim', 'otherClaim', 'weaker', 'confidence', 'reason'],
        properties: {
          otherPath: { type: 'string' },
          topic: { type: 'string' },
          thisClaim: { type: 'string' },
          otherClaim: { type: 'string' },
          weaker: { enum: ['this', 'other', 'unclear'], description: 'which side is less authoritative by provenance strength' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const FACTCHECK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdicts', 'guardrailViolations', 'mustFix'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['claimId', 'status'],
        properties: {
          claimId: { type: 'string' },
          status: { enum: ['supported', 'refuted', 'needs-caveat', 'unsupported'] },
          evidenceUrl: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
    guardrailViolations: { type: 'array', items: { type: 'string' } },
    mustFix: { type: 'array', items: { type: 'string' } },
  },
}

const FINAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['accept', 'finalMarkdown', 'provenance'],
  properties: {
    accept: { type: 'boolean' },
    blocking: { type: 'array', items: { type: 'string' } },
    nonBlocking: { type: 'array', items: { type: 'string' } },
    wordCount: { type: 'number' },
    // minLength gives the schema-retry layer something to reject when an agent returns a status
    // line instead of the document; the structural gate in stubReasons() catches the rest.
    finalMarkdown: { type: 'string', minLength: 400 },
    provenance: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['anchor', 'repo', 'path', 'sha'],
        properties: {
          anchor: { type: 'string' }, repo: { type: 'string' },
          path: { type: 'string' }, sha: { type: 'string' }, url: { type: 'string' },
        },
      },
    },
  },
}

const RECON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'targetFile', 'rationale'],
        properties: {
          type: { enum: ['add', 'remove', 'merge', 'rename', 'rescope', 'none'] },
          targetFile: { type: 'string' },
          affectedSkill: { type: 'string' },
          rationale: { type: 'string' },
          suggestedCovers: { type: 'string' },
          suggestedRoutingRow: { type: 'string' },
          suggestedTrigger: { type: 'string', description: 'PROPOSAL ONLY — never auto-applied' },
        },
      },
    },
  },
}

// ---- helpers ---------------------------------------------------------------
function sourcesBlock(f) {
  return f.sources.map(s =>
    `- ${s.repo} (${s.kind || 'git'}${s.sha ? ' @ ' + s.sha.slice(0, 12) : ''})\n` +
    `    cache: ${s.cachePath || '(no local clone — fetch live)'}\n` +
    `    url:   ${s.url || ''}\n` +
    `    paths: ${(s.paths || []).join(', ') || '(whole repo)'}`
  ).join('\n')
}

function roleInstruction(role) {
  if (role === 'canonical')
    return 'ROLE=canonical: this is the SINGLE source of truth for its material; fully author it. Other skills LINK here — do not write anything that invites copying.'
  if (role === 'pointer')
    return 'ROLE=pointer: keep this THIN. Output only a short mapping table + relative links to the canonical pubky-skill references. Do NOT restate concepts/auth/app-spec detail.'
  return 'ROLE=normal: where you touch shared protocol concepts, LINK to the canonical pubky-skill reference instead of restating it.'
}

// deterministic word-shingle overlap (no Date/Math.random) for canonical-copy detection
function shingles(text, n) {
  const words = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const set = new Set()
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '))
  return set
}
function overlapRatio(a, b) {
  const sa = shingles(a, 8), sb = shingles(b, 8)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const s of sa) if (sb.has(s)) hit++
  return hit / sa.size
}

// Deterministic substance check on the finalize output — never trust the agent's self-graded
// accept for a property a script can verify. The sandbox forbids importing maintenance/lib.mjs,
// so this mirrors checkReference() there; keep the two in sync.
function stubReasons(md, reportedWordCount) {
  const t = (md || '').trim(), reasons = []
  const words = t ? t.split(/\s+/).length : 0
  if (words < 80) reasons.push(`too short (${words}w)`)
  if (!/^#{1,6}\s/m.test(t)) reasons.push('no heading')
  if (((t.match(/^```/gm) || []).length) % 2) reasons.push('unbalanced fences')
  const first = (t.split('\n').find(l => l.trim()) || '').trim()
  if (/^(done|finalize|finalized|gate:|fixes applied)\b/i.test(first) || /\bgate:\s*accept=/i.test(t) || /\bfile finalized\b/i.test(t))
    reasons.push('looks like a finalize-log')
  if (reportedWordCount && words && words < reportedWordCount * 0.5) reasons.push(`body ${words}w << reported ${reportedWordCount}w`)
  return reasons
}

// The next three mirror maintenance/lib.mjs (the sandbox can't import it) — keep in sync.
const TIER_RANK = { lint: 0, surface: 1, compiled: 2, executed: 3 }
function auditSnippets(results, draftSnippets) {
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
      notes.push(`${r.id}: bash command only surface-checked — invoke the real tool to validate flags`)
    const exp = expected[r.id]
    if (exp && TIER_RANK[r.tier] < TIER_RANK[exp]) notes.push(`${r.id}: tier ${r.tier} below expected ${exp}`)
    return out
  })
  return { results: audited, notes }
}
function dedupeContradictions(list) {
  const byKey = new Map()
  for (const c of list || []) {
    const key = JSON.stringify([[c.aPath, c.bPath].sort(), c.topic || ''])
    const prev = byKey.get(key)
    if (!prev || (c.confidence || 0) > (prev.confidence || 0)) byKey.set(key, c)
  }
  return Array.from(byKey.values())
}
function consistencyGate(contradictions, canonicalPaths, minConfidence = 0.7) {
  const canon = new Set(canonicalPaths || [])
  const gate = new Map(), flags = []
  for (const c of contradictions || []) {
    const involvesCanon = canon.has(c.aPath) || canon.has(c.bPath)
    const weaker = c.weakerPath
    if (involvesCanon && weaker && !canon.has(weaker) && (c.confidence || 0) >= minConfidence) {
      const other = weaker === c.aPath ? c.bPath : c.aPath
      if (!gate.has(weaker)) gate.set(weaker, `contradicts canonical ${other} on "${c.topic}": ${c.reason}`)
    } else flags.push(c)
  }
  return { gate, flags }
}

// ===========================================================================
// PHASE: Reconcile (structure drift) — conservative; proposals only
// ===========================================================================
phase('Reconcile')
let reconciliation = { proposals: [] }
if (A.mode === 'initial') {
  log('initial run — reconciliation is a confirmation no-op (the 21 files were hand-designed)')
} else {
  const layoutList = (A.layout || []).join('\n')
  const repoSummary = FILES.map(f => `- ${f.path} <= ${f.sources.map(s => s.repo).join(', ')}`).join('\n')
  reconciliation = await agent(
    `You are auditing whether the set of Pubky skill reference files still matches upstream reality.\n\n` +
    `Current reference files:\n${layoutList}\n\n` +
    `In-scope files this run and their sources:\n${repoSummary}\n\n` +
    `Authoring rules:\n${RULES}\n\n` +
    `Propose add/remove/merge/rename/rescope ONLY when a source clearly has no home or a file has no live source. ` +
    `Be conservative: a new reference => a new routing-table row (low risk). A SKILL.md trigger/description edit is PROPOSAL-ONLY (suggestedTrigger), never auto-applied. ` +
    `Adding/removing a whole skill is out of scope here. If nothing is needed, return a single proposal of type "none".`,
    { schema: RECON_SCHEMA, phase: 'Reconcile', label: 'reconcile' }
  ) || { proposals: [] }
}

// ===========================================================================
// PER-FILE PIPELINE: research -> draft -> snippet -> factcheck -> finalize
// ===========================================================================
const perFile = await pipeline(
  FILES,

  // --- Stage 1: research + provenance -------------------------------------
  (f) => agent(
    `Research the authoritative content for the Pubky skill reference file: ${f.path}\n\n` +
    `${roleInstruction(f.role)}\n` +
    `COVERS (scope contract): ${f.covers}\n` +
    (f.linksTo && f.linksTo.length ? `This file LINKS TO (do not duplicate their content): ${f.linksTo.join(', ')}\n` : '') +
    `\nSOURCES (read the local clones with Read/grep; WebFetch the live docs/registry URLs to confirm current shape):\n${sourcesBlock(f)}\n\n` +
    (f.diffHunks ? `INCREMENTAL UPDATE — focus on what these upstream diff hunks changed:\n${f.diffHunks}\n\n` : '') +
    `AUTHORING RULES:\n${RULES}\n\n` +
    `Extract every fact, API signature, and code snippet you will need, each with exact provenance (repo, path, url, line range). ` +
    `PREFER lifting code snippets verbatim from pubky-knowledge-base-v2/snippets/* (CI-verified) and runnable programs from pubky-core/examples/*; tag those snippet claims with their source. ` +
    `For snippet claims set lang and put the code in 'code'. Capture open questions for the fact-checker.`,
    { schema: CLAIMS_SCHEMA, phase: 'Research', label: `research:${f.path.split('/').pop()}` }
  ).then(r => ({ f, claims: r })),

  // --- Stage 2: draft / synthesis -----------------------------------------
  (prev) => {
    if (!prev) return null
    const { f, claims } = prev
    return agent(
      `Write the reference file ${f.path} from the researched claims below. Output GitHub-flavored markdown for the file BODY.\n\n` +
      `${roleInstruction(f.role)}\n` +
      `COVERS: ${f.covers}\n\n` +
      `CLAIMS (id => statement / snippet):\n${JSON.stringify(claims.claims, null, 1)}\n\n` +
      `AUTHORING RULES (follow exactly):\n${RULES}\n\n` +
      `Requirements: concise and to-the-point; LINK to upstream (docs.rs/README/Swagger) rather than mirroring drift-prone API detail; keep only short "what this means in Pubky" summaries. ` +
      `Remove the 'Status: stub' scaffolding. Include accurate code snippets where they earn their place, each fenced with its language. ` +
      `Record which claim ids back each section in sectionProvenance, and list every snippet you included (with lang, needsTestnet, expectedTier).`,
      { schema: DRAFT_SCHEMA, phase: 'Draft', label: `draft:${f.path.split('/').pop()}` }
    ).then(d => ({ ...prev, draft: d }))
  },

  // --- Stage 3: snippet testing (shared testnet; unique temp dirs) ---------
  (prev) => {
    if (!prev) return null
    const { f, draft } = prev
    const snippets = (draft && draft.snippets) || []
    if (snippets.length === 0) return { ...prev, snippetResults: { results: [] } }
    return agent(
      `Verify each code snippet for ${f.path}. Work in a UNIQUE temp dir (mktemp -d); never mutate the shared harness or the repo.\n\n` +
      `Snippet harness (pinned, published versions) is at: ${A.snippetHarnessDir}\n` +
      `Upstream clones are at: ${A.cacheDir}\n` +
      (TESTNET.up
        ? `A SHARED testnet is RUNNING — connect to it, do NOT start your own (ports are taken):\n` +
          `  pkarr relay: ${TESTNET.pkarrRelay}\n  http relay: ${TESTNET.httpRelay}\n  homeserver pubky: ${TESTNET.homeserverPubky}\n` +
          `  For JS use Pubky.testnet() / for Rust use the testnet client pointed at these relays.\n`
        : `No testnet is running; execute-tier is unavailable — fall back to compile/type-check and say so.\n`) +
      `\nTIERS (assign the highest you actually achieve; downgrading below expectedTier is a FAIL):\n` +
      `- executed: JS/Rust run end-to-end (signup->put->get etc.) against the shared testnet and asserted.\n` +
      `- compiled: tsc --noEmit (js/react-native), cargo clippy/build (rust), swift build, gradle compileDebugKotlin against the pinned bindings.\n` +
      `- surface: http/Nexus — validate method+path+schema against the OpenAPI doc (+ optional read-only curl).\n` +
      `- lint: react-native/swift/kotlin contract checks — bare 52-char z-base32 keys, pk:<z32> URIs, and (CRITICAL) any Android networking snippet MUST call RustlsInit.initPlatformVerifier before a handshake.\n\n` +
      `RIGOR — do NOT self-grade a pass you didn't earn:\n` +
      `- 'surface' is NOT acceptable for a CLI/bash command whose tool is on PATH. You MUST invoke the real tool so its OWN parser validates flags/subcommands — run it, or \`--help\` / \`--dry-run\` / \`compose config\` / \`-n\`. (This is exactly how a missing \`--\` separator, a bad flag, or an unparseable arg gets caught.)\n` +
      `- For install/version claims (\`cargo install\`, \`npm i\`), query the registry (crates.io / npmjs API) to confirm the EXACT version resolves — a crate published only as a pre-release will NOT install without \`--version\`.\n` +
      `- Capture the real stdout/stderr/exit excerpt in 'evidence' for every pass. A pass at executed/compiled tier WITHOUT a 'command' and 'evidence' will be demoted to unverifiable downstream.\n\n` +
      `SNIPPETS:\n${JSON.stringify(snippets, null, 1)}\n\n` +
      `For prose snippets that use placeholder context (declare const ...), materialize a runnable harness with real values to execute them. ` +
      `Use signinBlocking / retries for PKDNS timing. If a snippet is wrong, return correctedCode. Report the exact command and evidence per snippet.`,
      { schema: SNIPPET_SCHEMA, phase: 'Snippet', label: `snippet:${f.path.split('/').pop()}` }
    ).then(s => {
      // deterministic audit — distrust the self-graded tier (mirrors the substance gate)
      const { results, notes } = auditSnippets((s && s.results) || [], snippets)
      if (notes.length) log(`snippet-audit ${f.path}: ${notes.join(' | ')}`)
      return { ...prev, snippetResults: { results }, snippetAudit: notes }
    })
  },

  // --- Stage 4: adversarial fact-check + guardrail ------------------------
  (prev) => {
    if (!prev) return null
    const { f, claims, draft, snippetResults } = prev
    return agent(
      `Adversarially fact-check the draft for ${f.path}. Try to FALSIFY each claim against the upstream sources (read the clones at ${A.cacheDir} / WebFetch live docs).\n\n` +
      `DRAFT:\n${draft.markdown}\n\n` +
      `CLAIMS:\n${JSON.stringify(claims.claims, null, 1)}\n\n` +
      `SNIPPET RESULTS:\n${JSON.stringify((snippetResults && snippetResults.results) || [], null, 1)}\n\n` +
      (GUARDRAIL ? `SHIPPED-VS-PLANNED GUARDRAIL (authoritative):\n${GUARDRAIL}\n\n` : '') +
      `Flag, as guardrailViolations, any sentence that presents a PLANNED/unshipped feature as available ` +
      `(private /priv storage, encrypted-data-as-primitive, homeserver mirroring, backup restore, cloud backup, two-way sync). ` +
      `Flag stable-sounding claims about v0 / Nexus /v0 / /pub paths that lack an instability caveat. Flag any claim with no provenance, and any mirrored API detail that should be a link. ` +
      `Verify public-key string usage: publicKey.toString() => "pubky<z32>" (display) vs publicKey.z32() => raw z-base32 (hostnames/DNS/headers/keys). ` +
      `Put anything that must change before shipping into mustFix.`,
      { schema: FACTCHECK_SCHEMA, phase: 'FactCheck', label: `factcheck:${f.path.split('/').pop()}` }
    ).then(fc => ({ ...prev, factcheck: fc }))
  },

  // --- Stage 5+6: revise + concision, then gate ---------------------------
  (prev) => {
    if (!prev) return null
    const { f, draft, snippetResults, factcheck, snippetAudit } = prev
    return agent(
      `Finalize ${f.path}. Apply every fix, then a concision/altitude pass, then gate.\n\n` +
      `${roleInstruction(f.role)}\nCOVERS: ${f.covers}\n\n` +
      `DRAFT:\n${draft.markdown}\n\n` +
      `SNIPPET RESULTS (replace any failing snippet with its correctedCode; if a snippet is unverifiable, keep it but add a one-line caveat; annotate executed snippets are run against a local testnet):\n${JSON.stringify((snippetResults && snippetResults.results) || [], null, 1)}\n\n` +
      `FACT-CHECK (apply fixes; drop unsupported claims; add required caveats; demote mirrored detail to links):\n${JSON.stringify(factcheck, null, 1)}\n\n` +
      `AUTHORING RULES:\n${RULES}\n\n` +
      `Concision pass — AUDIENCE IS A CODING AGENT loading this on demand. Maximize actionable density: ` +
      `KEEP every API signature, correctness gotcha/caveat, tested snippet, and decision table; ` +
      `CUT motivational/marketing prose, taglines, and narrative flavor; prefer imperative "do X, not Y"; ` +
      `lead with code and the technical model; drop anything duplicating a canonical file (link instead). ` +
      `Never remove a correctness caveat or a verified snippet to save words. ` +
      `Then GATE: accept=true only if the stub scaffolding is gone, COVERS is satisfied, links are well-formed, role constraints hold, and no unfixed mustFix remains. ` +
      `CRITICAL: finalMarkdown MUST be the COMPLETE file body — GitHub-flavored markdown beginning with a "# " heading. It is the literal file content, NOT a status line, summary, or description of your work; never emit "done", "finalize complete", "file finalized", or a "Gate: accept=..." log as the body. Also return per-section provenance.`,
      { schema: FINAL_SCHEMA, phase: 'Finalize', label: `finalize:${f.path.split('/').pop()}` }
    ).then(fin => {
      const md = fin.finalMarkdown || ''
      const stub = stubReasons(md, fin.wordCount)   // deterministic override of the self-graded accept
      if (stub.length) log(`⚠ ${f.path}: finalize output failed substance check (${stub.join('; ')}) — forcing accept=false`)
      return {
        path: f.path, role: f.role, covers: f.covers,
        sourcesUsed: f.sources.map(s => ({ repo: s.repo, sha: s.sha })),
        snippet: summarizeSnippets((snippetResults && snippetResults.results) || []),
        factCheck: summarizeFactcheck(factcheck),
        guardrailViolations: (factcheck && factcheck.guardrailViolations) || [],
        accept: Boolean(fin.accept) && stub.length === 0,
        blocking: [...(fin.blocking || []), ...stub.map(s => `substance: ${s}`)],
        nonBlocking: [...(fin.nonBlocking || []), ...(snippetAudit || []).map(n => `snippet-audit: ${n}`)],
        wordCount: md.split(/\s+/).filter(Boolean).length,   // real count, never the self-report
        finalMarkdown: md, provenance: fin.provenance || [],
      }
    })
  }
)

function summarizeSnippets(rs) {
  const by = (s) => rs.filter(r => r.status === s).length
  return { total: rs.length, pass: by('pass'), fail: by('fail'), unverifiable: by('unverifiable'),
    failing: rs.filter(r => r.status === 'fail').map(r => r.id) }
}
function summarizeFactcheck(fc) {
  if (!fc) return { supported: 0, refuted: 0, caveated: 0, unsupported: 0 }
  const v = fc.verdicts || []
  const c = (s) => v.filter(x => x.status === s).length
  return { supported: c('supported'), refuted: c('refuted'),
    caveated: c('needs-caveat'), unsupported: c('unsupported') }
}

// ===========================================================================
// In-JS canonical-copy check on GENERATED content (deterministic, no agent).
// Disk-level invariants (SKILL.md budget, triggers, links, routing/manifest)
// run in maintenance/verify.mjs after the main agent writes the files.
// ===========================================================================
phase('Finalize')
const good = perFile.filter(Boolean)
const canon = good.filter(r => r.role === 'canonical')
const copyCheck = { threshold: 0.18, flags: [] }
for (const r of good) {
  if (r.role === 'canonical') continue
  for (const c of canon) {
    const ratio = overlapRatio(r.finalMarkdown, c.finalMarkdown)
    if (ratio >= copyCheck.threshold)
      copyCheck.flags.push({ file: r.path, canonical: c.path, overlap: Number(ratio.toFixed(3)),
        detail: 'high shingle overlap with a canonical file — should LINK, not restate' })
  }
}
if (copyCheck.flags.length) log(`canonical-copy: ${copyCheck.flags.length} file(s) flagged for review`)
else log('canonical-copy: clean')

// ===========================================================================
// PHASE: Consistency — adaptive cross-file contradiction detection. Each finalized
// file is compared (by an agent) against the canonical files + its related set
// (linksTo / shared-source), read from fresh output or the comparison corpus. No
// Pubky facts are hardcoded; the agent judges which side is weaker by provenance
// strength. A high-confidence contradiction with a canonical file auto-gates the
// weaker (non-canonical) file; everything else is flagged for human review.
// ===========================================================================
phase('Consistency')
const SETS = A.comparisonSets || {}                 // {path: [paths]} from plan-run
const CORPUS = A.comparisonCorpus || {}             // {path: {markdown, role}} for files not regenerated
const canonicalPaths = A.canonicalPaths || good.filter(r => r.role === 'canonical').map(r => r.path)
const byPath = Object.fromEntries(good.map(r => [r.path, r]))
const sideMd = (p) => (byPath[p] && byPath[p].finalMarkdown) || (CORPUS[p] && CORPUS[p].markdown) || null
const sideRole = (p) => (byPath[p] && byPath[p].role) || (CORPUS[p] && CORPUS[p].role) || 'normal'

const rawContradictions = (await parallel(good.map(r => () => {
  const setPaths = (SETS[r.path] || []).filter(p => sideMd(p))
  if (!setPaths.length) return Promise.resolve(null)
  const others = setPaths.map(p => `### ${p} (role=${sideRole(p)})\n${sideMd(p)}`).join('\n\n')
  return agent(
    `Find FACTUAL CONTRADICTIONS between THIS Pubky reference file and the RELATED files below — places where they state incompatible things about the SAME feature, API behaviour, protocol model, endpoint, port, or version. ` +
    `Ignore stylistic differences and merely-complementary detail; report only genuine contradictions.\n\n` +
    `For each, judge which side is WEAKER by evidentiary strength: a canonical file (role=canonical), or a claim citing primary source code/docs, OUTRANKS an inference. If you cannot tell, weaker="unclear".\n\n` +
    `THIS FILE — ${r.path} (role=${r.role}):\n${r.finalMarkdown}\n\n` +
    `RELATED FILES:\n${others}`,
    { schema: CONTRADICTION_SCHEMA, phase: 'Consistency', label: `consistency:${r.path.split('/').pop()}` }
  ).then(res => ((res && res.contradictions) || []).map(c => ({
    aPath: r.path, bPath: c.otherPath, topic: c.topic, aClaim: c.thisClaim, bClaim: c.otherClaim,
    weakerPath: c.weaker === 'this' ? r.path : c.weaker === 'other' ? c.otherPath : null,
    confidence: c.confidence, reason: c.reason,
  })))
}))).filter(Boolean).flat()

const contradictions = dedupeContradictions(rawContradictions)
const { gate, flags } = consistencyGate(contradictions, canonicalPaths)
for (const [p, reason] of gate) {
  const rec = byPath[p]
  if (rec && rec.accept) { rec.accept = false; rec.blocking = [...(rec.blocking || []), `consistency: ${reason}`] }
}
if (gate.size) log(`consistency: auto-gated ${gate.size} file(s) (canonical contradiction): ${Array.from(gate.keys()).join(', ')}`)
if (flags.length) log(`consistency: ${flags.length} contradiction(s) flagged for human review`)
const consistency = { contradictions, gated: Array.from(gate.keys()), flags }

const failed = good.filter(r => !r.accept).map(r => r.path)
if (failed.length) log(`gate: ${failed.length} file(s) need human attention: ${failed.join(', ')}`)

return {
  mode: A.mode,
  reconciliation,
  files: good,
  copyCheck,
  consistency,
  spend: { agentOutputTokens: budget.spent ? budget.spent() : null },
}
