# Joongna MCP

MCP server that fetches and parses Joongna's search and search-price pages.
Both `joongna_search_price` and `joongna_search_keyword` return seller
descriptions and full product-image links by default. The price tool also
returns average/highest/lowest price and BID and EXECUTION price history.

Two runtimes:

- **Cloudflare Workers** (root) — the primary runtime. Runs on Cloudflare's
  edge, survives OCI outages. Validates tokens directly against
  auth.lost.plus using the `joongna` scope.
- **Python** (`python/`) — local-dev fallback. Runs behind the Common Auth
  gateway on loopback (`cd python && docker compose up --build`, or
  `python -m joongna_mcp.server` from `python/`).

The HTTP endpoint uses the MCP Streamable HTTP transport. The Python server
uses the official MCP Python SDK v2 and supports the `2026-07-28` stateless
protocol via `server/discover`, with a stateless legacy fallback for clients
that still use `initialize`.

Production authentication is provided directly by the Worker against Common
Auth at `https://auth.lost.plus` using the `joongna` scope. Send a Common
Auth token as `Authorization: Bearer <token>` or `X-API-Key: <token>`.

## Caching difference vs the Python server

The Python server keeps in-memory caches (search pages, keyword pages, and
product details) with `JOONGNA_CACHE_TTL_SECONDS` (default 300). The Worker
drops these caches: module-level state does not persist across Worker
invocations, and there is no Workers KV binding. Every tool call fetches
fresh data, so `from_cache` is always `false` and `force_refresh` is
accepted for API parity but has no effect. `JOONGNA_CACHE_TTL_SECONDS` is
only read by the Python fallback.

## Tools

- `joongna_search_price(query, search_word?, max_listings?, force_refresh?)`
  — price summary, BID/EXECUTION price history, and available listings.
  `max_listings`: 1–20, default 10.
- `joongna_search_keyword(query, search_word?, max_listings?, force_refresh?)`
  — full search listings, including sold-out items.
  `max_listings`: 1–100, default 20.

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

## Deploy (Worker)

```sh
npm install
npx wrangler deploy
```

No secrets are required. Configuration lives in `wrangler.toml` `[vars]`:
`AUTH_URL`, `TOKEN_SCOPE`, `JOONGNA_BASE_URL`,
`JOONGNA_TIMEOUT_SECONDS`, and `JOONGNA_USER_AGENT`.

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
