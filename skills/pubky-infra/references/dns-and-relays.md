# Self-sovereign DNS and relays (operator)

Run the services that face the DHT: **pkdns** (DNS + DoH resolver for public-key domains),
**pkarr-relay** (HTTP gateway to the DHT), and the **mainline** DHT node underneath both.

**Protocol background is canonical. Don't restate it here.**
[`concepts.md` → PKARR resolution](../../pubky/references/concepts.md#pkarr-resolution) covers the
`SignedPacket` layout (1104 bytes max), ephemeral DHT records and ~hourly republishing, why
browsers / UDP-less hosts / AWS-GCP-Azure need relays, and the `_pubky` discovery chain. For `z32`
vs `pubky<z32>`, see
[public-key string formats](../../pubky/references/concepts.md#public-key-string-formats).

> **"Relay" means two unrelated services.** `pkarr-relay` (this file) bridges HTTP and the
> Mainline DHT for PKARR publish/resolve. The Pubky **`http-relay`** is store-and-forward for
> `pubkyauth` and inbox flows. See [`http-relay.md`](http-relay.md).

Homeserver-side `[pkdns]` settings (`user_keys_republisher_interval`, `dht_relay_nodes`) and how
the homeserver republishes: [`homeserver.md` → config.toml](homeserver.md#configtoml) and
[`homeserver.md` → PKARR republishing](homeserver.md#pkarr-republishing).

**Versions (checked 2026-11-12):** pkdns **0.7.1** (Docker image: 0.7.0; **dev/experimentation
only**), pkarr **9.0.0** / pkarr-relay **3.0.0** (both from GitHub release v9.0.0, 2026-11-09,
together with `@synonymdev/pkarr` 9.0.0), and mainline **8.0.1** (2026-09-30). The Pubky
homeserver stack is still on **pkarr 8.1** (see [Pointing clients at relays](#pointing-clients-at-relays)).

## pkdns resolver

> [!WARNING]
> pkdns is for development and experimentation only. It is not ready for
> production use. Do not rely on it for production or mission-critical DNS
> services.

That is the upstream README warning (added in #129; no pkdns code changed with it). It names pkdns
only, and the README still suggests the hosted servers for trying pkdns out. Our inference: the
public servers in `servers.txt` and the public DoH endpoint run pkdns, so **treat them as dev/test
targets too, and don't build production name resolution on pkdns.**

[`pkdns`](https://github.com/pubky/pkdns) resolves public-key domains from PKARR records on the DHT
and forwards ICANN names to a fallback resolver.

- **Release:** v0.7.1 (2025-07-21), still the latest. Not on crates.io.
- **Binaries:** [release assets](https://github.com/pubky/pkdns/releases/tag/v0.7.1)
  `pkdns-v0.7.1-{linux-amd64,linux-arm64,osx-amd64,osx-arm64,windows-amd64}.tar.gz`.
- **Docker:** `synonymsoft/pkdns`. Its `latest` tag is **0.7.0**, not 0.7.1 (see [Docker](#docker)).

> **Released and `master` behave differently.** `master` has **unreleased** commits ahead of
> v0.7.1 (#115 pkarr relays, #117 config refactor, #119 hex seeds, …). Operators run the v0.7.1
> binary or the 0.7.0 image, so this section describes **v0.7.1** (links pinned to the tag) and
> marks `master`-only behavior. Don't apply the `master` README or source to a release build, or
> vice versa.

> **Old dependencies.** v0.7.1's `Cargo.lock` pins **pkarr 3.8.0** and **mainline 5.4.0** (current:
> 9.0.0 / 8.0.1), so pkdns behaves like those versions, not like current pkarr docs. v0.7.1 builds
> its pkarr client with `.no_relays()`: it reaches the DHT **directly over UDP** and needs outbound
> UDP.

### CLI

Flags, from [`server/src/main.rs@v0.7.1`](https://github.com/pubky/pkdns/blob/v0.7.1/server/src/main.rs):

| Flag | Meaning | Default |
| :-- | :-- | :-- |
| `-f, --forward <IP:Port>` | ICANN fallback, a `SocketAddr` (pass `8.8.8.8:53`, not `8.8.8.8`) | `8.8.8.8:53` |
| `-v, --verbose` | Debug logging | off |
| `-c, --config <PATH>` | Config file path; overrides `<pkdns-dir>/pkdns.toml`. Created from the template if missing | unset |
| `-p, --pkdns-dir <PATH>` | Data and config directory | `~/.pkdns` |

Also `--version` / `--help`. **`master` only:** `-c/--config` is removed (#117); config is read
only from `<pkdns-dir>/config.toml`.

### Config: `<pkdns-dir>/pkdns.toml`

> **File name depends on the build.** v0.7.1 and the 0.7.0 image read **`<pkdns-dir>/pkdns.toml`**
> (or the `-c` path)
> ([`config_file.rs@v0.7.1`](https://github.com/pubky/pkdns/blob/v0.7.1/server/src/config/config_file.rs)).
> **`master`** builds read **`config.toml`**. Each silently ignores the other name and runs on a
> freshly created template, so match the file to the binary.

If the file is missing, v0.7.1 writes a template with the `[general]`, `[dns]` and `[dht]` headers
uncommented and every value commented out, so code defaults apply. Keys and code defaults (same in
v0.7.1 and `master`):

```toml
[general]
socket = "0.0.0.0:53"
forward = "8.8.8.8:53"
# dns_over_http_socket = "127.0.0.1:3000"   # unset by default = DoH off
verbose = false

[dns]
min_ttl = 60
max_ttl = 86400
query_rate_limit = 100
query_rate_limit_burst = 200
disable_any_queries = false
icann_cache_mb = 100
max_recursion_depth = 15

[dht]
dht_cache_mb = 100
dht_query_rate_limit = 5
dht_query_rate_limit_burst = 25
top_level_domain = "key"
```

- **v0.7.1: keep all three tables.** Keys have serde defaults; the tables don't. Omitting
  `[general]`, `[dns]` or `[dht]` (even an empty one) fails to parse, and startup panics with
  `Failed to read valid config file`. Only `master` defaults whole tables.
- **DoH is off unless `dns_over_http_socket` is set.** Uncomment the template's `127.0.0.1:3000`
  line to turn it on.
- **Unknown keys and typos are silently ignored** (no `deny_unknown_fields`).
- **Rate limits:** a *rate* of `0` disables that limiter. A *burst* of `0` does **not**: pkdns falls
  back to burst = rate (governor's default), not to 200.
- **`dht_query_rate_limit_burst` has no effect.** It is parsed, but the DHT limiter is built from
  `dht_query_rate_limit` only.
- **`dht_cache_mb = 0` fails to parse** (`NonZeroU64`).
- **Caching:** pkdns turns off pkarr's client cache (`minimum_ttl(0).maximum_ttl(0)`) and uses its
  own LRU caches. PKARR and ICANN entries refresh after a TTL clamped to `[dns] min_ttl..max_ttl`.
  `max_ttl = 0` means nothing is cached.
- **`disable_any_queries = true`** silently drops `ANY` queries (amplification protection). Default
  `false`.

> **`master` only: `# [dht]` gotcha.**
> [`server/config.sample.toml`](https://github.com/pubky/pkdns/blob/master/server/config.sample.toml)
> ships with the `[dht]` header commented out, so the four DHT keys parse under `[dns]` and are
> ignored. Uncomment `[dht]` to override a DHT key on a `master` build. Its "0 is disabled" comment
> on bursts is also wrong (see above).

> **DNS is UDP only.** There is no TCP/53 listener (`dig +tcp` times out); expose only UDP 53. The
> default `socket = "0.0.0.0:53"` answers ICANN names for anyone who can reach it. On a reachable
> host, firewall UDP/53, keep `query_rate_limit` on, and set `disable_any_queries = true`.

### DNS-over-HTTPS

[`docs/dns-over-https.md`](https://github.com/pubky/pkdns/blob/v0.7.1/docs/dns-over-https.md)
(RFC 8484). **Experimental, off by default.** Same behavior in v0.7.1 and `master`.

- **Enable:** under `[general]`, set `dns_over_http_socket = "127.0.0.1:3000"`. pkdns serves
  **plain HTTP** (no TLS) and logs
  `[EXPERIMENTAL] DNS-over-HTTP listening on http://{socket}/dns-query.`
- **Routes:** `GET /dns-query?dns=<base64url>` and `POST /dns-query` (body limit 65535 bytes).
- **Both routes require `Accept: application/dns-message`, matched exactly.** Without it, or with a
  list such as `application/dns-message, */*`, they return **400**.
- **Response:** `Content-Type: application/dns-message`,
  `Cache-Control: max-age=<lowest answer TTL, default 300>`. CORS allows any origin.

Terminate TLS at a reverse proxy. Upstream nginx block:

```nginx
location / {
	proxy_set_header X-Forwarded-For $remote_addr;
	proxy_pass http://127.0.0.1:3000;
}
```

> **Keep the DoH socket on loopback, and overwrite `X-Forwarded-For`.** The per-IP rate limiter uses
> `X-Forwarded-For` whenever it parses as a single IP, else the peer address.
> - A client that can reach the socket directly can spoof the header and bypass the limit.
> - A proxy that **appends** (`$proxy_add_x_forwarded_for` gives `a, b`) fails to parse, so every
>   client shares the proxy's bucket. Set it to `$remote_addr`, as above.

Test against the public endpoint (dev/test target only):

```bash
# RFC 8484's www.example.com A query; expect 200 (verified 2026-11-12; 400 without the Accept header)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'accept: application/dns-message' \
  'https://pkdns.pubky.org/dns-query?dns=AAABAAABAAAAAAAAA3d3dwdleGFtcGxlA2NvbQAAAQAB'
```

### Docker

Upstream [`compose.yaml`](https://github.com/pubky/pkdns/blob/master/compose.yaml), comments trimmed.
Mount `/root/.pkdns` to persist the config (**`pkdns.toml`** in the 0.7.0 image) and the cache.

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

> **The Docker image is pkdns 0.7.0.** `synonymsoft/pkdns:latest` and `:0.7.0` share one digest
> (pushed 2025-07-11); there is no `0.7.1` tag (still true on 2026-11-12). v0.7.1 fixed only the
> pkdns-cli TXT-quote bug (#113) and a build-version issue (#111), so the image's `pkdns-cli` still
> writes TXT records with extra quotes. **Publish TXT records with the 0.7.1 release binary.** The
> image otherwise has released behavior: `pkdns.toml`, `-c/--config`, z-base-32 seeds.

**"Address already in use" on port 53:** Docker Desktop (macOS) or `systemd-resolved` (Ubuntu)
usually holds the port. Free it first.

### Verify and log

```bash
nslookup 7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy. PKDNS_SERVER_IP
nslookup example.com PKDNS_SERVER_IP
```

- **Add the trailing dot** to the key, or nslookup can append your OS search domain. The upstream
  README leaves it out.
- **In a browser address bar,** use `http://<key>./`.
- **If ICANN names fail,** fix the fallback: `pkdns -f 8.8.8.8:53`. The README's `pkdns -f 8.8.8.8`
  is rejected (no port).
- **Public servers are not reliable test targets.** Upstream
  [`servers.txt`](https://github.com/pubky/pkdns/blob/master/servers.txt) lists `34.65.109.99`,
  `66.78.40.76` and DoH `https://pkdns.pubky.org/dns-query`. Their answers for a published key flip
  between checks: on 2026-10-26 `34.65.109.99` and DoH resolved it and `66.78.40.76` timed out; on
  2026-11-12 `66.78.40.76` resolved it and `34.65.109.99` returned NXDOMAIN. **Verify against your
  own pkdns,** and don't assume a public server is either up or down.
- **Record types:** the README's "A, AAAA, TXT, CNAME and MX only" limit applies to `pkdns-cli` zone
  authoring and display (display also handles NS). The resolver returns any record type in the
  PKARR packet that matches the query type. On 2026-10-26, `34.65.109.99` answered an
  **HTTPS (TYPE65)** query for a homeserver key with two HTTPS records, so the `_pubky` HTTPS/SVCB
  chain can resolve through pkdns. Test it on your own instance.
- **Logging** ([`docs/logging.md`](https://github.com/pubky/pkdns/blob/v0.7.1/docs/logging.md)):
  with `RUST_LOG` unset, the filter is `pkdns=INFO,mainline=WARN`, so startup lines do print (the
  doc's "stays silent" is wrong); `--verbose` raises it to `pkdns=DEBUG`. **When `RUST_LOG` is set,
  `--verbose` is ignored** (pkdns logs a warning). Useful filters:
  - `RUST_LOG=pkdns=trace` for pkdns itself.
  - `RUST_LOG=pkdns=debug,pkarr=debug,mainline=debug` for DHT issues.

## pkdns-cli (publish your own records)

`pkdns-cli` is a separate binary. Argument syntax:
[`cli/src/cli.rs@v0.7.1`](https://github.com/pubky/pkdns/blob/v0.7.1/cli/src/cli.rs).

- **`generate`** prints a new secret key as **z-base-32** (v0.7.1). Protect it like a private key.
- **`publish`** signs and publishes a zone file once.
- **`publickey`** prints the public key for a seed file.
- **Seed format (v0.7.1):** `publish` and `publickey` decode the trimmed seed as **z-base-32 only**.

> **`master` only: hex seeds (#119).** `generate` prints **hex**; `publish` decodes a 52-char seed
> as z-base-32 and anything else as hex (first 32 bytes; its "tries hex first" doc comment is
> wrong); `publickey` still decodes z-base-32 only, so it fails on every generated seed. **The
> v0.7.1 binary can't read a hex seed from a `master` build**, and the failure echoes it to stderr
> (below). Don't mix seeds across builds.

> **`publish` is one-shot, and exits 0 even when the DHT publish fails.** It calls
> `client.publish(&packet, None)` once and prints `<time> Successfully announced.` on success or
> `Error <e>` on a DHT failure, both to stdout. Seed/zone read, parse and signing errors exit 1; a
> failed external-IP lookup panics. `docs/dyn-dns.md` says to publish "every 60 minutes", but the
> CLI doesn't loop. Schedule it yourself (cron or a systemd timer) and have the wrapper check the
> output for `Successfully announced.`, not `$?`.

> **Protect the seed (both versions).**
> - If `publish` or `publickey` can't parse the seed, it prints the raw seed to stderr:
>   `Failed to parse the seed file. {e} {seed}`. Under cron or journald, the secret lands in the
>   logs.
> - A seed that decodes to **fewer than 32 bytes panics** (slice index out of range) instead of
>   returning an error.

- **Zone file:** a normal DNS zone **without an SOA record**.
- **Dynamic DNS:** `{external_ipv4}` and `{external_ipv6}` are replaced before publishing, using
  external IP-lookup services (icanhazip, identme, ipify, ipinfo, myip). **If the lookup fails, it
  panics** with `Failed to fetch external ips.`

Sample [`cli/sample/pkarr.zone`](https://github.com/pubky/pkdns/blob/master/cli/sample/pkarr.zone):

```text
$TTL 60

@      IN    A      127.0.0.1
dynv4  IN    A      {external_ipv4}
dynv6  IN    AAAA   {external_ipv6}

text   IN    TXT    hero=satoshi2
```

## pkarr-relay

[`pkarr-relay`](https://github.com/pubky/pkarr/blob/main/relay/README.md) is an HTTP gateway and
cache for PKARR publish/resolve over the Mainline DHT, for clients that can't use UDP: browsers,
VMs, containers and firewalled networks. Spec:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md). Current crate:
**3.0.0**, from pkarr release **v9.0.0** (2026-11-09). MSRV 1.85.

> **3.0.0 has no operator-facing breaking changes.** The major bump comes from the pkarr 9
> dependency and its `Timestamp` API. From v8.1.0 to v9.0.0, `relay/` changed only `Cargo.toml`,
> `LICENSE` (added) and `src/response.rs` (HTTP dates). CLI flags, config keys and defaults,
> rate-limiter semantics, routes and status codes below are the same as in 2.1.0. v9.0.0 also
> resolved rustls advisories and moved the Docker build to Alpine 3.24.

### Install and run

- **Prebuilt binaries** (since v8.0.2): GitHub release assets
  `pkarr-relay-v<relay-version>-{linux-amd64,linux-arm64,osx-amd64,osx-arm64,windows-amd64}.tar.gz`.
  The asset version is the **relay crate** version, not the release tag: release v9.0.0 ships
  `pkarr-relay-v3.0.0-*.tar.gz`. Linux builds are static musl binaries.
- **Docker:** `synonymsoft/pkarr-relay` (linux/amd64, linux/arm64). **Tags follow the pkarr repo
  tag** (`v9.0.0`, `v8.1.0`, …, plus commit SHAs and `latest`), not the relay crate version
  (`3.0.0`). `latest` and `v9.0.0` are the same image. The image runs
  `pkarr-relay --config=/config.toml`, so **mount a config at `/config.toml`**.
- **From source** (commands verified with pkarr-relay 3.0.0):

```bash
cargo install pkarr-relay

pkarr-relay

pkarr-relay --config ./config.toml

pkarr-relay --tracing-env-filter pkarr_relay=debug,tower_http=debug
```

Flags ([`relay/src/main.rs`](https://github.com/pubky/pkarr/blob/main/relay/src/main.rs)):

- **`-c, --config <PATH>`**.
- **`-t, --tracing-env-filter <FILTER>`**, default `pkarr_relay=info,tower_http=debug`.
- **`-V, --version`** (since 2.0.2) prints `pkarr-relay <version>`.
- **`--testnet`** (local testnet, port 15411) exists only when built with the non-default
  `testnet` feature. A plain `cargo install pkarr-relay` doesn't have it.

> **The HTTP server binds `0.0.0.0:<http.port>`** (default 6881) on all IPv4 interfaces. On a
> network-reachable host, restrict it with a firewall or a reverse proxy.

> **The example config pins `[mainline] port = 6881`.** If another process (a local testnet,
> another DHT node) already holds UDP 6881, `--config` startup fails with
> `Address already in use`. Change or drop that line.

### Config

Commented source:
[`relay/src/config.example.toml`](https://github.com/pubky/pkarr/blob/main/relay/src/config.example.toml).
Key values (unchanged from 2.1.0 to 3.0.0):

```toml
[http]
port = 6881

[mainline]
request_timeout_seconds = 2
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

- **`[mainline] request_timeout_seconds`** (since 2.1.0, default 2) is the timeout for **each DHT
  request**, not the whole operation. It isn't validated, so `0` is accepted.
- **`[cache] minimum_ttl` / `maximum_ttl`** default to pkarr's `DEFAULT_MINIMUM_TTL` (300 s) and
  `DEFAULT_MAXIMUM_TTL` (86400 s). `minimum_ttl` must be ≤ `maximum_ttl`.
- **`[http]`** also accepts `max_connections` (default 1024, > 0) and `max_connection_age_seconds`
  (default 300, > 0).
- **Typos are ignored in every table except `[rate_limiter]`.** `[http]`, `[mainline]` and
  `[cache]` accept unknown keys silently.

**Rate limiter semantics:**

- **`quota` / `burst`:** per-IP HTTP limit on **every** request: GET, PUT, the index page, cache
  hits and `CacheOnly`.
- **`dht_quota` / `dht_burst`:** per-peer-IP limit on incoming DHT requests to the relay's own node.
- **`user_dht_quota` / `user_dht_burst`:** counts only requests that reach the DHT: PUT, a GET that
  misses the cache, an expired `CacheFirst`, and `NetworkOnly`.

> **Rate limiting depends on how you start the relay.**
> - **No `--config`:** limits are on, at `2r/s` for all three quotas, with **burst = rate (2)**,
>   not 10.
> - **With `--config`, omitting `[rate_limiter]` disables rate limiting entirely** (the relay logs
>   `rate_limiter: None`).
> - **A partial `[rate_limiter]` table fails to load.** It has `deny_unknown_fields`, and
>   `behind_proxy`, `quota`, `dht_quota` and `user_dht_quota` are all required.
> - **`burst = 0` is a parse error** (bursts are `NonZeroU32`). Leave the key out for the default.

> **Set `behind_proxy = true` only when the relay is reachable solely through the proxy.** It reads
> the client IP from `X-Forwarded-For` and similar headers. If clients can also reach the relay
> directly, they can spoof the header and bypass every IP rate limit.

> **Set `cache.path`.** Without it, every start uses a fresh temporary cache and logs
> `Cache path is not configured, running ephemeral Relay`.
> - A **relative** path resolves against the config file's directory and **must already exist**,
>   or the relay fails with `failed to canonicalize …`. Absolute paths are used as-is.
> - Data goes in a `pkarr-cache` subdirectory. The storage format is unchanged in 3.0.0, so an
>   existing 2.x cache directory carries over.
> - Since pkarr 9.0.0 (#333), a stored packet with truncated data or an invalid public key returns
>   a deserialization error (`InsufficientData` / `InvalidDnsPacket`) instead of panicking. A packet
>   with an invalid signature still deserializes; the relay rejects it on verification.
> - Opening the LMDB cache is `unsafe` (`Relay::run*` are `unsafe fn`s). **Never share one cache
>   directory between relays.**

### HTTP API

Full status and header semantics:
[`design/relays.md`](https://github.com/pubky/pkarr/blob/main/design/relays.md). Operator points:

- **Routes:** `GET /` (HTML status page), `GET /{key}`, `PUT /{key}`.
- **`{key}` is raw z-base-32** (`publicKey.z32()`), **not** `pubky<z32>`; a `pubky`-prefixed key
  returns `400`.
- **`GET ?policy=`** takes `CacheFirst` (default), `CacheOnly` or `NetworkOnly`. `CacheOnly` never
  touches the DHT; `NetworkOnly` skips the cache.
- **PUT body:** `signature(64) + timestamp(8, big-endian µs) + DNS packet(<1000 bytes)`. Body limit
  **1104** bytes, and the body must arrive within 30 s. The spec says 413 above 1072 bytes; the
  implementation's limit is 1104.
- **PUT status codes:** `204` stored (with `Pkarr-Dht-Stored-Nodes`); `400` bad payload or
  signature; `409` `NotMostRecent`; `413` body over 1104 bytes; `429` rate-limited (HTTP quota or
  `user_dht_quota`); `500` DHT failure.
- **GET status codes:** `200`, `304`, `400`, `404`, `429`, and `503` (no DHT nodes queried or no
  usable answer). A freshly started relay can return `404` until its DHT node has bootstrapped.
- **BEP44 mapping** ([`design/base.md`](https://github.com/pubky/pkarr/blob/main/design/base.md)):
  `k` = public key, `seq` = timestamp (µs), `sig` = signature, `v` = DNS packet, `salt` is
  ignored. Signed bytes: `3:seqi<seq>e1:v<len>:<v>`. The relay verifies `sig` before the DHT put.

> **Since pkarr-relay 3.0.0: packet timestamps beyond year 9999.** Such a packet is served with its
> full timestamp but **without a `Last-Modified` header** (so distinct out-of-range versions don't
> share one cache validator), and it never gets a `304` (`If-Modified-Since` is always ≤ 9999).
> `Memento-Datetime` is when the relay last saw the packet (its own clock), not the packet
> timestamp, and is formatted with saturation. Clients still check that a returned packet is newer
> than the requested timestamp, and ignore future `Memento-Datetime` values. **The public relays
> don't run 3.0.0** (see [Public relays](#public-relays)), so don't assume this behavior there.

> **pkarr 9 clients don't log your error bodies (#344).** On an HTTP error status, a pkarr 9.0.0
> client neither reads nor logs the response body on PUT or GET. It derives the error from the
> status (and protocol headers) and logs only relay origin, operation and status. Debug from the
> status code and the relay's own logs, not client-side error text.

```bash
KEY=7fmjpcuuzf54hw18bsgi3zihzyh4awseeuq5tmojefaezjbd64cy   # raw z-base-32, no "pubky" prefix
curl -fsI "https://pkarr.pubky.org/$KEY" >/dev/null && echo "on DHT" || echo "NOT on DHT"
# Skip your own relay's cache (default port 6881) and query the DHT directly:
curl -sI "http://localhost:6881/$KEY?policy=NetworkOnly"
```

### Docker and health

pkarr repo [`docker-compose.yml`](https://github.com/pubky/pkarr/blob/main/docker-compose.yml)
builds from source:

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

- **Open both** TCP 6881 (HTTP) and UDP 6881 (DHT).
- `/cache` works because `./cache` resolves relative to `/config.toml`.
- **To skip the source build,** replace `build: .` with `image: synonymsoft/pkarr-relay:v9.0.0`
  (pkarr-relay 3.0.0). Pin the tag, not `latest`. This substitution is ours, not upstream's.
- **`GET /`** shows the version, cache size/capacity/utilization, node port, firewalled flag and
  DHT size estimate. Use it for liveness probes.

### Public relays

[`relays.txt`](https://github.com/pubky/pkarr/blob/main/relays.txt) lists `https://pkarr.pubky.app`,
`https://pkarr.pubky.org` and `https://relay.pkarr.org`. `pkarr::DEFAULT_RELAYS` holds only the
first two (unchanged in 9.0.0).

> **A public relay doesn't behave like a bare relay.** On 2026-10-26, all three sat behind a proxy
> and returned `cache-control: public, max-age=300`, with `x-ratelimit-limit` of 1000
> (`pkarr.pubky.app`), 50 (`pkarr.pubky.org`) and 10 (`relay.pkarr.org`); `relay.pkarr.org` sent
> no `memento-datetime`. On 2026-11-12 their status pages reported relay **2.0.1** for the two
> pubky relays and **0.10.0** for `relay.pkarr.org`; none runs 3.0.0. These values change, so don't
> hard-code them.

## Pointing clients at relays

- **JS/WASM SDK:** see
  [`sdk-js.md` → WASM needs PKARR relays](../../pubky/references/sdk-js.md#wasm-needs-pkarr-relays)
  for the canonical `new Client({ pkarr: { relays: [...] } })` snippet.
- **Rust pkarr on WASM:** set `default-features = false, features = ["relays"]`. Only
  `wasm32-unknown-unknown` is supported, not WASI (browsers can't open UDP sockets). The upstream
  `docs/integration.md` WASM and lmdb-cache examples still pin pkarr `"7"`. Use `9` for standalone
  pkarr code (but see the next callout).

> **The Pubky stack is still on pkarr 8.1.** `pubky-homeserver` (HEAD 2026-11-11) declares
> `pkarr = "8.1"` and `pkarr-relay = "2"`; its lockfile resolves pkarr 8.1.0, and the `pubky` SDK
> re-exports that `pkarr`. A standalone pkarr-relay 3.0.0 interoperates with it over the unchanged
> HTTP API. **Rust code that also uses the `pubky` SDK should stay on pkarr 8.1**: adding pkarr 9
> gives two semver-major copies whose `PublicKey` / `SignedPacket` types don't interchange.

Rust backend options, adapted from the
[integration guide](https://github.com/pubky/pkarr/blob/main/docs/integration.md#backend-configuration)
(block 3 corrected for the `extra_bootstrap` bug; compiled and run with pkarr 9.0.0 + mainline
8.0.1; the builder API is the same in 8.1.0):

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

// Extend defaults: list mainline's default bootstrap nodes explicitly (see extra_bootstrap bug)
let mut bootstrap = mainline::DEFAULT_BOOTSTRAP_NODES.to_vec();
bootstrap.push("my-bootstrap.example.com:6881");
let client = Client::builder()
    .bootstrap(&bootstrap)
    .extra_relays(&["https://my-relay.example.com"])?
    .build()?;
```

- `build()` after `no_default_network()` with no backend returns `BuildError::NoNetwork`.
- `relays()` and `extra_relays()` return `Result<&mut Self, InvalidRelayUrl>`.

> **Don't call `.extra_bootstrap()` on a default builder.** Still a bug in pkarr 9.0.0
> ([`builder.rs`](https://github.com/pubky/pkarr/blob/main/pkarr/src/client/builder.rs)). The
> default bootstrap is `None` ("use mainline's defaults"), and `extra_bootstrap` extends an empty
> list (`config.bootstrap.clone().unwrap_or_default()`), so it **replaces** mainline's
> `DEFAULT_BOOTSTRAP_NODES` with only your extras. The upstream integration guide still shows it.
> pkarr doesn't re-export `mainline`; add `mainline = "8"` to use
> `mainline::DEFAULT_BOOTSTRAP_NODES`.

> **`.extra_relays()` does nothing after `no_relays()` or `no_default_network()`.** It extends the
> list only when relays are already set, and returns `Ok` either way without parsing the URLs (an
> invalid URL also returns `Ok`). Use `.relays()` there.

**Timeouts (since pkarr 8.1.0, unchanged in 9.0.0):** DHT and relay timeouts are separate.

- `DEFAULT_DHT_REQUEST_TIMEOUT` is **2 s**, per DHT peer request.
- `DEFAULT_RELAY_REQUEST_TIMEOUT` is **5 s**, per relay HTTP request, including the relay's own
  DHT lookup.
- `request_timeout()` and `DEFAULT_REQUEST_TIMEOUT` are `#[deprecated]`. The setter sets both
  timeouts; the constant equals the relay default (5 s).
- **Before 8.1.0, relay-only clients had to raise the 2 s `request_timeout`.** From 8.1.0 the relay
  default is already 5 s, which the homeserver (pkarr 8.1) also gets.

Requires **pkarr >= 8.1.0** (doesn't compile on 8.0.1; compiled on 9.0.0):

```rust
use pkarr::Client;
use std::time::Duration;

let client = Client::builder()
    .dht_request_timeout(Duration::from_secs(2))
    .relay_request_timeout(Duration::from_secs(5))
    .build()?;
```

## Republishing

Why DHT records expire and how often to republish:
[`concepts.md` → Republishing](../../pubky/references/concepts.md#republishing). Who republishes:

- **Homeservers** republish their users' keys every 4 h by default
  ([`homeserver.md` → PKARR republishing](homeserver.md#pkarr-republishing)).
- **`pkdns-cli`** doesn't. Use an external scheduler that checks the output (see
  [pkdns-cli](#pkdns-cli-publish-your-own-records)).
- **A custom Rust publisher** can use the upstream patterns below
  ([integration guide](https://github.com/pubky/pkarr/blob/main/docs/integration.md#republishing-patterns)).
  `Client::publish(&SignedPacket)` returns `Result<StoredNodeCount, PublishError>`, where
  `StoredNodeCount` is a `u32` alias: the number of DHT nodes that stored the packet.

**Rules:**

- **The pkarr client doesn't serialize concurrent publishes for the same key.** Run the whole
  resolve → build → publish sequence one at a time per key, e.g. behind a single-permit semaphore.
- **When you change records, resolve with `NetworkOnly` first** and pick a timestamp above the
  highest `seq` you observed (snippet below). `Timestamp::now()` increases strictly only within one
  process, not across processes or restarts.
- **The packet is the complete record set.** Records you omit from the new packet are removed.

Updating a published packet, from the upstream
[integration guide](https://github.com/pubky/pkarr/blob/main/docs/integration.md#updating-a-published-packet).
Executed against a local testnet relay with pkarr 9.0.0 (both the `NotFound` path and the
strictly-newer-timestamp path):

```rust
use pkarr::{
    errors::ResolveError, Client, Keypair, ResolvePolicy, SignedPacket, Timestamp,
};
use std::io;

async fn republish_update(
    client: &Client,
    keypair: &Keypair,
) -> Result<(), Box<dyn std::error::Error>> {
    // Get the highest observed sequence before building the replacement.
    let observed_sequence = match client
        .resolve(&keypair.public_key(), ResolvePolicy::NetworkOnly)
        .await
    {
        Ok(existing) => existing.timestamp().as_u64(),
        Err(ResolveError::NotFound) => 0,
        Err(ResolveError::InvalidSignedPacket { seq }) => u64::try_from(seq)?,
        Err(error) => return Err(error.into()),
    };

    let next_sequence = observed_sequence
        .checked_add(1)
        .filter(|sequence| *sequence <= i64::MAX as u64)
        .ok_or_else(|| io::Error::other("Pkarr sequence is exhausted"))?;
    let timestamp = Timestamp::from(Timestamp::now().as_u64().max(next_sequence));

    let packet = SignedPacket::builder()
        // Build the complete desired record set; omitted records are removed.
        .txt("key".try_into()?, "updated_value".try_into()?, 300)
        .timestamp(timestamp)
        .sign(keypair)?;

    let stored_on = client.publish(&packet).await?;
    println!("Published successfully; stored on at least {stored_on} DHT nodes");
    Ok(())
}
```

Periodic republish loop. Executed against a local testnet relay with pkarr 9.0.0 (both the `Ok`
and the `NotMostRecent` branch):

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

**`Timestamp` in pkarr 9 (breaking, #335).** `pkarr::Timestamp` is now pkarr's own type (feature
`signed_packet`), replacing the re-exported `ntimestamp::Timestamp`, with a smaller API. Full API on
[docs.rs/pkarr](https://docs.rs/pkarr). What changes your code:

- It wraps a `u64` of **microseconds** since the Unix epoch; `to_bytes()` is big-endian.
- **`format_http_date()` returns `Option<String>`** (`None` beyond year 9999). Use
  `format_http_date_saturating() -> String` for clamped output.
- `parse_http_date(&str)` returns `Result<Timestamp, httpdate::Error>`.
- `Add` / `Sub` / `SubAssign<u64>` saturate. In browser WASM, `now()` uses `js_sys::Date::now()`.
- Code that used other `ntimestamp` methods via `pkarr::Timestamp` may not compile on 9.

**Client cache TTLs:** `DEFAULT_MINIMUM_TTL = 300` s, `DEFAULT_MAXIMUM_TTL = 86400` s,
`DEFAULT_CACHE_SIZE = 1000` (unchanged in 9.0.0). pkdns bypasses this cache (see
[Config](#config-pkdns-dirpkdnstoml)).

## mainline (the DHT node)

[`mainline`](https://github.com/pubky/mainline) ([docs.rs](https://docs.rs/mainline)) **8.0.1**,
used by both pkarr 8.1.0 and 9.0.0. 8.0.1 only raises a dependency (`lru >= 0.18.2`, for
RUSTSEC-2026-0253); the API is unchanged.

- **BEPs:** BEP5 (DHT), BEP42 (security extension), BEP43 (read-only nodes) and BEP44 (arbitrary
  data), in client and server modes, plus vertical-Sybil defences
  ([`docs/censorship-resistance.md`](https://github.com/pubky/mainline/blob/main/docs/censorship-resistance.md#vertical-sybil-attacks)).
- **Unreleased:** the repo also holds a `mainline-next` workspace crate (a DHT refactor,
  `publish = false`). Don't depend on it.

README errors: `Dht::builder::server_mode()` should be `Dht::builder().server_mode()`, and
`.public_ip()` takes an `Ipv4Addr`. `build()` returns `Result<Dht, std::io::Error>`. Corrected
(compiled and run against mainline 8.0.1):

```rust
use mainline::Dht;
use std::net::Ipv4Addr;

let dht = Dht::client()?; // adaptive: client first, server after ~15 min if publicly reachable
let dht = Dht::server()?; // server mode from the start

let dht = Dht::builder()
    .server_mode()
    .public_ip(Ipv4Addr::new(203, 0, 113, 10))
    .build()?;
```

- **No built-in rate limiting.** Supply a request filter
  ([`examples/request_filter.rs`](https://github.com/pubky/mainline/blob/main/examples/request_filter.rs)).
  It runs after messages are parsed and doesn't affect incoming responses. pkarr exposes it as
  `pkarr::dht::RequestFilter`, which pkarr-relay uses to enforce `dht_quota`.
- **Port:** default UDP **6881**. If no port is configured and 6881 is taken, the node **silently
  binds a random port**. An explicitly configured port that fails to bind is an error. IPv4 only.
- **Bootstrap nodes (`mainline::DEFAULT_BOOTSTRAP_NODES`):** `router.bittorrent.com:6881`,
  `dht.transmissionbt.com:6881`, `dht.libtorrent.org:25401`, `relay.pkarr.org:6881`.
- **Breaking changes:** 8.0.0 rejects malformed mutable PUTs and validates mutable-item targets
  (with error and conversion API changes). 7.0.0 returns `PutOutcome` from mutable puts and
  deprecates blocking ops in favour of `Dht::as_async()`. Details:
  [CHANGELOG](https://github.com/pubky/mainline/blob/main/CHANGELOG.md).
