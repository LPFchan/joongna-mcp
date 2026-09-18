# Joongna MCP

MCP server that fetches and parses Joongna's search and search-price pages.
Both `joongna_search_price` and `joongna_search_keyword` return seller
descriptions and full product-image links by default. The price tool also
returns average/highest/lowest price and BID and EXECUTION price history.

## Where it runs

A Cloudflare Worker named `joongna-mcp` (`index.ts`, `wrangler.toml`). It
holds no zone route of its own and is not on workers.dev. The only way in is
the `JOONGNA` service binding declared by the `auth-gateway` Worker
(`LPFchan/auth`, `gateway/wrangler.toml`), whose route table
(`gateway/config/cloudflare.gateway.json`) maps `joongna.lost.plus` to this
binding under the `mcp` policy with token scope `joongna`.

The gateway holds every zone route for `joongna.lost.plus` (the exact
patterns are in `gateway/wrangler.toml` in the auth repo). Of what arrives:

| path | handled by |
| --- | --- |
| `/mcp`, `/mcp/*` | forwarded here over the binding |
| `/healthz` | the gateway (`ok`, `text/plain`) |
| `/.well-known/oauth-protected-resource*` | the gateway |
| anything else | the gateway, 404 |

Authentication belongs to the gateway. It validates the Common Auth token,
strips it, and forwards the caller as percent-encoded `x-lost-plus-{sub,
email, name, role, encoding}` headers. This Worker reads those (`identity.ts`)
and never sees a credential; a request without them is refused with a 500
because it can only mean the deployment is wrong (see `refused()` in
`index.ts`). There is no `AUTH_URL`, no token scope, and no secret here.

It holds no state: no D1, KV, or R2. Every tool call fetches Joongna fresh.

## Tools

- `joongna_search_price(query, search_word?, max_listings?, force_refresh?)`
  — price summary, BID/EXECUTION price history, and available listings.
  `max_listings`: 1–20, default 10.
- `joongna_search_keyword(query, search_word?, max_listings?, force_refresh?)`
  — full search listings, including sold-out items.
  `max_listings`: 1–100, default 20.

`query` is normalized into a Joongna search word (English device names are
translated, English filler is stripped, spaces are removed); pass
`search_word` to use an exact term instead. `force_refresh` is accepted for
compatibility with earlier clients and does nothing: there is no cache, and
`from_cache` is always `false`.

Each listing is enriched with the seller's description and full-size image
URLs from Joongna's product API, one request per unique listing. If that
request fails the listing keeps its search thumbnail and a `null`
description; the search itself still succeeds, and `detail_failures` in the
result says how many listings that happened to.

The usual reason it happens is the platform: Cloudflare caps a Worker
invocation at 50 subrequests on the free plan, shared between the search
page and the detail fetches, so at most 49 listings per call can be enriched
(fewer if the keyword search had to retry an empty page). Measured
2026-09-19: `joongna_search_keyword` with `max_listings=60` returns 50
listings (all Joongna's page carries), the first 49 with details,
`detail_failures: 1`; `max_listings=40` reports 0. Ask for at most 49 if
every listing needs a description. The Python server had no such limit. Joongna errors (non-200,
non-HTML, suspected anti-bot page) come back as MCP tool errors
(`isError: true`) with the reason as text.

The MCP transport is Streamable HTTP via `@modelcontextprotocol/server` v2,
serving 2026-07-28 clients natively and 2025-era clients (`initialize`)
through the SDK's stateless fallback. 2026-07-28 clients are told to cache
`tools/list` and `server/discover` for five minutes (`cacheHints` in
`index.ts`).

## Listing sale status

Every listing carries `sale_status`, derived from the bare integer Joongna
puts in its search payload:

| raw code | `sale_status` | product page shows |
| --- | --- | --- |
| 0 | `on_sale` | no badge |
| 1 | `reserved` | 예약중 |
| 3 | `sold` | 판매완료 |
| anything else | `unknown_<code>` | — |

Sold listings do come back from `joongna_search_keyword`. Joongna's
`excludeSoldOutProductYn` URL parameter does not filter them out — the real
site applies that filter client-side, after the server-rendered payload these
parsers read. Filter on `sale_status` instead.

Note that Joongna's product detail API uses a different scale for the same
idea (search `state: 3` is `productStatus: 9` there), so the two are not
interchangeable.

## Develop

```sh
npm install
npm test            # vitest: parser/normalizer fixtures, identity parsing, refusal path, MCP handshakes, tool calls against a fake Joongna
npm run typecheck
```

## Deploy

```sh
CLOUDFLARE_API_TOKEN=… npm run deploy     # wrangler deploy
```

Configuration is the `[vars]` block in `wrangler.toml` (`JOONGNA_BASE_URL`,
`JOONGNA_TIMEOUT_SECONDS`, `JOONGNA_USER_AGENT`). There are no secrets and
no `.dev.vars`. Do not add `routes` to `wrangler.toml`: deploying would take
the hostname away from the gateway (the comment there explains).

To verify a deploy, call the public URL with a Common Auth token that has the
`joongna` scope: `initialize` should return 200, and a bogus bearer should get
a 401 with a `WWW-Authenticate` challenge from the gateway.

Roll back with `npx wrangler rollback` (Cloudflare keeps the previous
versions). If the gateway side is what broke, that is the auth repo's
rollback, not this one's.

## Usage

```json
{
  "mcpServers": {
    "joongna": {
      "type": "remote",
      "url": "https://joongna.lost.plus/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

`X-API-Key: YOUR_TOKEN` works too. The token needs the `joongna` scope.

## History

Until 2026-09-18 this ran as a Python container (`python/`, FastMCP, port 8000
on OCI behind the local auth gateway and the Cloudflare tunnel). The Worker
port replaced it; the Python tree was deleted once its tests were carried
over to `test/`. The Python server kept five-minute in-memory caches, which
the Worker does not.
