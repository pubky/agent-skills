# Pubky Agent Skills

Agent skills that help AI coding tools build on and operate the [Pubky](https://pubky.org)
protocol — install once, get accurate, drift-resistant context for the SDKs, data specs,
auth flow, and infrastructure.

This repo is a [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces).
The same `skills/` tree is also consumed by Codex and Gemini CLI (see the manifests below).

> Replaces the single-file [`pubky-ai-kit`](https://github.com/pubky/pubky-ai-kit) context
> doc. The old monolith loaded ~1,300 lines all at once; these skills load a thin always-on
> overview and pull in topic reference files only when relevant.

## Skills

Split by **audience / task**, not by SDK language (every SDK re-expresses the same protocol
spine, so language is a reference-file dimension, not a skill boundary):

| Skill | Plugin | For | Covers |
| :-- | :-- | :-- | :-- |
| **`pubky`** | `pubky` | Building web / server apps | `@synonymdev/pubky` (JS/WASM) + the `pubky` Rust crate, `pubky-app-specs`, the `pubkyauth` flow, `pubky://` `/pub` storage, consuming the Nexus read API, testnet |
| **`pubky-mobile`** | `pubky` | Building native iOS / Android / React Native apps | `@synonymdev/react-native-pubky`, `pubky-core-ffi`, Pubky Ring deeplink auth, mobile-only safety gotchas |
| **`pubky-infra`** | `pubky-infra` | Operating / self-hosting | homeserver, Nexus indexer, `pubky-docker` stack, `homegate`, `pkdns`, relays |

App builders install `pubky` (web + mobile in one). Operators install `pubky-infra` and keep
app-SDK skills out of their context. The install boundary is the build-vs-operate seam.

## Install (Claude Code)

```
/plugin marketplace add pubky/agent-skills
/plugin install pubky@pubky-agent-skills          # building apps (web + mobile)
/plugin install pubky-infra@pubky-agent-skills    # operating infrastructure
```

## Layout

```
.claude-plugin/marketplace.json   # Claude Code marketplace + plugins
.codex-plugin/plugin.json         # Codex
gemini-extension.json             # Gemini CLI
skills/<name>/SKILL.md            # thin, always-loaded: trigger + overview + routing table
skills/<name>/references/*.md     # progressive-disclosure detail, loaded on demand
```

## Future: MCP server

A Pubky MCP server (homeserver / Nexus tools) will live in its own repo
(mirroring `supabase/agent-skills` + `supabase/mcp`). When it ships, this plugin can
auto-wire it by adding a root `.mcp.json` that points at the hosted endpoint — no separate
install step for users. The server source stays out of this repo.

## Maintaining this repo

See [CLAUDE.md](./CLAUDE.md). The load-bearing rule: **shared concepts live in exactly one
place** (`skills/pubky/references/{concepts,app-specs,shipped-vs-planned}.md`); other skills
**link, never copy**. Per [pubky-knowledge-base `.ai-rules.md`](https://github.com/pubky/pubky-knowledge-base-v2/blob/main/.ai-rules.md),
reference files should link to maintained upstream sources and keep only short "what this
means in Pubky" summaries rather than re-copying drift-prone API detail.
