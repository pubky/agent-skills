// Homeserver session handling. Sessions are stored exactly where the official
// `pubky-shop` CLI keeps them (macOS keychain service "pubky-shop", account
// "<service origin>|<pubky>|homeserver-session"), so one Pubky Ring approval
// serves both these scripts and `npx pubky-shop auth login`.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AuthFlowKind, Pubky } from "@synonymdev/pubky";
import { CLIENT_ID, MARKETPLACE_CAPABILITY, SERVICE_ORIGIN, SKILL_DIR } from "./common.mjs";

const CLI_DIST = path.join(SKILL_DIR, "scripts", "node_modules", "@bitcoinerrorlog", "pubky-shop", "dist", "cli");

async function cliModule(name) {
  return await import(pathToFileURL(path.join(CLI_DIST, name)).href);
}

async function sessionStore() {
  const { homeserverSessionStoreFor } = await cliModule("credentials.js");
  const { configDir } = await cliModule("config.js");
  return homeserverSessionStoreFor(process.env, configDir(process.env));
}

let sharedPubky;
export function pubkyClient() {
  sharedPubky ??= new Pubky();
  return sharedPubky;
}

/** Starts a grant sign-in; returns the flow so the caller can show the QR. */
export async function startSignIn() {
  return await pubkyClient().startGrantAuthFlow(MARKETPLACE_CAPABILITY, AuthFlowKind.signin(), {
    clientId: CLIENT_ID,
  });
}

export async function storeSession(session) {
  const store = await sessionStore();
  const stored = {
    pubky: session.info.publicKey.z32(),
    capabilities: [...session.info.capabilities],
    secret: await session.exportLocalSecret(),
  };
  await store.put(SERVICE_ORIGIN, stored);
  return stored;
}

/** Restores the stored session; `pubkyHint` picks one when several exist. */
export async function restoreSession(pubkyHint = process.env.PUBKY_SHOP_PUBKY) {
  const store = await sessionStore();
  const { loadStoredHomeserverSession } = await cliModule("credentials.js");
  const env = pubkyHint ? { ...process.env, PUBKY_SHOP_PUBKY: pubkyHint } : process.env;
  const stored = await loadStoredHomeserverSession(store, SERVICE_ORIGIN, env);
  if (!stored) {
    throw new Error("No stored Pubky session. Run `node login.mjs` and approve the QR code in Pubky Ring.");
  }
  const session = await pubkyClient().restoreSession(stored.secret);
  const z32 = session.info.publicKey.z32();
  if (z32 !== stored.pubky) throw new Error("Stored session belongs to a different pubky");
  const caps = [...session.info.capabilities];
  if (!caps.some((cap) => cap === MARKETPLACE_CAPABILITY || cap === "/:rw")) {
    throw new Error(`Session lacks ${MARKETPLACE_CAPABILITY}; run login.mjs again`);
  }
  return { session, pubky: z32 };
}

export async function forgetSession(pubky) {
  const store = await sessionStore();
  await store.delete(SERVICE_ORIGIN, pubky);
}

/** The marketplace-service bearer stored by `npx pubky-shop auth login`, if any. */
export async function loadServiceBearer(pubky) {
  const { credentialStoreFor } = await cliModule("credentials.js");
  const { configDir } = await cliModule("config.js");
  const store = credentialStoreFor(process.env, configDir(process.env));
  const credential = await store.get(SERVICE_ORIGIN, pubky).catch(() => undefined);
  if (!credential) return undefined;
  if (Date.parse(credential.expires_at) <= Date.now() + 60_000) return undefined;
  return credential;
}

/** Public read of a seller's file, no session needed. */
export async function publicGetJson(owner, filePath) {
  try {
    return await pubkyClient().publicStorage.getJson(`pubky${owner}${filePath}`);
  } catch (error) {
    if (/404|not ?found/i.test(String(error?.message ?? error))) return undefined;
    throw error;
  }
}

export async function publicExists(owner, filePath) {
  return await pubkyClient().publicStorage.exists(`pubky${owner}${filePath}`);
}
