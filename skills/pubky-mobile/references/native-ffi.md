# Native FFI (`pubky-core-ffi`)

`pubky-core-ffi` is the **UniFFI** crate that wraps the `pubky` SDK and emits Swift, Kotlin,
and Python bindings ("Pubky Core Mobile SDK"). Use it directly when you are not on React
Native; `@synonymdev/react-native-pubky` is a thin JS layer over the **same** exports (see
[`./react-native.md`](./react-native.md)).

This page covers what differs from the web/server SDK: the per-platform build, how Swift/Kotlin
consume the artifacts, the **String Contracts**, the `[error, data]` response convention, the
`<z32>:<cookie>` session-secret format, and the **mandatory Android rustls init** at startup.
For the underlying protocol model — identity, `pubky://` addressing, PKARR, the homeserver
model, and the write-vs-Nexus-read split — do **not** re-read it here; see the canonical `pubky`
references:

- Identity / keypairs: [`../../pubky/references/concepts.md#identity-the-ed25519-keypair`](../../pubky/references/concepts.md#identity-the-ed25519-keypair)
- Public-key string formats (`z32()` vs `toString()`): [`../../pubky/references/concepts.md#public-key-string-formats`](../../pubky/references/concepts.md#public-key-string-formats)
- Addressing / `/pub` tree, PKARR, homeserver, write-vs-Nexus-read: [`../../pubky/references/concepts.md`](../../pubky/references/concepts.md)
- `pubkyauth` flow, capabilities, signup tokens, sessions: [`../../pubky/references/auth.md`](../../pubky/references/auth.md)
- On-wire data contract (`pubky-app-specs`): [`../../pubky/references/app-specs.md`](../../pubky/references/app-specs.md)

**Upstream (authoritative — summarize, don't mirror):**
[pubky-core-ffi](https://github.com/pubky/pubky-core-ffi) (README = String Contracts + iOS/Android
integration), the build scripts
[`build_ios.sh`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/build_ios.sh) /
[`build_android.sh`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/build_android.sh),
[`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/src/lib.rs) (the
exported function signatures), and
[`src/rustls_init.rs`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/src/rustls_init.rs)
(Android TLS init). The wrapped crate is [`pubky` 0.9.3](https://docs.rs/pubky/0.9.3); binding
generation is [UniFFI](https://mozilla.github.io/uniffi-rs/). When a signature here looks stale,
trust `src/lib.rs` at the version you built. This page is anchored on commit `782d6c0c842c`.

## The crate

`pubkycore` **v0.3.1**, edition 2021 — a UniFFI library (`crate_type = ["cdylib"]`,
`name = "pubkycore"`), bindings generated with **uniffi 0.25.3** (`cli` feature). It wraps
`pubky = 0.9.3`, `reqwest 0.12` (`default-features=false, features=["rustls-tls"]`), and
`bip39 2.2.0` for mnemonics. Source of truth:
[`Cargo.toml`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/Cargo.toml).

> **Pre-1.0, output formats are a contract.** The string formats below are depended on by
> `react-native-pubky`, Pubky Ring, and Bitkit. Do **not** reshape FFI output to "clean it up" —
> coordinate a migration first.

## Building the bindings

`./build.sh` dispatches per platform; `all` runs iOS → Android → Python.

```bash
# Build bindings
./build.sh ios       # iOS only
./build.sh android   # Android only
./build.sh python    # Python only
./build.sh all       # all three

# Run tests (must be single-threaded: shared global client/runtime state)
cargo test -- --test-threads=1
```

The `--test-threads=1` is **required**: the crate keeps process-global statics (a single
`NETWORK_CLIENT`, one shared Tokio runtime, and a single `AUTH_FLOW` slot — see
[Auth-flow singleton](#pubkyauth-functions)), so parallel tests collide.

### iOS — `build_ios.sh`

Sets `IPHONEOS_DEPLOYMENT_TARGET=13.4`, temporarily adds `staticlib` to `crate_type`, builds for
`aarch64-apple-ios-sim` and `aarch64-apple-ios`, generates Swift bindings, renames the modulemap,
and assembles an XCFramework.

```bash
export IPHONEOS_DEPLOYMENT_TARGET=13.4
sed -i '' 's/crate_type = .*/crate_type = ["cdylib", "staticlib"]/' Cargo.toml
cargo build --release
rustup target add aarch64-apple-ios-sim aarch64-apple-ios
cargo build --release --target=aarch64-apple-ios-sim
cargo build --release --target=aarch64-apple-ios
cargo run --bin uniffi-bindgen generate \
    --library ./target/release/libpubkycore.dylib \
    --language swift --out-dir ./bindings/ios
mv bindings/ios/pubkycoreFFI.modulemap bindings/ios/module.modulemap
xcodebuild -create-xcframework \
    -library ./target/aarch64-apple-ios-sim/release/libpubkycore.a -headers bindings/ios/ios-arm64-sim/Headers \
    -library ./target/aarch64-apple-ios/release/libpubkycore.a -headers bindings/ios/ios-arm64/Headers \
    -output bindings/ios/PubkyCore.xcframework
```

Artifacts: `bindings/ios/PubkyCore.xcframework` + `bindings/ios/pubkycore.swift`.

> **Apple-silicon simulators only.** The XCFramework ships exactly two slices — `ios-arm64`
> (device) and `ios-arm64-simulator`. There is **no `x86_64` simulator slice**, so it will not
> link in an Intel-Mac simulator. Each slice carries `libpubkycore.a` + a `Headers/` dir
> (`pubkycoreFFI.h` + `module.modulemap`).

**Consume (iOS):** drag `PubkyCore.xcframework` into Xcode (check *Copy items if needed*, add to
the target), add `pubkycore.swift`, then `import PubkyCore`. **No runtime init is needed** on
iOS/macOS — TLS uses Apple's Security.framework.

### Android — `build_android.sh`

Keeps `crate_type = ["cdylib"]`, builds `.so` per ABI with `cargo ndk`, then generates Kotlin.

```bash
cargo install cargo-ndk   # if not present
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
cargo ndk -o ./bindings/android/jniLibs --manifest-path ./Cargo.toml \
    -t armeabi-v7a -t arm64-v8a -t x86 -t x86_64 \
    build --release
cargo run --bin uniffi-bindgen generate \
    --library ./target/release/libpubkycore.dylib \
    --language kotlin --out-dir "$TMP_DIR"
# pubkycore.kt is then moved to bindings/android/
```

Artifacts: `bindings/android/jniLibs/{armeabi-v7a,arm64-v8a,x86,x86_64}/libpubkycore.so` +
`bindings/android/pubkycore.kt` (Kotlin package `uniffi.pubkycore`).

**Consume (Android):** copy `jniLibs/*` into `app/src/main/jniLibs`, copy `pubkycore.kt` into a
source dir, load with `System.loadLibrary("pubkycore")` — **then do the rustls init below.** The
README's Android example stops at `loadLibrary` and does **not** show the init step; skipping it
makes the first TLS call panic.

## MANDATORY: initialize rustls on Android

```kotlin
package uniffi.pubkycore

import android.content.Context

object RustlsInit {
    external fun initPlatformVerifier(context: Context)
}

// At app startup (e.g. Application.onCreate), after the native lib is loaded:
System.loadLibrary("pubkycore")
RustlsInit.initPlatformVerifier(applicationContext)  // REQUIRED before any TLS call on Android
```

> **Why this exists.** pkarr's relay HTTP client (pulled in transitively via reqwest's `rustls`
> feature) uses [`rustls-platform-verifier`](https://github.com/rustls/rustls-platform-verifier),
> which on Android must be handed the JVM + app `Context` **once, before any TLS handshake**, or
> the first verification panics with `Expect rustls-platform-verifier to be initialized`. Because
> the UniFFI bindings load the `.so` via JNA, `JNI_OnLoad` never fires, so the JVM can't be
> captured automatically — the app **must** call the init explicitly. Init is idempotent
> (`OnceCell`-backed). iOS/macOS need nothing (Security.framework).

How it wires up: the crate exports a **plain JNI symbol** (not a UniFFI export) in
[`src/rustls_init.rs`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/src/rustls_init.rs):

```rust
#[no_mangle]
pub extern "system" fn Java_uniffi_pubkycore_RustlsInit_initPlatformVerifier(/* env, _class, context */) { /* … */ }
```

By JNI name mangling this binds to a Kotlin `object RustlsInit` in package `uniffi.pubkycore`
exposing `external fun initPlatformVerifier(context: Context)`. **That object is NOT in the
autogenerated `pubkycore.kt`** — you (or your wrapper, e.g. `react-native-pubky`) must declare it
yourself, exactly as shown above. The Kotlin snippet is derived from the symbol name + source
comments; verify against a real consumer (Pubky Ring / react-native-pubky) before shipping
verbatim.

The Android-only deps (`rustls-platform-verifier 0.7.0`, `jni 0.22.4`) are **version-pinned** so
the verifier's `GLOBAL` static is one instance across the dependency graph. As of `pubky` 0.9.3
the SDK's own ICANN client no longer uses the platform verifier (pubky-core#456), but pkarr's
relay client still does — so this init stays required until pkarr#262 lands, after which
`rustls_init.rs` and the Android-only deps can be removed. (FFI-side tracking:
[pubky-core-ffi PR #24](https://github.com/pubky/pubky-core-ffi/pull/24).)

## The `[error, data]` convention

Every exported function returns a **`Vec<String>` of exactly two elements**, built by
`create_response_vector`:

```rust
pub fn create_response_vector(error: bool, data: String) -> Vec<String> {
    vec![error.to_string(), data]
}
// result[0] == "true"  => failure, result[1] is the error message
// result[0] == "false" => success, result[1] is the data (often JSON)
```

`result[0]` is the **string** `"true"`/`"false"` (not a bool); `result[1]` is the result data or
the error message. UniFFI renders Rust `snake_case` as platform **camelCase**
(`generate_secret_key` → `generateSecretKey`, `sign_up` → `signUp`, `publish_https` →
`publishHttps`, `put_with_session` → `putWithSession`); Swift call sites use named argument
labels (`get(url:)`, `signUp(secretKey:homeserver:signupToken:)`).

**Swift:**

```swift
import PubkyCore

func getContent(url: String) async throws -> String {
    let result = try get(url: url)
    if result[0] == "true" {
        throw NSError(domain: "PubkyError", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: result[1]])
    }
    return result[1]
}

// Network switching
try switchNetwork(useTestnet: true)   // testnet
try switchNetwork(useTestnet: false)  // default
```

**Kotlin:**

```kotlin
// after System.loadLibrary("pubkycore") and RustlsInit.initPlatformVerifier(...)
fun generateNewAccount(): String {
    val result = generateSecretKey()
    if (result[0] == "true") {
        throw Exception(result[1])
    }
    val json = JSONObject(result[1])
    return json.getString("secret_key")
}

switchNetwork(true)   // testnet
switchNetwork(false)  // default
```

## String Contracts

Four output contracts, relied upon downstream — treat as fixed:

| Contract | Rule |
| :-- | :-- |
| Public keys | always **bare z-base-32** (52 chars, **no prefix**) in every output |
| `uri` fields | pkarr URI form `pk:<z32>` |
| Response vectors | `[error, data]`, `error` is the string `"true"`/`"false"` |
| Session secrets | `<z32-pubkey>:<cookie>` |

**Public-key output uses `.z32()`, never `.to_string()`.** `pubky` 0.9.x renders
`PublicKey::to_string()` as `pubky<z32>` (with the `pubky` prefix), which pubky's own storage-URL
parser rejects (`pubky://pubky<z32>/…` is invalid) and downstream apps reject — so the FFI
deliberately emits bare z32 at every output site (`public_key` fields, the session `pubky` field,
`get_homeserver` return, `publish`/`publish_https` returns). This matches the canonical rule in
[concepts.md → public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).
**Inputs** accept either form (bare z32 *or* `pubky`-prefixed).

## Session-secret format

A session is persisted as the opaque string **`<z32-pubkey>:<cookie>`** — bare z32 user key, a
colon, then the homeserver session cookie. Produced by `session.export_secret()`, re-imported by
`PubkySession::import_secret(&secret, Some(http_client))`. It is the handle you store and pass to
`put_with_session`, `delete_with_session`, `sign_out`, and `revalidate_session`. (README notes it
is bidirectionally compatible with sessions created on pubky 0.6.0-rc.6.)

`sign_up` / `sign_in` / `await_auth_approval` / `revalidate_session` return session JSON in
`result[1]`, built by `session_to_json_with_secret`:

```rust
pub fn session_to_json_with_secret(session: &PubkySession, session_secret: &str) -> String {
    let info = session.info();
    let json_obj = json!({
        "pubky": info.public_key().z32(),
        "capabilities": info.capabilities().iter().map(|c| c.to_string()).collect::<Vec<String>>(),
        "session_secret": session_secret,
    });
    serde_json::to_string(&json_obj).unwrap_or_else(|e| format!("Failed to serialize JSON: {}", e))
}
```

## Exported function surface

Names are Rust `snake_case` (call sites are camelCase). Authoritative signatures live in
[`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/src/lib.rs) — trust it
over this summary. All functions follow the `[error, data]` convention above.

### Identity & keys (sync)

| Fn | Returns (`result[1]`) |
| :-- | :-- |
| `generate_secret_key()` | JSON `{secret_key(hex), public_key(z32), uri(pk:z32)}` |
| `get_public_key_from_secret_key(secret_key)` | JSON `{public_key, uri}` |
| `generate_mnemonic_phrase()` | 12-word BIP39 English |
| `mnemonic_phrase_to_keypair(mnemonic_phrase)` | keypair JSON |
| `generate_mnemonic_phrase_and_keypair()` | mnemonic + keypair |
| `validate_mnemonic_phrase(mnemonic_phrase)` | `"true"`/`"false"` |
| `create_recovery_file(secret_key, passphrase)` | base64 recovery file |
| `decrypt_recovery_file(recovery_file, passphrase)` | secret_key |

Secret keys are 32-byte ed25519, **hex-encoded**.

### Homeserver & session

`switch_network(use_testnet: bool)` is **synchronous** — it just swaps the global
`Mutex<Arc<Pubky>>` client (testnet vs default), no I/O. The rest are async, run on the shared
Tokio runtime via `block_on`:

- `get_signup_token(homeserver_pubky, admin_password)` — GETs
  `https://{homeserver_pubky}/admin/generate_signup_token` with an `X-Admin-Password` header
- `sign_up(secret_key, homeserver, signup_token: Option<String>)` → session JSON
- `sign_in(secret_key)` → session JSON
- `sign_out(session_secret)`
- `revalidate_session(session_secret)` → session JSON, or error if expired/invalidated
- `get_homeserver(pubky)` → homeserver z32
- `republish_homeserver(secret_key, homeserver)`

### Storage

| Fn | Auth | Notes |
| :-- | :-- | :-- |
| `get(url)` | none (public read) | uses `client.public_storage()` |
| `list(url)` | none (public read) | JSON array of `pubky://` URLs; forces a trailing `/` |
| `put(url, content, secret_key)` | signs in per call (legacy) | returns the trimmed URL on success |
| `delete_file(url, secret_key)` | signs in per call (legacy) | — |
| `put_with_session(url, content, session_secret)` | reuses session | preferred after a Ring auth flow |
| `delete_with_session(url, session_secret)` | reuses session | — |

All URL-taking write/get/delete fns **require `/pub/` in the URL** and operate on the substring
from `/pub/` onward; otherwise they error `Invalid URL: must contain /pub/`.

> **Binary reads are base64-tagged.** `get(url)` returns the body as a UTF-8 string in
> `result[1]` when valid; if the bytes are **not** valid UTF-8 (binary content) it returns the
> base64 of the body **prefixed with `base64:`** (i.e. `"base64:<…>"`). Consumers must detect the
> `base64:` prefix and decode.

### `pubkyauth` functions

For the full handshake/capabilities model see [`../../pubky/references/auth.md`](../../pubky/references/auth.md)
and the mobile-specific [`./ring-auth.md`](./ring-auth.md).

**Authenticator side** (the app holding the key, e.g. Pubky Ring):

- `parse_auth_url(url)` → JSON `{relay, capabilities, secret, kind("signin"|"signup"), homeserver?, signup_token?}`
- `auth(url, secret_key)` — approves a third-party request via `signer.approve_auth(&url)`

**Requester side** (the app asking for authorization):

- `start_auth_flow(capabilities_str)` → returns the `pubkyauth://` authorization URL, stashes the flow
- `await_auth_approval()` → blocks until approved, consumes the stashed flow, returns session JSON

> **One auth flow at a time.** `start_auth_flow`/`await_auth_approval` share a single
> process-global `static AUTH_FLOW: Lazy<Mutex<Option<PubkyAuthFlow>>>`. `await_auth_approval`
> `take()`s the stored flow (errors `No auth flow in progress` if none); starting a second flow
> **overwrites** the first. The flow is built with `AuthFlowKind::SignIn`.

`parse_auth_url` parsing rules (see
[`src/auth.rs`](https://github.com/pubky/pubky-core-ffi/blob/782d6c0c842c/src/auth.rs)): scheme
must be `pubkyauth`; the **intent is in the host position** — `pubkyauth://signin?…` → `"signin"`,
`pubkyauth://signup?…` → `"signup"`, legacy `pubkyauth:///?…` (no host) → `"signin"`; any other
host is rejected. It reads `relay` (required), `secret` (required), `capabilities` (or legacy
`caps`, comma-separated `path:permission`), and for signup links `hs` → homeserver (bare z32) and
`st` → signup_token (both optional, omitted from JSON when empty).

### pkarr / DNS

- `publish(record_name, record_content, secret_key)` — TXT record (TTL 30s) → author public key (z32)
- `publish_https(record_name, target, secret_key)` — HTTPS/SVCB record (TTL 3600s) → public key (z32)
- `resolve(public_key)` → JSON of the full signed packet (hex/base64 fields, records)
- `resolve_https(public_key)` → JSON of the HTTPS records only

All accept bare-z32 or `pubky`-prefixed key inputs.

## `EventListener` is a placeholder, not a real stream

`set_event_listener` / `remove_event_listener` (callback interface) are wired to an internal loop
that merely emits the string `"Internal event triggered"` every 2 seconds (started by
`generate_secret_key`). It is a **demo/placeholder, not a homeserver event subscription** — do
not present it as one. For real event streams, use the homeserver event endpoints documented in
the `pubky-infra` skill.

## Shipped-vs-planned guardrail

The FFI exposes only what is **shipped**: public `/pub` storage (no `/priv`), capability-scoped
sessions, PKARR identity/discovery, resumable `pubkyauth`, and local recovery-file
create/decrypt. It does **not** expose any planned items (private storage, mirroring, backup
restore) — do not present those as available. See
[`../../pubky/references/shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md).
