---
name: pubky-shop-import
description: "Use when a seller wants to import, sync, update, pause or remove products from a WooCommerce / WordPress store as listings on Pubky Shop (shop.pubky.app), written to the seller's own homeserver. Covers exporting via the WooCommerce Store API (optionally exact stock, shipping rates and translated pages over SSH + WP-CLI), converting prices to the Shop's USD or BTC, mapping to the Shop's taxonomy v2 categories, photo upload with BLAKE3 content hashes, validating the marketplace listing record, seller sign-in with Pubky Ring, publishing, checkout registration with the marketplace service (sync-many) and checking the Nexus index. NOT for building or debugging a general Pubky app (use pubky), NOT for native iOS/Android or React Native apps (use pubky-mobile), NOT for running or self-hosting Pubky services (use pubky-infra), and NOT for querying the social graph with read-only Cypher (use nexus-scout)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Pubky Shop import — WooCommerce → shop.pubky.app

A Pubky Shop listing is a JSON record the **seller writes to their own homeserver**
(`/pub/pubky.app/marketplace/v1/listings/<id>`, photos under `…/v1/media/<id>`). The Shop's
Nexus indexes it into the catalog, and the marketplace service must register it before
checkout works. There is no upload API: the bundled scripts do what the Shop's sell form
does, for a whole WooCommerce catalog. Identity, `pubky://` and sessions:
[`../pubky/references/concepts.md`](../pubky/references/concepts.md),
[`../pubky/references/auth.md`](../pubky/references/auth.md).

## Ground rules (always apply)

- **Publishing is public and signed with the seller's identity.** `publish.mjs` is a dry run
  until `--confirm`. Show `preview.md`, get an explicit yes for those exact listings, then confirm.
- **Never handle keys.** The seller approves a `pubkyauth://` QR in Pubky Ring. The grant is
  scoped to `/pub/pubky.app/marketplace/:rw` and stored where the official `pubky-shop` CLI keeps
  sessions (macOS keychain, else a 0600 file).
- **Only USD (exponent 2) or BTC (exponent 8, sats)** are Shop prices. Convert at build time
  and show the rate.
- **Ask the seller** about currency, products, shipping (price, days, destinations), stock
  share and language. The Shop cannot restrict shipping destinations or sync stock, so say so.
- The Shop contract is pre-1.0 (contract v1, taxonomy v2). If validation suddenly fails,
  re-check [`references/listing-record.md`](references/listing-record.md) against upstream.

## Workflow (scripts in this skill's `scripts/`, Node ≥ 22, `npm install` once)

```bash
node export.mjs   --config pubky-import/config.json --ids 12,34 [--ssh]   # products.json
node build.mjs    --config pubky-import/config.json                       # plan.json + preview.md
node login.mjs    --qr-png pubky-import/login-qr.png                      # seller approves in Ring
node publish.mjs  --config pubky-import/config.json            # dry run, then --confirm
npx pubky-shop auth login && npx pubky-shop auth login --complete         # 24 h service bearer
node register.mjs --config pubky-import/config.json            # checkout: sync-many
node status.mjs   --config pubky-import/config.json            # homeserver / index / checkout
```

Re-running is idempotent: same listing id per WooCommerce product, unchanged records are
skipped, changed ones get `revision + 1`. `--state paused|removed` pauses or withdraws.

## Where to look

| Task | Read |
| :-- | :-- |
| Config keys, each step's flags, overrides, language and shipping rules, limits, troubleshooting | `references/workflow.md` |
| The listing record contract, paths, validation rules that bite, endpoints, upstream sources | `references/listing-record.md` |
