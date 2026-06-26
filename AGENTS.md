# AGENTS.md

This repository is a bundle of **agent skills** for building on and operating the
[Pubky](https://pubky.org) protocol. Each skill lives in `skills/<name>/SKILL.md` with
progressive-disclosure detail under `skills/<name>/references/`.

- **Claude Code** consumes it as a plugin marketplace via `.claude-plugin/marketplace.json`.
- **Codex** consumes the `skills/` tree via `.codex-plugin/plugin.json`.
- **Gemini CLI** via `gemini-extension.json`.

If your agent does not support the skill format, read `skills/pubky/SKILL.md` first (it holds
the always-on overview and ground rules), then follow its routing table into the relevant
`references/*.md` files for the task at hand.

When editing this repo, follow [CLAUDE.md](./CLAUDE.md).
