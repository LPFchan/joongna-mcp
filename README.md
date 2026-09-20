# Joongna MCP

This Cloudflare Worker exposes Joongna search, source price-chart, and seller
evidence data through MCP. The public contract is version `0.2.0`.

## Gateway and deployment

The Worker is named `joongna-mcp` and has no route of its own. It is reached
through the `JOONGNA` service binding in the `auth-gateway` Worker at
`https://joongna.lost.plus/mcp`. The gateway authenticates the Common Auth
token, removes it, and forwards the `x-lost-plus-*` identity headers. This
Worker refuses requests without those headers. It has no token secret, D1, KV,
R2, or application cache.

Do not add a Wrangler route. Routes belong to the gateway and the route-less
configuration is part of the identity boundary. The existing development and
deployment commands are:

```sh
npm install
npm test
npm run typecheck
npm run deploy
```

`npm run deploy` obtains `CLOUDFLARE_API_TOKEN` through the repository's
`passage` setup. The Worker configuration only contains upstream URL,
timeout, and user-agent variables.

## Tools

### `joongna_search_keyword`

Searches exactly one native Joongna search page. Supply `query`, or supply an
exact `search_word`; at least one is required. A nonblank `search_word` is sent
byte-for-byte as supplied and takes precedence over `query`. `query` uses the
existing Joongna normalizer for compatibility.

Inputs:

```json
{
  "search_word": "닌텐도 스위치",
  "min_price_krw": 100000,
  "max_price_krw": 400000,
  "statuses": ["on_sale", "reserved", "sold"],
  "sort": "recent",
  "include_details": true,
  "include_seller_evidence": false
}
```

Details default to `true`; seller evidence defaults to `false`. The native
page size is 50. `sort` defaults to `recent`. When `statuses` is omitted,
Joongna's native default excludes sold items; this is not an unfiltered
marketplace-history query. Joongna's native default price request is
`0..100000000` KRW when no price bounds are supplied. A nonempty native page
returns an opaque cursor and
`has_more: null`, because the next page must be probed. A validated empty page
is terminal with `has_more: false` and no cursor. The server never fills a page
from later pages and never replays an offset.

The cursor is bound to the marketplace, query, filters, sort, and page size.
Treat it as opaque. A cursor from another request returns `cursor_mismatch`.

Each listing preserves string IDs, source status, nullable price, category,
images, raw source flags, and raw source dates where present. `status` is the
normalized search status:

| Joongna search state | MCP status |
| -------------------: | ---------- |
|                  `0` | `on_sale`  |
|                  `1` | `reserved` |
|                  `3` | `sold`     |
|        anything else | `unknown`  |

The detail API has a different status scale. For example, detail
`productStatus: 9` does not make a search result sold. No `sold_at` value is
invented from update or creation dates.

Joongna's native price range is applied in the upstream request. Requested
status values are also checked after parsing. Unknown statuses are retained
when no status filter is requested; with a status filter they are counted as
`unknown_status` exclusions. External shopping ads are excluded and counted;
promoted marketplace products remain listings when identifiable. The result
reports `scanned_count`, `returned_count`, and mutually exclusive exclusion
counts. Joongna totals are unreliable and are exposed as unavailable.

Detail and seller enrichment failures retain the listing. Each listing carries
an evidence state, timestamp, and structured error when a requested lookup
fails. Duplicate detail and seller requests are deduplicated, and seller batch
work is bounded. Evidence is source data, not a safety or qualification
judgment.

### `joongna_search_price`

Returns the native Joongna product-price chart and separate related current
listings. `date_range` accepts numeric `30`, `90`, or `180` days and defaults to
`30`. `source_label` defaults to `sales_price`; `registered_price` is also
supported. `max_related_listings` defaults to 20 and limits only the related
current listings. Details default to `true` for those listings.

```json
{
  "search_word": "닌텐도 스위치",
  "date_range": 90,
  "source_label": "registered_price",
  "max_related_listings": 10,
  "include_details": true
}
```

The chart returns raw line and scatter series, observed valid date bounds, the
requested range, and the native `scatterPriceCountAvg` value under the
source-named field `native_scatter_price_count_avg`. Its units and meaning are
unverified, so it is not presented as an average paid price or transaction
count. Chart population, weighting, completeness, and exact transaction
semantics are unknown. This tool does not provide exact sold averages,
medians, counts, or paid-price labels.

### `joongna_get_seller_evidence`

Fetches one evidence result for every requested seller ID, including repeated
IDs in the input. The batch accepts at most 100 IDs. The native `safeTradeCount` and `reviewCount` fields are
preserved. A valid zero is distinct from missing or invalid data. The role
scope of `safeTradeCount` is reported as unknown; an unavailable or failed
metric is never changed into zero.

```json
{
  "seller_ids": ["12345", "67890"]
}
```

## Results and errors

Successful calls return `structuredContent` with `outcome: "ok"`; retained
rows with enrichment failures return `outcome: "partial"`. An upstream or
validation failure returns `isError: true` and structured content with
`outcome: "error"`, an error `code`, `retryable`, and an optional retry delay.
Error pagination is always `{ "has_more": null, "next_cursor": null }` and
does not claim successful row counts. When a later cursor request fails, the
request cursor is preserved and no fabricated next cursor is returned.

Common error codes include `invalid_query`, `cursor_mismatch`, `parse_failed`,
`unsupported_filter`, `timeout`, `rate_limited`, `upstream_http`, and
`upstream_blocked`. Parse and validation failures are nonretryable; timeouts,
rate limits, and appropriate upstream failures are retryable.

## Migration and limits

This is a versioned pagination and output migration. The old `max_listings` and
`offset` inputs are removed and rejected rather than silently ignored. Search
now returns one native page, with no automatic page fill. The old summary
fields such as `sale_status`, `detail_failures`, and `from_cache` are not part
of this contract. `query` remains as a compatibility input, but it does not
restore the old response shape.

The service exposes source evidence and normalized transport status. It does
not classify product models, storage, phone floors, seller safety, or buyer
eligibility. Search data is fetched from Joongna at call time, and native
upstream limits, anti-bot behavior, and subrequest limits can affect results.

## Client configuration

```json
{
  "mcpServers": {
    "joongna": {
      "type": "remote",
      "url": "https://joongna.lost.plus/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

The token needs the `joongna` scope. `X-API-Key` is also accepted by the
gateway. MCP clients from the current and supported 2025-era protocol
families are served by the same stateless Worker.
