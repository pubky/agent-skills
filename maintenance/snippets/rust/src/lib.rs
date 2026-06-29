// Compiled-tier fixture: the snippet-test agent appends each Rust snippet here as a
// `snippet_*` fn and runs `cargo clippy --all-features -- -D warnings`. Snippets that need
// execution are instead emitted as a `src/bin/<id>.rs` with a #[tokio::main] that connects
// to the running shared testnet and asserts a roundtrip. Mirrors the KB-v2 lib pattern.
#![allow(unused_imports, unused_variables, dead_code, unused_must_use, unreachable_code)]
