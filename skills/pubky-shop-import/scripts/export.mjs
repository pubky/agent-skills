#!/usr/bin/env node
// Step 1 — read products from the WooCommerce Store API (public, read-only,
// no credentials) into <workDir>/products.json.
//
//   node export.mjs --config pubky-import/config.json [--ids 3698,5935] [--all]
//                   [--ssh] [--ssh-stock] [--ssh-shipping] [--translations en]
//
// --ids           only these WooCommerce product ids (default: config.selection.productIds, else all)
// --ssh-stock     exact stock (_stock) via `ssh <source.ssh.host> wp eval-file`; the Store API
//                 only reveals stock when it is low
// --ssh-shipping  what WooCommerce charges to ship ONE unit to source.shipping.country
//                 (cheapest paid rate; free-shipping coupons and pickup ignored)
// --ssh           both of the above
// --translations  also read the translated product page (TranslatePress-style /<lang>/ URL):
//                 title, short and long description (default: config.source.translation.lang)
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  decodeEntities, die, extractElementByClass, fetchJson, fetchWithRetry, htmlToText, loadConfig, looksEnglish,
  parseArgs, writeJson,
} from "./lib/common.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const { config, workDir } = loadConfig(flags);
const storeUrl = config.source?.storeUrl?.replace(/\/$/, "");
if (!storeUrl) die("config.source.storeUrl is required (e.g. https://shop.example.com)");
const api = `${storeUrl}/wp-json/wc/store/v1`;

const wantedIds = flags.all
  ? null
  : String(flags.ids ?? (config.selection?.productIds ?? []).join(","))
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter(Number.isFinite);

async function allProducts() {
  const products = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchWithRetry(`${api}/products?per_page=100&page=${page}`);
    if (!response.ok) die(`Store API ${response.status} at ${api}/products`);
    const batch = await response.json();
    products.push(...batch);
    const totalPages = Number(response.headers.get("x-wp-totalpages") ?? 1);
    if (page >= totalPages || batch.length === 0) return products;
  }
}

const raw = wantedIds?.length
  ? await Promise.all(wantedIds.map((id) => fetchJson(`${api}/products/${id}`)))
  : await allProducts();

function priceMajor(prices) {
  return Number(prices.price) / 10 ** prices.currency_minor_unit;
}

function termNames(product) {
  const map = {};
  for (const attribute of product.attributes ?? []) {
    for (const term of attribute.terms ?? []) map[`${attribute.name}|${term.slug}`] = term.name;
  }
  return map;
}

const products = [];
for (const p of raw) {
  const names = termNames(p);
  const variations = [];
  for (const v of p.variations ?? []) {
    const detail = await fetchJson(`${api}/products/${v.id}`);
    variations.push({
      id: v.id,
      sku: detail.sku || null,
      options: Object.fromEntries(
        v.attributes.map((a) => [a.name, decodeEntities(names[`${a.name}|${a.value}`] ?? a.value)]),
      ),
      price: priceMajor(detail.prices),
      inStock: detail.is_in_stock,
      lowStockRemaining: detail.low_stock_remaining ?? null,
      stock: null,
      weight: detail.weight || null,
      dimensions: detail.dimensions ?? null,
      images: (detail.images ?? []).map((i) => ({ src: i.src, alt: decodeEntities(i.alt || "") })),
    });
  }
  products.push({
    id: p.id,
    slug: p.slug,
    permalink: p.permalink,
    type: p.type,
    name: decodeEntities(p.name),
    sku: p.sku || null,
    shortDescriptionHtml: p.short_description ?? "",
    descriptionHtml: p.description ?? "",
    price: priceMajor(p.prices),
    currency: p.prices.currency_code,
    inStock: p.is_in_stock,
    purchasable: p.is_purchasable,
    lowStockRemaining: p.low_stock_remaining ?? null,
    stock: null,
    weight: p.weight || null,
    dimensions: p.dimensions ?? null,
    images: (p.images ?? []).map((i) => ({ src: i.src, alt: decodeEntities(i.alt || "") })),
    categories: (p.categories ?? []).map((c) => c.slug),
    tags: (p.tags ?? []).map((t) => decodeEntities(t.name)),
    brands: (p.brands ?? []).map((b) => decodeEntities(b.name)),
    attributes: Object.fromEntries(
      (p.attributes ?? [])
        .filter((a) => !a.has_variations)
        .map((a) => [a.taxonomy || a.name, (a.terms ?? []).map((t) => decodeEntities(t.name))]),
    ),
    variations,
  });
}

// ---------------------------------------------------------------- translated pages
const translationLang = flags.translations ?? config.source?.translation?.lang;
if (translationLang && translationLang !== true) {
  for (const product of products) {
    const url = new URL(product.permalink);
    url.pathname = `/${translationLang}${url.pathname}`;
    const response = await fetchWithRetry(url.href, { headers: { accept: "text/html" } }).catch(() => null);
    if (!response?.ok) continue;
    const html = await response.text();
    const title = html.match(/<h1[^>]*class="[^"]*product_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)?.[1];
    const short = extractElementByClass(html, "woocommerce-product-details__short-description");
    const long =
      extractElementByClass(html, "elementor-widget-woocommerce-product-content") ??
      extractElementByClass(html, "woocommerce-Tabs-panel--description");
    const english = (fragment) => (fragment ? looksEnglish(htmlToText(fragment)) : false);
    product.translations = {
      ...product.translations,
      [translationLang]: {
        url: url.href,
        title: title ? decodeEntities(title.replace(/<[^>]+>/g, "")).trim() : null,
        shortDescriptionHtml: short ?? "",
        descriptionHtml: long ?? "",
        translated: translationLang === "en" ? { short: english(short), long: english(long) } : null,
      },
    };
  }
}

function sshEval(php) {
  const host = config.source?.ssh?.host;
  const wpPath = config.source?.ssh?.wpPath;
  if (!host || !wpPath) die("SSH options need config.source.ssh.host and .wpPath");
  const stdout = execFileSync("ssh", [host, `wp --path=${wpPath} eval-file - 2>/dev/null`], { input: php });
  return JSON.parse(stdout.toString().trim().split("\n").pop());
}

if (flags["ssh-stock"] || flags.ssh) {
  const ids = products.flatMap((p) => [p.id, ...p.variations.map((v) => v.id)]);
  const stock = sshEval(`<?php
$out = [];
foreach (${JSON.stringify(ids)} as $id) {
  $p = wc_get_product($id);
  if (!$p) continue;
  $out[$id] = ['manage' => $p->get_manage_stock(), 'qty' => $p->get_stock_quantity(), 'status' => $p->get_stock_status()];
}
echo json_encode($out);`);
  for (const item of products.flatMap((p) => [p, ...p.variations])) {
    const s = stock[item.id];
    if (s && s.manage && typeof s.qty === "number") item.stock = s.qty;
  }
}

if (flags["ssh-shipping"] || flags.ssh) {
  const dest = { country: "CH", postcode: "", city: "", ...config.source?.shipping };
  const ids = products.map((p) => p.variations[0]?.id ?? p.id);
  // Read-only: builds an in-memory one-item package and asks WooCommerce for its rates.
  const rates = sshEval(`<?php
WC()->frontend_includes();
if (null === WC()->session) { $c = apply_filters('woocommerce_session_handler', 'WC_Session_Handler'); WC()->session = new $c(); WC()->session->init(); }
if (null === WC()->customer) { WC()->customer = new WC_Customer(0, true); }
if (null === WC()->cart) { WC()->cart = new WC_Cart(); }
$out = [];
foreach (${JSON.stringify(ids)} as $id) {
  $p = wc_get_product($id);
  if (!$p) continue;
  $price = (float) $p->get_price();
  $package = [
    'contents' => ['x' => ['key' => 'x', 'product_id' => $p->get_parent_id() ?: $p->get_id(), 'variation_id' => $p->get_parent_id() ? $p->get_id() : 0, 'quantity' => 1, 'data' => $p, 'line_total' => $price, 'line_tax' => 0, 'line_subtotal' => $price, 'line_subtotal_tax' => 0]],
    'contents_cost' => $price, 'applied_coupons' => [], 'user' => ['ID' => 0],
    'destination' => ['country' => ${JSON.stringify(dest.country)}, 'state' => '', 'postcode' => ${JSON.stringify(String(dest.postcode))}, 'city' => ${JSON.stringify(dest.city)}, 'address' => '', 'address_1' => '', 'address_2' => ''],
    'cart_subtotal' => $price,
  ];
  WC()->shipping()->reset_shipping();
  $calc = WC()->shipping()->calculate_shipping_for_package($package, 'pubky' . $id);
  $best = null;
  foreach ($calc['rates'] as $r) {
    if (in_array($r->get_method_id(), ['free_shipping', 'local_pickup', 'pickup_location'], true)) continue;
    $cost = (float) $r->get_cost();
    if ($best === null || $cost < $best['cost']) $best = ['cost' => $cost, 'label' => wp_strip_all_tags($r->get_label())];
  }
  $out[$id] = $best;
}
echo json_encode($out);`);
  for (const product of products) {
    const rate = rates[product.variations[0]?.id ?? product.id];
    product.shipping = rate ? { country: dest.country, cost: rate.cost, method: decodeEntities(rate.label) } : null;
  }
}

const out = path.join(workDir, "products.json");
writeJson(out, { exportedAt: new Date().toISOString(), storeUrl, products });
console.log(`Exported ${products.length} product(s) → ${out}`);
for (const p of products) {
  const stock = p.stock ?? p.lowStockRemaining ?? (p.inStock ? "in stock" : "OUT");
  const ship = p.shipping ? `  ship ${p.shipping.cost} ${p.currency}` : "";
  const tr = Object.entries(p.translations ?? {})
    .map(([lang, t]) => ` ${lang}:${t.translated ? `${t.translated.short ? "S" : "-"}${t.translated.long ? "L" : "-"}` : "?"}`)
    .join("");
  console.log(`  ${p.id}  ${p.name.slice(0, 50)}  ${p.price} ${p.currency}  [${stock}]${ship}  ${p.images.length} img${tr}  ${p.variations.length ? `${p.variations.length} variants` : ""}`);
}
