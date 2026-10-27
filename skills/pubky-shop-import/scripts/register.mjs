#!/usr/bin/env node
// Step 4 — ask the marketplace service to (re)read the published records so
// the listings become purchasable (POST /v1/listings/sync-many).
//
// Needs the service bearer stored by the official CLI. Once per day:
//   npx pubky-shop auth login            (shows a QR; approve in Pubky Ring)
//   npx pubky-shop auth login --complete
// then:
//   node register.mjs --config pubky-import/config.json [--ids 3698,5935]
import { existsSync } from "node:fs";
import path from "node:path";
import { SERVICE_ORIGIN, die, fetchWithRetry, loadConfig, parseArgs, readJson } from "./lib/common.mjs";
import { loadServiceBearer, restoreSession } from "./lib/pubky.mjs";

const { flags } = parseArgs(process.argv.slice(2));
const { workDir } = loadConfig(flags);
const logFile = path.join(workDir, "published.json");
if (!existsSync(logFile)) die("Nothing published yet (published.json missing).");
const log = readJson(logFile);
const onlyIds = flags.ids ? new Set(String(flags.ids).split(",").map((s) => Number(s.trim()))) : null;

const owner = flags.pubky ?? log.owner ?? (await restoreSession()).pubky;
const credential = await loadServiceBearer(owner);
if (!credential) {
  die(
    "No valid marketplace-service session. From the skill's scripts directory run:\n" +
      "  npx pubky-shop auth login            # approve the QR in Pubky Ring\n" +
      "  npx pubky-shop auth login --complete\n" +
      "Alternative: open each listing in shop.pubky.app → My shop; the Shop registers it on publish/retry.",
  );
}

const ids = Object.entries(log.listings)
  .filter(([, l]) => !onlyIds || onlyIds.has(l.productId))
  .map(([listingId]) => listingId);
let failures = 0;
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const response = await fetchWithRetry(`${SERVICE_ORIGIN}/v1/listings/sync-many`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ listings: chunk.map((listing_id) => ({ seller_pubky: owner, listing_id })) }),
  });
  if (response.status === 401) die("Service session rejected (expired?). Run `npx pubky-shop auth login` again.");
  if (response.status !== 207) die(`sync-many → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = await response.json();
  for (const result of body.results) {
    const title = log.listings[result.listing_id]?.title ?? result.listing_id;
    const ok = result.status >= 200 && result.status < 300;
    if (!ok) failures += 1;
    const detail = ok ? `revision ${result.result?.revision ?? "?"}` : `${result.result?.error?.code}: ${result.result?.error?.message ?? ""}`;
    console.log(`${ok ? "✔" : "✖"} ${String(result.status).padEnd(4)} ${title.slice(0, 55).padEnd(55)} ${detail}`);
  }
}
process.exit(failures ? 1 : 0);
