# Self-sovereign DNS and relays (operator)

Run the services that face the DHT: **pkdns** (DNS + DoH resolver for public-key domains),
**pkarr-relay** (HTTP gateway to the DHT), and the **mainline** DHT node underneath both.

**Protocol background is canonical — don't restate it here.**
[`concepts.md` → PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution) covers the
`SignedPacket` layout (1104 bytes max), BEP44 mutable items keyed by `sha1(pubkey)`, expiry and
~hourly republishing, why browsers / UDP-less hosts / AWS-GCP-Azure need relays, PKDNS as the DNS
bridge, and the `_pubky` discovery chain.

> **"Relay" means two unrelated services.** `pkarr-relay` (this file) bridges HTTP and the
> Mainline DHT for PKARR publish/resolve. The Pubky **`http-relay`** is store-and-forward for
> `pubkyauth` and inbox flows — see [`http-relay.md`](http-relay.md).

> **Don't copy from the knowledge-base pkdns or troubleshooting pages.** The pkdns page's TOML
> (`[doh]`, `[rate_limit]`, `[cache]`, `fallback_dns`) matches no pkdns config struct, and these
> don't exist: `-c`, `pkdns-cli --seed/--zone-file/--detect-ip`, a "52-character secret"
> (`generate` writes 64-char hex), `sample-config.toml` (real: `config.sample.toml`),
> `pkdns-linux-x64.tar.gz`. The troubleshooting page's `pkdns resolve` and
> `dig @pkdns.pkarr.org` are also wrong.

Homeserver-side `[pkdns]` settings (`public_ip`, `user_keys_republisher_interval` default
14400 s, `dht_relay_nodes`): [`homeserver.md` → config.toml](homeserver.md#configtoml).

Snippets below were executed on 2026-09-17 against pkdns 0.7.1, pkarr 8.0.1 / pkarr-relay 2.0.1
and mainline 8.0.0 (local builds and a local testnet unless a public host is named).

## pkdns resolver

[`pkdns`](https://github.com/pubky/pkdns) (default branch **`master`**) resolves public-key
domains from PKARR records on the DHT and forwards ICANN names to a fallback resolver.

- **Version:** v0.7.1 (2025-07-21). Not on crates.io.
- **Binaries:** [release assets](https://github.com/pubky/pkdns/releases/latest)
  `pkdns-v0.7.1-{linux-amd64,linux-arm64,osx-amd64,osx-arm64,windows-amd64}.tar.gz`.
- **Docker:** `synonymsoft/pkdns` (contains `pkdns` and `pkdns-cli`).
- **systemd:** [`server/pkdns.service`](https://github.com/pubky/pkdns/blob/master/server/pkdns.service)
  (`ExecStart=/usr/local/bin/pkdns`, `Restart=on-failure`).

> **Old dependencies.** `Cargo.lock` pins **pkarr 3.8.0** and **mainline 5.4.0** (current: 8.0.1 /
> 8.0.0). pkdns behaves like those versions, not like current pkarr docs.

### CLI

From [`server/src/main.rs`](https://github.com/pubky/pkdns/blob/master/server/src/main.rs):

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-f, --forward <IP:Port>` | ICANN fallback (`SocketAddr`: pass `8.8.8.8:53`) | `8.8.8.8:53` |
| `-v, --verbose` | Log every query | off |
| `-p, --pkdns-dir <PATH>` | Data and config directory | `~/.pkdns` |

- **No `-c/--config`** (the README is wrong). Config is read only from `<pkdns-dir>/config.toml`.
- **No `--max-ttl` flag** (`cli/sample/README.md` is wrong). Disable caching with `max_ttl = 0`
  under `[dns]`.

> **Unreachable `forward` = crash at startup.** DHT bootstrap hostnames are resolved through the
> forward resolver; failure panics with `Resolving bootstrap nodes failed`.

### Config: `<pkdns-dir>/config.toml`

> **The file is `config.toml`, not `pkdns.toml`.** The upstream README and
> `docs/dns-over-https.md` still say `pkdns.toml`
> ([actual path](https://github.com/pubky/pkdns/blob/master/server/src/config/persistent_data_dir.rs#L48)).
> A `pkdns.toml` is **silently ignored** and pkdns runs on defaults — including binding
> `0.0.0.0:53`.

If `config.toml` is missing, pkdns writes a template with every value commented out (code
defaults apply). Upstream
[`server/config.sample.toml`](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml),
comments removed:

```toml
[general]
socket = "0.0.0.0:53"
forward = "8.8.8.8:53"
dns_over_http_socket = "127.0.0.1:3000"
verbose = false

[dns]
min_ttl = 60
max_ttl = 86400
query_rate_limit = 100
query_rate_limit_burst = 200
disable_any_queries = false
icann_cache_mb = 100
max_recursion_depth = 15

# [dht]
dht_cache_mb = 100
dht_query_rate_limit = 5
dht_query_rate_limit_burst = 25
top_level_domain = "key"
```

- **Code defaults equal the sample except `dns_over_http_socket`**, which is unset (DoH off).
  Copying the sample as-is enables DoH on `127.0.0.1:3000`.
- **Rate limits:** a *rate* of `0` disables that limiter. A *burst* of `0` does **not** — it
  falls back to the default burst.
- **`dht_query_rate_limit_burst` has no effect** — it is parsed but never used.
- **`top_level_domain = ""`** disables the `.key` TLD.
- **Unknown keys are silently ignored** (no `deny_unknown_fields`) — typos fail quietly.

> **`# [dht]` is commented out in the sample**, so the four DHT keys land in `[dns]` and are
> ignored. The sample works only because the defaults match. To **override** a DHT key, uncomment
> `[dht]`.

> **Default bind `0.0.0.0:53` = open recursive resolver** for ICANN names. On any reachable host:
> - **Firewall UDP/53** to trusted networks.
> - Keep `query_rate_limit` on and set `disable_any_queries = true` (amplification).
> - Don't bind `socket` to `127.0.0.1` as the fix: on macOS that broke ICANN forwarding (every
>   forward failed with `Can't assign requested address (os error 49)` → SERVFAIL).

DNS is **UDP only** (no TCP/53 listener) — map only `53:53/udp`.

### DNS-over-HTTPS

[`docs/dns-over-https.md`](https://github.com/pubky/pkdns/blob/master/docs/dns-over-https.md)
(RFC 8484). **Experimental, off by default.**

- **Enable:** in `<pkdns-dir>/config.toml` under `[general]`, set
  `dns_over_http_socket = "127.0.0.1:3000"`. pkdns serves **plain HTTP** at `/dns-query` and logs
  `[EXPERIMENTAL] DNS-over-HTTP listening on http://{socket}/dns-query.`
- **No TLS** — terminate it at a reverse proxy. Upstream NGINX example:

```nginx
location / {
	proxy_set_header X-Forwarded-For $remote_addr;
	proxy_pass http://127.0.0.1:3000;
}
```

- **Routes:** `GET /dns-query?dns=<base64url, no padding>`; `POST /dns-query` with a raw wire
  body ≤ 65535 bytes.
- **Both require exactly `Accept: application/dns-message`**, else **400**.
- **Response:** `Content-Type: application/dns-message`,
  `Cache-Control: max-age=<lowest answer TTL, default 300>`. CORS allows any origin (GET, POST).

> **Keep the DoH socket on loopback.** Per-IP rate limiting trusts `X-Forwarded-For` whenever it
> parses as an IP. Directly reachable clients can spoof it and bypass limits. The proxy must
> **overwrite** the header (as above).

```bash
# RFC 8484's www.example.com A query; expect 200
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'accept: application/dns-message' \
  'https://pkdns.pubky.org/dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB'
```

### Docker

Upstream [`compose.yaml`](https://github.com/pubky/pkdns/blob/master/compose.yaml). Mount
`/root/.pkdns` to persist `config.toml` and cache.

```yaml
services:
  pkdns:
    image: "synonymsoft/pkdns:latest"
    container_name: pkdns
    ports:
      - "53:53/udp"
    restart: unless-stopped
    command: ["pkdns"]
    # volumes:
    #  - /my/pkdns/folder/location:/root/.pkdns
```

- `"53:53/udp"` publishes on all host interfaces, and Docker's port publishing bypasses host
  firewalls such as ufw. On a reachable host publish on a specific IP (`"<host-ip>:53:53/udp"`).
- **"Address already in use" on 53:** Docker Desktop (macOS) or `systemd-resolved` (Ubuntu) holds
  it. Free the port first.

### Verify, record types, logging

```bash
nslookup 7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy. PKDNS_SERVER_IP
nslookup example.com PKDNS_SERVER_IP
```

- **Use the trailing dot** on the key, or nslookup may append your OS search domain.
- **Verify against your own pkdns.** Upstream
  [`servers.txt`](https://github.com/pubky/pkdns/blob/master/servers.txt) lists `34.65.109.99`,
  `66.78.40.76` and DoH `https://pkdns.pubky.org/dns-query`, but on 2026-09-17 `34.65.109.99`
  and the DoH endpoint returned **NXDOMAIN** for a published key (ICANN names worked) and
  `66.78.40.76` timed out.
- **ICANN names fail:** fix the fallback, e.g. `pkdns -f 8.8.8.8:53`.
- **Browser address bar:** use `http://<key>./` — without the trailing `./` the browser searches.
- **Record types:** the README says only **A, AAAA, TXT, CNAME, MX** (use bind9 for others).
  **HTTPS/SVCB isn't listed**, and the `_pubky` chain depends on them — test before assuming
  pkdns resolves `_pubky` on your version.
- **Logging** ([`docs/logging.md`](https://github.com/pubky/pkdns/blob/master/docs/logging.md)):
  default filter is `pkdns=info,mainline=warn` (startup lines and warnings print; queries don't).
  `--verbose` logs every query. `RUST_LOG` overrides the filter **and makes `--verbose` a no-op**:
  - `RUST_LOG=pkdns=trace` — pkdns itself.
  - `RUST_LOG=pkdns=debug,pkarr=debug,mainline=debug` — DHT issues.

## pkdns-cli (publish your own records)

Separate binary (Docker image or build from the repo). Subcommands take **positional** args
([`cli/src/cli.rs`](https://github.com/pubky/pkdns/blob/master/cli/src/cli.rs)):

- **`generate`** — prints a new **64-char hex** secret key.
- **`publish [seed=./seed.txt] [zonefile=./pkarr.zone]`** — signs and publishes once. First output
  line is `Packet <public-key>`.
- **`resolve <pubkey>`** — looks a key up on the DHT.
- **`publickey [seed]`** — **broken for generated seeds; don't use it.** In 0.7.1 it only parses
  legacy 52-char z-base-32, so every hex seed fails with
  `Failed to parse the seed file. <err> <SEED>` — **echoing the secret to stderr**.

```bash
umask 077
pkdns-cli generate > seed.txt             # the secret key (64-char hex); protect it like a private key
# Do NOT run `pkdns-cli publickey seed.txt` on a generated seed: in 0.7.1 it only parses the
# legacy 52-char zbase32 format, fails on hex, and echoes the secret seed in its error.
pkdns-cli publish seed.txt pkarr.zone     # publishes once, then exits; first line is "Packet <public-key>"
                                          # exits 0 even on failure: check for "Successfully announced."
pkdns-cli resolve <public-key>
```

> **`publish` is one-shot and its exit code lies.** It calls `client.publish(&packet, None)` once,
> prints `Successfully announced.` and returns (`cli/sample/README.md` and `docs/dyn-dns.md`
> wrongly claim it repeats every 60 min). On failure it prints `Error …` and **still exits 0**.
> Schedule republishing yourself (~hourly, cron or systemd timer) and have the wrapper **grep for
> `Successfully announced.`**, not `$?`.

> **Protect the seed.**
> - An unparseable seed makes `publish` print its **raw contents** to stderr
>   (`Failed to parse the seed file. {e} {seed}`) — under cron/journald the secret lands in logs.
>   For `publickey` this is the normal path for every hex seed.
> - `cli/sample/seed.txt` is **publicly committed**. Never use it for a real domain.

- **Seed parsing (`publish` only):** a trimmed 52-char seed is decoded as legacy z-base-32; any
  other length as hex (first 32 bytes). The "tries hex first" doc comment is wrong.
- **Zone file:** a normal DNS zone **without SOA**.
- **Dynamic DNS:** `{external_ipv4}` / `{external_ipv6}` are replaced at publish time via external
  IP-lookup services. **Panics if lookup fails.**

Sample [`cli/sample/pkarr.zone`](https://github.com/pubky/pkdns/blob/master/cli/sample/pkarr.zone):

```text
$TTL 60

@      IN    A      127.0.0.1
dynv4  IN    A      {external_ipv4}
dynv6  IN    AAAA   {external_ipv6}

text   IN    TXT    hero=satoshi2
```

## pkarr-relay

[`pkarr-relay`](https://github.com/pubky/pkarr/blob/main/relay/README.md) is an HTTP gateway +
cache for PKARR publish/resolve over the Mainline DHT, for clients that can't use UDP (browsers/
WASM, restricted VMs/containers, firewalled networks). Spec:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md).
Crate **2.0.1** (released with pkarr **v8.0.1**); default branch `main`.

### Install and run

```bash
cargo install pkarr-relay

pkarr-relay

pkarr-relay --config ./config.toml

pkarr-relay --tracing-env-filter pkarr_relay=debug,tower_http=debug
```

Flags ([`relay/src/main.rs`](https://github.com/pubky/pkarr/blob/main/relay/src/main.rs)):

- **`-c, --config <PATH>`**.
- **`-t, --tracing-env-filter <FILTER>`** — kebab-case (`--tracing_env_filter` is rejected).
  Default `pkarr_relay=info,tower_http=debug`.
- **`--testnet`** (local testnet, port 15411) exists only with the non-default `testnet` feature —
  **not** in a plain `cargo install pkarr-relay`.

> **Binds `0.0.0.0:<http.port>`** (default 6881) unconditionally. Restrict with a firewall or
> reverse proxy.

> **Rate limiting depends on how you start it.** No `--config` → built-in limits on. With
> `--config`, **omitting `[rate_limiter]` disables rate limiting entirely.**

### Config

Commented source:
[`relay/src/config.example.toml`](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml).
Key values:

```toml
[http]
port = 6881

[mainline]
port = 6881
# public_ip = "203.0.113.10"

[cache]
path = "./cache"
size = 1_000_000
minimum_ttl =  300
maximum_ttl =  86400

[rate_limiter]
behind_proxy = false
quota = "2r/s"
burst = 10
dht_quota = "2r/s"
dht_burst = 10
user_dht_quota = "2r/s"
user_dht_burst = 10
```

- **`quota`/`burst`:** per-IP HTTP limit on **every** request (GET, PUT, index, cache hits).
- **`dht_quota`/`dht_burst`:** per-peer-IP limit on incoming DHT requests to the internal node.
- **`user_dht_quota`/`user_dht_burst`:** only requests that reach the DHT — PUT, cache-miss GET,
  expired `CacheFirst`, `NetworkOnly`. Cache hits and `CacheOnly` don't count.
- **`[mainline].public_ip`:** known IPv4, used for the BEP42 node ID.
- **`[http]`** also accepts `max_connections` (1024) and `max_connection_age_seconds` (300);
  both must be > 0. `minimum_ttl` must be ≤ `maximum_ttl`.

> **Set `cache.path`.** Without it every start uses a fresh temp cache and logs
> `Cache path is not configured, running ephemeral Relay`.
> - A **relative** path resolves against the config file's directory and **must already exist**
>   (else `failed to canonicalize ./cache`). Absolute paths are used as-is.
> - Data goes in a `pkarr-cache` subdirectory.
> - Opening LMDB is `unsafe` (a corrupted lock file is UB): never share one cache directory
>   between relays.

> **`behind_proxy = true` only when actually behind a proxy.** It trusts forwarding headers; if
> clients can also reach the relay directly, they spoof IPs and bypass every IP rate limit.

### HTTP API

Full status/header semantics: [`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md)
and [`relay/src/handlers.rs`](https://github.com/pubky/pkarr/blob/main/relay/src/handlers.rs).
Operator-relevant points:

- **Routes:** `GET /` (HTML status page), `GET /{key}`, `PUT /{key}`. CORS is permissive and
  exposes `Pkarr-Invalid-Signed-Packet-Seq` and `Pkarr-Dht-Stored-Nodes`.
- **`{key}` is raw z-base-32** (`publicKey.z32()`), **not** `pubky…` (that returns 400). See
  [public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).
  `pk:` / `http(s)://` prefixes, subdomains and a trailing dot are also accepted.
- **PUT body:** `signature(64) + timestamp(8, BE microseconds) + DNS packet(<1000)`; the relay adds
  the key from the path. Body must arrive within 30 s.
  - `204` stored (`Pkarr-Dht-Stored-Nodes: <n>`); `409` a newer packet exists (`NotMostRecent`);
    `429` HTTP or `user_dht_quota` limit; `500` DHT failure.
  - **Size:** `413` only above **1104** bytes; **1073–1104** bytes returns `400` (spec says 413
    above 1072).
  - **No `If-Match` CAS** — 412/428 no longer exist.
- **GET `?policy=`** (case-sensitive; default `CacheFirst`; old `LocalOrRelayCacheOnly` /
  `DhtNetworkOnly` return 400):
  - `CacheFirst` — serve unexpired cache; else query the DHT (cached timestamp as minimum), return
    the first acceptable answer, keep refreshing the cache in the background.
  - `CacheOnly` — never touches the DHT; 404 if uncached.
  - `NetworkOnly` — skip the cache; newest packet on the DHT.
- **GET responses:** `200` with `Cache-Control: public, max-age=<TTL clamped to cache min/max>`,
  `Last-Modified`, `memento-datetime`; `304`, `400`, `404` (may carry
  `Pkarr-Invalid-Signed-Packet-Seq`), `429`, `503` (no DHT nodes queried / no usable answer).

> **Public relay ≠ bare relay.** On 2026-09-17 `https://pkarr.pubky.org` sat behind nginx
> (`x-ratelimit-limit: 120`), returned `max-age=300`, and sent **no `memento-datetime`**. Don't
> depend on that header through a proxy.

BEP44 mapping ([`design/base.md`](https://github.com/pubky/pkarr/blob/main/design/base.md)):
`k` = public key, `seq` = timestamp (µs), `sig` = signature, `v` = DNS packet, `salt` ignored;
signed bytes `3:seqi<seq>e1:v<len>:<v>`.

```bash
KEY=7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy   # raw z-base-32, no "pubky" prefix
curl -fsI "https://pkarr.pubky.org/$KEY" >/dev/null && echo "on DHT" || echo "NOT on DHT"
# Skip your own relay's cache and query the DHT directly:
curl -sI "http://localhost:6881/$KEY?policy=NetworkOnly"
```

### Docker and health

pkarr repo [`docker-compose.yml`](https://github.com/pubky/pkarr/blob/main/docker-compose.yml);
the Dockerfile `CMD` is `pkarr-relay --config=/config.toml`.

```yaml
services:
  pkarr-relay:
    build: .

    # need both TCP and UDP
    ports:
      - "6881:6881/tcp"
      - "6881:6881/udp"

    volumes:
      # config file
      - ./relay/src/config.example.toml:/config.toml:ro
      # pkarr cache location, must match [cache].path in config
      - pkarr-cache:/cache

    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:6881/"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

volumes:
  pkarr-cache:
```

- **Open both** TCP 6881 (HTTP) and UDP 6881 (DHT node).
- `/cache` works because `./cache` resolves relative to `/config.toml`.
- **`GET /`** shows version, cache size/capacity/utilization, DHT port, firewalled status and DHT
  size estimate — use it for liveness probes.

### Public relays and pointing clients at yours

- [`relays.txt`](https://github.com/pubky/pkarr/blob/main/relays.txt): `https://pkarr.pubky.app`,
  `https://pkarr.pubky.org`, `https://relay.pkarr.org`. `pkarr::DEFAULT_RELAYS` has only the
  first two.
- **JS/WASM SDK:** [`sdk-js.md` → WASM needs PKARR relays](../../pubky/references/sdk-js.md#wasm-needs-pkarr-relays).
- **Rust pkarr on WASM:** `default-features = false, features = ["relays"]`;
  `wasm32-unknown-unknown` only, not WASI. (Upstream `docs/integration.md` WASM setup still pins
  pkarr `"7"` — use 8.)

Rust backend options (adapted from the
[integration guide](https://github.com/pubky/pkarr/blob/main/docs/integration.md#client-configuration);
block 3 corrected):

```rust
// Relays only (required for WASM, optional for firewall-restricted environments)
let client = Client::builder()
    .no_dht()
    .build()?;

// Start without either default backend, then enable only your relays
let client = Client::builder()
    .no_default_network()
    .relays(&["https://my-relay.example.com"])?
    .build()?;

// Extend defaults with additional nodes.
// Caveat: `extra_bootstrap` appends to the *configured* list, which is empty until set, so on a
// default builder it REPLACES mainline's default bootstrap nodes. List the defaults explicitly
// (pkarr does not re-export `mainline`; depend on the same major version pkarr uses).
let mut bootstrap = mainline::DEFAULT_BOOTSTRAP_NODES.to_vec();
bootstrap.push("my-bootstrap.example.com:6881");
let client = Client::builder()
    .bootstrap(&bootstrap)
    .extra_relays(&["https://my-relay.example.com"])?
    .build()?;
```

> **Don't use `.extra_bootstrap()` on a default builder** (pkarr 8.0.1 bug,
> [`builder.rs`](https://github.com/pubky/pkarr/blob/main/pkarr/src/client/builder.rs)): it
> replaces the default bootstrap list, the DHT never bootstraps, and resolves fail with
> `NoDhtNodesQueried`. `.extra_relays()` does extend `DEFAULT_RELAYS` correctly.

## Republishing

DHT records expire — why and how often:
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution). Who republishes:

- **Homeservers:** their own user keys ([`homeserver.md`](homeserver.md#configtoml)).
- **`pkdns-cli`:** nobody — use an external scheduler that checks output (see above).
- **Custom Rust publisher:** the upstream pattern below
  ([integration guide](https://github.com/pubky/pkarr/blob/main/docs/integration.md#republishing-patterns)).

Rules:

- The pkarr client **doesn't serialize concurrent publishes for the same key**. Run
  resolve → build → publish one at a time per key; on `NotMostRecent`, resolve with `NetworkOnly`
  before retrying.
- **Relay-only clients:** raise `request_timeout` above the 2 s default. Relay PUTs take ~3 s
  while the relay publishes to the DHT, and failed with `publish query received no responses`.

```rust
use pkarr::{errors::PublishError, Client, SignedPacket};
use std::time::Duration;

async fn republish_loop(
    client: Client,
    build_packet: impl Fn() -> SignedPacket,
) {
    let interval = Duration::from_secs(3600); // Republish hourly

    loop {
        let packet = build_packet();

        match client.publish(&packet).await {
            Ok(stored_on) => {
                println!("Republished successfully; stored on at least {stored_on} DHT nodes")
            }
            Err(PublishError::NotMostRecent) => {
                eprintln!("A newer packet exists; resolve NetworkOnly before retrying")
            }
            Err(error) => eprintln!("Republish failed: {error}"),
        }

        tokio::time::sleep(interval).await;
    }
}
```

**Cache TTLs:** pkarr client bounds default to `DEFAULT_MINIMUM_TTL = 300` s and
`DEFAULT_MAXIMUM_TTL = 86400` s. pkdns bypasses them (`minimum_ttl(0)`/`maximum_ttl(0)`) and uses
its own LRU cache sized by `dht_cache_mb`, refreshed per `[dns] min_ttl`/`max_ttl`.

## mainline (the DHT node)

[`mainline`](https://github.com/pubky/mainline) ([docs.rs](https://docs.rs/mainline)) **8.0.0**;
pkarr 8 depends on it.

- **BEPs:** BEP5 (DHT), BEP42 (security), BEP43 (read-only nodes), BEP44 (mutable data), in client
  and server modes; plus vertical-Sybil defences.
- **Clouds:** DHT nodes often block AWS/GCP/Azure ranges — use relays there
  ([`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution)).

README errors: `Dht::builder::server_mode()` should be `Dht::builder().server_mode()`, and
`.public_ip()` takes an `Ipv4Addr`. Corrected:

```rust
use mainline::Dht;
use std::net::Ipv4Addr;

let dht = Dht::client()?; // Adaptive: starts as a client (no incoming requests), switches to server
                          // mode after ~15 min if publicly reachable
let dht = Dht::server()?; // server mode from the start: also routes and stores for the network

// Force server mode and pin a known public IPv4 instead of relying on peer votes
let dht = Dht::builder()
    .server_mode()
    .public_ip(Ipv4Addr::new(203, 0, 113, 10))
    .build()?;
```

- **No built-in rate limiting.** Supply a request filter
  ([`examples/request_filter.rs`](https://github.com/pubky/mainline/blob/main/examples/request_filter.rs));
  it runs after parsing and doesn't affect incoming responses. pkarr-relay installs `dht_quota`
  this way.
- **Port:** default UDP **6881**; if taken, the node **silently picks a random port**. An explicit
  port that fails to bind is an error. IPv4 only.
- **Bootstrap nodes (`DEFAULT_BOOTSTRAP_NODES`):** `router.bittorrent.com:6881`,
  `dht.transmissionbt.com:6881`, `dht.libtorrent.org:25401`, `relay.pkarr.org:6881`.
- **Breaking changes:** 8.0.0 rejects malformed mutable PUTs and changes mutable-item error/
  conversion APIs; 7.0.0 moved blocking ops to `Dht::as_async()` and puts to `PutOutcome`.
  Details: [CHANGELOG](https://github.com/pubky/mainline/blob/main/CHANGELOG.md).
