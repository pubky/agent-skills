Finalized /Users/jason/Documents/Repositories/agent-skills/skills/pubky/references/auth.md. Gate: accept=true.

Fixes applied:
1. mustFix (authenticator-approve snippet): replaced the HEAD-only `deep_link.params()` + `SignupParams` field access with the clippy-verified pubky 0.9.3 accessor form `signer.signup(deep_link.homeserver(), deep_link.signup_token().as_deref())`, documented the accessor return types inline, and added a Drift note explaining the HEAD `params()`/`SignupParams` divergence (the cited example file tracks HEAD).
2. caps-builder import note: added that the `pubky` crate re-exports `Capability`/`Capabilities` so a `pubky`-only dependency imports `use pubky::{Capability, Capabilities};` (the snippet's `pubky_common::capabilities` path requires the separate crate). Prevents a broken build for pubky-only users.

All other snippets passed against pinned 0.9.3 and were left byte-identical to their CI-verified sources.

Concision/altitude pass: file was already dense and prior-edited; every paragraph carries an API signature, security caveat, protocol-model step, or decision table, so no caveats or snippets were cut. Shared concepts (keypair/identity, pk string formats, homeserver session model, recovery-file basics + keygen example, single-cookie limit) link to canonical concepts.md; signup-token issuance delegates to pubky-infra/signup-gating.md — no restatement (ROLE=normal honored).

Gate checks: no stub/scaffolding markers; 13 balanced code fences; all 6 relative links resolve to existing files; both concepts.md anchors (#identity-the-ed25519-keypair, #stability-and-known-limits) match real headings; no stale params() call remains in code. COVERS fully satisfied across H2 sections: handshake, capabilities, pubkyauth:// URL, relays, recovery files, signup tokens, session lifecycle (plus AuthToken wire format and known limitations).
