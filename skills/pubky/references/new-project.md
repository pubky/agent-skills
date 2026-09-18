# Starting a new Pubky app

For a repo with no Pubky code yet: do steps 1–5 in order before writing app code; steps 6–7 shape what you ship. This page only sequences and links. If a linked file disagrees with this one, the linked file wins.

## 1. Ask before you build

Ask everything in one message (use a question tool if you have one); do not scaffold until answered or defaulted.

| Ask | Options | Default if unanswered or you cannot ask |
| :-- | :-- | :-- |
| Which network while we build? | (a) local testnet — your machine, throwaway identities, no phone; (b) mainnet + production homeserver; (c) mainnet + staging homeserver | (a) |
| What is it for? | (a) trying Pubky, a prototype; (b) an app you will ship; (c) pubky.app social data | (a) |
| Which stack? | web/JS · Rust service or CLI · native mobile | web/JS (ask only if the request and the repo leave it open) |

For (c): read [`./app-specs.md`](./app-specs.md) and [`./nexus-api.md`](./nexus-api.md); writes go under `/pub/pubky.app/`. Otherwise your app owns `/pub/<client-id>/`. For (b): build on a testnet first, read [`./shipped-vs-planned.md`](./shipped-vs-planned.md), plan your own [relay](./auth.md#relays).

**Say the outcome in your first reply even when you defaulted** — "Building against a LOCAL TESTNET; say so if you want mainnet." Record it in the README and `.env`. Never select mainnet silently.

## 2. Networks at a glance

| Network | SDK facade | How the user gets an account | You must run |
| :-- | :-- | :-- | :-- |
| Local testnet | `Pubky.testnet(host?)` | dev-only new-identity button, or the Ring Simulator (step 5) | a local testnet |
| Mainnet + production homeserver | `new Pubky()` | in Pubky Ring or pubky.app onboarding, outside your app; signup is [token-gated](./auth.md#signup-tokens) | nothing |
| Mainnet + staging homeserver | `new Pubky()` | an operator-issued token; no self-serve path is documented — ask whether the user has one | nothing |

Staging is **not** a separate network: mainnet DHT, a token-gated homeserver, a staging [Nexus](./nexus-api.md) URL. Identities are published per network — a testnet key does not resolve on mainnet, or the reverse. Facade: [`./sdk-js.md#the-facade`](./sdk-js.md#the-facade).

## 3. Check the SDK version first

```bash
npm view @synonymdev/pubky version
npm view @synonymdev/pubky dist-tags   # install `latest` only — never `alpha` or `next`
cargo search pubky --limit 1
```

Install what the registry reports (`npm install @synonymdev/pubky@latest`, `cargo add pubky`), never a version from memory or an old example. Compare it with the Version note atop [`./sdk-js.md`](./sdk-js.md) / [`./sdk-rust.md`](./sdk-rust.md). Equal: proceed. Newer: install the newest anyway, treat signatures here as possibly stale, trust the installed `.d.ts` or docs.rs, skim the `pubky-homeserver` release notes, and tell the user the references trail the SDK. Unreachable: use the documented version and say so.

**Floor:** grant auth needs 0.10.0 or newer. `startCookieAuthFlow`, `signinCookie`, a no-argument `signin()`, or using `signup()`'s return value as a session mark pre-0.10 code — stop and read [version drift](./reference-apps.md#version-drift-check-before-copying-any-call).

## 4. Pick the stack and scaffold

| Building | Do | Then read |
| :-- | :-- | :-- |
| Web/JS app | `npx tiged pubky/pubky-app-templates/basic-pubky-app my-app`, then change `APP_CLIENT_ID` in `src/config.ts` first | [basic-pubky-app](./reference-apps.md#basic-pubky-app), [`./sdk-js.md`](./sdk-js.md) |
| Rust service or CLI | `cargo add pubky` — no template exists | [`./sdk-rust.md`](./sdk-rust.md), [pick the right path](./auth.md#pick-the-right-path) |
| Native iOS, Android or React Native | stop; use the **`pubky-mobile`** skill | — |

On another web framework, port the template's `config.ts` and `pubky.ts` rather than hand-writing auth. After scaffolding, compare its SDK pin with step 3 and bump it if older. Testnet is the template default; only the exact string `VITE_PUBKY_TESTNET=false` selects mainnet ([relay config](./reference-apps.md#relay-config)).

## 5. Get the network running and the user an account

**Local testnet.** Start one per [standalone local testnet](./testing-and-testnet.md#standalone-local-testnet); it needs a Rust toolchain, a `pubky-homeserver` checkout and [PostgreSQL](./testing-and-testnet.md#postgresql-is-required). Check `cargo --version`, `pg_isready` and `docker --version` before promising any of it. Never install a toolchain or switch network silently: name what is missing, then offer to install it or to use mainnet with an existing account. Heavier Docker alternative: [the full local stack](../../pubky-infra/references/local-stack.md#quick-start-public-images).

Then an account: the dev-only **New identity** button (only under `vite dev`, on testnet, against an open-signup homeserver → [dev-only identity shortcut](./reference-apps.md#dev-only-identity-shortcut)), or the [Ring Simulator](https://simulator.pubkyring.app) — Copy link, paste into *Auth link*, approve in **Shortcut** mode.

**Mainnet.** Your app never creates accounts; the user signs in with an identity they already hold in Pubky Ring. Say that in the UI and in your reply.

## 6. Newcomer-ready defaults

Defaults and app choices, not protocol rules. Keep them unless the user says otherwise.

**The template already ships these — keep them.**

1. QR code *and* clickable authorize link *and* **Copy link** — a QR alone is unusable on a laptop and in the simulator.
2. The dev-only **New identity** button, gated on a dev build and testnet. Never ship it: it holds a raw keypair in the browser.
3. Path and [capabilities](./auth.md#capabilities) derived from one client ID.
4. A closed-signup failure turned into a friendly message.

**The template lacks these — add them.**

5. Show the active network in the UI ("Local testnet" / "Mainnet").
6. Tell the user, on the sign-in screen, how to get an account on this network (step 5).
7. Translate a `PkarrError` at sign-in into a network hint: branch on `error.name`, see [error handling](./sdk-js.md#error-handling).

## 7. Sign-in fails: check the network first

| Symptom | Likely cause | Do |
| :-- | :-- | :-- |
| `PkarrError` after approval or from `getHomeserverOf` | the identity is not published on this build's network | show "No identity found on `<network>`" and the active network, never the raw error |
| Same error for every identity on testnet | the testnet is down or not ready | [JS against the local testnet](./testing-and-testnet.md#js-against-the-local-testnet) |
| Signup 400/401 mentioning a token | token-gated homeserver | [signup tokens](./auth.md#signup-tokens); do not invent a token source |
| No **New identity** button | not `vite dev`, not testnet, or disabled | [dev-only identity shortcut](./reference-apps.md#dev-only-identity-shortcut) |
