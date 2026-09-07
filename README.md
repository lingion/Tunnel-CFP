<p align="center">
  <a href="https://github.com/lingion/Tunnel-CFP/stargazers"><img src="https://img.shields.io/github/stars/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=FFD700" alt="Stars"></a>
  <a href="https://github.com/lingion/Tunnel-CFP/network/members"><img src="https://img.shields.io/github/forks/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=8B5CF6" alt="Forks"></a>
  <a href="https://github.com/lingion/Tunnel-CFP/issues"><img src="https://img.shields.io/github/issues/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=EF4444" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/lingion/Tunnel-CFP?style=for-the-badge&logo=github&color=10B981" alt="License"></a>
  <br>
  <a href="https://github.com/lingion/Tunnel-CFP/commits/main"><img src="https://img.shields.io/github/last-commit/lingion/Tunnel-CFP?style=flat-square" alt="Last commit"></a>
  <img src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="CF Workers">
  <img src="https://img.shields.io/badge/lang-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TS">
  <a href="README.zh.md"><img src="https://img.shields.io/badge/README-中文-CC0000?style=flat-square" alt="中文"></a>
</p>

<h1 align="center">Tunnel-CFP</h1>

<p align="center">
  One Cloudflare Worker, one self-hosted network toolkit.<br>
  Web fetching proxy · WebSocket bridge · DoH server · subscription endpoints · admin panel.
</p>

---

[中文](README.zh.md) | **English**

> **Read the [Disclaimer](#disclaimer) before downloading or using this project.**

## What is Tunnel-CFP?

Tunnel-CFP is a single TypeScript Worker that you deploy to your own Cloudflare account. One router dispatches several independent utilities:

| Path | What it does |
|---|---|
| `/proxy/<encoded-url>` | Fetches a page through the Worker, rewrites HTML/CSS/JS asset URLs, isolates cookies per target site, blocks SSRF |
| `/proxy-ws/<encoded-ws-url>` | Bridges a browser WebSocket to an origin TCP socket |
| `/api/v1/fetch/<target>` | JSON fetch API for scripts and agents (`X-API-Key` auth) |
| `/sub/*` | Serves Clash YAML / base64 configuration lists, token-gated |
| `/dns-query`, `/resolve` | DNS-over-HTTPS (RFC 8484 wire format + JSON API) |
| `/*` | Admin panel and WebSocket tunnel (vendored edgetunnel engine) |

The tunnel core is **vendored, unmodified upstream code** (see [Acknowledgements](#acknowledgements)). Everything described in [What this project adds](#what-this-project-adds) below is original code in `src/`, written to manage, secure, and operate around that core.

It is a self-hosted development tool. Configuration, secrets, and all runtime data live in your own Cloudflare account. The project authors have no access to any deployed instance.

## How the web proxy works

`/proxy/` is a streaming fetch-rewrite pipeline, not a static mirror:

1. **Resolve and validate the target.** The target URL is parsed with `new URL()`, and validation runs on the *parsed hostname*, not the raw string. This closes the classic SSRF bypass where `http://2130706433/`, `http://0x7f000001/`, `http://0177.0.0.1/`, and `http://127.1/` all normalize to `127.0.0.1` inside a URL parser. Also rejected: any dotted-quad IPv4, IPv6 literals, `localhost`, and internal TLDs (`.internal`, `.local`, `.home.arpa`), plus self-recursion against the configured `SELF_HOSTS`.
2. **Fetch with a hard timeout.** Origin requests carry `AbortSignal.timeout(60s)`. Timeouts produce a 504 page; other failures a 502.
3. **Rewrite by content type, streaming.** HTML goes through `HTMLRewriter` — a streaming rewriter with no DOM — so elements are rewritten as they pass through. Handled cases: `href`/`src`/`srcset`/`action` and `srcdoc` iframes (whose content arrives entity-encoded and is decoded before rewriting), inline `<style>` text with O(n) buffered CSS `url()` rewriting, and `<script>` text guarded against touching template literals. The rewriter also strips the Cloudflare RUM beacon script and adds `Cache-Control: no-transform` so the edge does not re-inject it.
4. **Bound every buffer.** Rewritable bodies are read through a byte-counting reader capped at 5 MB; anything larger is streamed through untouched. The WS bridge caps frames at 16 MB and handshakes at 64 KB. Nothing accumulates unbounded in memory.
5. **Cache conditionally.** Only cacheable asset types, only GET, only requests without cookies, and only via a deferred `ctx.waitUntil` put that strips `Set-Cookie` before storing — the response itself is never delayed by cache writes, and authenticated responses never enter the cache.
6. **Preserve protocol semantics.** `Content-Encoding` and `Content-Length` pass through untouched, so `Range` requests (video seeking) get real 206 responses. Timeout handling works for HEAD requests (which must have no body).

Navigation rescue is the small piece that makes this usable in a browser: single-page sites that set `location.href = "/some/path"` would otherwise break out of the proxy. When a same-origin navigation arrives with a Referer pointing back into `/proxy/`, the Worker answers a 302 that maps the path back onto the proxied origin site. The proxied page also stores the last target site in an `HttpOnly` cookie (server-side — no injected JS writes cookies), so even origin-only referers can be rescued.

## How the WebSocket bridge works

`/proxy-ws/` terminates a browser WebSocket and opens a raw TCP socket to the origin with `cloudflare:sockets`, then pumps bytes in both directions. The browser side is the hard part, and it is implemented to the letter of RFC 6455:

- **Client masking is mandatory (RFC 6455 §5.1).** Every frame sent toward the origin carries the mask bit and a fresh `crypto.getRandomValues` mask key, with the payload XOR-masked. Length classes (7-bit / 16-bit / 64-bit) are encoded per spec; frame opcodes (text, binary, ping, pong, close) are preserved.
- **Continuation frames are reassembled.** Fragmented messages (opcode `0x0`) are buffered and dispatched whole; a fragmented control frame interleaving a text message is a protocol violation and fails the connection with close code 1002.
- **Ping/pong follows the protocol.** Application-level pings from the origin are answered with pongs on the same connection. When the origin closes, the bridge closes the client socket cleanly (code 1000) instead of leaking it.
- **Writes are serialized.** The origin-facing socket has a single promise-chained writer, so concurrent reads on the client side cannot interleave writes mid-frame.
- **Failures are diagnosable.** When `wrangler tail` is unavailable (a mirrored network makes the tail WebSocket unusable), the bridge encodes the exception name and message into the WebSocket close reason (truncated to 120 bytes), which is observable from any WebSocket client.

## What this project adds

The vendored engines provide the tunnel core and an admin panel. The following are original to this repository. This is a factual list of changes relative to upstream, not a feature advertisement — each item exists because a specific gap or defect needed closing.

**Subscription governance (`src/subscription/`)**

- **Multi-source merge with normalization.** `/sub/all` fetches both vendored engines' outputs plus an internally generated pool, detects payload format (base64 link list vs Clash YAML), normalizes everything to one Clash document, and deduplicates by node name.
- **Fake-country node stripping.** The vendored engine names nodes after the requester's `cf.country` + ASN (e.g. `CF移动优选-CN-…`). An anycast edge IP has no country-level identity — the label is misleading, and each requester gets differently-labeled nodes for the same IPs. `stripFakeCountryNodes` removes those proxies and their Trojan twins from both the proxies section and every proxy-group reference.
- **Stable named node pool.** `cidr.ts` samples IPs from the public Cloudflare CIDR space, buckets them by *measured landing colo* (a bucket map recorded from real residential-network `curl --resolve` + `/cdn-cgi/trace` probes, not geoip guesses — geoip answers with registration country, which for CF ranges is almost always wrong), and names nodes `{REGION}-{COLO}-{NN}`. `geo.ts` caches the pool in KV for 6 hours so a client's speed-test results stay valid between subscription refreshes.
- **Token-gated subscriptions.** Subscription endpoints answer `MD5MD5(host + UUID)` tokens only. The MD5 and truncated-double-MD5 constructions are implemented locally because the Workers runtime's `crypto.subtle` does not provide MD5.

**Web proxy hardening (`src/proxy-web/`)**

- **Parsed-hostname SSRF validation**, as described above — the string-literal checks used in typical designs are bypassable with alternative IPv4 encodings.
- **Cookie isolation and un-isolation.** Cookies from the target site are namespaced with a per-site prefix so two sites cannot read each other's cookies; `__Host-` and `__Secure-` prefixed cookies keep their required attributes when restored.
- **Bounded memory everywhere** (5 MB rewrite cap, deferred cache writes, 16 MB WS frames).
- **Timing-safe `PROXY_KEY` comparison.** The gate uses length-check + XOR accumulation instead of `===`, which is a constant-time comparison shape; `?key=` and `Cookie` paths are both supported.
- **JS-navigation rescue** (above), which the upstream panel lacks.

**Agent gateway (`src/gateway/`)**

- A small JSON fetch API for scripts and agents: `GET /api/v1/fetch/<target-url>` with `X-API-Key` auth, a health endpoint, hop-by-hop header stripping, `cf-*`/`x-forwarded-*` removal, and value-level redaction — the API key is stripped from the forwarded request so it never reaches the target site.

**Test suite**

- 232 tests across two Vitest pools (173 Node + 59 workers-runtime/miniflare), covering SSRF encodings, the WS frame codec (mask bit, all length classes, continuation frames, opcode preservation), subscription merge/stripping, DoH wire-format round-trips, and navigation rescue. The frame codec tests exist because the original implementation had zero coverage and the mask-bit requirement was verified against the RFC.

## Capability boundaries

Stated plainly, so nobody has to discover them in production:

- **The web proxy does not execute JavaScript.** Sites that build their DOM client-side (most SPAs) will not render correctly through `/proxy/*`. Static and server-rendered sites work.
- **Anonymity is not a property of this system.** The Worker's egress IP is a shared Cloudflare address; third parties see Cloudflare, not you — but Cloudflare sees everything, and the operator of the deployment sees everything. Treat it as a relay, not an anonymity tool.
- **The Worker runtime constrains persistence.** No long-lived processes: the page cache is per-colo, KV is eventually consistent, and the node-pool refresh is best-effort.
- **Subscription output depends on vendored engines' response formats.** If an upstream format changes, `/sub/*` breaks until the vendor file is bumped.
- **The WS bridge requires maskable, unauthenticated origins.** Origins behind auth cookies must be handled by the client.
- **Encrypted-client-hello (ECH) and post-quantum TLS are out of scope.** The edge terminates TLS with the cert of the deployed domain; nothing in the Worker stack can change what the edge negotiates.
- **Not for high-throughput relay.** Workers' free tier (100k req/day) and CPU limits make this a personal-tool footprint by design. Heavy relay use will exhaust the quota and degrade other paths on the same Worker.

## Requirements

- A Cloudflare account (free tier works)
- Node.js ≥ 18 + npm
- A `CLOUDFLARE_API_TOKEN` with Workers and KV permissions

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/lingion/Tunnel-CFP.git
cd Tunnel-CFP
npm install
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create KV
# Copy the printed namespace id into wrangler.cfp.toml → kv_namespaces[0].id
```

### 3. Configure `wrangler.cfp.toml`

Minimal edits — everything you must replace is marked in the file:

```toml
name = "cfp"                      # your worker name

# Optional: custom domain. Remove the comment and set your hostname.
# { pattern = "your-domain.example.com", custom_domain = true }

[[kv_namespaces]]
binding = "KV"                    # must stay "KV" — the vendored engine reads env.KV
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"

[vars]
UUID = "00000000-0000-4000-8000-000000000000"  # ← replace with your own UUIDv4 (node credential)
# PROXY_KEY = "a-long-random-string"           # optional: gate /proxy* behind key/cookie
```

### 4. Verify and deploy

```bash
npx tsc --noEmit                              # typecheck
npx vitest run                                # unit suite (173 tests)
npx vitest run -c vitest.workers.config.ts    # workers-runtime suite (59 tests, miniflare)
npx wrangler deploy -c wrangler.cfp.toml
```

### 5. Set secrets

```bash
echo "<key>"   | npx wrangler secret put KEY   -c wrangler.cfp.toml   # vendored edgetunnel KEY
echo "<admin>" | npx wrangler secret put ADMIN -c wrangler.cfp.toml   # admin panel password
```

### 6. Smoke test

```bash
# Health check (no auth)
curl "https://<your-worker-domain>/api/v1/health"
# → {"status":"ok","colo":"...","ts":...}

# DoH JSON API
curl "https://<your-worker-domain>/resolve?name=example.com&type=A"
```

Subscription URLs are token-gated. The token for your deployment is
`MD5MD5(<your-domain> + <UUID>)` — the same value the vendored admin panel
shows for its own `/sub` link. The MD5MD5 construction is `md5(md5hex(s).substring(7, 27))`.

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| HTML rewriting | `HTMLRewriter` (streaming, no DOM) |
| Sockets | `cloudflare:sockets` TCP + WebSocketPair |
| Testing | Vitest + miniflare (workers pool) — 232 tests |
| Vendors | [edgetunnel](https://github.com/cmliu/edgetunnel) (GPL-2.0), [yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan) |

## Repository Layout

```
src/index.ts                 entry: route dispatch
├── src/gateway/             agent gateway (/api/*)
│   ├── router.ts            /api/v1/fetch + health
│   ├── auth.ts              X-API-Key check
│   └── proxy.ts             bounded fetch forwarder
├── src/proxy-web/           web proxy
│   ├── handler.ts           /proxy handler, conditional cache, timeouts
│   ├── rewriter.ts          HTMLRewriter attribute/CSS URL rewriting
│   ├── ws-bridge.ts         RFC 6455 frame codec + TCP pump
│   ├── security.ts          SSRF guards (parsed-hostname validation)
│   ├── url-resolver.ts      attribute decoding + path preservation
│   ├── rescue.ts            JS-navigation referer rescue (302)
│   └── auth.ts              PROXY_KEY gate (constant-time)
├── src/subscription/        subscription endpoints
│   ├── handler.ts           /sub/* routes + list normalization
│   ├── cidr.ts              CF CIDR pool → node generation
│   ├── geo.ts               6h KV-cached stable pool
│   ├── merge.ts             multi-source merge
│   ├── md5.ts / sha224.ts   crypto primitives (CF runtime lacks MD5/SHA-224)
│   └── types.ts
├── src/doh/                 DoH RFC 8484 + JSON API
└── vendor/                  unmodified upstream code (see THIRD_PARTY_NOTICES.md)
    ├── edgetunnel/_worker.js
    └── yonggekkk/_worker.js
```

`vendor/` is read-only: an update means replacing the file and bumping the pinned-commit header. Everything else lives in `src/` and is covered by tests.

## Updating the vendored engines

1. Download the new upstream `_worker.js`.
2. Replace the vendor file. Keep the provenance header comment intact and update the pinned commit / version lines.
3. Run `npx tsc --noEmit && npx vitest run` — all green before deploy.

## Repository Rule

`lingion/Tunnel-CFP` is the sole upstream for this project. Don't treat mirrors or forks as the primary entry point.

## Disclaimer

This project is provided for **learning, research, and technical exchange only**. It is a general-purpose network programming toolkit built on the Cloudflare Workers platform.

By downloading, deploying, or using this project, you acknowledge and agree to the following:

1. **You are solely responsible for lawful use.** You must comply with the laws and regulations of your country or region, and with the terms of service of any platform you deploy to (including Cloudflare's Terms of Service). You are responsible for obtaining any authorization required for your use case.
2. **No unlawful-use promotion.** This project must not be used for any activity that violates applicable law, including but not limited to: evading network access controls where such evasion is prohibited, accessing computer systems without authorization, distributing unlawful content, infringing intellectual property rights, or disrupting network services. The authors do not support, endorse, or encourage any such use.
3. **No warranty.** The project is provided "AS IS", WITHOUT WARRANTY OF ANY KIND, express or implied. The authors and contributors are not liable for any direct or indirect damages, data loss, service suspension, account termination, or legal consequences arising from the use or misuse of this project.
4. **User content is out of scope.** All traffic relayed through a deployed instance is generated by its operator and users. The project authors never have access to, store, or monitor any deployed instance's traffic.
5. **Removal at your own discretion.** If you deploy this project, consider removing the deployment after you finish your research or testing.

If you do not agree with any of the above, do not download or use this project.

## Acknowledgements

This project depends on two upstream projects — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and pinned versions:

- **[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)** (GPL-2.0) — tunnel core, admin panel, subscription machinery
- **[yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan)** — alternative subscription format

Plus [cmliu/CF-CIDR.txt](https://github.com/cmliu/CF-CIDR.txt) for the Cloudflare CIDR snapshot used by the node pool.

## Contributing

PRs are accepted at <https://github.com/lingion/Tunnel-CFP>. By contributing, you agree that your contribution is licensed under GPL-2.0.

## License

GNU General Public License v2.0. See [LICENSE](./LICENSE).

You may use, modify, and redistribute this work provided that derivative works are also licensed under GPL-2.0 and the copyright notice is preserved. No warranty is provided. Vendored components remain under their respective licenses as described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
