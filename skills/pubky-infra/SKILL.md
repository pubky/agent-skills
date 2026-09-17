---
name: pubky-infra
description: "Use when running, deploying, configuring, or operating Pubky backend infrastructure rather than building an app: self-hosting a homeserver (Docker, admin API, config.toml, signup/invite tokens, enable/disable users, the homeserver-dashboard, Cloudflare-tunnel exposure, Umbrel vs standalone); operating the Nexus indexer (nexusd api/watcher/db subcommands, Neo4j + Redis, config.toml, the Migration Manager, OpenTelemetry/Signoz); spinning up the full local stack with pubky-docker compose profiles; gating signups with Homegate (SMS/Lightning/IP, PostgreSQL); running self-sovereign DNS (pkdns resolver + DoH, pkarr-relay, the Mainline DHT); or hosting http-relay for store-and-forward/auth flows. Includes operator/admin CLI workflows via homeservercli and pubky-cli (minting signup tokens, enabling/disabling users, per-user quotas). NOT for building apps that consume Pubky (use pubky or pubky-mobile), and NOT for querying the social graph with read-only Cypher (use nexus-scout)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Pubky — operate & self-host infrastructure

For **running** Pubky backend services, not building apps that consume them. Operator prompts
routinely span components (e.g. "run the Pubky stack in Docker" touches homeserver + Nexus +
DNS), so this is **one** skill with per-component reference files.

## Orientation

- **Homeserver** — the per-public-key backend users sign up to. Run via Docker or `cargo`;
  has an admin API and `config.toml`.
- **Nexus** — the indexer/read-API. Runs as `nexusd` (api/watcher) over Neo4j + Redis.
- **pubky-docker** — the one-command full local stack (compose profiles).
- **Homegate** — signup gating (SMS/Lightning/IP) in front of homeserver registration.
- **DNS/relays** — `pkdns` (resolver + DoH), `pkarr-relay` (so browsers/WASM can publish &
  resolve), `http-relay` (store-and-forward / auth flows), `mainline` (the DHT).

## Where to look

| Task | Read |
| :-- | :-- |
| Run a homeserver: install/deploy (domain, IP-only, Cloudflare tunnel), admin/client/metrics endpoints, `config.toml`, PKARR republishing, signup tokens, dashboard, Umbrel | `references/homeserver.md` |
| Operate Nexus: `nexusd` api/watcher/db, Neo4j+Redis, migrations, observability, event ingestion | `references/nexus-operations.md` |
| Full local stack: `pubky-docker` compose profiles, `.env`, `pubky-docker-cli.sh` | `references/local-stack.md` |
| Signup gating: Homegate routes (SMS/Lightning/IP), secrets, PostgreSQL | `references/signup-gating.md` |
| Self-sovereign DNS: `pkdns` + DoH, `pkarr-relay`, why browsers/WASM need relays, DHT background | `references/dns-and-relays.md` |
| Run the HTTP relay: binary/Docker, inbox API, TTL/persistence/CORS | `references/http-relay.md` |
| Operator/admin CLI flows: `homeservercli` (tokens, stats, enable/disable users, per-user quotas) and legacy `pubky-cli` | `references/operator-cli.md` |

Building an app that **consumes** Pubky? Use the **`pubky`** (web/server) or **`pubky-mobile`**
(native) skill instead.
Querying the social graph rather than running it? Use the **`nexus-scout`** skill.
