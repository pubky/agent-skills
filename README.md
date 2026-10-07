# Pubky Agent Skills

Agent skills that help AI coding tools build on and operate the [Pubky](https://pubky.org)
protocol — install once and get accurate, drift-resistant context for the SDKs, data specs,
auth flow, and infrastructure in every editor and CLI.

A skill is a folder under [`skills/`](./skills) containing a `SKILL.md`. It follows the open
**[Agent Skills](https://agentskills.io)** standard, so the same files work across Claude
Code, Codex, Cursor, OpenCode, Gemini CLI, and others. The repo doubles as a Claude Code
plugin marketplace.

> Replaces the single-file [`pubky-ai-kit`](https://github.com/pubky/pubky-ai-kit) context
> doc. The old monolith loaded ~1,300 lines all at once; these skills load a thin always-on
> overview and pull in topic reference files only when relevant.

## Skills

One plugin (`pubky`), four skills split by **audience / task** — not by SDK language (every
SDK re-expresses the same protocol spine, so language is a reference-file dimension, not a
skill boundary). Each skill auto-activates on its own triggers.

| Skill | For | Covers |
| :-- | :-- | :-- |
| **`pubky`** | Building web / server apps | `@synonymdev/pubky` (JS/WASM) + the `pubky` Rust crate, `pubky-app-specs`, the `pubkyauth` flow, `pubky://` `/pub` storage, consuming the Nexus read API, testnet |
| **`pubky-mobile`** | Building native iOS / Android / React Native apps | `@synonymdev/react-native-pubky`, `pubky-core-ffi`, Pubky Ring deeplink auth, mobile-only safety gotchas |
| **`pubky-infra`** | Operating / self-hosting | homeserver, Nexus indexer, `pubky-docker` stack, `homegate`, `pkdns`, relays |
| **`nexus-scout`** | Asking questions *of* the social graph | read-only Cypher over the public [nexus-scout](https://nexus-scout.pubky.app) gateway: followers, tags, threads, reputation, follow distance. Vendored verbatim from upstream |

## Install

Every tool installs from this repo via a marketplace, extension, or managed CLI — no manual
clones. **Claude Code** and **Codex** have native plugin marketplaces, **Gemini CLI** installs
it as an extension, and **Cursor** imports it from GitHub in its UI; for every other tool, the
GitHub CLI (`gh skill`) installs straight into that tool's skills directory.

### Claude Code

```sh
/plugin marketplace add pubky/agent-skills
/plugin install pubky@pubky-agent-skills
/reload-plugins
```

Turn on auto-update so new commits flow in: `/plugin` → **Marketplaces** → `pubky-agent-skills`
→ **Enable auto-update** (off by default for third-party marketplaces). Claude Code then fetches
updates at startup; run `/reload-plugins` to activate them. The four skills auto-activate on
their triggers; to invoke one manually it's namespaced, e.g. `/pubky:pubky-infra`.

### Codex CLI

```sh
codex plugin marketplace add pubky/agent-skills
codex plugin add pubky@pubky-agent-skills
```

Update with `codex plugin marketplace upgrade pubky-agent-skills`, then re-run
`codex plugin add pubky@pubky-agent-skills`. (Same commands work as `/plugin …` inside the
Codex TUI.)

### Cursor

Import straight from GitHub in the UI — no CLI needed:

1. Open **Cursor Settings** (`Cmd+Shift+J`).
2. Go to the **Rules** tab.
3. Click **Add Rule** → **Remote Rule (GitHub)**.
4. Enter `https://github.com/pubky/agent-skills`.
5. Select the skills to import.

Cursor copies them into `.cursor/skills/` and auto-discovers them (Cursor 2.4+). Re-import to
pull updates.

### Gemini CLI

Installs as a native extension; `--auto-update` keeps it current automatically:

```sh
gemini extensions install https://github.com/pubky/agent-skills --auto-update
```

Without `--auto-update`, refresh manually with `gemini extensions update pubky-agent-skills`
(or `--all`). List with `/extensions list`.

### OpenCode, Copilot, … (GitHub CLI)

Other tools that read the `SKILL.md` standard install via `gh skill` (GitHub CLI **≥ 2.90**) —
it writes into the host's own skills directory:

```sh
gh skill install pubky/agent-skills --all --agent opencode --scope user
gh skill install pubky/agent-skills --all --agent github-copilot --scope user
```

`--agent` picks the host (`opencode`, `codex`, `claude-code`, `github-copilot`, …). Pull
updates with `gh skill update --all`.

### Hermes (Nous Research)

```sh
hermes skills install pubky/agent-skills/pubky
hermes skills install pubky/agent-skills/pubky-mobile
hermes skills install pubky/agent-skills/pubky-infra
hermes skills install pubky/agent-skills/nexus-scout
```

Update with `hermes skills update`.

## Updates

Merge to `main` and it ships — there's no release step. How updates reach installed tools:

- **Claude Code** — auto-fetched at startup once auto-update is enabled, then a one-time
  `/reload-plugins` to activate.
- **Gemini CLI** — fully automatic if installed with `--auto-update`; otherwise
  `gemini extensions update pubky-agent-skills`.
- **Codex** — `codex plugin marketplace upgrade pubky-agent-skills` + re-add.
- **Cursor** — re-import the Remote Rule from the Rules tab.
- **gh skill hosts (OpenCode, Copilot, …)** — `gh skill update --all`.
- **Hermes** — `hermes skills update`.

For reproducibility, pin a tag/commit instead of tracking `main` (`--pin` with `gh skill`,
`#tag` when adding the Codex marketplace, `--ref` with Gemini, or `ref`/`sha` in a Claude Code
marketplace source).

## Layout

```
.claude-plugin/marketplace.json   # Claude Code marketplace + the pubky plugin
.codex-plugin/plugin.json         # Codex
gemini-extension.json             # Gemini CLI
skills/<name>/SKILL.md            # thin, always-loaded: trigger + overview + routing table
skills/<name>/references/*.md     # progressive-disclosure detail, loaded on demand
skills/nexus-scout/SKILL.md       # EXCEPTION: byte copy of upstream's file — never hand-edit
```

## Future: MCP server

A Pubky MCP server (homeserver / Nexus tools) will live in its own repo (mirroring
`supabase/agent-skills` + `supabase/mcp`). When it ships, this plugin can auto-wire it by adding
a root `.mcp.json` that points at the hosted endpoint — no separate install step for users. The
server source stays out of this repo.

## Updating the skill content from upstream

The reference files are **generated from upstream Pubky repos, not hand-edited** — with one
exception: `skills/pubky/references/new-project.md` is a hand-authored procedure file (flagged
`handAuthored: true` in the lock) that the pipeline deliberately skips. To refresh the generated
ones after upstream changes, run this in Claude Code from the repo root:

```sh
/sync-references
```

It fetches the tracked source repos, regenerates only the references whose sources changed
(executing/verifying every code snippet against a local testnet), refreshes the vendored
skills, and opens a signed **draft PR**. For a full rebuild of all 21 generated references, run
`/sync-references --initial`.

**`skills/nexus-scout/SKILL.md` is different: it is a byte copy**, not generated. It is authored
upstream in [`pubky/nexus-scout`](https://github.com/pubky/nexus-scout) — which compiles it into
the gateway binary and serves it at [`/llms.txt`](https://nexus-scout.pubky.app/llms.txt) — and
refreshed here by `node maintenance/vendor-skills.mjs`. Editing it locally is pointless: the next
sync overwrites it. Send corrections upstream.

One-time prerequisite — a local Postgres 18 for the snippet testnet (no Docker needed):

```sh
brew install postgresql@18 && brew services start postgresql@18
```

(This regenerates the *content*; the **Updates** section above is about how the published
skills reach installed tools.) See [`maintenance/README.md`](./maintenance/README.md) for how
the pipeline works.

## Maintaining this repo

See [CLAUDE.md](./CLAUDE.md). The load-bearing rule: **shared concepts live in exactly one
place** (`skills/pubky/references/{concepts,app-specs,shipped-vs-planned}.md`); other skills
**link, never copy**. Per [pubky-knowledge-base `.ai-rules.md`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/.ai-rules.md),
reference files should link to maintained upstream sources and keep only short "what this means
in Pubky" summaries rather than re-copying drift-prone API detail.

## Security

Skills are loaded into an agent's context and can instruct it to run bundled scripts — treat
this repo like any other code dependency. Changes go through PR review. Never put secrets or
credentials in a `SKILL.md` — they'd be pulled straight into model context.
