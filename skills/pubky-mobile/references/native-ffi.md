# Native FFI (`pubky-core-ffi`)

`pubky-core-ffi` is the **UniFFI** crate that wraps the `pubky` Rust SDK and generates Swift, Kotlin
and Python bindings. Use it directly for native iOS/Android apps. `react-native-pubky` wraps the
same exports ([`./react-native.md`](./react-native.md)). Ring deeplinks and the authenticator role
are in [`./ring-auth.md`](./ring-auth.md).

This page covers only FFI-specific material. For the protocol model, follow these links:

- Identity / keypairs: [`concepts.md#identity-the-ed25519-keypair`](../../pubky/references/concepts.md#identity-the-ed25519-keypair)
- `z32()` vs `toString()`: [`concepts.md#public-key-string-formats`](../../pubky/references/concepts.md#public-key-string-formats)
- `pubkyauth` handshake, capabilities, relays, signup tokens, persisting sessions: [`auth.md`](../../pubky/references/auth.md)
- Shipped vs planned: [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)

**Upstream (authoritative):** [pubky-core-ffi](https://github.com/pubky/pubky-core-ffi)
(its README holds the String Contracts), [`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/src/lib.rs)
(exported signatures), [`src/rustls_init.rs`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/src/rustls_init.rs),
the wrapped [`pubky` 0.10.0](https://docs.rs/pubky/0.10.0), and [UniFFI](https://mozilla.github.io/uniffi-rs/).
This page is anchored on commit [`74fea50702cd`](https://github.com/pubky/pubky-core-ffi/commit/74fea50702cd331c3c0a1e60fc02978d0588c396)
("upgrade pubky bindings to 0.10"). The repo has **no tags or releases**, so pin a commit. If a
signature here disagrees with `src/lib.rs` at the commit you built, `src/lib.rs` wins.

> **Status.** The knowledge base lists the iOS/Android SDKs as **Beta**. As of 2026-09 the crate
> wraps `pubky` 0.10.0, which is two minor versions behind crates.io (0.12.0). Upstream has no
> CI-verified FFI snippets. **The README's Swift/Kotlin examples are stale.** They leave out
> `clientId`, the Android TLS init, the JNA dependency and the verifier JAR. Use this page instead.

## The crate

The crate is `pubkycore` **v0.4.0**, edition 2021, with `crate_type = ["cdylib"]` as committed.
Dependencies: uniffi **0.25.3** (`cli`), `pubky = 0.10.0`, `reqwest 0.12` (`default-features = false`,
`rustls-tls`) and `bip39 2.2.0`. The lockfile also pulls in `reqwest 0.13.4` and `pkarr 7.0.0`
transitively. The Android-only deps `rustls-platform-verifier = "0.7.0"` and `jni = "0.22.4"`
are pinned to the versions `pubky` resolves, which keeps the verifier's `GLOBAL` static a single
instance ([`Cargo.toml`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/Cargo.toml)).

## Building

Build with `./build.sh`. It calls the per-platform scripts, which are the source of truth:
[`build_ios.sh`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/build_ios.sh) and
[`build_android.sh`](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/build_android.sh).
Don't try to rebuild the steps by hand. Partial copies of those scripts fail: `xcodebuild` needs
the per-slice `Headers/` dirs and refuses to overwrite an existing XCFramework, and the Kotlin
step depends on `TMP_DIR=$(mktemp -d)`.

```bash
./build.sh ios       # iOS only
./build.sh android   # Android only
./build.sh python    # Python only
./build.sh all       # ios && android && python

cargo test -- --test-threads=1
```

- **Use `--test-threads=1`.** The README requires it. The likely reason is the crate's
  process-global statics: `NETWORK_CLIENT`, `TOKIO_RUNTIME`, `GRANT_AUTH_FLOW`, `COOKIE_AUTH_FLOW`
  and `EVENT_NOTIFIER`.
- **Tests hit the real network.** Signup tests use the homeserver
  `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` and read the optional
  `PUBKY_TEST_SIGNUP_TOKEN`. If the error contains `Token required`, the test returns early and
  **passes silently**. Any other signup failure fails the test.
- **Build on a macOS host.** The scripts use BSD `sed -i ''`. Both scripts generate bindings
  from `target/release/libpubkycore.dylib`, and `build_android.sh` exits if that file is missing.
- **The scripts change the working tree:**
  - `build_ios.sh` runs `rm -rf bindings/ios/*` and sets `crate_type = ["cdylib", "staticlib"]`.
    After `./build.sh ios`, **revert `Cargo.toml` before committing.** `./build.sh all` resets
    it to `["cdylib"]` during the Android step.
  - `build_android.sh` runs `rm -rf bindings/android/`, which deletes the committed `jniLibs`.
- **What the scripts produce:**
  - iOS: `IPHONEOS_DEPLOYMENT_TARGET=13.4`, targets `aarch64-apple-ios` and
    `aarch64-apple-ios-sim`, output `bindings/ios/PubkyCore.xcframework` and `pubkycore.swift`.
  - Android: `cargo ndk` for `armeabi-v7a`, `arm64-v8a`, `x86` and `x86_64`, output
    `bindings/android/jniLibs/` and `bindings/android/pubkycore.kt`.

## Consuming on iOS

- **Artifacts:** `bindings/ios/PubkyCore.xcframework` and `bindings/ios/pubkycore.swift`.
  1. Drag the XCFramework into Xcode. Check *Copy items if needed* and add it to the target.
  2. Add `pubkycore.swift` to the target.

  CocoaPods: use `s.ios.vendored_frameworks`, with a minimum of iOS 13.4.
- **There are only two slices:** `ios-arm64` (device) and `ios-arm64-simulator`. With **no
  `x86_64` simulator slice**, set `EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64`, as
  react-native-pubky does.
- **Don't write `import PubkyCore`.** The modulemap declares the Clang module `pubkycoreFFI`, and
  `pubkycore.swift` imports it for you. Once that file is in your target, its public functions
  belong to **your own module**, so call `get(url:)` directly.
- **Compile `pubkycore.swift` in Swift 5 language mode.** The generated file does not pass
  Swift 6 strict concurrency (`static var handleMap is not concurrency-safe`).
- **iOS needs no TLS init.** iOS and macOS verify certificates through Security.framework.

## Consuming on Android

1. Copy `bindings/android/jniLibs/{armeabi-v7a,arm64-v8a,x86,x86_64}/libpubkycore.so` into
   `app/src/main/jniLibs/`. Copy `pubkycore.kt` (package `uniffi.pubkycore`) into a source dir.
2. **Add JNA.** The generated Kotlin loads the library with
   `Native.load(findLibraryName("pubkycore"), …)`. To override the lookup, set the system property
   `uniffi.component.pubkycore.libraryOverride`. The README leaves this step out.
3. **Add the rustls-platform-verifier JVM classes** (`org.rustls.platformverifier.*`). Without
   them, certificate verification fails even after init. The component is **not on Maven**
   ([rustls-platform-verifier#115](https://github.com/rustls/rustls-platform-verifier/issues/115)).
   - Find it with `cargo metadata`. The `rustls-platform-verifier-android` crate ships a `maven/`
     dir. The verifier README gives `classes.jar` as an alternative.
   - react-native-pubky vendors it as `libs/rustls-platform-verifier.jar`.
   - With R8/Proguard, add `-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }`.
4. **Add the rustls init (below), and call it before any other `pubkycore` call.**

These are the dependencies from [react-native-pubky's `build.gradle`](https://github.com/pubky/react-native-pubky/blob/bf0b7925314031023db3ae47cdba12e23389c25e/android/build.gradle#L100-L106)
(excerpt). They are Groovy there and work unchanged in the Kotlin DSL. All three resolve.

```groovy
implementation("net.java.dev.jna:jna:5.18.1@aar") // Uniffi
implementation(files("libs/rustls-platform-verifier.jar"))
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
```

## MANDATORY: Android rustls init

On Android, run this before the first network call. Otherwise the first TLS handshake **panics**
with `Expect rustls-platform-verifier to be initialized`. The cause:

- pkarr's relay HTTP client (reqwest 0.13, `rustls`) uses `rustls-platform-verifier`.
- On Android, that verifier needs the JavaVM and the app `Context` once, before any handshake.
- UniFFI loads the `.so` through **JNA**, so `JNI_OnLoad` never runs and nothing can capture the
  VM automatically.
- pubky's own ICANN client stopped using the platform verifier in
  [pubky-homeserver#456](https://github.com/pubky/pubky-homeserver/pull/456). The pkarr relay
  client still uses it, so the init stays required until that changes. The attempted fix,
  [pkarr#262](https://github.com/pubky/pkarr/pull/262), was closed without merging.

The Rust side is a **plain JNI export, not a UniFFI export**. It is compiled only for
`target_os = "android"`, and it **discards the init result**. A failed init therefore does not
report an error here. It shows up later as the original handshake panic. Compiled with
clippy `-D warnings` for `arm64-v8a`. The exported symbol is confirmed.

```rust
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_uniffi_pubkycore_RustlsInit_initPlatformVerifier<'caller>(
    mut env: jni::EnvUnowned<'caller>,
    _class: jni::objects::JClass<'caller>,
    context: jni::objects::JObject<'caller>,
) {
    let _ = env.with_env(|env| -> Result<(), jni::errors::Error> {
        rustls_platform_verifier::android::init_with_env(env, context)
    });
}
```

**`RustlsInit` is NOT in the generated `pubkycore.kt`.** Declare it yourself:

- Put it in package `uniffi.pubkycore` so the JNI name matches.
- Put it **outside** the directory you regenerate, or regeneration deletes it.

The code below comes from react-native-pubky
([`RustlsInit.kt`](https://github.com/pubky/react-native-pubky/blob/bf0b7925314031023db3ae47cdba12e23389c25e/android/src/main/java/com/pubky/RustlsInit.kt)).
The code is verbatim, with comments trimmed, and it compiles.

```kotlin
package uniffi.pubkycore

import android.content.Context

object RustlsInit {
    @JvmStatic
    private external fun initPlatformVerifier(context: Context)

    @Volatile
    private var initialized = false

    @JvmStatic
    @Synchronized
    fun ensure(context: Context) {
        if (initialized) return
        // Bind the JNI symbol in libpubkycore.so. This resolves to the same loaded library
        // that uniffi's JNA layer uses, so the Rust-side rustls-platform-verifier `GLOBAL`
        // is shared. init is idempotent (OnceCell) on the Rust side.
        System.loadLibrary("pubkycore")
        initPlatformVerifier(context.applicationContext)
        initialized = true
    }
}
```

- **Call `RustlsInit.ensure(context)`**, not `initPlatformVerifier`, which is `private` and won't
  compile if called from outside.
- Call it once at startup, before any other `pubkycore` function, for example in
  `Application.onCreate`. react-native-pubky calls it in its module `init`.
- Repeat calls are safe, because the Rust side uses a `OnceCell`.

## Calling conventions

- **Naming:** `snake_case` becomes camelCase (`put_with_session` → `putWithSession`,
  `start_grant_auth_flow` → `startGrantAuthFlow`). Swift adds argument labels:
  `signIn(secretKey:clientId:)`, `startAuthFlow(capabilitiesStr:clientId:)`,
  `putWithSession(url:content:sessionSecret:)`.
- **Every export is sync and non-throwing.** Swift returns `[String]` and Kotlin returns
  `List<String>`. Example: `signUp(secretKey: String, homeserver: String, signupToken: String?, clientId: String)`.
  Drop the README's `try`.
- **Network calls block the calling thread.** Every network export runs
  `TOKIO_RUNTIME.block_on(...)`, and `await*AuthApproval` blocks **until the user approves**.
  **Never call them on the iOS main thread or the Android UI thread.** Wrapping a call in
  `suspend fun` or `async func` does not move the work to another thread.

### The `[error, data]` convention

Compiled. This is identical to upstream `src/utils.rs`.

```rust
pub fn create_response_vector(error: bool, data: String) -> Vec<String> {
    vec![error.to_string(), data]
}
```

- If `result[0]` is the **string** `"true"`, the call **failed** and `result[1]` is the error message.
- If `result[0]` is `"false"`, the call succeeded and `result[1]` holds the data, often JSON.
- Exceptions:
  - `set_event_listener` and `remove_event_listener` return nothing.
  - `validate_mnemonic_phrase` returns `["false", "true"|"false"]`, so **read validity from index 1**.
- Don't copy `bindings/python/README.md`. It checks `result[0] == "success"`, which never matches.

**Kotlin:** move the call to `Dispatchers.IO`, as react-native-pubky does. This is an authored
example that compiles against the generated bindings. It calls `RustlsInit.ensure`, so it is safe
to copy on its own.

```kotlin
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.pubkycore.RustlsInit
import uniffi.pubkycore.get

// Android: RustlsInit.ensure must run before the first TLS handshake (idempotent).
suspend fun getContent(context: Context, url: String): String = withContext(Dispatchers.IO) {
    RustlsInit.ensure(context)
    val result = get(url)
    if (result[0] == "true") throw Exception(result[1])
    result[1]
}
```

**Swift:** this is the README pattern without the `try`, with the blocking call moved to a Dispatch
queue. Long blocks such as `awaitAuthApproval` would otherwise hold a Swift-concurrency pool thread.
This authored example compiles in Swift 5 and 6 modes against the generated `get(url:)`, and both
the success and error paths ran.

```swift
import Foundation

func pubkyCall(_ body: @escaping @Sendable () -> [String]) async throws -> String {
    let result = await withCheckedContinuation { (cont: CheckedContinuation<[String], Never>) in
        DispatchQueue.global(qos: .userInitiated).async { cont.resume(returning: body()) }
    }
    if result[0] == "true" {
        throw NSError(domain: "PubkyError", code: -1, userInfo: [NSLocalizedDescriptionKey: result[1]])
    }
    return result[1]
}

// let body = try await pubkyCall { get(url: url) }
```

## String Contracts

react-native-pubky, Pubky Ring and Bitkit all rely on these. **Don't change the output shape
without a coordinated migration.** The authoritative list is in the
[README](https://github.com/pubky/pubky-core-ffi/blob/74fea50702cd/README.md).

| # | Contract |
| :-- | :-- |
| 1 | Public keys in **every output** are **bare z-base32: 52 chars, no prefix**. This covers `public_key`, the session `pubky` field, `get_homeserver`, and the values returned by `publish`/`publish_https`. Inputs accept bare or `pubky`-prefixed keys. |
| 2 | `uri` fields use the pkarr form `pk:<z32>`. |
| 3 | Responses are `[error, data]`, where `error` is the string `"true"` or `"false"`. |
| 4 | `parse_auth_url` returns `relay`, `capabilities`, `secret` and `kind`. Signup links also return `homeserver` (bare z32) and an optional `signup_token`. |
| 5 | Auth follows pubky 0.10: grant functions return `grant_secret` and cookie functions return `session_secret`. |
| 6 | Session-token APIs accept either kind of secret. |

`pubky` 0.10 renders `PublicKey::to_string()` as `pubky<z32>`, so the FFI outputs `.z32()` instead
([public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)).
**Don't detect the prefixed form with `startsWith("pubky")`.** All five letters are valid
z-base32, so a bare key can start with `pubky`. Check the length: **57** means prefixed, **52**
means bare. The upstream test checks length for the same reason.

## Auth strategies and session secrets

The unqualified names are **grant aliases**:

- `sign_up` = `sign_up_grant`
- `sign_in` = `sign_in_grant`
- `start_auth_flow` = `start_grant_auth_flow`
- `await_auth_approval` = `await_grant_auth_approval`

Legacy cookie auth remains as `sign_up_cookie`, `sign_in_cookie`, `start_cookie_auth_flow` and
`await_cookie_auth_approval`. Upstream has deprecated it, so don't use it in new code.

| | Grant (default) | Cookie (legacy) |
| :-- | :-- | :-- |
| JSON in `result[1]` | `{pubky, capabilities, grant_secret}` | `{pubky, capabilities, session_secret}` |
| Secret format | **Opaque.** It starts with `pubky-grant-credential-`, and the rest is a pubky-internal encoding. | `<z32-pubkey>:<cookie_secret>` |
| `client_id` param | **required** | none |

- **Both secrets are bearer credentials.** The grant secret also contains the client
  proof-of-possession **private key**.
  - Never log either secret.
  - Store them in Keychain or Keystore
    ([persisting a session](../../pubky/references/auth.md#persist-and-restore)).
  - Don't parse the grant secret.
- **Session functions accept either secret.** `sign_out`, `revalidate_session`, `put_with_session`
  and `delete_with_session` pass it to
  [`Pubky::restore_session`](https://docs.rs/pubky/0.10.0/pubky/struct.Pubky.html#method.restore_session).
  - A token with the `pubky-grant-credential-` prefix goes to grant import, which mints a fresh
    short-lived bearer. Anything else goes to cookie import.
  - `revalidate_session` returns the JSON key that matches the input token.
  - Once the grant JWS expires, restore fails with `stored grant credential has expired`, and the
    user must authenticate again.
- **The `<z32>:<cookie>` format applies only to the cookie functions.** Commit 74fea50 removed it
  from the README contracts.
- **`client_id`** is new in v0.4.0. It is a required param on:
  - `sign_up*` and `sign_in*` (grant)
  - `start_auth_flow` and `start_grant_auth_flow`
  - `put` and `delete_file`

  The value must be non-empty and at most 253 chars. It is usually a domain such as
  `franky.pubky.app`. Bad input returns `Invalid client_id: …`.

The session JSON builder below is identical to upstream `src/utils.rs`. It was executed against a
local testnet with the pubky 0.9.3 snippet harness. The output `pubky` was a bare 52-char z32.

```rust
pub fn session_to_json_with_grant_secret(session: &PubkySession, grant_secret: &str) -> String {
    let info = session.info();
    let json_obj = json!({
        "pubky": info.public_key().z32(),
        "capabilities": info.capabilities().iter().map(|c| c.to_string()).collect::<Vec<String>>(),
        "grant_secret": grant_secret,
    });

    serde_json::to_string(&json_obj).unwrap_or_else(|e| format!("Failed to serialize JSON: {}", e))
}
```

## Exported surface (summary; signatures in `src/lib.rs`)

### Keys (sync, no network)

| Fn | `result[1]` |
| :-- | :-- |
| `generate_secret_key()` | `{secret_key (hex), public_key (z32), uri (pk:z32)}` |
| `get_public_key_from_secret_key(secret_key)` | `{public_key, uri}` |
| `generate_mnemonic_phrase()` | 12-word BIP39 English |
| `mnemonic_phrase_to_keypair(phrase)` | `{secret_key, public_key, uri}` |
| `generate_mnemonic_phrase_and_keypair()` | same, plus `mnemonic` |
| `validate_mnemonic_phrase(phrase)` | `"true"` / `"false"` |
| `create_recovery_file(secret_key, passphrase)` | base64 recovery file (errors if either input is empty) |
| `decrypt_recovery_file(recovery_file_b64, passphrase)` | hex `secret_key` |

- **A secret key is 64 hex chars** (32-byte ed25519). Any other input fails with
  `Failed to decode secret key` or `Failed to convert secret key to 32-byte array`.
- **Mnemonic derivation is FFI-specific.**
  - The phrase is parsed as BIP39 English and seeded with `to_seed("")` (empty passphrase).
  - The **first 32 bytes of the seed** become the key. There is no SLIP-10/BIP32 path.
  - Other wallets can derive a different key from the same words.
- **Recovery files are local, passphrase-encrypted key backups.** They are not homeserver backup
  restore ([recovery files](../../pubky/references/concepts.md#identity-the-ed25519-keypair)).

### Homeserver and session (blocking)

| Fn | Result and notes |
| :-- | :-- |
| `switch_network(use_testnet)` | **Sync.** Swaps the global client between `Pubky::testnet()` and `Pubky::new()`. **Panics** if construction fails. |
| `sign_up(secret_key, homeserver, signup_token?, client_id)` | Grant session JSON. On `signup succeeded but sign in failed: …` the account **exists**, so retry with `sign_in` instead of signing up again. A token-gated server returns `signup failure: …Token required…`. |
| `sign_in(secret_key, client_id)` | Grant session JSON. |
| `sign_out(secret)` | `Sign out success` |
| `revalidate_session(secret)` | Session JSON, or `Session is no longer valid (expired or invalidated)` |
| `get_homeserver(pubky)` | Homeserver z32, or `No homeserver found for this public key` |
| `republish_homeserver(secret_key, homeserver)` | Force-publishes the record. Returns `Homeserver republished successfully`. |
| `get_signup_token(homeserver_pubky, admin_password)` | **Don't rely on it.** It sends `GET https://{homeserver_pubky}/admin/generate_signup_token` with `X-Admin-Password` through a plain reqwest client that cannot resolve pkarr names, so a bare z32 host won't resolve. The current pubky-homeserver admin API is a separate listener serving `/generate_signup_token`. The HTTP status is not checked, so an error body comes back as success. The admin password must never ship in a client app ([signup tokens](../../pubky/references/auth.md#signup-tokens)). |

### Storage (blocking, `/pub` only)

| Fn | Auth | Notes |
| :-- | :-- | :-- |
| `get(url)` | public read | Returns a UTF-8 body as-is. Anything else comes back as **`base64:` + standard base64**. |
| `list(url)` | public read | Forces a trailing `/`. Returns a JSON array of `pubky://<z32>/<path>`. |
| `put(url, content, secret_key, client_id)` | **full grant sign-in on every call** | Returns the trimmed URL. |
| `delete_file(url, secret_key, client_id)` | full grant sign-in on every call | Returns `Deleted successfully`. |
| `put_with_session(url, content, session_secret)` | restores the session | Use this after auth. |
| `delete_with_session(url, session_secret)` | restores the session | Returns `Deleted successfully`. |

- **Write and delete URLs must contain `/pub/`.** Otherwise the call fails with
  `Invalid URL: must contain /pub/`.
  - The trailing `/` is trimmed, and only the part from `/pub/` onward is used.
  - `put` and `delete_file` sign in **before** checking the URL, so a bad URL still costs a
    network sign-in.
  - There is no `/priv`, encryption, mirroring or backup restore
    ([shipped-vs-planned](../../pubky/references/shipped-vs-planned.md)).
- **`content` is a `String` sent as UTF-8**, so you can't upload arbitrary binary data.
- **Check `get` results for the `base64:` prefix.** A text body that really starts with `base64:`
  is ambiguous.

### `pubkyauth` (blocking)

For the model, see [auth.md](../../pubky/references/auth.md). For deeplinks and the two roles, see
[ring-auth.md](./ring-auth.md).

- **Requester side.**
  - `start_auth_flow(capabilities_str, client_id)` stores the flow and returns the authorization URL.
  - `await_auth_approval()` **blocks** until the user approves, then returns grant session JSON.
  - The cookie equivalents are `start_cookie_auth_flow` and `await_cookie_auth_approval`.
- **One flow per strategy.**
  - Starting a new flow **overwrites** the one stored in `GRANT_AUTH_FLOW` (or `COOKIE_AUTH_FLOW`).
  - Awaiting with no stored flow returns `["true", "No auth flow in progress"]`.
  - Both flows use `AuthFlowKind::signin()` and the current network client, so call
    `switch_network` first.
- **`parse_auth_url(url)`** accepts the `pubkyauth` and `pubkyring` schemes with the intents
  `signin`, `signup`, `signin_grant` and `signup_grant`.
  - Any other intent errors with `Invalid auth URL intent '<kind>'` or `Invalid intent`.
  - The legacy form `pubkyauth:///?caps=…` parses as `signin`.
  - Output JSON: `relay`, `capabilities` (`[{path, permission}]`), `secret` (base64url) and `kind`.
  - `signup` and `signup_grant` always add `homeserver` (z32), because `hs` is required. Only
    `signup_token` is optional.
  - Grant kinds add `client_id` and `client_public_key` (z32). Both are required, so a grant link
    without `cpk` errors.
  - Optional callback fields: `x_source`, `x_success`, `x_error` and `x_cancel`.
  - The README lists only `signin` and `signup`.
- **`parse_deep_link(url)`** is not in the README. It returns `{scheme, kind, url, …}` for every
  deep link, including:
  - `direct_signup`: homeserver + signup_token, no relay
  - `secret_export`: `pubkyring://secret_export?secret=…`
- **Authenticator (wallet) side:** `auth(url, secret_key)` approves a request.
  - It returns `Authorization success`, or `Authorization failure: <full error chain>`. The chain
    includes TLS causes such as `invalid peer certificate: NotValidYet`.
  - It does not handle `direct_signup` or `secret_export`.

### pkarr / DNS (blocking)

- `publish(record_name, record_content, secret_key)` publishes one TXT record (TTL 30) and returns z32.
- `publish_https(record_name, target, secret_key)` publishes one HTTPS/SVCB record (priority 0,
  TTL 3600) and returns z32.
- **Each publish replaces the whole signed packet.** Records are not merged, so a publish can
  **wipe the user's `_pubky` homeserver record**. Don't publish under a user's identity key unless
  you intend to replace that packet.
- `resolve(public_key)` uses `CacheFirst` and returns
  `{signed_packet (hex), public_key/signature/dns_packet (base64), timestamp, last_seen, records[{name, ttl, rdata}]}`.
- `resolve_https(public_key)` returns
  `{public_key, https_records[{name, class, ttl, priority, target, port?, alpn?}], last_seen, timestamp}`,
  or `No HTTPS records found`.

## `EventListener` is a placeholder

`set_event_listener` and `remove_event_listener` are a demo that emits `"Internal event triggered"`
every 2s. **It is not a homeserver event stream.** Each `generate_secret_key()` call also starts
**another** 2s loop that never stops, so repeated key generation piles up background tasks.
