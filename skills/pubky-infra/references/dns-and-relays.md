# Self-sovereign DNS & relays (operator)

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

## pkdns — public-key DNS resolver

[`pkdns`](https://github.com/pubky/pkdns) is a DNS server that resolves 52-char public-key
domains from records published on the Mainline DHT (powered by pkarr), with ICANN fallback for
normal domains. Run it to bridge sovereign public-key domains into ordinary DNS — including for
browsers, which can point their native DoH setting at a pkdns server without changing system
DNS.

> pkdns's default branch is **`master`** (not `main`) — link file URLs accordingly.

### Run it

```text
Usage: pkdns [OPTIONS]

  -f, --forward <FORWARD>      ICANN fallback DNS server. IP:Port. [default: 8.8.8.8:53]
  -v, --verbose                Show verbose output. [default: false]
  -c, --config <CONFIG>        Path to config file. Overrides --pkdns-dir.
  -p, --pkdns-dir <PKDNS_DIR>  Base data/config dir. [default: ~/.pkdns]
```

`pkdns --verbose` is the simplest start; the server listens on `127.0.0.1` for local use.
Extended config lives at `~/.pkdns/pkdns.toml` (sample:
[`server/config.sample.toml`](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml)) —
link it rather than trusting a copy. Key fields and defaults:

```toml
[general]
socket = "0.0.0.0:53"                     # DNS UDP listen (default binds local only)
forward = "8.8.8.8:53"                    # ICANN fallback
dns_over_http_socket = "127.0.0.1:3000"   # EXPERIMENTAL DoH; disabled by default

[dns]
max_ttl = 86400                           # 0 disables caching (see testing gotcha)
query_rate_limit = 100                    # per-IP qps; 0 disables
disable_any_queries = false               # true drops ANY queries (DNS-amplification mitigation)

# Upstream quirk: the sample groups DHT keys under a *commented-out* `# [dht]` header, yet the
# keys beneath it are active. Copy the sample; don't hand-rebuild the section layout.
dht_query_rate_limit = 5                  # per-IP DHT qps
top_level_domain = "key"                  # optional TLD for public-key domains; "" disables
```

### DNS-over-HTTPS (browsers)

pkdns supports DoH per
[RFC 8484](https://github.com/pubky/pkdns/blob/master/docs/dns-over-https.md). Set
`dns_over_http_socket = "127.0.0.1:3000"` and pkdns serves **plain HTTP** (not HTTPS) at
`http://127.0.0.1:3000/dns-query`. Terminate TLS with a reverse proxy in front (e.g. NGINX +
Let's Encrypt):

```nginx
location / {
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_pass http://127.0.0.1:3000;
}
```

This is why browsers can use pkdns without touching system DNS — Firefox/Chrome/Brave/Edge
support DoH natively; point them at your DoH endpoint.

### Docker

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

### Verify

```bash
# Resolve a public-key domain via pkdns (replace PKDNS_SERVER_IP)
nslookup 7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy PKDNS_SERVER_IP

# Resolve a normal ICANN domain (tests fallback)
nslookup example.com PKDNS_SERVER_IP
```

If ICANN domains fail, set the fallback explicitly: `pkdns -f 8.8.8.8`.

> **Browser gotcha.** Always append a trailing `./` to a public-key domain in the address bar
> (`http://<pubkey>./`), or browsers treat it as a search query instead of resolving the site.

### Served record types

The resolver currently serves **A, AAAA, TXT, CNAME, MX** from DHT-published packets; the
README says to use bind9 for any other type. Note this list does **not** mention HTTPS/SVCB,
which the `_pubky` homeserver-discovery chain relies on and which pkarr `SignedPacket`s do
support (see [`concepts.md`](../../pubky/references/concepts.md)). Treat the README list as
possibly incomplete or version-dependent — verify against the pkdns version you deploy if you
rely on HTTPS/SVCB resolution through pkdns.

### Logging

pkdns is silent by default; `--verbose` logs all queries. For finer control use `RUST_LOG`
(see [`docs/logging.md`](https://github.com/pubky/pkdns/blob/master/docs/logging.md)):
`RUST_LOG=pkdns=trace` (chatty), `RUST_LOG=mainline=debug` (DHT), or combined
`RUST_LOG=pkdns=debug,pkarr=debug,mainline=debug` to investigate the DHT.

### Hosted servers

Public servers (from
[`servers.txt`](https://github.com/pubky/pkdns/blob/master/servers.txt), confirmed live
2026-06-29): IPs `34.65.109.99` and `66.78.40.76`; DoH endpoint
`https://pkdns.pubky.org/dns-query`. Zone-explorer demo: <https://pkdns.net/>.

## pkdns-cli — publishing tool

`pkdns-cli` is a **separate** binary from the pkdns server, used to publish records to the DHT
under your key. Subcommands
([`cli/src/cli.rs`](https://github.com/pubky/pkdns/blob/master/cli/src/cli.rs)):

| Command | Does |
| :-- | :-- |
| `generate` | New 64-char hex seed |
| `publickey [seed]` | Derive public key from seed |
| `publish [seed] [zonefile]` | Publish a DNS zone file under the seed (defaults `./seed.txt` + `./pkarr.zone`) |
| `resolve <pubkey>` | Resolve a public-key domain on the DHT |

The zone file is a standard DNS zone **without the SOA record**. `publish` keeps running and
**republishes every 60 minutes** (until Ctrl-C) — this is the operator-side answer to DHT
record ephemerality (see the republish note in
[`concepts.md`](../../pubky/references/concepts.md)).

> **Testing latency gotcha.** pkdns caches DHT packets for at least 60s. Run
> `pkdns --max-ttl 0` to disable caching while testing fresh publishes.

**DynDNS.** In the zone file, `{external_ipv4}` / `{external_ipv6}` are replaced with the host's
actual external IP at publish time; combined with hourly republish this keeps a public-key
domain pointed at a dynamic IP (sample:
[`cli/sample/pkarr.zone`](https://github.com/pubky/pkdns/blob/master/cli/sample/pkarr.zone)):

```text
$TTL 60

@      IN    A      127.0.0.1
dynv4  IN    A      {external_ipv4}
dynv6  IN    AAAA   {external_ipv6}

text   IN    TXT    hero=satoshi2
```

## pkarr-relay — DHT bridge over HTTP

A [`pkarr-relay`](https://github.com/pubky/pkarr/blob/main/relay/README.md) relays PUT/GET
between HTTP clients and the Mainline DHT. UDP-less environments — browsers, WASM, many VMs and
containers, firewalled networks — cannot reach the DHT directly, so they relay PUT and GET over
HTTP through a relay (spec:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md)). The full "why
browsers need this" rationale is canonical in
[`concepts.md`](../../pubky/references/concepts.md) — link, don't restate. **Public relays MUST
set CORS headers.**

### Install & run

```bash
cargo install pkarr-relay

pkarr-relay --config=./config.toml

pkarr-relay -t=pkarr=debug,tower_http=debug
```

CLI flags ([`relay/src/main.rs`](https://github.com/pubky/pkarr/blob/main/relay/src/main.rs)):
`--config`/`-c <path>`, `--tracing-env-filter`/`-t <filter>` (default
`pkarr_relay=info,tower_http=debug`), and `--testnet` (local testnet relay on port `15411`,
handy for local-stack dev). With no flags it runs at `http://localhost:6881`.

### HTTP API

The relay key in the path is the **raw z-base-32 public key** (`publicKey.z32()`), **not** the
`pubky`-prefixed display form — the relay's `PublicKey` extractor (`relay/src/extractors.rs`)
rejects a `pubky`-prefixed string. HTTP shapes below match
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md); status codes
and `?policy=` are confirmed in `relay/src/handlers.rs`.

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
- **GET** is a DHT mutable get; supports `If-Modified-Since` (relay answers `304 Not Modified`),
  returns `Cache-Control: public, max-age=<min ttl>` and a `Memento-Datetime` header (when the
  packet was last observed on the DHT).
- Optional **`?policy=`** maps to `ResolvePolicy`: `CacheFirst` (default — serve unexpired cache
  per min/max TTL, else hit the DHT and return the first response while completing in the
  background), `LocalOrRelayCacheOnly` (cache only; `404` if absent, never touches the DHT,
  consumes no `user_dht_quota`), `DhtNetworkOnly` (always query the DHT).

**PUT errors:** `400` invalid key/signature/DNS packet · `409` timestamp older than what the
server/DHT already saw (BEP44 code 302) · `412` `If-Match` CAS failed (BEP44 code 301) · `413`
payload > 1072 bytes · `428` server already publishing another packet for this key, `If-Match`
required · `429` per-IP rate limited. **GET errors:** `400` invalid key · `404` not found.

The **1072-byte** PUT limit is the `SignedPacket` encoding minus the leading 32-byte public key
(it lives in the URL path): `1104 − 32 = 1072`. Relay payload =
`signature(64) + timestamp(8) + dns-packet(<1000)`. Formal ABNF:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md); the full
`SignedPacket` layout is canonical in
[`concepts.md`](../../pubky/references/concepts.md#pkarr-resolution).

### Config

[`relay/src/config.example.toml`](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml)
(link rather than mirror the full file; gotcha + decision fields shown):

```toml
[http]
port = 6881
[mainline]
port = 6881              # internal DHT node (UDP) — drives the TCP+UDP Docker gotcha below
[cache]
path = "./cache"         # must match the Docker cache mount; stored under a pkarr-cache subdir
minimum_ttl = 300        # seconds; also drives GET `Cache-Control: max-age`
[rate_limiter]           # omit the whole section to disable
behind_proxy = false     # see security gotcha below
user_dht_quota = "2r/s"  # user-initiated DHT ops/IP: PUTs, GET cache misses, expired CacheFirst,
                         # DhtNetworkOnly. Cache hits + LocalOrRelayCacheOnly do NOT consume it.
```

> **Security gotcha — `behind_proxy`.** Set `behind_proxy = true` **only** when the relay sits
> behind a reverse proxy (it then trusts real-IP headers). If you set it true while the relay is
> **also** directly reachable, an attacker can spoof that header to a random IP per request and
> bypass IP rate limiting entirely. Keep direct access blocked whenever `behind_proxy = true`.

### Docker

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

### Health / monitoring

`GET /` serves an HTML status page (version; cache size/capacity/utilization; DHT node port,
firewalled bool, DHT size estimate ± confidence). The Docker healthcheck `wget`s
`http://localhost:6881/` for liveness — reuse the same probe for monitoring.

### Public relays

From [`relays.txt`](https://github.com/pubky/pkarr/blob/main/relays.txt) (confirmed live
2026-06-29): `https://pkarr.pubky.app`, `https://pkarr.pubky.org`, `https://relay.pkarr.org`.
These are what a JS/browser client's `pkarr.relays` config typically points at.

> **Resolvers are deprecated.** Older "Resolvers" (well-known long-running caching DHT nodes)
> are deprecated; [`design/resolvers.md`](https://github.com/pubky/pkarr/blob/main/design/resolvers.md)
> advises combining a DHT client with an HTTP client to use **Relays** instead. An org running a
> Resolver may expose the same node/cache over HTTP via the relay GET endpoint. Mentioned only
> as historical context — do not present Resolvers as the recommended path.

## mainline — the DHT underneath

[`mainline`](https://github.com/pubky/mainline)
([docs.rs/mainline](https://docs.rs/mainline)) is the Rust client/server for BitTorrent's
Mainline DHT, where pkarr stores records. Supported BEPs: **BEP-5** (DHT protocol), **BEP-42**
(security extension / Sybil resistance), **BEP-43** (read-only nodes), **BEP-44** (storing
arbitrary/mutable data — how pkarr `SignedPacket`s are stored). It includes measures against
vertical Sybil attacks (`docs/sybil-resistance.md`).

**Node modes** — operator-relevant for whether a self-hosted node contributes routing/storage:

```rust
use mainline::Dht;

let dht = Dht::client().unwrap();
// or, to contribute routing/storage:
let dht = Dht::server().unwrap(); // or Dht::builder().server_mode().build();
```

- **client** (`Dht::client()`): stores/queries values, accepts no incoming requests.
- **server** (`Dht::server()`): also routes/stores for the network.
- **Adaptive mode** (default): starts as a client and, after ~15 minutes running with a publicly
  accessible address, switches to server mode. Force it with
  `Dht::builder().server_mode().build()`; optionally pin a known public IP with `.public_ip()`
  to avoid depending on votes from responding nodes.

> **No built-in rate limiting.** A mainline server does **not** rate-limit by default. If you
> worry about spam/DoS, supply a custom request filter (`examples/request_filter.rs`). Caveat:
> the filter applies only **after** parsing incoming messages and does not affect handling of
> incoming responses.

**Lifecycle reminder (canonical in [`concepts.md`](../../pubky/references/concepts.md)):** DHT
records are ephemeral (dropped after hours), capped at 1000 bytes (pkarr is for discovery, not
storage), and heavily cached by clients and relays — so the DHT is **not real-time**. The
operator takeaway: a homeserver, relay, or `pkdns-cli` must run a **republisher (~hourly)** to
keep keys alive.

## Upstream sources

[pkdns](https://github.com/pubky/pkdns) ·
[pkdns config sample](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml) ·
[pkdns DoH doc](https://github.com/pubky/pkdns/blob/master/docs/dns-over-https.md) ·
[pkdns logging doc](https://github.com/pubky/pkdns/blob/master/docs/logging.md) ·
[pkarr](https://github.com/pubky/pkarr) ·
[relay README](https://github.com/pubky/pkarr/blob/main/relay/README.md) ·
[relay design spec](https://github.com/pubky/pkarr/blob/main/design/relays.md) ·
[relay config example](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml) ·
[mainline](https://github.com/pubky/mainline) ·
[docs.rs/mainline](https://docs.rs/mainline).
