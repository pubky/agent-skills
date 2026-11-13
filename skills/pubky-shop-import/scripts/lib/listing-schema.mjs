// Listing record validation, ported from pubky/pubky-marketplace
// src/libs/commerce/marketplace-records.ts (commerceListingRecordSchema) and
// src/libs/commerce/transaction-contracts.ts, limits from src/config/commerce.ts.
// Keep in sync when the Shop bumps its contract; see references/pubky-shop-format.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fetchJson } from "./common.mjs";

export const CONTRACT_VERSION = 1;
export const TAXONOMY_VERSION = 2;
export const LIMITS = {
  titleMin: 3,
  titleMax: 80,
  descriptionMax: 10_000,
  maxImages: 12,
  studioMaxPhotos: 8,
  maxVariants: 100,
  maxOptionDimensions: 3,
  maxTags: 10,
  maxQuantity: 1_000_000,
  altTextMax: 300,
  policyMax: 4_000,
};

const Z32 = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const pubky = z.string().regex(Z32, "Expected a 52-character z-base-32 Pubky");
const entityId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "Expected a path-safe id");
const timestamp = z.iso.datetime({ offset: true });
const money = z
  .object({
    amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().min(3).max(12).regex(/^[A-Z][A-Z0-9]*$/),
    exponent: z.number().int().min(0).max(18),
  })
  .strict();
const positiveMoney = money.refine((m) => m.amountMinor > 0, { message: "Expected a positive amount" });
const marketplaceUri = z
  .string()
  .regex(
    /^pubky:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}\/pub\/pubky\.app\/marketplace\/v1\/[A-Za-z0-9_./-]+$/,
    "Expected a Pubky marketplace v1 URI",
  );

const media = z.looseObject({
  id: entityId,
  type: z.enum(["image", "video"]),
  url: marketplaceUri,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase BLAKE3 hash"),
  mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]+$/i),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  durationMs: z.number().int().positive().optional(),
  altText: z.string().trim().min(1).max(LIMITS.altTextMax),
});

const variant = z.looseObject({
  id: entityId,
  sku: z.string().trim().min(1).max(64).optional(),
  options: z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(80)),
  priceOverride: positiveMoney.optional(),
  quantity: z.number().int().min(0).max(LIMITS.maxQuantity),
  mediaIds: z.array(entityId).max(LIMITS.maxImages + 1).default([]),
  enabled: z.boolean().default(true),
});

const sale = z.discriminatedUnion("format", [
  z.looseObject({ format: z.literal("fixed_price"), unitPrice: positiveMoney, acceptsOffers: z.boolean() }),
  z.looseObject({
    format: z.literal("auction"),
    startingPrice: positiveMoney,
    buyNowPrice: positiveMoney.optional(),
    minimumIncrement: positiveMoney,
    startsAt: timestamp,
    endsAt: timestamp,
    antiSnipingWindowSeconds: z.number().int().min(0).max(3600),
    antiSnipingExtensionSeconds: z.number().int().min(0).max(3600),
  }),
]);

const days = z.number().int().min(0).max(365);
const shippingOption = z.discriminatedUnion("pricing", [
  z.looseObject({ id: entityId, pricing: z.literal("free"), label: z.string().trim().min(1).max(100), estimatedMinDays: days, estimatedMaxDays: days }),
  z.looseObject({ id: entityId, pricing: z.literal("flat"), label: z.string().trim().min(1).max(100), price: money, estimatedMinDays: days, estimatedMaxDays: days }),
]);

const listing = z
  .looseObject({
    schemaVersion: z.literal(CONTRACT_VERSION),
    recordType: z.literal("listing"),
    ownerPubky: pubky,
    revision: z.number().int().positive(),
    createdAt: timestamp,
    updatedAt: timestamp,
    listingId: entityId,
    state: z.enum(["active", "paused", "ended", "removed"]),
    title: z.string().trim().min(LIMITS.titleMin).max(LIMITS.titleMax),
    description: z.string().trim().min(1).max(LIMITS.descriptionMax),
    taxonomyVersion: z.number().int().min(1).max(1_000_000),
    categoryId: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    attributes: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    condition: z.enum(["new", "like_new", "excellent", "good", "fair", "for_parts"]),
    conditionDetails: z.string().trim().max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(LIMITS.maxTags),
    location: z.looseObject({
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      region: z.string().trim().min(1).max(100).optional(),
    }),
    media: z.array(media).min(1).max(LIMITS.maxImages + 1),
    variants: z.array(variant).min(1).max(LIMITS.maxVariants),
    sale,
    fulfillmentMethods: z.array(z.enum(["physical", "digital", "shipping", "pickup"])).min(1).max(4),
    package: z
      .looseObject({
        weightGrams: z.number().int().positive().max(1_000_000),
        lengthMillimeters: z.number().int().positive().max(100_000),
        widthMillimeters: z.number().int().positive().max(100_000),
        heightMillimeters: z.number().int().positive().max(100_000),
      })
      .optional(),
    shippingOptions: z.array(shippingOption).max(20),
    returnPolicy: z.looseObject({
      acceptsReturns: z.boolean(),
      returnWindowDays: z.number().int().min(1).max(365).optional(),
      buyerPaysReturnShipping: z.boolean(),
      details: z.string().trim().max(LIMITS.policyMax).optional(),
    }),
    adultOnly: z.boolean(),
  })
  .superRefine((l, ctx) => {
    const issue = (message, p) => ctx.addIssue({ code: "custom", message, path: p });
    const unique = (values, p, message) => new Set(values).size !== values.length && issue(message, p);
    if (Date.parse(l.updatedAt) < Date.parse(l.createdAt)) issue("updatedAt must not precede createdAt", ["updatedAt"]);
    unique(l.media.map((m) => m.id), ["media"], "Media ids must be unique");
    unique(l.variants.map((v) => v.id), ["variants"], "Variant ids must be unique");
    unique(l.variants.flatMap((v) => (v.sku ? [v.sku] : [])), ["variants"], "Variant SKUs must be unique");
    unique(l.tags, ["tags"], "Tags must be unique");
    unique(l.fulfillmentMethods, ["fulfillmentMethods"], "Fulfillment methods must be unique");
    unique(l.shippingOptions.map((o) => o.id), ["shippingOptions"], "Shipping option ids must be unique");
    const images = l.media.filter((m) => m.type === "image").length;
    if (images === 0 || images > LIMITS.maxImages) issue(`Listings require 1-${LIMITS.maxImages} images`, ["media"]);
    const mediaIds = new Set(l.media.map((m) => m.id));
    l.variants.forEach((v, i) => {
      if (Object.keys(v.options).length > LIMITS.maxOptionDimensions) issue("At most 3 option dimensions", ["variants", i]);
      v.mediaIds.forEach((id) => !mediaIds.has(id) && issue("Variant references unknown media", ["variants", i]));
    });
    if (l.state === "active" && !l.variants.some((v) => v.enabled && v.quantity > 0)) {
      issue("An active listing requires available quantity", ["variants"]);
    }
    const physical = l.fulfillmentMethods.includes("physical");
    if (physical && !l.package) issue("Physical fulfillment requires package facts", ["package"]);
    if (physical && l.shippingOptions.length === 0) issue("Physical fulfillment requires a shipping option", ["shippingOptions"]);
    if (!physical && (l.package || l.shippingOptions.length > 0)) issue("Package/shipping require physical fulfillment", ["fulfillmentMethods"]);
    const r = l.returnPolicy;
    if (r.acceptsReturns && r.returnWindowDays === undefined) issue("Return window required when returns are accepted", ["returnPolicy"]);
    if (!r.acceptsReturns && r.returnWindowDays !== undefined) issue("No return window without returns", ["returnPolicy"]);
    const primary = l.sale.format === "fixed_price" ? l.sale.unitPrice : l.sale.startingPrice;
    const sameAsset = (m) => m.currency === primary.currency && m.exponent === primary.exponent;
    l.variants.forEach((v, i) => v.priceOverride && !sameAsset(v.priceOverride) && issue("Variant price must use the listing asset", ["variants", i]));
    l.shippingOptions.forEach((o, i) => o.pricing === "flat" && !sameAsset(o.price) && issue("Shipping price must use the listing asset", ["shippingOptions", i]));
    if (!["USD", "BTC"].includes(primary.currency)) issue("The Shop only prices in USD (exp 2) or BTC (exp 8)", ["sale"]);
    const mediaPrefix = `pubky://${l.ownerPubky}/pub/pubky.app/marketplace/v1/media/`;
    l.media.forEach((m, i) => !m.url.startsWith(mediaPrefix) && issue("Media must be owned by the seller", ["media", i, "url"]));
    if (!categoryIds().has(l.categoryId)) issue(`Unknown taxonomy v2 category: ${l.categoryId}`, ["categoryId"]);
  });

export function validateListing(record) {
  const result = listing.safeParse(record);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.join(".") || "(record)"}: ${i.message}`);
}

// The category tree is client config in the Shop repo (taxonomy v2), fetched rather than copied.
export const TAXONOMY_URL =
  "https://raw.githubusercontent.com/pubky/pubky-marketplace/master/src/config/taxonomy/taxonomy-tree.v2.json";

let cachedCategories;

/** Loads the taxonomy (cached as <workDir>/taxonomy-v2.json; delete it to refresh). */
export async function loadCategories(workDir) {
  const cacheFile = path.join(workDir, "taxonomy-v2.json");
  let tree;
  if (existsSync(cacheFile)) {
    tree = JSON.parse(readFileSync(cacheFile, "utf8"));
  } else {
    tree = await fetchJson(TAXONOMY_URL);
    writeFileSync(cacheFile, JSON.stringify(tree));
  }
  cachedCategories = new Map();
  const walk = (nodes, labels) => {
    for (const node of nodes) {
      const trail = [...labels, node.label ?? node.id];
      cachedCategories.set(node.id, { kind: node.children?.length ? "branch" : "leaf", label: trail.join(" > ") });
      walk(node.children ?? [], trail);
    }
  };
  walk(tree, []);
  return cachedCategories;
}

export function categoryIds() {
  if (!cachedCategories) throw new Error("call loadCategories(workDir) first");
  return cachedCategories;
}
