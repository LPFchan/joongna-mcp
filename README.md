# Joongna MCP

MCP server that fetches and parses Joongna's search and search-price pages. Both `joongna_search_price` and `joongna_search_keyword` return seller descriptions and full product-image links by default. The price tool also returns average/highest/lowest price and BID and EXECUTION price history. Configure via environment variables: `JOONGNA_BASE_URL`, `JOONGNA_PRODUCT_API_BASE_URL`, `JOONGNA_CACHE_TTL_SECONDS`, `JOONGNA_TIMEOUT_SECONDS`, `JOONGNA_USER_AGENT`, `JOONGNA_PUBLIC_BASE_URL`, `JOONGNA_ALLOWED_HOSTS`, and `JOONGNA_ALLOWED_ORIGINS`. Run with `docker compose up --build` or `python -m joongna_mcp.server`.

The production endpoint is `https://joongna.lost.plus/mcp`. The shared Common
Auth gateway protects it with the `joongna` scope. Send a Common Auth token as
`Authorization: Bearer <token>` or `X-API-Key: <token>`. The backend does not
authenticate requests itself and must remain bound to localhost behind the
gateway. The Compose service uses `restart: unless-stopped` so it returns after
host and Docker restarts. Standalone runs default to loopback; Compose
explicitly binds `0.0.0.0` only inside its loopback-published Docker boundary.

The HTTP endpoint uses the official MCP Python SDK v2 and supports the
`2026-07-28` stateless protocol via `server/discover`, with a stateless legacy
fallback for clients that still use `initialize`.
