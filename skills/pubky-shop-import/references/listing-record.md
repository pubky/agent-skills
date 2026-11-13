# Pubky Shop listing record (contract v1, taxonomy v2)

What the import scripts write and why. This is a summary of upstream code that is still
pre-1.0, so treat upstream as authoritative and re-check it when validation starts failing.

## Upstream sources

| What | Where |
| :-- | :-- |
| Listing record schema (Zod, open-world) | [`marketplace-records.ts`](https://github.com/pubky/pubky-marketplace/blob/master/src/libs/commerce/marketplace-records.ts) |
| Money, id and pubky schemas | [`transaction-contracts.ts`](https://github.com/pubky/pubky-marketplace/blob/master/src/libs/commerce/transaction-contracts.ts) |
| Limits (`COMMERCE_*`), contract version | [`src/config/commerce.ts`](https://github.com/pubky/pubky-marketplace/blob/master/src/config/commerce.ts) |
| Category tree (fetched at build time) | [`taxonomy-tree.v2.json`](https://github.com/pubky/pubky-marketplace/blob/master/src/config/taxonomy/taxonomy-tree.v2.json) |
| Seller CLI, credential store, Shopify bridge | [`pubky/pubky-shop-sdk`](https://github.com/pubky/pubky-shop-sdk) |
| Service routes (sessions, sync-many, availability) | [`pubky-marketplace-service/docs/api.md`](https://github.com/pubky/pubky-marketplace-service/blob/main/docs/api.md) |
| Read-only index recipes for agents | [shop.pubky.app/llms.txt](https://shop.pubky.app/llms.txt) |

`scripts/lib/listing-schema.mjs` ports the listing schema for local validation. Update it
together with the upstream schema.

## Paths on the seller's homeserver

All are public under `/pub`. For the `pubky://` and session model see
[`../../pubky/references/concepts.md`](../../pubky/references/concepts.md).

- `/pub/pubky.app/marketplace/v1/listings/<listingId>`: listing JSON, no `.json` suffix
- `/pub/pubky.app/marketplace/v1/media/<mediaId>`: raw image bytes (`putBytes`)
- `/pub/pubky.app/marketplace/v1/delivery-keys/current`: needed for shipped checkout
- `/pub/pubky.app/marketplace/v1/shop.json`: shop profile, created in the Shop UI

The session needs only `/pub/pubky.app/marketplace/:rw`.

## Shape (fixed price, physical)

```json
{
  "schemaVersion": 1, "recordType": "listing", "ownerPubky": "<z32>",
  "revision": 1, "createdAt": "<ISO>", "updatedAt": "<ISO>",
  "listingId": "<[A-Za-z0-9_-]{1,128}>", "state": "active",
  "title": "3-80 chars", "description": "1-10000 chars, plain text",
  "taxonomyVersion": 2, "categoryId": "books-media-books", "condition": "new",
  "tags": ["<=10 unique, <=40 chars"], "location": { "countryCode": "CH" },
  "media": [{ "id": "<id>", "type": "image",
    "url": "pubky://<owner>/pub/pubky.app/marketplace/v1/media/<id>",
    "contentHash": "<64 hex BLAKE3 of the bytes>", "mimeType": "image/png",
    "byteSize": 123, "width": 1500, "height": 1500, "altText": "1-300 chars" }],
  "variants": [{ "id": "default", "options": {}, "quantity": 3, "mediaIds": ["<id>"], "enabled": true }],
  "sale": { "format": "fixed_price", "acceptsOffers": false,
    "unitPrice": { "amountMinor": 2523, "currency": "USD", "exponent": 2 } },
  "fulfillmentMethods": ["physical"],
  "package": { "weightGrams": 410, "lengthMillimeters": 210, "widthMillimeters": 130, "heightMillimeters": 25 },
  "shippingOptions": [{ "id": "seller_flat_rate", "pricing": "flat", "label": "...",
    "price": { "amountMinor": 841, "currency": "USD", "exponent": 2 },
    "estimatedMinDays": 1, "estimatedMaxDays": 3 }],
  "returnPolicy": { "acceptsReturns": true, "returnWindowDays": 14, "buyerPaysReturnShipping": true },
  "adultOnly": false
}
```

## Rules that bite

- **Money** is only `USD`/2 or `BTC`/8 in the Shop UI. Variant `priceOverride` and flat shipping
  prices must use the sale's currency and exponent.
- **Media** needs 1-12 images (the sell form allows 8), and every URL must sit under the
  **owner's** `/media/` prefix. `contentHash` is **BLAKE3**, not SHA-256. Width and height
  are required.
- **Active** needs at least one enabled variant with `quantity > 0`. SKUs, variant ids,
  media ids, tags and shipping-option ids must be unique. Variants have at most 3 option keys.
- **`physical`** requires `package` and at least one shipping option. A non-physical listing must
  have neither. Shipping options carry no destination list.
- **`returnWindowDays`** is required with `acceptsReturns: true` and forbidden without it.
- **Never** put `reservePrice`/`reserveMet` keys in a public record.
- **Optional fields** should be omitted, not set to `null`. Records are open-world, so don't
  invent extra fields.
- **Updates:** keep the `listingId` and `createdAt`, bump `revision`, set a new `updatedAt`.
  Deleting the file is the tombstone. `state: "removed"` keeps the record.

## Auth and registration

- **Homeserver:** a grant flow with Pubky Ring, using `startGrantAuthFlow(caps, AuthFlowKind.signin(), { clientId })`,
  `awaitApproval()` and `exportLocalSecret()` / `restoreSession()`. Details are in
  [`../../pubky/references/auth.md`](../../pubky/references/auth.md).
- **Marketplace service:** a 24 h bearer, from `POST /v1/auth/sessions` (AuthToken bytes) or the
  `pubky-shop auth login` CLI flow. `POST /v1/listings/sync-many` with
  `{listings:[{seller_pubky, listing_id}]}` (1-100 items, response 207, per-item status) makes
  fixed-price listings purchasable.
- **Public checks:** `GET <service>/v0/listings/<seller>/<id>/availability` returns
  `available|reserved|sold`, or 404 if unregistered. Nexus serves
  `GET /v0/listing/<seller>/<id>` and `/v0/shop/<seller>`.

## Production hosts (as of 2026-10)

- Shop: `https://shop.pubky.app`. Listing page: `/marketplace/listing/<seller>/<listingId>`.
- Marketplace service: `https://marketplace-service-production-ce23.up.railway.app`, the
  default in the `pubky-shop` CLI.
- Nexus index: the `INDEX` host named in shop.pubky.app/llms.txt. It may move.
