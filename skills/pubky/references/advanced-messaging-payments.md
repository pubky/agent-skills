# Advanced: E2E messaging (`pubky-noise`) and payments (`paykit`)

Router, not a full guide: *when* to reach for two **external, experimental** crates layered **on
top of** Pubky Core — `pubky-noise` (end-to-end encrypted messaging) and `paykit` (cross-app
payment metadata) — with the real API in their upstream READMEs. Neither is part of the core
`pubky` SDK surface documented elsewhere in this skill. For the shared protocol model these build
on (homeserver, `/pub` addressing, public-key string formats, PKARR, event streams) see
[`concepts.md`](concepts.md) — canonical there, not restated here.

## Status & guardrails (read first)

> **Both are pre-1.0 and experimental. Never present them as shipped, production-ready Pubky
> features.**
>
> - **`paykit` is explicitly not production-ready** — its README opens with `WIP - not for
>   production.`; latest tag is in the `0.1.0-rc` series.
> - **`pubky-noise` is a release candidate** — on crates.io only at `0.1.0-rc5`.
> - **Neither adds `/priv` or homeserver encrypted/private storage.** E2E privacy is
>   **client-side** ChaCha20-Poly1305 ciphertext written under ordinary **public `/pub`** paths
>   (the "outbox model") at DH-derived path segments — *not* a homeserver primitive. Consistent
>   with "only `/pub` ships"; see [`shipped-vs-planned.md`](shipped-vs-planned.md). Don't let
>   their existence imply `/priv` or guarded storage is available.
> - **Version skew:** `pubky-noise` depends on `pubky` `0.8.0` and `paykit-lib` pins
>   `pubky = "0.8"`, while this skill documents the core SDK at `0.9.x`/`0.10.x`. These layered
>   crates lag the core SDK — expect a compatibility gap.

## When to reach for which

| You need | Reach for |
| :-- | :-- |
| Authenticated, E2E-encrypted P2P messages between two Pubky users, **no** payment semantics | `pubky-noise` directly |
| Discover where an identity can **receive** payment + exchange payment metadata across apps | `paykit` |
| Stateless Rust helpers — you own sessions, keys, persistence, dedupe | `paykit-lib` |
| A stateful runtime — durable link snapshots, retry/recovery, request lifecycle, receipt indexing | `paykit-sdk` |
| Native iOS/Android/React Native payment UI | bindings below — but native work belongs to the **`pubky-mobile`** skill's domain |

`paykit`'s private channel **is** a `pubky-noise` session — use `pubky-noise` *directly* only
when you want generic messaging without payment semantics.

---

## `pubky-noise` — E2E messaging

Authenticated, end-to-end encrypted P2P messaging over homeservers. **Outbox model:** each peer
**writes** encrypted Noise messages to its **own** homeserver and **reads** from the **remote**
peer's homeserver (ordinary public `/pub` paths). Wraps the Snow Noise implementation in an
async, polling-safe interface with built-in session backup/restore.

**Crypto / wire.** Protocol name `Noise_{pattern}_25519_ChaChaPoly_SHA256` — X25519 DH,
ChaCha20-Poly1305 AEAD, SHA-256 transcript hash, stateless transport with an explicit
per-message nonce. Patterns **`NN`** (anonymous) and **`XX`** (mutual auth) are *implemented*;
`N`, `IK`, `NK` are declared in the enum but **panic if used**. Wire framing is length-prefixed
`[len_hi, len_lo, payload]`; payload max **1000 bytes** (`PUBKY_NOISE_MSG_LEN`), total packet
1002 bytes.

**Core types.** `PubkyNoiseConfig` — shared resources (HTTP client, authenticated
`PubkySession`, read/write paths, root keypair, default pattern); wrap in `Arc` and share across
sessions. `PubkyNoiseEncryptor` — one Noise session with one remote peer. `LinkId` — 32-byte id
from the handshake transcript hash, available after `transition_transport()`.
`PubkyNoiseSessionState` — a 197-byte serializable snapshot.

**Lifecycle.** `new()` → `handle_handshake()` in a loop (`HandshakeResult::Pending` until the
peer's message lands, then `Terminal`) → `transition_transport()` → `send_message()` /
`receive_message()` → `close()`. `handle_handshake()` is **polling-safe**: callable repeatedly
by either side in any order.

**Path derivation (privacy).** `derive_asymmetric_paths(my_sk, their_pk, domain, base_path)` →
`(write_path, read_path)`, where each segment is
`"{base_path}/{hex(SHA-256(domain || dh_secret || pubkey))}"` and
`dh_secret = X25519(local_seed_scalar, montgomery(remote_ed25519_pk))`. Commutativity guarantees
**Alice's `write_path` == Bob's `read_path`**, so third parties can't enumerate who-talks-to-whom.
Note the derived segment is **hex of SHA-256, not z-base-32**.

### Gotchas (read before shipping)

- **Crash / write-failure recovery.** Snow's `HandshakeState` is a one-way ratchet — once
  `write_message()` runs, internal state advances irreversibly, so if the homeserver `put()`
  *then* fails the encryptor is corrupted and cannot retry. Each `handle_handshake()`
  auto-captures a **pre-mutation snapshot**; on `HomeserverWriteError` (or a lost write) call
  `last_good_snapshot()`, persist it, and rebuild via
  `PubkyNoiseEncryptor::restore(config, state, endpoint_pubkey)` — which replays handshake
  messages from the homeservers. `last_good_snapshot()` returns `None` before the first
  `handle_handshake()` call.
- **The snapshot is critical key material.** The 197-byte `PubkyNoiseSessionState` contains the
  ephemeral secret key (offset 4–35) and an optional static secret key (offset 37–68) — that is
  what lets `restore()` re-derive transport keys. **Store snapshots encrypted at rest; never log
  or expose them.** Old 189-byte snapshots from `0.1.0-rc3` are rejected by the current 197-byte
  deserializer — re-establish the link instead of migrating them.

### Quick start

Illustrative README example (`rust,no_run`, **not** CI-verified): build config, build
initiator/responder encryptors, run the polling-safe handshake loop, transition, send/receive.

```rust
use std::sync::Arc;
use pubky::prelude::*;
use pubky_noise::{PubkyNoiseConfig, PubkyNoiseEncryptor, HandshakeResult};

// 1. Create shared configuration
//    (requires an authenticated PubkySession and a Pubky HTTP client)
let config = PubkyNoiseConfig::new(
    root_secret_key,          // [u8; 32] - root Ed25519 secret key
    0,                        // protocol version
    "XX",                     // Noise handshake pattern
    homeserver_session,       // authenticated PubkySession
    "/pub/data".to_string(),  // storage path prefix
    pubky_client,             // Pubky HTTP client
).unwrap();

// 2. Create encryptors for each side
let mut initiator = PubkyNoiseEncryptor::new(
    config.clone(),
    ephemeral_secret_key,     // [u8; 32] - per-session key
    true,                     // initiator = true
    responder_public_key,     // remote peer's PublicKey
).unwrap();

// 3. Run the handshake (polling-safe, call repeatedly)
loop {
    match initiator.handle_handshake().await.unwrap() {
        HandshakeResult::Pending => { /* poll again later */ },
        HandshakeResult::Terminal => break,
    }
}

// 4. Transition to transport phase
let link_id = initiator.transition_transport().unwrap();

// 5. Send and receive encrypted messages
initiator.send_message(b"Hello, peer!").await?;
let messages = initiator.receive_message().await?;

// 6. Clean up
initiator.close();
```

---

## `paykit` — cross-app payments

A **meta payment protocol**: discovery + exchange of Payment Endpoints, Private Payment Lists,
Payment Requests, Payment Proofs, and Receipts. It does **not move money or pick the final
endpoint** — wallets/processors keep control of payment **execution, selection, scheduling, and
lifecycle**. Reach for it when an app needs to learn where a Pubky identity can *receive* payment
and trade payment metadata across apps.

**Architecture — layered on `pubky-noise`.** Public Payment Endpoints use plain Pubky public
storage (`pubky::PubkySession` writes, `pubky::PublicStorage` reads). Private messages (Private
Payment Lists, Payment Requests, Receipt Access) ride a `paykit` **Encrypted Link**, which **is**
a `pubky-noise` `XX` channel — its `PubkyNoiseEncryptor` owns encryption, file naming, counters,
and storage slots.

**Storage layout (reuse the exported constants, never hardcode).** Public endpoints at
`/pub/paykit/v0/{payment_endpoint_identifier}` (one file each), `PAYKIT_PATH_PREFIX =
/pub/paykit/v0/`. Private paths derive from `PAYKIT_PRIVATE_PATH_PREFIX = /pub/paykit/v0/private`
via `pubky-noise`'s `derive_asymmetric_paths`. Encrypted Receipts live at
`/pub/paykit/v0/private/receipts/{ReceiptId}`. `paykit` reuses `/pub/paykit/*` as a cross-app
*protocol scope* — see [`concepts.md`](concepts.md#addressing-and-the-pub-tree).

### `paykit-lib` vs `paykit-sdk`

- **`paykit-lib` — stateless.** Free functions over concrete Pubky handles, no global state; the
  **caller owns** sessions, keys, persistence, and dedupe.
- **`paykit-sdk` — stateful runtime.** Durable Encrypted-Link snapshots, private-stream intake,
  outbound retry/recovery, Payment Request lifecycle state, receipt indexing, Paykit Profiles,
  Contact Records, backup/restore. Apps build a `PaykitSdk` with a `StorageAdapter` +
  `PubkySessionProvider` + `PaymentAdapter`.

Platform bindings (Swift/Kotlin/RN) currently wrap **`paykit-lib`**; SDK bindings are the
planned next layer.

### Public Payment Endpoints

`set_payment_endpoint(session, identifier, payload)` and `remove_payment_endpoint(session,
identifier)` take `&pubky::PubkySession`; `get_payment_list(storage, payee)` and
`get_payment_endpoint(storage, payee, identifier)` take `&pubky::PublicStorage`. Missing
files/dirs are treated as **absent** (`None` / empty list), not errors; `remove` of a
non-existent endpoint **succeeds** (retry-safe).

`PaymentEndpointIdentifier::new(s)` is **fallible and path-injection-safe**: 1–64 ASCII chars
from `[a-zA-Z0-9_-.]`, rejecting `.`/`..`, slashes, null bytes, and the reserved values `private`
and `encrypted-link-recovery`. `PaymentEndpointPayload::new(s)` is opaque UTF-8.
`PaymentList.payment_endpoints` is a `HashMap<PaymentEndpointIdentifier, PaymentEndpointPayload>`.
`PaykitError` has exactly four variants — `Transport{context,source}`, `NotFound(String)`,
`InvalidData{context,source}`, `Validation(String)` — and all public fns return
`paykit_lib::Result<T>`.

**Identifier convention (recommended, *not* enforced):** three byte-compared segments
`{asset}-{rail}-{endpoint_format}`, lowercase `a-z`/`0-9`, hyphen separator, no intra-segment
punctuation — e.g. `btc-bitcoin-p2tr`, `btc-lightning-bolt11`, `usdt-ethereum-address`,
`eur-sepa-iban`. `paykit-lib` enforces only structural path-safety, **not** the three-segment
shape. Recommended payload is a JSON object with a `value` field plus optional `min`/`max`.

```rust
use paykit_lib::{
    set_payment_endpoint, get_payment_endpoint, get_payment_list,
    PaymentEndpointIdentifier, PaymentEndpointPayload,
};

// Create validated types.
let identifier = PaymentEndpointIdentifier::new("btc-lightning-bolt11")?;
let payload = PaymentEndpointPayload::new("lnbc1...");

// Store a Payment Endpoint using an authenticated PubkySession.
set_payment_endpoint(&session, identifier.clone(), payload).await?;

// Read it back using pubky::PublicStorage.
let endpoint = get_payment_endpoint(&public_storage, &payee_pubkey, &identifier).await?;

// List all published Payment Endpoints for a payee.
let payment_list = get_payment_list(&public_storage, &payee_pubkey).await?;
for (identifier, payload) in &payment_list.payment_endpoints {
    println!("{}: {}", identifier.as_str(), payload.as_str());
}
```

<sub>Illustrative README example (`rust,ignore`, not CI-verified).</sub>

### Private messages: the Encrypted Link

`initiate_encrypted_link(session, sender_sk, receiver_pk, outbox_client)` (initiator) /
`accept_encrypted_link(session, receiver_sk, sender_pk, outbox_client)` (responder) →
`EncryptedLinkHandshake`; drive with `advance_handshake(handshake)` →
`HandshakeProgress::Pending(h) | Complete(EncryptedLink)`. Polling-safe; auto-recovers from
`HomeserverWriteError` up to `DEFAULT_MAX_RECOVERY_ATTEMPTS = 3`. Snapshot/restore via
`EncryptedLink::serialize()` / `restore_encrypted_link(...)` and
`EncryptedLinkHandshake::serialize()` / `restore_encrypted_link_handshake(...)` (same 197-byte
`pubky-noise` wire format). Tear down with `close_encrypted_link(link)`.

> **Who initiates?** Noise needs exactly one initiator and one responder, and user flow alone
> often can't decide. Recommended tie-break: compare the two public keys and let the party with
> the **lexicographically bigger** public key be the initiator.

**Message semantics (decision-critical).** All Private Application Messages share **one ordered
encrypted stream**, consumed via `EncryptedLink::receive_private_application_messages()`. Route
the raw stream with the stateless parsers `parse_private_payment_list_json`,
`parse_payment_request_event_message`, `parse_receipt_access_event_message`:

- **Private Payment Lists** (`paykit.private_payment_list`) — **latest-state**: the newest *valid*
  message supersedes older ones; a malformed newer message does **not** supersede.
- **Payment Requests** (`paykit.payment_request` + acceptance/rejection/cancellation/proof) and
  **Receipt Access** (`paykit.receipt_access`) — **event messages**: FIFO, every valid message
  matters, each carries a UUID-v4 Event ID; **dedupe by `event_id`**.

> **Durability gotcha.** The Encrypted-Link snapshot is your local **read checkpoint**. If you
> trigger side effects from event messages, **persist your handled/unhandled event state BEFORE**
> persisting a snapshot whose read counter has advanced past those messages — otherwise events
> are silently dropped. If events are persisted but the snapshot is not, **replay is expected**
> (dedupe by `event_id`; Receipt Access also by Receipt ID). Commit raw stream items, derived
> indexes, and the advanced snapshot **atomically**.

### Receipts

Three objects: plaintext `Receipt` (created/decrypted locally, **never stored raw**), `Encrypted
Receipt` (stored at the issuer's Receipt Location on the homeserver), and `ReceiptAccess` (an
event-message descriptor sent over the link carrying Event ID, ReceiptId, `payment_reference`,
optional `payment_request_id`/`billing_period`, the Receipt Location, and the symmetric **Receipt
Decryption Key**). Retryable pipeline: `prepare_receipt(link, draft)` →
`store_prepared_receipt(session, prepared)` → `send_receipt_access(link, access)`. Encryption is
**XChaCha20-Poly1305 with the storage location path as AAD** — decrypting against a different
location fails, and plaintext whose ReceiptId doesn't match the location is rejected. Receipt
Decryption Keys are sensitive (redacted from `Debug`/`Display`; keep out of logs).

### More gotchas

- **Closed-world JSON.** v0.2 private wire messages reject **unknown fields** unless the field is
  an explicit open object (Payment Request `metadata`, Payment Proof `proof`, Receipt Metadata).
- **`get_payment_list` is a best-effort snapshot.** It lists, then fetches each endpoint
  individually, and Pubky public storage has **no atomic reads** — endpoints can change between
  list and fetch. On a failed payment, re-fetch the specific endpoint with `get_payment_endpoint`
  and compare payloads.
- **Public Payment Lists are public.** Anyone who knows the payee's public key can read them —
  don't publish correlation-sensitive payloads publicly.

### Bindings

`paykit-ffi` exposes UniFFI **Swift/Kotlin** bindings; `@synonymdev/react-native-paykit` wraps
them for React Native (all functions return `Promise<Result<T>>` via `@synonymdev/result`). Note
`importSession` takes a `"pubkey_z32:cookie_secret"` string and `getPaymentList` takes a z-base-32
public-key string — the raw `z32()` form, not the `pubky<z32>` display form
([public-key string formats](concepts.md#public-key-string-formats)). **Native/mobile usage of
`paykit` belongs conceptually to the `pubky-mobile` skill** — keep trigger vocabularies disjoint.

```jsx
import {
  initialize, importSession, getPaymentList, getPaymentEndpoint,
  setPaymentEndpoint, removePaymentEndpoint,
  initiateEncryptedLink, advanceHandshake, setPrivatePaymentList,
  receivePrivateApplicationMessages,
} from '@synonymdev/react-native-paykit';

const initResult = await initialize();
if (initResult.isErr()) console.error('Failed to init:', initResult.error);

// Restore a session from a stored secret
const sessionResult = await importSession('pubkey_z32:cookie_secret');

// Fetch a user's Payment Endpoints
const listResult = await getPaymentList('user_public_key');
if (listResult.isOk()) {
  for (const e of listResult.value) {
    console.log(`${e.payment_endpoint_identifier}: ${e.payment_endpoint_payload}`);
  }
}

await setPaymentEndpoint('btc-bitcoin-p2tr', 'bc1p...');

// Private messages use Encrypted Link handles
const handshake = await initiateEncryptedLink(secretKeyHex, receiverPublicKey);
if (handshake.isOk()) {
  const progress = await advanceHandshake(handshake.value);
  if (progress.isOk() && progress.value.status === 'complete') {
    await setPrivatePaymentList(progress.value.linkHandle, {
      payment_endpoints: [
        { payment_endpoint_identifier: 'btc-lightning-bolt11', payment_endpoint_payload: '{"value":"lnbc1..."}' },
      ],
    });
    const messages = await receivePrivateApplicationMessages(progress.value.linkHandle);
  }
}
```

<sub>Illustrative React Native README example, not CI-verified.</sub>

---

## Dependency sourcing

- **`pubky-noise` is on crates.io** — `pubky-noise = "0.1.0-rc5"`.
- **`paykit-lib` is NOT published** (`crates.io/api/v1/crates/paykit-lib` → 404; the README uses
  a `version = "x.x.x"` placeholder) — pull it as a **git dependency** from
  [`github.com/pubky/paykit-rs`](https://github.com/pubky/paykit-rs).

Both churn — prefer pinning the **`0.1.0-rc` series** (or a git rev) over an exact rc you'll have
to chase.

## Upstream — the full guides

Per the link-don't-mirror rule, treat these as the source of truth and re-check signatures there:

- **`pubky-noise`:** [github.com/pubky/pubky-noise](https://github.com/pubky/pubky-noise) (README
  + e2e tests are the full guide) · [crates.io](https://crates.io/crates/pubky-noise)
- **`paykit`:** [github.com/pubky/paykit-rs](https://github.com/pubky/paykit-rs) — root `README.md`,
  `paykit-lib/README.md`, `paykit-sdk/README.md`, `THESAURUS.md`, and
  `specs/payment-endpoint-identifier.md`
- **Guardrails this file depends on:** [`shipped-vs-planned.md`](shipped-vs-planned.md) (no
  `/priv`, no shipped encrypted storage) and [`concepts.md`](concepts.md) (homeserver model,
  `/pub` addressing, public-key string formats).
