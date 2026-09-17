# Advanced: E2E messaging (`pubky-noise`) and payments (`paykit`)

This file says when to use two **external, pre-1.0** crates that sit on top of Pubky: `pubky-noise` (end-to-end encrypted P2P messaging) and `paykit` (cross-app payment discovery and exchange). It points you to the right crate and doesn't replace their docs. Neither crate is part of the core `pubky` SDK. Check exact signatures in the [upstream READMEs](#upstream-sources-of-truth) before you write code. The shared model these crates build on (identity, homeserver, `/pub` addressing, public-key string formats) is covered in [`concepts.md`](concepts.md), so this file doesn't repeat it.

## Status and guardrails (read first)

- **Neither crate is production-ready.** The paykit-rs README opens with `> WIP - not for production.`, and `pubky-noise` has no stable release.
- **Versions (checked 2026-09-17):**
  - `pubky-noise`: crates.io's newest release is **`0.1.0-rc8`**. The repo is at **`0.1.0-rc9`**, which is **unreleased** (its README install line says rc9 anyway).
  - `paykit-lib`, `paykit-sdk` and `paykit-ffi` are at **`0.1.0-rc55`**, and **none of them is on crates.io**.
- **Version skew with the core SDK.** paykit rc55 depends on `pubky = "0.11.0"` and `pubky-noise = "0.1.0-rc8"`. pubky-noise rc8 and rc9 also depend on `pubky 0.11.0`. That matches neither the version [`sdk-rust.md`](sdk-rust.md) documents nor the current `pubky` on crates.io (0.12.0). If you use these crates, pin `pubky` to 0.11 and expect API differences from the rest of this skill.
- **Neither crate adds private or encrypted homeserver storage.** All data sits under ordinary **public `/pub`** paths, and `pubky-noise` never uses `/priv`. Confidentiality comes from **client-side ciphertext**. Paths are unguessable **only when you use `derive_asymmetric_paths` + `new_with_paths`**. With `PubkyNoiseConfig::new(..., "/pub/data")`, the message paths and `{write_path}/backup` are fixed and anyone can list them. Guarded or encrypted storage still hasn't shipped: see [`shipped-vs-planned.md`](shipped-vs-planned.md#no-private-encrypted-or-guarded-storage).
- **"Backup/restore" here means crate-local state only.** In `pubky-noise` it means restoring a Noise session snapshot. In `paykit-sdk` it means exporting and restoring SDK state over a transport your app owns. **Neither is Pubky Backup restore or homeserver mirroring,** which are still planned ([`shipped-vs-planned.md`](shipped-vs-planned.md#backup-restore-and-mirroring)).
- **Snippets are not CI-verified.** Each snippet is copied from an upstream README. During this refresh each one was run against a **local Pubky testnet** at the version given in its caption. For maintained runnable code, see pubky-noise [`e2e/`](https://github.com/pubky/pubky-noise/tree/main/e2e) (`cargo nextest run -p e2e`, which needs Docker for Testcontainers PostgreSQL) and paykit-lib `src/tests/*`.

## When to reach for which

| You need | Use |
| :-- | :-- |
| E2E-encrypted messages between two Pubky users, with no payment semantics | `pubky-noise` directly |
| To find where an identity can **receive** payment, and to exchange payment requests, proofs and receipts across apps | `paykit` |
| Stateless Rust helpers, where you own sessions, keys, persistence and dedupe | `paykit-lib` |
| A stateful runtime (endpoint sync, link snapshots, stream intake, request state, receipt indexing, contacts, SDK backup) | `paykit-sdk` (one runtime per app/receiver) |
| iOS/Android payments | `paykit-ffi` (Swift/Kotlin over `paykit-sdk`). Native work belongs to the **`pubky-mobile`** skill. |

A paykit Encrypted Link **is** a `pubky-noise` `XX` session, and `paykit-lib` re-exports `pubky_noise`.

- **The re-export is crates.io rc8, not the rc9 API** in the backup section below. `paykit_lib::pubky_noise::PubkyNoiseEncryptor::persist_snapshot()` is the plaintext rc8 version.
- **Don't add a pubky-noise rc9 git dependency next to paykit-lib.** Cargo then builds two separate pubky-noise versions whose types can't be used together.

---

## `pubky-noise`: E2E messaging

**Outbox model.** Each peer **writes** Noise messages to its **own** homeserver and **reads** the remote peer's homeserver.

**Crypto and wire format**

- **Suite:** `Noise_{pattern}_25519_ChaChaPoly_SHA256`, with explicit nonces.
- **Patterns:** only **`NN`** (anonymous) and **`XX`** (mutual authentication) are implemented. `N`, `IK` and `NK` exist in the enum but **panic if used**.
- **Packets** are `[len_hi, len_lo, ciphertext..., zero padding...]`, where `len` is a big-endian u16.
  - Plaintext is at most **1000 bytes** (`PUBKY_NOISE_MSG_LEN`).
  - Ciphertext is at most 1016 bytes, including the 16-byte tag (`PUBKY_NOISE_TAG_LEN`).
  - Every stored packet is **1018 bytes**.
- **Slots:** messages go to incrementing slot indices under each direction's path.
  - During the handshake, reads and writes share one counter.
  - After `transition_transport()`, that counter becomes the base slot and each direction keeps its own counter.
  - Snow nonces are tracked separately from slots.

**Core types (upstream signatures)**

- `PubkyNoiseConfig::new(root_seckey: [u8;32], version: u32, pattern: &str, session: PubkySession, destination_path: String, outbox_client: Pubky) -> Result<Arc<Self>, PubkyNoiseError>` uses one path for both directions.
- `PubkyNoiseConfig::new_with_paths(..., write_path, read_path, outbox_client)` takes separate write and read paths. Use it with path derivation.
- `PubkyNoiseEncryptor::new(config: Arc<PubkyNoiseConfig>, holder_skey: [u8;32], initiator: bool, endpoint_pubkey: PublicKey)` creates one session with one peer.
  - `holder_skey` is the **local static Noise secret key** that `XX` authenticates, not a per-session ephemeral key.
  - **Zeroize your own copy.** `[u8;32]` is `Copy`, so the crate only overwrites its local copy, using a plain `copy_from_slice` without the `zeroize` crate (the compiler may remove that write). Your copy of the key is never wiped. Hold it in a `zeroize::Zeroizing` wrapper, for example.
- `LinkId` is a 32-byte id from the handshake hash. It's available after `transition_transport()`.
- `PubkyNoiseSessionState` is a 197-byte snapshot.
- `PreparedSend` and `PreparedReceive` are staged transport results.

**Handshake.** Call `handle_handshake()` in a loop. It's polling-safe: either side can call it repeatedly, in any order. It returns `HandshakeResult::Pending` without advancing state until the peer's message arrives, then returns `Terminal`. **Sleep or back off between polls.** Each call hits the homeserver.

**Path derivation (use it for unlinkable paths).** Call `pubky_noise::path_derivation::derive_asymmetric_paths(&my_sk, &their_pk, domain: &[u8], base_path: &str) -> (write_path, read_path)`, then pass the result to `new_with_paths`.

- Each path is `{base_path}/{hex(SHA-256(domain || dh_secret || pk))}`. The write path uses your key as `pk`; the read path uses the peer's.
- `dh_secret` is X25519 over the Ed25519 keys converted to Montgomery form. DH is commutative, so **Alice's write_path equals Bob's read_path**.
- The segment is **64 hex characters, not z-base-32**.
- The README example's base `/pub/paykit.app/v0/private` is **not** paykit's real prefix.

### Sending and receiving: use the staged API

**Don't use `send_message()` or `retry_pending_send()`.** Both are `#[deprecated]`: they can't persist the ciphertext and the new state atomically, and their recovery lives only in memory, so a crash loses it.

1. **Send.** Call `prepare_send(plaintext)` to get a `PreparedSend` with `destination_path()`, `ciphertext()` and `resulting_session_state()`.
   - Atomically persist the ciphertext and the resulting state as one outbound record.
   - Call `acknowledge_persisted_send(prepared)`.
   - Publish the persisted records **in order**. If a write's outcome is uncertain, retry with the **exact stored ciphertext**.
2. **Receive.** Call `next_receive_path()`, then `prepare_receive()`. Atomically persist the new state with your app's processing result, then call `acknowledge_persisted_receive()`.
3. **If atomic persistence fails,** drop the encryptor and restore the last persisted state. A staged operation can't be discarded in place.
4. **Don't commit a staged operation with `persist_snapshot()`.** It fails with `UnacknowledgedPreparedTransport` while an acknowledgement is pending, and so does `snapshot()`.
5. **Use `receive_message()`** only when you don't need atomic processing.

The staged APIs provide no cross-process authentication, authorization or locking.

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

// 5. Prepare, persist, and publish an encrypted message
let prepared = initiator.prepare_send(b"Hello, peer!")?;
persistent_store.commit_send(
    prepared.destination_path(),
    prepared.ciphertext(),
    prepared.resulting_session_state(),
)?;
initiator.acknowledge_persisted_send(prepared)?;
ordered_publisher.flush_in_order().await?;

// Receive convenience API; use prepare_receive for durable processing.
let messages = initiator.receive_message().await?;

// 6. Clean up
initiator.close();
```

<sub>pubky-noise README Quick Start (`rust,no_run`), copied unchanged. Ran end to end against crates.io **rc8** on a local testnet with an `XX` responder. Not CI-verified. Corrections to the upstream text:
(1) `ephemeral_secret_key // per-session key` is mislabeled. The argument is the local **static** Noise key.
(2) The loop busy-polls on `Pending`. Add a sleep or backoff (clippy also flags `while_let_loop`).
(3) The fixed `/pub/data` path gets none of the unlinkability from `derive_asymmetric_paths`.
(4) Don't copy the `.unwrap()` calls into library code. Propagate `PubkyNoiseError` instead.
`persistent_store` and `ordered_publisher` are types you write yourself.</sub>

### Session snapshots and encrypted backup (unreleased rc9, git only)

> **Everything in this section requires unreleased `pubky-noise` 0.1.0-rc9.** Use a git dependency on `github.com/pubky/pubky-noise` pinned to a rev (verified at `e38460d`), not crates.io rc8. That covers `backup_crypto`, `persist_snapshot(&backup_key, generation)`, `load_snapshot` / `LoadedSnapshot` and `MAX_BACKUP_RESPONSE_BYTES`. Against rc8 the snippet below fails to compile (E0432/E0061/E0599). Remember that paykit-lib pins rc8 (see above).
>
> **Never call rc8's `persist_snapshot()`.** That includes `paykit_lib::pubky_noise`. It takes no arguments and uploads the 197-byte session state, **including the ephemeral and static secret keys, unencrypted**, to public `{write_path}/backup`. On rc8, encrypt snapshots yourself and store them off `/pub`.

**The snapshot holds secret keys.** `PubkyNoiseSessionState` contains the ephemeral secret key (bytes 4–35) and, optionally, the static secret key (bytes 37–68).

- **Never store it in plaintext.** If you persist it outside rc9 `persist_snapshot()`, encrypt it yourself.
- **Make superseded snapshots unrecoverable.** Old ephemeral keys can expose that session's messages.
- **Never log decrypted plaintext.**

| Call (rc9) | What it does |
| :-- | :-- |
| `persist_snapshot(&backup_key, generation)` | Encrypts the snapshot and uploads it to `{write_path}/backup`. It's under `/pub`, so the ciphertext is publicly readable. |
| `PubkyNoiseEncryptor::load_snapshot(&config, &backup_key, min_generation: Option<u64>)` | Returns `LoadedSnapshot { generation, state }`. |
| `PubkyNoiseEncryptor::restore(config, state, endpoint_pubkey).await` | Rebuilds the session by replaying handshake messages from the homeservers. |
| `backup_crypto::derive_backup_key(&root_secret)` | Returns SHA-256(`"pubky-noise/session-backup/v0"` \|\| root_secret). Delegated apps without the root secret must supply their own 32-byte key. |

- **Envelope:** `"PNBK" || version || alg_id || nonce || ciphertext`. It uses XChaCha20Poly1305 with a random 192-bit nonce and the 6-byte header as AAD.
- **Read cap:** `MAX_BACKUP_RESPONSE_BYTES` (4096). Known limitation: the pubky SDK reads the full body of a non-2xx GET response before the cap applies.

**Rollback protection is your job.** AEAD doesn't prove a backup is fresh. A stale or malicious homeserver can replay an older valid backup, which causes **nonce reuse and slot overwrites**.

1. Give every new snapshot a **strictly higher** `generation`. `load_snapshot` still accepts a generation equal to your checkpoint.
2. Advance your trusted local checkpoint **before**, or atomically with, `persist_snapshot()`.
3. After `load_snapshot()`, save `loaded.generation` as the checkpoint **before** the restored session does anything.
4. Keep the checkpoint in trusted, rollback-resistant storage, **never on the same homeserver as the backup**.
5. With `min_generation = None` (for example on a fresh device), rollback **can't be detected**. If you don't know whether the checkpoint is fresh, discard the restored state and start a new Noise session.

A backup older than your checkpoint returns `RestoreBackupRollbackError`.

```rust
use pubky_noise::backup_crypto;

let backup_key = backup_crypto::derive_backup_key(&root_secret);

let generation = local_checkpoint.map_or(1, |checkpoint| checkpoint + 1);

// IMPORTANT: advance your trusted local checkpoint to `generation` *before*
// (or atomically with) this call -- see "Rollback protection" below.
save_checkpoint(generation)?;
encryptor.persist_snapshot(&backup_key, generation).await?;

// Later (e.g. after a crash or on another device): fetch, decrypt and restore.
let local_checkpoint = load_checkpoint();
let loaded = PubkyNoiseEncryptor::load_snapshot(&config, &backup_key, local_checkpoint).await?;

// record accepted generation *before* the restored session resumes activity
save_checkpoint(loaded.generation)?;

let mut restored = PubkyNoiseEncryptor::restore(config, loaded.state, peer_pubkey).await?;
```

<sub>pubky-noise README (`rust,ignore`), copied unchanged. **Requires rc9 from git (unreleased) and doesn't compile against crates.io rc8.** Ran against upstream HEAD `e38460d` on a local testnet: persist, load, restore with a matching `LinkId`, and a stale load rejected with `RestoreBackupRollbackError`. Not CI-verified. It's a fragment: `PubkyNoiseEncryptor`, `encryptor`, `config`, `root_secret`, `local_checkpoint` and `peer_pubkey` all come from your code, and `save_checkpoint` / `load_checkpoint` are your trusted storage.</sub>

### Handshake write failures and errors

**If `handle_handshake()` returns `Err(HomeserverWriteError)`, the encryptor is corrupted.** Snow's `HandshakeState` only moves forward, so recover like this:

1. Take `last_good_snapshot()`. It's captured before any change at the start of each call, and is `None` before the first call.
2. Drop the encryptor.
3. Call `PubkyNoiseEncryptor::restore(config, snapshot, endpoint_pubkey)`.

This recovery has limits:

- Persisting the state from before the call only helps after an *explicit* write error.
- If a put succeeds but the server later loses the data, `handle_handshake()` returns `Ok(Pending)` forever. Keep your durable checkpoint at the pre-write state until the peer's progress confirms the write.
- During the transport phase, `restore()` checks the handshake hash and returns `RestoreBackupHashMismatch` if it differs.

**Errors.** The full `PubkyNoiseError` variant list is in the [README error-handling section](https://github.com/pubky/pubky-noise/blob/main/pubky-noise/README.md#error-handling). These need special handling:

| Error | What to do |
| :-- | :-- |
| `CounterOverflow`, `NonceOverflow` | Start a new Noise session. |
| `HomeserverWriteError` | Recover as described above. |
| `UnacknowledgedPreparedTransport`, `NoPreparedTransport`, `PreparedTransportMismatch` | Fix how your code uses the staged API. |
| `RestoreBackup*` | Restore failed: replay, hash mismatch, deserialize, decrypt, rollback or not found. |

The `test-utils` feature enables `test_enable_tampering`, `test_enable_write_failure` and `test_last_ciphertext`.

---

## `paykit`: cross-app payments

**Paykit is a meta payment protocol and doesn't move money.** It handles discovery (where an identity can receive payment) and exchange: Payment Requests, Payment Proofs, receipts and Receipt Access. Wallets, processors and apps keep control of:

- payment execution and selection,
- business rules and local storage,
- key rotation,
- recurring scheduling, request lifecycle state and timeouts.

Vocabulary is defined in [`THESAURUS.md`](https://github.com/pubky/paykit-rs/blob/main/THESAURUS.md).

**Dependency.** paykit isn't on crates.io, and its README shows a placeholder version (`"x.x.x"`). Use a git dependency pinned to a tag:

```toml
paykit-lib = { git = "https://github.com/pubky/paykit-rs", tag = "v0.1.0-rc55" }
```

**Crate split**

- **`paykit-lib` is stateless.** It takes concrete Pubky SDK handles and keeps no global state. It does **not**:
  - execute payments or pick an endpoint,
  - track recurring or lifecycle state, or run a background service,
  - fetch profiles or contacts,
  - manage session creation, scopes, key rotation or recovery.
- **`paykit-sdk` is the stateful runtime.** It covers endpoint sync, Encrypted Link snapshots, private stream intake, Private Payment Lists, Payment Request state, receipt indexing, Paykit Profiles, local Contact Records, contact payment resolution, reservations, and SDK-state backup/restore (app-owned transport; not Pubky Backup).
- **Since rc55,** `PubkySessionBootstrap::republish_identity(public_key)` rebroadcasts an existing signed Pubky identity record unchanged. It needs no secret key and no restored session. Your app owns scheduling, throttling, retries and timeouts.

### Storage layout (receiver-scoped)

**Everything is scoped to a receiver path.** Use the exported constants `PAYKIT_PATH_PREFIX = "/pub/paykit/v0"` (no trailing slash) and `PAYKIT_PRIVATE_PATH_PREFIX = "/pub/paykit/v0/private"`.

| Data | Path |
| :-- | :-- |
| Public Payment Endpoint | `/pub/paykit/v0/{receiver_path}/endpoints/{payment_endpoint_identifier}` |
| Receiver Marker | `/pub/paykit/v0/{receiver_path}/receiver.json` |
| Private message bases | `/pub/paykit/v0/private/{receiver_path}/messages/<derived hex>` |
| Encrypted Receipts | `/pub/paykit/v0/private/{receiver_path}/receipts/{ReceiptId}` |
| Recovery markers | `/pub/paykit/v0/private/{receiver_path}/encrypted-link-recovery` |

- **The `private` segment is only a naming convention.** Everything is under **public `/pub`**.
- **The `/pub` layout isn't stabilized.** See [`concepts.md`](concepts.md#addressing-and-the-pub-tree).

**Receiver path.** `PaykitReceiverPath::new(s)` returns an error on invalid input. It enforces these rules:

- exactly 2 segments, `{app}/{runtime}`, where **the runtime segment must be exactly `wallet` or `server`** (for example `bitkit/wallet`);
- at most 128 bytes total and 64 bytes per segment;
- only lowercase ASCII letters, digits and `-`;
- `.` and `..` are rejected, and `private` is reserved as the app segment.

A receiver path identifies **one Paykit runtime folder under an identity, not the user**.

### Public Payment Endpoints

Every call takes a receiver path. Writes take `&pubky::PubkySession`; reads take `&pubky::PublicStorage`.

- **Discover:** `list_paykit_receiver_paths(storage, payee)`.
- **Write:** `set_payment_endpoint(session, &receiver_path, identifier, payload)` and `remove_payment_endpoint(session, &receiver_path, identifier)`. Removing a missing endpoint succeeds, so retries are safe.
- **Read:** `get_payment_list(storage, payee, &receiver_path)` and `get_payment_endpoint(storage, payee, &receiver_path, &identifier) -> Option<PaymentEndpointPayload>`. A missing file returns `None` or an empty list, not an error.

**Types and errors**

- **`PaymentEndpointIdentifier::new(s)`** returns an error on invalid input and guards against path injection.
  - It allows 1–64 characters from `[a-zA-Z0-9_-.]`.
  - It rejects `.`, `..`, slashes, null bytes, spaces, and the reserved values `private` and `encrypted-link-recovery` with `PaykitError::Validation`.
  - The naming convention `{asset}-{rail}-{endpoint_format}` (for example `btc-lightning-bolt11`) is recommended but **not enforced**; see [`specs/payment-endpoint-identifier.md`](https://github.com/pubky/paykit-rs/blob/main/specs/payment-endpoint-identifier.md).
- **`PaymentEndpointPayload`** is opaque UTF-8. `PaymentList.payment_endpoints` is a `HashMap<PaymentEndpointIdentifier, PaymentEndpointPayload>`.
- **`PaykitError`** has four variants: `Transport { context, source: anyhow::Error }`, `NotFound(String)`, `InvalidData { context, source: Option<anyhow::Error> }` and `Validation(String)`. You can downcast `source` when it's present.
- **Paykit sets no deadlines.** Configure `PubkyHttpClient::builder().request_timeout(..)` yourself.

```rust
use paykit_lib::{
    set_payment_endpoint, get_payment_endpoint, get_payment_list,
    PaykitReceiverPath, PaymentEndpointIdentifier, PaymentEndpointPayload,
};

// Create validated types.
let receiver_path = PaykitReceiverPath::new("bitkit/wallet")?;
let identifier = PaymentEndpointIdentifier::new("btc-lightning-bolt11")?;
let payload = PaymentEndpointPayload::new("lnbc1...");

// Store a Payment Endpoint using an authenticated PubkySession.
set_payment_endpoint(&session, &receiver_path, identifier.clone(), payload).await?;

// Read it back using pubky::PublicStorage.
let endpoint = get_payment_endpoint(&public_storage, &payee_pubkey, &receiver_path, &identifier).await?;

// List all published Payment Endpoints for a payee.
let payment_list = get_payment_list(&public_storage, &payee_pubkey, &receiver_path).await?;
for (identifier, payload) in &payment_list.payment_endpoints {
    println!("{}: {}", identifier.as_str(), payload.as_str());
}
```

<sub>paykit-lib README Quick Start (`rust,ignore`), copied unchanged. With paykit-lib rc55 (`d263a70`) and `pubky 0.11.0` it passed clippy cleanly and ran on a local testnet: endpoint round trip plus list. Not CI-verified.</sub>

**Gotchas**

- **`get_payment_list` is best-effort.** It lists the directory, then fetches each file, and public storage has no atomic reads. If a payment fails because an endpoint was consumed, expired or changed, re-fetch it with `get_payment_endpoint`, compare the payload, and apply your own retry policy.
- **Public lists are public.** Anyone with the payee's key and receiver path can read them. Don't publish reusable or correlation-sensitive payloads. If an Encrypted Link exists, prefer the latest Private Payment List.

### Encrypted Link (private channel)

**Link keys are Noise keys scoped to one receiver, separate from the Pubky identity key.**

- The identity key finds and authenticates homeserver state.
- Keep the receiver's Noise secret in secure storage. Generate it **once per receiver** and reuse it across restarts.
- The receiver publishes its Noise public key in its Receiver Marker: `PaykitReceiverMarker { receiver_path, capabilities: { private_payments, payment_requests, receipts, outgoing_payments }, noise_public_key }`.
- Manage the marker with `publish_paykit_receiver_marker`, `get_paykit_receiver_marker` and `remove_paykit_receiver_marker`. Publishing is an explicit call because it makes the receiver **publicly discoverable**.

**Handshake**

- **Start:** `initiate_encrypted_link(session, sender_noise_secret_key: [u8;32], receiver_pubkey, receiver_noise_public_key, local_receiver_path, remote_receiver_path, outbox_client) -> Result<EncryptedLinkHandshake>` takes 7 arguments and is **synchronous**. `accept_encrypted_link(...)` has the same shape for the responder.
- **Drive:** `advance_handshake(h).await` returns `HandshakeProgress::Pending(h)` or `Complete(EncryptedLink)`, and is polling-safe. It retries `HomeserverWriteError` up to `DEFAULT_MAX_RECOVERY_ATTEMPTS` (3); change that with `set_max_recovery_attempts`.
- **Exactly one side must initiate.** If your user flow can't decide who, one option is to let the party with the **lexicographically larger public key** initiate.

```rust
use std::time::{Duration, Instant};
use paykit_lib::{advance_handshake, HandshakeProgress, EncryptedLinkHandshake};

async fn poll_with_timeout(mut handshake: EncryptedLinkHandshake) -> paykit_lib::Result<paykit_lib::EncryptedLink> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if Instant::now() > deadline {
            return Err(paykit_lib::PaykitError::Transport {
                context: "handshake timed out".into(),
                source: anyhow::anyhow!("deadline exceeded"),
            });
        }
        match advance_handshake(handshake).await? {
            HandshakeProgress::Pending(h) => {
                handshake = h;
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            HandshakeProgress::Complete(link) => return Ok(link),
        }
    }
}
```

<sub>paykit-lib README (`rust,ignore`), copied unchanged. Passed clippy against rc55 (`d263a70`) and ran on a local testnet, with both sides driven concurrently until `Complete`. Not CI-verified. Needs `anyhow` and `tokio` (`time` feature) as direct dependencies.</sub>

**Snapshot and restore**

- `EncryptedLink::snapshot()` and `serialize()` return `Result`. They fail while a prepared send is unacknowledged.
- **After a restart:** `restore_encrypted_link(session, noise_secret_key, remote_pubkey, local_receiver_path, remote_receiver_path, outbox_client, snapshot)`.
- **In-process:** `restore_encrypted_link_from_config(config, remote_pubkey, snapshot)`.
- **Handshake variants:** `restore_encrypted_link_handshake(...)` and `..._from_config(...)`.
- Restoring into mismatched receiver paths is rejected. Close a link with `close_encrypted_link(link)`.
- **Snapshot bytes are secrets.** Encrypt them at rest and never log them.

**Send failures.** Once a send exhausts `DEFAULT_MAX_SEND_RETRIES` (3), sends, receives and snapshots all fail until `EncryptedLink::retry_pending_send()` republishes the retained packet.

**Never restore an older snapshot after a failed send, and never send different plaintext from it.** The failed write may have reached the homeserver, so doing either **reuses the transport key and nonce**. Your only options are to republish the retained packet or to set up a new link.

### Private messages, Payment Requests, receipts

**All Private Application Messages share one ordered, encrypted stream.** `EncryptedLink::receive_private_application_messages()` returns the raw messages in send order, including malformed JSON. Route them with the stateless parsers `parse_private_payment_list_json`, `parse_payment_request_event_message` and `parse_receipt_access_event_message`.

| Kind | How to treat it |
| :-- | :-- |
| `paykit.private_payment_list` | **Latest state.** The newest *valid* message wins; a newer malformed one doesn't replace it. `set_private_payment_list(link, &list)` sends the **complete** list each time, and its JSON must fit in **1000 bytes** (`PUBKY_NOISE_MSG_LEN`). |
| `paykit.payment_request`, `_acceptance`, `_rejection`, `_cancellation`, `paykit.payment_proof`, `paykit.receipt_access` | **Events.** Every valid message matters. **Dedupe by `event_id`.** |

**Durability**

- **Persist before you checkpoint.** The link snapshot is your read checkpoint. Save raw stream items and your handled/unhandled event state **before** persisting a snapshot whose read counter has moved past them.
- **Expect replays.** If the events were saved but the snapshot wasn't, they arrive again. Dedupe by `event_id`, and also dedupe Receipt Access by Receipt ID.
- **Make outbound events idempotent.** Save the JSON from `serialize_payment_request_event` before you send it, and on retry reuse the same `event_id` and payload.
- **v0.2 private messages are closed-world JSON.** Unknown fields are rejected, except inside Payment Request `metadata`, Payment Proof `proof` and Receipt Metadata.

**Payment Requests** (sent by the payee)

- **API:** `send_payment_request`, `send_payment_request_acceptance`, `send_payment_request_rejection`, `send_payment_request_cancellation` and `send_payment_proof`.
- **`PaymentProof::validate_for_request(&request)` is stateless and shallow.** It checks that the request ID and payment reference match, that the billing period is present and well-formed, and that the accepted endpoint identifier matches. It does **not** verify method-specific proofs, and it doesn't execute or schedule anything.
- **Subscriptions have no separate protocol.** A Subscription is an accepted Recurring Payment Request; see [`specs/payment-requests.md`](https://github.com/pubky/paykit-rs/blob/main/specs/payment-requests.md).

**Receipts** are issued in retryable steps:

1. The issuer calls `prepare_receipt(link, receiver_path, draft)` or `prepare_receipt_for_recipient(recipient_pk, receiver_path, draft)`, then **persists** the `PreparedReceipt`.
2. The issuer calls `store_prepared_receipt(session, &prepared)`.
3. The issuer calls `send_receipt_access(link, &access)`. On retry, use the same descriptor.
4. The receiver parses the access message, fetches the Encrypted Receipt from the issuer's homeserver, and calls `decrypt_receipt(encrypted_json, key, location)`.

- **Encryption:** XChaCha20Poly1305 with the storage location as AAD. Decrypting against a different location fails, and a mismatched ReceiptId is rejected.
- **Size cap:** `MAX_ENCRYPTED_RECEIPT_BYTES` is 256 KiB.
- **Keys:** `ReceiptDecryptionKey` and `ReceiptAccess` redact the key in `Debug`/`Display`. Still, never log the raw key or persist it outside secure storage.

### Mobile bindings (`paykit-ffi`)

**UniFFI Swift/Kotlin bindings for the stateful `paykit-sdk`, not for `paykit-lib`.**

- **Entry points:** the `PaykitSdk` class (`initialize`, `syncPublicEndpoints`, `initiateLinkWithPeer` / `acceptLinkWithPeer` / `advanceLinkHandshake`, `enqueuePrivatePaymentList`, `resolvePublicContactPayment` / `prepareAndResolvePrivateContactPayment`, and more), plus `defaultConfig(receiverPath)` and `requiredSessionCapabilities(config)`.
- **Callbacks you implement:** `SdkStateBlobStore`, `SdkPubkySessionProvider` and `SdkPaymentAdapter`.
- **Public and private resolution are separate.** There is **no implicit fallback** between them.
- **Key strings:** methods accept raw z32 or `pubky...`; returned records use `pubky...`. Convert with `normalizePubkyPublicKey`, `rawPubkyPublicKey` and `redactedPubkyPublicKey` (see [public-key string formats](concepts.md#public-key-string-formats)).
- **iOS:** SwiftPM `Package.swift` at tag `v0.1.0-rc55`, with a `Paykit.xcframework.zip` release asset. Requires iOS 15 / macOS 12.
- **No React Native.** `paykit-react-native` was removed and `@synonymdev/react-native-paykit` returns 404 on npm, so don't suggest either.

Native app work belongs to the **`pubky-mobile`** skill; for details, see the [`paykit-ffi` README](https://github.com/pubky/paykit-rs/blob/main/paykit-ffi/README.md).

---

## Upstream sources of truth

- **pubky-noise** ([github.com/pubky/pubky-noise](https://github.com/pubky/pubky-noise)):
  - [crate README](https://github.com/pubky/pubky-noise/blob/main/pubky-noise/README.md)
  - [e2e tests](https://github.com/pubky/pubky-noise/tree/main/e2e)
  - [crates.io/crates/pubky-noise](https://crates.io/crates/pubky-noise)
- **paykit** ([github.com/pubky/paykit-rs](https://github.com/pubky/paykit-rs)):
  - [root README](https://github.com/pubky/paykit-rs/blob/main/README.md)
  - [`paykit-lib/README.md`](https://github.com/pubky/paykit-rs/blob/main/paykit-lib/README.md)
  - [`paykit-sdk/README.md`](https://github.com/pubky/paykit-rs/blob/main/paykit-sdk/README.md)
  - [`paykit-ffi/README.md`](https://github.com/pubky/paykit-rs/blob/main/paykit-ffi/README.md)
  - [`THESAURUS.md`](https://github.com/pubky/paykit-rs/blob/main/THESAURUS.md)
  - [`specs/payment-endpoint-identifier.md`](https://github.com/pubky/paykit-rs/blob/main/specs/payment-endpoint-identifier.md)
  - [`specs/payment-requests.md`](https://github.com/pubky/paykit-rs/blob/main/specs/payment-requests.md)
  - [`CHANGELOG.md`](https://github.com/pubky/paykit-rs/blob/main/CHANGELOG.md)
- **Guardrails this file relies on:**
  - [`shipped-vs-planned.md`](shipped-vs-planned.md)
  - [`concepts.md`](concepts.md)
  - [`sdk-rust.md`](sdk-rust.md) (core `pubky` version)
