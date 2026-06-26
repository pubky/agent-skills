---
name: pubky-mobile
description: "Use when building a native mobile app on Pubky for iOS or Android, via React Native (@synonymdev/react-native-pubky) or the UniFFI-generated Swift/Kotlin/Python bindings (pubky-core-ffi). Covers native module install/linking, key generation and recovery files, homeserver signUp/signIn/session lifecycle, pubky:// put/get/list/delete from mobile, the Result/isErr() and [error,data] response contracts, the documented FFI String Contracts (do not change output formats), the MANDATORY Android rustls TLS init at startup before any handshake, and integrating the Pubky Ring authenticator's pubkyauth:// and pubkyring:// deeplink authorization (capabilities, relay+secret, QR/animated-frame input, session revoke). NOT for web/server SDK usage (use pubky) and NOT for operating backend infrastructure (use pubky-infra)."
metadata:
  author: pubky
  version: "0.1.0"
---

# Pubky — build native mobile apps

Same protocol as the **`pubky`** skill, different toolchain (React Native, UniFFI
Swift/Kotlin). This skill does **not** re-teach identity, auth theory, or the data spec — for
those, read the `pubky` skill's `references/concepts.md`, `references/auth.md`, and
`references/app-specs.md`. Here we map those concepts onto the mobile packages and cover the
mobile-only gotchas that bite in production.

## Safety-critical (do not skip)

- **Android TLS init.** Call the rustls initializer **at app startup, before any homeserver
  handshake**. Skipping it makes the first network call fail. See `references/native-ffi.md`.
- **FFI String Contracts.** The native bindings return strings in documented formats — do not
  reshape or "clean up" their output; downstream parsing depends on the exact contract.
- **`[error, data]` / `isErr()` responses.** Mobile calls return a result envelope, not a
  thrown exception. Always check the error arm before using the value.

## Where to look

| Task | Read |
| :-- | :-- |
| React Native API surface (`@synonymdev/react-native-pubky`): auth/Ring, homeserver lifecycle, keys, data ops, pkarr, `isErr()` | `references/react-native.md` |
| Native FFI (`pubky-core-ffi`): per-platform build, XCFramework/Kotlin, String Contracts, `[error,data]`, session-secret format, Android `rustls` init | `references/native-ffi.md` |
| Pubky Ring integration: `pubkyauth://` / `pubkyring://` deeplinks, capabilities, relay+secret, QR/animated frames, session revoke | `references/ring-auth.md` |
| Map of core Pubky concepts → mobile method names (defers theory to the `pubky` skill) | `references/concepts-pointer.md` |

For the shared protocol concepts, the `pubkyauth` flow, and the data spec, read the
**`pubky`** skill's references — do not duplicate them here.
