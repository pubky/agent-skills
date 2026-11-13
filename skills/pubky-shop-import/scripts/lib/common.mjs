// Shared helpers for the pubky-shop-import scripts (WooCommerce → Pubky Shop).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const USER_AGENT = "pubky-shop-import/0.1 (+https://github.com/pubky/agent-skills)";

// Production endpoints, as shipped by shop.pubky.app and the pubky-shop CLI (2026-10).
// The Nexus host is the one shop.pubky.app/llms.txt names; it may move.
export const SHOP_ORIGIN = "https://shop.pubky.app";
export const SERVICE_ORIGIN = "https://marketplace-service-production-ce23.up.railway.app";
export const NEXUS_ORIGIN = "https://nexusd-production-7108.up.railway.app";
export const MARKETPLACE_CAPABILITY = "/pub/pubky.app/marketplace/:rw";
export const CLIENT_ID = "pubky-shop-import";

export const LISTINGS_PREFIX = "/pub/pubky.app/marketplace/v1/listings/";
export const MEDIA_PREFIX = "/pub/pubky.app/marketplace/v1/media/";
export const DELIVERY_KEY_PATH = "/pub/pubky.app/marketplace/v1/delivery-keys/current";

// ---------------------------------------------------------------- args/config

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

export function loadConfig(flags) {
  const file = path.resolve(flags.config ?? "pubky-import/config.json");
  if (!existsSync(file)) {
    die(`Config not found: ${file}\nCopy ${path.join(SKILL_DIR, "scripts", "config.example.json")} there and edit it.`);
  }
  const config = JSON.parse(readFileSync(file, "utf8"));
  const workDir = path.resolve(path.dirname(file), config.workDir ?? ".");
  mkdirSync(workDir, { recursive: true });
  return { config, configFile: file, workDir };
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function die(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- http

export async function fetchJson(url, init = {}) {
  const response = await fetchWithRetry(url, init);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url} → HTTP ${response.status}`);
  return await response.json();
}

export async function fetchWithRetry(url, init = {}, attempts = 4) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
      });
      if (response.status === 429 || response.status >= 500) {
        last = new Error(`HTTP ${response.status} from ${url}`);
      } else {
        return response;
      }
    } catch (error) {
      last = error;
    }
    await sleep(500 * 2 ** attempt);
  }
  throw last;
}

/** Retries a homeserver call on rate limits / transient failures. */
export async function withRetry(label, fn, attempts = 5) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const text = String(error?.message ?? error);
      const transient = /429|too many|timeout|timed out|503|502|network|fetch failed/i.test(text);
      if (!transient || attempt === attempts) break;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${label}: ${last?.name ?? "Error"}: ${last?.message ?? last}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- text

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bdquo: "„", euro: "€", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", middot: "·",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é",
  egrave: "è", agrave: "à", ecirc: "ê", ccedil: "ç", bull: "•", shy: "",
};

export function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name] ?? match);
}

/** WooCommerce HTML → readable plain text (Pubky descriptions are plain text). */
export function htmlToText(html) {
  if (!html) return "";
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|section|blockquote)>/gi, "\n\n")
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "  ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/•\s*\n+\s*/g, "• ")
    .replace(/(• [^\n]*)\n{2,}(?=• )/g, "$1\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return `${(lastBreak > max * 0.8 ? cut.slice(0, lastBreak + 1) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------- ids & hashes

/** 32 lowercase hex chars, stable for the same input (listing ids look like the Shop's own). */
export function stableId(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function blake3Hex(bytes) {
  return bytesToHex(blake3(bytes));
}

// ---------------------------------------------------------------- images

const MIME_BY_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
];

export function sniffImageMime(bytes) {
  for (const [magic, mime] of MIME_BY_MAGIC) {
    if (magic.every((byte, index) => bytes[index] === byte)) return mime;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Pixel dimensions from PNG / JPEG / GIF / WebP headers. */
export function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mime = sniffImageMime(bytes);
  if (mime === "image/png") return { width: view.getUint32(16), height: view.getUint32(20) };
  if (mime === "image/gif") return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  if (mime === "image/webp") {
    const chunk = ascii(bytes, 12, 16);
    if (chunk === "VP8 ") {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L") {
      const b = bytes;
      return {
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    }
    if (chunk === "VP8X") {
      return {
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
  }
  throw new Error("unsupported or unreadable image format");
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Shrinks an image in place with macOS `sips` when it is larger than the limits
 * (keeps the format, so transparent PNGs stay transparent). No-op elsewhere.
 */
export function shrinkIfNeeded(file, { maxEdge, maxBytes }) {
  let bytes = new Uint8Array(readFileSync(file));
  const { width, height } = imageSize(bytes);
  if (Math.max(width, height) <= maxEdge && bytes.length <= maxBytes) return bytes;
  try {
    execFileSync("sips", ["-Z", String(maxEdge), file], { stdio: "ignore" });
    bytes = new Uint8Array(readFileSync(file));
  } catch {
    // sips unavailable: upload the original; the homeserver allows ~10 MB per request.
  }
  return bytes;
}

// ---------------------------------------------------------------- money

/** CHF→target rate. USD via ECB (frankfurter.app); BTC via mempool.space. */
export async function fetchRate(from, to) {
  if (to === "BTC") {
    const prices = await fetchJson("https://mempool.space/api/v1/prices");
    const btcInFrom = prices[from];
    if (!btcInFrom) throw new Error(`mempool.space has no BTC/${from} price`);
    return { rate: 1 / btcInFrom, source: `mempool.space BTC/${from} = ${btcInFrom}` };
  }
  const data = await fetchJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
  const rate = data.rates?.[to];
  if (!rate) throw new Error(`frankfurter.app has no ${from}/${to} rate`);
  return { rate, source: `ECB via frankfurter.app ${data.date}: 1 ${from} = ${rate} ${to}` };
}

export const ASSETS = {
  USD: { currency: "USD", exponent: 2 },
  BTC: { currency: "BTC", exponent: 8 },
};

/** Converts a source-currency amount (major units) into listing money. */
export function convertMoney(amountMajor, pricing, rate) {
  const asset = ASSETS[pricing.currency];
  if (!asset) die(`pricing.currency must be USD or BTC (Pubky Shop supports no others), got ${pricing.currency}`);
  const markup = 1 + (pricing.markupPercent ?? 0) / 100;
  const converted = amountMajor * rate * markup;
  let amountMinor;
  if (asset.currency === "BTC") {
    const sats = converted * 1e8;
    const step = pricing.roundSatsTo ?? 100;
    amountMinor = Math.max(step, Math.round(sats / step) * step);
  } else if (pricing.rounding === "whole") {
    amountMinor = Math.max(100, Math.round(converted) * 100);
  } else if (pricing.rounding === "x.99") {
    amountMinor = Math.max(99, Math.ceil(converted) * 100 - 1);
  } else {
    amountMinor = Math.max(1, Math.round(converted * 100));
  }
  return { amountMinor, ...asset };
}

export function formatMoney({ amountMinor, currency, exponent }) {
  if (currency === "BTC") return `${amountMinor.toLocaleString("en-US")} sats`;
  return `${(amountMinor / 10 ** exponent).toFixed(exponent)} ${currency}`;
}

// ---------------------------------------------------------------- html scraping

/** Inner HTML of the first element whose class list contains `className` (balanced tags). */
export function extractElementByClass(html, className) {
  const open = new RegExp(`<(div|section|article)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  const start = open.index + open[0].length;
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, "g");
  re.lastIndex = start;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return null;
}

const EN_WORDS = new Set(["the", "and", "with", "for", "your", "this", "is", "of", "to", "you", "are", "it", "on", "in"]);
const DE_WORDS = new Set(["der", "die", "das", "und", "mit", "für", "ist", "ein", "eine", "nicht", "sich", "auf", "dein", "deine", "sie", "zu", "den", "im"]);

/** Crude English-vs-German check, enough to spot untranslated TranslatePress pages. */
export function looksEnglish(text) {
  let en = 0;
  let de = 0;
  for (const word of text.toLowerCase().split(/[^a-zäöüß]+/)) {
    if (EN_WORDS.has(word)) en += 1;
    if (DE_WORDS.has(word)) de += 1;
  }
  return en > 0 && en >= de * 2;
}
