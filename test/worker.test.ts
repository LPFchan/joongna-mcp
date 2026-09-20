import { afterEach, describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import worker, { type Env } from "../index";
type JsonRecord = Record<string, unknown>;

const env: Env = {
  JOONGNA_BASE_URL: "https://web.joongna.com",
  JOONGNA_TIMEOUT_SECONDS: "20",
  JOONGNA_USER_AGENT: "test-agent",
};
const IDENTITY = {
  "x-lost-plus-sub": "42",
  "x-lost-plus-email": "me%40lost.plus",
  "x-lost-plus-name": "%EC%82%AC%EC%9A%A9%EC%9E%90",
  "x-lost-plus-role": "user",
  "x-lost-plus-encoding": "percent-utf8",
};
type JsonRpc = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
function rpcRequest(body: JsonRpc, headers: Record<string, string> = {}) {
  return new Request("https://joongna.lost.plus/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...IDENTITY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
async function rpc(body: JsonRpc, headers: Record<string, string> = {}) {
  const response = await worker.fetch(rpcRequest(body, headers), env);
  const text = await response.text();
  const data = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6)
    : text;
  return { status: response.status, json: JSON.parse(data) as any };
}
const META_2026 = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
function rpc2026(method: string, params: Record<string, unknown> = {}) {
  return rpc(
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META_2026 } },
    {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
  );
}
function callTool(name: string, args: Record<string, unknown>) {
  return rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    { "mcp-protocol-version": "2025-06-18" },
  );
}
function responseFor(items: unknown[], totalSize = items.length) {
  return Response.json({
    data: { meta: { code: 0, message: "SUCCESS" }, items, totalSize },
  });
}
function listing(seq: number, state: number, price: unknown = 150000) {
  return {
    seq,
    state,
    price,
    title: `상품 ${seq}`,
    url: `https://img.example/${seq}.jpg`,
    storeSeq: "seller-1",
    objectType: "product",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("gateway boundary", () => {
  it("refuses requests without complete gateway identity", async () => {
    const response = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "no gateway identity",
    });
  });

  it("keeps non-MCP paths unavailable after identity", async () => {
    const response = await worker.fetch(
      new Request("https://joongna.lost.plus/healthz", { headers: IDENTITY }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("refuses bearer-only callers", async () => {
    const response = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp", {
        method: "POST",
        headers: { authorization: "Bearer token" },
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "no gateway identity",
    });
  });

  it("refuses partial and malformed gateway identity", async () => {
    const { "x-lost-plus-role": _role, ...partial } = IDENTITY;
    const missingRole = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp", {
        method: "POST",
        headers: partial,
      }),
      env,
    );
    expect(missingRole.status).toBe(500);

    const malformed = await worker.fetch(
      new Request("https://joongna.lost.plus/mcp", {
        method: "POST",
        headers: { ...IDENTITY, "x-lost-plus-encoding": "latin1" },
      }),
      env,
    );
    expect(malformed.status).toBe(500);
  });
});

describe("MCP contract", () => {
  it.each(["2025-06-18", "2025-03-26"])(
    "initializes legacy protocol %s",
    async (protocolVersion) => {
      const { status, json } = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      expect(status).toBe(200);
      expect(json.result.protocolVersion).toBe(protocolVersion);
      expect(json.result.serverInfo).toEqual({
        name: "joongna-mcp",
        version: "0.2.0",
      });
    },
  );

  it("serves modern discovery and private cache hints", async () => {
    const discover = await rpc2026("server/discover");
    expect(discover.json.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "private",
    });
    const listed = await rpc2026("tools/list");
    expect(listed.json.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "private",
    });
    expect(listed.json.result.tools).toHaveLength(3);
  });

  it("executes a modern structured tool call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor([])),
    );
    const result = await rpc2026("tools/call", {
      name: "joongna_search_keyword",
      arguments: { search_word: "아이폰", include_details: false },
    });
    expect(result.status).toBe(200);
    expect(result.json.result.structuredContent).toMatchObject({
      outcome: "ok",
      returned_count: 0,
      pagination: { has_more: false },
    });
  });

  it("advertises the migrated tools and object-root output variants", async () => {
    const { json } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(
      json.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "joongna_search_keyword",
      "joongna_search_price",
      "joongna_get_seller_evidence",
    ]);
    const search = json.result.tools[0];
    expect(search.inputSchema.properties.max_listings).toBeUndefined();
    expect(search.inputSchema.properties.offset).toBeUndefined();
    expect(search.outputSchema.type).toBe("object");
    expect(
      search.outputSchema.oneOf.map(
        (variant: { properties: { outcome: { const: string } } }) =>
          variant.properties.outcome.const,
      ),
    ).toEqual(["ok", "partial", "error"]);
    expect(json.result.tools[1].inputSchema.properties.date_range.default).toBe(
      30,
    );
  });

  it("passes native price/status/sort filters, excludes external ads, and preserves invalid prices as null", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        return responseFor(
          [
            { ...listing(1, 0, "1,2,3") },
            { ...listing(2, 3, 160000) },
            {
              seq: 3,
              state: 0,
              price: 170000,
              title: "외부 광고",
              objectType: "external_shopping_ad",
            },
            { ...listing(4, 9, 180000) },
          ],
          99,
        );
      }),
    );
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: {
            search_word: "아이폰 17",
            min_price_krw: 150000,
            max_price_krw: 200000,
            statuses: ["sold"],
            sort: "price_low",
            include_details: false,
          },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const body = JSON.parse(await calls[0].clone().text());
    expect(body.searchWord).toBe("아이폰 17");
    expect(body.priceFilter).toEqual({ minPrice: 150000, maxPrice: 200000 });
    expect(body.saleYn).toBe("SALE_Y");
    expect(body.sort).toBe("PRICE_ASC_SORT");
    expect(json.result.structuredContent.outcome).toBe("ok");
    expect(json.result.structuredContent.scanned_count).toBe(4);
    expect(json.result.structuredContent.excluded_counts).toEqual({
      status: 1,
      external_ad: 1,
      unknown_status: 1,
    });
    expect(json.result.structuredContent.listings).toHaveLength(1);
    expect(json.result.structuredContent.listings[0].price_krw).toBe(160000);
    expect(json.result.structuredContent.listings[0].sold_at).toBeNull();
  });

  it("retains listings when details fail and still fetches deduplicated seller evidence", async () => {
    let detailCalls = 0;
    let sellerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v3/search/all"))
          return responseFor([
            { ...listing(1, 0), storeSeq: "zero" },
            { ...listing(2, 0), storeSeq: "zero" },
            { ...listing(3, 0), storeSeq: [] },
          ]);
        if (url.includes("/basic/")) {
          detailCalls++;
          return new Response("detail unavailable", { status: 503 });
        }
        if (url.includes("/v2/my-store/zero")) {
          sellerCalls++;
          return Response.json({
            data: {
              meta: { code: 0 },
              safeTradeCount: 0,
              reviewCount: 2,
            },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    );
    const { json } = await callTool("joongna_search_keyword", {
      search_word: "아이폰",
      include_seller_evidence: true,
    });
    const data = json.result.structuredContent;
    expect(data.outcome).toBe("partial");
    expect(detailCalls).toBe(3);
    expect(sellerCalls).toBe(1);
    expect(data.listings).toHaveLength(3);
    expect(data.listings[0]).toMatchObject({
      detail_status: "failed",
      seller_evidence_status: "available",
      seller_evidence: {
        status: "available",
        source_metrics: { safeTradeCount: 0, reviewCount: 2 },
        safe_trade_count: { value: 0, status: "available" },
      },
    });
    expect(data.listings[2]).toMatchObject({
      seller_id: null,
      seller_evidence_status: "unavailable",
      seller_error: { code: "missing_seller_id", retryable: false },
    });
    const listed = await rpc(
      { jsonrpc: "2.0", id: 20, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const schema = listed.json.result.tools.find(
      (tool: { name: string }) => tool.name === "joongna_search_keyword",
    ).outputSchema;
    expect(new Ajv2020({ strict: false }).compile(schema)(data)).toBe(true);
  });

  it("deduplicates seller batch requests, preserves one result per input, and caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const sellerCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes("/v2/my-store/"))
          throw new Error(`unexpected URL ${url}`);
        const id = decodeURIComponent(url.split("/").at(-1)!);
        sellerCalls.push(id);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        if (id === "missing")
          return Response.json({
            data: { meta: { code: 0 }, reviewCount: 1 },
          });
        if (id === "failed") return new Response("busy", { status: 503 });
        return Response.json({
          data: { meta: { code: 0 }, safeTradeCount: 0, reviewCount: 1 },
        });
      }),
    );
    const sellerIds = [
      "zero",
      "zero",
      "missing",
      "failed",
      ...Array.from({ length: 10 }, (_, index) => `seller-${index}`),
    ];
    const { json } = await callTool("joongna_get_seller_evidence", {
      seller_ids: sellerIds,
    });
    const data = json.result.structuredContent;
    expect(data.outcome).toBe("partial");
    expect(data.sellers).toHaveLength(sellerIds.length);
    expect(sellerCalls).toHaveLength(new Set(sellerIds).size);
    expect(peak).toBeLessThanOrEqual(8);
    expect(data.sellers[0]).toMatchObject({
      seller_id: "zero",
      status: "available",
      safe_trade_count: { value: 0, status: "available" },
    });
    expect(data.sellers[1]).toMatchObject({ seller_id: "zero" });
    expect(data.sellers[2]).toMatchObject({
      seller_id: "missing",
      status: "unavailable",
      safe_trade_count: { value: null, status: "unavailable" },
    });
    expect(data.sellers[3]).toMatchObject({
      seller_id: "failed",
      status: "failed",
      error: { code: "upstream_http", retryable: true },
    });
    const listed = await rpc(
      { jsonrpc: "2.0", id: 21, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const schema = listed.json.result.tools.find(
      (tool: { name: string }) => tool.name === "joongna_get_seller_evidence",
    ).outputSchema;
    expect(new Ajv2020({ strict: false }).compile(schema)(data)).toBe(true);
  });

  it("uses UTF-8 opaque cursors and keeps native empty-page termination", async () => {
    const bodies: JsonRecord[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        bodies.push(JSON.parse(await request.clone().text()));
        return bodies.length === 1
          ? responseFor([listing(1, 0)])
          : responseFor([]);
      }),
    );
    const first = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: { search_word: "아이폰 17", include_details: false },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const cursor = first.json.result.structuredContent.pagination.next_cursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: {
            search_word: "아이폰 17",
            cursor,
            include_details: false,
          },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(bodies[1].page).toBe(1);
    expect(second.json.result.structuredContent.pagination).toMatchObject({
      has_more: false,
      next_cursor: null,
      raw_count: 0,
    });
  });

  it("returns structured parse and retry errors with unchanged request cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor([null])),
    );
    const malformed = await rpc(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: {
            search_word: "아이폰",
            cursor: null,
            include_details: false,
          },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(malformed.json.result.isError).toBe(true);
    expect(malformed.json.result.structuredContent).toMatchObject({
      outcome: "error",
      error: { code: "parse_failed", retryable: false },
      request_cursor: null,
      pagination: { has_more: null, next_cursor: null },
    });
    const ajv = new Ajv2020({ strict: false });
    const listed = await rpc(
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const schema = listed.json.result.tools.find(
      (tool: { name: string }) => tool.name === "joongna_search_keyword",
    ).outputSchema;
    expect(ajv.compile(schema)(malformed.json.result.structuredContent)).toBe(
      true,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFor([listing(99, 0)])),
    );
    const successful = await rpc(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: { search_word: "아이폰", include_details: false },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const cursor =
      successful.json.result.structuredContent.pagination.next_cursor;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("busy", {
            status: 429,
            headers: { "retry-after": "12" },
          }),
      ),
    );
    const rateLimited = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "joongna_search_keyword",
          arguments: { search_word: "아이폰", cursor, include_details: false },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(rateLimited.json.result.structuredContent).toMatchObject({
      outcome: "error",
      error: { code: "rate_limited", retryable: true, retry_after_seconds: 12 },
      request_cursor: cursor,
    });
    expect(ajv.compile(schema)(rateLimited.json.result.structuredContent)).toBe(
      true,
    );
  });

  it("distinguishes forbidden upstream blocks and keeps body aborts retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("forbidden", { status: 403 })),
    );
    const forbidden = await callTool("joongna_search_keyword", {
      search_word: "아이폰",
      include_details: false,
    });
    expect(forbidden.json.result).toMatchObject({
      isError: true,
      structuredContent: {
        outcome: "error",
        error: { code: "upstream_blocked", retryable: true },
      },
    });

    const abortedResponse = new Response("body");
    Object.defineProperty(abortedResponse, "json", {
      value: async () => {
        const error = new Error("body read aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => abortedResponse),
    );
    const aborted = await callTool("joongna_search_keyword", {
      search_word: "아이폰",
      include_details: false,
    });
    expect(aborted.json.result).toMatchObject({
      isError: true,
      structuredContent: {
        outcome: "error",
        error: { code: "timeout", retryable: true },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("busy", {
            status: 429,
            headers: { "retry-after": "0" },
          }),
      ),
    );
    const zeroRetryAfter = await callTool("joongna_search_keyword", {
      search_word: "아이폰",
      include_details: false,
    });
    expect(zeroRetryAfter.json.result.structuredContent.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retry_after_seconds: 0,
    });
  });

  it("requests numeric 90-day registered chart data without inventing averages", async () => {
    let requestBody: JsonRecord | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requestBody = JSON.parse(await request.clone().text());
        return Response.json({
          data: {
            productPrice: {
              linePrices: [{ date: "2026-06-22", avgPrice: 1200000 }],
              scatterPrices: [],
              scatterPriceCountAvg: 1,
            },
            items: [],
          },
        });
      }),
    );
    const { json } = await rpc(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "joongna_search_price",
          arguments: {
            search_word: "아이폰 17",
            date_range: 90,
            source_label: "registered_price",
            include_details: false,
          },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(requestBody).toMatchObject({
      searchWord: "아이폰 17",
      dateRange: 90,
      priceType: 0,
    });
    expect(json.result.structuredContent.chart.requested_range.date_range).toBe(
      90,
    );
    expect(
      json.result.structuredContent.chart.native_scatter_price_count_avg,
    ).toBe(1);
    expect(
      json.result.structuredContent.chart.source_reported_scatter_average_krw,
    ).toBeUndefined();
  });
});
