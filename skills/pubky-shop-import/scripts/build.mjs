#!/usr/bin/env node
// Step 2 — turn <workDir>/products.json into Pubky listing drafts:
// <workDir>/plan.json (+ preview.md, media/). Nothing is published here.
//
//   node build.mjs --config pubky-import/config.json [--ids 3698,5935] [--offline-rate]
//
// Per-product manual edits (e.g. English title/description) go in
// <workDir>/overrides.json: { "<productId>": { "title": "...", "description": "...",
// "categoryId": "...", "condition": "...", "tags": [...], "quantity": 3, "skip": true } }
// They survive re-runs of export/build.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ASSETS, blake3Hex, convertMoney, die, fetchRate, fetchWithRetry, formatMoney, htmlToText,
  loadConfig, parseArgs, readJson, shrinkIfNeeded, sniffImageMime, imageSize, stableId,
  truncate, writeJson,
} from "./lib/common.mjs";
import { LIMITS, TAXONOMY_VERSION, categoryIds, loadCategories, validateListing } from "./lib/listing-schema.mjs";
import { materialize } from "./lib/record.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const { config, workDir } = loadConfig(flags);
const productsFile = path.join(workDir, "products.json");
if (!existsSync(productsFile)) die(`Run export.mjs first (${productsFile} missing)`);
const { products, storeUrl } = readJson(productsFile);
const overridesFile = path.join(workDir, "overrides.json");
const overrides = existsSync(overridesFile) ? readJson(overridesFile) : {};
const onlyIds = flags.ids ? new Set(String(flags.ids).split(",").map((s) => Number(s.trim()))) : null;
await loadCategories(workDir);

// ---------------------------------------------------------------- settings
const pricing = { currency: "USD", rounding: "cent", markupPercent: 0, ...config.pricing };
const asset = ASSETS[pricing.currency] ?? die(`pricing.currency must be USD or BTC, got ${pricing.currency}`);
const sourceCurrency = products[0]?.currency ?? "CHF";
const shipping = config.shipping;
if (!shipping || !["flat", "free"].includes(shipping.pricing) || !shipping.label ||
    !Number.isInteger(shipping.minDays) || !Number.isInteger(shipping.maxDays) ||
    (shipping.pricing === "flat" && typeof shipping.price !== "number" && shipping.price !== "woocommerce")) {
  die("config.shipping is incomplete: needs pricing (flat|free), label, minDays, maxDays and, for flat, price " +
    '(a number in the shop currency, or "woocommerce" = per-product rate from `export.mjs --ssh-shipping`).');
}
const language = { prefer: null, names: {}, descriptionLine: "Language: {language}", titleSuffix: " ({language})", ...config.language };
const defaults = {
  condition: "new",
  quantityWhenUnknown: 1,
  maxQuantity: 50,
  acceptsOffers: false,
  countryCode: "CH",
  ...config.defaults,
};
const pkgDefault = { weightGrams: 500, lengthMillimeters: 250, widthMillimeters: 180, heightMillimeters: 60, ...config.defaults?.package };
const returns = config.returnPolicy ?? { acceptsReturns: true, returnWindowDays: 14, buyerPaysReturnShipping: true };
const maxPhotos = Math.min(config.media?.maxPhotos ?? LIMITS.studioMaxPhotos, LIMITS.maxImages);

let rate;
let rateSource;
if (pricing.fixedRate) {
  rate = pricing.fixedRate;
  rateSource = `fixed in config: 1 ${sourceCurrency} = ${rate} ${pricing.currency}`;
} else {
  ({ rate, source: rateSource } = await fetchRate(sourceCurrency, pricing.currency));
}
const toListingMoney = (amount) => convertMoney(amount, pricing, rate);
const shippingMoney = (amount) => convertMoney(amount, { ...pricing, rounding: "cent", markupPercent: 0 }, rate);

// ---------------------------------------------------------------- mapping
function resolveCategory(product, override) {
  if (override?.categoryId) return override.categoryId;
  for (const rule of config.categories?.titleRules ?? []) {
    if (new RegExp(rule.match, "i").test(product.name)) return rule.category;
  }
  for (const rule of config.categories?.byWooCategory ?? []) {
    if (product.categories.includes(rule.woo)) return rule.category;
  }
  return config.categories?.default ?? "other";
}

function resolveCondition(product, override) {
  if (override?.condition) return override.condition;
  for (const rule of config.conditionRules ?? []) {
    if (new RegExp(rule.match, "i").test(product.name)) return rule.condition;
  }
  return defaults.condition;
}

function buildTags(product, override) {
  if (override?.tags) return override.tags;
  const words = product.name
    .toLocaleLowerCase("de-CH")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !(config.tags?.stopwords ?? []).includes(w));
  const candidates = [...(config.tags?.always ?? []), ...product.tags, ...product.brands, ...words]
    .map((t) => t.toLocaleLowerCase("de-CH").trim().slice(0, 40))
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, Math.min(config.tags?.max ?? 8, LIMITS.maxTags));
}

/** Picks the listing text: overrides > translated page (if really translated) > source text. */
function chooseTexts(product, override, warnings) {
  const t = language.prefer ? product.translations?.[language.prefer] : null;
  let title = product.name;
  let shortHtml = product.shortDescriptionHtml;
  let longHtml = product.descriptionHtml;
  let textLanguage = "source";
  if (t?.translated && (t.translated.short || t.translated.long)) {
    textLanguage = language.prefer;
    if (t.title) title = t.title;
    // Never mix languages: drop a part the translation left untranslated.
    shortHtml = t.translated.short ? t.shortDescriptionHtml : "";
    longHtml = t.translated.long ? t.descriptionHtml : "";
    if (!t.translated.short || !t.translated.long) warnings.push(`${language.prefer} page only partly translated — used the translated part`);
  } else if (language.prefer && t) {
    warnings.push(`no ${language.prefer} translation on ${t.url} — source text used`);
  }
  if (override?.title) title = override.title;
  const url = textLanguage !== "source" && t?.url ? t.url : product.permalink;
  return { title, shortHtml, longHtml, textLanguage, url };
}

function itemLanguage(product) {
  const attribute = config.source?.languageAttribute;
  const value = attribute ? product.attributes?.[attribute]?.[0] : undefined;
  return value ? (language.names[value] ?? value) : null;
}

const dropLinePatterns = (config.description?.dropLines ?? []).map((pattern) => new RegExp(pattern, "i"));
/** Removes shop-internal leftovers (cross-sell links whose text was an image, "→ Link to …"). */
function cleanText(text) {
  return text
    .split("\n")
    .filter((line) => !dropLinePatterns.some((re) => re.test(line.trim())))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildDescription(product, override, texts, itemLang) {
  const short = cleanText(htmlToText(texts.shortHtml));
  const long = cleanText(htmlToText(texts.longHtml));
  const parts = override?.description
    ? [override.description.trim()]
    : [short, long && !(short && long.startsWith(short.slice(0, 60))) ? long : ""].filter(Boolean);
  if (itemLang && language.descriptionLine) parts.unshift(language.descriptionLine.replaceAll("{language}", itemLang));
  if (config.description?.footer && !override?.noFooter) {
    parts.push(config.description.footer.replaceAll("{url}", texts.url ?? product.permalink));
  }
  const text = parts.join("\n\n") || product.name;
  return truncate(text, LIMITS.descriptionMax);
}

/** Listed quantity: a share of the real stock (defaults.stockShare, rounded down, at least 1). */
function quantityOf(item, override) {
  if (Number.isInteger(override?.quantity)) return override.quantity;
  if (!item.inStock) return 0;
  const known = item.stock ?? item.lowStockRemaining;
  if (!Number.isInteger(known)) return Math.min(defaults.quantityWhenUnknown, defaults.maxQuantity);
  if (known <= 0) return 0;
  const share = typeof defaults.stockShare === "number" ? defaults.stockShare : 1;
  return Math.max(1, Math.min(Math.floor(known * share), defaults.maxQuantity));
}

function packageOf(item, product) {
  const unit = config.source?.weightUnit ?? "g";
  const dimUnit = config.source?.dimensionUnit ?? "cm";
  const weight = Number.parseFloat(item.weight ?? product.weight);
  const dims = item.dimensions?.length ? item.dimensions : product.dimensions;
  const toMm = (v) => Math.round(Number.parseFloat(v) * (dimUnit === "mm" ? 1 : dimUnit === "m" ? 1000 : 10));
  const hasDims = dims && ["length", "width", "height"].every((k) => Number.parseFloat(dims[k]) > 0);
  return {
    weightGrams: weight > 0 ? Math.round(weight * (unit === "kg" ? 1000 : unit === "lbs" ? 453.6 : 1)) : pkgDefault.weightGrams,
    lengthMillimeters: hasDims ? toMm(dims.length) : pkgDefault.lengthMillimeters,
    widthMillimeters: hasDims ? toMm(dims.width) : pkgDefault.widthMillimeters,
    heightMillimeters: hasDims ? toMm(dims.height) : pkgDefault.heightMillimeters,
  };
}

function optionKey(name) {
  const mapped = config.variantOptionKeys?.[name];
  if (mapped) return mapped;
  if (/size|gr(ö|oe)sse|grosse/i.test(name)) return "size";
  if (/colou?r|farbe/i.test(name)) return "color";
  return "style";
}

async function downloadMedia(product, images, title, warnings) {
  const dir = path.join(workDir, "media");
  mkdirSync(dir, { recursive: true });
  const media = [];
  const seen = new Set();
  for (const [index, image] of images.entries()) {
    if (media.length >= maxPhotos) break;
    if (!image.src.startsWith("https://")) continue;
    const file = path.join(dir, `${product.id}-${index + 1}${path.extname(new URL(image.src).pathname) || ".img"}`);
    if (!existsSync(file)) {
      const response = await fetchWithRetry(image.src, { headers: { accept: "image/*" } });
      if (!response.ok) {
        warnings.push(`photo ${index + 1} skipped (HTTP ${response.status})`);
        continue;
      }
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
    }
    // Only raster formats the Shop renders (PNG/JPEG/WebP/GIF); SVG and others are skipped.
    if (!sniffImageMime(new Uint8Array(readFileSync(file)))) {
      warnings.push(`photo ${index + 1} skipped (${path.extname(file) || "unknown"} is not PNG/JPEG/WebP/GIF)`);
      continue;
    }
    const bytes = shrinkIfNeeded(file, { maxEdge: config.media?.maxEdge ?? 2000, maxBytes: config.media?.maxBytes ?? 3_000_000 });
    const mimeType = sniffImageMime(bytes);
    const { width, height } = imageSize(bytes);
    const contentHash = blake3Hex(bytes);
    const id = contentHash.slice(0, 32);
    if (seen.has(id)) continue;
    seen.add(id);
    media.push({
      id, type: "image", file: path.relative(workDir, file), mimeType, byteSize: bytes.length,
      width, height, contentHash, altText: truncate(image.alt || title, LIMITS.altTextMax), sourceUrl: image.src,
    });
  }
  return media;
}

// ---------------------------------------------------------------- build
const DUMMY_OWNER = "y".repeat(52);

const listings = [];
for (const product of products) {
  if (onlyIds && !onlyIds.has(product.id)) continue;
  const override = overrides[String(product.id)] ?? {};
  const warnings = [];
  const texts = chooseTexts(product, override, warnings);
  const itemLang = itemLanguage(product);
  let title = texts.title.replace(/\s+/g, " ").trim();
  if (itemLang && !override.title && language.titleSuffix && itemLang !== language.listingLanguageName) {
    const suffix = language.titleSuffix.replaceAll("{language}", itemLang);
    if (!title.includes(itemLang) && title.length + suffix.length <= LIMITS.titleMax) title += suffix;
  }
  title = truncate(title, LIMITS.titleMax);
  const base = toListingMoney(product.price);

  let variants;
  if (product.variations.length) {
    const keys = new Set();
    const skuCounts = new Map();
    for (const v of product.variations) if (v.sku) skuCounts.set(v.sku, (skuCounts.get(v.sku) ?? 0) + 1);
    const variantSku = (v) => {
      if (!v.sku) return undefined;
      const shared = skuCounts.get(v.sku) > 1 || v.sku === product.sku;
      return (shared ? `${v.sku}-${v.id}` : v.sku).slice(0, 64);
    };
    variants = product.variations.slice(0, LIMITS.maxVariants).map((v) => {
      const options = {};
      for (const [name, value] of Object.entries(v.options)) {
        let key = optionKey(name);
        while (options[key] !== undefined) key = `${key}2`;
        keys.add(key);
        options[key] = String(language.valueNames?.[value] ?? value).slice(0, 80);
      }
      const price = toListingMoney(v.price);
      const quantity = quantityOf(v, override.variants?.[v.id]);
      return {
        id: `v${v.id}`,
        ...(variantSku(v) ? { sku: variantSku(v) } : {}),
        options,
        ...(price.amountMinor !== base.amountMinor ? { priceOverride: price } : {}),
        quantity,
        enabled: quantity > 0,
      };
    });
    if (keys.size > LIMITS.maxOptionDimensions) warnings.push(`more than ${LIMITS.maxOptionDimensions} option dimensions`);
  } else {
    variants = [{ id: "default", ...(product.sku ? { sku: product.sku.slice(0, 64) } : {}), options: {}, quantity: quantityOf(product, override), enabled: true }];
  }

  const totalQty = variants.reduce((sum, v) => sum + (v.enabled ? v.quantity : 0), 0);
  let include = !override.skip;
  if (override.skip) warnings.push("skipped via overrides.json");
  if (totalQty === 0) {
    include = false;
    warnings.push("out of stock — not published");
  }
  if (!product.purchasable) {
    include = false;
    warnings.push("not purchasable in WooCommerce — not published");
  }
  if (!product.weight && !product.variations.some((v) => v.weight)) warnings.push(`no weight in WooCommerce — default ${pkgDefault.weightGrams} g`);

  let shippingCost = typeof override.shippingPrice === "number" ? override.shippingPrice : shipping.price;
  if (shipping.pricing === "flat" && shippingCost === "woocommerce") {
    shippingCost = product.shipping?.cost;
    if (typeof shippingCost !== "number") {
      include = false;
      shippingCost = 0;
      warnings.push("no WooCommerce shipping rate — run export.mjs --ssh-shipping (or set overrides.shippingPrice)");
    }
  }

  const categoryId = resolveCategory(product, override);
  const category = categoryIds().get(categoryId);
  if (!category) warnings.push(`unknown category ${categoryId}`);
  else if (category.kind === "branch") warnings.push(`category ${categoryId} is a branch, not a leaf`);

  const images = [...product.images, ...product.variations.flatMap((v) => v.images)];
  const media = include || flags["all-media"] ? await downloadMedia(product, images, title, warnings) : [];
  if (include && media.length === 0) {
    include = false;
    warnings.push("no usable images — not published");
  }

  const entry = {
    productId: product.id,
    listingId: stableId(`${storeUrl}|product|${product.id}`),
    include,
    source: { permalink: product.permalink, sku: product.sku, price: product.price, currency: product.currency },
    warnings,
    draft: {
      title,
      description: buildDescription(product, override, texts, itemLang),
      taxonomyVersion: TAXONOMY_VERSION,
      categoryId,
      condition: resolveCondition(product, override),
      tags: buildTags(product, override),
      location: { countryCode: defaults.countryCode, ...(defaults.region ? { region: defaults.region } : {}) },
      variants,
      sale: { format: "fixed_price", unitPrice: base, acceptsOffers: Boolean(override.acceptsOffers ?? defaults.acceptsOffers) },
      fulfillmentMethods: ["physical"],
      package: packageOf(product.variations[0] ?? product, product),
      shippingOptions: [
        shipping.pricing === "free" || shippingCost === 0
          ? { id: "seller_flat_rate", pricing: "free", label: shipping.label, estimatedMinDays: shipping.minDays, estimatedMaxDays: shipping.maxDays }
          : { id: "seller_flat_rate", pricing: "flat", label: shipping.label, price: shippingMoney(shippingCost), estimatedMinDays: shipping.minDays, estimatedMaxDays: shipping.maxDays },
      ],
      returnPolicy: returns,
      adultOnly: false,
    },
    media,
  };
  const body = entry.draft.description.replace(config.description?.footer?.split("{url}")[0] ?? "\u0000", "").trim();
  if (body.length < 80) entry.warnings.push("description is (nearly) empty — check the source text or add an override");
  if (include) {
    const errors = validateListing(materialize(entry, DUMMY_OWNER));
    if (errors.length) {
      entry.include = false;
      entry.errors = errors;
    }
  }
  listings.push(entry);
}

const plan = {
  builtAt: new Date().toISOString(),
  storeUrl,
  rate: { from: sourceCurrency, to: pricing.currency, rate, source: rateSource },
  asset,
  listings,
};
writeJson(path.join(workDir, "plan.json"), plan);

// ---------------------------------------------------------------- preview
const rows = listings.map((l) => {
  const d = l.draft;
  const qty = d.variants.reduce((s, v) => s + v.quantity, 0);
  const ship = d.shippingOptions[0];
  const status = l.errors ? "❌ invalid" : l.include ? "✅ ready" : "⏭ skip";
  return `| ${status} | ${l.productId} | ${d.title.replaceAll("|", "/")} | ${d.categoryId} | ${l.source.price} ${l.source.currency} → **${formatMoney(d.sale.unitPrice)}** | ${qty}${d.variants.length > 1 ? ` (${d.variants.length} var.)` : ""} | ${l.media.length} | ${ship.pricing === "free" ? "free" : formatMoney(ship.price)} | ${[...(l.errors ?? []), ...l.warnings].join("; ").replaceAll("|", "/")} |`;
});
const preview = [
  `# Pubky import preview — ${plan.builtAt}`,
  "",
  `Rate: ${rateSource}${pricing.markupPercent ? `, markup ${pricing.markupPercent}%` : ""}. Nothing has been published yet.`,
  "",
  "| Status | Woo ID | Title | Category | Price | Qty | Photos | Shipping | Notes |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows,
  "",
].join("\n");
writeFileSync(path.join(workDir, "preview.md"), preview);
console.log(preview);
const ready = listings.filter((l) => l.include).length;
console.log(`${ready} listing(s) ready, ${listings.length - ready} skipped/invalid. Plan: ${path.join(workDir, "plan.json")}`);
