# Native FFI (`pubky-core-ffi`)

`pubky-core-ffi` is the **UniFFI** crate that wraps the `pubky` Rust SDK and generates Swift,
Kotlin and Python bindings. Use it directly for native iOS/Android apps. `react-native-pubky`
wraps the same exports ([`./react-native.md`](./react-native.md)). Ring deep links and the
authenticator role are in [`./ring-auth.md`](./ring-auth.md).

This page covers only FFI-specific material. Protocol model:

- Identity, keypairs, recovery files: [`concepts.md#identity-the-ed25519-keypair`](../../pubky/references/concepts.md#identity-the-ed25519-keypair)
- `z32()` vs `toString()`: [`concepts.md#public-key-string-formats`](../../pubky/references/concepts.md#public-key-string-formats)
- Grant model, capabilities, deep links, relays, signup tokens, persist/restore, list/revoke
  grants: [`auth.md`](../../pubky/references/auth.md)
- `/priv` and app-side encryption: [`shipped-vs-planned.md`](../../pubky/references/shipped-vs-planned.md)

**Upstream (authoritative):** the [README](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/README.md)
(String Contracts), [`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/lib.rs)
and the sibling `src/*.rs` modules (exported signatures),
[`BINDING_PARITY.md`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/BINDING_PARITY.md),
the wrapped [`pubky` 0.16.1](https://docs.rs/pubky/0.16.1/pubky/), and the
[UniFFI user guide](https://mozilla.github.io/uniffi-rs/).

Anchored on commit [`cecd67c161ba`](https://github.com/pubky/pubky-core-ffi/commit/cecd67c161ba9d2a9ada1a131a2df9279fde882a)
(2026-10-14, "Merge pull request #39 … pubky-0.16-upgrade"). The repo has **no tags or releases**,
so **pin a commit**. If a signature here disagrees with the source at the commit you built, the
source wins. The FFI resolves `pubky` 0.16.1. crates.io already has 0.16.2 (2026-10-15).

**The README's Swift/Kotlin samples are incomplete.** They leave out the Android TLS init, the
JNA dependency and the verifier classes, write `import PubkyCore`, and call `get_signup_token`
with an admin password. Use this page instead.

## The crate

- `pubkycore` **v0.4.0** (unchanged by the 0.16 upgrade), edition 2021,
  `crate-type = ["cdylib"]` as committed
  ([`Cargo.toml`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/Cargo.toml#L1-L35)).
- Deps: uniffi **0.25.3** (`cli`), `pubky = "0.16.1"`, `reqwest 0.13` (`default-features = false`,
  `rustls`), `bip39 2.2.0`, `thiserror 2.0.18`, `futures-util 0.3.31`.
- Android-only: `rustls-platform-verifier = "0.7.0"` and `jni = "0.22.4"`.
- `Cargo.lock` resolves pkarr 8.1.0, reqwest 0.13.4, rustls 0.23.28 and
  **`rustls-platform-verifier-android` 0.1.1**. Your Android verifier component must match that
  last version exactly (see [Consuming on Android](#consuming-on-android)).

## Building

`./build.sh` dispatches to
[`build_ios.sh`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/build_ios.sh),
[`build_android.sh`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/build_android.sh) and
`build_python.sh`. The scripts are the source of truth. Don't rebuild their steps by hand.

```bash
./build.sh ios       # iOS only
./build.sh android   # Android only
./build.sh python    # Python only
./build.sh all       # ios && android && python

cargo test -- --test-threads=1
```

**Prebuilt artifacts are committed** under [`bindings/`](https://github.com/pubky/pubky-core-ffi/tree/cecd67c161ba/bindings).
At a pinned commit you can use them without building.

### iOS (`build_ios.sh`)

- **macOS host only.** It rewrites `Cargo.toml` with BSD `sed -i ''` to
  `crate-type = ["cdylib", "staticlib"]` and **does not restore it.**
- Exports `IPHONEOS_DEPLOYMENT_TARGET=13.4` and builds `aarch64-apple-ios` and
  `aarch64-apple-ios-sim` in release.
- Runs `rm -rf bindings/ios/*`. Then it generates Swift from `target/release/libpubkycore.dylib`,
  renames `pubkycoreFFI.modulemap` to `module.modulemap`, copies the header and modulemap into
  per-slice `Headers/` dirs, deletes any existing XCFramework, and runs
  `xcodebuild -create-xcframework` to produce `bindings/ios/PubkyCore.xcframework`.
- **Revert `Cargo.toml` before committing** after `./build.sh ios` (or `ios` then `android`).
  Only `build_python.sh` resets `crate-type` to `["cdylib"]`, so `./build.sh all` fixes it at the
  Python step. `build_android.sh` doesn't touch `Cargo.toml`.

### Android (`build_android.sh`)

- Requires `ANDROID_SDK_ROOT` or `ANDROID_HOME`.
- **NDK is pinned** in [`.ndk-version`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/.ndk-version)
  (`29.0.14206865`, r29). Override with `ANDROID_NDK_VERSION`. The script fails if the NDK major is
  below 28 or the NDK isn't installed at `$ANDROID_SDK_ROOT/ndk/<ver>`. Install it with
  `sdkmanager "ndk;$(cat .ndk-version)"`. The script exports `ANDROID_NDK_HOME` and `NDK_HOME`.
- If a different cargo-ndk version is installed, it installs **cargo-ndk 3.5.4** exactly (`--locked`).
- Runs `rm -rf bindings/android`, which **deletes the committed `jniLibs`**.
- Builds the host lib, then `cargo ndk -t armeabi-v7a -t arm64-v8a -t x86 -t x86_64 build --release`
  with `-C link-arg=-Wl,--build-id=sha1` (GNU build ID, for crash symbol matching).
- Generates Kotlin from the host lib through a `mktemp` dir. **macOS (`.dylib`) and Linux (`.so`)
  hosts both work.**
- **16 KB page size:** NDK r28+ aligns ELF LOAD segments to 16 KB by default.
  [`scripts/verify_android_page_size.sh`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/scripts/verify_android_page_size.sh)
  runs after the build and fails if any LOAD alignment is below `0x4000`. It checks **only
  `arm64-v8a` and `x86_64`**. The committed 32-bit libs (`armeabi-v7a`, `x86`) are `0x1000`. To
  re-check existing libs:
  `ANDROID_NDK_HOME="$ANDROID_SDK_ROOT/ndk/$(cat .ndk-version)" ./scripts/verify_android_page_size.sh`.

### Tests

- **Use `--test-threads=1`.** The crate has process-global statics: `NETWORK_CLIENT`,
  `TOKIO_RUNTIME`, `GRANT_AUTH_FLOW`, `COOKIE_AUTH_FLOW`, `EVENT_NOTIFIER`, `EVENT_STREAM_TASKS`,
  `EVENT_STREAM_SEQUENCE`.
- **Tests hit the real network.** Signup tests target homeserver
  `ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy` with `CLIENT_ID` `pubky-core-ffi.test`
  and read the optional `PUBKY_TEST_SIGNUP_TOKEN`. If the error contains `Token required`, the test
  returns early and **passes silently**.

## Consuming on iOS

1. Drag `bindings/ios/PubkyCore.xcframework` into Xcode. Check *Copy items if needed* and add it
   to the target.
2. Add `bindings/ios/pubkycore.swift` to the target.

- **Only two slices:** `ios-arm64` (device) and `ios-arm64-simulator`. There is **no `x86_64`
  simulator slice**, so set `EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64`. CocoaPods:
  `s.ios.vendored_frameworks = "…/PubkyCore.xcframework"`, as react-native-pubky's podspec does.
- **Don't write `import PubkyCore`** (the README is wrong). The modulemap declares the Clang module
  `pubkycoreFFI`, and `pubkycore.swift` imports it with `#if canImport(pubkycoreFFI)`. The generated
  functions belong to **your own module**, so call `publicGetBytes(address:)` directly.
- **Compile `pubkycore.swift` in Swift 5 language mode.** Swift 6 mode fails with
  `static property 'handleMap' is not concurrency-safe`
  ([L1794](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/bindings/ios/pubkycore.swift#L1794)
  `EventListener`, L1943 `PubkyEventStreamListener`). If your app code is Swift 6, put the bindings
  in a separate Swift 5 module and import that module.
- **Generated records (`EventStreamConfig`, `PubkyStorageEvent`, …) are not `Sendable`.** Capturing
  one in a `@Sendable` closure is a **hard error in Swift 6 mode** and a warning under
  `-strict-concurrency=complete`. Build records inside the closure, as the typed snippet below does.
- **iOS needs no TLS init.** Certificates are verified through Security.framework.

## Consuming on Android

1. Copy `bindings/android/jniLibs/{armeabi-v7a,arm64-v8a,x86,x86_64}/libpubkycore.so` into
   `app/src/main/jniLibs/`. Copy `pubkycore.kt` (package `uniffi.pubkycore`) into a source dir.
2. **Add JNA.** The generated Kotlin loads the library with
   `Native.load<Lib>(findLibraryName(componentName), …)`. To override the lookup, set the system
   property `uniffi.component.pubkycore.libraryOverride`.
3. **Add the rustls-platform-verifier JVM classes** (`org.rustls.platformverifier.*`).
   - Since rustls-platform-verifier 0.7.1 the Android component is published to a GitHub-hosted
     Maven repo ([v/0.7.1 release notes](https://github.com/rustls/rustls-platform-verifier/releases/tag/v%2F0.7.1),
     [PR #251](https://github.com/rustls/rustls-platform-verifier/pull/251)). Component versions
     0.1.0 and 0.1.1 were backported to it. Follow the upstream
     [Gradle setup](https://github.com/rustls/rustls-platform-verifier#gradle-setup), but don't copy
     its snippet blindly: its `resolutionStrategy` matches `org.rustls` while its dependency line
     says `rustls:rustls-platform-verifier`.
   - **Pin the component to the `rustls-platform-verifier-android` version in the FFI's
     `Cargo.lock` (0.1.1 at `cecd67c`).** Upstream requires the native and JVM component versions
     to be identical.
   - Alternative: the `rustls-platform-verifier-android` 0.1.1 crate still ships a local `maven/`
     dir. react-native-pubky vendors the classes as `libs/rustls-platform-verifier.jar` (not on
     Maven, hence `files(...)` below).
   - With R8/Proguard: `-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }`.
4. **Add the rustls init (next section), and call it before any other `pubkycore` call.**

Dependencies as used by react-native-pubky 0.15.0
([`build.gradle`](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c7ecb4e2a2b4016914d252aa63c51/android/build.gradle#L100-L106),
comments trimmed). The lines work in both the Groovy and Kotlin DSL. Compiled in an AGP 8.13 /
Kotlin 2.2 library project.

```kotlin
implementation("net.java.dev.jna:jna:5.18.1@aar")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.7.3")
implementation(files("libs/rustls-platform-verifier.jar"))
```

## MANDATORY: Android rustls init

On Android, run this before the first network call. Otherwise the first TLS handshake **panics**
with `Expect rustls-platform-verifier to be initialized`.

- pkarr's relay HTTP client (reqwest 0.13, `rustls`) uses `rustls-platform-verifier`. So does the
  FFI's own reqwest client (used by `get_signup_token`).
- On Android, the verifier needs the JavaVM and the application `Context` once, before any
  handshake.
- UniFFI loads the `.so` through **JNA**, so `JNI_OnLoad` never runs and nothing captures the VM
  automatically.
- pubky's ICANN client stopped using the platform verifier
  ([pubky-homeserver#456](https://github.com/pubky/pubky-homeserver/pull/456)), but the pkarr relay
  client still uses it. The fix, [pkarr#262](https://github.com/pubky/pkarr/pull/262), was closed
  unmerged, so the init is still required.

The Rust side ([`src/rustls_init.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/rustls_init.rs#L21-L35),
verbatim) is a **plain JNI export, not a UniFFI export**. It is compiled only for
`target_os = "android"` and **discards the init result**, so a failed init surfaces later as the
original handshake error. The symbol is present in all four committed `.so` files.

```rust
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_uniffi_pubkycore_RustlsInit_initPlatformVerifier<'caller>(
    mut env: jni::EnvUnowned<'caller>,
    _class: jni::objects::JClass<'caller>,
    context: jni::objects::JObject<'caller>,
) {
    // `with_env` upgrades the FFI-safe `EnvUnowned` into an `Env` and wraps the closure in
    // `catch_unwind`, so a JNI failure here can't unwind across the FFI boundary. We
    // deliberately discard the outcome: a failed init leaves the verifier uninitialized and
    // surfaces later as the original handshake error, which is the most we can do here.
    let _ = env.with_env(|env| -> Result<(), jni::errors::Error> {
        rustls_platform_verifier::android::init_with_env(env, context)
    });
}
```

**`RustlsInit` is NOT in the generated `pubkycore.kt`.** Declare it yourself:

- Put it in package `uniffi.pubkycore` so the JNI name matches.
- Put it **outside** the directory you regenerate, or regeneration deletes it.

Verbatim from react-native-pubky
([`RustlsInit.kt`](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c7ecb4e2a2b4016914d252aa63c51/android/src/main/java/com/pubky/RustlsInit.kt#L8-L42),
header comment trimmed). Compiled alongside the `cecd67c` `pubkycore.kt`.

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

- **Call `RustlsInit.ensure(context)`.** `initPlatformVerifier` is `private`.
- Call it once at startup, before any other `pubkycore` function, for example in
  `Application.onCreate`. react-native-pubky calls it in `PubkyModule`'s `init`
  ([L27-30](https://github.com/pubky/react-native-pubky/blob/e85e34453a1c7ecb4e2a2b4016914d252aa63c51/android/src/main/java/com/pubky/PubkyModule.kt#L27-L30))
  and runs calls on `Dispatchers.IO`.
- Repeat calls are safe because the Rust side uses a `OnceCell`.

## Calling conventions

There are **two API families**
([README](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/README.md#L46-L49)):

| Family | Returns | Errors | Members |
| :-- | :-- | :-- | :-- |
| Legacy vector (kept for downstream compat) | Swift `[String]`, Kotlin `List<String>` | never throws; `result[0] == "true"` | keys/mnemonics, `create_recovery_file`/`decrypt_recovery_file`, `sign_up*`, `sign_in`/`sign_in_grant`/`sign_in_cookie`, `sign_out`, `revalidate_session`, `get`/`list`/`put*`/`delete*`, pkarr (`publish*`, `resolve*`), `get_homeserver`, `republish_homeserver`, `get_signup_token`, `start_auth_flow`/`start_grant_auth_flow`/`start_cookie_auth_flow`, `await_auth_approval`/`await_grant_auth_approval`/`await_cookie_auth_approval`, `auth*`, `parse_*`, `switch_network`, **`list_grants`, `revoke_grant`** |
| Typed (pubky 0.16) | native types | Swift `throws`; Kotlin `@Throws(PubkyCoreException::class)` | `public_*`/`session_*` storage, event streams, locks, `configure_client`, `sign_in_grant_blocking`/`sign_in_cookie_blocking`, advanced grant flow (`*_grant_auth_flow*`), grant features |

Neither convention: `cancel_grant_auth_flow` (unit), `stop_event_stream` (→ `Bool`),
`stop_all_event_streams` (→ `u64`), `set_event_listener`/`remove_event_listener`.

- **Naming:** `snake_case` becomes camelCase. Swift adds argument labels:
  `signIn(secretKey:clientId:)`, `signUp(secretKey:homeserver:signupToken:clientId:)`,
  `startAuthFlow(capabilitiesStr:clientId:)`, `putWithSession(url:content:sessionSecret:)`,
  `sessionPutBytes(pathOrAddress:content:sessionSecret:)` (`content: Data`),
  `startEventStream(config:listener:) throws -> String`,
  `sessionLock(pathOrAddress:sessionSecret:timeoutSeconds:) throws -> PubkyStorageLock`.
- **Kotlin uses unsigned types:** `ULong` for timeouts, event cursors and max bytes; `UShort` for
  list and event `limit` and for `Server.status`. `StorageListOptions.cursor` is a `String`. Bytes
  are `ByteArray` (Swift `Data`).
- **Generated record initializers have no default values** in Swift or Kotlin. Rust
  `#[derive(Default)]` doesn't carry over, so pass every field, including optionals (`nil`/`null`).

### Never call on the main/UI thread

- **Every network export, in both families, runs `TOKIO_RUNTIME.block_on(...)` on the calling
  thread.** `await_*` blocks **until the user approves**. Wrapping a call in `suspend fun` or
  `async func` does not move work off-thread: dispatch it (`Dispatchers.IO`, a Dispatch queue).
- `poll_grant_auth_flow` is documented as "without blocking the UI thread" but still does one relay
  network probe inside `block_on`. Call it off the main thread too.
- `start_grant_auth_flow_with_config` and `restore_grant_auth_flow` only enter the runtime; they
  don't `block_on`.
- `sign_in_grant_blocking`/`sign_in_cookie_blocking` are named after pubky's `signin_blocking`,
  which, if the homeserver PKDNS record is stale, waits (~3–5 s) for it to be republished so the
  user is immediately discoverable. "Blocking" does **not** mean the other functions are async.

### The `[error, data]` convention (legacy family)

Identical to upstream [`src/utils.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/utils.rs#L206-L208):

```rust
pub fn create_response_vector(error: bool, data: String) -> Vec<String> {
    vec![error.to_string(), data]
}
```

- `result[0] == "true"` (a **string**) means the call **failed**, and `result[1]` is the message.
- `result[0] == "false"` means success, and `result[1]` holds the data, often JSON.
- `validate_mnemonic_phrase` returns `["false", "true"|"false"]`. **Read validity from index 1.**
- Don't copy `bindings/python/README.md` or `build_python.sh`. They check
  `result[0] == "success"`, which never matches.

**Kotlin**, legacy `get(url)` on `Dispatchers.IO`. Authored, compiled against the `cecd67c`
`pubkycore.kt` (`get(url: String): List<String>`), not run. It calls `RustlsInit.ensure`, so it's
safe to copy on its own.

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

**Swift**, legacy call moved to a Dispatch queue so long blocks such as `awaitAuthApproval` don't
hold a Swift-concurrency pool thread. Authored. Compiled and linked for the iOS simulator against
`get(url: String) -> [String]` at `cecd67c`, clean in Swift 5 and Swift 6 modes, not run.

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

### Typed errors (`PubkyCoreError`)

Variants ([`src/binding_error.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/binding_error.rs#L8-L36)):

| Variant | Fields | Comes from |
| :-- | :-- | :-- |
| `Transport` | `details` | network failure |
| `Server` | `status: u16`, `details` | HTTP status kept from pubky `RequestError::Server`. **Missing resource on GET = 404 or 410.** |
| `Validation` | `details` | bad input (`client_id`, secret lengths, keys); also **every** `verify_custom_grant_proof` failure, including an expired grant |
| `DecodeJson` | `details` | |
| `Pkarr` | `details`, `retryable: bool` | `PkarrError::is_retryable()` |
| `Parse` | `details` | |
| `Authentication` | `details`, `expired: bool` | `expired = true` for `AuthError::RequestExpired` and for an expired grant in `create_custom_grant_proof` |
| `Build` | `details` | client construction |
| `State` | `details` | e.g. no flow in progress, released lock |

- **Don't use `expired` to decide whether to re-authenticate.** An expired *stored* grant on
  session restore fails with pubky `AuthError::Validation("stored grant credential has expired")`,
  which arrives as `Authentication` with **`expired == false`**. An expired grant in
  `verify_custom_grant_proof` arrives as `Validation`.
- Swift: `enum PubkyCoreError: Error` with capitalized cases, e.g.
  `.Server(status: UInt16, details: String)`.
- Kotlin: `sealed class PubkyCoreException` with nested classes, e.g.
  `PubkyCoreException.Server(status: UShort, details)`. Kotlin's `message` is UniFFI's
  `"status=..., details=..."` form, not the Rust `Display` text. Branch on the class and fields,
  not on `message`.

**Swift**, typed API off the caller's thread, 404/410 → `nil`, and an event-stream listener that
hops to main. Authored. Compiled and linked for the iOS simulator against the generated
`pubkycore.swift` at `cecd67c`. It is clean in Swift 5 mode (bindings in the same module) and in
Swift 6 mode (bindings in a separate Swift 5 module). Not run against a homeserver.

```swift
import Foundation

// Run a blocking pubkycore call off the caller's thread; typed APIs throw PubkyCoreError.
func pubkyTyped<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
        DispatchQueue.global(qos: .userInitiated).async {
            cont.resume(with: Result { try body() })
        }
    }
}

// Returns nil when the resource is missing (404/410 surface as PubkyCoreError.Server).
func readPublic(_ address: String) async throws -> Data? {
    do {
        return try await pubkyTyped { try publicGetBytes(address: address) }
    } catch PubkyCoreError.Server(let status, _) where status == 404 || status == 410 {
        return nil
    }
}

// Listener callbacks arrive on a native worker thread: hop to main before touching UI.
final class StreamListener: PubkyEventStreamListener, Sendable {
    func onEvent(event: PubkyStorageEvent) {
        DispatchQueue.main.async { print(event.eventType, event.resource, event.cursor) }
    }
    func onError(message: String) {
        DispatchQueue.main.async { print("event stream ended with error:", message) }
    }
    func onComplete() {}
}

func followUser(_ userZ32: String) async throws -> String {
    let listener = StreamListener()
    // Keep the returned id; pass it to stopEventStream(subscriptionId:) when done.
    return try await pubkyTyped {
        // Build the config inside the closure: generated records are not Sendable.
        let config = EventStreamConfig(
            users: [EventStreamUser(publicKey: userZ32, cursor: nil)],
            homeserver: nil, paths: ["/pub/my-app/"], limit: nil, maxEventBytes: nil,
            live: true, reverse: false, sessionSecret: nil)
        return try startEventStream(config: config, listener: listener)
    }
}
```

**Kotlin**, the same read on `Dispatchers.IO` with the mandatory init. Authored. Compiled against
the `cecd67c` `pubkycore.kt` (`publicGetBytes(address: String): ByteArray` throws
`PubkyCoreException`; `Server.status` is `UShort`). Not run.

```kotlin
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import uniffi.pubkycore.PubkyCoreException
import uniffi.pubkycore.RustlsInit
import uniffi.pubkycore.publicGetBytes

// Android: RustlsInit.ensure must run before the first TLS handshake (idempotent).
suspend fun readPublic(context: Context, address: String): ByteArray? = withContext(Dispatchers.IO) {
    RustlsInit.ensure(context)
    try {
        publicGetBytes(address)
    } catch (e: PubkyCoreException.Server) {
        val status = e.status.toInt()
        if (status == 404 || status == 410) null else throw e
    }
}
```

## String Contracts

react-native-pubky, Pubky Ring and Bitkit rely on these. **Don't change an output shape without a
coordinated migration.** Authoritative list:
[README](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/README.md#L5-L49). Summary:

| # | Contract |
| :-- | :-- |
| 1 | Public keys in **every output** are **bare z-base32, 52 chars, no prefix**: `public_key`, session `pubky`, `get_homeserver`, `publish`/`publish_https` returns. Inputs accept bare or `pubky`-prefixed. |
| 2 | `uri` fields use `pk:<z32>`. |
| 3 | Legacy responses are `[error, data]` with the strings `"true"`/`"false"`. |
| 4 | `parse_auth_url` returns `relay`, `capabilities`, `secret`, `kind` (+ signup `homeserver` as bare z32 and optional `signup_token`). Full field set: [Parsing links](#parsing-links). |
| 5 | Auth mirrors pubky 0.16: grant functions return `grant_secret`; unqualified `sign_up`/`sign_in`/`start_auth_flow`/`await_auth_approval` are grant aliases. |
| 6 | A signer can narrow an approval with `auth_with_capabilities`. |
| 7 | Cookie auth remains, **deprecated**, returning `session_secret`. |
| 8 | Session-token APIs accept either secret. |
| 9 | Grant management needs a root-capability session. |
| 10 | The new 0.16 APIs use typed native errors. |

Why #1: pubky 0.16 `PublicKey::to_string()` renders `pubky<z32>`, and pubky's own storage URL
parser rejects `pubky://pubky<z32>/...`, so the FFI outputs `.z32()`
([public-key string formats](../../pubky/references/concepts.md#public-key-string-formats)).

**Don't detect the prefixed form with `startsWith("pubky")`.** All five letters are valid z-base32,
so a bare key can start with `pubky`. Check the length instead: **57** = prefixed, **52** = bare.
The upstream test [`test_public_key_outputs_are_bare_z32`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/tests.rs#L86-L128)
asserts length 52 and `uri.starts_with("pk:")`.

## Auth strategies and session secrets

Model: [`auth.md`](../../pubky/references/auth.md). Deep links and the two roles:
[`./ring-auth.md`](./ring-auth.md).

Unqualified names are **grant aliases**: `sign_up` = `sign_up_grant`, `sign_in` = `sign_in_grant`,
`start_auth_flow` = `start_grant_auth_flow`, `await_auth_approval` = `await_grant_auth_approval`.
Cookie auth (`sign_up_cookie`, `sign_in_cookie`, `sign_in_cookie_blocking`,
`start_cookie_auth_flow`, `await_cookie_auth_approval`) is deprecated upstream
([cookie auth](../../pubky/references/auth.md#deprecated-cookie-auth)). Don't use it in new code.

| | Grant (default) | Cookie (deprecated) |
| :-- | :-- | :-- |
| Session JSON | `homeserver` (z32), `pubky` (z32), `client_id`, `capabilities` (string array), `grant_id`, `token_expires_at`, `grant_expires_at`, `created_at` (Unix seconds), `grant_secret` | `pubky` (z32), `capabilities`, `session_secret` |
| Secret format | **Opaque.** `pubky-grant-credential-v1:…` (bare grant) or `pubky-grant-credential-v2:…` (signed approval). | `<z32-pubkey>:<cookie_secret>` |
| `client_id` param | **required** | none |

The grant JSON grew in the 0.16 upgrade (it was `{pubky, capabilities, grant_secret}`). It comes
from `sign_up`/`sign_in(_grant)`, `await_(grant_)auth_approval`, `revalidate_session` with a grant
input, `await_grant_auth_flow`, `poll_grant_auth_flow` and `sign_in_grant_blocking`. Vector APIs
put it in `result[1]`; typed ones return it as a `String`
([`session_to_json_with_grant_secret`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/utils.rs#L230-L253)).

- **Both secrets are bearer credentials.** The grant secret also holds the client
  proof-of-possession **private key**. A v2 secret also holds the confidential signed approval,
  which can contain scoped encryption keys.
  - Never log either secret. Store them in Keychain/Keystore
    ([persist and restore](../../pubky/references/auth.md#persist-and-restore)).
  - **Don't parse the grant secret** in app code.
- **The `<z32>:<cookie>` format applies only to the cookie functions.** On import it splits at the
  **first** colon, because the cookie may contain `:`.
- **Session functions accept either secret** and restore through
  [`Pubky::restore_session`](https://docs.rs/pubky/0.16.1/pubky/struct.Pubky.html#method.restore_session).
  A token starting `pubky-grant-credential-` goes to grant import, which mints a fresh short-lived
  bearer. Anything else goes to cookie import. An expired grant fails with
  `stored grant credential has expired` (typed: `Authentication`, `expired == false`), and the user
  must authenticate again.
- **`client_id`** is required on `sign_up`/`sign_up_grant`, `sign_in`/`sign_in_grant`,
  `sign_in_grant_blocking`, `start_auth_flow`/`start_grant_auth_flow`,
  `GrantAuthFlowConfig.client_id`, `put` and `delete_file`. It must be non-empty and at most
  253 bytes (pubky `ClientId::new`). Bad input → `Invalid client_id: …` (vector) or
  `PubkyCoreError::Validation` (typed).

### `secret_key` exports are for key holders only

**Every export that takes the user's `secret_key` is a key-holder path.** The sign-ins use
`PubkySigner::signin`/`signin_blocking`, which grant **root `/:rw`** without encryption keys
([first-party signer sign-in](../../pubky/references/auth.md#first-party-signer-sign-in)).

- That includes `sign_in`/`sign_in_grant`, `sign_up`/`sign_up_grant`, the **typed
  `sign_in_grant_blocking`**, the cookie sign-ins (`sign_in_cookie`, `sign_in_cookie_blocking`,
  `sign_up_cookie`), `put`, `delete_file`, `republish_homeserver`, `auth`/`auth_with_capabilities`,
  `publish`/`publish_https` and `create_recovery_file`.
- These are for authenticators such as Pubky Ring. **A third-party native app must use the auth
  flow** (`start_auth_flow` or `start_grant_auth_flow_with_config`) and **never ask for the user's
  secret key.** Being in the typed family doesn't make `sign_in_grant_blocking` a third-party API.
- `put` and `delete_file` do a full grant sign-in **on every call, before validating the URL**, so
  a bad URL still costs a network sign-in. Prefer `put_with_session` or `session_put_bytes`.
- `sign_up`/`sign_up_grant`: on `signup succeeded but sign in failed: …` the account **exists**.
  Retry with `sign_in`, not `sign_up`. A token-gated homeserver returns
  `signup failure: …Token required…` ([signup tokens](../../pubky/references/auth.md#signup-tokens)).

## `pubkyauth`: requester side

### Legacy flow (vector)

- `start_auth_flow(capabilities_str, client_id)` / `start_grant_auth_flow` stores the flow and
  returns the authorization URL ([capabilities](../../pubky/references/auth.md#capabilities)).
- `await_auth_approval()` / `await_grant_auth_approval()` **blocks** until approval and returns grant
  session JSON. With no stored flow it returns `["true", "No auth flow in progress"]`.
- Both always use `AuthFlowKind::signin()` and the current global client, so call
  `configure_client`/`switch_network` first.
- Cookie equivalents use a separate `COOKIE_AUTH_FLOW` slot.

### Advanced grant flow (typed)

Source: [`src/auth_flow.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/auth_flow.rs).

| Fn | Result |
| :-- | :-- |
| `start_grant_auth_flow_with_config(GrantAuthFlowConfig)` | `GrantAuthFlowStateRecord{authorization_url, client_key_secret, approval_key_secret}` |
| `save_grant_auth_flow()` | the current `GrantAuthFlowStateRecord` |
| `restore_grant_auth_flow(state)` | `authorization_url` |
| `poll_grant_auth_flow()` | `Option<session JSON>`. `None` = keep polling. On error the flow is kept. |
| `await_grant_auth_flow()` | session JSON. **Consumes** the flow. |
| `cancel_grant_auth_flow()` | clears the flow |

- `GrantAuthFlowConfig` fields: `capabilities`, `client_id`, `homeserver` (present = signup flow),
  `signup_token`, `relay` ([relays](../../pubky/references/auth.md#relays)), `client_secret` and
  `client_key_secret` (each **exactly 32 bytes**, else `Validation` `<name> must contain exactly 32 bytes`),
  `approval_format` (`GrantApprovalMode.BareGrant` | `SignedApprovalV1`; `None` = legacy bare grant),
  `x_source`, `x_success`, `x_error`, `x_cancel`. Pass every field.
- **Only ONE grant flow is held globally** (`GRANT_AUTH_FLOW`). Starting or restoring another
  overwrites it, and the legacy `start_grant_auth_flow` shares the same slot.
- **`GrantAuthFlowStateRecord` is sensitive temporary state** (client PoP secret, HPKE recipient
  secret). It's useful only while the relay inbox exists. Keep it in secure storage and **delete it
  once the flow completes, expires or is abandoned**
  ([resume after restart](../../pubky/references/auth.md#resume-after-reload-or-restart)).
- After an SDK upgrade, pending signed-approval flows whose saved URL contains `secret` without
  `epk` can't be resumed. Restart them.

### Parsing links

`parse_auth_url(url)` ([`src/auth.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/auth.rs),
[deep links](../../pubky/references/auth.md#pubkyauth-deep-links)):

- Intents: `signin`, `signup`, `signin_grant`, `signup_grant` (the README still lists only `signin`
  and `signup`). Others → `Invalid auth URL intent '<kind>'` or pubky's `Invalid intent`. Legacy
  `pubkyauth:///?...` parses as `signin`.
- Output JSON: `relay`, `capabilities` (`[{path, permission}]`), `kind`, and, when present:
  - `secret` (base64url). **Absent on signed-approval links**, which carry `ephemeral_public_key`
    (base64url) instead.
  - `homeserver` (z32), `signup_token`.
  - `client_id`, `client_public_key` (z32; `cpk` is required for grant kinds).
  - `approval_format` (`bare_grant` | `signed_approval_v1`).
  - `x_source`, `x_success`, `x_error`, `x_cancel`.
- `parse_deep_link(url)` returns `{scheme, kind, url, …}` for all six DeepLink variants, including
  `direct_signup` (homeserver + signup_token, no relay) and `secret_export`
  (`pubkyring://secret_export?secret=…`).

## Authenticator (signer) side

See [authenticator side](../../pubky/references/auth.md#authenticator-side-approving-requests) and
[`./ring-auth.md`](./ring-auth.md).

- `auth(url, secret_key)` approves **all** requested capabilities.
- `auth_with_capabilities(url, secret_key, approved_capabilities)` approves a user-selected subset
  as comma-separated `scope:actions`. An empty string approves no capabilities. The capabilities
  are parsed before any network work (`Invalid approved capabilities: …`), and the SDK rejects
  approvals that exceed the request.
- Both return `Authorization success` or `Authorization failure: <full source error chain>`. The
  chain includes TLS causes such as `invalid peer certificate: NotValidYet`.
- Neither handles `direct_signup` or `secret_export`. For signup links, create the account first.

### Grant management (vector)

[`src/lib.rs` L738-786](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/lib.rs#L738-L786),
model in [list and revoke grants](../../pubky/references/auth.md#list-and-revoke-grants):

- `list_grants(session_secret)` → JSON array of `{grant_id, client_id, capabilities`
  (comma-separated string)`, issued_at, expires_at}` (Unix seconds).
- `revoke_grant(session_secret, grant_id)` → `Grant revoked`. It invalidates every session minted
  from that grant.
- **Both need a root-capability session** (a key-holder/signer session). A narrowly scoped
  third-party app session gets 401/403.
- Invalid id → `Invalid grant id: …` (checked before the network). Bad secret →
  `Failed to import session: …`.

## Storage

### Legacy (vector, `/pub` only)

| Fn | Auth | Notes |
| :-- | :-- | :-- |
| `get(url)` | public | UTF-8 body as-is, else **`base64:` + standard base64** (ambiguous if real text starts with `base64:`) |
| `list(url)` | public | Forces a trailing `/`. JSON array of `pubky://<z32>/<path>`. |
| `put(url, content, secret_key, client_id)` | key-holder sign-in per call | avoid in third-party apps |
| `delete_file(url, secret_key, client_id)` | key-holder sign-in per call | avoid in third-party apps |
| `put_with_session(url, content, session_secret)` | restores session | |
| `delete_with_session(url, session_secret)` | restores session | |

- Write/delete URLs must contain `/pub/` (`Invalid URL: must contain /pub/`). The trailing `/` is
  trimmed and only the part from `/pub/` on is used.
- `content` is a `String` sent as UTF-8. **No arbitrary binary.** For binary, `/priv`, existence,
  stats or pagination, use the typed APIs.

### Typed

Source: [`src/storage.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/storage.rs).

- Public reads: `public_get_bytes(address)` → bytes, `public_exists(address)` → `Bool`,
  `public_stats(address)` → `StorageResourceStats?{content_length, content_type, last_modified_ms`
  (ms since epoch)`, etag}`, `public_list(address, StorageListOptions{reverse, shallow, limit: u16?, cursor: String?})`
  → `StorageListPage{entries, next_cursor}`.
- Session variants: `session_get_bytes`, `session_exists`, `session_stats`, `session_list`,
  `session_put_bytes(path_or_address, content: bytes, session_secret)`, `session_delete`.
  - They **restore the session from the secret on every call**.
  - `path_or_address` is an absolute path (`/pub/...`, or `/priv/...` which is alpha, see below)
    or a `pubky://` address.
  - An address owned by a different Pubky is rejected (`addressed resource belongs to a different Pubky`).
- A missing resource on GET surfaces as `PubkyCoreError.Server` 404 or 410.
- **Pagination:** `next_cursor` is the last entry's URL whenever the page is non-empty, **even on
  the final page**. It is `None` only when `entries` is empty. Loop until `entries` is empty (or
  shorter than your `limit`). Don't treat a non-nil cursor as "more pages exist".
- **`/priv` is ALPHA, not for production, and not encrypted from the homeserver operator**
  (access-controlled only; the admin can read and write it). The typed `session_*` APIs and
  `EventStreamConfig.session_secret` accept `/priv/...`. Read
  [`/priv` private storage (alpha)](../../pubky/references/shipped-vs-planned.md#priv-private-storage-alpha)
  before using it.

### WebDAV locks (typed)

Homeserver "Basic Webdav locks" shipped in v0.13.0
([`src/locks.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/locks.rs)):

- `session_lock(path_or_address, session_secret, timeout_seconds)` → `PubkyStorageLock` with
  `info()` → `StorageLockInfo{path, token, timeout_seconds}`, `refresh(timeout_seconds)`,
  `put(content bytes)`, `delete()`, `unlock()`.
- After `unlock`, methods fail with `State` `Storage lock has already been released`.
- An expired or unlocked lock returns 412. Take a new lock.

## Event streams (typed)

Homeserver event streams
([`src/events.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/events.rs)):

- `start_event_stream(EventStreamConfig, listener)` → subscription id `event-stream-<n>`.
  - `EventStreamConfig{users: [EventStreamUser{public_key, cursor: u64?}], homeserver: z32?, paths, limit: u16?, max_event_bytes, live, reverse, session_secret}`.
  - At least one user is required. Without `homeserver`, the first user's homeserver is used.
  - `session_secret` is required only for `/priv/...` paths (alpha, see above).
  - It blocks while subscribing. Events then arrive from a background tokio task.
- `stop_event_stream(id)` → `Bool` (`false` if it already finished). `stop_all_event_streams()` →
  count.
- Listener `PubkyEventStreamListener`: `on_event(PubkyStorageEvent{event_type "PUT"|"DEL", resource`
  (pubky URL)`, cursor: u64, content_hash` (blake3 hex, PUT only)`})`, `on_error(message)`,
  `on_complete()`.

Gotchas:

- **Callbacks run on a native tokio worker thread.** Hop to the main thread before touching UI.
- `on_error` **ends** the stream: the task is removed and `on_complete` is not called.
- Keep the returned id and call `stop_event_stream` to cancel. The native task holds the listener
  until the stream stops.
- To resume, pass the last seen `cursor` per user.

**`set_event_listener`/`remove_event_listener` (`EventListener.on_event_occurred`) is a demo**, not a
homeserver stream. It emits `Internal event triggered` every 2 s. `generate_secret_key()` also
spawns another never-ending 2 s loop on every call
([`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/lib.rs#L239-L251)), so
repeated key generation piles up background tasks.

## Client configuration and networks

- `configure_client(PubkyClientConfig{use_testnet, testnet_host, request_timeout_ms, read_timeout_ms, pool_max_idle_per_host, max_error_body_bytes, user_agent_extra})`
  (typed) rebuilds the process-global client
  ([`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/lib.rs#L86-L159)).
  - `testnet_host` takes precedence over `use_testnet`. `None` keeps pubky defaults.
  - It affects later requests and sessions only.
- `switch_network(use_testnet)` (vector) still exists but `.unwrap()`s client construction, so it
  **panics** on build failure. Prefer `configure_client`. The default `NetworkClient::new` also
  unwraps `PubkyHttpClient::new()`, so the first use of the global client can panic too.
- pubky's `testnet()` targets `localhost`. On a device or emulator, `localhost` is the device itself.
  Set `testnet_host` to the LAN/host machine (on the Android emulator the host is the standard
  alias `10.0.2.2`).

## Grant features (typed, pubky 0.16)

Source: [`src/grant_features.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/grant_features.rs).

### Scoped encryption keys

[`grant_features.rs` L90-120](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/grant_features.rs#L90-L120):

- `grant_encryption_key_scopes(session_secret)` → `[scope]?`. `None` = legacy bare grant or v1
  token; empty = signed approval with no keys.
- `derive_grant_encryption_key(session_secret, path)` → 32 bytes or `None`. Pass a **file** path;
  otherwise it fails with `OutsideScope` or `DirectoryPath`.
- `grant_signed_approval(session_secret)` → `String?`.
- Requires `approval_format: SignedApprovalV1` and the `e` action (e.g. `/pub/chat/:rwe`). Older
  homeservers reject grants containing `e`, and older signers can't open `af=v1` links.
- **These deliver KEYS only. The SDK does not encrypt content, and this is not encrypted storage.**
  - The app owns the ciphertext format and nonces. Use a vetted library, never hand-rolled crypto.
  - Metadata and paths stay public.
  - **Keys don't authenticate writers:** anyone holding a key can produce valid ciphertext.
  - Keys are permanent (no revocation or rotation; they survive grant expiry), and a directory
    scope covers everything below it.
  - Read [app-side ciphertext is your own crypto](../../pubky/references/shipped-vs-planned.md#app-side-ciphertext-is-your-own-crypto)
    and upstream [`scoped-encryption-keys.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/scoped-encryption-keys.md).

### Custom grant proofs

[`grant_features.rs` L34-88](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/grant_features.rs#L34-L88):

- `create_custom_grant_proof(session_secret, data_json)` → `CustomGrantProof{grant, proof}`. Runs
  locally (no homeserver contact) and needs a grant-backed secret.
- `verify_custom_grant_proof(proof, clock_skew_seconds)` → `VerifiedCustomGrantProof{identity`
  (z32)`, client_id, client_public_key` (z32)`, grant_id, capabilities, grant_issued_at, grant_expires_at, proof_issued_at, nonce, data_json}`.
  Verifies offline. Every failure, including an expired grant, is `Validation`.
- **You remain responsible for freshness and replay checks.** Put an audience and a challenge in
  `data_json`. Upstream guide:
  [`CUSTOM_POP.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/CUSTOM_POP.md). Grant
  lifecycle: [`grant-session-lifecycle.md`](https://github.com/pubky/pubky-homeserver/blob/main/docs/grant-session-lifecycle.md).

## Keys and mnemonics (vector, no network)

| Fn | `result[1]` |
| :-- | :-- |
| `generate_secret_key()` | `{secret_key` (64 hex)`, public_key` (z32)`, uri` (`pk:z32`)`}` |
| `get_public_key_from_secret_key(secret_key)` | public key and `uri` |
| `generate_mnemonic_phrase()` | 12-word BIP39 English |
| `mnemonic_phrase_to_keypair(phrase)` | keypair JSON |
| `generate_mnemonic_phrase_and_keypair()` | same, plus `mnemonic` |
| `validate_mnemonic_phrase(phrase)` | `"true"`/`"false"` in **index 1** |
| `create_recovery_file(secret_key, passphrase)` | base64 (errors if either is empty) |
| `decrypt_recovery_file(recovery_file, passphrase)` | hex `secret_key` |

- A secret key is **64 hex chars**. Otherwise you get `Failed to decode secret key` or
  `Failed to convert secret key to 32-byte array`.
- **Mnemonic derivation is FFI-specific.** It uses BIP39 English with `to_seed("")` (empty
  passphrase), and the **first 32 bytes of the seed** become the ed25519 secret. There is no
  SLIP-10/BIP32 path, so other wallets may derive a different key from the same words
  ([`src/keypair.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/keypair.rs#L48-L66)).
- Recovery files are local passphrase-encrypted key backups, not homeserver backup restore
  ([identity](../../pubky/references/concepts.md#identity-the-ed25519-keypair)).

## pkarr / DNS (vector)

- `publish(record_name, record_content, secret_key)` builds a signed packet with **one** TXT record
  (TTL 30). `publish_https` builds one HTTPS/SVCB record (priority 0, TTL 3600). Both return z32.
- **Each publish REPLACES the whole signed packet** (no merge), so publishing under a user's
  identity key can **wipe their `_pubky` homeserver record**
  ([`src/lib.rs`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/src/lib.rs#L962-L1011)).
- `resolve`/`resolve_https` use `ResolvePolicy::CacheFirst`. `resolve` returns `signed_packet`
  (hex), `public_key`/`signature`/`dns_packet` (base64), `timestamp`, `last_seen`,
  `records[{name, ttl, rdata}]`.

## Don't ship `get_signup_token`

`get_signup_token(homeserver_pubky, admin_password)` sends a plain reqwest
`GET https://{homeserver_pubky}/admin/generate_signup_token` with `X-Admin-Password`. It can't
resolve pkarr hosts and doesn't check the HTTP status, so an error body comes back as success.
**The admin password must never ship in a client app.** Don't copy the README samples that call it
([signup tokens](../../pubky/references/auth.md#signup-tokens)).

## Intentionally not bound

Per [`BINDING_PARITY.md`](https://github.com/pubky/pubky-core-ffi/blob/cecd67c161ba/BINDING_PARITY.md):

- reqwest `RequestBuilder`/`Response`/generic bodies.
- Generic `get_json`/`put_json`. Encode and decode your own bytes/JSON.
- PKARR builder closures.
- Raw encrypted relay channel actors.
- Delegated browser PoP callbacks. Mobile exposes local-key grant flows only.
- Filesystem-path session/recovery helpers. Persist the returned secrets and recovery bytes in
  platform storage yourself.
