# Tunnel-CFP

A single Cloudflare Worker that bundles a personal proxy stack:

- **VLESS tunnel** — WebSocket transport, TLS to the edge, random preferred-IP
  nodes generated per subscription fetch
- **Subscription endpoints** — Clash YAML / V2RayNG base64 link lists, with
  node-pool stabilization (6h KV-cached IP pool), measured-colo naming
  (`APAC-HKG-01` ...), and fake-country node stripping
- **Web proxy** — browse any site through `/proxy/<url-encoded-target>` with
  HTML rewriting, iframe srcdoc handling, cookie isolation, SSRF protection,
  and a WebSocket bridge (`/proxy-ws/`)
- **DoH server** — DNS-over-HTTPS (RFC 8484 wire format + JSON API)

Deployable free on Cloudflare Workers (100k req/day).

## Routes

| Path | Function |
|---|---|
| `/proxy/<encoded-url>` | Web proxy (HTML/CSS/JS URL rewriting, cookies, SSRF-guarded) |
| `/proxy-ws/<encoded-ws-url>` | WebSocket bridge (RFC 6455 client-masked framing) |
| `/sub/edgetunnel?token=...` | V2RayNG base64 subscription (governed) |
| `/sub/all?token=...` | Clash YAML subscription (all sources merged) |
| `/sub/yonggekkk` | Alternative vendor subscription (raw) |
| `/dns-query`, `/resolve` | DoH endpoints |
| `/*` | Vendor panel + VLESS tunnel (edgetunnel-managed) |

Subscription endpoints are token-gated: `token = MD5MD5(host + UUID)`.

## Deploy

Prereq: a Cloudflare account, a `CLOUDFLARE_API_TOKEN` with Workers + KV permissions.

```bash
npm install

# 1. Create the KV namespace and put its id into wrangler.cfp.toml
npx wrangler kv namespace create KV

# 2. Set your node UUID in wrangler.cfp.toml [vars] (any valid UUIDv4)

# 3. Typecheck + tests
npx tsc --noEmit && npx vitest run

# 4. Deploy
npx wrangler deploy -c wrangler.cfp.toml

# 5. Secrets
echo "<key>"   | npx wrangler secret put KEY       -c wrangler.cfp.toml   # vendor edgetunnel KEY
echo "<admin>" | npx wrangler secret put ADMIN     -c wrangler.cfp.toml   # admin panel password
```

The subscription token for your deployment: `MD5MD5(<your-domain> + <UUID>)` —
same value the vendor panel shows for its own `/sub` link.

## Architecture

```
src/index.ts                 entry: route dispatch
├── src/proxy-web/           web proxy (fetch rewriting + WS bridge)
│   ├── handler.ts           main /proxy handler, cache, timeouts
│   ├── rewriter.ts          HTMLRewriter attribute/CSS URL rewriting
│   ├── ws-bridge.ts         RFC 6455 frame codec + TCP pump
│   ├── security.ts          SSRF guards (parsed-hostname validation)
│   ├── url-resolver.ts      attribute decoding + path preservation
│   ├── rescue.ts            JS-navigation referer rescue (302)
│   └── auth.ts              PROXY_KEY gate
├── src/subscription/        governed subscriptions
│   ├── handler.ts           /sub/* routes, fake-country stripping
│   ├── cidr.ts              CF CIDR pool → measured-colo named nodes
│   ├── geo.ts               6h KV-cached stable node pool
│   ├── merge.ts             multi-vendor merge + normalization
│   ├── md5.ts / sha224.ts   crypto primitives (CF runtime lacks MD5)
│   └── types.ts
├── src/doh/                 DoH RFC 8484 + JSON API
└── vendor/                  unmodified upstream code (see THIRD_PARTY_NOTICES.md)
    ├── edgetunnel/_worker.js
    └── yonggekkk/_worker.js
```

`vendor/` is treated as read-only: updates mean replacing the file and bumping
the pinned-commit header. All governance (fake-CN stripping, colo naming, pool
stabilization, SSRF, WS bridge hardening) lives in `src/`.

## Tests

```bash
npx vitest run                              # unit suite (173 tests)
npx vitest run -c vitest.workers.config.ts  # workers-runtime suite (59 tests, miniflare)
```

SSRF (integer/hex/octal IPv4 bypasses), WS frame codec (mask bit, length
classes, continuation frames), subscription merge/stripping, DoH wire-format
round-trips.

## Security notes

- Subscription endpoints are token-gated (the node UUID itself is the
  credential; subscriptions never serve unauthenticated).
- Web proxy blocks self-recursion (configurable `SELF_HOSTS` in
  `src/proxy-web/security.ts`), IPv4 literals in any encoding, IPv6 literals,
  and internal TLDs — validation runs on the *parsed* hostname.
- WS bridge enforces client-side masking, frame-size caps, and serialized
  writes per connection.
- Set `PROXY_KEY` in `[vars]` to require a key/cookie gate on `/proxy*`.

## Acknowledgements

This project stands on two excellent upstreams — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licenses and pinned
versions:

- **[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)** (GPL-2.0) — the
  tunnel core, admin panel, and subscription machinery
- **[yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan)** —
  alternative subscription format

Plus [cmliu/CF-CIDR.txt](https://github.com/cmliu/CF-CIDR.txt) for the
Cloudflare CIDR snapshot used by the node pool.

## License

GPL-2.0 — see [LICENSE](LICENSE). Vendored components remain under their
respective licenses as described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
