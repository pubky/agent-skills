# Advanced: E2E messaging (`pubky-noise`) and payments (`paykit`)

Use this file to decide when to reach for two **external, pre-1.0** crates built on Pubky. `pubky-noise` provides end-to-end encrypted peer-to-peer messaging. `paykit` provides payment discovery and exchange across apps. Neither crate is part of the core `pubky` SDK. This file is a pointer: check exact signatures in the [upstream READMEs and docs.rs](#upstream-sources-of-truth) before you write code. For the shared model (identity, homeserver, `/pub` addressing, public-key string formats), see [`concepts.md`](concepts.md).

## Status and guardrails (read first)

- **Versions (checked 2026-11-12):**
  - **`pubky-noise` 0.1.0** is on crates.io (2026-10-16): `pubky-noise = "0.1.0"`. All `0.1.0-rc*` releases are superseded.
  - **`paykit-lib` 0.1.0 and `paykit-sdk` 0.1.0** are on crates.io (2026-10-16): `paykit-lib = "0.1.0"`. Upstream `master` is at `0.1.1-rc8` (`paykit-lib`, `paykit-sdk`, `paykit-ffi`, `paykit-react-native`). The newest tag is `v0.1.1-rc1`, and nothing newer than 0.1.0 is on crates.io. READMEs on `master` can describe API that 0.1.0 doesn't have. For your version, trust [docs.rs/paykit-lib/0.1.0](https://docs.rs/paykit-lib/0.1.0).
  - Both crates are pre-1.0. paykit's `SECURITY.md` says only the final 0.1.0 release and `master` get security fixes. **Don't pin a `0.1.0-rc*`, because those are no longer patched.**
- **Both crates need `pubky = "0.16.2"`.** `pubky-noise` 0.1.0, `paykit-lib` 0.1.0 and `paykit-sdk` 0.1.0 all depend on `pubky ^0.16.2`. See [`sdk-rust.md`](sdk-rust.md). If a signature there disagrees, use [docs.rs/pubky/0.16.2](https://docs.rs/pubky/0.16.2).
- **Don't add a second `pubky-noise` version.** `paykit-lib` pins `pubky-noise = "=0.1.0"` and re-exports it as `paykit_lib::pubky_noise`. A second version makes Cargo build two copies whose types don't mix.
- **Neither crate adds private or encrypted homeserver storage.** All data sits under ordinary **public `/pub`** paths. `pubky-noise` never uses `/priv`: it reads peers through public storage, so its paths must be under `/pub`.
  - The only confidentiality is the **ciphertext each client produces itself**.
  - Paths are hard to link to a pair of users **only** when you use `derive_asymmetric_paths` with `new_with_paths`.
  - See [`shipped-vs-planned.md`](shipped-vs-planned.md#no-private-encrypted-or-guarded-storage) and [App-side ciphertext is your own crypto](shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto).
- **"Backup/restore" here means state local to the crate.** In `pubky-noise` it is a Noise session snapshot. In `paykit-sdk` it is SDK state over a transport your app owns. **Neither is Pubky Backup restore or homeserver mirroring**, which are both still planned ([`shipped-vs-planned.md`](shipped-vs-planned.md#backup-restore-and-mirroring)).
- **Paykit shared state needs a specific homeserver setup:** at least **Homeserver 0.16.2**, with **GCS storage on every serving instance**. Filesystem storage doesn't give the shared-state guarantee.
  - Paykit doesn't check the server version or storage backend. Neither the client version nor the `webdav-locks` feature proves the server is compatible.
  - Recovering shared state on a homeserver the user picked and you haven't verified is unsupported.
  - Operators: see the `pubky-infra` skill.
- **Snippet status:** every Rust snippet below is copied verbatim from an upstream README. Each was **last run 2026-11-12** against the published crates (pubky-noise 0.1.0, paykit-lib/paykit-sdk 0.1.0, pubky 0.16.2) on a local Pubky testnet (`Pubky::testnet()`). None is CI-verified. For maintained runnable code, see pubky-noise [`e2e/`](https://github.com/pubky/pubky-noise/tree/master/e2e).

## When to reach for which

| You need | Use |
| :-- | :-- |
| E2E-encrypted messages between two Pubky users, with no payment meaning | `pubky-noise` directly |
| To discover where an identity can **receive** payment, and to exchange Payment Requests, Payment Proofs, receipts and Allowances across apps | `paykit` |
| Stateless Rust helpers, where you own sessions, keys, persistence, lifecycle and dedupe | `paykit-lib` |
| A stateful runtime for endpoint sync, Encrypted Link state, private stream intake, Payment Request and Allowance lifecycle, receipts, Profiles, Contact Records and SDK backup | `paykit-sdk` |
| iOS or Android payments (Swift/Kotlin) | `paykit-ffi`, the UniFFI bindings and main mobile integration surface. Native work belongs to the **`pubky-mobile`** skill ([`native-ffi.md`](../../pubky-mobile/references/native-ffi.md)). |
| React Native payments | `@synonymdev/react-native-paykit` (`paykit-react-native`), generated from the same UniFFI metadata. **Not on npm yet** (see [Mobile bindings](#mobile-bindings-paykit-ffi-paykit-react-native)). RN work belongs to the **`pubky-mobile`** skill ([`react-native.md`](../../pubky-mobile/references/react-native.md)). |
| Agent guidance for SDK and mobile workflows and link recovery | Upstream's maintained skill, [`skills/paykit/SKILL.md`](https://github.com/pubky/paykit-rs/tree/master/skills/paykit) (`$paykit`). Use the version that matches your SDK. |

A paykit Encrypted Link **is** a `pubky-noise` `XX` session.

---

## `pubky-noise`: E2E messaging

**Outbox model.** Each peer **writes** Noise messages to its **own** homeserver and **reads** from the peer's homeserver.

- Each direction's path holds numbered **slots**, and the slot number goes up by one per message.
- During the handshake, reads and writes share one slot counter. After `transition_transport()`, that counter becomes the transport base slot, and each direction then keeps its own counter.
- Noise (snow) transport nonces are tracked separately from slots.

**Crypto and wire format**

- **Suite:** `Noise_{pattern}_25519_ChaChaPoly_SHA256` (X25519, ChaCha20-Poly1305, SHA-256). The transport is stateless, with an explicit nonce on each message.
- **Patterns:** only **`NN`** (no authentication) and **`XX`** (mutual authentication) are implemented. `N`, `IK` and `NK` are declared but return `UnsupportedNoisePattern`. Unknown names return `UnknownNoisePattern`.
- **Every stored packet is 1018 bytes, whatever the body length.**
  - Handshake packet: `[len_hi, len_lo, ciphertext..., zero padding...]`.
  - Transport packet: `NoiseAEAD([body_len_hi, body_len_lo, body..., zero padding...])`. The body length sits **inside** the AEAD.
  - The body is at most **1000 bytes** (`PUBKY_NOISE_MSG_LEN`). The other constants are `PUBKY_NOISE_TAG_LEN = 16`, `PUBKY_NOISE_CIPHERTEXT_LEN = 1016` and `PUBKY_NOISE_TRANSPORT_PACKET_LEN = 1018`.

**Core types and signatures (0.1.0)**

- `PubkyNoiseConfig::new(pubky_root_seckey: [u8;32], pubky_noise_version: u32, pattern_string: &str, homeserver_auth_session: PubkySession, destination_path: String, outbox_client: Pubky) -> Result<Arc<Self>, PubkyNoiseError>` uses one path for both directions.
- `PubkyNoiseConfig::new_with_paths(..., write_path: String, read_path: String, outbox_client: Pubky)` takes a separate path for each direction. Use it with path derivation. Several encryptors can share one `Arc<PubkyNoiseConfig>`.
- `PubkyNoiseEncryptor::new(config: Arc<PubkyNoiseConfig>, holder_skey: [u8;32], initiator: bool, endpoint_pubkey: PublicKey) -> Result<Self, PubkyNoiseError>` creates one session with one peer.
  - `holder_skey` is the **local static secret key**, not a per-session ephemeral key.
  - **Zeroize your own copy.** `[u8;32]` is `Copy`, so `new` receives a copy, and wiping that copy never wipes yours. Hold yours in something like `zeroize::Zeroizing`.
  - In the **published 0.1.0 crate**, `new` overwrites its copy only with a plain `copy_from_slice`. The crate has no `zeroize` dependency, and the code carries a TODO. Upstream `master` (unreleased, still versioned 0.1.0) adds `zeroize` and wraps its internal copy in `Zeroizing`. Neither version wipes the caller's copy.
- `LinkId` is 32 bytes derived from the handshake hash. It's available after `transition_transport()`.
- `PubkyNoiseSessionState` is a serializable snapshot that **includes secret keys** and the incoming handshake messages. `PreparedSend` and `PreparedReceive` are staged transport results.
- **`PubkyNoiseError` implements only `Debug`, `Eq`, `Hash` and `PartialEq`.** It has no `Display` and no `std::error::Error`. So `?` into `anyhow::Result` or `Box<dyn Error>` doesn't compile. Define your own error type with `From<PubkyNoiseError>`.

**Authenticate the peer yourself.** Noise `XX` proves the peer holds the key it presented. It does **not** bind that key to a Pubky identity.

- Before you use a completed or restored session, compare `remote_static_public_key() -> Option<&[u8]>` with an X25519 key you authenticated some other way.
- `remote_static_public_key()` returns `None` until the handshake completes, and for patterns with no remote static key.
- `pubky_noise::derive_static_public_key(&[u8;32]) -> [u8;32]` gives the X25519 public key for a static secret passed to `PubkyNoiseEncryptor::new`. It does **not** convert an Ed25519 key.

**Handshake.** `handle_handshake()` is polling-safe: either side can call it repeatedly, in any order. It returns `HandshakeResult::Pending`, without changing state, until the peer's message exists, and then `Terminal`. **Sleep or back off between polls**, because each call reads from the homeserver.

- Handshake reads treat only HTTP **404/410** as "not there yet" (`Pending`). Transport reads treat only **404** as absent.
- Any other non-success status returns `HomeserverHttpError { status }`.
- A read that fails with no status, or a 2xx with a bad body, returns `HomeserverResponseError`.
- A failed read doesn't move its cursor.

**Set timeouts.** `pubky` 0.16.2 turns native HTTP timeouts off by default, and Noise adds no timeout or retry of its own.

- **Native:** set a total `PubkyHttpClientBuilder::request_timeout` before you read from peers, and before you create the session that reads snapshots. `read_timeout` resets on each read, so it doesn't replace the total timeout.
- **Browser/WASM:** add your own deadline and cancellation to each operation.
- Cancelling a write doesn't prove the homeserver rejected it.

**Path derivation (use it for unlinkable paths).** `pubky_noise::path_derivation::derive_asymmetric_paths(local_secret_key: &[u8;32], remote_pubkey: &PublicKey, domain: &[u8], base_path: &str) -> (String, String)` returns `(write_path, read_path)`. Pass both to `new_with_paths`.

- Each path is `{base_path}/{hex(SHA-256(domain || dh_secret || pk))}`. `pk` is your own Ed25519 public key for the write path and the peer's for the read path.
- `dh_secret` is X25519 over the two Ed25519 keys converted to Montgomery form, so **Alice's `write_path` equals Bob's `read_path`**.
- The final segment is **64 hex characters**, not z-base-32.
- The README example uses the base `/pub/paykit.app/v0/private`, which is **not** paykit's prefix. Paykit uses `/pub/paykit/v0/private`.

### Sending and receiving: use the staged API

**Don't use `send_message()` or `retry_pending_send()`.** Both are `#[deprecated]`, and their recovery state lives only in memory, so a crash loses it.

1. **Send.** `prepare_send(&mut self, plaintext: &[u8]) -> Result<PreparedSend, _>` returns a value with `destination_path()`, `ciphertext()` and `resulting_session_state()`.
   - Save the ciphertext and resulting state as **one outbound record** in a single atomic write, then call `acknowledge_persisted_send(prepared)`.
   - Publish records **in order**. If you don't know whether a write succeeded, retry it with the **exact stored ciphertext**.
2. **Receive.** `next_receive_path() -> Result<String, _>` does no I/O. Fetch that path yourself, then call `prepare_receive(&mut self, ciphertext: &[u8]) -> Result<PreparedReceive, _>`, which is synchronous. Save the new state in the same write as your app's processing result, then call `acknowledge_persisted_receive(prepared)`.
3. **If saving fails,** drop the encryptor and restore the last saved state. You can't cancel a staged operation while the encryptor is still in use.
4. **None of these calls confirm that the peer received anything.**
5. **With several processes,** let only one prepare at a time, and make state updates conditional on the state you read. The staged APIs have no authentication, authorization, credential management or locking across processes.
6. While a staged operation is unacknowledged, `snapshot()` and `persist_snapshot()` return `UnacknowledgedPreparedTransport`. **Don't use `persist_snapshot()` to commit a staged operation.**
7. `receive_message() -> Result<Vec<Vec<u8>>, _>` remains for callers that don't need atomic processing.

**Durable handshake.** `prepare_handshake_step(self, incoming_packet: Option<&[u8]>) -> Result<PreparedHandshakeStep, PubkyNoiseError>` prepares one `NN` or `XX` step with no network I/O. It **consumes the encryptor, even when it fails**.

- Call `snapshot.next_handshake_read_slot()`, which returns `Result<Option<u32>, SerializerError>`.
  - `Ok(Some(slot))`: fetch the peer's packet at that slot and pass `Some(packet)`. On 404/410, wait instead of preparing.
  - `Ok(None)`: pass `None`.
- Before you publish, save the returned snapshot, the exact outgoing packet and its path in one atomic write.
- Don't enter transport until the final `XX` packet is saved and acknowledged.
- `MissingHandshakePacket` or `UnexpectedHandshakePacket` means the input was wrong. The encryptor is already gone, so recover from your previous saved checkpoint.

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
    match initiator.handle_handshake().await? {
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

<sub>pubky-noise crate README Quick Start (`rust,no_run`), copied unchanged from `17aed35`. The snippet text is the same at `2439e9e`. Last run 2026-11-12 against crates.io pubky-noise 0.1.0 and pubky 0.16.2 on a local testnet, with an `XX` responder running at the same time. Both sides got the same `LinkId`, the responder decrypted `b"Hello, peer!"`, and the responder's `remote_static_public_key()` equalled `derive_static_public_key(holder_skey)`. Not CI-verified. You write `persistent_store` and `ordered_publisher`. Problems in the upstream text:
(1) The comment `ephemeral_secret_key // per-session key` is wrong. This argument is the local **static** key.
(2) The loop busy-polls `Pending` and finishes only if the peer runs at the same time. Add a sleep or backoff.
(3) The fixed `/pub/data` path doesn't get the unlinkability that `derive_asymmetric_paths` gives.
(4) It never checks `remote_static_public_key()` against an authenticated key.
(5) Don't copy the `.unwrap()` calls into library code. The `?` calls compile only in a function that returns your own error type with `From<PubkyNoiseError>`, not `anyhow::Result`.
(6) `clippy -D warnings` flags the unused `Arc` import and `while_let_loop`.</sub>

### Session snapshots and encrypted backup

**Snapshot format.** Snapshots are versioned (format 1), and their length varies between `MIN_SESSION_STATE_LEN` and `MAX_SESSION_STATE_LEN`, so don't assume a fixed size. A snapshot holds the ephemeral and static secret keys and up to two incoming handshake messages. For the byte layout, see [README Snapshot Format](https://github.com/pubky/pubky-noise/blob/master/pubky-noise/README.md#snapshot-format). Don't hard-code it.

**Restore does no network I/O.** A snapshot keeps the incoming handshake messages and rebuilds the outgoing ones in memory from the saved ephemeral seed. While replaying them, restore checks authentication and the saved transcript hash or `LinkId`. Deleting or replacing old handshake files on a homeserver does **not** invalidate a saved transcript or revoke a session.

| Call (0.1.0) | What it does |
| :-- | :-- |
| `persist_snapshot(&self, backup_key: &[u8;32], generation: u64)` | Encrypts the snapshot and uploads it to `{write_path}/backup`. A failed homeserver write becomes `OtherError`. |
| `PubkyNoiseEncryptor::load_snapshot(config: &PubkyNoiseConfig, backup_key: &[u8;32], min_generation: Option<u64>) -> Result<LoadedSnapshot, _>` | Returns `LoadedSnapshot { generation, state }`. |
| `PubkyNoiseEncryptor::restore(config: Arc<PubkyNoiseConfig>, state, endpoint_pubkey: PublicKey).await -> Result<Self, _>` | Rebuilds the session. `endpoint_pubkey` must match `state.endpoint_pubkey`. |
| `backup_crypto::derive_backup_key(root_secret: &[u8;32]) -> [u8;32]` | Returns SHA-256(`"pubky-noise/session-backup/v0"` \|\| root_secret). Delegated apps without the root secret supply their own 32-byte key. |

- **Envelope:** XChaCha20Poly1305 with a random 192-bit nonce. The AAD includes `{write_path}/backup`, so a backup from another path can't be swapped in. For the byte layout, see the [README](https://github.com/pubky/pubky-noise/blob/master/pubky-noise/README.md#encrypted-homeserver-backup).
- **Read limits:** a HEAD/stats check rejects a missing or oversized backup before the GET, and the body read is capped at `MAX_BACKUP_RESPONSE_BYTES`.
- **Metadata leaks:** the snapshot's length isn't hidden. The homeserver sees the size and upload timing, which can reveal the pattern, the role or how far the session has got. `write_path` is under `/pub`, so **anyone can read the ciphertext**.

**The snapshot holds secret keys.**

- Encrypt and authenticate it at rest. If you store snapshots yourself, you can use `backup_crypto::encrypt_backup_with_key(backup_key, backup_path, generation, &snapshot)`.
- Let only processes authorized for the same identity read it.
- Make old snapshots unrecoverable once a newer one replaces them, because their ephemeral keys can expose that session's messages.
- Never log decrypted plaintext.

**Rollback protection is your job.** Restoring stale state **reuses keys and nonces**, which breaks both confidentiality and authentication. Keep a trusted checkpoint: the highest snapshot generation you have accepted.

1. Give each new snapshot a **strictly higher** `generation`. `load_snapshot` accepts a generation **equal** to the checkpoint, so it won't flag a reused one.
2. Advance the trusted local checkpoint **before** `persist_snapshot()`, or in the same atomic step.
3. After `load_snapshot()`, save `loaded.generation` as the checkpoint **before** the restored session does anything.
4. Keep the checkpoint in trusted storage that can't be rolled back. **Never keep it next to the backup on the same homeserver.**
5. With `min_generation = None` (for example on a fresh device), a rollback can't be detected. Unless you know the checkpoint is fresh, throw the restored state away and start a new Noise session.

A backup older than the checkpoint fails with `RestoreBackupRollbackError`.

```rust
use pubky_noise::backup_crypto;

// `save_checkpoint`/`load_checkpoint` are caller-side trusted local storage:
// they must durably persist and return the generation (e.g. on disk).

// Obtain the 32-byte backup key. Apps with access to the Pubky root secret
// can derive it via `derive_backup_key()`; delegated apps that do not hold
// the root secret may supply their own key instead (e.g. derived from a
// shared Noise/state key).
let backup_key = backup_crypto::derive_backup_key(&root_secret);

// Encrypt and upload the snapshot to the homeserver. `generation` is a
// caller-managed counter that must be *strictly* higher for each new
// snapshot (equality with the checkpoint is accepted on load, so a reused
// generation would not be flagged as a rollback).
let generation = local_checkpoint.map_or(1, |checkpoint| checkpoint + 1);

// IMPORTANT: advance your trusted local checkpoint to `generation` *before*
// (or atomically with) this call -- see "Rollback protection" below.
save_checkpoint(generation)?;
encryptor.persist_snapshot(&backup_key, generation).await?;

// Later (e.g. after a crash or on another device): fetch, decrypt and restore.
// Reload the checkpoint (it may have advanced since this process cached it):
// passing a stale or missing checkpoint would weaken rollback detection.
let local_checkpoint = load_checkpoint();
let loaded = PubkyNoiseEncryptor::load_snapshot(&config, &backup_key, local_checkpoint).await?;

// The accepted generation may be higher than your checkpoint; record it as
// the new checkpoint *before* the restored session resumes activity.
// Otherwise a crash could leave the old checkpoint in place, letting a
// stale homeserver replay an older backup and reuse counters or nonces.
save_checkpoint(loaded.generation)?;

let mut restored = PubkyNoiseEncryptor::restore(config, loaded.state, peer_pubkey).await?;
// (`peer_pubkey` is the remote peer you were talking to; it is also stored
//  in `loaded.state.endpoint_pubkey` and can be reconstructed from it via pkarr.)
```

<sub>pubky-noise crate README encrypted backup (`rust,ignore`), copied unchanged from `17aed35`. Last run 2026-11-12 against crates.io pubky-noise 0.1.0 and pubky 0.16.2 on a local testnet, after a completed `XX` handshake. Persist, load and restore passed twice. The `LinkId` was preserved, the checkpoint went from 1 to 2, and the peer decrypted a message sent after the restore. A load with a stale `min_generation` failed with `RestoreBackupRollbackError`. Not CI-verified. This is a fragment:
(1) It imports only `backup_crypto`. Add `use pubky_noise::PubkyNoiseEncryptor;`.
(2) `encryptor`, `config`, `root_secret`, `local_checkpoint` and `peer_pubkey` come from your code. `save_checkpoint` and `load_checkpoint` are your trusted storage.
(3) The `?` calls need your own error type with `From<PubkyNoiseError>`.
(4) After `restore`, check `remote_static_public_key()` before you use the session.</sub>

### Handshake write failures and errors

**If `handle_handshake()` returns `Err(HomeserverWriteError)`, the encryptor is corrupted.** The internal snow state has already advanced and can't go back. To recover:

1. Clone the result of `last_good_snapshot() -> Option<&PubkyNoiseSessionState>`. The crate captures it at the start of each `handle_handshake()` call, so it is `None` before the first call.
2. Drop the encryptor.
3. Call `PubkyNoiseEncryptor::restore(config, snapshot, endpoint_pubkey)`, which makes no homeserver writes, and retry `handle_handshake()` on the next poll.

The upstream [code example](https://github.com/pubky/pubky-noise/blob/master/pubky-noise/README.md#code-example) wraps these steps in `handshake_with_recovery`. It calls `.expect(...)` on the snapshot, so don't copy it unchanged into library code.

**Lost writes are different.** If a write succeeded but the server later lost the data, `handle_handshake()` returns `Ok(Pending)` forever. To recover, you need a checkpoint saved **before** the lost write. Keep that checkpoint until the peer's progress confirms the write arrived.

**Errors.** The full list is in the [README error-handling section](https://github.com/pubky/pubky-noise/blob/master/pubky-noise/README.md#error-handling). These ones need specific handling:

| Error | What to do |
| :-- | :-- |
| `CounterOverflow`, `NonceOverflow` | Start a new Noise session. |
| `HomeserverWriteError` | Restore from `last_good_snapshot()` (see above). |
| `HomeserverHttpError { status }` | Inspect `status` and apply your own retry policy. **Treat 408, 429 and 5xx as neither bad ciphertext nor non-retryable.** |
| `HomeserverResponseError` | A read failed with no status, a 2xx had a bad body, or a snapshot was over its size cap. Fix the cause before you retry. |
| `UnacknowledgedPreparedTransport`, `NoPreparedTransport`, `PreparedTransportMismatch` | The staged API was called in the wrong order. Fix the call sequence. |
| `MissingHandshakePacket`, `UnexpectedHandshakePacket` | `prepare_handshake_step` already consumed the encryptor. Recover from the previous checkpoint and follow its `next_handshake_read_slot()`. |
| `UnknownNoisePattern`, `UnsupportedNoisePattern` | Use `NN` or `XX`. |
| `RestoreBackupReplayError`, `RestoreBackupHashMismatch`, `RestoreBackupDeserializeError`, `RestoreBackupDecryptError`, `RestoreBackupRollbackError`, `RestoreBackupNotFoundError` | The restore failed; see the snapshot section above. `RestoreBackupHashMismatch` has no `Error` suffix. |

**Testing.**

- The `test-utils` feature turns on `test_enable_tampering`, `test_enable_write_failure` and `test_last_ciphertext`.
- Unit tests: `cargo nextest run -p pubky-noise`.
- End-to-end examples are maintained in [`e2e/src/tests/pubky_noise.rs`](https://github.com/pubky/pubky-noise/tree/master/e2e). Run them with `cargo nextest run -p e2e`. This needs Docker for the Testcontainers PostgreSQL database, and it starts testnets in-process.

---

## `paykit`: cross-app payments

**Paykit is a meta payment protocol and doesn't move money.** It covers discovery (where an identity can receive payment) and exchange (Payment Requests, Payment Proofs, receipts, Receipt Access, Allowances). It doesn't choose the final payment endpoint. Your wallet, processor or app keeps control of:

- running payments, business rules and endpoint choice,
- local storage and key rotation,
- recurring-payment scheduling and timeouts.

`paykit-sdk` derives each Payment Request's lifecycle state from the shared private event stream and the outbound queue. [`THESAURUS.md`](https://github.com/pubky/paykit-rs/blob/master/THESAURUS.md) defines the terms.

**Crate split**

- **`paykit-lib`** is the stateless Rust library. It works directly on Pubky SDK handles and keeps no global state. It and its bindings do **not**:
  - run payments or choose endpoints,
  - manage recurring or lifecycle state, or run a background service,
  - fetch profiles or contacts,
  - create sessions, or manage scopes, key rotation or recovery.
- **`paykit-sdk`** is the stateful runtime. Build it with `PaykitSdk::new(storage, pubky, payment, config)`, which takes:
  - a `StorageAdapter` (atomic transactions over the state that all of the identity's apps share),
  - a `PubkySessionProvider`,
  - a `PaymentAdapter`,
  - a config from `PaykitSdkConfig::new(app_id) -> Result<_>`.

  Then call `sdk.initialize().await`. The returned status has a `capability` field, for example `PubkyIdentityCapability::PrivateLinkCapable`.
- **App processes that share one identity must share durable SDK state.** The first-party `PubkySharedStateStorage` keeps it encrypted at `/pub/paykit/v0/shared-state.bin`, behind a WebDAV write lock that it renews. It needs the homeserver described in [Status and guardrails](#status-and-guardrails-read-first).
- **SDK backup and restore use a transport your app owns.** This is not Pubky Backup.
- `PubkySessionBootstrap::republish_identity(&PublicKey) -> Result<bool>` republishes an already-signed identity record without changing it. It needs no secret key or restored session. Your app owns scheduling, throttling, retries and timeouts for it. The FFI name is `republishIdentity(publicKey)` in Swift, Kotlin and React Native. For return values and limits, see the [`paykit-ffi` README](https://github.com/pubky/paykit-rs/blob/master/paykit-ffi/README.md#pubky-session-bootstrap).

```rust
use paykit_sdk::{PaykitSdk, PaykitSdkConfig};

let config = PaykitSdkConfig::new("bitkit")?;
let sdk = PaykitSdk::new(storage, pubky, payment, config);
let status = sdk.initialize().await?;

if status.capability == paykit_sdk::PubkyIdentityCapability::PrivateLinkCapable {
    // Private workflows also require current signed Noise key authorization.
}
```

<sub>paykit-sdk README typical startup (`rust,no_run`). The README hides wrapper lines rustdoc-style, and they're left out here: `async fn example<S, K, P>(storage: S, pubky: K, payment: P) -> paykit_sdk::Result<()>` where `S: StorageAdapter`, `K: PubkySessionProvider`, `P: PaymentAdapter`. Upstream doesn't run it as a doctest. Last run 2026-11-12 against crates.io paykit-sdk 0.1.0 and pubky 0.16.2 on a local testnet, with in-memory storage and a fresh testnet user. `initialize()` returned `PrivateLinkCapable`. Not CI-verified.</sub>

### Storage layout (app-scoped)

**rc55's receiver-path model is gone.** `PaykitReceiverPath`, `{app}/{wallet|server}`, the `receiver.json` Receiver Marker and `list_paykit_receiver_paths` were all removed. Data is now grouped by **Paykit App ID** and listed in one App Registry per identity.

| Data | Path (constant) |
| :-- | :-- |
| Prefix | `/pub/paykit/v0/` (`PAYKIT_PATH_PREFIX`, **now with a trailing slash**) |
| App Registry | `/pub/paykit/v0/app-registry.json` (`PAYKIT_APP_REGISTRY_PATH`) |
| Public Payment Endpoint | `/pub/paykit/v0/apps/{app_id}/endpoints/{payment_endpoint_identifier}` |
| Noise key authorization | `/pub/paykit-authority/v0/current-key.json` (`PAYKIT_NOISE_KEY_AUTHORIZATION_PATH`) |
| SDK shared state | `/pub/paykit/v0/shared-state.bin` (`PAYKIT_SHARED_STATE_PATH`). Writes go under `/pub/paykit/v0/shared-state-writes/`. |
| Private message base | `/pub/paykit/v0/private` (`PAYKIT_PRIVATE_PATH_PREFIX`) |
| Encrypted Receipts | `/pub/paykit/v0/private/receipts/{ReceiptId}` (no app segment) |
| Link recovery | `/pub/paykit/v0/encrypted-link-recovery` (`PAYKIT_ENCRYPTED_LINK_RECOVERY_PATH_PREFIX`) |

- **`private` is only part of the path name.** Everything above sits under **public `/pub`**.
- **The `/pub` layout isn't stable yet** (see [`concepts.md`](concepts.md#addressing-and-the-pub-tree)). Use the exported constants instead of hard-coding paths.
- The **App Registry** lists the participating apps and their coarse capabilities, the identity's single Noise public key and its key generation, and optional default-app preferences. Its limits are 64 KiB, 64 apps and 256 per-endpoint default-app entries.

**Validated types.** Their constructors return an error on invalid input.

- **`PaykitAppId::new(value: impl Into<String>) -> Result<Self>`**
  - Rules: non-empty, at most 64 bytes, not `.` or `..`, and only lowercase ASCII letters, digits and `-`. It rejects `Bitkit` and `bitkit/wallet`.
  - An App ID marks which app owns an endpoint or sent a private message. It creates no separate identity or Encrypted Link, and it gives **no cryptographic isolation** between authorized apps that share keys.
- **`PaymentEndpointIdentifier::new(id) -> Result<Self>`**
  - Rules: 1–64 characters from `[A-Za-z0-9_.-]`. It rejects other characters (such as `/`, NUL or a space), all-dot values and the reserved value `private` with `PaykitError::Validation`.
  - The naming convention `{asset}-{rail}-{endpoint_format}` (for example `btc-lightning-bolt11`, `btc-bitcoin-p2tr` or `eur-sepa-iban`) is recommended but **not enforced**. See [`specs/payment-endpoint-identifier.md`](https://github.com/pubky/paykit-rs/blob/master/specs/payment-endpoint-identifier.md).
- **`PaymentEndpointPayload`** is opaque UTF-8, with `new`, `as_str` and `into_inner`. `PaymentList.payment_endpoints` is a `HashMap<PaymentEndpointIdentifier, PaymentEndpointPayload>`.

### Public Payment Endpoints

**Flow**

1. The payee creates its payment endpoints.
2. The payee registers the publishing app in the App Registry with `create_paykit_app_registry` or `update_paykit_app_registry` and `PaykitAppRegistry::register_app`.
3. The payee writes each endpoint payload under that App ID and shares its Pubky public key.
4. The payer reads the registry with `get_paykit_app_registry` or `get_paykit_app_registry_with_revision`, picks an App ID, then reads that app's endpoints. To help pick the app, use `preferred_app_for_endpoint`, `set_default_app` and `set_default_app_for_endpoint`.

**Signatures.** Writes take `&pubky::PubkySession`, reads take `&pubky::PublicStorage`, and every call takes `&PaykitAppId`.

- `set_payment_endpoint(session, app_id, identifier: PaymentEndpointIdentifier, payload: PaymentEndpointPayload) -> Result<()>`.
- `remove_payment_endpoint(session, app_id, identifier) -> Result<()>`. Removing a missing endpoint still succeeds, so retries are safe.
- `get_payment_list(storage, payee: &PublicKey, app_id) -> Result<PaymentList>` returns an empty list when nothing is published.
- `get_payment_endpoint(storage, payee, app_id, identifier: &PaymentEndpointIdentifier) -> Result<Option<PaymentEndpointPayload>>`.
- Also exported: `get_payment_list_with_limits`, `get_payment_list_with_budget`, `update_payment_endpoint` and `remove_payment_endpoint_if_revision`.

**Errors.** `PaykitError` has four variants: `Transport { context, source: anyhow::Error }`, `NotFound(String)`, `InvalidData { context, source: Option<anyhow::Error> }` and `Validation(String)`. `paykit_lib::Result<T>` is `std::result::Result<T, PaykitError>`. **Paykit sets no deadlines**, so configure `PubkyHttpClient::builder().request_timeout(..)` yourself.

```rust
use paykit_lib::{
    set_payment_endpoint, get_payment_endpoint, get_payment_list,
    PaykitAppId, PaymentEndpointIdentifier, PaymentEndpointPayload,
};

// Create validated types.
let app_id = PaykitAppId::new("bitkit")?;
let identifier = PaymentEndpointIdentifier::new("btc-lightning-bolt11")?;
let payload = PaymentEndpointPayload::new("lnbc1...");

// Store a Payment Endpoint using an authenticated PubkySession.
set_payment_endpoint(&session, &app_id, identifier.clone(), payload).await?;

// Read it back using pubky::PublicStorage.
if let Some(endpoint) = get_payment_endpoint(&public_storage, &payee_pubkey, &app_id, &identifier).await? {
    println!("{}", endpoint.as_str());
}

// List all Payment Endpoints published by this app for a payee.
let payment_list = get_payment_list(&public_storage, &payee_pubkey, &app_id).await?;
for (identifier, payload) in &payment_list.payment_endpoints {
    println!("{}: {}", identifier.as_str(), payload.as_str());
}
```

<sub>paykit-lib README Quick Start (`rust,no_run`). Upstream compiles it as a doctest. Its hidden wrapper is left out here: `async fn example(session: pubky::PubkySession, public_storage: pubky::PublicStorage, payee_pubkey: pubky::PublicKey) -> paykit_lib::Result<()>`. Last run 2026-11-12 against crates.io paykit-lib 0.1.0 and pubky 0.16.2 on a local testnet. The write-then-read round trip worked, and the list had exactly one entry. Not CI-verified here. The snippet skips the App Registry step, so a real payee must register `app_id` first.</sub>

**Gotchas**

- **`get_payment_list` is a best-effort snapshot.** It lists the directory and then fetches each file, and public storage has no atomic reads. If a payment fails because an endpoint was used up, expired or changed, re-fetch it with `get_payment_endpoint`, compare the payload, and apply your own retry policy.
- **Public lists are public.** Anyone with the payee's key can read them. Don't publish reused payloads or payloads that link payments together. When an Encrypted Link exists, prefer the latest Private Payment List.

### Encrypted Link (private channel)

**One Noise key per identity.** There is one Encrypted Link per counterparty identity, shared by every app under that identity.

- **Key derivation:** `derive_paykit_noise_secret_key(&[u8;32]) -> [u8;32]` computes `blake3::derive_key("paykit/noise", paykit_identity_secret)`. `derive_paykit_noise_public_key(&[u8;32]) -> PublicKey` gives the matching public key.
- **The App Registry entry doesn't prove the Noise key is authorized.** The identity signs a `PaykitNoiseKeyAuthorization` at `/pub/paykit-authority/v0/current-key.json`. `get_paykit_noise_key_authorization` checks its signature and owner.
- **With the low-level API, pin peers.** Before you use a new or restored link, match the routing keys and `remote_static_public_key()` against the signed record. This is the paykit form of the [peer-authentication check](#pubky-noise-e2e-messaging) above.
- **Session capabilities** are constants in `paykit-sdk`, not `paykit-lib`:
  - Authorizer: `PAYKIT_AUTHORIZER_SESSION_CAPABILITIES` = `/pub/paykit/:rw,/pub/paykit-authority/v0/current-key.json:rw`.
  - Ordinary apps: only `PAYKIT_SESSION_CAPABILITIES` = `/pub/paykit/:rw`. **Never give an ordinary app write access to the authority path.**
  - To request capabilities, see [`auth.md`](auth.md).

**Private paths** are built with `pubky-noise` path derivation:

- The domain is `paykit-path-v0` followed by the two 32-byte Pubky identity keys, sorted by bytes.
- The Noise DH secret is still part of the hash. The base path is `PAYKIT_PRIVATE_PATH_PREFIX`, and `pubky-noise` names the slot files.
- Copying another identity's advertised Noise key doesn't give you its stream.
- All apps under one identity share one pair of paths.
- Recovery markers use the domain `paykit-link-recovery-v0`.

**Handshake.** The constructors are synchronous, take 6 arguments and take no receiver paths.

- `initiate_encrypted_link(session: pubky::PubkySession, sender_secret_key: [u8;32], receiver_identity_public_key: &PublicKey, receiver_noise_public_key: &PublicKey, recovery_context: EncryptedLinkRecoveryContext, outbox_client: pubky::Pubky) -> Result<EncryptedLinkHandshake>`.
- `accept_encrypted_link(session, receiver_secret_key, sender_identity_public_key, sender_noise_public_key, recovery_context, outbox_client)` has the same shape.
- **Key separation:** pass the **local Paykit Noise secret** from `derive_paykit_noise_secret_key(...)` as `sender_secret_key` or `receiver_secret_key`. **Never pass the Pubky identity root key.** The README calls this argument `sender_noise_secret_key`.
- `*_noise_public_key` is the peer's authorized routing key, taken from its signed `PaykitNoiseKeyAuthorization`.
- `EncryptedLinkRecoveryContext::new(local_attempt_id: Option<&str>, remote_attempt_id: Option<&str>) -> Result<Self>` takes UUID-v4 IDs and implements `Default`. Both peers use the same pair of IDs in opposite order.
- **Roles:** `paykit-sdk` decides which side initiates by comparing the two Pubky public keys. With `paykit-lib`, you agree on roles and IDs yourself.
- **Drive the handshake** with `advance_handshake(handshake: EncryptedLinkHandshake) -> std::result::Result<HandshakeProgress, HandshakeAdvanceError>`, which is polling-safe. It returns `Pending(handle)` or `Complete(EncryptedLink)`.
  - It recovers from `HomeserverWriteError` by itself, up to `DEFAULT_MAX_RECOVERY_ATTEMPTS` (3) times. Change the limit with `EncryptedLinkHandshake::set_max_recovery_attempts`. The counter resets after each successful step.
  - Failed HTTP reads and bad response bodies are real errors. `HandshakeAdvanceError::error()` borrows the underlying `PaykitError`.
  - `into_parts()` returns the error plus an optional boxed handshake. You get the handshake back only when a transport read failed and left it unchanged. That doesn't mean the error is transient or that you should retry.
  - `HandshakeAdvanceError` implements `From<PaykitError>`.

```rust
use std::time::{Duration, Instant};
use paykit_lib::{advance_handshake, HandshakeAdvanceError, HandshakeProgress, EncryptedLinkHandshake};

async fn poll_with_timeout(mut handshake: EncryptedLinkHandshake) -> Result<paykit_lib::EncryptedLink, HandshakeAdvanceError> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if Instant::now() > deadline {
            return Err(paykit_lib::PaykitError::Transport {
                context: "handshake timed out".into(),
                source: anyhow::anyhow!("deadline exceeded"),
            }
            .into());
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

<sub>paykit-lib README handshake polling (`rust,ignore`), copied unchanged. It passes `clippy -D warnings` as is. Last run 2026-11-12 against crates.io paykit-lib 0.1.0 and pubky 0.16.2 on a local testnet:
(1) Two peers set up with `initiate_encrypted_link` and `accept_encrypted_link` both reached `Complete` in under 1 s. Their keys came from `derive_paykit_noise_secret_key`, and their recovery contexts were mirror images.
(2) A signed-up peer that never answered produced a `Transport` "handshake timed out" error after about 60 s, with no retry handle.
(3) If the peer has never signed up, so its homeserver can't be resolved, `?` returns early (after about 7 s) with `HomeserverResponseError` and a retry handle, not the timeout.
Not CI-verified. It needs `anyhow` and `tokio` (with the `time` feature) as direct dependencies.</sub>

**Snapshot and restore.** These calls take no receiver paths either.

- **After a restart:** `restore_encrypted_link(session, secret_key, remote_identity_public_key, outbox_client, snapshot) -> Result<EncryptedLink>`.
- **In the same process:** `restore_encrypted_link_from_config(config, remote_identity_public_key, snapshot)`.
- **During the handshake:** `restore_encrypted_link_handshake(...)` and `restore_encrypted_link_handshake_from_config(...)` have the same argument shape, but they take an `EncryptedLinkHandshakeSnapshot`, not an `EncryptedLinkSnapshot`.
- `EncryptedLink::snapshot()` and `serialize()` return `Result`. They fail while a prepared send is unacknowledged.
- An `EncryptedLinkSnapshot` holds the Noise state, the counterparty's 32-byte Noise public key and a 72-byte recovery context. Read the first two with `recipient()` and `remote_noise_public_key()`. Restore checks that the config paths match the identity pair and the Noise keys.
- Close a link with `close_encrypted_link(link) -> Result<()>`.
- **Snapshot bytes are secrets.** Encrypt them at rest, and never send them to logs or telemetry.

**Send failures.** After `DEFAULT_MAX_SEND_RETRIES` (3) failed attempts, sends, receives and snapshots all fail until `EncryptedLink::retry_pending_send()` republishes the packet it kept. `set_max_send_retries` changes the limit, which goes back to the default after a restore.

**After a failed send, never restore an older snapshot and never send different plaintext from it.** The failed write may have reached the homeserver, so either action **reuses the transport key and nonce**. The only safe options are to republish the kept packet or to set up a new link.

### Private messages, Payment Requests, Allowances, receipts

**All Private Application Messages with one counterparty share one ordered, encrypted stream.** Each message carries the sending app's `app_id`.

- `EncryptedLink::receive_private_application_messages()` returns raw messages in the order they were sent, malformed JSON included.
- Route messages with `message.known_kind()` / `PrivateMessageKind`. Parse them with the stateless parsers: `parse_private_payment_list_json`, `parse_payment_request_event_message`, `parse_allowance_event_message` and `parse_receipt_access_event_message`.

| Kind | How to treat it |
| :-- | :-- |
| Private Payment List | **Keep the latest one per Paykit App.** A newer valid list replaces an older one from the **same app** only, and a newer malformed list replaces nothing. `set_private_payment_list(link: &mut EncryptedLink, list: &PrivatePaymentList) -> Result<()>` sends the **complete** list each time, and its JSON must fit in **1000 bytes** (`PUBKY_NOISE_MSG_LEN`). |
| Payment Request, Allowance and Receipt Access messages | These are **Event Messages**, and every valid one matters. **Dedupe them by `event_id`.** |

**Durability**

- **Use the staged APIs for durable send and receive.**
  - Send:
    1. Call `EncryptedLink::prepare_private_application_message_json`.
    2. Save the exact ciphertext and the resulting snapshot together.
    3. Acknowledge.
    4. Call `publish_prepared_private_application_message`.
  - Receive:
    1. Call `prepare_next_private_application_message`.
    2. Save the plaintext result and the snapshot together.
    3. Call `acknowledge_persisted_private_receive`.
  - The direct stateless send helpers remain as convenience APIs.
  - These steps are correct for 0.1.0. Upstream `master` (unreleased) also requires a write-slot check (`prepared_private_send_slot` / `skip_published_write_slots`) before each staged publish. That API doesn't exist in 0.1.0 or `v0.1.1-rc1`.
- **Save events before you checkpoint.** The link snapshot is your read checkpoint. Save raw events and whether you've handled them **before** you save a snapshot whose read counter has moved past them. Otherwise, expect replays.
- **Make outbound events idempotent.** Save the JSON from `serialize_payment_request_event(app_id, event)` before you send it. On retry, reuse the same `event_id` and payload.
- **v0.2 private wire messages are strict JSON.** Unknown fields are rejected, except in Payment Request metadata, the Payment Proof `proof` field and Receipt Metadata.

**Payment Requests.** Every call takes `app_id`:

- `send_payment_request(link, app_id, &PaymentRequest)`.
- `send_payment_request_acceptance`, `send_payment_request_rejection` and `send_payment_request_cancellation`, each with `(link, app_id, ..)`.
- `send_payment_proof(link, app_id, &PaymentProof)` and `send_payment_conversion_quote(link, app_id, quote)`.

`PaymentProof::validate_for_request(&request) -> Result<()>` is **stateless and shallow**.

- It checks the request ID, the payment reference, the billing period (present and well-formed), the accepted endpoint identifier, the conversion selection and the shape of method-specific proof fields.
- It does **not** verify that the payment happened (no settlement or on-chain check), and it does no lifecycle checks.
- To check a conversion quote, use `PaymentProof::validate_conversion_quote(&request, quote)`.
- A Subscription is just an accepted Recurring Payment Request. Paykit doesn't run periodic payments for you.

For details, see [`specs/payment-requests.md`](https://github.com/pubky/paykit-rs/blob/master/specs/payment-requests.md) and [`specs/payment-conversion.md`](https://github.com/pubky/paykit-rs/blob/master/specs/payment-conversion.md).

**Allowances.** An Allowance is a limited permission an Allower shares with an Allowee, so that the Allowee can handle matching Payment Requests automatically.

- Every Allowance needs a **monetary ceiling or an expiry**. Whether to pay automatically is still the wallet's decision, and one payment can't draw on more than one Allowance.
- `paykit-lib` provides:
  - `AllowanceTerms::builder(asset)`,
  - typed lifecycle events (proposal, acceptance, rejection, end),
  - `serialize_allowance_event(app_id: &PaykitAppId, event: &AllowanceEvent) -> Result<String>` and `parse_allowance_event_message`,
  - `send_allowance_proposal`, `send_allowance_acceptance`, `send_allowance_rejection` and `send_allowance_end`.
- `match_allowance_request`, `check_allowance_time` and `evaluate_allowance` are **pure checks, not payment authorization.**
- Durable lifecycle state, usage reservation and Allowance selection belong to `paykit-sdk` or your wallet. See [`specs/allowances.md`](https://github.com/pubky/paykit-rs/blob/master/specs/allowances.md).

**Receipts**

- The plaintext Receipt stays local.
- The Encrypted Receipt is stored on the issuer's homeserver at `/pub/paykit/v0/private/receipts/{ReceiptId}`. It uses XChaCha20Poly1305, with the Receipt Location path as AAD.
- A `ReceiptAccess` message travels over the link. It carries the Event ID, ReceiptId, `payment_reference`, an optional `payment_request_id` and billing period, the Receipt Location and the symmetric Receipt Decryption Key.

To issue and read a receipt:

1. The issuer calls `prepare_receipt(link, draft)` and **saves** the result.
2. The issuer calls `store_prepared_receipt(session, &prepared)`.
3. The issuer calls `send_receipt_access(link, app_id, &access)`. Each of steps 1–3 can be retried.
4. The receiver parses the access message with `parse_receipt_access_event_message` or `parse_receipt_access_json`. It then fetches the Encrypted Receipt and calls `decrypt_receipt(encrypted_json, key, location)`.

**Never log the raw `ReceiptDecryptionKey::as_str()`.** Keep it only in the platform's secure storage.

### Mobile bindings (`paykit-ffi`, `paykit-react-native`)

`paykit-ffi` provides the UniFFI Swift/Kotlin bindings and is the main mobile and app integration surface. `paykit-react-native` is the React Native package `@synonymdev/react-native-paykit`. It is generated from the same UniFFI metadata with `uniffi-bindgen-react-native`.

- `Package.swift` is at the repo root.
- Build Swift/Kotlin with `cd paykit-ffi && ./build.sh all`, which writes the iOS XCFramework to `paykit-ffi/dist/ios`.
- **`build.sh all` doesn't build React Native.** The RN package builds separately with `cd paykit-react-native && npm run build:native`, which is for repo development only, not for consuming the package in an app. A React Native CI workflow regenerates and type-checks it on every FFI change.
- Native and RN app work belongs to the **`pubky-mobile`** skill ([`native-ffi.md`](../../pubky-mobile/references/native-ffi.md), [`react-native.md`](../../pubky-mobile/references/react-native.md)).
- For the binding API, read the [`paykit-ffi` README](https://github.com/pubky/paykit-rs/blob/master/paykit-ffi/README.md), the [`paykit-react-native` README](https://github.com/pubky/paykit-rs/blob/master/paykit-react-native/README.md) and upstream's [`$paykit` skill](https://github.com/pubky/paykit-rs/tree/master/skills/paykit), not this file.

**React Native package: not installable yet.**

- **`@synonymdev/react-native-paykit` is not on npm.** The registry returned 404 on 2026-11-12. The package appears only under the CHANGELOG `[Unreleased]` section, not in 0.1.0 or 0.1.1-rc1. **Don't tell users to `npm install` it** until it's published. After that, release candidates go out under the npm `next` tag (`@synonymdev/react-native-paykit@next`) and finals under `latest`.
- **It isn't the old package.** An older CHANGELOG entry says the unmaintained `paykit-react-native` package was removed and that only Swift and Kotlin were supported. The current package is a new reintroduction generated by `uniffi-bindgen-react-native`. Ignore guidance written for the removed package.
- **Requirements (pointer-level; the full list is in its README):**
  - New Architecture (TurboModules/JSI) only, with Hermes.
  - React Native 0.78+ / Expo SDK 54+, iOS 15.1+ and Android API 24+.
  - Android is 64-bit only (`arm64-v8a`, `x86_64`), and the iOS simulator slice is `arm64` only.
  - Expo Go can't load it, so use a dev build.
- **Don't add `com.synonym:paykit-android` alongside it.** Both ship the same classes and `libpaykit.so`, which causes duplicate-class failures.
- **TypeScript names keep the `Ffi` prefix** (`FfiPaykitSdk`, `FfiSdkStateBlobStore`), unlike the Swift/Kotlin names.

**React Native security gotchas** (details in the README's [Security section](https://github.com/pubky/paykit-rs/blob/master/paykit-react-native/README.md#security)):

- **`FfiSdkStateBlobStore` callbacks are synchronous.** Don't return Promises, and don't call back into the same `FfiPaykitSdk` handle from inside them.
- **The store must be synchronous, encrypted and atomic,** with a revision compare-and-swap: `saveStateBlobAtomically(blob, expectedRevision)` throws `PaykitFfiError.ConcurrentUpdate` on a stale revision. AsyncStorage can't implement this.
- **Exported SDK state blob bytes enter the JS heap and can't be zeroized.** To keep state out of JS entirely, use the `FfiPaykitSdk.withPubkySharedState*` constructors.
- **`exportBytes()` on `FfiPubkyLocalSecretKey`, `FfiPaykitIdentitySecretKey` and `FfiSdkBackupBlob` puts key material on the JS heap.** Avoid calling it where you can.
- **TypeScript records aren't redacted.** Never `console.log` sensitive `Ffi*` records or send them to error reporting or telemetry.

---

## Upstream sources of truth

- **pubky-noise** ([github.com/pubky/pubky-noise](https://github.com/pubky/pubky-noise)):
  - [crate README](https://github.com/pubky/pubky-noise/blob/master/pubky-noise/README.md). Master is ahead of 0.1.0 (zeroization, HTTP status wording, snapshot size ceiling), so check docs.rs for your version.
  - [docs.rs/pubky-noise/0.1.0](https://docs.rs/pubky-noise/0.1.0)
  - [e2e tests](https://github.com/pubky/pubky-noise/tree/master/e2e)
- **paykit** ([github.com/pubky/paykit-rs](https://github.com/pubky/paykit-rs)):
  - [root README](https://github.com/pubky/paykit-rs/blob/master/README.md), including [Homeserver Requirements](https://github.com/pubky/paykit-rs#homeserver-requirements), and [`SECURITY.md`](https://github.com/pubky/paykit-rs/blob/master/SECURITY.md)
  - [`paykit-lib/README.md`](https://github.com/pubky/paykit-rs/blob/master/paykit-lib/README.md) and [docs.rs/paykit-lib/0.1.0](https://docs.rs/paykit-lib/0.1.0)
  - [`paykit-sdk/README.md`](https://github.com/pubky/paykit-rs/blob/master/paykit-sdk/README.md)
  - [`paykit-ffi/README.md`](https://github.com/pubky/paykit-rs/blob/master/paykit-ffi/README.md)
  - [`paykit-react-native/README.md`](https://github.com/pubky/paykit-rs/blob/master/paykit-react-native/README.md) (`@synonymdev/react-native-paykit`, not yet on npm)
  - [`skills/paykit`](https://github.com/pubky/paykit-rs/tree/master/skills/paykit) (upstream's agent skill)
  - [`THESAURUS.md`](https://github.com/pubky/paykit-rs/blob/master/THESAURUS.md) and [`CHANGELOG.md`](https://github.com/pubky/paykit-rs/blob/master/CHANGELOG.md)
  - [`specs/`](https://github.com/pubky/paykit-rs/tree/master/specs): `payment-endpoint-identifier.md`, `payment-requests.md`, `allowances.md`, `payment-conversion.md`, `paykit-sdk.md`
- **Guardrails this file relies on:**
  - [`shipped-vs-planned.md`](shipped-vs-planned.md)
  - [`concepts.md`](concepts.md)
  - [`sdk-rust.md`](sdk-rust.md), for the core `pubky` crate (0.16.2, which these crates require)
