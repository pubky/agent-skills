#!/usr/bin/env node
// Sign in as the seller: shows a pubkyauth QR code, waits for approval in
// Pubky Ring, stores the grant session in the pubky-shop CLI keychain store.
//
//   node login.mjs [--qr-png <file>]      (default PNG: ./pubky-login-qr.png)
//   node login.mjs --status               show the stored session
//   node login.mjs --logout [--pubky z32] remove the stored session
import path from "node:path";
import QRCode from "qrcode";
import { MARKETPLACE_CAPABILITY, parseArgs } from "./lib/common.mjs";
import { forgetSession, restoreSession, startSignIn, storeSession } from "./lib/pubky.mjs";

const { flags } = parseArgs(process.argv.slice(2));

if (flags.status) {
  try {
    const { session, pubky } = await restoreSession(flags.pubky);
    console.log(JSON.stringify({ ok: true, pubky, capabilities: [...session.info.capabilities] }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error.message ?? error) }, null, 2));
    process.exitCode = 2;
  }
  process.exit();
}

if (flags.logout) {
  const { pubky } = flags.pubky ? { pubky: flags.pubky } : await restoreSession();
  await forgetSession(pubky);
  console.log(`Removed the stored session for ${pubky}. Revoke the grant itself in Pubky Ring if needed.`);
  process.exit();
}

const flow = await startSignIn();
const url = flow.authorizationUrl;
const png = path.resolve(flags["qr-png"] ?? "pubky-login-qr.png");
await QRCode.toFile(png, url, { width: 480, margin: 2 });
console.log(await QRCode.toString(url, { type: "terminal", small: true }));
console.log(`Scan with Pubky Ring (or open on the phone): ${url}`);
console.log(`QR image: ${png}`);
console.log(`Requested access: ${MARKETPLACE_CAPABILITY} (listings and photos only)`);
console.log("Waiting for approval (the request expires after about 5 minutes)…");

const timeout = setTimeout(() => {
  console.error("No approval within 5 minutes; run login.mjs again.");
  process.exit(3);
}, 5 * 60_000 + 10_000);

const session = await flow.awaitApproval();
clearTimeout(timeout);
const stored = await storeSession(session);
console.log(JSON.stringify({ ok: true, pubky: stored.pubky, capabilities: stored.capabilities }, null, 2));
process.exit();
