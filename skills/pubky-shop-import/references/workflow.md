# Importing a WooCommerce catalog into Pubky Shop

Hand-authored procedure for the bundled scripts (`../scripts/`). The record contract they
produce is in [`listing-record.md`](listing-record.md); sessions and `pubkyauth` are in
[`../../pubky/references/auth.md`](../../pubky/references/auth.md).

## Setup

- Node ≥ 22. Run `npm install` in `scripts/` once (pins `@synonymdev/pubky` **0.11.x**, the
  version shop.pubky.app and the `@bitcoinerrorlog/pubky-shop` CLI use, so stored sessions
  stay restorable by both).
- Copy `scripts/config.example.json` to a project folder, e.g. `pubky-import/config.json`.
  Every script takes `--config`; working files (`products.json`, `plan.json`, `preview.md`,
  `media/`, `published.json`, `overrides.json`, `taxonomy-v2.json`) live next to it.
- The seller needs, in shop.pubky.app, signed in with Ring: a **shop profile** (My shop), at
  least one **payment method** (Bitcoin via Paykit, or PayPal), and for shipped items a
  **delivery key** (Shipping settings). `publish.mjs` checks the profile and key; the payment
  config is public at `GET <service>/v0/sellers/<pubky>/payment-config`.

## Decisions to ask the seller for

| Config key | Question | Notes |
| :-- | :-- | :-- |
| `selection.productIds` / `--ids` / `--all` | Which products? | Start with a small test batch. |
| `pricing.currency` | USD or BTC? | Rate source: ECB via frankfurter.app (USD), mempool.space (BTC). `pricing.fixedRate`, `markupPercent`, `rounding` (`cent`, `whole`, `x.99`). |
| `shipping` | Price, days, destinations | `price: "woocommerce"` uses the store's own one-unit rate (needs `export --ssh`); or a number in store currency; or `pricing: "free"`. One option per listing. |
| `defaults.stockShare` | How much stock to list? | No stock sync exists; listing a share (rounded down, min 1) limits overselling. |
| `language.prefer` | Listing language? | Uses the store's translated page text when it really is translated. |
| `returnPolicy` | Returns? | `returnWindowDays` only when `acceptsReturns`. |

## Steps

1. **Export:** `node export.mjs --config … [--ids …|--all] [--ssh|--ssh-stock|--ssh-shipping] [--translations en]`.
   Reads the public Store API (`/wp-json/wc/store/v1/products`, no credentials). The Store API
   shows stock only when low; `--ssh-stock` reads `_stock` through `ssh <source.ssh.host>
   wp eval-file -`. `--ssh-shipping` asks WooCommerce for the cheapest paid rate for one unit to
   `source.shipping.country` (in memory, nothing written). `--translations <lang>` fetches
   `/<lang>/product/<slug>/` (TranslatePress-style) and records whether short and long texts are
   actually translated.
2. **Build:** `node build.mjs --config …`. Maps products to drafts, downloads and (on macOS, with
   `sips`) shrinks photos, hashes them with BLAKE3, validates every record and writes
   `preview.md`. Fix every ❌ before going on. Photos that aren't PNG/JPEG/WebP/GIF (e.g. SVG)
  are skipped with a note, and a (nearly) empty description is flagged.
3. **Sign in:** run `node login.mjs --qr-png <file>` in the background, show the PNG and the link,
   and wait for approval (the relay drops the request after about 5 minutes). Check with
   `login.mjs --status`; remove with `--logout`.
4. **Dry run, then publish:** `node publish.mjs --config …`, add `--show` to print records, and
   only after the seller's yes, `--confirm`. Photos already on the homeserver are not re-uploaded,
   and records are read back after writing.
5. **Register for checkout:** `npx pubky-shop auth login` (second QR, for the marketplace
   service), then `npx pubky-shop auth login --complete`, then `node register.mjs --config …`
   (`POST /v1/listings/sync-many`, 100 per call).
6. **Verify:** `node status.mjs --config …` shows the homeserver revision, whether Nexus has
   indexed it, and checkout availability (`available|reserved|sold`), plus the listing URL.

## Mapping rules

- **Category:** `overrides` → `categories.titleRules` (regex on the title) →
  `categories.byWooCategory` (first matching store category slug) → `categories.default`. Ids
  must exist in taxonomy v2 (fetched from upstream, cached as `taxonomy-v2.json`). Prefer leaves.
- **Text:** overrides → translated page (never mixed: an untranslated part is dropped) → store
  text. HTML becomes plain text, `description.dropLines` regexes remove store-internal leftovers,
  and `description.footer` (with `{url}`) is appended.
- **Item language:** `source.languageAttribute` (e.g. a books language filter) adds
  `language.descriptionLine` and, if it differs from `language.listingLanguageName`, the
  `language.titleSuffix`. The Shop has no language attribute.
- **Variants:** WooCommerce variations become variants (`size`/`color`/`style`, max 3), with
  `priceOverride` when their price differs. Shared parent SKUs get `-<variationId>`. Option
  values can be translated with `language.valueNames` (e.g. `"Schwarz": "Black"`).
- **Package:** WooCommerce weight and dimensions (`source.weightUnit`, `source.dimensionUnit`),
  otherwise `defaults.package`. Physical listings must have one.
- **Overrides:** `<workDir>/overrides.json` keyed by product id: `title`, `description`,
  `categoryId`, `condition`, `tags`, `quantity`, `shippingPrice`, `skip`, `acceptsOffers`,
  `noFooter`. Overrides survive re-runs.

## Limits to tell the seller

- **No destination restriction.** A shipping option has a price and days but no country list.
  Put the restriction in the label, the description footer and the shop's shipping policy.
  Foreign orders must be cancelled and refunded by hand.
- **No stock sync** between the store and the Shop in either direction. Re-run
  export → build → publish → register to refresh prices and stock.
- Shipping is charged per order line, not per unit.

## Troubleshooting

- `No stored Pubky session` / `Session lacks …`: run `login.mjs` again; grants can be revoked in Ring.
- `401 No authenticated session` mid-run: another process restored the same stored session and got
  a fresh token. `publish.mjs` re-authenticates once, but don't run two session scripts at the same time.
  Re-running `publish.mjs` is safe: finished listings are skipped, and `published.json` is written after each one.
- Homeserver `429`: the scripts back off. Publish large catalogs in batches with `--ids`.
- On the homeserver but not in the catalog: indexing usually takes seconds to a minute. The
  Nexus host comes from shop.pubky.app/llms.txt and may move (`NEXUS_ORIGIN` in `lib/common.mjs`).
- `register.mjs` `INVALID_STATE`: the service rejected the record. Rebuild and fix the
  validation output. `401`: the 24 h service bearer expired, so log in with the CLI again.
