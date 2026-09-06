# Self-sovereign DNS and relays (operator)

This file is the operator "how to run it" surface for the DHT-facing edge: the **pkdns**
resolver, the **pkarr-relay**, and the **mainline** DHT node beneath them.

The protocol "why" is **canonical** in
[`concepts.md` → PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution) —
PKARR resolution, the `SignedPacket` layout, BEP44 mutable items, ephemeral records + ~hourly
republish, why UDP-less / browser environments need HTTP relays, and the `_pubky`
homeserver-discovery record chain all live there. Read it first; this file does not restate it.

> **Two different "relays."** `pkarr-relay` (this file) bridges browsers/WASM to the **Mainline
> DHT** for PKARR publish/resolve. The Pubky-core **`http-relay`** is an unrelated
> store-and-forward service for `pubkyauth` and inbox flows — see
> [`http-relay.md`](http-relay.md). Do not conflate them.

## pkdns resolver

[`pkdns`](https://github.com/pubky/pkdns) is a DNS server that resolves self-sovereign,
public-key domains from records published on the Mainline DHT (powered by pkarr), with ICANN
fallback for normal domains. Run it to bridge sovereign public-key domains into ordinary DNS —
including for browsers, which can point their native DoH setting at a pkdns server without
changing system DNS. Demo key used throughout the docs:
`7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy`.

> pkdns's default branch is **`master`** (not `main`); pinned clone HEAD `221fe94`. Link file
> URLs with `/blob/master/`.

### Run it

The pkdns **server** binary's actual clap CLI
([`server/src/main.rs`](https://github.com/pubky/pkdns/blob/master/server/src/main.rs)) defines
only three real flags plus auto `--help`/`--version`:

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-f, --forward <IP:Port>` | ICANN fallback DNS server | `8.8.8.8:53` |
| `-v, --verbose` | Log all queries | `false` |
| `-p, --pkdns-dir <PATH>` | Base data/config dir | `~/.pkdns` |

> **Stale README warning.** The README's "Options" block also lists `-c, --config <CONFIG>`.
> **That flag does not exist** in the server binary at `221fe94`. Configuration is read **only**
> from `<pkdns-dir>/pkdns.toml`. Do not pass `--config` / `-c` — it errors. (Earlier versions of
> this skill copied that stale block; ignore it.)

`pkdns --verbose` is the simplest start.

### Config file

Extended config lives at `~/.pkdns/pkdns.toml` (sample:
[`server/config.sample.toml`](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml)) —
link it rather than trusting a copy. Faithful shape, with **corrected** comments:

```toml
[general]
socket = "0.0.0.0:53"                     # DNS UDP listen — ALL interfaces by default (see warning)
forward = "8.8.8.8:53"                    # ICANN fallback
dns_over_http_socket = "127.0.0.1:3000"   # [EXPERIMENTAL] DoH; disabled (unset) by default
verbose = false

[dns]
min_ttl = 60
max_ttl = 86400                           # set to 0 to DISABLE caching (no CLI flag exists for this)
query_rate_limit = 100                    # per-IP qps; 0 disables
query_rate_limit_burst = 200
disable_any_queries = false               # true mitigates DNS amplification
icann_cache_mb = 100
max_recursion_depth = 15

# [dht]   <-- in the sample this section header is COMMENTED OUT (see quirk below)
dht_cache_mb = 100
dht_query_rate_limit = 5                  # per-IP DHT qps; 0 disables
dht_query_rate_limit_burst = 25
top_level_domain = "key"                  # "" disables the public-key TLD
```

> **Security — default bind is `0.0.0.0:53` (all interfaces), not local-only.** pkdns's
> `default_socket()` binds **every** interface, exposing it as an **open recursive resolver**.
> The README's mention of `127.0.0.1` is the IP you **query** when testing locally, not the bind
> address. Bind to `127.0.0.1:53` (or a specific interface) and/or firewall UDP/53, and set
> `disable_any_queries = true` to blunt DNS-amplification abuse.

> **`# [dht]` quirk — the override gotcha.** `ConfigToml` has three real sections
> `[general]`/`[dns]`/`[dht]` with no `deny_unknown_fields`. In the sample the `# [dht]` header
> is **commented out**, so the four keys under it (`dht_cache_mb`, `dht_query_rate_limit`,
> `dht_query_rate_limit_burst`, `top_level_domain`) actually parse under `[dns]` and are
> **silently ignored**; the real `[dht]` struct falls back to defaults. Those defaults *happen to
> equal* the sample's values (`100`, `5`, `25`, `top_level_domain = "key"`), so copying verbatim
> changes nothing. But to **override** any DHT setting — e.g. `top_level_domain = ""` to disable
> the public-key TLD — you **must uncomment the `[dht]` header**, or the override is dropped.

> **Disabling caching while testing.** There is **no `--max-ttl` CLI flag** (the upstream sample
> README and older skill text are wrong). Set `max_ttl = 0` in the `[dns]` section. By default
> pkdns caches DHT packets for at least `min_ttl = 60s`.

### DNS-over-HTTPS (browsers)

pkdns supports DoH per
[RFC 8484](https://github.com/pubky/pkdns/blob/master/docs/dns-over-https.md). Setting
`dns_over_http_socket = "127.0.0.1:3000"` makes pkdns serve **plain HTTP** (not HTTPS) at
`http://127.0.0.1:3000/dns-query`. It is **experimental and disabled by default**. At startup
pkdns logs `[EXPERIMENTAL] DNS-over-HTTP listening on http://{socket}/dns-query.`. Terminate TLS
with a reverse proxy (e.g. NGINX + Let's Encrypt):

```nginx
location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://127.0.0.1:3000;
}
```

Browsers (Firefox/Chrome/Brave/Edge) support DoH natively — point them at your HTTPS-fronted DoH
endpoint, no system-DNS change needed.

### pkdns Docker

pkdns ships [`synonymsoft/pkdns`](https://github.com/pubky/pkdns/blob/master/compose.yaml).
Mount a volume at `/root/.pkdns` to persist cache + config:

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

> **Port 53 conflict ("Address already in use").** Docker Desktop occupies UDP/53 on macOS;
> `systemd-resolved` occupies it on Ubuntu. Free the port before binding pkdns to 53.

### Verify resolution

```bash
# Resolve a public-key domain via pkdns (replace PKDNS_SERVER_IP)
nslookup 7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy PKDNS_SERVER_IP

# Resolve a normal ICANN domain (tests fallback)
nslookup example.com PKDNS_SERVER_IP
```

If ICANN domains fail, set the fallback explicitly: `pkdns -f 8.8.8.8:53`.

> **Browser gotcha.** Always append a trailing `./` to a public-key domain in the address bar
> (`http://<pubkey>./`), or browsers treat it as a search query instead of resolving the site.

### Served record types

The resolver currently serves **A, AAAA, TXT, CNAME, MX** from DHT-published packets; the README
says to use bind9 for any other type. Note this list does **not** mention HTTPS/SVCB, which the
`_pubky` homeserver-discovery chain relies on and which pkarr `SignedPacket`s do support (see
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution)). Treat the README list as
possibly incomplete or version-dependent — verify against the pkdns version you deploy if you
rely on HTTPS/SVCB resolution through pkdns.

### Logging

pkdns is silent by default; `--verbose` logs all queries. For finer control use `RUST_LOG`
(see [`docs/logging.md`](https://github.com/pubky/pkdns/blob/master/docs/logging.md)):
`RUST_LOG=pkdns=trace` (chatty), `RUST_LOG=mainline=debug` (DHT), or combined
`RUST_LOG=pkdns=debug,pkarr=debug,mainline=debug` to investigate the DHT.

### Hosted servers

From [`servers.txt`](https://github.com/pubky/pkdns/blob/master/servers.txt): plain-DNS IPs
`34.65.109.99` and `66.78.40.76`; DoH endpoint `https://pkdns.pubky.org/dns-query`.
Zone-explorer demo app: <https://pkdns.net/>. README demo: <http://pkdns-demo.pubky.app/>.

## pkdns-cli (publishing)

`pkdns-cli` is a **separate** binary from the pkdns server, used to publish records to the DHT
under your key. Subcommands
([`cli/src/cli.rs`](https://github.com/pubky/pkdns/blob/master/cli/src/cli.rs)):

| Command | Does |
| :-- | :-- |
| `generate` | Print a new seed: a 64-char hex string (`hex::encode` of the 32-byte secret key) |
| `publickey [seed]` | Derive the public key from a seed (default `./seed.txt`) |
| `publish [seed] [zonefile]` | Publish a DNS zone file under the seed (defaults `./seed.txt` + `./pkarr.zone`) |
| `resolve <pubkey>` | Resolve a public-key domain on the DHT |

Seed parsing for `publish` is **length-gated**, not try-then-fallback: a **52-char** seed is
parsed as the **old zbase32** format, **any other length** as **64-char hex** (32-byte secret
key). The zone file is a standard DNS zone **without an SOA record**.

> **`publish` is one-shot — it does NOT republish.** At `221fe94`, `cli_publish`
> ([`cli/src/commands/publish.rs`](https://github.com/pubky/pkdns/blob/master/cli/src/commands/publish.rs))
> reads the seed + zone, signs one `SignedPacket`, calls `client.publish(&packet, None)` **once**,
> prints `Successfully announced.`, and **returns**. There is **no 60-minute republish loop** and
> no Ctrl-C wait in the code — this contradicts both earlier skill text and the upstream sample
> README. Because DHT records are ephemeral (canonical in
> [`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution)), to keep a key alive you
> must wrap `publish` in an external scheduler (cron / a systemd timer, ~hourly) or rely on the
> homeserver / pkarr republisher. Do not claim this command auto-republishes.

**DynDNS.** In the zone file, the literals `{external_ipv4}` / `{external_ipv6}` are replaced by
`pkdns-cli` (`fill_dyndns_variables`) with the host's actual external IP — resolved via
external-IP provider services — at publish time. Combined with an external republish schedule
this keeps a public-key domain pointed at a dynamic IP (doc:
[`docs/dyn-dns.md`](https://github.com/pubky/pkdns/blob/master/docs/dyn-dns.md); sample:
[`cli/sample/pkarr.zone`](https://github.com/pubky/pkdns/blob/master/cli/sample/pkarr.zone)):

```text
$TTL 60

@      IN    A      127.0.0.1
dynv4  IN    A      {external_ipv4}
dynv6  IN    AAAA   {external_ipv6}

text   IN    TXT    hero=satoshi2
```

## pkarr-relay

A [`pkarr-relay`](https://github.com/pubky/pkarr/blob/main/relay/README.md) relays PUT/GET
between HTTP clients and the Mainline DHT. UDP-less environments — browsers, WASM, many VMs and
containers, firewalled networks — cannot open the UDP sockets the DHT runs on, so they publish
and resolve over HTTP through a relay (spec:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md)). The full "why
browsers need this" rationale is canonical in
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution) — link, don't restate.
**Public relays MUST set CORS headers.**

> pkarr's default branch is **`main`**; pinned clone HEAD `04c04cc`.

### Install and run

```bash
cargo install pkarr-relay

pkarr-relay --config=./config.toml

pkarr-relay -t=pkarr=debug,tower_http=debug
```

CLI flags ([`relay/src/main.rs`](https://github.com/pubky/pkarr/blob/main/relay/src/main.rs),
clap derive): `--config`/`-c <path>` (optional), `--tracing_env_filter`/`-t <filter>` (default
`pkarr_relay=info,tower_http=debug`), and `--testnet` (runs a relay on a **local testnet** on
port `15411`, handy for local-stack dev). With no flags it runs `Relay::builder().run()` at
`http://localhost:6881`.

### HTTP API

The relay key in the path is the **raw z-base-32 public key** (`publicKey.z32()`), **not** the
`pubky`-prefixed display form. The `PublicKeyParam` extractor
(`relay/src/extractors.rs`) feeds `PublicKey::from_str`, which rejects a 57-char `pubky<z32>`
string (it z32-decodes to ~35 bytes → `InvalidPublicKeyLength` → `400`). Note: in **pkarr core**,
`PublicKey`'s `Display` already emits **raw z32 with no `pubky` prefix** — the `pubky` prefix is a
pubky-homeserver wrapper concept. `from_str` is otherwise lenient (accepts `pk:<z32>`,
`http(s)://<z32>`, `sub.<z32>`, trailing dot, path/query/port). HTTP shapes below match
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md); `?policy=` and
most status codes come from `relay/src/handlers.rs` (the `413` body limit comes from a
`DefaultBodyLimit` layer in `relay/src/lib.rs` — see the error table). The `GET` response
status + headers below were verified live against a local `--testnet` relay (`200`, `content-type`,
`cache-control`, `last-modified`).

```http
PUT /:z-base32-encoded-key HTTP/2
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, PUT, OPTIONS
If-Match: 1741107004412159

<body>

--- response ---
HTTP/2 204 NO CONTENT

GET /:z-base32-encoded-key HTTP/2
If-Modified-Since: Fri, 18 Oct 2024 13:24:21 GMT

--- response ---
HTTP/2 200 OK
Content-Type: application/pkarr.org/relays#payload
Cache-Control: public, max-age=300
Last-Modified: Fri, 18 Oct 2024 13:24:21 GMT
Memento-Datetime: Fri, 8 May 2026 04:21:21 GMT

<body>
```

- **PUT** verifies the signature before the DHT put; supports `If-Match` CAS (the value is a
  utf8 `u64` timestamp).
- **GET** is a DHT mutable get; supports `If-Modified-Since` (relay answers `304 Not Modified`
  when `If-Modified-Since >= packet timestamp`), and returns `Cache-Control: public,
  max-age=<min ttl>` plus `Memento-Datetime` (when the packet was last observed on the DHT).
- Optional **`?policy=`** maps to `ResolvePolicy`: `CacheFirst` (**default** — serve unexpired
  cache per min/max TTL, else hit the DHT and return the first response while completing in the
  background via `tokio::spawn`), `LocalOrRelayCacheOnly` (cache only; `404` if absent, never
  touches the DHT, consumes no `user_dht_quota`), `DhtNetworkOnly` (always query the DHT). The
  per-IP `user_dht_quota` is enforced for PUTs, `CacheFirst` misses/expired, and `DhtNetworkOnly`
  — not for cache hits or `LocalOrRelayCacheOnly`.

**PUT errors:** `400` invalid key/signature/DNS packet — **also** any well-formed body of
1073–1104 bytes (passes the body limit, then fails `SignedPacket` size verification) · `409`
timestamp older than what the server/DHT already saw (BEP44 code 302, `NotMostRecent`) · `412`
`If-Match` CAS failed (BEP44 code 301) · `413` request **body > 1104 bytes** (the
`DefaultBodyLimit::max(1104)` layer, *not* the 1072 logical payload cap) · `428` server already
publishing another packet for this key, `If-Match` required · `429` per-IP rate limited. **GET
errors:** `400` invalid key · `404` not found.

**Two distinct size numbers — don't conflate them.** A **valid** relay payload is at most
**1072 bytes**: `signature(64) + timestamp(8, big-endian UNIX microseconds) + dns-packet(<1000
bytes)`. That's `SignedPacket::MAX_BYTES` (1104) **minus** the 32-byte public key carried in the
URL path (`1104 − 32 = 1072`). But the relay's enforced **HTTP body limit is 1104**
(`DefaultBodyLimit::max(1104)`), so a body of **1073–1104 bytes returns `400`** (passes the body
limit, then fails `SignedPacket` verification) and **only `>1104` returns `413`**. The DNS packet
itself errors past 1000 bytes. Formal ABNF:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md); the full
`SignedPacket` layout is canonical in
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution).

### Relay config

[`relay/src/config.example.toml`](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml)
(link rather than mirror; decision + gotcha fields shown):

```toml
[http]
port = 6881

[mainline]
port = 6881              # internal DHT node (UDP) — drives the TCP+UDP Docker requirement

[cache]
path = "./cache"         # must match the Docker cache mount; stored under a `pkarr-cache` subdir
size = 1_000_000         # max SignedPackets before evicting oldest
minimum_ttl = 300        # also drives GET `Cache-Control: max-age`
maximum_ttl = 86400

[rate_limiter]           # omit the whole section to disable rate limiting
behind_proxy = false     # see security gotcha
quota = "2r/s"           # HTTP request quota per IP
burst = 10
dht_quota = "2r/s"       # incoming DHT request quota per DHT peer IP
dht_burst = 10
user_dht_quota = "2r/s"  # user-initiated DHT ops/IP: PUTs, GET cache misses, expired CacheFirst,
                         # DhtNetworkOnly. Cache hits + LocalOrRelayCacheOnly do NOT consume it.
user_dht_burst = 10
```

> **Security gotcha — `behind_proxy`.** Set `behind_proxy = true` **only** when the relay sits
> behind a reverse proxy (it then trusts real-IP headers). If you set it true while the relay is
> **also** directly reachable, an attacker can spoof that header to a random IP per request and
> bypass IP rate limiting entirely. Keep direct access blocked whenever `behind_proxy = true`.

### Relay Docker

```yaml
services:
  pkarr-relay:
    build: .
    # need both TCP and UDP
    ports:
      - "6881:6881/tcp"
      - "6881:6881/udp"
    volumes:
      - ./relay/src/config.example.toml:/config.toml:ro
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

> **Gotcha — TCP *and* UDP.** The relay needs **both** on 6881: TCP for the HTTP relay API, UDP
> for its internal Mainline DHT node. Mount the config to `/config.toml:ro` and the cache volume
> to `/cache` (must match `[cache].path`).

### Health and monitoring

`GET /` serves an HTML status page (`handlers.rs` `index`): version; cache
size/capacity/utilization %; DHT node port (public address or local addr), node firewalled bool,
and a DHT-size estimate ± confidence %. Reuse the Docker healthcheck probe
(`wget http://localhost:6881/`) for liveness monitoring.

### Public relays

From [`relays.txt`](https://github.com/pubky/pkarr/blob/main/relays.txt): `https://pkarr.pubky.app`,
`https://pkarr.pubky.org`, `https://relay.pkarr.org`. These are what a JS/browser client's
`pkarr.relays` config typically points at.

> **Resolvers are deprecated.** Older "Resolvers" (well-known long-running caching DHT nodes)
> are deprecated; [`design/resolvers.md`](https://github.com/pubky/pkarr/blob/main/design/resolvers.md)
> advises combining a DHT client with an HTTP client to use **Relays** instead. An org running a
> Resolver may expose the same node/cache over HTTP via the relay GET endpoint. Mentioned only as
> historical context — do not present Resolvers as the recommended path.

## mainline (the DHT)

[`mainline`](https://github.com/pubky/mainline) (crate `7.0.0`,
[docs.rs/mainline](https://docs.rs/mainline)) is the Rust client/server for BitTorrent's Mainline
DHT, where pkarr stores records. Supported BEPs: **BEP-5** (DHT protocol), **BEP-42** (security
extension / Sybil resistance), **BEP-43** (read-only nodes), **BEP-44** (storing arbitrary /
mutable data — how pkarr `SignedPacket`s are stored). It includes measures against vertical Sybil
attacks (`docs/sybil-resistance.md`).

**Node modes** — operator-relevant for whether a self-hosted node contributes routing/storage:

```rust
use mainline::Dht;

// client mode: store/query, accept no incoming requests
let dht = Dht::client().unwrap();

// server mode: also route/store for the network
let dht = Dht::server().unwrap();
// equivalently, and to pin a known public IP:
let dht = Dht::builder().server_mode().public_ip(/* ip */).build();
```

- **client** (`Dht::client()`): stores/queries values, accepts no incoming requests.
- **server** (`Dht::server()`): also routes/stores for the network.
- **Adaptive mode** (default): starts as a client and, after ~15 minutes running with a publicly
  accessible address, switches to server mode. Force it with
  `Dht::builder().server_mode().build()`; optionally pin a known public IP with `.public_ip()` to
  avoid depending on votes from responding nodes.

> **No built-in rate limiting.** A mainline server does **not** rate-limit by default. If you
> worry about spam/DoS, supply a custom request filter (`examples/request_filter.rs`). Caveat:
> the filter applies only **after** parsing incoming messages and does not affect handling of
> incoming responses.

> **mainline 7.0.0 breaking changes (2026-06-08).** `AsyncDht::put()` / `put_mutable()` now
> return `PutOutcome` instead of a raw `Id`; a mutable GET no longer echoes a locally pending PUT
> value; the blocking `Dht::*` operation methods and `GetIterator` are **deprecated** in favor of
> the async API via `Dht::as_async()`. The `Dht::client()` / `Dht::server()` constructors above
> are unaffected. Check the [CHANGELOG](https://github.com/pubky/mainline/blob/main/CHANGELOG.md)
> if you call the operation API directly.

**Lifecycle (why is canonical in
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution)):** DHT records are ephemeral
and heavily cached, so the DHT is **not real-time**. Operator takeaway: any homeserver, relay, or
publisher must run a **republisher (~hourly)** to keep its keys alive.

## Upstream sources

[pkdns](https://github.com/pubky/pkdns) ·
[pkdns config sample](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml) ·
[pkdns DoH doc](https://github.com/pubky/pkdns/blob/master/docs/dns-over-https.md) ·
[pkdns logging doc](https://github.com/pubky/pkdns/blob/master/docs/logging.md) ·
[pkdns-cli](https://github.com/pubky/pkdns/blob/master/cli/src/cli.rs) ·
[pkarr](https://github.com/pubky/pkarr) ·
[relay README](https://github.com/pubky/pkarr/blob/main/relay/README.md) ·
[relay design spec](https://github.com/pubky/pkarr/blob/main/design/relays.md) ·
[relay config example](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml) ·
[mainline](https://github.com/pubky/mainline) ·
[docs.rs/mainline](https://docs.rs/mainline).
