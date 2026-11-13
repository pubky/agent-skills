#!/usr/bin/env node
// Read-only check of every published listing: homeserver record, Nexus index
// (catalog visibility) and marketplace-service availability (checkout).
//
//   node status.mjs --config pubky-import/config.json
import { existsSync } from "node:fs";
import path from "node:path";
import {
  DELIVERY_KEY_PATH, LISTINGS_PREFIX, NEXUS_ORIGIN, SERVICE_ORIGIN, die, fetchWithRetry, loadConfig,
  parseArgs, readJson,
} from "./lib/common.mjs";
import { publicExists, publicGetJson } from "./lib/pubky.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const { workDir } = loadConfig(flags);
const logFile = path.join(workDir, "published.json");
if (!existsSync(logFile)) die("Nothing published yet (published.json missing).");
const { owner, listings } = readJson(logFile);

const shop = await fetchWithRetry(`${NEXUS_ORIGIN}/v0/shop/${owner}?limit=1`).catch(() => null);
console.log(`Seller ${owner}`);
console.log(`  shop profile indexed: ${shop?.ok ? "yes" : "no"}`);
console.log(`  delivery key:         ${(await publicExists(owner, DELIVERY_KEY_PATH).catch(() => false)) ? "yes" : "MISSING"}`);
console.log("");
console.log("homeserver  index  checkout     title");

for (const [listingId, entry] of Object.entries(listings)) {
  const record = await publicGetJson(owner, `${LISTINGS_PREFIX}${listingId}`).catch(() => undefined);
  const indexed = await fetchWithRetry(`${NEXUS_ORIGIN}/v0/listing/${owner}/${listingId}`).catch(() => null);
  let indexState = "no";
  if (indexed?.ok) {
    const body = await indexed.json();
    indexState = body.revision === record?.revision ? "yes" : `rev ${body.revision}`;
  }
  const availability = await fetchWithRetry(`${SERVICE_ORIGIN}/v0/listings/${owner}/${listingId}/availability`).catch(() => null);
  const checkout = availability?.ok ? (await availability.json()).state : availability?.status === 404 ? "unregistered" : "unknown";
  const hs = record ? `rev ${record.revision} ${record.state}` : "MISSING";
  console.log(`${hs.padEnd(11)} ${indexState.padEnd(6)} ${String(checkout).padEnd(12)} ${entry.title.slice(0, 50)}`);
  console.log(`${"".padEnd(31)}${entry.shopUrl}`);
}
