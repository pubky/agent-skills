#!/usr/bin/env node
// Step 3 — write photos and listing records to the seller's homeserver.
// DRY RUN unless --confirm is given. Publishing is public: confirm with the user first.
//
//   node publish.mjs --config pubky-import/config.json [--ids 3698,5935] [--confirm]
//                    [--state active|paused|removed] [--pubky <z32>]
//
// Idempotent: unchanged listings are skipped, changed ones get revision+1,
// photos already on the homeserver are not re-uploaded.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DELIVERY_KEY_PATH, LISTINGS_PREFIX, MEDIA_PREFIX, NEXUS_ORIGIN, SHOP_ORIGIN, die, fetchWithRetry,
  formatMoney, loadConfig, parseArgs, readJson, sleep, withRetry, writeJson,
} from "./lib/common.mjs";
import { loadCategories, validateListing } from "./lib/listing-schema.mjs";
import { publicExists, publicGetJson, restoreSession } from "./lib/pubky.mjs";
import { contentKey, materialize } from "./lib/record.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const { workDir } = loadConfig(flags);
const planFile = path.join(workDir, "plan.json");
if (!existsSync(planFile)) die(`Run build.mjs first (${planFile} missing)`);
const plan = readJson(planFile);
const onlyIds = flags.ids ? new Set(String(flags.ids).split(",").map((s) => Number(s.trim()))) : null;
const confirm = Boolean(flags.confirm);
const forcedState = flags.state;
if (forcedState && !["active", "paused", "removed"].includes(forcedState)) die("--state must be active, paused or removed");

await loadCategories(workDir);
let { session, pubky: owner } = await restoreSession(flags.pubky);

/**
 * Homeserver call with one re-authentication: another process restoring the same stored
 * session gets a fresh token, which can invalidate this one (401 "No authenticated session").
 */
async function hs(label, fn) {
  try {
    return await withRetry(label, () => fn(session));
  } catch (error) {
    if (!/401|No authenticated session/i.test(String(error?.message ?? error))) throw error;
    ({ session } = await restoreSession(owner));
    return await withRetry(label, () => fn(session));
  }
}
console.log(`Seller: ${owner}${confirm ? "" : "   (DRY RUN — add --confirm to publish)"}`);

// ---------------------------------------------------------------- preflight
const hasDeliveryKey = await publicExists(owner, DELIVERY_KEY_PATH).catch(() => false);
const shopResponse = await fetchWithRetry(`${NEXUS_ORIGIN}/v0/shop/${owner}?limit=1`).catch(() => null);
const hasShop = shopResponse?.ok === true;
console.log(`Shop profile indexed: ${hasShop ? "yes" : "NO — create it under My shop in shop.pubky.app"}`);
console.log(`Delivery key published: ${hasDeliveryKey ? "yes" : "NO — buyers cannot check out shipped items until you create it (Shipping settings)"}`);

// ---------------------------------------------------------------- publish
const logFile = path.join(workDir, "published.json");
const log = existsSync(logFile) ? readJson(logFile) : { owner, listings: {} };
const selected = plan.listings.filter((l) => l.include && (!onlyIds || onlyIds.has(l.productId)));
if (selected.length === 0) die("Nothing to publish (check --ids and plan.json include flags).");

const results = [];
for (const entry of selected) {
  const recordPath = `${LISTINGS_PREFIX}${entry.listingId}`;
  const existing = await hs("read existing", async (s) =>
    (await s.storage.exists(recordPath)) ? await s.storage.getJson(recordPath) : undefined,
  );
  const state = forcedState ?? existing?.state ?? "active";
  let record = materialize(entry, owner, { state });
  let action = "create";
  if (existing) {
    if (contentKey({ ...existing }) === contentKey(record)) {
      results.push({ entry, action: "unchanged", record: existing });
      if (confirm) recordInLog(entry, existing);
      continue;
    }
    action = "update";
    record = materialize(entry, owner, {
      state,
      revision: (existing.revision ?? 0) + 1,
      createdAt: existing.createdAt,
    });
  }
  const errors = validateListing(record);
  if (errors.length) {
    results.push({ entry, action: "invalid", errors });
    continue;
  }
  if (!confirm) {
    results.push({ entry, action: `would ${action}`, record });
    continue;
  }

  let uploaded = 0;
  for (const media of entry.media) {
    const mediaPath = `${MEDIA_PREFIX}${media.id}`;
    if (await hs("media exists", (s) => s.storage.exists(mediaPath))) continue;
    const bytes = new Uint8Array(readFileSync(path.join(workDir, media.file)));
    await hs(`upload ${media.file}`, (s) => s.storage.putBytes(mediaPath, bytes));
    uploaded += 1;
  }
  await hs(`write listing ${entry.listingId}`, (s) => s.storage.putJson(recordPath, record));

  let servedRevision;
  for (let attempt = 0; attempt < 6 && servedRevision !== record.revision; attempt += 1) {
    await sleep(attempt === 0 ? 300 : 1500);
    servedRevision = (await publicGetJson(owner, recordPath).catch(() => undefined))?.revision;
  }
  results.push({ entry, action, record, uploaded, verified: servedRevision === record.revision });
  recordInLog(entry, record);
}

/** Saved after every listing, so an interrupted run still leaves an accurate log. */
function recordInLog(entry, record) {
  log.owner = owner;
  log.listings[entry.listingId] = {
    productId: entry.productId,
    title: record.title,
    revision: record.revision,
    state: record.state,
    publishedAt: record.updatedAt,
    shopUrl: `${SHOP_ORIGIN}/marketplace/listing/${owner}/${entry.listingId}`,
  };
  writeJson(logFile, log);
}

// ---------------------------------------------------------------- report
for (const r of results) {
  const d = r.entry.draft;
  const head = `${r.action.padEnd(14)} ${String(r.entry.productId).padEnd(6)} ${d.title.slice(0, 50).padEnd(50)} ${formatMoney(d.sale.unitPrice)}`;
  console.log(head);
  if (r.errors) for (const e of r.errors) console.log(`               ✖ ${e}`);
  if (r.uploaded !== undefined) {
    console.log(`               photos uploaded: ${r.uploaded}/${r.entry.media.length}, served back: ${r.verified ? "yes" : "not yet (homeserver lag; re-check with status.mjs)"}`);
    console.log(`               ${SHOP_ORIGIN}/marketplace/listing/${owner}/${r.entry.listingId}`);
  }
}
if (!confirm && flags.show) {
  for (const r of results.filter((x) => x.record)) console.log(JSON.stringify(r.record, null, 2));
}
const failed = results.filter((r) => r.action === "invalid").length;
if (confirm) {
  console.log(`\nNext: node register.mjs (makes the listings purchasable), then node status.mjs.`);
}
process.exit(failed ? 1 : 0);
